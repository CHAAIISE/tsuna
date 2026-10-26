import { Address, Contract, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Call } from "./actions.js";
import { decodeResult } from "./contracts/index.js";
import type { AdapterKind } from "./deployments.js";
import { TsunaRefusal, type TsunaError } from "./errors.js";
import { decodePending, decodePolicy, type PendingPolicy, type Policy, type Role } from "./policy.js";
import type { Chain, TxResult } from "./tx.js";

export interface Usage {
  calls: number;
  day: bigint;
  hour: bigint;
  spent: bigint;
}

export interface Position {
  /** Protocol contract, or `idle` for balances the vault holds itself. */
  protocol: string;
  kind: "idle" | "supply" | "collateral" | "debt" | "shares" | "liquidity";
  asset: string;
  /** Raw units of `asset`; negative for a debt. */
  amount: bigint;
  /** Base-asset units (7 decimals) at strict oracle prices; negative for a debt. */
  value: bigint;
}

export interface Adapter {
  kind: AdapterKind;
  protocol: string;
}

export type SimResult =
  | { ok: true; navBefore?: bigint; returnValue?: xdr.ScVal }
  | { ok: false; error: TsunaError };

export interface ExecuteOptions {
  /** Role to act as; `undefined` or `default` calls `execute`, any other `execute_as`. */
  role?: string;
  /**
   * Submit even when simulation shows a refusal, so the refusal is recorded on-chain as a
   * FAILED transaction carrying the contract error.
   */
  submitEvenIfRefused?: boolean;
  /** Transaction source; `member` then only signs its authorization entry. */
  feePayer?: Keypair;
  /**
   * A valid call touching the same state as `call`, used to budget a refused submission whose
   * refusal happens after the protocol call (NAV, perimeter, risk, health or exposure checks).
   * Pre-call refusals need none.
   */
  footprintFrom?: Call;
  /**
   * Read-only operations adding state the refused call reads but no valid call of the same
   * member does, such as the price oracle a lending pool consults only to check a new borrow.
   */
  footprintOps?: xdr.Operation[];
}

const RATE_SCALAR = 1_000_000_000_000n;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const address = (value: string) => new Address(value).toScVal();
const symbol = (value: string) => nativeToScVal(value, { type: "symbol" });

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}

export class VaultClient {
  constructor(
    readonly address: string,
    private readonly chain: Chain,
    /** Funded account used as the source of read-only simulations. */
    private readonly readSource: string,
  ) {}

  private op(fn: string, args: xdr.ScVal[] = []): xdr.Operation {
    return new Contract(this.address).call(fn, ...args);
  }

  private async view<T>(fn: string, args: xdr.ScVal[] = []): Promise<T> {
    return decodeResult<T>("agentVault", fn, await this.chain.read(this.readSource, this.op(fn, args), "vault"));
  }

  private async raw<T>(contract: string, fn: string, args: xdr.ScVal[] = []): Promise<T> {
    const value = await this.chain.read(this.readSource, new Contract(contract).call(fn, ...args));
    return scValToNative(value) as T;
  }

  nav(): Promise<bigint> { return this.view("nav"); }
  pricePerShare(): Promise<bigint> { return this.view("price_per_share"); }
  paused(): Promise<boolean> { return this.view("paused"); }
  totalShares(): Promise<bigint> { return this.view("total_shares"); }
  owner(): Promise<string> { return this.view("owner"); }
  asset(): Promise<string> { return this.view("asset"); }
  oracle(): Promise<string> { return this.view("oracle"); }
  registry(): Promise<string> { return this.view("registry"); }
  highWaterMark(): Promise<bigint> { return this.view("high_water_mark"); }
  /** Lowest health factor across lending positions, bps; `i128::MAX` without debt. */
  healthFactor(): Promise<bigint> { return this.view("health_factor"); }
  /** Current session key of the default role, `null` once revoked. */
  session(): Promise<string | null> { return this.view("session"); }
  sharesOf(user: string): Promise<bigint> { return this.view("balance", [address(user)]); }

