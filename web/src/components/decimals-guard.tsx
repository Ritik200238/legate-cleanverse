"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { usePublicClient } from "@/lib/wallet";
import { A_TOKEN_DECIMALS } from "@/lib/format";
import { ATOKEN_ABI, CONTRACTS } from "@/lib/contracts";

/**
 * Reads the configured A-Token's real `decimals()` once and refuses to stay quiet if it
 * disagrees with what this app formats amounts with.
 *
 * This exists because the failure it catches already happened: aUSDC was 6 decimals, the app
 * hardcoded 6, Cleanverse redeployed the Monad A-Token with 18, and nothing anywhere would
 * have complained — a user typing "100" would have signed away 10^-10 aUSDC, and balances
 * would have rendered as thirteen-digit numbers that still looked like a formatting quirk
 * rather than a wrong-by-10^12 bug. Silent, plausible, and about money: exactly the class of
 * error worth spending a network round-trip to make loud.
 */
export function DecimalsGuard() {
  const publicClient = usePublicClient();
  const [onChain, setOnChain] = useState<number | null>(null);

  useEffect(() => {
    if (!CONTRACTS.aToken) return;
    let cancelled = false;
    publicClient
      .readContract({ address: CONTRACTS.aToken, abi: ATOKEN_ABI, functionName: "decimals" })
      .then((d) => {
        if (!cancelled) setOnChain(Number(d));
      })
      .catch(() => {
        // A read failure is a connectivity problem, not a decimals problem — the app's other
        // surfaces already report RPC trouble, so don't add a second misleading alarm here.
        if (!cancelled) setOnChain(null);
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  if (onChain === null || onChain === A_TOKEN_DECIMALS) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTitle>Stop — token decimals mismatch</AlertTitle>
      <AlertDescription>
        The configured A-Token ({CONTRACTS.aToken}) reports <strong>{onChain}</strong> decimals, but this app is
        formatting amounts as <strong>{A_TOKEN_DECIMALS}</strong>. Every amount shown or entered is wrong by a factor
        of 10<sup>{Math.abs(onChain - A_TOKEN_DECIMALS)}</sup>. Set{" "}
        <code className="font-mono">NEXT_PUBLIC_ATOKEN_DECIMALS={onChain}</code> and reload before sending anything.
      </AlertDescription>
    </Alert>
  );
}
