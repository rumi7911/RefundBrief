// Integration tests against the REAL app + REAL SQLite database, with a
// DETERMINISTIC FAKE of the PayPal HTTP boundary. These demonstrate app
// behaviour only — they are NOT a test against actual PayPal.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";
import type { AppConfig } from "./config.ts";
import { resetSessions } from "./security.ts";

describe("owner outcomes without payment", () => {
  let outcomeConfig: AppConfig;
  let captureGate: Promise<void> | null;
  let onCapture: () => void;
  beforeEach(() => {
    outcomeConfig = baseConfig(); captureGate = null; onCapture = () => {};
    const fake = makePayPalFake();
    const fetchFake: typeof fetch = async (url, init) => {
      if (captureGate && /\/v2\/payments\/captures\/[^/]+$/.test(String(url))) { onCapture(); await captureGate; }
      return fake.fetchFake(url, init);
    };
    return boot(outcomeConfig, { ...fake, fetchFake });
  });
  const caseId = "sample-deep-clean";
  const path = `/api/cases/${caseId}/decision`;
  const decision = (outcome = "clarification_needed") => ({ outcome, reason: "Please confirm the cancellation receipt time.", reviewed: true, caseRevision: 1, briefVersion: 1 });

  it("saves a reviewed clarification locally and includes it in both exports", async () => {
    const c = await client();
    const res = await c.send(path, "POST", decision());
    expect(res.status).toBe(201);
    const detail = await (await fetch(`${origin}/api/cases/${caseId}`)).json();
    expect(detail.decision).toMatchObject({ outcome: "clarification_needed", reason: decision().reason, stale: false, superseded: false });
    expect(detail.operations).toHaveLength(0);
    const exported = await (await fetch(`${origin}/api/cases/${caseId}/export`)).json();
    expect(exported.decisions).toHaveLength(1);
    expect(exported.auditHistory.some((a: any) => a.event === "owner_decision_recorded")).toBe(true);
    expect(await (await fetch(`${origin}/api/cases/${caseId}/export?format=text`)).text()).toContain("clarification_needed");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const persisted = new DatabaseSync(join(dir, "t.sqlite"));
    expect((persisted.prepare("SELECT outcome FROM case_decisions WHERE case_id = ?").get(caseId) as any).outcome).toBe("clarification_needed");
    persisted.close();
  });

  it("records no refund without treating the note as a payment operation", async () => {
    const c = await client();
    expect((await c.send(path, "POST", decision("no_refund"))).status).toBe(201);
    const detail = await (await fetch(`${origin}/api/cases/${caseId}`)).json();
    expect(detail.decision.outcome).toBe("no_refund");
    expect(detail.operations).toHaveLength(0);
  });

  it("permits an owner clarification record for an incomplete case without a brief", async () => {
    const c = await client();
    expect((await c.send("/api/cases/sample-missed-appointment/decision", "POST", { ...decision(), briefVersion: 0 })).status).toBe(201);
  });

  it("a delayed refund preparation cannot supersede a newer owner outcome", async () => {
    outcomeConfig.paypal = { configured: true, baseUrl: "https://api-m.sandbox.paypal.com", clientId: "FAKE-ID", clientSecret: "FAKE-SECRET", merchantId: "MERCH-X" };
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(join(dir, "t.sqlite"));
    db.prepare("UPDATE cases SET is_sample=0,merchant_id='MERCH-X',capture_id='CAP-X' WHERE id=?").run(caseId);
    db.close();
    let release!: () => void;
    captureGate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { onCapture = resolve; });
    const c = await client();
    const pending = c.send(`/api/cases/${caseId}/prepare-approval`, "POST", { amountRaw: "17.00", purpose: "Earlier choice", reviewed: true });
    await started;
    expect((await c.send(path, "POST", decision("no_refund"))).status).toBe(201);
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("APPROVAL_DECISION_CHANGED");
    const detail = await (await fetch(`${origin}/api/cases/${caseId}`)).json();
    expect(detail.decision.superseded).toBe(false);
    expect(detail.approval).toBeNull();
  });

  it("verified capture amount does not turn a legacy case-creation timestamp into payment evidence", async () => {
    outcomeConfig.paypal = { configured: true, baseUrl: "https://api-m.sandbox.paypal.com", clientId: "FAKE-ID", clientSecret: "FAKE-SECRET", merchantId: "MERCH-X" };
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(join(dir, "t.sqlite"));
    db.prepare("UPDATE cases SET is_sample=0,merchant_id='MERCH-X',capture_id='CAP-X',capture_status='UNVERIFIED',paid_pennies=NULL,capture_amount_pennies=0,paid_at='2026-11-02T10:00:00Z' WHERE id=?").run(caseId);
    db.close();
    const c = await client();
    expect((await c.send(`/api/cases/${caseId}/prepare-approval`, "POST", { amountRaw: "17.00", purpose: "Reviewed", reviewed: true })).status).toBe(200);
    const detail = await (await c.get(`/api/cases/${caseId}`)).json();
    expect(detail.amountFormatted).toBe("180.00");
    expect(detail.paidAt).toBeNull();
  });

  it.each([
    [{ outcome: "refund" }, 400], [{ outcome: "DENY_AUTOMATICALLY" }, 400],
    [{ reason: " " }, 400], [{ reason: "x".repeat(1001) }, 400],
    [{ reviewed: false }, 400], [{ caseRevision: 0 }, 409], [{ briefVersion: 0 }, 409],
  ])("rejects invalid or stale outcome input %j", async (patch, status) => {
    const c = await client();
    expect((await c.send(path, "POST", { ...decision(), ...patch })).status).toBe(status);
  });

  it("invalidates an earlier refund token when the owner records no refund", async () => {
    const c = await client();
    const approval = await (await c.send(`/api/cases/${caseId}/prepare-approval`, "POST", { amountRaw: "17.00", purpose: "Old review", reviewed: true })).json();
    expect((await c.send(path, "POST", decision("no_refund"))).status).toBe(201);
    const result = await c.send(`/api/approvals/${approval.token}/confirm`, "POST", {});
    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("APPROVAL_INVALIDATED");
  });

  it("marks a note stale after evidence edits and superseded by a later refund review", async () => {
    const c = await client();
    await c.send(path, "POST", decision());
    await c.send(`/api/cases/${caseId}/prepare-approval`, "POST", { amountRaw: "17.00", purpose: "Explicit new choice", reviewed: true });
    let detail = await (await fetch(`${origin}/api/cases/${caseId}`)).json();
    expect(detail.decision.superseded).toBe(true);
    await c.send(`/api/sources/deepclean-work`, "PUT", { text: "New evidence" });
    detail = await (await fetch(`${origin}/api/cases/${caseId}`)).json();
    expect(detail.decision.stale).toBe(true);
  });

  it.each(["completed", "preparing", "pending", "unknown"])("blocks a contradictory outcome while a refund is %s", async state => {
    const c = await client();
    const approval = await (await c.send(`/api/cases/${caseId}/prepare-approval`, "POST", { amountRaw: "17.00", purpose: "Reviewed refund", reviewed: true })).json();
    const result = await (await c.send(`/api/approvals/${approval.token}/confirm`, "POST", {})).json();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(join(dir, "t.sqlite"));
    db.prepare("UPDATE operations SET state=? WHERE id=?").run(state, result.operation.id);
    db.close();
    expect((await c.send(path, "POST", decision("no_refund"))).status).toBe(409);
  });
});

