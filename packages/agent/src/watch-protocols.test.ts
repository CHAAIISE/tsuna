import { describe, expect, it } from "vitest";
import { planProtocolChecks, type WatchedVault } from "./watch-protocols.js";

const BLEND = "CBLEND";
const DEFINDEX = "CDEFINDEX";
const USDC = "CUSDC";
const [OLD, NEW] = ["aa".repeat(32), "bb".repeat(32)];

const vault = (address: string, protocols: string[], pinned: Record<string, string | null>, halted: string[] = []): WatchedVault =>
  ({ address, name: address, protocols, pinned, halted });

describe("planProtocolChecks", () => {
  it("asks to pause only the vaults allowlisting an upgraded protocol", () => {
    const vaults = [
      vault("CPRUDENT", [BLEND, DEFINDEX], { [BLEND]: OLD, [DEFINDEX]: OLD }),
      vault("CLIQUIDITY", [DEFINDEX], { [DEFINDEX]: OLD }),
    ];
    const plan = planProtocolChecks(vaults, new Map([[BLEND, NEW], [DEFINDEX, OLD]]));
    expect(plan.upgrades).toEqual([{ vault: "CPRUDENT", name: "CPRUDENT", protocol: BLEND, pinned: OLD, current: NEW }]);
    expect(plan.check).toEqual(["CPRUDENT"]);
  });

  it("pins unseen protocols without reporting an upgrade", () => {
    const plan = planProtocolChecks([vault("CNEW", [BLEND], { [BLEND]: null })], new Map([[BLEND, OLD]]));
    expect(plan).toEqual({ upgrades: [], check: ["CNEW"] });
  });

  it("does not report again a protocol the vault already halted on", () => {
    const plan = planProtocolChecks([vault("CPRUDENT", [BLEND], { [BLEND]: OLD }, [BLEND])], new Map([[BLEND, NEW]]));
    expect(plan).toEqual({ upgrades: [], check: [] });
  });

  it("ignores Stellar Asset contracts, which carry no Wasm", () => {
    const plan = planProtocolChecks([vault("CPRUDENT", [USDC], { [USDC]: null })], new Map([[USDC, null]]));
    expect(plan).toEqual({ upgrades: [], check: [] });
  });
});
