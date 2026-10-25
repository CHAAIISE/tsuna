import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { api } from "@/lib/passkey/client";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

type WalletKit = typeof StellarWalletsKit;
let kitPromise: Promise<WalletKit> | undefined;

/**
 * Loads Stellar Wallets Kit once, on demand: it ships every wallet module and
 * reads browser globals, so it stays out of the server render and first load.
 */
function walletKit(): Promise<WalletKit> {
  kitPromise ??= Promise.all([
    import("@creit.tech/stellar-wallets-kit/sdk"),
    import("@creit.tech/stellar-wallets-kit/modules/utils"),
    import("@creit.tech/stellar-wallets-kit/types"),
  ]).then(([{ StellarWalletsKit: kit }, { defaultModules }, { Networks }]) => {
    kit.init({ modules: defaultModules(), network: Networks.TESTNET });
    return kit;
  });
  return kitPromise;
}

/** Opens the wallet picker and returns the connected `G…` address. */
export async function connectWallet(): Promise<string> {
  const kit = await walletKit();
  const { address } = await kit.authModal();
  return address;
}

/**
 * Opens the Blend USDC trustline with the SAC `trust()` function (CAP-73):
 * the wallet signs the call, the relayer pays the fee with a fee bump.
 */
export async function addUsdcTrustline(address: string): Promise<{ hash: string }> {
  const { xdr } = await api<{ xdr: string }>("/api/sponsor", { action: "trustline", address });
  const kit = await walletKit();
  const { signedTxXdr } = await kit.signTransaction(xdr, { networkPassphrase: TESTNET_PASSPHRASE, address });
  return api<{ hash: string }>("/api/sponsor", { action: "fee-bump", xdr: signedTxXdr });
}

/** Signs a prepared creator operation locally; the relayer only sponsors its fee. */
export async function signCreatorTransaction(address: string, xdr: string): Promise<{ hash: string }> {
  const kit = await walletKit();
  const { signedTxXdr } = await kit.signTransaction(xdr, { networkPassphrase: TESTNET_PASSPHRASE, address });
  return api<{ hash: string }>("/api/sponsor", { action: "fee-bump", xdr: signedTxXdr });
}
