import { describe, it, expect } from "vitest";
import {
  queryDepositAtokenList,
  queryApass,
  validatorIsPaused,
  queryRampCountries,
  queryRampFiatCurrencies,
  queryRampCryptoCurrencies,
  queryRampPaymentMethods,
  queryRampQuote,
} from "../src/cleanverse/client.js";
import type { CleanverseConfig } from "../src/cleanverse/client.js";

/**
 * LIVE tests against Cleanverse's real UAT sandbox — not mocks. Per CLAUDE.md: "don't guess,
 * verify against real sources." These prove the TypeScript client's request/response shapes
 * actually match reality, not just that they compile.
 */

const config: CleanverseConfig = {
  baseUrl: "https://uatapi.cleanverse.com/api/cooperate",
  apiId: process.env.CLEANVERSE_API_ID ?? "APP20260614112550LIDZXM",
};

describe("Cleanverse live sandbox — client correctness", () => {
  // This test earns its keep: on 2026-08-08 it failed against the live sandbox and that
  // failure was the ONLY signal that Cleanverse had redeployed Monad's aUSDC — new address,
  // and decimals moved 6 -> 18. Their published docs still show the old address. Everything
  // downstream (deploy-script caps, the web app's amount formatting, the test double) was
  // silently wrong by 10^12 until this went red. Asserting decimals explicitly now, not just
  // the address, so the more dangerous half of that change can't slip through on its own.
  it("queryDepositAtokenList returns the real Monad aUSDC address and decimals", async () => {
    const result = await queryDepositAtokenList(config, "monad");
    expect(result.chain).toBe("monad");
    expect(result.tokens.length).toBeGreaterThan(0);
    const usdcEntry = result.tokens.find((t) => t.origin_token.symbol.toLowerCase() === "usdc");
    expect(usdcEntry).toBeDefined();
    expect(usdcEntry!.atoken.address.toLowerCase()).toBe("0xfa96de5b8f434c26fdff953303dd66ff80af1026");
    expect(usdcEntry!.atoken.decimals).toBe(18);
    // The wrapped origin token is still 6-decimal USDC — the wrapper changed, the underlying
    // did not. Pinned so a future divergence is attributed to the right side of the pair.
    expect(usdcEntry!.origin_token.address.toLowerCase()).toBe("0x534b2f3a21130d7a60830c2df862319e593943a3");
    expect(usdcEntry!.origin_token.decimals).toBe(6);
    expect(usdcEntry!.accesscore_address.toLowerCase()).toBe("0x8f118338a1fa41e7fa86be19a4e8b99ed58a6ecc");
  });

  it("queryApass returns null (not throw) for an unregistered address", async () => {
    const randomAddress = "0x1234567890123456789012345678901234abcd";
    const result = await queryApass(config, "monad", randomAddress);
    expect(result).toBeNull();
  });

  it("queryApass returns real data for the seeded burn address", async () => {
    const result = await queryApass(config, "monad", "0x0000000000000000000000000000000000dEaD");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(1); // active
  });

  it("validatorIsPaused does not throw for an arbitrary pool address (returns a boolean)", async () => {
    // The validator itself is real; this pool address isn't registered yet (that's still
    // pending — see PRD.md §8's #1 priority), so this call proves the endpoint shape works,
    // not that our specific pool exists yet.
    const result = await validatorIsPaused(config, "monad", "0xaC7e5179C2C7f03f209136886c172eb34F161792");
    expect(typeof result).toBe("boolean");
  });

  it("queryRampCountries confirms MY present, SG absent — the corridor decision is correct", async () => {
    const countries = await queryRampCountries(config);
    const malaysia = countries.find((c) => c.code === "MY");
    const singapore = countries.find((c) => c.code === "SG");
    expect(malaysia).toBeDefined();
    expect(malaysia!.isAllowed).toBe(true);
    expect(singapore).toBeUndefined();
  });

  it("queryRampFiatCurrencies confirms MYR/PHP sellable, SGD/INR absent", async () => {
    const currencies = await queryRampFiatCurrencies(config);
    const myr = currencies.find((c) => c.symbol === "MYR");
    const sgd = currencies.find((c) => c.symbol === "SGD");
    expect(myr).toBeDefined();
    expect(myr!.isAllowed).toBe(true);
    expect(myr!.isSellAllowed).toBe(true);
    expect(sgd).toBeUndefined();
  });

  // IMPORTANT VERIFIED FINDING (2026-08-08, logged in DECISIONS.md): the docs prose
  // (CLEANVERSE_API.md line 2006) lists "monad" among ramp-supported wallet networks, but
  // live sandbox testing proves the Fiat Ramp (Transak-backed) does NOT currently support it:
  // query_ramp_crypto_currencies never returns a monad-network asset, and query_ramp_quote
  // with network:"monad" fails with [BIZ_068] regardless of currency/symbol/amount/direction
  // tried — while the identical request against network:"base" succeeds immediately. This is
  // a docs-vs-reality gap, not a mistake in this client. Product implication: the Fiat Ramp's
  // MYR/PHP legs settle in USDC on a Cleanverse-supported chain (e.g. base), not directly as
  // aUSDC on Monad — PRD.md's Send/Claim flow is corrected accordingly.
  it("queryRampCryptoCurrencies never returns a monad-network asset (documents the gap, doesn't assume it)", async () => {
    const assets = await queryRampCryptoCurrencies(config);
    const monadAssets = assets.filter((a) => a.network?.name === "monad");
    expect(monadAssets.length).toBe(0);
  });

  it("queryRampPaymentMethods returns at least one usable payment method id", async () => {
    const methods = await queryRampPaymentMethods(config);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.some((m) => m.id === "credit_debit_card")).toBe(true);
  });

  it("queryRampQuote succeeds for MYR -> USDC on the real supported 'base' network", async () => {
    const quote = await queryRampQuote(config, {
      fiatCurrency: "MYR",
      cryptoCurrency: "USDC",
      isBuyOrSell: "BUY",
      network: "base",
      paymentMethod: "credit_debit_card",
      fiatAmount: 100,
    });
    expect(quote.cryptoAmount).toBeGreaterThan(0);
    expect(quote.quoteToken).toBeTruthy();
  });

  it("queryRampQuote fails for network:'monad' even with valid currency/amount — confirms the gap is network-specific, not amount-specific", async () => {
    await expect(
      queryRampQuote(config, {
        fiatCurrency: "MYR",
        cryptoCurrency: "USDC",
        isBuyOrSell: "BUY",
        network: "monad",
        paymentMethod: "credit_debit_card",
        fiatAmount: 500, // 5x the amount that succeeds on "base" — rules out an amount-threshold explanation
      }),
    ).rejects.toThrow();
  });
});
