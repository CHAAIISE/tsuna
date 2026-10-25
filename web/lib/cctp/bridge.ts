import { Keypair } from "@stellar/stellar-sdk";
import { cctp, stellar } from "#cctp/config";
import { assertForwarderMessage, cctpToStellarAmount, decodeBurnMessage, maxFeeFor, mintedOnStellar } from "#cctp/encoding";
import { formatUsdc } from "#cctp/format";
import { fetchMinimumFeeBps, pollAttestation } from "#cctp/iris";
import { burnToStellar, sepoliaClients } from "#cctp/sepolia";
import {
  depositToVault, ensureTrustline, isNonceUsed, minSwapOut, mintAndForward, pegPlan, poolReserves, quoteCircleToBlend,
  readContract, restorePeg, swapCircleToBlend, tokenBalance,
} from "#cctp/stellar";

export const STEP_IDS = ["burn", "attestation", "mint", "swap", "deposit"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = "pending" | "running" | "done" | "failed";

export interface StepTx {
  label: string;
  hash: string;
  network: "sepolia" | "stellar";
}

export interface BridgeStep {
  id: StepId;
  status: StepStatus;
  detail?: string;
  txs: StepTx[];
}

export interface BridgeResult {
  /** Six-decimal USDC burned on Sepolia. */
  burned: string;
  /** Seven-decimal Circle USDC received on Stellar. */
  minted: string;
  /** Seven-decimal Blend USDC out of the swap and deposited. */
  deposited: string;
  /** Raw vault share units minted to the recipient. */
  shares: string;
}

export interface BridgeConfig {
  sepoliaPrivateKey: string;
  sepoliaRpcUrl: string | undefined;
  /** Pays for `mint_and_forward`. */
  opsSecret: string;
  /** Stellar recipient: receives the mint, swaps and deposits. */
  userSecret: string;
  vault: string;
  /** Six-decimal USDC to burn. */
  amount: bigint;
  /** Resume after an earlier burn instead of burning again. */
  burnTxHash?: string;
}

export function initialSteps(): BridgeStep[] {
  return STEP_IDS.map(id => ({ id, status: "pending", txs: [] }));
}

/** Sepolia burn → Iris attestation → `mint_and_forward` → Soroswap → vault deposit. */
export async function runBridge(config: BridgeConfig, onUpdate: (steps: BridgeStep[]) => void): Promise<BridgeResult> {
  const steps = initialSteps();
  let current: StepId = "burn";
  const update = (id: StepId, patch: Partial<Omit<BridgeStep, "id" | "txs">>, tx?: StepTx) => {
    current = id;
    const step = steps.find(entry => entry.id === id);
    if (!step) return;
    Object.assign(step, patch);
    if (tx) step.txs.push(tx);
    onUpdate(structuredClone(steps));
  };

  try {
    const ops = Keypair.fromSecret(config.opsSecret);
    const user = Keypair.fromSecret(config.userSecret);
    const recipient = user.publicKey();
    const sepolia = sepoliaClients(config.sepoliaPrivateKey, config.sepoliaRpcUrl);

    update("burn", { status: "running", detail: "Checking the Stellar recipient and the swap pool" });
    for (const [sac, issuer, label] of [
      [stellar.circleUsdc, stellar.circleUsdcIssuer, "Circle USDC trustline"],
      [stellar.blendUsdc, stellar.blendUsdcIssuer, "Blend USDC trustline"],
    ] as const) {
      const hash = await ensureTrustline(user, sac, issuer);
      if (hash) update("burn", {}, { label, hash, network: "stellar" });
    }
    if (await readContract<boolean>(recipient, config.vault, "paused")) throw new Error("The vault is paused");

    // Each bridged swap moves the pair off 1:1; the ops account (the pool's seeder) swaps it back
    // so the next swap clears the 99.5 % floor. Nothing is burned if the floor stays out of reach.
    const ensureSwapFloor = async (amountIn: bigint, step: StepId) => {
      if (await quoteCircleToBlend(recipient, amountIn) >= minSwapOut(amountIn)) return;
      const plan = pegPlan(await poolReserves(recipient));
      if (plan && await tokenBalance(recipient, plan.tokenIn, ops.publicKey()) >= plan.amountIn) {
        const { hash } = await restorePeg(ops, plan);
        update(step, {}, { label: "Pool rebalance to 1:1", hash, network: "stellar" });
      }
      if (await quoteCircleToBlend(recipient, amountIn) < minSwapOut(amountIn)) {
        throw new Error(`Swap pool cannot return 99.5 % of ${formatUsdc(amountIn, 7)} USDC`);
      }
    };

    let burnHash = config.burnTxHash;
    if (!burnHash) {
      const feeBps = await fetchMinimumFeeBps(cctp.sepoliaDomain, cctp.stellarDomain, cctp.minFinalityThreshold);
      const maxFee = maxFeeFor(config.amount, feeBps);
      await ensureSwapFloor(cctpToStellarAmount(config.amount - maxFee), "burn");
      update("burn", { detail: `Burning ${formatUsdc(config.amount, 6)} USDC on Ethereum Sepolia` });
      burnHash = await burnToStellar(sepolia, {
        amount: config.amount,
        maxFee,
        recipient,
        onApprove: hash => update("burn", {}, { label: "Approve USDC", hash, network: "sepolia" }),
      });
    }
    update("burn", { status: "done", detail: `Burned ${formatUsdc(config.amount, 6)} USDC on Ethereum Sepolia` }, {
      label: "depositForBurnWithHook", hash: burnHash, network: "sepolia",
    });

    update("attestation", { status: "running", detail: "Waiting for Circle" });
    const attested = await pollAttestation(cctp.sepoliaDomain, burnHash, status => update("attestation", { detail: `Circle: ${status}` }));
    const message = decodeBurnMessage(attested.message);
    assertForwarderMessage(message, recipient);
    const minted = mintedOnStellar(message);
    update("attestation", {
      status: "done",
      detail: `Attested at ${message.finalityThresholdExecuted <= 1000 ? "fast" : "standard"} finality, fee ${formatUsdc(message.feeExecuted, 6)} USDC`,
    });

    update("mint", { status: "running", detail: "Submitting mint_and_forward on Stellar" });
    if (await isNonceUsed(ops.publicKey(), message.nonce)) {
      update("mint", { status: "done", detail: `Already minted: ${formatUsdc(minted, 7)} USDC` });
    } else {
      const before = await tokenBalance(recipient, stellar.circleUsdc, recipient);
      const { hash } = await mintAndForward(ops, attested.message, attested.attestation);
      const received = await tokenBalance(recipient, stellar.circleUsdc, recipient) - before;
      if (received !== minted) throw new Error(`Expected ${minted} stroops of USDC, received ${received}`);
      update("mint", { status: "done", detail: `Received ${formatUsdc(received, 7)} USDC on Stellar` }, {
        label: "mint_and_forward", hash, network: "stellar",
      });
    }

    update("swap", { status: "running", detail: "Swapping Circle USDC for Blend USDC on Soroswap" });
    await ensureSwapFloor(minted, "swap");
    const swap = await swapCircleToBlend(user, minted);
    update("swap", {
      status: "done", detail: `Swapped ${formatUsdc(minted, 7)} Circle USDC for ${formatUsdc(swap.amountOut, 7)} Blend USDC`,
    }, { label: "swap_exact_tokens_for_tokens", hash: swap.hash, network: "stellar" });

    update("deposit", { status: "running", detail: "Depositing into the vault" });
    const deposit = await depositToVault(user, config.vault, swap.amountOut);
    update("deposit", {
      status: "done", detail: `Deposited ${formatUsdc(swap.amountOut, 7)} USDC and received vault shares`,
    }, { label: "deposit", hash: deposit.hash, network: "stellar" });

    return { burned: config.amount.toString(), minted: minted.toString(), deposited: swap.amountOut.toString(), shares: deposit.shares.toString() };
  } catch (error) {
    // viem messages embed the RPC URL, which may carry an API key.
    const raw = error instanceof Error ? ("shortMessage" in error && typeof error.shortMessage === "string" ? error.shortMessage : error.message) : "Bridge failed";
    const message = config.sepoliaRpcUrl ? raw.replaceAll(config.sepoliaRpcUrl, "<Sepolia RPC>") : raw;
    update(current, { status: "failed", detail: message });
    throw new Error(message);
  }
}
