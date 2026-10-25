import { Address, Contract, nativeToScVal, rpc, scValToNative, xdr, type Keypair } from "@stellar/stellar-sdk";
import {
  Leash, TESTNET, actions, type Call, type Deployments, type ExecuteOptions, type LeashError, type Position, type TxResult,
} from "@leash/sdk";
import type { JournalEntry } from "./runtime/journal.js";
import { runAgent } from "./runtime/run.js";

/** Demo vault the crash scenario runs on: XLM collateral on Blend with USDC debt. */
export const CRASH_VAULT_ID = "leverage";
/** XLM move forced through the demo oracle, bps. */
export const CRASH_BPS = 3_000n;
const BPS = 10_000n;
const UNIT = 10_000_000n;
/** Health factor the refused borrow aims for at the crashed price: under the 1.3 floor, above 1. */
const REFUSED_BORROW_HF_BPS = 12_000n;
/** Health factor, relative to the floor, a budgeting repay brings the book back to. */
const BUDGET_HF_OVER_FLOOR_BPS = 11_000n;
/** Smallest Blend request used as a valid sibling call for footprints, and the dust a restore ignores. */
const DUST = UNIT / 100n;
const RISKOFF = "riskoff";
const AGENT_ATTEMPTS = 2;

/** Steps in the order they run; `restore` may run at any point and ends the scenario. */
export const CRASH_STEPS = ["prepare", "crash", "yield-refused", "pause", "riskoff-refused", "riskoff-repay", "withdraw"] as const;
export type CrashStep = (typeof CRASH_STEPS)[number] | "restore";

export interface CrashKeys {
  /** Admin of the oracle router and owner of the vault: signs the demo price and the unpause. */
  admin: Keypair;
  /** Session key of the vault's default role (the yield agent). */
  agent: Keypair;
  /** Member of the vault's risk-off role. */
  riskoff: Keypair;
  /** Calls the permissionless `check_drawdown`, as the keeper does; it is the source of that call. */
  keeper: Keypair;
  /** Holds shares before the crash and withdraws while the vault is paused; source of its own calls. */
  depositor: Keypair;
  /**
   * Source of the admin, agent and risk-off transactions; those keys then only sign their
   * authorization entries. Without it each key is the source of its own calls.
   */
  feePayer?: Keypair;
}

export interface CrashOptions {
  /** Client of the deployments; built from `deployments` when omitted. */
  leash?: Leash;
  deployments?: Deployments;
  keys: CrashKeys;
  /** Vault id in the deployments file. */
  vault?: string;
  /** Base units the depositor puts in when it holds no shares yet. */
  depositAmount?: bigint;
  /** Journal of the risk-off agent, entry by entry. */
  onEntry?: (entry: JournalEntry) => void;
}

/** A refusal or precondition whose message is meant for the person running the scenario. */
export class CrashError extends Error {}

export interface CrashTx {
  label: string;
  hash: string;
  status: TxResult["status"];
  error?: LeashError;
}

export interface CrashStepResult {
  step: CrashStep;
  txs: CrashTx[];
  /** Facts read back from the chain after the step, one sentence each. */
  notes: string[];
  /** Journal of the risk-off agent's runs (`riskoff-repay` only). */
  journal: JournalEntry[];
  /** `restore` only: every restore transaction landed and the vault ends unpaused. */
  ok: boolean;
}

/** Live readings of the crash vault and the demo oracle. */
export interface CrashLive {
  demo: boolean;
  /** XLM price forced by the demo oracle, if any (USDC, 7 decimals). */
  forcedPrice: bigint | null;
  /** XLM price the vault uses (`price_strict`), `null` while the oracle cannot vouch for it. */
  xlmPrice: bigint | null;
  /** Lowest health factor in bps; `null` without debt or while unpriced. */
  healthFactor: bigint | null;
  minHealth: number;
  maxDrawdown: number;
  nav: bigint | null;
  pps: bigint | null;
  paused: boolean;
  /** Blend USDC debt of the vault, base units; `null` while the positions cannot be valued. */
  debt: bigint | null;
}

