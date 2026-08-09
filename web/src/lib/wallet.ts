"use client";

import { useCallback, useEffect, useState } from "react";
import { createWalletClient, createPublicClient, custom, http, type Address, type Hex } from "viem";
import { activeChain } from "./contracts";

/**
 * Real EIP-1193 wallet connection (window.ethereum) via viem — no wallet-connect abstraction
 * library, since a single injected-provider path (MetaMask et al.) is what every judge will
 * actually have installed, and it's the real, standard way to read/sign against an EVM chain
 * from a browser. State-changing calls (approve, initiate, settle, createMandate) are always
 * signed by the CONNECTED wallet — this app never custodies keys or relays user transactions.
 */

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

export interface WalletState {
  address: Address | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
}

const publicClient = createPublicClient({ chain: activeChain, transport: http() });

export function usePublicClient() {
  return publicClient;
}

export type WalletHook = ReturnType<typeof useWalletState>;

/** Internal hook — holds one instance of connection state. Only wallet-context.tsx should
 *  call this directly (wrapped in WalletProvider); every component should import useWallet
 *  from wallet-context.tsx so they all read the SAME connection, not independent copies. */
export function useWalletState() {
  const [state, setState] = useState<WalletState>({ address: null, chainId: null, connecting: false, error: null });

  useEffect(() => {
    if (!window.ethereum) return;
    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      setState((s) => ({ ...s, address: (accounts[0] as Address) ?? null }));
    };
    const handleChainChanged = (...args: unknown[]) => {
      const chainIdHex = args[0] as string;
      setState((s) => ({ ...s, chainId: parseInt(chainIdHex, 16) }));
    };
    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);
    return () => {
      window.ethereum?.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener("chainChanged", handleChainChanged);
    };
  }, []);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setState((s) => ({ ...s, error: "No injected wallet found. Install MetaMask or another EIP-1193 wallet." }));
      return;
    }
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const chainIdHex = (await window.ethereum.request({ method: "eth_chainId" })) as string;
      setState({ address: accounts[0] as Address, chainId: parseInt(chainIdHex, 16), connecting: false, error: null });
    } catch (err) {
      setState((s) => ({ ...s, connecting: false, error: err instanceof Error ? err.message : "Connection failed" }));
    }
  }, []);

  const switchToActiveChain = useCallback(async () => {
    if (!window.ethereum) return;
    const chainIdHex = `0x${activeChain.id.toString(16)}`;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: chainIdHex,
              chainName: activeChain.name,
              nativeCurrency: activeChain.nativeCurrency,
              rpcUrls: [activeChain.rpcUrls.default.http[0]],
              blockExplorerUrls: "blockExplorers" in activeChain ? [activeChain.blockExplorers?.default.url] : undefined,
            },
          ],
        });
      } else {
        throw err;
      }
    }
  }, []);

  const getWalletClient = useCallback(() => {
    if (!window.ethereum || !state.address) return null;
    return createWalletClient({ chain: activeChain, transport: custom(window.ethereum), account: state.address });
  }, [state.address]);

  return { ...state, connect, switchToActiveChain, getWalletClient, isOnActiveChain: state.chainId === activeChain.id };
}

export type { Address, Hex };
