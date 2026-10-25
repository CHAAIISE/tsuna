import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { Account, Address, Contract, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { keyData, signAuthEntry, type PasskeyAssertion, type PasskeySigner } from "../lib/passkey/auth";
import { derToLowSRawSignature, toBase64Url } from "../lib/passkey/encoding";

const deployment = JSON.parse(readFileSync(new URL("../../deployments/passkey.testnet.json", import.meta.url), "utf8")) as {
  relayer: string;
  faucet: string;
  usdc: string;
  verifier: string;
};
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const FLAGS_UP_UV = 0x05;

async function onChainBalance(owner: string): Promise<bigint> {
  const tx = new TransactionBuilder(new Account(deployment.relayer, "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(deployment.usdc).call("balance", new Address(owner).toScVal()))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) throw new Error("Balance simulation failed");
  return scValToNative(simulation.result.retval) as bigint;
}

/**
 * Software stand-in for a platform authenticator: produces the exact bytes a
 * browser returns from `navigator.credentials.get` (flags UP and UV set).
 */
function softwareAssertion(privateKey: KeyObject, origin: string, flags = FLAGS_UP_UV) {
  return async (challenge: Uint8Array): Promise<PasskeyAssertion> => {
    const rpIdHash = createHash("sha256").update(new URL(origin).hostname).digest();
    const authenticatorData = new Uint8Array(Buffer.concat([rpIdHash, Buffer.from([flags, 0, 0, 0, 1])]));
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: toBase64Url(challenge), origin, crossOrigin: false }));
    const message = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
    const der = sign("sha256", message, { key: privateKey, dsaEncoding: "der" });
    return { authenticatorData, clientDataJSON, signature: derToLowSRawSignature(new Uint8Array(der)) };
  };
}

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<{ status: number; body: T & { error?: string } }> {
  const response = await request.post(path, { data });
  return { status: response.status(), body: await response.json() as T & { error?: string } };
}

test("the relayer submits a passkey-signed transfer and refuses a forged one", async ({ request, baseURL }) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = new Uint8Array(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x ?? "", "base64url"), Buffer.from(jwk.y ?? "", "base64url")]));
  const credentialId = new Uint8Array(Buffer.from(`leash-e2e-${Date.now()}`));

  const deployed = await post<{ account: string; hash: string }>(request, "/api/sponsor", {
    action: "deploy", publicKey: toBase64Url(point), credentialId: toBase64Url(credentialId),
  });
  expect(deployed.status, deployed.body.error).toBe(200);
  const { account } = deployed.body;

  const funded = await post<{ hash: string; amount: string }>(request, "/api/faucet", { address: account });
  expect(funded.status, funded.body.error).toBe(200);
  const amount = BigInt(funded.body.amount);
  expect(await onChainBalance(account)).toBe(amount);

  // Return the whole drip to the faucet so this test leaves the stock unchanged.
  const invocation = {
    account,
    contract: deployment.usdc,
    method: "transfer",
    args: [new Address(account).toScVal(), new Address(deployment.faucet).toScVal(), nativeToScVal(amount, { type: "i128" })]
      .map(arg => arg.toXDR("base64")),
  };
  const signEntries = async (signer: PasskeySigner["sign"]) => {
    const prepared = await post<{ authEntries: string[]; validUntilLedger: number }>(request, "/api/sponsor", { action: "prepare", ...invocation });
    expect(prepared.status, prepared.body.error).toBe(200);
    const passkey = { account, verifier: deployment.verifier, keyData: keyData(point, credentialId), sign: signer };
    return Promise.all(prepared.body.authEntries.map(async entry =>
      (await signAuthEntry(xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64"), passkey, prepared.body.validUntilLedger)).toXDR("base64")));
  };

  const origin = baseURL ?? "http://localhost:3100";
  const unverified = await post(request, "/api/sponsor", { action: "submit", ...invocation, authEntries: await signEntries(softwareAssertion(privateKey, origin, 0x01)) });
  expect([unverified.status, unverified.body.error]).toEqual([422, "The signature was refused by the account contract."]);
  const intruder = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const forged = await post(request, "/api/sponsor", { action: "submit", ...invocation, authEntries: await signEntries(softwareAssertion(intruder, origin)) });
  expect([forged.status, forged.body.error]).toEqual([422, "The signature was refused by the account contract."]);
  expect(await onChainBalance(account)).toBe(amount);

  const submitted = await post<{ hash: string }>(request, "/api/sponsor", { action: "submit", ...invocation, authEntries: await signEntries(softwareAssertion(privateKey, origin)) });
  expect(submitted.status, submitted.body.error).toBe(200);
  expect((await server.getTransaction(submitted.body.hash)).status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
  expect(await onChainBalance(account)).toBe(0n);

  console.log(`RELAY_ACCOUNT ${account}\nRELAY_DEPLOY_TX ${deployed.body.hash}\nRELAY_FAUCET_TX ${funded.body.hash}\nRELAY_TRANSFER_TX ${submitted.body.hash}`);
});
