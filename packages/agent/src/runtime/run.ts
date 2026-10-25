import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openai } from "@ai-sdk/openai";
import type { Keypair } from "@stellar/stellar-sdk";
import { Leash, loadDeployments, type Deployments } from "@leash/sdk";
import { generateText, isStepCount, type LanguageModel } from "ai";
import type { BuySignalOptions } from "../tools/signals.js";
import { Journal, type JournalEntry, type JournalTx } from "./journal.js";
import type { AssetSymbol, Venues } from "./menu.js";
import { loadNewsPage, type NewsPage } from "./news.js";
import { STRATEGIES, systemPrompt, type StrategyId } from "./strategies.js";
import { TESTNET_ASSETS, knownVaults, resolveKeys, resolveVault } from "./targets.js";
import { createTools } from "./tools.js";
import { z } from "zod";

const payDeployment = z.object({
  usdc: z.string(), agent: z.string(), verifier: z.string(), signalBudget: z.string(), spendingLimit: z.string(),
});

/** Hard cap on model steps per run. */
export const MAX_STEPS = 6;
export const DEFAULT_MODEL = "gpt-4.1-mini";
/** Loss tolerated by the demo policies on volatile swaps; Soroswap `min_out` is the oracle quote minus this. */
const SWAP_MAX_LOSS_BPS = 50n;

export interface RunAgentOptions {
  /** Vault id, name or contract address. */
  vault: string;
  /** Strategy; defaults to the vault's own (by id) or `riskoff` when `role` is `riskoff`. */
  strategy?: StrategyId;
  /** Vault role to act under; defaults to the strategy's role. */
  role?: string;
  /** Poisoned page fed to `fetch_market_news` instead of a real one (attack scenarios). */
  injection?: NewsPage;
  /** URL or file read by `fetch_market_news` when there is no injection. */
  news?: string;
  /** Member key and optional fee payer; resolved from the environment when omitted. */
  keys?: { member: Keypair; feePayer?: Keypair };
  /** Paid signals; `buy_signal` is offered only when set. */
  signals?: BuySignalOptions;
  deployments?: Deployments;
  leash?: Leash;
  model?: LanguageModel;
  /** Extra instruction appended to the run prompt. */
  prompt?: string;
  onEntry?: (entry: JournalEntry) => void;
}

export interface RunAgentResult {
  vault: { id: string; name: string; address: string };
  strategy: StrategyId;
  role: string;
  model: string;
  text: string;
  steps: number;
  journal: JournalEntry[];
  /** Every submitted vault transaction, in order. */
  transactions: JournalTx[];
}

const modelName = () => process.env.OPENAI_MODEL || DEFAULT_MODEL;

/**
 * Runs one bounded management cycle of a vault: the model reads rates,
 * positions and prices, may read news or buy a signal, simulates and proposes
 * vault calls. Returns the structured journal of everything it did.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const deployments = options.deployments ?? loadDeployments();
  const leash = options.leash ?? new Leash({ deployments });
  const target = resolveVault(options.vault, knownVaults(deployments));
  const strategyId = options.strategy ?? (options.role === "riskoff" ? "riskoff" : target.strategyId);
  if (!strategyId) throw new Error(`No strategy for ${target.name}: pass one of ${Object.keys(STRATEGIES).join(", ")}`);
  const strategy = STRATEGIES[strategyId];
  const role = options.role ?? strategy.role;
  const keys = options.keys ?? resolveKeys(target, role);

  const protocol = (kind: string) => target.adapters.find(adapter => adapter.kind === kind)?.protocol;
  const [blendPool, defindexVault, aquariusPool] = [protocol("Blend"), protocol("DeFindex"), protocol("Aquarius")];
  const assets: Record<AssetSymbol, string> = { ...TESTNET_ASSETS };
  const venues: Venues = {
    vault: target.address,
    assets,
    ...(blendPool ? { blendPool } : {}),
    ...(defindexVault ? { defindexVault } : {}),
    ...(aquariusPool ? { aquariusPool, aquariusTokens: await leash.read<string[]>(aquariusPool, "get_tokens", []) } : {}),
  };

  const journal = new Journal(options.onEntry);
  const { injection, news: newsSource } = options;
  const news = injection ? async () => injection : newsSource ? () => loadNewsPage(newsSource) : undefined;
  const tools = createTools({
    leash, vault: leash.vault(target.address), venues, strategy, role, journal,
    member: keys.member,
    ...(keys.feePayer ? { feePayer: keys.feePayer } : {}),
    ...(news ? { news } : {}),
    ...(options.signals ? { signals: options.signals } : {}),
    quote: async (sell, buy, amountIn) => {
      const [sellPrice, buyPrice] = await Promise.all([leash.price(assets[sell]), leash.price(assets[buy])]);
      const scaled = amountIn * sellPrice * (10_000n - SWAP_MAX_LOSS_BPS);
      const divisor = buyPrice * 10_000n;
      return (scaled + divisor - 1n) / divisor;
    },
  });

  const name = modelName();
  const result = await generateText({
    model: options.model ?? openai(name),
    instructions: systemPrompt(strategy, target),
    prompt: [
      `Run one management cycle of ${target.name} now (${new Date().toISOString()}).`,
      options.prompt ?? "",
    ].join(" ").trim(),
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    onStepStart: ({ stepNumber }) => { journal.step = stepNumber; },
    onStepEnd: step => {
      if (step.text) journal.add({ kind: "model", text: step.text });
    },
  });
  return {
    vault: { id: target.id, name: target.name, address: target.address },
    strategy: strategy.id,
    role,
    model: options.model ? "custom" : name,
    text: result.text,
    steps: result.steps.length,
    journal: journal.entries,
    transactions: journal.entries.flatMap(entry => entry.tool === "propose_execute" ? entry.tx ?? [] : []),
  };
}

/** Signal purchase settings for the deployed signal budget, paid with `sessionKey`. */
export function signalOptions(baseUrl: string, sessionKey: Keypair): BuySignalOptions {
  const pay = payDeployment.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../../../deployments/pay.testnet.json", import.meta.url)), "utf8")));
  if (sessionKey.publicKey() !== pay.agent) throw new Error(`The signal budget session key is ${pay.agent}`);
  return {
    baseUrl,
    budget: { account: pay.signalBudget, verifier: pay.verifier, sessionKey },
    asset: pay.usdc,
    maxPrice: BigInt(pay.spendingLimit),
  };
}
