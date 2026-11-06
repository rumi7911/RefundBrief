// PayPal SANDBOX-ONLY adapter. OAuth client-credentials, capture lookup,
// refund creation (with a stable PayPal-Request-Id) and refund status.
//
// The HTTP boundary is injectable (`FetchLike`) so tests can supply a
// deterministic fake. Raw tokens and upstream headers are NEVER returned to
// callers or logged. If the configured merchant does not match the capture, the
// adapter refuses. Only official sandbox fields are read.

import type { PayPalConfig } from "./config.ts";
import type { CaptureDetails } from "./domain/balance.ts";

export type FetchLike = typeof fetch;

export class PayPalError extends Error {
  code: string;
  httpStatus?: number;
  /** True when the failure is a network/timeout/ambiguous condition. */
  ambiguous: boolean;
  constructor(message: string, code = "PAYPAL_ERROR", opts: { httpStatus?: number; ambiguous?: boolean } = {}) {
    super(message);
    this.name = "PayPalError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.ambiguous = opts.ambiguous ?? false;
  }
}

const DEFAULT_TIMEOUT_MS = 15000;

interface ReqOpts {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function pennies(amount: { value?: string; currency_code?: string } | undefined): number | null {
  if (!amount || typeof amount.value !== "string") return null;
  // value like "180.00" — parse without float arithmetic.
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.value);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export class PayPalClient {
  private token: { value: string; expiresAtMs: number } | null = null;
  constructor(
    private cfg: PayPalConfig,
    private fetchImpl: FetchLike = fetch,
    private timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    if (!cfg.configured) throw new PayPalError("PayPal is not configured.", "PAYPAL_NOT_CONFIGURED");
    if (!/^https:\/\/api-m\.sandbox\.paypal\.com$/.test(cfg.baseUrl)) {
      throw new PayPalError("Refusing non-sandbox PayPal base URL.", "PAYPAL_NON_SANDBOX");
    }
  }

  private async request(path: string, init: ReqOpts): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.cfg.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (e) {
      // Network error / abort — ambiguous outcome for writes.
      throw new PayPalError(
        `Network error contacting PayPal: ${(e as Error).message}`,
        "PAYPAL_NETWORK",
        { ambiguous: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs > now + 30000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.request("/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError("Failed to obtain PayPal access token.", "PAYPAL_AUTH", { httpStatus: res.status });
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new PayPalError("PayPal token response missing access_token.", "PAYPAL_AUTH");
    this.token = { value: json.access_token, expiresAtMs: now + (json.expires_in ?? 3000) * 1000 };
    return this.token.value;
  }

  private async authed(path: string, init: ReqOpts = {}, beforeSend?: () => void): Promise<Response> {
    const token = await this.accessToken();
    // Recheck owner approval after token acquisition, immediately before dispatch.
    // A local refusal here is not an ambiguous network failure.
    beforeSend?.();
    return this.request(path, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  }

  /** GET /v2/payments/captures/{id}. Verifies merchant ownership. */
  async getCapture(captureId: string): Promise<CaptureDetails> {
    const res = await this.authed(`/v2/payments/captures/${encodeURIComponent(captureId)}`);
    if (res.status === 404) throw new PayPalError("Capture not found.", "PAYPAL_CAPTURE_NOT_FOUND", { httpStatus: 404 });
    if (!res.ok) throw new PayPalError("Failed to read capture.", "PAYPAL_CAPTURE_READ", { httpStatus: res.status });
    const json = (await res.json()) as any;

    const amountPennies = pennies(json?.amount);
    const currency = json?.amount?.currency_code;
    if (amountPennies === null || currency !== "GBP") {
      throw new PayPalError("Capture amount/currency could not be established.", "PAYPAL_CAPTURE_SHAPE");
    }
    let merchantId: string | undefined = json?.payee?.merchant_id;
    if (!merchantId) {
      const orderId = json?.supplementary_data?.related_ids?.order_id;
      if (typeof orderId === "string" && orderId) {
        const orderRes = await this.authed(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
        if (orderRes.ok) {
          const order = await orderRes.json() as any;
          const unit = order?.purchase_units?.find((u: any) =>
            u?.payments?.captures?.some((c: any) => c.id === captureId));
          merchantId = unit?.payee?.merchant_id;
        }
      }
    }
    if (!merchantId) throw new PayPalError("Merchant ownership could not be established from the capture/order.", "PAYPAL_MERCHANT_UNKNOWN");
    if (merchantId !== this.cfg.merchantId) {
      throw new PayPalError("Capture is not owned by the configured merchant.", "PAYPAL_MERCHANT_MISMATCH");
    }
    return {
      captureId: String(json?.id ?? captureId),
      merchantId,
      currency: "GBP",
      amountPennies,
      status: String(json?.status ?? "UNKNOWN"),
    };
  }

  /**
   * POST /v2/payments/captures/{id}/refund with a caller-provided stable
   * PayPal-Request-Id. Returns the refund id and upstream status string.
   */
  async refundCapture(args: {
    captureId: string;
    requestId: string;
    amountValue: string; // "60.00"
    invoiceNote?: string;
    beforeSend?: () => void;
  }): Promise<{ id: string; status: string }> {
    const res = await this.authed(`/v2/payments/captures/${encodeURIComponent(args.captureId)}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PayPal-Request-Id": args.requestId, Prefer: "return=representation" },
      body: JSON.stringify({
        amount: { value: args.amountValue, currency_code: "GBP" },
        note_to_payer: args.invoiceNote?.slice(0, 255),
      }),
    }, args.beforeSend);
    if (res.status === 409 || res.status === 422) {
      throw new PayPalError("PayPal refused the refund.", "PAYPAL_REFUND_REFUSED", { httpStatus: res.status });
    }
    if (res.status >= 500) {
      throw new PayPalError("PayPal server error during refund.", "PAYPAL_REFUND_SERVER", { httpStatus: res.status, ambiguous: true });
    }
    if (!res.ok) throw new PayPalError("Refund request failed.", "PAYPAL_REFUND_FAILED", { httpStatus: res.status });
    const json = (await res.json()) as { id?: string; status?: string };
    if (!json.id) throw new PayPalError("Refund response missing id.", "PAYPAL_REFUND_SHAPE", { ambiguous: true });
    return { id: json.id, status: String(json.status ?? "UNKNOWN") };
  }

  /** GET /v2/payments/refunds/{id}. */
  async getRefund(refundId: string): Promise<{ id: string; status: string; amountPennies: number | null }> {
    const res = await this.authed(`/v2/payments/refunds/${encodeURIComponent(refundId)}`);
    if (res.status === 404) throw new PayPalError("Refund not found.", "PAYPAL_REFUND_NOT_FOUND", { httpStatus: 404 });
    if (!res.ok) throw new PayPalError("Failed to read refund.", "PAYPAL_REFUND_READ", { httpStatus: res.status });
    const json = (await res.json()) as any;
    return { id: String(json?.id ?? refundId), status: String(json?.status ?? "UNKNOWN"), amountPennies: pennies(json?.amount) };
  }
}
