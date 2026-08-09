"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CONTRACTS, activeChain, API_BASE_URL } from "@/lib/contracts";

/**
 * Tells the truth about what this particular instance can actually do.
 *
 * A hosted preview whose contracts aren't deployed yet will fail every on-chain read and every
 * A-Pass lookup. Left unexplained that reads as a broken app, which is worse than no hosted
 * URL at all — a reviewer cannot distinguish "not wired up yet" from "doesn't work". So the
 * app says which parts are live, which are waiting, and where to see the rest working for
 * real. Silence would be the dishonest option here, not the modest one.
 */
export function DeploymentStatus() {
  const contractsConfigured = Boolean(CONTRACTS.legateEscrow);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timeout = AbortSignal.timeout(6000);
    fetch(`${API_BASE_URL}/health`, { signal: timeout })
      .then((r) => {
        if (!cancelled) setBackendUp(r.ok);
      })
      .catch(() => {
        if (!cancelled) setBackendUp(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Everything wired: say nothing. A permanent banner on a working deployment is noise.
  if (contractsConfigured && backendUp) return null;
  // Still checking, and contracts are fine — don't flash a warning that may be wrong.
  if (contractsConfigured && backendUp === null) return null;

  return (
    <div className="mb-6 rounded-lg border border-amber-600/40 bg-amber-600/10 p-4 text-sm">
      <p className="font-medium text-amber-300">
        Hosted preview — this instance is not connected to a live deployment yet.
      </p>
      <div className="mt-2 flex flex-col gap-1 text-muted-foreground">
        <span>
          <strong className="text-foreground">Works here now:</strong> the full walkthrough,
          every explanation, and the exact UI the flow runs in.
        </span>
        <span>
          <strong className="text-foreground">Needs the deployment:</strong> A-Pass lookups, live
          quotes, and any on-chain action.{" "}
          {contractsConfigured
            ? "The contracts are configured; the policy-engine backend is unreachable."
            : `No contract addresses are configured for ${activeChain.name}.`}
        </span>
        <span className="pt-1">
          To see the whole thing working against real contracts with no wallet and no
          credentials, run{" "}
          <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
            bash demo/run-demo.sh
          </code>{" "}
          from the repo — or read{" "}
          <Link href="/auditor" className="underline">
            what the Verify step does
          </Link>
          .
        </span>
      </div>
    </div>
  );
}
