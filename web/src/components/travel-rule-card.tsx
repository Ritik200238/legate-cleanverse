import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { type PaymentResult } from "@/lib/api";
import { shortAddress, formatTimestamp } from "@/lib/format";

/**
 * The Travel Rule proof card — identical structure on the Auditor page and the receipt
 * permalink, previously duplicated verbatim in both (see DECISIONS.md). `explainNotAnchored`
 * controls only the not-yet-anchored copy: Auditor's fuller walkthrough context vs. the
 * permalink's terser display.
 */
export function TravelRuleCard({ payment, explainNotAnchored = false }: { payment: PaymentResult; explainNotAnchored?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Travel Rule compliance proof</CardTitle>
        <CardDescription>
          A hash anchor of Cleanverse&apos;s real{" "}
          {explainNotAnchored && <code className="font-mono text-xs">download_travel_rule</code>}
          {!explainNotAnchored && "compliance"} report — never the report or any identity data itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {payment.travelRuleAnchor ? (
          <>
            <div className="flex justify-between"><span className="text-muted-foreground">Report hash</span><span className="font-mono text-xs">{shortAddress(payment.travelRuleAnchor.reportHash)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Anchored</span><span>{formatTimestamp(payment.travelRuleAnchor.anchoredAt)}</span></div>
          </>
        ) : explainNotAnchored && payment.state === "Settled" ? (
          <div className="print:hidden">
            <Alert>
              <AlertTitle>Not yet anchored</AlertTitle>
              <AlertDescription>
                Anchoring pulls Cleanverse&apos;s real compliance report for this settlement and writes its hash
                on-chain. This is a server-signed action — <code className="font-mono text-xs">TravelRuleAnchor.anchor()</code>{" "}
                is <code className="font-mono text-xs">ANCHOR_ROLE</code>-gated on-chain by design, run by whoever
                operates this corridor, not triggered from a public page. Check back after the operator anchors it.
              </AlertDescription>
            </Alert>
          </div>
        ) : explainNotAnchored ? (
          <p className="text-muted-foreground">Anchoring is only available once a payment is Settled.</p>
        ) : (
          <p className="text-muted-foreground">Not yet anchored.</p>
        )}
      </CardContent>
    </Card>
  );
}
