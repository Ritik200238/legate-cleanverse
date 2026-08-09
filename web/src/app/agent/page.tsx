"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StepHeader, FunnelFooter } from "@/components/funnel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { usePublicClient } from "@/lib/wallet";
import { useWallet } from "@/lib/wallet-context";
import { api, type MandateResult, type RecipientResult, ApiError } from "@/lib/api";
import { toBaseUnits, fromBaseUnits, shortAddress, formatTimestamp } from "@/lib/format";
import { decodeContractError } from "@/lib/decode-error";
import { AGENT_MANDATE_ABI, CONTRACTS, activeChain } from "@/lib/contracts";

interface ActivityEvent {
  type: "MandateCreated" | "MandateExecuted" | "MandateRevokedEvt" | "MandateSuspended";
  blockNumber: bigint;
  txHash: string;
  data: Record<string, unknown>;
}

/** Legate's own tier scheme (PRD.md §5.1 — Cleanverse's docs define only the mechanical 0-99
 *  range, no fixed meaning): 10 = basic-KYC individual, 30 = enhanced-KYC individual (this
 *  corridor's registered floor), 50 = verified institutional/agent-operator. Tier 30's numbers
 *  match the fixed defaults this page has always shipped with — and what demo/run-demo.sh's
 *  Scene 4 narrates — so a tier-30 principal (or no tier data yet) sees no change at all;
 *  tier 50+ principals, the ones the PRD's own scheme calls out as agent operators, get a
 *  suggestion sized for that. Below 30 is below the corridor's own floor — createMandate()
 *  will refuse it on-chain regardless of what caps are entered, so no suggestion is offered. */
function suggestedCapsForTier(tier: string | undefined): { perTxCap: string; dailyCap: string; totalCap: string } | null {
  const n = tier ? Number.parseInt(tier, 10) : NaN;
  if (Number.isNaN(n) || n < 30) return null;
  if (n >= 50) return { perTxCap: "2000", dailyCap: "10000", totalCap: "25000" };
  return { perTxCap: "500", dailyCap: "2000", totalCap: "5000" };
}

