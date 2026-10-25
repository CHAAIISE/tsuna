import { describe, expect, it } from "vitest";
import { contractMeta, exportedFunctions } from "./wasm";

const text = (value: string) => [...new TextEncoder().encode(value)];
const xdrString = (value: string) => {
  const bytes = text(value);
  const padding = (4 - (bytes.length % 4)) % 4;
  return [0, 0, 0, bytes.length, ...bytes, ...new Array<number>(padding).fill(0)];
};
const section = (id: number, body: number[]) => [id, body.length, ...body];

/** Header, a `contractmetav0` custom section and an export section (one function, one memory). */
const wasm = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(0, [14, ...text("contractmetav0"), 0, 0, 0, 0, ...xdrString("leash_build"), ...xdrString("2"), 0, 0, 0, 0, ...xdrString("rsver"), ...xdrString("1.94.1")]),
  ...section(7, [2, 3, ...text("nav"), 0, 0, 6, ...text("memory"), 2, 0]),
]);

describe("contract Wasm reader", () => {
  it("reads contract meta entries", () => {
    expect(contractMeta(wasm)).toEqual({ leash_build: "2", rsver: "1.94.1" });
  });

  it("lists exported functions only", () => {
    expect(exportedFunctions(wasm)).toEqual(["nav"]);
  });

  it("returns nothing for a Wasm without those sections", () => {
    const bare = wasm.slice(0, 8);
    expect(contractMeta(bare)).toEqual({});
    expect(exportedFunctions(bare)).toEqual([]);
  });
});
