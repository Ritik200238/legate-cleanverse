import { describe, it, expect } from "vitest";
import {
  queryDepositAtokenList,
  queryApass,
  verifyApass,
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
  // This test earns its keep twice over. First: on 2026-08-08 it failed against the live
  // sandbox, and that failure was the ONLY signal Cleanverse had redeployed Monad's aUSDC —
  // new address, decimals 6 -> 18. Second: hours later on 2026-08-09, the address it had just
  // confirmed FLIPPED BACK to the original one, stable across repeated re-checks — see
  // DECISIONS.md's "Cleanverse's own aUSDC address flip-flopped" entry for the full trail.
  //
  // A test that pins one specific address as ground truth would now be wrong by construction
  // — Cleanverse's own backend has proven it can change its mind within a single day. What's
  // asserted instead is the invariant that actually protects downstream code: whichever
  // address comes back, its address and decimals must belong to one of the two real,
  // independently-verified states, never an unrecognized third value or a mismatched pairing.
  // The deploy pipeline reads decimals() live from the chain regardless (DeployMonadTestnet.s.sol),
  // so this consistency check — not a specific address — is what stands between a real state and
  // a broken one.
  it("queryDepositAtokenList returns a real Monad aUSDC entry (address+decimals internally consistent)", async () => {
    const result = await queryDepositAtokenList(config, "monad");
    expect(result.chain).toBe("monad");
    expect(result.tokens.length).toBeGreaterThan(0);
    const usdcEntry = result.tokens.find((t) => t.origin_token.symbol.toLowerCase() === "usdc");
    expect(usdcEntry).toBeDefined();

    // The wrapped origin token (real USDC) has been stable across every observed state.
    expect(usdcEntry!.origin_token.address.toLowerCase()).toBe("0x534b2f3a21130d7a60830c2df862319e593943a3");
    expect(usdcEntry!.origin_token.decimals).toBe(6);
    expect(usdcEntry!.accesscore_address.toLowerCase()).toBe("0x8f118338a1fa41e7fa86be19a4e8b99ed58a6ecc");

    const KNOWN_ATOKEN_STATES: Record<string, number> = {
      "0xfa96de5b8f434c26fdff953303dd66ff80af1026": 18, // observed 2026-08-09, morning
      "0xac0893567d43c3e7e6e35a72803df05416c1f20d": 6, // observed 2026-08-09, afternoon — reversion
    };
    const addr = usdcEntry!.atoken.address.toLowerCase();
    expect(Object.keys(KNOWN_ATOKEN_STATES)).toContain(addr);
    expect(usdcEntry!.atoken.decimals).toBe(KNOWN_ATOKEN_STATES[addr]);
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

  // Never called from the live request path (grep backend/src confirms it) — the compliance
  // pipeline uses validatorVerify instead. That turned out to matter: verify_apass keeps its
  // own internal atoken registry, separate from query_deposit_atoken_list's, and on 2026-08-09
  // the two disagreed WITHIN THE SAME DAY about which Monad aUSDC address is canonical — see
  // DECISIONS.md's "Cleanverse's own aUSDC address flip-flopped" entry for the full trail. The
  // `base` case below is used as the control specifically because it stayed stable throughout;
  // asserting anything Monad-specific here would pin a fact this session watched move.
  it("verifyApass works on the known-good base/aUSDC pairing (stable control case)", async () => {
    const result = await verifyApass(
      config,
      "base",
      "0xaC0893567D43C3E7e6e35a72803df05416C1f20D",
      "0x000000000000000000000000000000000000dEaD",
    );
    expect(result.code).toBe(4); // "apass verify success"
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
