import { Address, Contract, Keypair, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { encodeArgs } from "./contracts/index.js";
import { loadDeployments, required, type AdapterKind, type Deployments } from "./deployments.js";
import { LeashRefusal, describeError, isLeashError, parseHostError, type ErrorSource, type LeashError } from "./errors.js";
import { fetchSnapshots, rank, score, type LeaderboardRow, type Snapshot } from "./leaderboard.js";
import { TESTNET } from "./network.js";
import { encodePolicy, type Policy } from "./policy.js";
import { Chain, type TxResult } from "./tx.js";
import { VaultClient, type Adapter } from "./vault.js";

export interface LeashOptions {
  rpcUrl?: string;
  networkPassphrase?: string;
  /** Defaults to {@link loadDeployments}. */
  deployments?: Deployments;
  /** Funded account used as the source of read-only simulations (no signature involved). */
  readSource?: string;
}

export interface VaultSummary {
  address: string;
  /** Name from the deployments file, else the shortened address. */
  name: string;
  strategy: string | null;
  creator: string;
  /** Session key of the default role; `null` once revoked. */
  agent: string | null;
  /** `null` with `navError` when the oracle cannot vouch for a held asset right now. */
  nav: bigint | null;
  pps: bigint | null;
  navError?: LeashError;
  totalShares: bigint;
  paused: boolean;
  /** Role names, `default` included while the session key is live. */
  roles: string[];
  assets: string[];
  adapters: Adapter[];
}

export interface CreateVaultOptions {
  /** Session key of the vault's default role. */
  agent: string;
  /** Initial policy, registered before any deposit (no timelock). */
  policy: Policy;
  /** Adapters to set once the policy is registered (their protocols must be in the policy). */
  adapters?: { kind: AdapterKind; protocol: string }[];
  /** Receives the protocol's share of performance fees; defaults to the deployments' keeper. */
  protocolRecipient?: string;
}

export interface CreatedVault {
  address: string;
  deployTx: string;
  registerTx: string;
  adapterTxs: string[];
}

const short = (id: string) => `${id.slice(0, 4)}…${id.slice(-4)}`;

export class Leash {
  readonly deployments: Deployments;
  readonly server: rpc.Server;
  readonly chain: Chain;
  readonly networkPassphrase: string;
  private readonly readSource: string;
  /** Vault addresses seen through this client, for naming their errors. */
  private readonly knownVaults = new Set<string>();

  constructor(opts: LeashOptions = {}) {
    this.deployments = opts.deployments ?? loadDeployments();
    this.networkPassphrase = opts.networkPassphrase ?? TESTNET.networkPassphrase;
    this.server = new rpc.Server(opts.rpcUrl ?? TESTNET.rpcUrl);
    const source = opts.readSource ?? this.deployments.keeper ?? this.deployments.admin ?? this.deployments.agent;
    if (!source) throw new Error("No funded account to simulate reads from: pass readSource");
    this.readSource = source;
    for (const vault of this.deployments.vaults) this.knownVaults.add(vault.address);
    this.chain = new Chain(this.server, this.networkPassphrase, id => this.classify(id));
  }

  /** Kind of contract `contractId`, from the deployments file and the vaults seen so far. */
  classify(contractId: string): ErrorSource {
    const d = this.deployments;
    if (contractId === d.policyRegistry) return "registry";
    if (contractId === d.oracleRouter || contractId === d.oracleRouterStrict) return "oracle";
    if (contractId === d.factory) return "factory";
    if (contractId === d.signalBudget) return "signal_budget";
    if (this.knownVaults.has(contractId)) return "vault";
    return "other";
  }

  vault(address: string): VaultClient {
    this.knownVaults.add(address);
    return new VaultClient(address, this.chain, this.readSource);
  }

  /** Return value of a read-only call, converted with `scValToNative`. */
  async read<T>(contract: string, fn: string, args: xdr.ScVal[] = []): Promise<T> {
    return scValToNative(await this.chain.read(this.readSource, new Contract(contract).call(fn, ...args))) as T;
  }

  /** Strict oracle price of `asset` in USDC, 7 decimals (the price the vault uses for the agent). */
  async price(asset: string): Promise<bigint> {
    return this.read(required(this.deployments, "oracleRouter"), "price_strict", [new Address(asset).toScVal()]);
  }

  /** Vaults deployed by the factory, newest last. */
  async vaultAddresses(): Promise<string[]> {
    const list = await this.read<string[]>(required(this.deployments, "factory"), "vaults");
    for (const address of list) this.knownVaults.add(address);
    return list;
  }

  async vaults(): Promise<VaultSummary[]> {
    const addresses = await this.vaultAddresses();
    return Promise.all(addresses.map(address => this.summary(address)));
  }

  async summary(address: string): Promise<VaultSummary> {
    const vault = this.vault(address);
    const record = this.deployments.vaults.find(v => v.address === address);
    const [nav, owner, session, totalShares, paused, policy, adapters] = await Promise.all([
      Promise.all([vault.nav(), vault.pricePerShare()]).catch((error: unknown) => {
        if (error instanceof LeashRefusal) return error.error;
        throw error;
      }),
      vault.owner(),
      vault.session(),
      vault.totalShares(),
      vault.paused(),
      vault.policy().catch(() => null),
      vault.adapters(),
    ]);
    const creator = await this.read<string | null>(required(this.deployments, "policyRegistry"), "creator", [new Address(address).toScVal()]);
    const priced = Array.isArray(nav);
    return {
      address,
      name: record?.name ?? short(address),
      strategy: record?.strategy ?? null,
      creator: creator ?? owner,
      agent: session,
      nav: priced ? nav[0] : null,
      pps: priced ? nav[1] : null,
      ...(priced ? {} : { navError: nav }),
      totalShares,
      paused,
      roles: [...(session ? ["default"] : []), ...Object.keys(policy?.roles ?? {})],
      assets: policy?.assets ?? [await vault.asset()],
      adapters,
    };
  }

  /**
   * Leaderboard from on-chain `NavSnapshot` events of every factory vault, best return first.
   * History is bounded by the RPC event retention (about 7 days on testnet); each row's `since`
   * is its first retained snapshot.
   */
  async leaderboard(): Promise<LeaderboardRow[]> {
    const vaults = [...new Set([...await this.vaultAddresses(), ...this.deployments.vaults.map(v => v.address)])];
    const { snapshots } = await fetchSnapshots(this.server, vaults);
    const byVault = new Map<string, Snapshot[]>();
    for (const snapshot of snapshots) byVault.set(snapshot.vault, [...(byVault.get(snapshot.vault) ?? []), snapshot]);
    return rank([...byVault.values()].map(list => score(list)));
  }

  /** Contract error carried by `e`: a refusal, a transaction result or a host error text. */
  decodeError(e: unknown): LeashError | null {
    if (e instanceof LeashRefusal) return e.error;
    if (typeof e === "object" && e !== null && "error" in e) {
      const { error } = e;
      if (isLeashError(error)) return error;
      if (typeof error === "string") return this.decodeError(error);
    }
    const text = e instanceof Error ? e.message : typeof e === "string" ? e : null;
    if (!text) return null;
    const raw = parseHostError(text);
    if (!raw) return null;
    return raw.contractId ? describeError(this.classify(raw.contractId), raw.code) : describeError("other", raw.code);
  }

  /**
   * Deploys a vault through the factory, on the factory's shared executable (CAP-85). The vault
   * cannot act or take deposits until its owner registers a policy.
   */
  async deployVault(creator: Keypair, opts: { agent: string; asset: string; protocolRecipient?: string }): Promise<{ address: string; hash: string }> {
    const params = {
      asset: opts.asset,
      oracle: required(this.deployments, "oracleRouter"),
      protocol_recipient: opts.protocolRecipient ?? required(this.deployments, "keeper"),
      registry: required(this.deployments, "policyRegistry"),
    };
    const deployed = await this.chain.invoke(creator, new Contract(required(this.deployments, "factory")).call("deploy_vault",
      ...encodeArgs("vaultFactory", "deploy_vault", { creator: creator.publicKey(), agent: opts.agent, params })), [creator], "factory");
    if (deployed.status !== "SUCCESS" || !deployed.returnValue) throw new Error(`deploy_vault failed: ${deployed.hash}`);
    const address = scValToNative(deployed.returnValue) as string;
    this.knownVaults.add(address);
    return { address, hash: deployed.hash };
  }

  /**
   * Deploys a vault through the factory, registers `policy` for it (before any deposit, so
   * without timelock) and sets its adapters. `creator` owns the vault and signs every step.
   */
  async createVault(creator: Keypair, opts: CreateVaultOptions): Promise<CreatedVault> {
    const asset = opts.policy.assets[0];
    if (!asset) throw new Error("The policy needs a base asset");
    const deployed = await this.deployVault(creator, {
      agent: opts.agent, asset, ...(opts.protocolRecipient ? { protocolRecipient: opts.protocolRecipient } : {}),
    });
    const { address } = deployed;
    const registry = required(this.deployments, "policyRegistry");
    const registered = await this.chain.invoke(creator, new Contract(registry).call("register",
      new Address(address).toScVal(), encodePolicy(opts.policy)), [creator], "registry");
    if (registered.status !== "SUCCESS") throw new Error(`register failed: ${registered.hash}`);
    const adapterTxs: string[] = [];
    for (const adapter of opts.adapters ?? []) {
      const set = await this.chain.invoke(creator, new Contract(address).call("set_adapter",
        xdr.ScVal.scvVec([nativeToScVal(adapter.kind, { type: "symbol" })]), new Address(adapter.protocol).toScVal()), [creator], "vault");
      if (set.status !== "SUCCESS") throw new Error(`set_adapter failed: ${set.hash}`);
      adapterTxs.push(set.hash);
    }
    return { address, deployTx: deployed.hash, registerTx: registered.hash, adapterTxs };
  }

  /** Submits a policy change for `vault`: tightening applies now, loosening waits for the timelock. */
  async proposePolicy(creator: Keypair, vault: string, policy: Policy): Promise<TxResult> {
    return this.chain.invoke(creator, new Contract(required(this.deployments, "policyRegistry")).call("propose_policy",
      new Address(vault).toScVal(), encodePolicy(policy)), [creator], "registry");
  }
}
