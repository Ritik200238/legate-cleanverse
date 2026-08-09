"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWallet } from "@/lib/wallet-context";

/**
 * "Request a payment" — the one genuinely missing piece in the send/receive story. Legate
 * already does sender-initiated transfers (Send) and escrow settlement (Claim); what it didn't
 * have was a way for the *recipient* to ask first: generate a link or QR pointing at their own
 * address, hand it to whoever owes them money, and let that person's browser land in Send
 * already pointed the right way.
 *
 * Deliberately not a new on-chain object or a backend endpoint. A request is not a payment —
 * it's an address plus a suggestion, and inventing server-side state for something this thin
 * would be exactly the kind of unearned abstraction this project's own rules argue against. The
 * link IS the request: everything it carries is a URL search param the Send page already knows
 * how to read, so there is nothing to store, expire, or reconcile.
 *
 * QR is rendered client-side to a canvas — no third-party QR API, so a payment request address
 * never leaves the browser before the requester chooses to share it themselves.
 */
export function RequestPayment() {
  const wallet = useWallet();
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const requestUrl = (() => {
    if (!wallet.address || typeof window === "undefined") return null;
    const url = new URL("/send", window.location.origin);
    url.searchParams.set("to", wallet.address);
    if (amount) url.searchParams.set("amount", amount);
    if (memo.trim()) url.searchParams.set("memo", memo.trim());
    return url.toString();
  })();

  useEffect(() => {
    if (!requestUrl || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, requestUrl, { width: 176, margin: 1 }).catch(() => {
      // A canvas render failure leaves the link itself still copyable — the QR is a
      // convenience on top of the link, never the only way to get it.
    });
  }, [requestUrl]);

  async function copyLink() {
    if (!requestUrl) return;
    await navigator.clipboard.writeText(requestUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!wallet.address) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Request a payment</CardTitle>
        <CardDescription>
          Share a link or QR pointing at your own address. Opening it starts Send already filled
          in — the same compliance checks run either way, nothing about this bypasses them.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex gap-3 flex-wrap">
          <div className="flex flex-col gap-1.5 flex-1 min-w-[140px]">
            <Label htmlFor="request-amount">Amount (optional)</Label>
            <Input
              id="request-amount"
              type="number"
              min="0"
              step="0.000001"
              placeholder="Any amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5 flex-[2] min-w-[180px]">
            <Label htmlFor="request-memo">Memo (optional)</Label>
            <Input
              id="request-memo"
              placeholder="e.g. October rent"
              maxLength={80}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
        </div>

        {requestUrl && (
          <div className="flex gap-4 items-start flex-wrap">
            <canvas ref={canvasRef} className="rounded-md border border-border shrink-0" />
            <div className="flex flex-col gap-2 min-w-0 flex-1">
              <p className="text-xs font-mono break-all text-muted-foreground bg-secondary rounded-md p-2">
                {requestUrl}
              </p>
              <Button variant="outline" size="sm" className="self-start" onClick={copyLink}>
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
