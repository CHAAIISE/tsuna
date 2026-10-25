import { scValToNative } from "@stellar/stellar-sdk";
import { describe, expect, test } from "vitest";
import { actions } from "./actions.js";
import { TESTNET } from "./network.js";

const VAULT = "CCBRIR3I772JUQ5ZPD7FJ4WAILTKZL2BPGPBL5ZSA46O5TEHJHZK3YEL";
const DEFINDEX = "CDTXTXCYXNHVRSQUWOP4UW6DGW23Y4ZYT2WMFC4BKHOEOR3CUB3JXKVQ";
const AQUARIUS = "CAM2FIEZINPFYA6T6ACWHBJVIOJSJHGMTCSPJK7HFWBRGU2PLU2BED4F";
const ATTACKER = "GCNAX2DH52MFMP35OTEPRZDOFZVR5XTGLTOE34UTLLL4HMXJWT3TJPQ3";

const only = <T>(list: T[]): T => {
  expect(list).toHaveLength(1);
  return list[0] as T;
};

describe("Blend actions", () => {
  test.each([
    ["blendSupply", 0], ["blendWithdraw", 1], ["blendSupplyCollateral", 2],
    ["blendWithdrawCollateral", 3], ["blendBorrow", 4], ["blendRepay", 5],
  ] as const)("%s is one submit_with_allowance with request type %i", (name, type) => {
    const call = only(actions[name](VAULT, TESTNET.usdc, 1_000_000n));
    expect(call.target).toBe(TESTNET.blendPool);
    expect(call.fn).toBe("submit_with_allowance");
    expect(call.args.map(arg => arg.type)).toEqual(["scvAddress", "scvAddress", "scvAddress", "scvVec"]);
    expect(call.args.slice(0, 3).map(scValToNative)).toEqual([VAULT, VAULT, VAULT]);
    const requests = call.args[3];
    if (requests?.type !== "scvVec" || !requests.value) throw new Error("requests must be a vector");
    const [request] = requests.value;
    if (request?.type !== "scvMap" || !request.value) throw new Error("request must be a map");
    expect(request.value.map(entry => scValToNative(entry.key))).toEqual(["address", "amount", "request_type"]);
    expect(request.value.map(entry => entry.val.type)).toEqual(["scvAddress", "scvI128", "scvU32"]);
    expect(scValToNative(request)).toEqual({ address: TESTNET.usdc, amount: 1_000_000n, request_type: type });
  });
});

describe("DeFindex, Soroswap and Aquarius actions", () => {
  test("DeFindex deposit and withdraw", () => {
    const deposit = only(actions.defindexDeposit(VAULT, DEFINDEX, 5n));
    expect([deposit.target, deposit.fn]).toEqual([DEFINDEX, "deposit"]);
    expect(deposit.args.map(arg => arg.type)).toEqual(["scvVec", "scvVec", "scvAddress", "scvBool"]);
    expect(deposit.args.map(scValToNative)).toEqual([[5n], [0n], VAULT, true]);
    const withdraw = only(actions.defindexWithdraw(VAULT, DEFINDEX, 7n));
    expect(withdraw.args.map(arg => arg.type)).toEqual(["scvI128", "scvVec", "scvAddress"]);
    expect(withdraw.args.map(scValToNative)).toEqual([7n, [0n], VAULT]);
  });

  test("Soroswap swap pays the vault with a ten-minute deadline", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    const swap = only(actions.soroswapSwap(VAULT, [TESTNET.usdc, TESTNET.xlm], 100n, 90n, TESTNET.soroswapRouter, now));
    expect([swap.target, swap.fn]).toEqual([TESTNET.soroswapRouter, "swap_exact_tokens_for_tokens"]);
    expect(swap.args.map(arg => arg.type)).toEqual(["scvI128", "scvI128", "scvVec", "scvAddress", "scvU64"]);
    expect(swap.args.map(scValToNative)).toEqual([100n, 90n, [TESTNET.usdc, TESTNET.xlm], VAULT, BigInt(now.getTime() / 1000 + 600)]);
  });

  test("Aquarius deposit and withdraw use u128 amounts", () => {
    const deposit = only(actions.aquariusDeposit(VAULT, AQUARIUS, [3n, 4n], 1n));
    expect(deposit.args.map(arg => arg.type)).toEqual(["scvAddress", "scvVec", "scvU128"]);
    expect(deposit.args.map(scValToNative)).toEqual([VAULT, [3n, 4n], 1n]);
    const withdraw = only(actions.aquariusWithdraw(VAULT, AQUARIUS, 9n, [0n, 0n]));
    expect(withdraw.args.map(arg => arg.type)).toEqual(["scvAddress", "scvU128", "scvVec"]);
  });

  test("USDC transfer out of the vault", () => {
    const transfer = only(actions.usdcTransfer(VAULT, ATTACKER, 10n));
    expect([transfer.target, transfer.fn]).toEqual([TESTNET.usdc, "transfer"]);
    expect(transfer.args.map(scValToNative)).toEqual([VAULT, ATTACKER, 10n]);
  });
});