interface Book { debt: bigint; collateral: bigint; idleXlm: bigint; xlmValue: bigint }

const address = (value: string) => new Address(value).toScVal();
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const NO_DEBT = 1_000_000_000n;

/** `stroops` (7 decimals) with up to `digits` decimals, trailing zeros dropped. */
export function formatAmount(stroops: bigint, digits = 4): string {
  const sign = stroops < 0n ? "-" : "";
  const abs = stroops < 0n ? -stroops : stroops;
  const fraction = (abs % UNIT).toString().padStart(7, "0").slice(0, digits).replace(/0+$/, "");
  return `${sign}${(abs / UNIT).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export const formatHealth = (bps: bigint) => (bps > NO_DEBT ? "none (no debt)" : (Number(bps) / 10_000).toFixed(2));

/** Borrow the yield agent attempts after the crash: enough to land near 1.2, never less than dust. */
export function refusedBorrowAmount(debt: bigint, health: bigint): bigint {
  const sized = debt * health / REFUSED_BORROW_HF_BPS - debt;
  return sized > DUST ? sized : DUST;
}

/**
 * Repay that leaves the health factor at 1.1 × `floor` or more (health scales with 1 / debt): a
 * valid default-role call touching the same Blend state as a refused borrow, used to budget it.
 */
export function budgetRepayAmount(debt: bigint, health: bigint, floor: bigint): bigint {
  const target = floor * BUDGET_HF_OVER_FLOOR_BPS / BPS;
  if (health >= target) return DUST;
  const repay = debt - debt * health / target + DUST;
  return repay > debt ? debt : repay;
}

const sum = (positions: Position[], match: (p: Position) => boolean, field: "amount" | "value") =>
  positions.filter(match).reduce((total, p) => total + p[field], 0n);

/** Vault and oracle router of the crash scenario in `leash`'s deployments. */
function crashTarget(leash: Leash, vaultId: string): { vault: string; router: string } {
  const record = leash.deployments.vaults.find(v => v.id === vaultId);
  if (!record) throw new Error(`Vault ${vaultId} is not in the deployments file`);
  const router = leash.deployments.oracleRouter;
  if (!router) throw new Error("No oracle router in the deployments file");
  return { vault: record.address, router };
}

/** Price of `asset` forced on the demo oracle `router`, read from its ledger entry; `null` when none. */
async function demoPrice(leash: Leash, router: string, asset: string): Promise<bigint | null> {
  const key = xdr.ScVal.scvVec([nativeToScVal("Price", { type: "symbol" }), address(asset)]);
  let entry: rpc.Api.LedgerEntryResult;
  try {
    entry = await leash.server.getContractData(router, key, rpc.Durability.Persistent);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 404) return null;
    throw error;
  }
  const data = entry.val;
  if (data.type !== "contractData") throw new Error("Unexpected ledger entry for the forced price");
  return scValToNative(data.contractData.val) as bigint;
}

/** Live readings of the crash vault and the demo oracle; unpriced values come back `null`. */
export async function readCrashLive(leash: Leash, vaultId = CRASH_VAULT_ID): Promise<CrashLive> {
  const { vault: address, router } = crashTarget(leash, vaultId);
  const vault = leash.vault(address);
  const priced = <T>(read: Promise<T>) => read.catch(() => null);
  const [demo, forcedPrice, xlmPrice, health, nav, pps, paused, policy, positions] = await Promise.all([
    leash.read<boolean>(router, "is_demo"),
    demoPrice(leash, router, TESTNET.xlm),
    priced(leash.price(TESTNET.xlm)),
    priced(vault.healthFactor()),
    priced(vault.nav()),
    priced(vault.pricePerShare()),
    vault.paused(),
    vault.policy(),
    priced(vault.positions()),
  ]);
  return {
    demo, forcedPrice, xlmPrice,
    healthFactor: health === null || health > NO_DEBT ? null : health,
    minHealth: policy.limits.min_health_factor_bps,
    maxDrawdown: policy.limits.max_drawdown_bps,
    nav, pps, paused,
    debt: positions ? -sum(positions, p => p.kind === "debt" && p.asset === TESTNET.usdc, "amount") : null,
  };
}

/**
 * Crash scenario on the demo Leverage vault (testnet): the demo oracle drops XLM by 30 %, the
 * yield agent's borrow is refused `HealthFactorTooLow`, the keeper's `check_drawdown` pauses the
 * vault, the risk-off role is refused `RiskIncreased` when it tries to borrow, the risk-off agent
 * repays Blend debt while paused, and a depositor withdraws. Every step is a real transaction
 * read back with `getTransaction`. `restore` puts the price, the pause and the Blend book back.
 */
export class CrashScenario {
  readonly leash: Leash;
  readonly vaultId: string;
  readonly vaultAddress: string;
  private readonly router: string;
  private readonly keys: CrashKeys;
  private readonly depositAmount: bigint;
  private readonly onEntry: ((entry: JournalEntry) => void) | undefined;
  private readonly done = new Set<CrashStep>();
  private startBook: Book | null = null;
  private healthBefore: bigint | null = null;
  private ppsBefore: bigint | null = null;
  /** XLM price read before the first crash attempt: a retry must not compound the drop. */
  private xlmBefore: bigint | null = null;
  private refusedBorrow = DUST;
  private demoEnabledHere = false;
  private crashed = false;
  /** The baseline drawdown check paused the vault before any crash. */
  private pausedHere = false;
  /** A restore ran: no further step. */
  private over = false;
  /** A restore ran and every one of its transactions landed. */
  private restored = false;

  constructor(opts: CrashOptions) {
    this.leash = opts.leash ?? new Leash(opts.deployments ? { deployments: opts.deployments } : {});
    this.vaultId = opts.vault ?? CRASH_VAULT_ID;
    const { vault, router } = crashTarget(this.leash, this.vaultId);
    this.vaultAddress = vault;
    this.router = router;
    this.keys = opts.keys;
    this.depositAmount = opts.depositAmount ?? UNIT;
    this.onEntry = opts.onEntry;
  }

  private get vault() {
    return this.leash.vault(this.vaultAddress);
  }

  /** First step not run yet; `null` once every step ran or a restore ran. */
  next(): CrashStep | null {
    if (this.over) return null;
    return CRASH_STEPS.find(step => !this.done.has(step)) ?? null;
  }

  /** This scenario changed the oracle or the pause (or may have) and no restore has fully succeeded yet. */
  get needsRestore(): boolean {
    return !this.restored && (this.crashed || this.demoEnabledHere || this.pausedHere);
  }

  async run(step: CrashStep): Promise<CrashStepResult> {
    if (step === "restore") {
      if (this.restored) throw new CrashError("This scenario is already restored.");
      this.over = true;
      const result = await this.restore();
      this.restored = result.ok;
      return result;
    }
    const expected = this.next();
    if (step !== expected) throw new CrashError(expected ? `Run the steps in order: next is ${expected}.` : "This scenario is over.");
    let result: CrashStepResult;
    switch (step) {
      case "prepare": result = await this.prepare(); break;
      case "crash": result = await this.crash(); break;
      case "yield-refused": result = await this.yieldRefused(); break;
      case "pause": result = await this.pause(); break;
      case "riskoff-refused": result = await this.riskoffRefused(); break;
      case "riskoff-repay": result = await this.riskoffRepay(); break;
      case "withdraw": result = await this.withdraw(); break;
    }
    this.done.add(step);
    return result;
  }

  /** Reads `tx` back from the RPC and fails unless it landed with `expected` (and `error`). */
  private async confirm(label: string, tx: TxResult, expected: TxResult["status"], error?: string): Promise<CrashTx> {
    const onChain = await this.leash.server.getTransaction(tx.hash);
    const found = tx.error?.name;
    if (onChain.status !== expected || tx.status !== expected) {
      throw new CrashError(`${label}: expected ${expected}, the chain says ${onChain.status} (${tx.hash})`);
    }
    if (error && found !== error) throw new CrashError(`${label}: expected ${error}, got ${found ?? "no error"} (${tx.hash})`);
    return { label, hash: tx.hash, status: tx.status, ...(tx.error ? { error: tx.error } : {}) };
  }

  private routerCall(fn: string, args: xdr.ScVal[] = []): Promise<TxResult> {
    const { admin, feePayer } = this.keys;
    return this.leash.chain.invoke(feePayer ?? admin, new Contract(this.router).call(fn, ...args), [admin], "oracle");
  }

  private setPaused(paused: boolean): Promise<TxResult> {
    const { admin, feePayer } = this.keys;
    return this.leash.chain.invoke(feePayer ?? admin, new Contract(this.vaultAddress).call("set_paused", xdr.ScVal.scvBool(paused)), [admin], "vault");
  }

  private execute(member: Keypair, call: Call, opts: ExecuteOptions = {}): Promise<TxResult> {
    const { feePayer } = this.keys;
    return this.vault.execute(member, call, { ...opts, ...(feePayer ? { feePayer } : {}) });
  }

  private async book(): Promise<Book> {
    const positions = await this.vault.positions();
    return {
      debt: -sum(positions, p => p.kind === "debt" && p.asset === TESTNET.usdc, "amount"),
      collateral: sum(positions, p => p.kind === "collateral" && p.asset === TESTNET.xlm, "amount"),
      idleXlm: sum(positions, p => p.kind === "idle" && p.asset === TESTNET.xlm, "amount"),
      xlmValue: sum(positions, p => p.asset === TESTNET.xlm, "value"),
    };
  }

  /**
   * Only a borrow makes Blend price the whole account through its own oracle, and the borrows
   * here are refused: those reads come from read-only calls instead.
   */
  private async blendOracleOps(): Promise<xdr.Operation[]> {
    const { oracle } = await this.leash.read<{ oracle: string }>(TESTNET.blendPool, "get_config");
    const blendOracle = new Contract(oracle);
    const pool = new Contract(TESTNET.blendPool);
    return [
      blendOracle.call("decimals"),
      ...[TESTNET.xlm, TESTNET.usdc].flatMap(asset => [
        blendOracle.call("lastprice", xdr.ScVal.scvVec([nativeToScVal("Stellar", { type: "symbol" }), address(asset)])),
        pool.call("get_reserve", address(asset)),
      ]),
    ];
  }

  /**
   * Submits a call the vault must refuse with `error`: simulation has to refuse it first, then it
   * is sent anyway so the refusal is recorded on-chain.
   */
  private async refused(label: string, member: Keypair, call: Call, error: string, opts: ExecuteOptions): Promise<CrashTx> {
    const simulated = await this.vault.simulateExecute(member, call, opts.role ? { role: opts.role } : {});
    if (simulated.ok) throw new CrashError(`${label}: the vault accepted ${call.fn} in simulation; not submitted`);
    if (simulated.error.name !== error) throw new CrashError(`${label}: simulation refused with ${simulated.error.name}, expected ${error}`);
    return this.confirm(label, await this.execute(member, call, { ...opts, submitEvenIfRefused: true }), "FAILED", error);
  }

  private result(step: CrashStep, txs: CrashTx[], notes: string[], journal: JournalEntry[] = [], ok = true): CrashStepResult {
    return { step, txs, notes, journal, ok };
  }

  /** Demo mode on, no leftover forced price, a depositor with shares, and a pre-crash peak on record. */
  private async prepare(): Promise<CrashStepResult> {
    const vault = this.vault;
    const { depositor, keeper } = this.keys;
    if (await vault.paused()) {
      throw new CrashError("The vault is already paused (drawdown or protocol watch): restore it before simulating a crash.");
    }
    const txs: CrashTx[] = [];
    if (!await this.leash.read<boolean>(this.router, "is_demo")) {
      txs.push(await this.confirm("Demo mode switched on", await this.routerCall("set_demo", [xdr.ScVal.scvBool(true)]), "SUCCESS"));
      this.demoEnabledHere = true;
    }
    if (await demoPrice(this.leash, this.router, TESTNET.xlm) !== null) {
      txs.push(await this.confirm("Leftover demo price cleared", await this.routerCall("clear_demo_price", [address(TESTNET.xlm)]), "SUCCESS"));
    }
    if (await vault.sharesOf(depositor.publicKey()) === 0n) {
      txs.push(await this.confirm(`Depositor deposits ${formatAmount(this.depositAmount)} USDC`, await vault.deposit(depositor, this.depositAmount), "SUCCESS"));
    }

    const { limits } = await vault.policy();
    const maxDrawdown = BigInt(limits.max_drawdown_bps);
    const book = await this.book();
    const [nav, health] = await Promise.all([vault.nav(), vault.healthFactor()]);
    if (book.debt < DUST) throw new CrashError(`The vault has no Blend debt to de-risk (${formatAmount(book.debt)} USDC).`);
    const expectedDrop = book.xlmValue * CRASH_BPS / nav;
    if (expectedDrop <= maxDrawdown) {
      throw new CrashError(`A −${CRASH_BPS / 100n} % XLM move lowers price per share by ${expectedDrop} bps, inside the ${maxDrawdown} bps breaker.`);
    }
    this.startBook = book;
    this.healthBefore = health;

    // The baseline snapshot is the peak the crash is measured against.
    txs.push(await this.confirm("Keeper records the pre-crash peak (check_drawdown)", await vault.checkDrawdown(keeper), "SUCCESS"));
    if (await vault.paused()) {
      this.pausedHere = true;
      throw new CrashError("check_drawdown paused the vault before the crash: price per share already sits below its 24 h peak.");
    }
    this.ppsBefore = await vault.pricePerShare();
    return this.result("prepare", txs, [
      `NAV ${formatAmount(nav, 2)} USDC, of which ${formatAmount(book.xlmValue, 2)} USDC in XLM; Blend debt ${formatAmount(book.debt)} USDC; health factor ${formatHealth(health)}.`,
      `A −${CRASH_BPS / 100n} % XLM move lowers price per share by about ${expectedDrop} bps; the drawdown breaker trips past ${maxDrawdown} bps.`,
    ]);
  }

  private async crash(): Promise<CrashStepResult> {
    const before = this.xlmBefore ?? await this.leash.price(TESTNET.xlm);
    this.xlmBefore = before;
    const crashPrice = before * (BPS - CRASH_BPS) / BPS;
    this.crashed = true;
    const tx = await this.confirm(`Demo oracle sets XLM to ${formatAmount(crashPrice)} USDC (−${CRASH_BPS / 100n} %)`,
      await this.routerCall("set_demo_price", [address(TESTNET.xlm), i128(crashPrice)]), "SUCCESS");
    const [after, health, { limits }] = await Promise.all([this.leash.price(TESTNET.xlm), this.vault.healthFactor(), this.vault.policy()]);
    if (after !== crashPrice) throw new CrashError(`price_strict reads ${after}, expected the forced ${crashPrice}.`);
    return this.result("crash", [tx], [
      `XLM ${formatAmount(before)} → ${formatAmount(after)} USDC on the vault's oracle.`,
      `Health factor ${this.healthBefore === null ? "" : `${formatHealth(this.healthBefore)} → `}${formatHealth(health)}; the vault's floor is ${formatHealth(BigInt(limits.min_health_factor_bps))}.`,
    ]);
  }

  /** The yield agent's session key borrows more USDC: refused by the health factor floor. */
  private async yieldRefused(): Promise<CrashStepResult> {
    const [health, { debt }, { limits }] = await Promise.all([this.vault.healthFactor(), this.book(), this.vault.policy()]);
    const borrow = refusedBorrowAmount(debt, health);
    this.refusedBorrow = borrow;
    const { vaultAddress: vault } = this;
    const tx = await this.refused(`Yield agent's session key borrows ${formatAmount(borrow)} USDC`, this.keys.agent,
      actions.blendBorrow(vault, TESTNET.usdc, borrow)[0] as Call, "HealthFactorTooLow", {
        footprintFrom: actions.blendRepay(vault, TESTNET.usdc, budgetRepayAmount(debt, health, BigInt(limits.min_health_factor_bps)))[0] as Call,
        footprintOps: await this.blendOracleOps(),
      });
    return this.result("yield-refused", [tx], [
      `At a health factor of ${formatHealth(health)}, borrowing ${formatAmount(borrow)} USDC would end under the ${formatHealth(BigInt(limits.min_health_factor_bps))} floor.`,
    ]);
  }

  /** The keeper's permissionless drawdown check pauses the vault. */
  private async pause(): Promise<CrashStepResult> {
    const [pps, { limits }] = await Promise.all([this.vault.pricePerShare(), this.vault.policy()]);
    const tx = await this.confirm("Keeper calls check_drawdown", await this.vault.checkDrawdown(this.keys.keeper), "SUCCESS");
    if (!await this.vault.paused()) throw new CrashError("check_drawdown did not pause the vault after the crash.");
    const drop = this.ppsBefore ? `${(this.ppsBefore - pps) * BPS / this.ppsBefore} bps under its pre-crash level` : "under its 24 h peak";
    return this.result("pause", [tx], [`Price per share sits ${drop}, past the ${limits.max_drawdown_bps} bps drawdown breaker: the vault paused itself.`]);
  }

  /**
   * The risk-off role tries to borrow while paused: refused on its outcome. It runs before the
   * repay because the refused borrow is budgeted from a valid repay, which needs debt left.
   */
  private async riskoffRefused(): Promise<CrashStepResult> {
    const borrow = this.refusedBorrow;
    const { vaultAddress: vault } = this;
    const tx = await this.refused(`Risk-off role borrows ${formatAmount(borrow)} USDC`, this.keys.riskoff,
      actions.blendBorrow(vault, TESTNET.usdc, borrow)[0] as Call, "RiskIncreased", {
        role: RISKOFF,
        footprintFrom: actions.blendRepay(vault, TESTNET.usdc, DUST)[0] as Call,
        footprintOps: await this.blendOracleOps(),
      });
    return this.result("riskoff-refused", [tx], ["The risk-off role may act while the vault is paused, but only if the result lowers risk."]);
  }

  /** The risk-off agent (the model, under the risk-off role) repays Blend debt while paused. */
  private async riskoffRepay(): Promise<CrashStepResult> {
    const debtBefore = (await this.book()).debt;
    const journal: JournalEntry[] = [];
    const txs: CrashTx[] = [];
    const { riskoff, feePayer } = this.keys;
    for (let attempt = 1; attempt <= AGENT_ATTEMPTS && txs.length === 0; attempt++) {
      const run = await runAgent({
        vault: this.vaultId,
        role: RISKOFF,
        deployments: this.leash.deployments,
        leash: this.leash,
        keys: { member: riskoff, ...(feePayer ? { feePayer } : {}) },
        prompt: `Situation: XLM fell ${CRASH_BPS / 100n} % on the vault's oracle and the keeper paused the vault on its drawdown breaker. Reduce the vault's risk now.`,
        onEntry: entry => {
          journal.push(entry);
          this.onEntry?.(entry);
        },
      });
      const repay = run.journal.find(entry => entry.tool === "propose_execute" && entry.input?.startsWith("blend_repay")
        && entry.tx?.some(tx => tx.status === "SUCCESS"));
      const landed = repay?.tx?.find(tx => tx.status === "SUCCESS");
      if (repay && landed) {
        txs.push(await this.confirm(`Risk-off agent: ${repay.input ?? "blend_repay"}`, { hash: landed.hash, status: landed.status }, "SUCCESS"));
      }
    }
    if (txs.length === 0) throw new CrashError(`The risk-off agent did not repay Blend debt in ${AGENT_ATTEMPTS} runs.`);
    const debtAfter = (await this.book()).debt;
    if (debtAfter >= debtBefore) throw new CrashError("Blend debt did not decrease.");
    return this.result("riskoff-repay", txs, [
      `Blend debt ${formatAmount(debtBefore)} → ${formatAmount(debtAfter)} USDC; health factor now ${formatHealth(await this.vault.healthFactor())}.`,
    ], journal);
  }

  /** The depositor redeems every share while the vault is paused. */
  private async withdraw(): Promise<CrashStepResult> {
    const { depositor } = this.keys;
    const shares = await this.vault.sharesOf(depositor.publicKey());
    if (shares === 0n) throw new CrashError("The depositor holds no shares.");
    const withdrawn = await this.vault.withdraw(depositor, shares);
    const tx = await this.confirm("Depositor withdraws every share", withdrawn, "SUCCESS");
    const paid = withdrawn.returnValue ? scValToNative(withdrawn.returnValue) as bigint : 0n;
    return this.result("withdraw", [tx], [
      `Paid ${formatAmount(paid)} USDC while the vault is ${await this.vault.paused() ? "paused" : "running"}: withdrawals never wait for the agent.`,
    ]);
  }

  /** Puts the price, the pause and the Blend book back as they were before the scenario. */
  private async restore(): Promise<CrashStepResult> {
    const vault = this.vault;
    const { agent, keeper } = this.keys;
    const txs: CrashTx[] = [];
    const notes: string[] = [];
    let ok = true;
    const step = async (label: string, send: () => Promise<TxResult>): Promise<boolean> => {
      try {
        txs.push(await this.confirm(label, await send(), "SUCCESS"));
        return true;
      } catch (error) {
        ok = false;
        notes.push(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };

    if (await demoPrice(this.leash, this.router, TESTNET.xlm) !== null) {
      await step("Demo price cleared", () => this.routerCall("clear_demo_price", [address(TESTNET.xlm)]));
      const price = await this.leash.price(TESTNET.xlm).catch(() => null);
      if (price !== null) notes.push(`XLM back to ${formatAmount(price)} USDC from the oracle's sources.`);
    }
    if (this.demoEnabledHere && await step("Demo mode switched off", () => this.routerCall("set_demo", [xdr.ScVal.scvBool(false)]))) {
      this.demoEnabledHere = false;
    }
    if (await vault.paused()) {
      const halted = await vault.haltedProtocols();
      if (halted.length > 0) {
        notes.push(`Left paused: the protocol watch halted ${halted.join(", ")}; its owner must acknowledge the upgrade.`);
        return this.result("restore", txs, notes, [], false);
      }
      await step("Vault unpaused by its owner", () => this.setPaused(false));
    }
    if (await vault.paused()) return this.result("restore", txs, notes, [], false);

    if (this.startBook) {
      const start = this.startBook;
      const now = await this.book();
      if (now.idleXlm > DUST && now.collateral + DUST < start.collateral) {
        const supply = start.collateral - now.collateral < now.idleXlm ? start.collateral - now.collateral : now.idleXlm;
        await step(`Yield agent's session key supplies ${formatAmount(supply)} XLM collateral back`, () =>
          this.execute(agent, actions.blendSupplyCollateral(vault.address, TESTNET.xlm, supply)[0] as Call));
      }
      if (now.debt + DUST < start.debt) {
        const reborrow = start.debt - now.debt;
        await step(`Yield agent's session key borrows ${formatAmount(reborrow)} USDC back`, () =>
          this.execute(agent, actions.blendBorrow(vault.address, TESTNET.usdc, reborrow)[0] as Call));
      }
      notes.push(`Blend debt back to ${formatAmount((await this.book()).debt)} USDC; health factor ${formatHealth(await vault.healthFactor())}.`);
    }

    // The 24 h peak still holds the pre-crash price per share: with the price back, it must not re-pause.
    await step("Keeper calls check_drawdown", () => vault.checkDrawdown(keeper));
    if (await vault.paused()) {
      ok = false;
      notes.push("check_drawdown paused the vault again after the restore.");
      await step("Vault unpaused again", () => this.setPaused(false));
    } else {
      notes.push("Price per share is back within the breaker: the vault runs again.");
    }
    return this.result("restore", txs, notes, [], ok && !await vault.paused());
  }
}
