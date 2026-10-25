import { StrKey } from "@stellar/stellar-sdk";
import { actions, type Call } from "@leash/sdk";
import { z } from "zod";
import { DECIMAL_AMOUNT, fromUnits, toUnits } from "./amounts.js";

/**
 * Everything the model can ask the vault to do. The model picks one of these
 * names with amounts; the runtime turns it into `actions.*` calls from
 * `@leash/sdk` and never lets the model write raw contract arguments.
 */
export const ACTION_NAMES = [
  "blend_supply",
  "blend_withdraw",
  "blend_supply_collateral",
  "blend_withdraw_collateral",
  "blend_borrow",
  "blend_repay",
  "defindex_deposit",
  "defindex_withdraw",
  "soroswap_swap",
  "aquarius_deposit",
  "aquarius_withdraw",
  "usdc_transfer",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];
export type Menu = readonly [ActionName, ...ActionName[]];

export const ASSET_SYMBOLS = ["USDC", "XLM"] as const;
export type AssetSymbol = (typeof ASSET_SYMBOLS)[number];

/** One line per action, shown to the model in the system prompt. */
export const ACTION_DOCS: Record<ActionName, string> = {
  blend_supply: "blend_supply {asset, amount}: lend `amount` of `asset` from the vault to the Blend pool (earns the supply APR).",
  blend_withdraw: "blend_withdraw {asset, amount}: withdraw `amount` of a Blend supply position back to the vault.",
  blend_supply_collateral: "blend_supply_collateral {asset, amount}: post `amount` of `asset` as Blend collateral (enables borrowing).",
  blend_withdraw_collateral: "blend_withdraw_collateral {asset, amount}: withdraw `amount` of Blend collateral back to the vault.",
  blend_borrow: "blend_borrow {asset, amount}: borrow `amount` of `asset` from Blend against the vault's collateral.",
  blend_repay: "blend_repay {asset, amount}: repay `amount` of the vault's Blend debt in `asset`.",
  defindex_deposit: "defindex_deposit {amount}: deposit `amount` USDC into the DeFindex vault (lends on Blend through its strategy).",
  defindex_withdraw: "defindex_withdraw {amount}: redeem `amount` DeFindex vault shares for USDC.",
  soroswap_swap: "soroswap_swap {asset, amount}: sell `amount` of `asset` (USDC or XLM) for the other one on Soroswap; the minimum output is set from oracle prices.",
  aquarius_deposit: "aquarius_deposit {amount, amountXlm}: add `amount` USDC and `amountXlm` XLM to the Aquarius XLM/USDC pool.",
  aquarius_withdraw: "aquarius_withdraw {amount}: burn `amount` Aquarius LP shares for XLM and USDC.",
  usdc_transfer: "usdc_transfer {to, amount}: transfer `amount` USDC from the vault to the Stellar address `to`.",
};

const amountField = z.string().regex(DECIMAL_AMOUNT).describe('Decimal token amount with up to 7 decimals, e.g. "25" or "12.5"');

/** Tool input shared by `simulate` and `propose_execute`, restricted to the strategy's menu. */
export function proposalSchema(menu: Menu) {
  return z.object({
    action: z.enum(menu).describe("Action from the strategy menu"),
    asset: z.enum(ASSET_SYMBOLS).optional().describe("Asset for Blend actions, or the asset sold by soroswap_swap"),
    amount: amountField,
    amountXlm: amountField.optional().describe("XLM amount, only for aquarius_deposit"),
    to: z.string().optional().describe("Destination address, only for usdc_transfer"),
    rationale: z.string().max(400).optional().describe("Why this action, in one sentence"),
  });
}
/** Raw proposal as the model writes it, before {@link validateProposal}. */
export interface ProposalInput {
  action: ActionName;
  asset?: AssetSymbol | undefined;
  amount: string;
  amountXlm?: string | undefined;
  to?: string | undefined;
  rationale?: string | undefined;
}

export type Action =
  | { action: "blend_supply" | "blend_withdraw" | "blend_supply_collateral" | "blend_withdraw_collateral" | "blend_borrow" | "blend_repay"; asset: AssetSymbol; amount: bigint }
  | { action: "defindex_deposit"; amount: bigint }
  | { action: "defindex_withdraw"; shares: bigint }
  | { action: "soroswap_swap"; sell: AssetSymbol; amountIn: bigint }
  | { action: "aquarius_deposit"; usdc: bigint; xlm: bigint }
  | { action: "aquarius_withdraw"; shares: bigint }
  | { action: "usdc_transfer"; to: string; amount: bigint };

export type Validation = { ok: true; action: Action } | { ok: false; reason: string };

const positive = (value: string | undefined, name: string): bigint => {
  if (value === undefined) throw new Error(`${name} is required`);
  const units = toUnits(value);
  if (units <= 0n) throw new Error(`${name} must be greater than 0`);
  return units;
};

/**
 * Checks a proposal against the strategy menu and the fields its action needs.
 * This only rejects malformed proposals (unknown action, missing field, amount
 * not strictly positive); whether an action is allowed with these funds is
 * decided by the vault contract on-chain.
 */
