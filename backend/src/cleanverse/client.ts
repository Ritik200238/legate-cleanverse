import { encryptCleanverseBody } from "./crypto.js";
import { randomUUID } from "node:crypto";

/**
 * Real Cleanverse API client — scoped to exactly the endpoints Legate's four demo scenes
 * touch (PRD.md §5.2), not a padded wrapper over all ~40 endpoints. Every function here
 * makes a real HTTP call to the sandbox; nothing is mocked. Sandbox base URL and field
 * shapes are taken from CLEANVERSE_API.md and cross-checked against live curl calls made
 * during this project's recon (see DECISIONS.md).
 */

export interface CleanverseConfig {
  /** e.g. "https://uatapi.cleanverse.com/api/cooperate" for sandbox */
  baseUrl: string;
  apiId: string;
  /** Base64-encoded api-key. Required only for encrypted-body endpoints. NEVER sent over the wire. */
  apiKeyBase64?: string;
}

export class CleanverseApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly code: string,
    message: string,
    public readonly raw: unknown,
  ) {
    super(`Cleanverse ${endpoint} failed [${code}]: ${message}`);
    this.name = "CleanverseApiError";
  }
}

interface CleanverseEnvelope<T> {
  code: string;
  message: string;
  data: T;
}

async function callPlain<T>(config: CleanverseConfig, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-id": config.apiId,
      "X-Request-ID": randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as CleanverseEnvelope<T>;
  if (json.code !== "0000") {
    throw new CleanverseApiError(path, json.code, json.message, json);
  }
  return json.data;
}

async function callEncrypted<T>(config: CleanverseConfig, path: string, plaintextBody: unknown): Promise<T> {
  if (!config.apiKeyBase64) {
    throw new Error(`${path} requires an encrypted body — apiKeyBase64 not configured`);
  }
  const encrypted = encryptCleanverseBody(plaintextBody, config.apiKeyBase64);
  return callPlain<T>(config, path, encrypted);
}

// --- Common Queries ---

export interface QueryApassResult {
  cvRecordId: string;
  subTier: number;
  tier: string;
  status: 1 | 2; // 1 = active, 2 = frozen
  expirationTime: number;
  subGroup: string;
  currentKycHash: string;
  group: string;
  countries: string[];
}

/** Real-time A-Pass status for a wallet. Returns null (not throw) on the documented
 * "not found" business failure (code 0002) so callers can treat "unregistered wallet" as a
 * normal, expected outcome (this is exactly Demo Scene 2's pre-flight check). */
export async function queryApass(config: CleanverseConfig, chain: string, address: string): Promise<QueryApassResult | null> {
  try {
    return await callPlain<QueryApassResult>(config, "/query_apass", { chain, address });
  } catch (err) {
    if (err instanceof CleanverseApiError && err.code === "0002") return null;
    throw err;
  }
}

export interface VerifyApassResult {
  chain: string;
  atoken: string;
  address: string;
  code: 1 | 2 | 3 | 4; // 1=AToken not found, 2=no APass, 3=expired/frozen, 4=success
  message: string;
  magickLink?: string;
}

export async function verifyApass(config: CleanverseConfig, chain: string, atoken: string, address: string): Promise<VerifyApassResult> {
  return callPlain<VerifyApassResult>(config, "/verify_apass", { chain, atoken, address });
}

export interface DepositAtokenListResult {
  chain: string;
  tokens: Array<{
    origin_token: { address: string; name: string; symbol: string; decimals: number; icon: string };
    atoken: { address: string; name: string; symbol: string; decimals: number; icon: string };
    accesscore_address: string;
    apass_address: string;
  }>;
}

export async function queryDepositAtokenList(config: CleanverseConfig, chain: string): Promise<DepositAtokenListResult> {
  return callPlain<DepositAtokenListResult>(config, "/query_deposit_atoken_list", { chain });
}

export interface TravelRuleReport {
  downloadUrl: string;
  fileName: string;
}

/** Report type is implicit in which txHash you pass: a withdraw tx's hash → Travel Rule
 * Report; a transfer tx's hash → Transaction Report. Not a separate parameter — per the doc. */
export async function downloadTravelRule(
  config: CleanverseConfig,
  args: { txHash: string; chain: string; address: string; customerId?: string; cvRecordId?: string },
): Promise<TravelRuleReport> {
  return callPlain<TravelRuleReport>(config, "/download_travel_rule", {
    txHash: args.txHash,
    wallet: { chain: args.chain, address: args.address },
    customerId: args.customerId,
    cvRecordId: args.cvRecordId,
  });
}

// --- Validator Compliance ---

export interface ValidatorVerifyResult {
  chain: string;
  contract_address: string;
  user_address: string;
  valid: boolean;
}

/** REST mirror of the on-chain complianceVerify() call — used by the backend for a
 * gas-free preview; the contracts re-check this on-chain independently at settlement. */
export async function validatorVerify(config: CleanverseConfig, chain: string, contractAddress: string, userAddress: string): Promise<ValidatorVerifyResult> {
  return callPlain<ValidatorVerifyResult>(config, "/validator/verify", {
    chain,
    contract_address: contractAddress,
    user_address: userAddress,
  });
}

export async function validatorIsPaused(config: CleanverseConfig, chain: string, contractAddress: string): Promise<boolean> {
  const result = await callPlain<{ chain: string; contract_address: string; paused: boolean }>(config, "/validator/is_paused", {
    chain,
    contract_address: contractAddress,
  });
  return result.paused;
}

export interface ComplianceRule {
  allowed_group: string;
  allowed_sub_group: string;
  min_tier: number;
  min_sub_tier: number;
  is_black_list: boolean;
  countries: string[];
}