export default function AgentConsolePage() {
  const wallet = useWallet();
  const publicClient = usePublicClient();

  const [agentAddress, setAgentAddress] = useState("");
  const [mandate, setMandate] = useState<MandateResult | null>(null);
  const [mandateError, setMandateError] = useState<string | null>(null);

  const [perTxCap, setPerTxCap] = useState("500");
  const [dailyCap, setDailyCap] = useState("2000");
  const [totalCap, setTotalCap] = useState("5000");
  const [expiryDays, setExpiryDays] = useState("30");

  // Real CVI tier data for the connected (principal) wallet, and whether the cap fields still
  // hold the tier-derived suggestion or the admin has since typed their own numbers. Tier data
  // has always been fetched by this backend (queryApass) but never used for anything besides a
  // display badge on Send — this is the same live data actually driving a real suggestion here,
  // not an invented number. The suggestion is informational only: createMandate() still takes
  // whatever the admin submits, and on-chain enforcement is unchanged (see DECISIONS.md).
  const [principalStatus, setPrincipalStatus] = useState<RecipientResult | null>(null);
  const [capsAreSuggested, setCapsAreSuggested] = useState(true);

  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Real, previously-missing bugs (see DECISIONS.md): neither function below had a race
  // guard or cleared stale data on failure. Pasting agent A's address, then quickly replacing
  // it with agent B's, could leave B's input showing A's mandate/activity if A's slower
  // response landed after B's — and a transient failure while switching agents left the
  // PREVIOUS agent's mandate fully rendered next to an error banner that actually belonged
  // to the new address. latestRequestedAddress tracks which address is "current" so a
  // late-arriving response for an address the user has since moved away from is ignored.
  const latestRequestedAddress = useRef<string | null>(null);

  async function refreshMandate(address: string) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return;
    latestRequestedAddress.current = address;
    setMandateError(null);
    try {
      const m = await api.getMandate(address);
      if (latestRequestedAddress.current === address) setMandate(m);
    } catch (err) {
      if (latestRequestedAddress.current !== address) return;
      setMandate(null);
      setMandateError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function loadActivity(address: string) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return;
    setActivityLoading(true);
    try {
      const [created, executed, revoked, suspended] = await Promise.all([
        publicClient.getContractEvents({ address: CONTRACTS.agentMandate, abi: AGENT_MANDATE_ABI, eventName: "MandateCreated", args: { agent: address as `0x${string}` }, fromBlock: 0n, toBlock: "latest" }),
        publicClient.getContractEvents({ address: CONTRACTS.agentMandate, abi: AGENT_MANDATE_ABI, eventName: "MandateExecuted", args: { agent: address as `0x${string}` }, fromBlock: 0n, toBlock: "latest" }),
        publicClient.getContractEvents({ address: CONTRACTS.agentMandate, abi: AGENT_MANDATE_ABI, eventName: "MandateRevokedEvt", args: { agent: address as `0x${string}` }, fromBlock: 0n, toBlock: "latest" }),
        publicClient.getContractEvents({ address: CONTRACTS.agentMandate, abi: AGENT_MANDATE_ABI, eventName: "MandateSuspended", args: { agent: address as `0x${string}` }, fromBlock: 0n, toBlock: "latest" }),
      ]);
      if (latestRequestedAddress.current !== address) return; // a newer address was requested while this was in flight
      const all: ActivityEvent[] = [
        ...created.map((l) => ({ type: "MandateCreated" as const, blockNumber: l.blockNumber, txHash: l.transactionHash, data: l.args as Record<string, unknown> })),
        ...executed.map((l) => ({ type: "MandateExecuted" as const, blockNumber: l.blockNumber, txHash: l.transactionHash, data: l.args as Record<string, unknown> })),
        ...revoked.map((l) => ({ type: "MandateRevokedEvt" as const, blockNumber: l.blockNumber, txHash: l.transactionHash, data: l.args as Record<string, unknown> })),
        ...suspended.map((l) => ({ type: "MandateSuspended" as const, blockNumber: l.blockNumber, txHash: l.transactionHash, data: l.args as Record<string, unknown> })),
      ].sort((a, b) => Number(b.blockNumber - a.blockNumber));
      setActivity(all);
    } finally {
      if (latestRequestedAddress.current === address) setActivityLoading(false);
    }
  }

  useEffect(() => {
    if (agentAddress) {
      // These kick off the real fetches this page exists to show; both set a loading flag
      // synchronously before their own async work, which is the correct way to trigger a
      // fetch on a changed dependency, not a value that could instead be computed during
      // render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refreshMandate(agentAddress);
      loadActivity(agentAddress);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentAddress]);

  useEffect(() => {
    if (!wallet.address) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrincipalStatus(null);
      return;
    }
    let cancelled = false;
    api.getRecipient(wallet.address).then((status) => {
      if (cancelled) return;
      setPrincipalStatus(status);
      if (capsAreSuggested) {
        const suggestion = suggestedCapsForTier(status.tier);
        if (suggestion) {
          setPerTxCap(suggestion.perTxCap);
          setDailyCap(suggestion.dailyCap);
          setTotalCap(suggestion.totalCap);
        }
      }
    }).catch(() => {
      if (!cancelled) setPrincipalStatus(null);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address]);

  function editCap(setter: (v: string) => void, value: string) {
    setCapsAreSuggested(false);
    setter(value);
  }

  async function handleCreateMandate() {
    const client = wallet.getWalletClient();
    if (!client || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) return;
    setCreateError(null);
    setCreating(true);
    try {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + Number(expiryDays) * 86400);
      await publicClient.simulateContract({
        address: CONTRACTS.agentMandate,
        abi: AGENT_MANDATE_ABI,
        functionName: "createMandate",
        args: [agentAddress as `0x${string}`, toBaseUnits(perTxCap), toBaseUnits(dailyCap), toBaseUnits(totalCap), expiry],
        account: wallet.address!,
      });
      const hash = await client.writeContract({
        address: CONTRACTS.agentMandate,
        abi: AGENT_MANDATE_ABI,
        functionName: "createMandate",
        args: [agentAddress as `0x${string}`, toBaseUnits(perTxCap), toBaseUnits(dailyCap), toBaseUnits(totalCap), expiry],
        chain: activeChain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refreshMandate(agentAddress);
      await loadActivity(agentAddress);
    } catch (err) {
      setCreateError(decodeContractError(err).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    const client = wallet.getWalletClient();
    if (!client || !mandate) return;
    setCreateError(null);
    setRevoking(true);
    try {
      const hash = await client.writeContract({
        address: CONTRACTS.agentMandate,
        abi: AGENT_MANDATE_ABI,
        functionName: "revokeMandate",
        args: [agentAddress as `0x${string}`],
        chain: activeChain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refreshMandate(agentAddress);
      await loadActivity(agentAddress);
    } catch (err) {
      setCreateError(decodeContractError(err).message);
    } finally {
      setRevoking(false);
    }
  }

  const isPrincipal = wallet.address && mandate && wallet.address.toLowerCase() === mandate.principal.toLowerCase();

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <StepHeader
        title="Agent Console"
        claim="Give an AI agent a spend mandate held in contract storage. A jailbroken agent hits the same revert an honest one does."
      />

      {!wallet.address && (
        <Alert>
          <AlertTitle>Connect your wallet</AlertTitle>
          <AlertDescription>Connect the principal wallet to manage a mandate.</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Agent wallet</CardTitle>
        </CardHeader>
        <CardContent>
          <Input placeholder="0x... agent address" value={agentAddress} onChange={(e) => setAgentAddress(e.target.value.trim())} className="font-mono" />
          {mandateError && <p className="text-sm text-destructive mt-2">{mandateError}</p>}
        </CardContent>
      </Card>

      {mandate && mandate.active && (
        <Card>
          <CardHeader>
            <CardTitle>Current mandate</CardTitle>
            <CardDescription>Principal: <span className="font-mono">{shortAddress(mandate.principal)}</span></CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Per-tx cap</span><span>{fromBaseUnits(mandate.perTxCap)} aUSDC</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Daily cap</span><span>{fromBaseUnits(mandate.spentToday)} / {fromBaseUnits(mandate.dailyCap)} aUSDC</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Total cap</span><span>{fromBaseUnits(mandate.spentTotal)} / {fromBaseUnits(mandate.totalCap)} aUSDC</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Expires</span><span>{formatTimestamp(mandate.expiry)}</span></div>
            {isPrincipal && (
              <Button variant="destructive" size="sm" className="mt-2 self-start" onClick={handleRevoke} disabled={revoking}>
                {revoking ? "Revoking…" : "Revoke mandate"}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{mandate?.active ? "Replace mandate" : "Create mandate"}</CardTitle>
          <CardDescription>Your wallet must itself hold a valid, compliant A-Pass — checked on-chain at creation.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {wallet.address && principalStatus?.hasApass && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Your CVI tier {principalStatus.tier}</Badge>
              {capsAreSuggested && suggestedCapsForTier(principalStatus.tier) && (
                <span>caps below suggested from this — edit any field to set your own</span>
              )}
              {capsAreSuggested && !suggestedCapsForTier(principalStatus.tier) && (
                <span>below tier 30, this corridor&apos;s registered floor — createMandate() will refuse on-chain regardless of caps entered</span>
              )}
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Per-tx cap</Label>
              <Input type="number" value={perTxCap} onChange={(e) => editCap(setPerTxCap, e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Daily cap</Label>
              <Input type="number" value={dailyCap} onChange={(e) => editCap(setDailyCap, e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Total cap</Label>
              <Input type="number" value={totalCap} onChange={(e) => editCap(setTotalCap, e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Expires in (days)</Label>
            <Input type="number" value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} className="max-w-[120px]" />
          </div>
          {createError && (
            <Alert variant="destructive">
              <AlertTitle>Refused</AlertTitle>
              <AlertDescription>{createError}</AlertDescription>
            </Alert>
          )}
          <Button onClick={handleCreateMandate} disabled={!wallet.address || !wallet.isOnActiveChain || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress) || creating}>
            {creating ? "Creating…" : "Create mandate"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>
            Real on-chain events for this agent. ALLOWs are <code className="font-mono text-xs">MandateExecuted</code> events — a
            revert leaves no log by definition, so DENYs (refused attempts) are visible in the caller&apos;s own x402/MCP
            call log, not here; the chain only records what actually settled.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activityLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!activityLoading && activity.length === 0 && <p className="text-sm text-muted-foreground">No activity yet.</p>}
          <div className="flex flex-col gap-2">
            {activity.map((e, i) => (
              <div key={`${e.txHash}-${i}`}>
                {i > 0 && <Separator className="my-2" />}
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    {e.type === "MandateExecuted" && <Badge className="bg-emerald-600/20 text-emerald-400 border-emerald-600/40 hover:bg-emerald-600/20">ALLOW</Badge>}
                    {e.type === "MandateCreated" && <Badge variant="outline">Created</Badge>}
                    {e.type === "MandateRevokedEvt" && <Badge variant="destructive">Revoked</Badge>}
                    {e.type === "MandateSuspended" && <Badge variant="destructive">Suspended</Badge>}
                    {e.type === "MandateExecuted" && (
                      <span className="text-muted-foreground">
                        {fromBaseUnits(e.data.amount as bigint)} aUSDC &rarr; {shortAddress(e.data.recipient as string)}
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{shortAddress(e.txHash)}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <FunnelFooter />
    </div>
  );
}
