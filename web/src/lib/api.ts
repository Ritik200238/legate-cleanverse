import { API_BASE_URL } from "./contracts";

/** Thin typed fetch wrapper over the backend's read-oriented /api/* routes
 *  (backend/src/routes/api.ts) — real HTTP calls, no mocking.
 *
 *  Base URL resolution differs by execution context: in the browser, relative paths (e.g. "")
 *  resolve against the page's own origin and are proxied server-side to the backend via
 *  next.config.ts rewrites (needed when the frontend is reached through a tunnel that can't
 *  reach the backend directly). A Node.js server-side fetch (the /receipt/[paymentId] Server
 *  Component) has no implicit origin, so a relative URL there throws — it must call the
 *  backend directly. */
function resolveBase(): string {
  if (typeof window !== "undefined") return API_BASE_URL;
  return process.env.LEGATE_BACKEND_URL ?? "http://127.0.0.1:4021";
}

export interface RecipientResult {
  address: string;
  hasApass: boolean;
  tier?: string;
  group?: string;
  status?: "active" | "frozen";
  canReceive: boolean | null;
  note?: string;
}

export interface CompliancePreview {
  allowed: boolean;
  reason?: string;
  senderStatus?: { tier: string; group: string; status: 1 | 2 };
  recipientStatus?: { tier: string; group: string; status: 1 | 2 };
  /** Present when an operator rule module vetoed: which module, and its own reason code. */
  rejectedBy?: { rule: string; code: string };
}

export interface QuoteResult {
  sender: string;
  recipient: string;
  amountBaseUnits: string;
  feeBps: string;
  feeBaseUnits: string;
  netToRecipientBaseUnits: string;
  compliancePreview: CompliancePreview;
}

export interface PaymentResult {
  paymentId: string;
  sender: string;
  recipient: string;
  amountBaseUnits: string;
  state: "None" | "Escrowed" | "Settled" | "Frozen" | "Refunded";
  createdAt: number;
  settledAt: number | null;
  /** Unix seconds after which the sender may reclaim an unclaimed payment themselves. */
  claimDeadline: number | null;
  settlementTxHash: string | null;
  travelRuleAnchor: { reportHash: string; settlementTxHash: string; anchoredAt: number } | null;
}

export interface MandateResult {
  agentAddress: string;
  principal: string;
  perTxCap: string;
  dailyCap: string;
  totalCap: string;
  spentToday: string;
  spentTotal: string;
  dailyRemaining: string;
  totalRemaining: string;
  expiry: number;
  active: boolean;
}

export interface RampQuoteResult {
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

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${resolveBase()}${path}`);
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed with ${res.status}`);
  return json as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${resolveBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed with ${res.status}`);
  return json as T;
}

export const api = {
  getRecipient: (address: string) => get<RecipientResult>(`/api/recipient/${address}`),
  getQuote: (sender: string, recipient: string, amountBaseUnits: string) =>
    get<QuoteResult>(`/api/quote?sender=${sender}&recipient=${recipient}&amount=${amountBaseUnits}`),
  getPayment: (paymentId: string) => get<PaymentResult | null>(`/api/payment/${paymentId}`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }),
  getMandate: (agentAddress: string) => get<MandateResult>(`/api/mandate/${agentAddress}`),
  getRampPaymentMethods: () => get<{ methods: Array<{ id: string; label: string }> }>("/api/ramp/payment-methods"),
  getRampQuote: (body: {
    fiatCurrency: string;
    cryptoCurrency: string;
    isBuyOrSell: "BUY" | "SELL";
    paymentMethod: string;
    fiatAmount?: number;
    cryptoAmount?: number;
  }) => post<RampQuoteResult>("/api/ramp/quote", body),
  createRampWidget: (body: { quoteToken: string; walletAddress: string; walletChain: string; email?: string }) =>
    post<{ orderId: string; widgetUrl: string }>("/api/ramp/widget", body),
  anchorTravelRule: (paymentId: string) => post<{ paymentId: string; anchorTxHash: string }>(`/api/payment/${paymentId}/anchor-travel-rule`, {}),
};

export { ApiError };