/** One-time setup call: grants REGISTER_ROLE-equivalent permission to `address`.
 * `ownerSignature` is an EIP-191 personal_sign over lowercase `chain+address` (no separator),
 * signed by the owner of `address` — for an EOA, the EOA signs for itself. */
export async function validatorGrant(config: CleanverseConfig, chain: string, address: string, ownerSignature: string): Promise<{ chain: string; address: string; tx_hash: string }> {
  return callEncrypted(config, "/validator/grant", { chain, address, owner_signature: ownerSignature });
}

/** One-time setup call: registers `contractAddress` as a compliance pool with its initial
 * rule. `ownerSignature` is over lowercase `chain+contract_address`. */
export async function validatorRegister(
  config: CleanverseConfig,
  chain: string,
  contractAddress: string,
  rule: ComplianceRule,
  ownerSignature: string,
): Promise<{ chain: string; contract_address: string; tx_hash: string }> {
  return callEncrypted(config, "/validator/register", {
    chain,
    contract_address: contractAddress,
    rule,
    owner_signature: ownerSignature,
  });
}

// --- Fiat Ramp ---

export interface RampCountry {
  name: string;
  code: string;
  currencyCode: string;
  isAllowed: boolean;
}

export async function queryRampCountries(config: CleanverseConfig): Promise<RampCountry[]> {
  return callPlain<RampCountry[]>(config, "/query_ramp_countries", {});
}

export interface RampFiatCurrency {
  symbol: string;
  name: string;
  isAllowed: boolean;
  isSellAllowed: boolean;
}

export async function queryRampFiatCurrencies(config: CleanverseConfig): Promise<RampFiatCurrency[]> {
  return callPlain<RampFiatCurrency[]>(config, "/query_ramp_fiat_currencies", {});
}

export interface RampCryptoCurrency {
  symbol: string;
  name: string;
  uniqueId: string;
  isAllowed: boolean;
  isSellAllowed: boolean;
  /** Live-verified (2026-08-08) shape: only { name: string } — no "slug" field despite the
   *  prose docs implying one. See DECISIONS.md for the full Monad-ramp-support finding. */
  network: { name: string };
}

export async function queryRampCryptoCurrencies(config: CleanverseConfig): Promise<RampCryptoCurrency[]> {
  return callPlain<RampCryptoCurrency[]>(config, "/query_ramp_crypto_currencies", {});
}

export interface RampPaymentMethod {
  id: string;
  label: string;
}

export async function queryRampPaymentMethods(config: CleanverseConfig): Promise<RampPaymentMethod[]> {
  return callPlain<RampPaymentMethod[]>(config, "/query_ramp_payment_methods", {});
}

export interface RampQuote {
  quoteToken: string;
  quoteId: string;
  fiatCurrency: string;
  cryptoCurrency: string;
  network: string;
  paymentMethod: string;
  fiatAmount?: number;
  cryptoAmount?: number;
  totalFee: number;
  conversionPrice: number;
}

export async function queryRampQuote(
  config: CleanverseConfig,
  args: {
    fiatCurrency: string;
    cryptoCurrency: string;
    isBuyOrSell: "BUY" | "SELL";
    network: string;
    paymentMethod: string;
    fiatAmount?: number;
    cryptoAmount?: number;
  },
): Promise<RampQuote> {
  return callPlain<RampQuote>(config, "/query_ramp_quote", args);
}

export interface RampWidgetResult {
  orderId: string;
  widgetUrl: string;
}

export async function createRampWidgetUrl(
  config: CleanverseConfig,
  args: { quoteToken: string; walletAddress: string; walletChain: string; email?: string },
): Promise<{ orderId: string; widgetUrl: string }> {
  return callPlain(config, "/create_ramp_widget_url", {
    quoteToken: args.quoteToken,
    wallet: { address: args.walletAddress, chain: args.walletChain },
    email: args.email,
  });
}

// --- A-Pass Management (used for test-wallet setup, not per-payment) ---

export async function generateApass(
  config: CleanverseConfig,
  args: {
    customerId: string;
    walletAddress: string;
    walletChain: string;
    expirationTime: number;
    subTier?: number;
    subGroup?: string;
    identityDataList?: Array<{ idType: string; fullName: string; issuingCountryISO2: string }>;
  },
): Promise<{ customerId: string; cvRecordId: string; tier: string }> {
  return callEncrypted(config, "/generate_apass", {
    customerId: args.customerId,
    wallet: { address: args.walletAddress, chain: args.walletChain },
    expirationTime: args.expirationTime,
    subTier: args.subTier,
    subGroup: args.subGroup,
    identityDataList: args.identityDataList,
  });
}

/** Freezes (status "2") or reactivates (status "1") a wallet's real A-Pass. Used by
 *  test/e2e-poller-local.sh to genuinely exercise the revocation poller end-to-end — not a
 *  per-payment call. See DECISIONS.md for why this needed a real, callable endpoint rather
 *  than a simulated status flip. */
export async function updateStatus(
  config: CleanverseConfig,
  args: { walletChain: string; walletAddress: string; status: "1" | "2"; customerId?: string; cvRecordId?: string; blacklistReason?: string },
): Promise<void> {
  await callEncrypted(config, "/update_status", {
    customerId: args.customerId,
    cvRecordId: args.cvRecordId,
    status: args.status,
    blacklistReason: args.blacklistReason,
    wallet: { chain: args.walletChain, address: args.walletAddress },
  });
}

export async function faucet(
  config: CleanverseConfig,
  args: { chain: string; symbol: string; depositAddress: string; amount: string },
): Promise<{ chain: string; symbol: string; deposit_address: string; amount: string; tx_hash: string }> {
  return callPlain(config, "/faucet", args);
}
