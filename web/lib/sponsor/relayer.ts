import "server-only";
import { createHash, createPublicKey } from "node:crypto";
import {
  Address, Contract, FeeBumpTransaction, Operation, StrKey, Transaction, TransactionBuilder, hash, rpc, xdr,
} from "@stellar/stellar-sdk";
import { passkeyDeployment } from "@/lib/passkey/deployment";
import { toBase64Url } from "@/lib/passkey/encoding";
import {
  MAX_RESOURCE_FEE, NETWORK_PASSPHRASE, SponsorError, buildTransaction, contractWasmHash, sendAndWait,
  serialize, serverKey, simulate, sponsoredContracts, submitOperation,
} from "./stellar";

/** Ledgers a passkey signature stays valid for (about five minutes). */
const AUTH_VALIDITY_LEDGERS = 60;
const FEE_BUMP_BASE_FEE = "10000";

export interface Invocation {
  account: string;
  contract: string;
  method: string;
  /** Base64 XDR `ScVal` arguments. */
  args: string[];
}

function contractId(deployer: string, salt: Buffer): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
    networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({
      address: new Address(deployer).toScAddress(),
      salt,
    })),
  }));
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

function assertP256Point(publicKey: Uint8Array): void {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new SponsorError("Expected an uncompressed P-256 public key.");
  try {
    createPublicKey({
      key: { kty: "EC", crv: "P-256", x: toBase64Url(publicKey.subarray(1, 33)), y: toBase64Url(publicKey.subarray(33)) },
      format: "jwk",
    });
  } catch {
    throw new SponsorError("The public key is not a point on P-256.");
  }
}

/**
 * Deploys the passkey account of a public key, paid by the relayer. The
 * address only depends on the key, so deploying twice returns the same
 * account.
 */
export async function deployAccount(publicKey: Uint8Array, credentialId: Uint8Array): Promise<{ account: string; hash: string | null }> {
  assertP256Point(publicKey);
  if (credentialId.length === 0 || credentialId.length > 255) throw new SponsorError("Invalid credential ID.");
  const relayer = serverKey("LEASH_RELAYER_SECRET");
  const keyData = Buffer.concat([publicKey, credentialId]);
  // Commits the address to the key: nobody can claim it with another key.
  const salt = createHash("sha256").update(keyData).digest();
  const account = contractId(relayer.publicKey(), salt);
  if (await contractWasmHash(account)) return { account, hash: null };

  const operation = Operation.createCustomContract({
    address: Address.fromString(relayer.publicKey()),
    wasmHash: Buffer.from(passkeyDeployment.accountWasmHash, "hex"),
    salt,
    constructorArgs: [new Address(passkeyDeployment.verifier).toScVal(), xdr.ScVal.scvBytes(keyData)],
  });
  const result = await submitOperation(relayer, operation);
  const deployed = result.returnValue && Address.fromScVal(result.returnValue).toString();
  if (deployed !== account) throw new SponsorError("The account was deployed at an unexpected address.", 502);
  return { account, hash: result.hash };
}

async function assertPasskeyAccount(account: string): Promise<void> {
  if (!StrKey.isValidContract(account)) throw new SponsorError("Expected a passkey account address (C…).");
  if (await contractWasmHash(account) !== passkeyDeployment.accountWasmHash) {
    throw new SponsorError("Only Tsuna passkey accounts can use the relayer.", 403);
  }
}

function invocationOperation({ contract, method, args }: Invocation, auth: xdr.SorobanAuthorizationEntry[] = []): xdr.Operation {
  if (!sponsoredContracts().has(contract)) throw new SponsorError("The relayer only pays for calls to Tsuna and USDC contracts.", 403);
  if (!/^[a-z_][a-z0-9_]{0,31}$/.test(method)) throw new SponsorError("Invalid method name.");
  return Operation.invokeContractFunction({
    contract,
    function: method,
    args: args.map(arg => xdr.ScVal.fromXDR(arg, "base64")),
    auth,
  });
}

/** Each entry must be the account's own address credentials: never the relayer's. */
function assertAccountAuth(account: string, entries: xdr.SorobanAuthorizationEntry[]): void {
  for (const entry of entries) {
    const credentials = entry.credentials;
    const address = credentials.type === "sorobanCredentialsAddress" ? credentials.address.address
      : credentials.type === "sorobanCredentialsAddressV2" ? credentials.addressV2.address
      : null;
    if (!address || Address.fromScAddress(address).toString() !== account) {
      throw new SponsorError("The call needs a signature from an address other than your account.", 403);
    }
  }
}