// --- deterministic PayPal fake -------------------------------------------
interface FakeOpts {
  captureAmount?: string;
  captureStatus?: string;
  merchantId?: string;
  refundStatus?: string;
  refundNetworkError?: boolean;
  refundHttp?: number;
}
function makePayPalFake(o: FakeOpts = {}) {
  const refundCalls: { requestId: string; body: any }[] = [];
  const fetchFake = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/v1/oauth2/token")) return json({ access_token: "FAKE-TOKEN", expires_in: 3000 });
    if (/\/v2\/payments\/captures\/[^/]+$/.test(u)) {
      return json({
        id: u.split("/").pop(),
        status: o.captureStatus ?? "COMPLETED",
        amount: { value: o.captureAmount ?? "180.00", currency_code: "GBP" },
        payee: { merchant_id: o.merchantId ?? "MERCH-X" },
      });
    }
    if (/\/refund$/.test(u)) {
      const requestId = (init?.headers as Record<string, string>)?.["PayPal-Request-Id"] ?? "";
      refundCalls.push({ requestId, body: JSON.parse(String(init?.body ?? "{}")) });
      if (o.refundNetworkError) throw new Error("ECONNRESET");
      if (o.refundHttp) return json({ error: "x" }, o.refundHttp);
      return json({ id: "RF-1", status: o.refundStatus ?? "COMPLETED" });
    }
    if (/\/v2\/payments\/refunds\/[^/]+$/.test(u)) {
      return json({ id: u.split("/").pop(), status: o.refundStatus ?? "COMPLETED", amount: { value: "60.00", currency_code: "GBP" } });
    }
    return json({ error: "unexpected" }, 500);
  }) as unknown as typeof fetch;
  return { fetchFake, refundCalls };
}

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 4100,
    host: "127.0.0.1",
    dataDir: tmpdir(),
    paypal: { configured: false, baseUrl: "https://api-m.sandbox.paypal.com" },
    ai: { enabled: false, reason: "test" },
    ...over,
  };
}

