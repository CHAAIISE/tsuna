import "server-only";
import { TESTNET, parseDeployments, type Deployments } from "@leash/sdk";
import agentFile from "../../../deployments/agent.testnet.json";
import passkeyFile from "../../../deployments/passkey.testnet.json";
import fleetFile from "../../../deployments/testnet.json";

/** The demo fleet, as deployed by the deploy and seed scripts (what the agent runtime resolves keys against). */
export const fleet = parseDeployments(fleetFile);

/** Vaults deployed with keys of their own for the agent runtime, named for display. */
const extraVaults = agentFile.vaults.map(vault => ({
  id: vault.id,
  name: vault.name,
  slug: vault.slug,
  strategy: vault.strategy,
  strategyId: vault.strategyId,
  address: vault.address,
  assets: vault.assets,
  adapters: vault.adapters.map(adapter => ({ kind: adapter.kind as "Blend" | "DeFindex", protocol: adapter.protocol })),
}));

/** Deployments the web app reads with: the fleet plus the runtime's extra vaults (names only). */
export const deployments: Deployments = { ...fleet, vaults: [...fleet.vaults, ...extraVaults] };

const featured = new Set(fleet.vaults.map(vault => vault.address));
export const isFeatured = (address: string) => featured.has(address);

/** Fee payers and attackers whose failed transactions may target a vault. */
export const extraSources: string[] = [
  ...agentFile.vaults.flatMap(vault => vault.feePayer ? [vault.feePayer.address] : []),
];

const assetSymbols: Record<string, string> = {
  [TESTNET.usdc]: "USDC",
  [TESTNET.xlm]: "XLM",
  [TESTNET.wbtc]: "wBTC",
  [TESTNET.weth]: "wETH",
};

export const assetSymbol = (address: string) => assetSymbols[address] ?? `${address.slice(0, 4)}…${address.slice(-4)}`;

const protocolNames: [string | undefined, string][] = [
  [TESTNET.blendPool, "Blend"],
  [fleet.protocols?.blendPool, "Blend"],
  [fleet.protocols?.defindexVault, "DeFindex"],
  [fleet.protocols?.aquariusPoolXlmUsdc, "Aquarius"],
  [fleet.protocols?.aquariusRouter, "Aquarius router"],
  [fleet.protocols?.soroswapRouter, "Soroswap"],
  [fleet.protocols?.soroswapPairXlmUsdc, "Soroswap pair"],
  [fleet.protocols?.reflector, "Reflector"],
  [TESTNET.soroswapRouter, "Soroswap"],
  [TESTNET.aquariusRouter, "Aquarius router"],
  [TESTNET.defindexBlendUsdcStrategy, "DeFindex strategy"],
  [fleet.oracleRouter, "Leash oracle"],
  [fleet.policyRegistry, "Leash registry"],
  [fleet.factory, "Leash factory"],
  [passkeyFile.usdc, "USDC"],
  [TESTNET.xlm, "XLM"],
];

/** Display name of a contract the vaults call or hold positions in. */
export function contractName(address: string, adapters: { kind: string; protocol: string }[] = []): string {
  if (address === "idle") return "Vault (idle)";
  const adapter = adapters.find(entry => entry.protocol === address);
  if (adapter) return adapter.kind;
  const known = protocolNames.find(([id]) => id === address)?.[1];
  if (known) return known;
  const vault = deployments.vaults.find(entry => entry.address === address);
  return vault ? vault.name : `${address.slice(0, 4)}…${address.slice(-4)}`;
}
