import "server-only";
import { Address, Contract, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { TESTNET, composePolicy, encodePolicy, presets, type CallPresetId, type Policy, type TxResult, type Venues } from "@tsuna/sdk";
import { z } from "zod";
import { FleetError } from "./admin";
import { deployments, tsuna, serverKey } from "./config";
import {
  DAILY_LOSS_OPTIONS, DRAWDOWN_OPTIONS, EXPOSURE_OPTIONS, PROTOCOL_CAP_BPS, STRATEGIES,
  type AssetSymbol, type CreateChoice, type PresetInfo, type Strategy,
} from "./strategies";

const FEE_SECRET = "LEASH_CREATE_FEE_SECRET";
const CREATOR_SECRET = "LEASH_CREATOR_SECRET";

/** Account that signs every vault published with Create (they are listed as community agents), or null when not configured. */
export function publisherAccount(): string | null {
  return serverKey(CREATOR_SECRET)?.publicKey() ?? null;
}

export const createChoice = z.object({
  strategy: z.enum(["yield", "leverage", "liquidity"]),
  venues: z.array(z.string()).min(1),
  dailyLossBps: z.number().refine(value => DAILY_LOSS_OPTIONS.some(option => option.value === value)),
  drawdownBps: z.number().refine(value => DRAWDOWN_OPTIONS.some(option => option.value === value)),
  exposure: z.enum(EXPOSURE_OPTIONS.map(option => option.value) as ["vault", "capped"]),
  riskOff: z.boolean(),
}) satisfies z.ZodType<CreateChoice>;

const ASSETS: Record<AssetSymbol, string> = { USDC: TESTNET.usdc, XLM: TESTNET.xlm };

/** Labels and descriptions of the presets the strategies use, for the form. */
export function presetCatalog(): Record<string, PresetInfo> {
  const ids = new Set(STRATEGIES.flatMap(strategy => strategy.venues.flatMap(venue => venue.presets)));
  return Object.fromEntries([...ids, "riskOff"].map(id => {
    const preset = presets[id as keyof typeof presets];
    return [id, { id, label: preset.label, description: preset.description }];
  }));
}

/** Venues of the demo deployment (the same pools and vaults as the demo agents). */
function venues(): Venues {
  const protocols = deployments.protocols ?? {};
  const blendPool = protocols.blendPool ?? TESTNET.blendPool;
  return {
    blendPool,
    defindexCustody: [protocols.defindexBlendUsdcStrategy ?? TESTNET.defindexBlendUsdcStrategy, blendPool],
    soroswapRouter: protocols.soroswapRouter ?? TESTNET.soroswapRouter,
    soroswapPairs: protocols.soroswapPairXlmUsdc ? [protocols.soroswapPairXlmUsdc] : [],
    ...(protocols.defindexVault ? { defindexVault: protocols.defindexVault } : {}),
    ...(protocols.aquariusPoolXlmUsdc ? { aquariusPool: protocols.aquariusPoolXlmUsdc } : {}),
  };
}

type Adapter = { kind: Strategy["venues"][number]["adapter"]; protocol: string };

/** Policy and adapters of a validated choice, composed from the SDK presets only. */
export function composeChoice(choice: CreateChoice): { strategy: Strategy; policy: Policy; adapters: Adapter[] } {
  const strategy = STRATEGIES.find(item => item.id === choice.strategy);
  if (!strategy) throw new FleetError("Unknown strategy.");
  const picked = strategy.venues.filter(venue => !venue.optional || choice.venues.includes(venue.id));
  if (picked.length === 0) throw new FleetError("Keep at least one protocol.");
  const riskOffMember = deployments.vaults.find(vault => typeof vault.riskoffMember === "string")?.riskoffMember;
  if (choice.riskOff && typeof riskOffMember !== "string") throw new FleetError("No risk-off agent key is published.", 503);
  const venueAddresses = venues();
  const adapters = picked.map(venue => {
    const protocol = presets[venue.presets[0] as CallPresetId].grant(venueAddresses).protocols[0];
    if (!protocol) throw new FleetError("A protocol of this strategy is not deployed.", 503);
    return { kind: venue.adapter, protocol };
  });
  const positions = adapters.filter(adapter => adapter.kind !== "Soroswap").map(adapter => adapter.protocol);
  const policy = composePolicy({
    assets: strategy.assets.map(symbol => ASSETS[symbol]),
    venues: venueAddresses,
    actions: picked.flatMap(venue => venue.presets).map(preset => ({ preset: preset as CallPresetId, volatile: strategy.volatile })),
    limits: { daily_loss_bps: choice.dailyLossBps, max_drawdown_bps: choice.drawdownBps },
    ...(choice.exposure === "capped" ? { exposureCaps: Object.fromEntries(positions.map(protocol => [protocol, PROTOCOL_CAP_BPS])) } : {}),
    ...(choice.riskOff && typeof riskOffMember === "string" ? { riskOffMember } : {}),
  });
  return { strategy, policy, adapters };
}

let queue: Promise<unknown> = Promise.resolve();

export interface Published {
  vault: string;
  creator: string;
  deployTx: string;
  registerTx: string;
  adapterTxs: string[];
}

/**
 * Deploys a vault through the demo factory, registers its policy before any deposit (no
 * timelock) and sets its adapters. The demo creator key signs every authorization; a separate
 * fee payer is the source of every transaction.
 */
export function publishAgent(choice: CreateChoice): Promise<Published> {
  const fee = serverKey(FEE_SECRET);
  const creator = serverKey(CREATOR_SECRET);
  const { factory, policyRegistry, keeper, agent } = deployments;
  // Published agents read the production router; only the crash demo vault reads the demo one.
  const oracleRouter = deployments.oracleRouterStrict ?? deployments.oracleRouter;
  if (!fee || !creator || !factory || !policyRegistry || !oracleRouter || !keeper || !agent) {
    return Promise.reject(new FleetError("Publishing is not configured on this server.", 503));
  }
  const { policy, adapters } = composeChoice(choice);
  const client = tsuna();
  const run = async (operation: xdr.Operation, source: "factory" | "registry" | "vault"): Promise<TxResult> => {
    const result = await client.chain.invoke(fee, operation, [creator], source).catch((error: unknown) => {
      const refusal = client.decodeError(error);
      throw refusal ? new FleetError(refusal.message, 409, refusal.name) : error;
    });
    if (result.status !== "SUCCESS") {
      throw new FleetError(result.error?.message ?? `The transaction failed on-chain (${result.hash}).`, 422, result.error?.name);
    }
    return result;
  };
  const task = async (): Promise<Published> => {
    const params = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("asset"), val: new Address(policy.assets[0] ?? TESTNET.usdc).toScVal() }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("oracle"), val: new Address(oracleRouter).toScVal() }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("protocol_recipient"), val: new Address(keeper).toScVal() }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("registry"), val: new Address(policyRegistry).toScVal() }),
    ]);
    const deployed = await run(new Contract(factory).call("deploy_vault",
      new Address(creator.publicKey()).toScVal(), new Address(agent).toScVal(), params), "factory");
    if (!deployed.returnValue) throw new FleetError("The factory returned no vault address.", 502);
    const vault = scValToNative(deployed.returnValue) as string;
    client.vault(vault);
    const registered = await run(new Contract(policyRegistry).call("register", new Address(vault).toScVal(), encodePolicy(policy)), "registry");
    const adapterTxs: string[] = [];
    for (const adapter of adapters) {
      const set = await run(new Contract(vault).call("set_adapter",
        xdr.ScVal.scvVec([nativeToScVal(adapter.kind, { type: "symbol" })]), new Address(adapter.protocol).toScVal()), "vault");
      adapterTxs.push(set.hash);
    }
    return { vault, creator: creator.publicKey(), deployTx: deployed.hash, registerTx: registered.hash, adapterTxs };
  };
  // One fee payer: publications run one at a time so sequence numbers never collide.
  const next = queue.catch(() => undefined).then(task);
  queue = next;
  return next;
}