export function validateProposal(menu: Menu, input: unknown): Validation {
  const parsed = proposalSchema(menu).safeParse(input);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") };
  const proposal = parsed.data;
  try {
    switch (proposal.action) {
      case "blend_supply":
      case "blend_withdraw":
      case "blend_supply_collateral":
      case "blend_withdraw_collateral":
      case "blend_borrow":
      case "blend_repay":
        if (!proposal.asset) throw new Error("asset is required");
        return { ok: true, action: { action: proposal.action, asset: proposal.asset, amount: positive(proposal.amount, "amount") } };
      case "defindex_deposit":
        return { ok: true, action: { action: proposal.action, amount: positive(proposal.amount, "amount") } };
      case "defindex_withdraw":
      case "aquarius_withdraw":
        return { ok: true, action: { action: proposal.action, shares: positive(proposal.amount, "amount") } };
      case "soroswap_swap":
        if (!proposal.asset) throw new Error("asset (the asset sold) is required");
        return { ok: true, action: { action: proposal.action, sell: proposal.asset, amountIn: positive(proposal.amount, "amount") } };
      case "aquarius_deposit":
        return { ok: true, action: { action: proposal.action, usdc: positive(proposal.amount, "amount"), xlm: positive(proposal.amountXlm, "amountXlm") } };
      case "usdc_transfer": {
        const to = proposal.to ?? "";
        if (!StrKey.isValidEd25519PublicKey(to) && !StrKey.isValidContract(to)) throw new Error("to must be a Stellar G… or C… address");
        return { ok: true, action: { action: proposal.action, to, amount: positive(proposal.amount, "amount") } };
      }
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Short human-readable form of an action, for the journal. */
export function describeAction(action: Action): string {
  switch (action.action) {
    case "defindex_deposit": return `${action.action} ${fromUnits(action.amount)} USDC`;
    case "defindex_withdraw":
    case "aquarius_withdraw": return `${action.action} ${fromUnits(action.shares)} shares`;
    case "soroswap_swap": return `${action.action} sell ${fromUnits(action.amountIn)} ${action.sell}`;
    case "aquarius_deposit": return `${action.action} ${fromUnits(action.usdc)} USDC + ${fromUnits(action.xlm)} XLM`;
    case "usdc_transfer": return `${action.action} ${fromUnits(action.amount)} USDC to ${action.to}`;
    default: return `${action.action} ${fromUnits(action.amount)} ${action.asset}`;
  }
}

/** Contract addresses the actions resolve to for one vault. */
export interface Venues {
  vault: string;
  blendPool?: string;
  assets: Record<AssetSymbol, string>;
  defindexVault?: string;
  aquariusPool?: string;
  /** Token order of the Aquarius pool (`get_tokens`), which its amount vectors follow. */
  aquariusTokens?: string[];
}

/** Minimum Soroswap output accepted for selling `amountIn` of `sell`. */
export type SwapQuote = (sell: AssetSymbol, buy: AssetSymbol, amountIn: bigint) => Promise<bigint>;

const venue = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`This vault has no ${name} venue`);
  return value;
};

/** Turns a validated action into the vault calls built by `@leash/sdk`. */
export async function buildCalls(action: Action, venues: Venues, quote: SwapQuote): Promise<Call[]> {
  const { vault, assets } = venues;
  switch (action.action) {
    case "blend_supply": return actions.blendSupply(vault, assets[action.asset], action.amount, venue(venues.blendPool, "Blend"));
    case "blend_withdraw": return actions.blendWithdraw(vault, assets[action.asset], action.amount, venue(venues.blendPool, "Blend"));
    case "blend_supply_collateral": return actions.blendSupplyCollateral(vault, assets[action.asset], action.amount, venue(venues.blendPool, "Blend"));
    case "blend_withdraw_collateral": return actions.blendWithdrawCollateral(vault, assets[action.asset], action.amount, venue(venues.blendPool, "Blend"));
    case "blend_borrow": return actions.blendBorrow(vault, assets[action.asset], action.amount, venue(venues.blendPool, "Blend"));
    case "blend_repay": return actions.blendRepay(vault, assets[action.asset], action.amount, venue(venues.blendPool, "Blend"));
    case "defindex_deposit": return actions.defindexDeposit(vault, venue(venues.defindexVault, "DeFindex"), action.amount);
    case "defindex_withdraw": return actions.defindexWithdraw(vault, venue(venues.defindexVault, "DeFindex"), action.shares);
    case "soroswap_swap": {
      const buy: AssetSymbol = action.sell === "USDC" ? "XLM" : "USDC";
      const minOut = await quote(action.sell, buy, action.amountIn);
      return actions.soroswapSwap(vault, [assets[action.sell], assets[buy]], action.amountIn, minOut);
    }
    case "aquarius_deposit": {
      const pool = venue(venues.aquariusPool, "Aquarius");
      const tokens = venues.aquariusTokens ?? [];
      const amounts = tokens.map(token => token === assets.USDC ? action.usdc : token === assets.XLM ? action.xlm : 0n);
      if (amounts.length !== 2 || amounts.includes(0n)) throw new Error("The Aquarius pool is not the XLM/USDC pool");
      return actions.aquariusDeposit(vault, pool, amounts, 0n);
    }
    case "aquarius_withdraw": {
      const pool = venue(venues.aquariusPool, "Aquarius");
      return actions.aquariusWithdraw(vault, pool, action.shares, (venues.aquariusTokens ?? []).map(() => 0n));
    }
    case "usdc_transfer": return actions.usdcTransfer(vault, action.to, action.amount);
  }
}
