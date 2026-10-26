import { generateKeyPairSync, sign, verify } from "node:crypto";
import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { authDigest, authPayload, contextCount, keyData, webAuthnSigData } from "./auth";
import { derToLowSRawSignature, fromBase64Url, p256PublicKeyFromSpki, toBase64Url, toHex } from "./encoding";

const P256_HALF_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n / 2n;
const SIG_DATA_XDR = "0000001100000001000000030000000f0000001261757468656e74696361746f725f6461746100000000000d00000025020202020202020202020202020202020202020202020202020202020202020202020202020000000000000f0000000b636c69656e745f64617461000000000d0000000503030303030000000000000f000000097369676e61747572650000000000000d0000004001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101";
const ACCOUNT = "CAC2HRI4PWFA2AIT257O4QFYE2PPMKORTNSR7OFLXZ4G3SDEOQD4JOYK";

describe("encoding", () => {
  it("round-trips base64url without padding", () => {
    const bytes = Uint8Array.from([251, 255, 0, 1, 2]);
    expect(toBase64Url(bytes)).toBe("-_8AAQI");
    expect(fromBase64Url("-_8AAQI")).toEqual(bytes);
  });

  it("extracts the uncompressed point from a P-256 SPKI", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
    const point = p256PublicKeyFromSpki(spki);
    const jwk = publicKey.export({ format: "jwk" });
    expect(point[0]).toBe(0x04);
    expect(toBase64Url(point.subarray(1, 33))).toBe(jwk.x);
    expect(toBase64Url(point.subarray(33))).toBe(jwk.y);
  });

  it("rejects a non P-256 key", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    expect(() => p256PublicKeyFromSpki(new Uint8Array(publicKey.export({ format: "der", type: "spki" })))).toThrow();
  });

  it("converts DER signatures to valid low-S raw signatures", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const message = Buffer.from("tsuna");
    for (let i = 0; i < 32; i += 1) {
      const raw = derToLowSRawSignature(new Uint8Array(sign("sha256", message, { key: privateKey, dsaEncoding: "der" })));
      expect(raw).toHaveLength(64);
      expect(BigInt(`0x${toHex(raw.subarray(32))}`) <= P256_HALF_N).toBe(true);
      expect(verify("sha256", message, { key: publicKey, dsaEncoding: "ieee-p1363" }, raw)).toBe(true);
    }
  });

  it("rejects malformed DER", () => {
    expect(() => derToLowSRawSignature(Uint8Array.from([0x30, 0x02, 0x02, 0x00]))).toThrow("Malformed DER signature");
  });
});

describe("auth payload", () => {
  // Vectors computed with stellar-accounts 0.8.0 in the passkey account test environment.
  it("matches the OZ AuthDigestPreimage digest", () => {
    const digest = authDigest(ACCOUNT, new Uint8Array(32).fill(9), [0, 0]);
    expect(toHex(digest)).toBe("e54e5aa78959931c6fba5c4f9e30068c0614b995486148b9512d0597c72edd24");
  });

  it("encodes WebAuthnSigData like the contract's XDR", () => {
    const encoded = webAuthnSigData({
      signature: new Uint8Array(64).fill(1),
      authenticatorData: new Uint8Array(37).fill(2),
      clientDataJSON: new Uint8Array(5).fill(3),
    });
    expect(toHex(encoded)).toBe(SIG_DATA_XDR);
  });

  it("builds an AuthPayload with one external signer per context", () => {
    const publicKey = Uint8Array.from([4, ...new Uint8Array(64).fill(7)]);
    const key = keyData(publicKey, Uint8Array.from([1, 2, 3]));
    const payload = authPayload(ACCOUNT, key, Uint8Array.from([9]), [0, 0]);
    const [ids, signers] = payload.value as xdr.ScMapEntry[];
    expect(ids?.key.value).toBe("context_rule_ids");
    expect((ids?.val.value as xdr.ScVal[]).map(id => id.value)).toEqual([0, 0]);
    const signer = (signers?.val.value as xdr.ScMapEntry[])[0]?.key.value as xdr.ScVal[];
    expect(signer[0]?.value).toBe("External");
    expect(Address.fromScVal(signer[1]!).toString()).toBe(ACCOUNT);
    expect(key).toHaveLength(68);
  });

  it("counts one context per authorized invocation", () => {
    const fn = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
      contractAddress: new Address(ACCOUNT).toScAddress(),
      functionName: "deposit",
      args: [],
    }));
    const leaf = new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [] });
    const root = new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [leaf, new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [leaf] })] });
    expect(contextCount(leaf)).toBe(1);
    expect(contextCount(root)).toBe(4);
  });

  it("refuses compressed public keys", () => {
    expect(() => keyData(new Uint8Array(33).fill(2), Uint8Array.from([1]))).toThrow();
  });
});