// --- test harness ---------------------------------------------------------
let srv: ReturnType<typeof import("http").createServer> | any;
let origin = "";
let dir = "";

async function boot(config: AppConfig, fake?: ReturnType<typeof makePayPalFake>) {
  resetSessions();
  dir = mkdtempSync(join(tmpdir(), "rb-test-"));
  const { app } = createApp({ config, dbFile: join(dir, "t.sqlite"), paypalFetch: fake?.fetchFake, serveStatic: false });
  await new Promise<void>((r) => {
    srv = app.listen(0, "127.0.0.1", () => r());
  });
  const addr = srv.address() as AddressInfo;
  origin = `http://127.0.0.1:${addr.port}`;
}

afterEach(() => {
  if (srv) srv.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Session + CSRF aware client.
async function client() {
  const s = await fetch(`${origin}/api/session`);
  const cookie = s.headers.get("set-cookie")!.split(";")[0];
  const { csrfToken } = await s.json();
  return {
    get: (p: string) => fetch(`${origin}${p}`, { headers: { cookie } }),
    send: (p: string, method: string, body?: unknown) =>
      fetch(`${origin}${p}`, {
        method,
        headers: { cookie, "x-rb-csrf": csrfToken, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

describe("security", () => {
  beforeEach(() => boot(baseConfig()));

  it("does not present an unverified capture as a zero payment or a payment date", async () => {
    const c = await client();
    const created = await (await c.send("/api/cases", "POST", { title: "Unverified capture", captureId: "CAP-UNVERIFIED" })).json();
    expect(created.amountFormatted).toBeNull();
    const detail = await (await c.get(`/api/cases/${created.id}`)).json();
    expect(detail.captureStatus).toBe("UNVERIFIED");
    expect(detail.amountFormatted).toBeNull();
    expect(detail.paidAt).toBeNull();
    const text = await (await c.get(`/api/cases/${created.id}/export?format=text`)).text();
    expect(text).toContain("Payment amount: unverified");
    expect(text).not.toContain("Amount paid: £0.00");
  });

  it("rejects mutations without a CSRF token", async () => {
    const res = await fetch(`${origin}/api/cases`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error.code).toBe("CSRF_INVALID");
  });

  it("rejects a non-loopback Host header", async () => {
    // fetch/undici forbids overriding Host, so use a raw socket request.
    const http = await import("node:http");
    const port = (srv.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/cases", method: "GET", headers: { Host: "evil.example.com" } }, (r) => {
        resolve(r.statusCode ?? 0);
        r.resume();
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it("exposes honest status with AI disabled and PayPal unconfigured", async () => {
    const c = await client();
    const j = await (await c.get("/api/status")).json();
    expect(j.ai.enabled).toBe(false);
    expect(j.paypal.configured).toBe(false);
    expect(j.paypal.baseUrl).toContain("sandbox");
  });
});

describe("sample simulated refund", () => {
  beforeEach(() => boot(baseConfig()));

  it("simulates a refund for a sample case with a simulation receipt and no PayPal mode", async () => {
    const c = await client();
    const prep = await c.send("/api/cases/sample-deep-clean/prepare-approval", "POST", {
      amountRaw: "60.00", purpose: "Goodwill adjustment", reviewed: true,
    });
    expect(prep.status).toBe(200);
    const { token, simulated } = await prep.json();
    expect(simulated).toBe(true);
    const conf = await c.send(`/api/approvals/${token}/confirm`, "POST", {});
    const body = await conf.json();
    expect(body.operation.state).toBe("completed");
    expect(body.operation.simulated).toBe(true);
    expect(body.receipt.simulated).toBe(true);
    expect(body.receipt.note).toMatch(/SIMULATION|No PayPal/i);
  });

  it("rejects an over-refund on a sample case", async () => {
    const c = await client();
    const prep = await c.send("/api/cases/sample-deep-clean/prepare-approval", "POST", {
      amountRaw: "500.00", purpose: "too much", reviewed: true,
    });
    expect(prep.status).toBe(422);
    expect((await prep.json()).error.code).toBe("APPROVAL_OVER_REFUND");
  });

  it("blocks preparing an approval when the case has no brief (incomplete case)", async () => {
    const c = await client();
    const prep = await c.send("/api/cases/sample-missed-appointment/prepare-approval", "POST", {
      amountRaw: "60.00", purpose: "x", reviewed: true,
    });
    expect(prep.status).toBe(400);
    expect((await prep.json()).error.code).toBe("NO_BRIEF");
  });
});

describe("stale approval after evidence edit", () => {
  beforeEach(() => boot(baseConfig()));

  it("invalidates a prepared approval when a source is edited", async () => {
    const c = await client();
    const detail = await (await c.get("/api/cases/sample-deep-clean")).json();
    const srcId = detail.sources[0].id;
    const prep = await (await c.send("/api/cases/sample-deep-clean/prepare-approval", "POST", { amountRaw: "60.00", purpose: "ok", reviewed: true })).json();
    // Edit evidence -> revision bumps -> approval stale.
    await c.send(`/api/sources/${srcId}`, "PUT", { text: "Edited policy text." });
    const conf = await c.send(`/api/approvals/${prep.token}/confirm`, "POST", {});
    expect(conf.status).toBe(409);
    expect((await conf.json()).error.code).toBe("APPROVAL_STALE_REVISION");
  });
});

describe("AI generation gating", () => {
  beforeEach(() => boot(baseConfig()));
  it("reports AI not configured instead of fabricating a brief", async () => {
    const c = await client();
    const res = await c.send("/api/cases/sample-deep-clean/generate-brief", "POST", {});
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("AI_NOT_CONFIGURED");
  });
  it("loads a clearly-labelled example brief locally", async () => {
    const c = await client();
    const res = await c.send("/api/cases/sample-completed-consultation/load-example", "POST", {});
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.brief.kind).toBe("example");
    expect(j.brief.data.timeline.length).toBeGreaterThan(0);
  });
});

// Fake AI boundary (Anthropic shape) returning a valid, fully-cited brief whose
// quote matches the owner case's source. Demonstrates the adapter only — NOT a
// real provider call.
function makeAiFakeFor(sourceId: string, quote: string) {
  const brief = {
    summary: "Owner case brief produced by the fake model boundary.",
    timeline: [{ title: "Evidence noted", detail: "A fact grounded in the source.", occurredAt: "20 Nov 2026", citations: [{ sourceId, quote }] }],
    issues: [{id:'record',title:'Is the record complete?',why:'The owner must assess completeness.',missing:['Full record confirmation'],relations:[{sourceId,quote,role:'context'}]}],
    uncertainties: ["Needs owner confirmation."],
    questions: ["Is this the full record?"],
  };
  return (async () =>
    new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(brief) }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function ownerConfig(): AppConfig {
  return baseConfig({
    paypal: { configured: true, clientId: "id", clientSecret: "sec", merchantId: "MERCH-X", baseUrl: "https://api-m.sandbox.paypal.com" },
    ai: { enabled: true, provider: "anthropic", model: "claude-test-model", apiKey: "k", baseUrl: "https://api.anthropic.com" },
  });
}

// Boot an owner-config app with both fakes. The AI fake must cite a real source
// id, so we add the source first, then (re)boot with an AI fake bound to it.
async function bootOwnerWithBrief(fake: ReturnType<typeof makePayPalFake>, captureId: string) {
  const cfg = ownerConfig();
  resetSessions();
  dir = mkdtempSync(join(tmpdir(), "rb-test-"));
  const dbFile = join(dir, "t.sqlite");
  let built = createApp({ config: cfg, dbFile, paypalFetch: fake.fetchFake, serveStatic: false });
  await new Promise<void>((r) => (srv = built.app.listen(0, "127.0.0.1", () => r())));
  origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  let c = await client();
  const created = await (await c.send("/api/cases", "POST", { title: "Owner case", captureId })).json();
  const { id: srcId } = await (await c.send(`/api/cases/${created.id}/sources`, "POST", { title: "Record", kind: "work", text: "The job was cancelled before the visit." })).json();
  srv.close();
  built = createApp({ config: cfg, dbFile, paypalFetch: fake.fetchFake, aiFetch: makeAiFakeFor(srcId, "cancelled before the visit"), serveStatic: false });
  await new Promise<void>((r) => (srv = built.app.listen(0, "127.0.0.1", () => r())));
  origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  c = await client();
  return { caseId: created.id, c };
}

async function reviewGeneratedIssues(c: Awaited<ReturnType<typeof client>>, id: string) {
  let detail = await (await c.get(`/api/cases/${id}`)).json();
  for (const issue of detail.ledger.issues) {
    const review = await c.send(`/api/cases/${id}/issues/${issue.recordId}/reviews`, 'POST', {
      caseRevision: detail.revision, briefVersion: detail.briefVersion, ledgerVersion: detail.ledger.version,
      review: { interpretation:'Full record remains unconfirmed; owner considering goodwill.', disposition:'unresolved', consideredRelations:issue.relations.map((_: unknown,i: number)=>i) }
    });
    expect(review.status).toBe(201);
    detail = await (await c.get(`/api/cases/${id}`)).json();
  }
  return {caseRevision:detail.revision,briefVersion:detail.briefVersion,ledgerVersion:detail.ledger.version};
}

describe("owner real sandbox refund (fake PayPal + fake AI boundaries)", () => {
  it("generates a cited brief, executes ONE request at the fake PayPal boundary, and is idempotent under double-submit", async () => {
    const fake = makePayPalFake({ captureAmount: "180.00", merchantId: "MERCH-X", refundStatus: "COMPLETED" });
    const { caseId: created, c: c2 } = await bootOwnerWithBrief(fake, "CAP-OWNER-1");
    const gen = await c2.send(`/api/cases/${created}/generate-brief`, "POST", {});
    expect(gen.status).toBe(200);
    expect((await gen.json()).brief.kind).toBe("live");

    const reviewBinding = await reviewGeneratedIssues(c2, created);
    const prep = await (await c2.send(`/api/cases/${created}/prepare-approval`, "POST", { amountRaw: "60.00", purpose: "Partial goodwill", reviewed: true, ...reviewBinding })).json();
    expect(prep.simulated).toBe(false);
    // Double-submit the SAME approval concurrently.
    const [r1, r2] = await Promise.all([
      c2.send(`/api/approvals/${prep.token}/confirm`, "POST", {}),
      c2.send(`/api/approvals/${prep.token}/confirm`, "POST", {}),
    ]);
    const b1 = await r1.json();
    const b2 = await r2.json();
    // Exactly one refund request reached the PayPal boundary, with the stable request id.
    expect(fake.refundCalls.length).toBe(1);
    expect(fake.refundCalls[0].requestId).toBe(prep.token);
    expect(fake.refundCalls[0].requestId.length).toBeLessThanOrEqual(38);
    // Both responses describe the same single operation.
    expect(b1.operation.id).toBe(b2.operation.id);
    expect(b1.operation.state).toBe("completed");
    expect(b1.receipt.note).toMatch(/does not guarantee funds/i);
  });

  it("marks an ambiguous/timeout outcome UNKNOWN and blocks a new refund until reconciled", async () => {
    const fake = makePayPalFake({ captureAmount: "180.00", merchantId: "MERCH-X", refundNetworkError: true });
    const { caseId: created, c: c2 } = await bootOwnerWithBrief(fake, "CAP-OWNER-2");
    await c2.send(`/api/cases/${created}/generate-brief`, "POST", {});
    const reviewBinding = await reviewGeneratedIssues(c2, created);
    const prep = await (await c2.send(`/api/cases/${created}/prepare-approval`, "POST", { amountRaw: "60.00", purpose: "goodwill", reviewed: true, ...reviewBinding })).json();
    const conf = await c2.send(`/api/approvals/${prep.token}/confirm`, "POST", {});
    expect(conf.status).toBe(202);
    expect((await conf.json()).operation.state).toBe("unknown");
    // A second prepare+confirm must be blocked by the unknown outcome.
    const prep2 = await (await c2.send(`/api/cases/${created}/prepare-approval`, "POST", { amountRaw: "10.00", purpose: "again", reviewed: true, ...reviewBinding })).json();
    const conf2 = await c2.send(`/api/approvals/${prep2.token}/confirm`, "POST", {});
    expect(conf2.status).toBe(409);
    expect((await conf2.json()).error.code).toBe("OPERATION_UNKNOWN_BLOCK");
  });
});


describe("interrupted operation recovery", () => {
  it("moves a stale preparing operation to unknown without resending", async () => {
    const fake = makePayPalFake();
    const { caseId, c } = await bootOwnerWithBrief(fake, "CAP-RECOVERY");
    await c.send(`/api/cases/${caseId}/generate-brief`, "POST", {});
    const reviewBinding = await reviewGeneratedIssues(c, caseId);
    const prep = await (await c.send(`/api/cases/${caseId}/prepare-approval`, "POST", {amountRaw:"60.00", purpose:"goodwill", reviewed:true, ...reviewBinding})).json();
    const result = await (await c.send(`/api/approvals/${prep.token}/confirm`, "POST", {})).json();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(join(dir,"t.sqlite"));
    db.prepare("UPDATE operations SET state='preparing', refund_id=NULL, updated_at_ms=? WHERE id=?").run(Date.now()-600000,result.operation.id);
    db.close();
    const recovered = await (await c.send(`/api/operations/${result.operation.id}/reconcile`,"POST",{})).json();
    expect(recovered.operation.state).toBe("unknown");
    expect(fake.refundCalls).toHaveLength(1);
  });
});
