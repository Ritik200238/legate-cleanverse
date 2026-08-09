"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { FUNNEL_STEPS, stepIndexFor } from "@/lib/funnel-steps";

export { FUNNEL_STEPS, stepIndexFor };

/**
 * The walkthrough spine.
 *
 * Judging is asynchronous — a judge opens this with no wallet, no testnet funds, no A-Pass,
 * and a few minutes of attention. Four equal navigation links ask that person to choose a
 * starting point before they know what any of it is, and choosing is friction paid before any
 * value is delivered. So the app has one obvious path through it, every step says what it
 * proves, and every step hands you the next one.
 *
 * The order is the argument, not a menu: a payment clears compliance before it exists, the
 * money moves or comes back, an agent spends under a mandate it cannot talk its way past, and
 * then anyone verifies all of it without a wallet.
 */

/** Compact progress rail, shown at the top of each step so position is never ambiguous. */
export function FunnelProgress() {
  const pathname = usePathname();
  const current = stepIndexFor(pathname);
  if (current < 0) return null;

  return (
    <div className="flex items-center gap-1.5 text-xs">
      {FUNNEL_STEPS.map((step, i) => (
        <div key={step.href} className="flex items-center gap-1.5">
          <Link
            href={step.href}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2 py-0.5 transition-colors",
              i === current
                ? "bg-primary/15 text-primary font-medium"
                : i < current
                  ? "text-muted-foreground hover:text-foreground"
                  : "text-muted-foreground/60 hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px]",
                i === current ? "border-primary text-primary" : "border-muted-foreground/40",
              )}
            >
              {i + 1}
            </span>
            {step.label}
          </Link>
          {i < FUNNEL_STEPS.length - 1 && <span className="text-muted-foreground/30">→</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * End-of-step handoff. Without this the walkthrough dead-ends on every page and the viewer has
 * to go back to the nav and guess — which is exactly the moment a demo loses its thread.
 */
export function FunnelFooter() {
  const pathname = usePathname();
  const current = stepIndexFor(pathname);
  if (current < 0) return null;

  const next = FUNNEL_STEPS[current + 1];

  return (
    <Card className="border-dashed">
      <CardContent className="pt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Step {current + 1} of {FUNNEL_STEPS.length} — what this proved
          </span>
          <span className="text-sm">{FUNNEL_STEPS[current].proves}</span>
        </div>
        {next ? (
          <Link
            href={next.href}
            className="shrink-0 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Next: {next.label} →
          </Link>
        ) : (
          <Link
            href="/"
            className="shrink-0 inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm hover:bg-secondary transition-colors"
          >
            ← Back to the start
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/** Header block for a step: progress rail, title, and the one-line claim being tested. */
export function StepHeader({ title, claim }: { title: string; claim: string }) {
  return (
    <div className="flex flex-col gap-3">
      <FunnelProgress />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-sm mt-1">{claim}</p>
      </div>
    </div>
  );
}
