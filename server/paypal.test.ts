// PayPal adapter unit tests with a DETERMINISTIC HTTP fake. These demonstrate
// adapter behaviour only — they are NOT a test against actual PayPal.

import { describe, it, expect } from "vitest";
import { PayPalClient, PayPalError } from "./paypal.ts";
import type { PayPalConfig } from "./config.ts";

const cfg: PayPalConfig = {
  configured: true,
  clientId: "id",
  clientSecret: "sec",
  merchantId: "MERCH-X",
  baseUrl: "https://api-m.sandbox.paypal.com",
};

function fake(handler: (url: string, init?: RequestInit) => Response) {
  return (async (url: string | URL, init?: RequestInit) => handler(String(url), init)) as unknown as typeof fetch;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("PayPalClient", () => {
  it("refuses a non-sandbox base URL", () => {
    expect(() => new PayPalClient({ ...cfg, baseUrl: "https://api-m.paypal.com" })).toThrow(PayPalError);
  });

  it("reads a capture and enforces merchant ownership", async () => {
    const client = new PayPalClient(cfg, fake((u) => {
      if (u.endsWith("/oauth2/token")) return json({ access_token: "T", expires_in: 3000 });
      return json({ id: "CAP", status: "COMPLETED", amount: { value: "180.00", currency_code: "GBP" }, payee: { merchant_id: "SOMEONE-ELSE" } });
    }));
    await expect(client.getCapture("CAP")).rejects.toMatchObject({ code: "PAYPAL_MERCHANT_MISMATCH" });
  });

  it("sends a refund with the provided PayPal-Request-Id", async () => {
    let seenId = "";
    const client = new PayPalClient(cfg, fake((u, init) => {
      if (u.endsWith("/oauth2/token")) return json({ access_token: "T", expires_in: 3000 });
      seenId = (init?.headers as Record<string, string>)["PayPal-Request-Id"];
      return json({ id: "RF-9", status: "COMPLETED" });
    }));
    const r = await client.refundCapture({ captureId: "CAP", requestId: "rb-abc", amountValue: "60.00" });
    expect(seenId).toBe("rb-abc");
    expect(r).toEqual({ id: "RF-9", status: "COMPLETED" });
  });

  it("flags network errors as ambiguous", async () => {
    const client = new PayPalClient(cfg, fake((u) => {
      if (u.endsWith("/oauth2/token")) return json({ access_token: "T", expires_in: 3000 });
      throw new Error("ECONNRESET");
    }));
    await expect(client.refundCapture({ captureId: "CAP", requestId: "x", amountValue: "1.00" })).rejects.toMatchObject({ ambiguous: true });
  });

  it.each([
    ["missing", undefined], ["null", null], ["empty", ""], ["number", 42],
    ["object", {}], ["array", []], ["mismatched", "OTHER-REFUND"],
  ])(
    "rejects %s refund lookup identity without substituting or coercing it",
    async (_label, responseId) => {
      const client = new PayPalClient(cfg, fake((url) => {
        if (url.endsWith("/oauth2/token")) return json({ access_token: "T", expires_in: 3000 });
        expect(url).toBe("https://api-m.sandbox.paypal.com/v2/payments/refunds/EXPECTED-REFUND");
        return json({ id: responseId, status: "FAILED", amount: { value: "1.00", currency_code: "GBP" } });
      }));
      await expect(client.getRefund("EXPECTED-REFUND")).rejects.toMatchObject({ code: "PAYPAL_REFUND_IDENTITY" });
    },
  );

  it("returns matching refund identity and status without changing their meaning", async () => {
    const client = new PayPalClient(cfg, fake((url) => {
      if (url.endsWith("/oauth2/token")) return json({ access_token: "T", expires_in: 3000 });
      return json({ id: "EXPECTED-REFUND", status: "PENDING", amount: { value: "1.00", currency_code: "GBP" } });
    }));
    await expect(client.getRefund("EXPECTED-REFUND")).resolves.toEqual({ id: "EXPECTED-REFUND", status: "PENDING", amountPennies: 100 });
  });
});