  async adapters(): Promise<Adapter[]> {
    const list = await this.view<{ kind: { tag: AdapterKind }; protocol: string }[]>("adapters");
    return list.map(({ kind, protocol }) => ({ kind: kind.tag, protocol }));
  }

  /** Budget counters of `role` (`default`: the session key's). */
  usage(role = "default"): Promise<Usage> {
    return role === "default" ? this.view("usage") : this.view("role_usage", [symbol(role)]);
  }

  /** NAV lost over the rolling 24 h window by `role`, base-asset units. */
  dailyLoss(role = "default"): Promise<bigint> {
    return role === "default" ? this.view("daily_loss") : this.view("role_daily_loss", [symbol(role)]);
  }

  private async registryCall(fn: string): Promise<xdr.ScVal> {
    const registry = await this.registry();
    return this.chain.read(this.readSource, new Contract(registry).call(fn, address(this.address)), "registry");
  }

  /** Policy in force in the registry, `null` before the owner registers one. */
  async findPolicy(): Promise<Policy | null> {
    const value = await this.registryCall("policy");
    return value.type === "scvVoid" ? null : decodePolicy(value);
  }

  /** Policy in force in the registry; fails for a vault without policy. */
  async policy(): Promise<Policy> {
    const policy = await this.findPolicy();
    if (!policy) throw new Error(`Vault ${this.address} has no registered policy`);
    return policy;
  }

  /** Loosening waiting for its public timelock, if any. */
  async pendingPolicy(): Promise<PendingPolicy | null> {
    return decodePending(await this.registryCall("pending_policy"));
  }

  /** Every role, `default` included (the session key with the policy's own calls and limits). */
  async roles(): Promise<Record<string, Role>> {
    const [policy, session] = await Promise.all([this.policy(), this.session()]);
    const { calls_per_hour, daily_cap_bps, daily_loss_bps, tx_cap_bps } = policy.limits;
    const roles: Record<string, Role> = {};
    if (session) {
      roles.default = {
        member: session, mode: "Normal", calls: policy.calls,
        quota: { calls_per_hour, daily_cap_bps, daily_loss_bps, tx_cap_bps },
      };
    }
    return { ...roles, ...policy.roles };
  }

