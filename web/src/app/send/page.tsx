"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StepHeader, FunnelFooter } from "@/components/funnel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { ComplianceBadge } from "@/components/compliance-badge";
import { usePublicClient } from "@/lib/wallet";
import { useWallet } from "@/lib/wallet-context";
import { api, type RecipientResult, type QuoteResult, type RampQuoteResult, ApiError } from "@/lib/api";
import { toBaseUnits, fromBaseUnits, shortAddress } from "@/lib/format";
import { decodeContractError } from "@/lib/decode-error";
import { ATOKEN_ABI, LEGATE_ESCROW_ABI, CONTRACTS, activeChain } from "@/lib/contracts";

type SendStep = "idle" | "checking-allowance" | "needs-approval" | "approving" | "ready" | "initiating" | "done";

export default function SendPage() {
  const wallet = useWallet();
  const publicClient = usePublicClient();

  const [recipientInput, setRecipientInput] = useState("");
  const [recipient, setRecipient] = useState<RecipientResult | null>(null);
  const [recipientLoading, setRecipientLoading] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  const [amount, setAmount] = useState("100");
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [step, setStep] = useState<SendStep>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [settledPaymentId, setSettledPaymentId] = useState<string | null>(null);

  const [rampFiatAmount, setRampFiatAmount] = useState("100");
  const [rampQuote, setRampQuote] = useState<RampQuoteResult | null>(null);
  const [rampLoading, setRampLoading] = useState(false);
  const [rampError, setRampError] = useState<string | null>(null);
  const [rampWidgetUrl, setRampWidgetUrl] = useState<string | null>(null);

  const amountBaseUnits = useMemo(() => {
    try {
      return toBaseUnits(amount || "0");
    } catch {
      return 0n;
    }
  }, [amount]);

  // Debounced recipient A-Pass lookup — real REST call, not simulated.
  useEffect(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipientInput)) {
      setRecipient(null);
      setRecipientError(recipientInput ? "Enter a valid 20-byte address (0x...)" : null);
      return;
    }
    setRecipientError(null);
    setRecipientLoading(true);
    let cancelled = false;
    const handle = setTimeout(() => {
      api
        .getRecipient(recipientInput)
        .then((r) => {
          if (!cancelled) setRecipient(r);
        })
        .catch((e) => {
          if (cancelled) return;
          // Real, previously-missing bug: a failed lookup used to leave the PREVIOUS
          // recipient's data in place, so the Send button (gated on recipient?.hasApass)
          // stayed enabled and would submit to a stale address, not the one currently typed
          // — see DECISIONS.md. Clearing it makes the button correctly re-disable instead.
          setRecipient(null);
          setRecipientError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setRecipientLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [recipientInput]);

  // Quote + compliance preview once we have a connected sender, a valid recipient, and an amount.
  useEffect(() => {
    if (!wallet.address || !recipient || amountBaseUnits <= 0n) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    setQuoteLoading(true);
    setQuoteError(null);
    let cancelled = false;
    // Debounced + race-guarded like the recipient lookup above — a real, previously-missing
    // gap: every keystroke in the Amount field fired an uncancelled request, so a slower
    // response for an earlier amount could resolve after a newer one and overwrite the
    // displayed fee/compliance preview with stale data. See DECISIONS.md.
    const handle = setTimeout(() => {
      api
        .getQuote(wallet.address!, recipient.address, amountBaseUnits.toString())
        .then((q) => {
          if (!cancelled) setQuote(q);
        })
        .catch((e) => {
          if (cancelled) return;
          setQuote(null);
          setQuoteError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setQuoteLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [wallet.address, recipient, amountBaseUnits]);

  // Real on-chain balance + allowance for the connected wallet.
  useEffect(() => {
    if (!wallet.address || !wallet.isOnActiveChain || !CONTRACTS.aToken) return;
    let cancelled = false;
    (async () => {
      const [bal, allow] = await Promise.all([
        publicClient.readContract({ address: CONTRACTS.aToken, abi: ATOKEN_ABI, functionName: "balanceOf", args: [wallet.address!] }),
        publicClient.readContract({
          address: CONTRACTS.aToken,
          abi: ATOKEN_ABI,
          functionName: "allowance",
          args: [wallet.address!, CONTRACTS.legateEscrow],
        }),
      ]);
      if (!cancelled) {
        setBalance(bal as bigint);
        setAllowance(allow as bigint);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.address, wallet.isOnActiveChain, publicClient, step]);

  const needsApproval = allowance !== null && amountBaseUnits > 0n && allowance < amountBaseUnits;
  const insufficientBalance = balance !== null && amountBaseUnits > balance;

  async function handleApprove() {
    const client = wallet.getWalletClient();
    if (!client) return;
    setTxError(null);
    setStep("approving");
    try {
      const hash = await client.writeContract({
        address: CONTRACTS.aToken,
        abi: ATOKEN_ABI,
        functionName: "approve",
        args: [CONTRACTS.legateEscrow, amountBaseUnits],
        chain: activeChain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setStep("idle");
    } catch (err) {
      setTxError(decodeContractError(err).message);
      setStep("idle");
    }
  }

  async function handleSend() {
    const client = wallet.getWalletClient();
    if (!client || !recipient) return;
    setTxError(null);
    setStep("initiating");
    try {
      // simulate first — surfaces the real decoded revert (compliance/cap) without spending gas.
      await publicClient.simulateContract({
        address: CONTRACTS.legateEscrow,
        abi: LEGATE_ESCROW_ABI,
        functionName: "initiate",
        args: [recipient.address as `0x${string}`, amountBaseUnits],
        account: wallet.address!,
      });
      const hash = await client.writeContract({
        address: CONTRACTS.legateEscrow,
        abi: LEGATE_ESCROW_ABI,
        functionName: "initiate",
        args: [recipient.address as `0x${string}`, amountBaseUnits],
        chain: activeChain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const escrowedLog = receipt.logs.find((l) => l.topics[0] && l.address.toLowerCase() === CONTRACTS.legateEscrow.toLowerCase());
      const paymentId = escrowedLog?.topics[1] ?? null;
      setSettledPaymentId(paymentId);
      setStep("done");
    } catch (err) {
      setTxError(decodeContractError(err).message);
      setStep("idle");
    }
  }

  async function handleRampQuote() {
    setRampLoading(true);
    setRampError(null);
    setRampQuote(null);
    setRampWidgetUrl(null);
    try {
      const q = await api.getRampQuote({
        fiatCurrency: "MYR",
        cryptoCurrency: "USDC",
        isBuyOrSell: "BUY",
        paymentMethod: "credit_debit_card",
        fiatAmount: Number(rampFiatAmount),
      });
      setRampQuote(q);
    } catch (err) {
      setRampError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRampLoading(false);
    }
  }

  async function handleOpenRampWidget() {
    if (!rampQuote || !wallet.address) return;
    try {
      const widget = await api.createRampWidget({ quoteToken: rampQuote.quoteToken, walletAddress: wallet.address, walletChain: "base" });
      setRampWidgetUrl(widget.widgetUrl);
      window.open(widget.widgetUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setRampError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <StepHeader
        title="Send"
        claim="Malaysia to Philippines. Watch three compliance layers run before the payment exists — try an unverified recipient to see one refuse."
      />

      {!wallet.address && (
        <Alert>
          <AlertTitle>Connect your wallet</AlertTitle>
          <AlertDescription>Connect a wallet to look up a live quote and send a payment.</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>1. Recipient</CardTitle>
          <CardDescription>Looked up live against Cleanverse&apos;s real A-Pass registry.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recipient">Recipient address</Label>
            <Input id="recipient" placeholder="0x..." value={recipientInput} onChange={(e) => setRecipientInput(e.target.value.trim())} className="font-mono" />
          </div>
          {recipientLoading && <p className="text-sm text-muted-foreground">Checking A-Pass…</p>}
          {recipientError && <p className="text-sm text-destructive">{recipientError}</p>}
          {recipient && !recipientLoading && (
            <div className="flex items-center gap-2 flex-wrap">
              {recipient.hasApass ? (
                <>
                  <Badge className="bg-emerald-600/20 text-emerald-400 border-emerald-600/40 hover:bg-emerald-600/20">A-Pass verified</Badge>
                  <Badge variant="outline">Tier {recipient.tier}</Badge>
                  <Badge variant="outline">{recipient.status}</Badge>
                  {recipient.canReceive === false && <Badge variant="destructive">Cannot receive</Badge>}
                  {recipient.note && <span className="text-xs text-muted-foreground w-full">{recipient.note}</span>}
                </>
              ) : (
                <Badge variant="destructive">No A-Pass on file</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Amount &amp; compliance preview</CardTitle>
          <CardDescription>A gas-free preview of what the chain will independently re-verify.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="amount">Amount (aUSDC)</Label>
            <Input id="amount" type="number" min="0" step="0.000001" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {quoteLoading && <p className="text-sm text-muted-foreground">Fetching quote…</p>}
          {quoteError && <p className="text-sm text-destructive">{quoteError}</p>}
          {quote && (
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Protocol fee ({Number(quote.feeBps) / 100}%)</span><span>{fromBaseUnits(quote.feeBaseUnits)} aUSDC</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Recipient receives</span><span>{fromBaseUnits(quote.netToRecipientBaseUnits)} aUSDC</span></div>
              <Separator />
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Compliance preview</span>
                <ComplianceBadge preview={quote.compliancePreview} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Fund via the real Fiat Ramp (optional)</CardTitle>
          <CardDescription>
            MYR &rarr; USDC via Cleanverse&apos;s real Gateway. Settles on Cleanverse&apos;s verified-working network
            (<code className="font-mono text-xs">base</code>) — Monad is not currently a supported ramp settlement
            network despite the docs listing it (live-verified; see DECISIONS.md). This funds a USDC balance you
            control on that chain; it does not automatically become Monad aUSDC.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2 items-end">
            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor="ramp-amount">MYR amount</Label>
              <Input id="ramp-amount" type="number" min="0" value={rampFiatAmount} onChange={(e) => setRampFiatAmount(e.target.value)} />
            </div>
            <Button variant="outline" onClick={handleRampQuote} disabled={rampLoading}>
              {rampLoading ? "Quoting…" : "Get real quote"}
            </Button>
          </div>
          {rampError && <p className="text-sm text-destructive">{rampError}</p>}
          {rampQuote && (
            <div className="text-sm flex flex-col gap-1">
              <div className="flex justify-between"><span className="text-muted-foreground">You receive</span><span>{rampQuote.cryptoAmount} USDC</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Fee</span><span>{rampQuote.totalFee} MYR</span></div>
              <Button size="sm" className="mt-2 self-start" onClick={handleOpenRampWidget} disabled={!wallet.address}>
                Open Cleanverse Ramp ↗
              </Button>
              {rampWidgetUrl && <p className="text-xs text-muted-foreground break-all">{rampWidgetUrl}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Send</CardTitle>
          <CardDescription>Signed directly by your wallet — Legate never custodies funds or relays this transaction.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {wallet.address && balance !== null && (
            <p className="text-sm text-muted-foreground">Your balance: {fromBaseUnits(balance)} aUSDC</p>
          )}
          {insufficientBalance && <p className="text-sm text-destructive">Insufficient aUSDC balance.</p>}
          {txError && (
            <Alert variant="destructive">
              <AlertTitle>Refused</AlertTitle>
              <AlertDescription>{txError}</AlertDescription>
            </Alert>
          )}
          {step === "done" && settledPaymentId ? (
            <Alert>
              <AlertTitle>Escrowed on-chain</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <span className="font-mono text-xs break-all">{settledPaymentId}</span>
                <Link href={`/receipt/${settledPaymentId}`} className="underline">
                  View receipt &rarr;
                </Link>
              </AlertDescription>
            </Alert>
          ) : needsApproval ? (
            <Button onClick={handleApprove} disabled={!wallet.address || step === "approving" || amountBaseUnits <= 0n}>
              {step === "approving" ? "Approving…" : "Approve aUSDC"}
            </Button>
          ) : (
            <>
              {quote?.compliancePreview.allowed === false && (
                <p className="text-xs text-muted-foreground">
                  The off-chain preview shows this would be blocked ({quote.compliancePreview.reason}) — but this is
                  only a fast, gas-free preview (see PRD §3). The contract independently re-verifies everything on
                  submission; you can still attempt it and the real on-chain reason will be shown if refused.
                </p>
              )}
              <Button
                onClick={handleSend}
                disabled={!wallet.address || !wallet.isOnActiveChain || !recipient?.hasApass || amountBaseUnits <= 0n || insufficientBalance || step === "initiating"}
              >
                {step === "initiating" ? "Sending…" : `Send ${amount || "0"} aUSDC to ${recipient ? shortAddress(recipient.address) : "recipient"}`}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
      <FunnelFooter />
    </div>
  );
}
