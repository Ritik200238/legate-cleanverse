/**
 * aUSDC's decimals. 18 on Monad testnet as of 2026-08-08 — but deliberately NOT a bare
 * constant any more: it was hardcoded to 6, Cleanverse redeployed the A-Token with 18, and
 * every amount this app formats or parses was silently off by a factor of 10^12 until a live
 * test caught the address change (see DECISIONS.md). Overridable per deployment, and checked
 * against the token's own `decimals()` at runtime by assertATokenDecimals() below.
 */
export const A_TOKEN_DECIMALS = Number(process.env.NEXT_PUBLIC_ATOKEN_DECIMALS ?? 18);

export function toBaseUnits(humanAmount: string): bigint {
  const [whole, frac = ""] = humanAmount.split(".");
  const paddedFrac = (frac + "0".repeat(A_TOKEN_DECIMALS)).slice(0, A_TOKEN_DECIMALS);
  return BigInt((whole || "0") + paddedFrac);
}

export function fromBaseUnits(baseUnits: string | bigint): string {
  const value = typeof baseUnits === "string" ? BigInt(baseUnits) : baseUnits;
  const divisor = 10n ** BigInt(A_TOKEN_DECIMALS);
  const whole = value / divisor;
  const frac = (value % divisor).toString().padStart(A_TOKEN_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function shortAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString();
}