  /**
   * Holdings recomputed from raw protocol reads, valued like the vault's strict NAV: idle
   * balances, Blend supply/collateral/debt, DeFindex shares and Aquarius liquidity. Amounts are
   * raw asset units; values are base-asset units, negative for debts.
   */
  async positions(): Promise<Position[]> {
    const [asset, oracle, adapters, policy] = await Promise.all([this.asset(), this.oracle(), this.adapters(), this.policy()]);
    const quotes = new Map<string, Promise<{ price: bigint; unit: bigint }>>();
    const quote = (token: string) => {
      let found = quotes.get(token);
      if (!found) {
        found = Promise.all([
          this.chain.read(this.readSource, new Contract(oracle).call("price_strict", address(token)), "oracle")
            .then(value => scValToNative(value) as bigint)
            .catch((error: unknown) => {
              // Strict NAV counts an asset without a feed as worth 0.
              if (error instanceof TsunaRefusal && error.error.contract === "oracle" && error.error.name === "NoPriceFeed") return 0n;
              throw error;
            }),
          this.raw<number>(token, "decimals"),
        ]).then(([price, decimals]) => ({ price, unit: 10n ** BigInt(decimals) }));
        quotes.set(token, found);
      }
      return found;
    };
    const value = async (token: string, amount: bigint, up = false) => {
      if (token === asset || amount === 0n) return amount;
      const [{ price, unit }, base] = await Promise.all([quote(token), quote(asset)]);
      if (price === 0n || base.price === 0n) return 0n;
      const [n, d] = [amount * price * base.unit, base.price * unit];
      return up ? ceil(n, d) : n / d;
    };
    const idle = await Promise.all(policy.assets.map(async token => {
      const amount = await this.raw<bigint>(token, "balance", [address(this.address)]);
      return { protocol: "idle", kind: "idle", asset: token, amount, value: await value(token, amount) } satisfies Position;
    }));
    const held = await Promise.all(adapters.map(async ({ kind, protocol }): Promise<Position[]> => {
      switch (kind) {
        case "Blend": {
          const book = await this.raw<Record<"supply" | "collateral" | "liabilities", Record<string, bigint>>>(
            protocol, "get_positions", [address(this.address)]);
          const reserves = await this.raw<string[]>(protocol, "get_reserve_list");
          const lines: Promise<Position>[] = [];
          for (const [slot, kind] of [["supply", "supply"], ["collateral", "collateral"], ["liabilities", "debt"]] as const) {
            for (const [index, tokens] of Object.entries(book[slot])) {
              if (tokens === 0n) continue;
              const reserveAsset = reserves[Number(index)];
              if (!reserveAsset) throw new Error(`Unknown Blend reserve ${index}`);
              lines.push(this.raw<{ data: { b_rate: bigint; d_rate: bigint } }>(protocol, "get_reserve", [address(reserveAsset)])
                .then(async ({ data }) => {
                  const debt = kind === "debt";
                  const amount = debt ? ceil(tokens * data.d_rate, RATE_SCALAR) : tokens * data.b_rate / RATE_SCALAR;
                  const worth = await value(reserveAsset, amount, debt);
                  return { protocol, kind, asset: reserveAsset, amount: debt ? -amount : amount, value: debt ? -worth : worth };
                }));
            }
          }
          return Promise.all(lines);
        }
        case "DeFindex": {
          const shares = await this.raw<bigint>(protocol, "balance", [address(this.address)]);
          if (shares === 0n) return [];
          const [amounts, assets] = await Promise.all([
            this.raw<bigint[]>(protocol, "get_asset_amounts_per_shares", [nativeToScVal(shares, { type: "i128" })]),
            this.raw<{ address: string }[]>(protocol, "get_assets"),
          ]);
          return Promise.all(assets.map(async ({ address: token }, i) => {
            const amount = amounts[i] ?? 0n;
            return { protocol, kind: "shares", asset: token, amount, value: await value(token, amount) } satisfies Position;
          }));
        }
        case "Aquarius": {
          const lp = await this.raw<bigint>(protocol, "get_user_shares", [address(this.address)]);
          if (lp === 0n) return [];
          const [total, reserves, tokens] = await Promise.all([
            this.raw<bigint>(protocol, "get_total_shares"),
            this.raw<bigint[]>(protocol, "get_reserves"),
            this.raw<string[]>(protocol, "get_tokens"),
          ]);
          const values = await Promise.all(tokens.map((token, i) => value(token, reserves[i] ?? 0n)));
          // The vault values LP at the pool invariant, 2·√(v₀·v₁), which a skewed pool cannot inflate.
          const poolValue = 2n * isqrt((values[0] ?? 0n) * (values[1] ?? 0n));
          const ownValue = poolValue * lp / total;
          const sum = values.reduce((a, b) => a + b, 0n);
          return tokens.map((token, i) => ({
            protocol, kind: "liquidity", asset: token,
            amount: (reserves[i] ?? 0n) * lp / total,
            value: sum === 0n ? 0n : ownValue * (values[i] ?? 0n) / sum,
          }));
        }
        case "Soroswap":
          return [];
        case "Xoxno":
          throw new Error("XOXNO positions are not decoded by the SDK");
      }
    }));
    return [...idle, ...held.flat()];
  }

  async deposit(user: Keypair, amount: bigint): Promise<TxResult> {
    return this.chain.invoke(user, this.op("deposit", [address(user.publicKey()), nativeToScVal(amount, { type: "i128" })]), [user], "vault");
  }

  async withdraw(user: Keypair, shares: bigint): Promise<TxResult> {
    return this.chain.invoke(user, this.op("withdraw", [address(user.publicKey()), nativeToScVal(shares, { type: "i128" })]), [user], "vault");
  }

