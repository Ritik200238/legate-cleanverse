import { useState } from "react";
import { api, ApiError, type RampQuoteResult } from "./api";

/**
 * The real Fiat Ramp quote flow — identical shape on Send (MYR -> USDC, BUY) and Claim
 * (USDC -> PHP, SELL), previously copy-pasted between the two pages with only the currency
 * direction flipped (see DECISIONS.md). One real fix folded in during extraction: Claim never
 * cleared a stale quote before fetching a new one, so a failed re-quote after changing the
 * amount could leave the previous quote's numbers on screen next to the new error — Send
 * already cleared it correctly; both pages now do.
 */
export function useRampQuote(opts: { fiatCurrency: "MYR" | "PHP"; isBuyOrSell: "BUY" | "SELL"; amountField: "fiatAmount" | "cryptoAmount" }) {
  const [amount, setAmount] = useState("100");
  const [quote, setQuote] = useState<RampQuoteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function getQuote() {
    setLoading(true);
    setError(null);
    setQuote(null);
    try {
      const q = await api.getRampQuote({
        fiatCurrency: opts.fiatCurrency,
        cryptoCurrency: "USDC",
        isBuyOrSell: opts.isBuyOrSell,
        paymentMethod: "credit_debit_card",
        [opts.amountField]: Number(amount),
      });
      setQuote(q);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return { amount, setAmount, quote, setQuote, loading, error, setError, getQuote };
}
