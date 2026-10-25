import type { CrashStepId } from "@/lib/crash/types";

export interface StepCopy {
  title: string;
  /** What happens, in one or two sentences. */
  detail: string;
  /** Label of the button that runs the step. */
  action: string;
  /** What the chain is expected to answer. */
  expect: "authorized" | "refused" | "paused" | "restored";
}

/** The guided crash, in order. Each step is one or more real testnet transactions. */
export const STEP_COPY: Record<CrashStepId, StepCopy> = {
  prepare: {
    title: "Set the stage",
    detail: "A demo depositor puts 1 USDC into the vault, then the keeper records today's price per share: the level a crash is measured against.",
    action: "Prepare the vault",
    expect: "authorized",
  },
  crash: {
    title: "XLM falls 30 %",
    detail: "The demo oracle's admin forces XLM 30 % lower. The vault reads every price from this oracle, so its XLM collateral is worth less at once.",
    action: "Simulate crash (demo oracle)",
    expect: "authorized",
  },
  "yield-refused": {
    title: "The yield agent tries to borrow more",
    detail: "A borrow signed with the yield agent's session key, sent as is (not the model's choice). The vault values the book at the new price before letting it through.",
    action: "Let the yield agent borrow",
    expect: "refused",
  },
  pause: {
    title: "The keeper checks the drawdown",
    detail: "check_drawdown is permissionless: anyone may call it. Price per share sits past the breaker, so the vault pauses itself.",
    action: "Run the keeper",
    expect: "paused",
  },
  "riskoff-refused": {
    title: "The risk-off role tries to add risk",
    detail: "The vault's second role may act while paused, but only when the outcome lowers risk. Here its key signs a borrow.",
    action: "Borrow as the risk-off role",
    expect: "refused",
  },
  "riskoff-repay": {
    title: "The risk-off agent repays debt",
    detail: "The model reads the vault and picks a de-risking call under the risk-off role. Repaying Blend debt passes, even while paused.",
    action: "Run the risk-off agent",
    expect: "authorized",
  },
  withdraw: {
    title: "A depositor withdraws",
    detail: "The demo depositor redeems every share while the vault is paused. Withdrawals never wait for the agent.",
    action: "Withdraw as the depositor",
    expect: "authorized",
  },
  restore: {
    title: "Restore the price",
    detail: "The demo price is cleared, the owner lifts the pause, the yield agent's key borrows back what was repaid, and the keeper checks the breaker again.",
    action: "Restore price and unpause",
    expect: "restored",
  },
};
