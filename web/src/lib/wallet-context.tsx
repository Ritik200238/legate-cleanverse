"use client";

import { createContext, useContext } from "react";
import { useWalletState, type WalletHook } from "./wallet";

/**
 * Wallet connection state must be shared across the whole app (Nav's connect button, and
 * every page that reads the connected address) — a plain custom hook called independently in
 * each component would give each one its own disconnected useState instance, so connecting
 * via the Nav would never be visible to a page component. One provider, one source of truth.
 */

const WalletContext = createContext<WalletHook | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWalletState();
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletHook {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
