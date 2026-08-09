/**
 * The walkthrough's step definitions.
 *
 * Deliberately NOT inside `components/funnel.tsx`. That module is `"use client"`, and only
 * functions survive the server/client boundary as usable references — a plain array imported
 * from a client module into a Server Component arrives as a proxy that is not an array, so
 * `.map()` throws at prerender. (It did: the build failed with "FUNNEL_STEPS.map is not a
 * function".) Shared data belongs in a module neither side owns.
 */
export const FUNNEL_STEPS = [
  {
    href: "/send",
    label: "Send",
    proves: "Compliance runs before the payment exists — three layers, on-chain, both parties.",
  },
  {
    href: "/claim",
    label: "Claim",
    proves: "The recipient settles. If nobody ever does, the sender takes their money back.",
  },
  {
    href: "/agent",
    label: "Agent",
    proves: "An AI agent spends under caps held in contract storage, not in a prompt.",
  },
  {
    href: "/auditor",
    label: "Verify",
    proves: "Anyone can audit any payment. No wallet required — this is the judge's entry point.",
  },
] as const;

export function stepIndexFor(pathname: string): number {
  return FUNNEL_STEPS.findIndex((s) => pathname.startsWith(s.href));
}
