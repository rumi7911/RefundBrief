// Actual app routes and SQLite, with an in-memory PayPal transport. These
// regressions never contact a provider or send a refund, even to the sandbox.
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { resetSessions } from "./security.ts";

let built: ReturnType<typeof createApp> | undefined;
let server: any;
let dataDir: string | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  built?.db.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  resetSessions();
  server = undefined;
  built = undefined;
  dataDir = undefined;
});

async function setup(payload: unknown, state: "unknown" | "pending" = "unknown", lookupStatus = 200) {
  dataDir = mkdtempSync(join(tmpdir(), "rb-lookup-identity-"));
  let refundPosts = 0;
  let modelCalls = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api-m.sandbox.paypal.com/v1/oauth2/token") {
      return Response.json({ access_token: "FAKE", expires_in: 3000 });
    }
    if (url === "https://api-m.sandbox.paypal.com/v2/payments/refunds/EXPECTED-REFUND") {
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json(payload, { status: lookupStatus });
    }
    if (url === "https://api-m.sandbox.paypal.com/v2/payments/captures/FAKE-CAPTURE") {
      return Response.json({ id: "FAKE-CAPTURE", status: "COMPLETED", amount: { value: "180.00", currency_code: "GBP" }, payee: { merchant_id: "FAKE-MERCHANT" } });
    }
    if (url.endsWith("/refund") && init?.method === "POST") refundPosts++;
    throw new Error("Unexpected fake transport request; no real transport is available.");
  };
  built = createApp({
    config: {
      port: 4184, host: "127.0.0.1", dataDir,
      paypal: { configured: true, baseUrl: "https://api-m.sandbox.paypal.com", clientId: "FAKE", clientSecret: "FAKE", merchantId: "FAKE-MERCHANT" },
      ai: { enabled: false, reason: "Local regression only" },
    },
    dbFile: ":memory:", paypalFetch: transport,
    aiFetch: async () => { modelCalls++; throw new Error("Model transport forbidden"); },
    serveStatic: false,
  });
  built.db.prepare("UPDATE cases SET is_sample=0,capture_id='FAKE-CAPTURE',merchant_id='FAKE-MERCHANT' WHERE id='sample-deep-clean'").run();
  built.db.prepare("INSERT INTO operations(id,case_id,capture_id,approval_token,request_id,amount_pennies,currency,state,simulated,refund_id,detail,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("lookup-operation", "sample-deep-clean", "FAKE-CAPTURE", "original-approval", "original-stable-request-key", 100, "GBP", state, 0, "EXPECTED-REFUND", "Existing operation remains unresolved", 1000, 1000);
  const row = () => built!.db.prepare("SELECT * FROM operations WHERE id='lookup-operation'").get();
  const before = row();
  server = await new Promise<any>((resolve) => { const s = built!.app.listen(0, "127.0.0.1", () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = await fetch(origin + "/api/session");
  const { csrfToken } = await session.json();
  const headers = { cookie: session.headers.get("set-cookie")!.split(";")[0], "x-rb-csrf": csrfToken, "content-type": "application/json" };
  const send = (path: string, body: unknown = {}) => fetch(origin + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { send, row, before, calls: () => ({ refundPosts, modelCalls }) };
}

for (const state of ["unknown", "pending"] as const) {
  it.each([
    ["wrong", { id: "OTHER-REFUND", status: "FAILED", amount: { value: "1.00", currency_code: "GBP" } }],
    ["missing", { status: "FAILED", amount: { value: "1.00", currency_code: "GBP" } }],
  ])(`keeps an operation in ${state} unchanged and blocks another confirmation on %s lookup identity`, async (_label, payload) => {
    const c = await setup(payload, state);
    const response = await c.send("/api/operations/lookup-operation/reconcile");
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("PAYPAL_REFUND_IDENTITY");
    // Retain every original operation field, including timestamps, detail and key.
    expect(c.row()).toEqual(c.before);
    const prepared = await c.send("/api/cases/sample-deep-clean/prepare-approval", { amountRaw: "1.00", purpose: "Separate owner choice", reviewed: true });
    expect(prepared.status).toBe(200);
    const { token } = await prepared.json();
    const confirmation = await c.send(`/api/approvals/${token}/confirm`);
    expect(confirmation.status).toBe(409);
    expect((await confirmation.json()).error.code).toBe(state === "unknown" ? "OPERATION_UNKNOWN_BLOCK" : "OPERATION_IN_PROGRESS");
    expect(c.row()).toEqual(c.before);
    expect(built!.db.prepare("SELECT COUNT(*) AS n FROM operations").get()).toEqual({ n: 1 });
    expect(c.calls()).toEqual({ refundPosts: 0, modelCalls: 0 });
  });
}

it.each([
  ["COMPLETED", "completed"], ["PENDING", "pending"], ["FAILED", "refused"], ["UNRECOGNISED", "unknown"],
])("preserves existing reconciliation mapping for matching identity and status %s", async (status, expectedState) => {
  const c = await setup({ id: "EXPECTED-REFUND", status, amount: { value: "1.00", currency_code: "GBP" } });
  const response = await c.send("/api/operations/lookup-operation/reconcile");
  expect(response.status).toBe(200);
  expect((await response.json()).operation.state).toBe(expectedState);
  expect(c.row()).toMatchObject({ state: expectedState, refund_id: "EXPECTED-REFUND", request_id: "original-stable-request-key", upstream_status: status });
  expect(c.calls()).toEqual({ refundPosts: 0, modelCalls: 0 });
});

it.each([404, 500])("leaves an unknown operation unchanged on lookup HTTP %s", async (status) => {
  const c = await setup({ name: "FAKE_UPSTREAM_ERROR" }, "unknown", status);
  const response = await c.send("/api/operations/lookup-operation/reconcile");
  expect(response.status).toBe(502);
  expect(c.row()).toEqual(c.before);
  expect(c.calls()).toEqual({ refundPosts: 0, modelCalls: 0 });
});
