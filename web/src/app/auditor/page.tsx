"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StepHeader, FunnelFooter } from "@/components/funnel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api, type PaymentResult, ApiError } from "@/lib/api";
import { fromBaseUnits, shortAddress, formatTimestamp } from "@/lib/format";
import { activeChain } from "@/lib/contracts";

const STATE_VARIANT: Record<PaymentResult["state"], "outline" | "secondary" | "destructive"> = {
  None: "outline",
  Escrowed: "outline",
  Settled: "secondary",
  Frozen: "destructive",
  Refunded: "destructive",
};

export default function AuditorPage() {
  const [paymentIdInput, setPaymentIdInput] = useState("");
  const [payment, setPayment] = useState<PaymentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [anchoring, setAnchoring] = useState(false);
  const [anchorError, setAnchorError] = useState<string | null>(null);

  async function lookup() {
    setError(null);
    setPayment(null);
    if (!/^0x[0-9a-fA-F]{64}$/.test(paymentIdInput)) {
      setError("Enter a valid 32-byte payment ID (0x...)");
      return;
    }
    setLoading(true);
    try {
      const result = await api.getPayment(paymentIdInput);
      if (!result) {
        setError("No payment found for this ID.");
        return;
      }
      setPayment(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleAnchor() {
    if (!payment) return;
    setAnchorError(null);
    setAnchoring(true);
    try {
      await api.anchorTravelRule(payment.paymentId);
      const refreshed = await api.getPayment(payment.paymentId);
      setPayment(refreshed);
    } catch (err) {
      setAnchorError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAnchoring(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div className="print:hidden">
        <StepHeader
          title="Verify"
          claim="Audit any payment — real on-chain state, the real Travel Rule report, and its hash anchor. No wallet needed for this step."
        />
      </div>

      <Card className="print:hidden">
        <CardHeader>
          <CardTitle>Look up a payment</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input placeholder="0x... payment ID" value={paymentIdInput} onChange={(e) => setPaymentIdInput(e.target.value.trim())} className="font-mono" />
            <Button onClick={lookup} disabled={loading}>{loading ? "Looking up…" : "Look up"}</Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {payment && (
        <>
          <Card className={payment.state === "Frozen" ? "border-destructive" : undefined}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Payment record</CardTitle>
                <Badge variant={STATE_VARIANT[payment.state]}>{payment.state}</Badge>
              </div>
              <CardDescription className="font-mono text-xs break-all">{payment.paymentId}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Sender</span><span className="font-mono">{shortAddress(payment.sender)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Recipient</span><span className="font-mono">{shortAddress(payment.recipient)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span>{fromBaseUnits(payment.amountBaseUnits)} aUSDC</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{formatTimestamp(payment.createdAt)}</span></div>
              {payment.settledAt && <div className="flex justify-between"><span className="text-muted-foreground">Settled</span><span>{formatTimestamp(payment.settledAt)}</span></div>}
              {payment.settlementTxHash && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Settlement tx</span>
                  <a
                    href={`${activeChain.blockExplorers?.default.url ?? ""}/tx/${payment.settlementTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs underline"
                  >
                    {shortAddress(payment.settlementTxHash)}
                  </a>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Travel Rule compliance proof</CardTitle>
              <CardDescription>
                A hash anchor of Cleanverse&apos;s real <code className="font-mono text-xs">download_travel_rule</code> report —
                never the report or any identity data itself.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {payment.travelRuleAnchor ? (
                <>
                  <div className="flex justify-between"><span className="text-muted-foreground">Report hash</span><span className="font-mono text-xs">{shortAddress(payment.travelRuleAnchor.reportHash)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Anchored</span><span>{formatTimestamp(payment.travelRuleAnchor.anchoredAt)}</span></div>
                </>
              ) : payment.state === "Settled" ? (
                <div className="print:hidden flex flex-col gap-2">
                  <Alert>
                    <AlertTitle>Not yet anchored</AlertTitle>
                    <AlertDescription>
                      Pull Cleanverse&apos;s real compliance report for this settlement and anchor its hash on-chain.
                    </AlertDescription>
                  </Alert>
                  {anchorError && <p className="text-sm text-destructive">{anchorError}</p>}
                  <Button size="sm" onClick={handleAnchor} disabled={anchoring} className="self-start">
                    {anchoring ? "Anchoring…" : "Fetch report & anchor"}
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground">Anchoring is only available once a payment is Settled.</p>
              )}
            </CardContent>
          </Card>

          <div className="flex gap-2 print:hidden">
            <Button variant="outline" onClick={() => window.print()}>Export PDF</Button>
            <Link href={`/receipt/${payment.paymentId}`}>
              <Button variant="outline">View permalink receipt</Button>
            </Link>
          </div>
        </>
      )}
      <FunnelFooter />
    </div>
  );
}
