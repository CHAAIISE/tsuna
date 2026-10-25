"use client";

import { useSyncExternalStore } from "react";
import { parsePasskeyAccount, passkeyAccountSnapshot, subscribePasskeyAccount, type PasskeyAccount } from "@/lib/passkey/client";

/**
 * The passkey account remembered on this device, or null when signed out.
 * `ready` is false during the server render, before local storage is read.
 */
export function usePasskeyAccount(): { account: PasskeyAccount | null; ready: boolean } {
  const raw = useSyncExternalStore(subscribePasskeyAccount, passkeyAccountSnapshot, () => undefined);
  return { account: raw === undefined ? null : parsePasskeyAccount(raw), ready: raw !== undefined };
}
