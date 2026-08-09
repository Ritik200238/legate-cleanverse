"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StepHeader, FunnelFooter } from "@/components/funnel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { usePublicClient } from "@/lib/wallet";
import { useWallet } from "@/lib/wallet-context";
import { api, type RecipientResult, type PaymentResult, type RampQuoteResult, ApiError } from "@/lib/api";
import { fromBaseUnits, shortAddress, formatTimestamp } from "@/lib/format";
import { decodeContractError } from "@/lib/decode-error";
import { LEGATE_ESCROW_ABI, CONTRACTS, activeChain } from "@/lib/contracts";

export default function ClaimPage() {
  const wallet = useWallet();
  const publicClient = usePublicClient();

  const [myApass, setMyApass] = useState<RecipientResult | null>(null);
  const [paymentIdInput, setPaymentIdInput] = useState("");
  const [payment, setPayment] = useState<PaymentResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [foundIds, setFoundIds] = useState<{ side: "incoming" | "outgoing"; ids: string[] } | null>(null);
  const [scanning, setScanning] = useState<"incoming" | "outgoing" | null>(null);
  const [busy, setBusy] = useState<"claim" | "reclaim" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [chainNow, setChainNow] = useState<number | null>(null);

  const [rampFiatAmount, setRampFiatAmount] = useState("100");
  const [rampQuote, setRampQuote] = useState<RampQuoteResult | null>(null);
  const [rampLoading, setRampLoading] = useState(false);
  const [rampError, setRampError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet.address) {
      setMyApass(null);
      return;
    }
    api.getRecipient(wallet.address).then(setMyApass).catch(() => setMyApass(null));
  }, [wallet.address]);

  // Read the chain's latest block timestamp while an escrowed payment is on screen — this is
  // the exact value reclaimExpired() compares p.claimDeadline against.
  useEffect(() => {
    if (!payment || payment.state !== "Escrowed") {
      setChainNow(null);
      return;
    }
    let cancelled = false;
    publicClient
      .getBlock()
      .then((b) => {
        if (!cancelled) setChainNow(Number(b.timestamp));
      })
      .catch(() => {
        if (!cancelled) setChainNow(null);
      });
    return () => {
      cancelled = true;
    };
  }, [payment, publicClient]);

  async function lookupPayment(id: string) {
    setLookupError(null);
    setPayment(null);
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
      setLookupError("Enter a valid 32-byte payment ID (0x...)");
      return;
    }
    try {
      const result = await api.getPayment(id);
      if (!result) {
        setLookupError("No payment found for this ID.");
        return;
      }
      setPayment(result);
    } catch (err) {
      setLookupError(err instanceof ApiError ? err.message : String(err));
    }
  }

  // PaymentEscrowed indexes both sender and recipient, so the same real event log answers
  // "what's owed to me" and "what have I sent that's still sitting there" — no separate index.
  async function scanForMyPayments(side: "incoming" | "outgoing") {
    if (!wallet.address) return;
    setScanning(side);
    setLookupError(null);
    try {
      const logs = await publicClient.getContractEvents({
        address: CONTRACTS.legateEscrow,
        abi: LEGATE_ESCROW_ABI,
        eventName: "PaymentEscrowed",
        args: side === "incoming" ? { recipient: wallet.address } : { sender: wallet.address },
        fromBlock: 0n,
        toBlock: "latest",
      });
      const ids = logs.map((l) => l.args.paymentId as string).filter(Boolean);
      setFoundIds({ side, ids: ids.reverse() });
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(null);
    }
  }

  // Both actions are the same shape — simulate first so the real decoded revert surfaces
  // without spending gas, then write, then re-read the payment from chain.
  async function runEscrowAction(kind: "claim" | "reclaim") {
    const client = wallet.getWalletClient();
    if (!client || !payment) return;
    const functionName = kind === "claim" ? "settle" : "reclaimExpired";
    const args = [payment.paymentId as `0x${string}`] as const;
    setActionError(null);
    setBusy(kind);
    try {
      await publicClient.simulateContract({
        address: CONTRACTS.legateEscrow,
        abi: LEGATE_ESCROW_ABI,
        functionName,
        args,
        account: wallet.address!,
      });
      const hash = await client.writeContract({
        address: CONTRACTS.legateEscrow,
        abi: LEGATE_ESCROW_ABI,
        functionName,
        args,
        chain: activeChain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await lookupPayment(payment.paymentId);
    } catch (err) {
      setActionError(decodeContractError(err).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleRampQuote() {
    setRampLoading(true);
    setRampError(null);
    try {
      const q = await api.getRampQuote({
        fiatCurrency: "PHP",
        cryptoCurrency: "USDC",
        isBuyOrSell: "SELL",
        paymentMethod: "credit_debit_card",
        cryptoAmount: Number(rampFiatAmount),
      });
      setRampQuote(q);
    } catch (err) {
      setRampError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRampLoading(false);
    }
  }

  const connected = wallet.address?.toLowerCase();
  const isRecipient = !!connected && !!payment && connected === payment.recipient.toLowerCase();
  const isSender = !!connected && !!payment && connected === payment.sender.toLowerCase();
  // Compared against the chain's own clock, not the browser's — reclaimExpired() gates on
  // block.timestamp, and on a local or fast-forwarded chain those two differ enough to
  // disable a button the contract would happily accept (or vice versa).
  const windowHasClosed = chainNow !== null && !!payment?.claimDeadline && chainNow >= payment.claimDeadline;

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <StepHeader
        title="Claim"
        claim="Settle an open escrow with your own wallet — no relayer, no custody. Recipients claim what was sent to them; senders reclaim what was never picked up."
      />

      {!wallet.address && (
        <Alert>
          <AlertTitle>Connect your wallet</AlertTitle>
          <AlertDescription>Connect the recipient wallet to look up and claim a payment.</AlertDescription>
        </Alert>
      )}

      {wallet.address && (
        <Card>
          <CardHeader>
            <CardTitle>Your A-Pass status</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 flex-wrap">
            {myApass?.hasApass ? (
              <>
                <Badge className="bg-emerald-600/20 text-emerald-400 border-emerald-600/40 hover:bg-emerald-600/20">A-Pass verified</Badge>
                <Badge variant="outline">Tier {myApass.tier}</Badge>
                <Badge variant="outline">{myApass.status}</Badge>
              </>
            ) : (
              <Badge variant="destructive">No A-Pass on file for this wallet</Badge>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Find a payment</CardTitle>
          <CardDescription>Enter a payment ID, or scan the chain for payments escrowed to your address.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input placeholder="0x... payment ID" value={paymentIdInput} onChange={(e) => setPaymentIdInput(e.target.value.trim())} className="font-mono" />
            <Button variant="outline" onClick={() => lookupPayment(paymentIdInput)}>Look up</Button>
          </div>
          <div className="flex gap-1 flex-wrap">
            <Button variant="ghost" size="sm" onClick={() => scanForMyPayments("incoming")} disabled={!wallet.address || scanning !== null}>
              {scanning === "incoming" ? "Scanning chain…" : "Payments sent to me"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => scanForMyPayments("outgoing")} disabled={!wallet.address || scanning !== null}>
              {scanning === "outgoing" ? "Scanning chain…" : "Payments I sent"}
            </Button>
          </div>
          {foundIds?.ids.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No {foundIds.side === "incoming" ? "incoming" : "outgoing"} payments found on-chain for this wallet.
            </p>
          )}
          {foundIds && foundIds.ids.length > 0 && (
            <div className="flex flex-col gap-1">
              {foundIds.ids.map((id) => (
                <button
                  key={id}
                  className="text-left text-xs font-mono text-muted-foreground hover:text-foreground truncate"
                  onClick={() => {
                    setPaymentIdInput(id);
                    lookupPayment(id);
                  }}
                >
                  {id}
                </button>
              ))}
            </div>
          )}
          {lookupError && <p className="text-sm text-destructive">{lookupError}</p>}
        </CardContent>
      </Card>

      {payment && (
        <Card>
          <CardHeader>
            <CardTitle>Payment {shortAddress(payment.paymentId)}</CardTitle>
            <CardDescription>State: <Badge variant={payment.state === "Escrowed" ? "outline" : payment.state === "Settled" ? "secondary" : "destructive"}>{payment.state}</Badge></CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">From</span><span className="font-mono">{shortAddress(payment.sender)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">To</span><span className="font-mono">{shortAddress(payment.recipient)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span>{fromBaseUnits(payment.amountBaseUnits)} aUSDC</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{formatTimestamp(payment.createdAt)}</span></div>
            {payment.state === "Escrowed" && payment.claimDeadline && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Reclaimable by sender after</span>
                <span>{formatTimestamp(payment.claimDeadline)}</span>
              </div>
            )}
            {actionError && (
              <Alert variant="destructive" className="mt-2">
                <AlertTitle>Refused</AlertTitle>
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            )}
            {payment.state === "Escrowed" && isRecipient && (
              <>
                <Button className="mt-2" onClick={() => runEscrowAction("claim")} disabled={!wallet.isOnActiveChain || busy !== null}>
                  {busy === "claim" ? "Claiming…" : "Claim"}
                </Button>
                {windowHasClosed && (
                  <p className="text-xs text-amber-500">
                    The claim window has closed. You can still claim this — the deadline never expires your right — but
                    the sender can now take it back at any moment, and whichever transaction lands first wins.
                  </p>
                )}
              </>
            )}
            {payment.state === "Escrowed" && isSender && (
              <>
                <Button
                  className="mt-2"
                  variant="outline"
                  onClick={() => runEscrowAction("reclaim")}
                  disabled={!wallet.isOnActiveChain || !windowHasClosed || busy !== null}
                >
                  {busy === "reclaim" ? "Reclaiming…" : "Reclaim my funds"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {windowHasClosed
                    ? "The claim window has closed and the recipient never claimed. You can take your own funds back — in full, no fee — without waiting on an administrator."
                    : "You sent this. If the recipient never claims it, you can take the funds back yourself once the claim window closes. The contract enforces that deadline, not this page."}
                </p>
              </>
            )}
            {wallet.address && payment.state === "Escrowed" && !isRecipient && !isSender && (
              <p className="text-xs text-muted-foreground">
                This payment is between {shortAddress(payment.sender)} and {shortAddress(payment.recipient)} — neither
                side is the connected wallet, so there is nothing for you to do here.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Cash out via the real Fiat Ramp (optional)</CardTitle>
          <CardDescription>
            USDC &rarr; PHP via Cleanverse&apos;s real Gateway, on the verified-working <code className="font-mono text-xs">base</code> network.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2 items-end">
            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor="sell-amount">USDC amount</Label>
              <Input id="sell-amount" type="number" min="0" value={rampFiatAmount} onChange={(e) => setRampFiatAmount(e.target.value)} />
            </div>
            <Button variant="outline" onClick={handleRampQuote} disabled={rampLoading}>
              {rampLoading ? "Quoting…" : "Get real quote"}
            </Button>
          </div>
          {rampError && <p className="text-sm text-destructive">{rampError}</p>}
          {rampQuote && (
            <div className="text-sm flex flex-col gap-1">
              <div className="flex justify-between"><span className="text-muted-foreground">You receive</span><span>{rampQuote.fiatAmount} PHP</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Fee</span><span>{rampQuote.totalFee} PHP</span></div>
            </div>
          )}
        </CardContent>
      </Card>
      <FunnelFooter />
    </div>
  );
}
