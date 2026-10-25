import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient, createWalletClient, erc20Abi, http,
  type Hash, type HttpTransport, type PublicClient, type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { sepolia as sepoliaChain } from "viem/chains";
import { cctp, sepolia, stellar } from "#cctp/config";
import { buildForwarderHookData, contractStrkeyToBytes32, decodeForwarderHookData, type Hex } from "#cctp/encoding";

const tokenMessengerV2Abi = [{
  type: "function",
  name: "depositForBurnWithHook",
  stateMutability: "nonpayable",
  inputs: [
    { name: "amount", type: "uint256" },
    { name: "destinationDomain", type: "uint32" },
    { name: "mintRecipient", type: "bytes32" },
    { name: "burnToken", type: "address" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "maxFee", type: "uint256" },
    { name: "minFinalityThreshold", type: "uint32" },
    { name: "hookData", type: "bytes" },
  ],
  outputs: [],
}] as const;

export interface SepoliaClients {
  account: PrivateKeyAccount;
  publicClient: PublicClient<HttpTransport, typeof sepoliaChain>;
  walletClient: WalletClient<HttpTransport, typeof sepoliaChain, PrivateKeyAccount>;
}

export function sepoliaClients(privateKey: string, rpcUrl: string | undefined): SepoliaClients {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("Invalid Sepolia private key");
  const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex);
  const transport = http(rpcUrl);
  return {
    account,
    publicClient: createPublicClient({ chain: sepoliaChain, transport }),
    walletClient: createWalletClient({ account, chain: sepoliaChain, transport }),
  };
}

export function sepoliaUsdcBalance({ publicClient, account }: SepoliaClients): Promise<bigint> {
  return publicClient.readContract({ address: sepolia.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
}

/**
 * Burns USDC on Sepolia for `recipient` on Stellar. Both `mintRecipient` and
 * `destinationCaller` are the CctpForwarder; the real recipient only lives in hookData.
 */
export async function burnToStellar(
  clients: SepoliaClients,
  { amount, maxFee, recipient, onApprove }: { amount: bigint; maxFee: bigint; recipient: string; onApprove: (hash: Hash) => void },
): Promise<Hash> {
  const { publicClient, walletClient, account } = clients;
  const forwarder = contractStrkeyToBytes32(stellar.cctpForwarder);
  const hookData = buildForwarderHookData(recipient);
  if (decodeForwarderHookData(hookData) !== recipient) throw new Error("Hook data does not round-trip to the recipient");
  if (maxFee >= amount) throw new Error("Fee budget exceeds the amount");

  const held = await sepoliaUsdcBalance(clients);
  if (held < amount) throw new Error(`Sepolia wallet holds ${held} USDC units, needs ${amount}`);
  const readAllowance = () => publicClient.readContract({
    address: sepolia.usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, sepolia.messengerV2],
  });
  if (await readAllowance() < amount) {
    const approveHash = await walletClient.writeContract({
      address: sepolia.usdc, abi: erc20Abi, functionName: "approve", args: [sepolia.messengerV2, amount],
    });
    onApprove(approveHash);
    const approval = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approval.status !== "success") throw new Error(`Approve reverted: ${approveHash}`);
    // Load-balanced RPC nodes can serve the next call from a block before the approval.
    for (let attempt = 0; await readAllowance() < amount; attempt++) {
      if (attempt === 30) throw new Error(`Allowance from ${approveHash} not visible on the RPC`);
      await sleep(2_000);
    }
  }

  const { request } = await publicClient.simulateContract({
    account,
    address: sepolia.messengerV2,
    abi: tokenMessengerV2Abi,
    functionName: "depositForBurnWithHook",
    args: [amount, cctp.stellarDomain, forwarder, sepolia.usdc, forwarder, maxFee, cctp.minFinalityThreshold, hookData],
  });
  const burnHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: burnHash });
  if (receipt.status !== "success") throw new Error(`Burn reverted: ${burnHash}`);
  return burnHash;
}