/**
 * Simulates a call made from a passkey account and returns the authorization
 * entries the passkey must sign.
 */
export async function prepareInvocation(invocation: Invocation): Promise<{ authEntries: string[]; validUntilLedger: number }> {
  await assertPasskeyAccount(invocation.account);
  const relayer = serverKey("LEASH_RELAYER_SECRET");
  const simulation = await simulate(await buildTransaction(relayer.publicKey(), invocationOperation(invocation)));
  const entries = simulation.result?.auth ?? [];
  if (entries.length === 0) throw new SponsorError("This call does not need your account's signature.");
  assertAccountAuth(invocation.account, entries);
  return {
    authEntries: entries.map(entry => entry.toXDR("base64")),
    validUntilLedger: simulation.latestLedger + AUTH_VALIDITY_LEDGERS,
  };
}

/** Submits a call with its passkey-signed entries; the relayer is source and fee payer. */
export async function submitInvocation(invocation: Invocation, signedEntries: string[]): Promise<{ hash: string }> {
  await assertPasskeyAccount(invocation.account);
  const entries = signedEntries.map(entry => xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64"));
  if (entries.length === 0) throw new SponsorError("Missing signed authorization entries.");
  assertAccountAuth(invocation.account, entries);
  const { hash: txHash } = await submitOperation(serverKey("LEASH_RELAYER_SECRET"), invocationOperation(invocation, entries));
  return { hash: txHash };
}

/**
 * Builds the CAP-73 `trust()` call that opens a Blend USDC trustline for a
 * classic (`G…`) wallet. The wallet signs it; the relayer then pays the fee.
 */
export async function prepareTrustline(owner: string): Promise<{ xdr: string }> {
  if (!StrKey.isValidEd25519PublicKey(owner)) throw new SponsorError("Expected a Stellar account address (G…).");
  let tx: Transaction;
  try {
    tx = await buildTransaction(owner, new Contract(passkeyDeployment.usdc).call("trust", new Address(owner).toScVal()));
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      throw new SponsorError("This wallet account does not exist on testnet yet. Fund it with Friendbot first.", 404);
    }
    throw error;
  }
  const simulation = await simulate(tx);
  return { xdr: rpc.assembleTransaction(tx, simulation).build().toXDR() };
}

/** Wraps a wallet-signed Soroban transaction in a fee bump paid by the relayer. */
export async function feeBump(signedXdr: string): Promise<{ hash: string }> {
  const inner = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  if (inner instanceof FeeBumpTransaction) throw new SponsorError("Send the inner transaction, not a fee bump.");
  const relayer = serverKey("LEASH_RELAYER_SECRET");
  const blocked = new Set([relayer.publicKey(), passkeyDeployment.faucet]);
  const [operation] = inner.operations;
  if (blocked.has(inner.source) || inner.operations.length !== 1 || operation?.type !== "invokeHostFunction"
    || operation.source && blocked.has(operation.source)) {
    throw new SponsorError("The relayer only sponsors a single contract call from your own wallet.", 403);
  }
  const func = operation.func;
  if (func.type !== "hostFunctionTypeInvokeContract") {
    throw new SponsorError("The relayer only sponsors contract calls.", 403);
  }
  const target = Address.fromScAddress(func.invokeContract.contractAddress).toString();
  if (!sponsoredContracts().has(target)) throw new SponsorError("The relayer only pays for calls to Tsuna and USDC contracts.", 403);
  const envelope = inner.toEnvelope();
  const ext = envelope.type === "envelopeTypeTx" ? envelope.v1.tx.ext : undefined;
  if (!ext || ext.type !== "sorobanData" || ext.sorobanData.resourceFee > MAX_RESOURCE_FEE) {
    throw new SponsorError("This call is too expensive to sponsor.", 422);
  }
  return serialize(relayer.publicKey(), async () => {
    const bumped = TransactionBuilder.buildFeeBumpTransaction(relayer, FEE_BUMP_BASE_FEE, inner, NETWORK_PASSPHRASE);
    bumped.sign(relayer);
    const { hash: txHash } = await sendAndWait(bumped);
    return { hash: txHash };
  });
}