  /** `execute(target, fn, args)` for the default role, `execute_as(member, role, …)` otherwise. */
  executeOperation(member: string, call: Call, role = "default"): xdr.Operation {
    const tail = [address(call.target), symbol(call.fn), xdr.ScVal.scvVec(call.args)];
    return role === "default" ? this.op("execute", tail) : this.op("execute_as", [address(member), symbol(role), ...tail]);
  }

  /** Dry run of `call` by `member` (a key or its public address), with the NAV before it. */
  async simulateExecute(member: Keypair | string, call: Call, opts: { role?: string } = {}): Promise<SimResult> {
    const publicKey = typeof member === "string" ? member : member.publicKey();
    try {
      const [navBefore, { simulation }] = await Promise.all([
        this.nav(),
        this.chain.simulate(publicKey, this.executeOperation(publicKey, call, opts.role), "vault"),
      ]);
      return { ok: true, navBefore, ...(simulation.result ? { returnValue: simulation.result.retval } : {}) };
    } catch (error) {
      if (error instanceof TsunaRefusal) return { ok: false, error: error.error };
      throw error;
    }
  }

  /**
   * Signs and submits `call`. A refusal at simulation throws {@link TsunaRefusal}, unless
   * `submitEvenIfRefused` is set: the transaction is then sent with a budget reconstructed from
   * valid simulations and returns `{ status: "FAILED", hash, error }`.
   */
  async execute(member: Keypair, call: Call, opts: ExecuteOptions = {}): Promise<TxResult> {
    const role = opts.role ?? "default";
    const source = opts.feePayer ?? member;
    const operation = this.executeOperation(member.publicKey(), call, role);
    try {
      return await this.chain.invoke(source, operation, [member], "vault");
    } catch (error) {
      if (!(error instanceof TsunaRefusal) || !opts.submitEvenIfRefused) throw error;
    }
    const registry = await this.registry();
    const roleArgs = role === "default" ? [] : [symbol(role)];
    const siblings = [
      this.op("nav"),
      this.op(role === "default" ? "usage" : "role_usage", roleArgs),
      this.op(role === "default" ? "daily_loss" : "role_daily_loss", roleArgs),
      this.op("session"),
      new Contract(registry).call("policy", address(this.address)),
    ];
    if (opts.footprintFrom) siblings.push(this.executeOperation(member.publicKey(), opts.footprintFrom, role));
    if (opts.footprintOps) siblings.push(...opts.footprintOps);
    return this.chain.submitRefused({ source, member, operation, siblings, writable: [this.address], fallback: "vault" });
  }

  /** Permissionless drawdown check: pauses the vault past its drawdown limit. */
  async checkDrawdown(caller: Keypair): Promise<TxResult> {
    return this.chain.invoke(caller, this.op("check_drawdown"), [caller], "vault");
  }

  /** Wasm hash (hex) the vault pinned for `protocol`, `null` before its first use. */
  async protocolHash(protocol: string): Promise<string | null> {
    const hash = await this.view<Uint8Array | null>("protocol_hash", [address(protocol)]);
    return hash ? Buffer.from(hash).toString("hex") : null;
  }

  /** Protocols whose upgrade paused the vault and that the owner has not acknowledged yet. */
  haltedProtocols(): Promise<string[]> { return this.view("halted_protocols"); }

  /** Permissionless: pins unseen protocol hashes and pauses the vault if a pinned one changed. */
  async checkProtocols(caller: Keypair): Promise<TxResult> {
    return this.chain.invoke(caller, this.op("check_protocols"), [caller], "vault");
  }

  /** Owner revalidates `protocol` at its current Wasm hash; lifts a pause the upgrade caused. */
  async acknowledgeProtocol(owner: Keypair, protocol: string, wasmHash: string): Promise<TxResult> {
    const hash = xdr.ScVal.scvBytes(Buffer.from(wasmHash, "hex"));
    return this.chain.invoke(owner, this.op("acknowledge_protocol", [address(protocol), hash]), [owner], "vault");
  }
}
