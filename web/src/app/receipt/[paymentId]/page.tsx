import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { api, type PaymentResult } from "@/lib/api";
import { fromBaseUnits, shortAddress, formatTimestamp } from "@/lib/format";
import { activeChain } from "@/lib/contracts";

/**
 * Walletless permalink — PRD.md §5.5. Judging is asynchronous; a judge will open this URL
 * without connecting a wallet or running the app locally. Server Component: fetches once on
 * the server, no client-side wallet dependency at all.
 */

const STATE_VARIANT: Record<PaymentResult["state"], "outline" | "secondary" | "destructive"> = {
  None: "outline",
  Escrowed: "outline",
  Settled: "secondary",
  Frozen: "destructive",
  Refunded: "destructive",
};

export default async function ReceiptPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  let payment: PaymentResult | null = null;
  let fetchError: string | null = null;
  try {
    payment = await api.getPayment(paymentId);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl mx-auto">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Legate Receipt</h1>
        <p className="text-muted-foreground text-sm mt-1 font-mono break-all">{paymentId}</p>
      </div>

      {fetchError && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">Could not load this receipt: {fetchError}</CardContent>
        </Card>
      )}

      {!fetchError && !payment && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">No payment found for this ID.</CardContent>
        </Card>
      )}

      {payment && (
        <>
          <Card className={payment.state === "Frozen" ? "border-destructive" : undefined}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Payment status</CardTitle>
                <Badge variant={STATE_VARIANT[payment.state]}>{payment.state}</Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Sender</span><span className="font-mono">{shortAddress(payment.sender)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Recipient</span><span className="font-mono">{shortAddress(payment.recipient)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span>{fromBaseUnits(payment.amountBaseUnits)} aUSDC</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{formatTimestamp(payment.createdAt)}</span></div>
              {payment.settledAt && <div className="flex justify-between"><span className="text-muted-foreground">Settled</span><span>{formatTimestamp(payment.settledAt)}</span></div>}
              <Separator className="my-1" />
              <p className="text-xs text-muted-foreground">
                Every payment independently cleared Cleanverse&apos;s real on-chain{" "}
                <code className="font-mono">complianceVerify()</code> for both parties, and Legate&apos;s own
                per-transaction and daily corridor caps — enforced by the contract, not asserted by this page.
              </p>
              {payment.settlementTxHash && (
                <a
                  href={`${activeChain.blockExplorers?.default.url ?? ""}/tx/${payment.settlementTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs underline text-center mt-1"
                >
                  View settlement transaction on {activeChain.blockExplorers?.default.name ?? "the explorer"} ↗
                </a>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Travel Rule compliance proof</CardTitle>
              <CardDescription>A hash anchor of Cleanverse&apos;s real compliance report — never the report or identity data itself.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              {payment.travelRuleAnchor ? (
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between"><span className="text-muted-foreground">Report hash</span><span className="font-mono text-xs">{shortAddress(payment.travelRuleAnchor.reportHash)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Anchored</span><span>{formatTimestamp(payment.travelRuleAnchor.anchoredAt)}</span></div>
                </div>
              ) : (
                <p className="text-muted-foreground">Not yet anchored.</p>
              )}
            </CardContent>
          </Card>

          <div className="text-center">
            <Link href="/auditor" className="text-xs underline text-muted-foreground">
              Open in Auditor →
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
