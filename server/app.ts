// Express app factory. Exported for tests; the HTTP boundary to PayPal and the
// AI provider are injectable so integration tests use deterministic fakes.
//
// Error envelope is always { error: { code, message } }. Success DTOs are
// consistent and never leak secrets, raw upstream headers or tokens.

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync } from "node:fs";
import { type AppConfig, loadConfig } from "./config.ts";
import { openDb, withImmediateTx, audit } from "./db.ts";
import { seedIfEmpty, exampleBriefFor } from "./seed.ts";
import { hostGuard, csrfGuard, ensureSession, csrfTokenFor, sendError } from "./security.ts";
import { formatPennies, MoneyError } from "./domain/money.ts";
import { validateBrief, BriefError, type RawBrief } from "./domain/brief.ts";
import { IssueLedger } from "./issue-ledger.ts";
import { IssueError } from "./domain/issues.ts";
import type { LedgerBinding } from "../shared/ledger";
import type { SourceDoc } from "./domain/citations.ts";
import { prepareApproval, assertApprovalUsable, ApprovalError, type BoundApproval, type CaptureSnapshot } from "./domain/approval.ts";
import { computeRemainingRefundable, type CaptureDetails, type LedgerRefund } from "./domain/balance.ts";
import { assertCanStartRefund, mapRefundStatus, IdempotencyError, type OperationState } from "./domain/idempotency.ts";
import { PayPalClient, PayPalError, type FetchLike } from "./paypal.ts";
import { generateBriefRaw, AiError } from "./ai.ts";
import { ChatGPTConnection, ChatGPTError } from "./chatgpt.ts";

export interface CreateAppOptions {
  demoMode?: boolean;
  config?: AppConfig;
  dbFile?: string;
  paypalFetch?: FetchLike;
  aiFetch?: FetchLike;
  serveStatic?: boolean;
}

const MAX_SOURCE_LEN = 20000;
const MAX_TITLE_LEN = 200;

export function createApp(opts: CreateAppOptions = {}) {
  const demoMode=opts.demoMode===true;
  const config:AppConfig = demoMode ? {
    port:opts.config?.port??4184,host:'127.0.0.1',dataDir:opts.config?.dataDir??mkdtempSync(join(tmpdir(),'refundbrief-demo-')),
    paypal:{configured:false,baseUrl:'https://api-m.sandbox.paypal.com'},
    ai:{enabled:false,reason:'Stored AI output · payments simulated. External services disabled in demo.'},
  } : opts.config ?? loadConfig();
  const db = openDb(opts.dbFile ?? resolve(config.dataDir, "refundbrief.sqlite"));
  const chatgpt = demoMode ? null : new ChatGPTConnection(config.dataDir, opts.aiFetch ?? fetch);
  seedIfEmpty(db);
  const issueLedger = new IssueLedger(db);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", hostGuard(config.port));
  app.use("/api", csrfGuard(config.port));
  app.use("/auth/chatgpt", hostGuard(config.port));
  app.use('/api', (req,res,next)=>{
    if(req.body && Object.hasOwn(req.body,'reviewContractVersion'))return sendError(res,422,'ISSUE_INVALID','Review contract metadata is server-authored.');
    next();
  });

  if(demoMode){
    const disabled=(_req:Request,res:Response)=>sendError(res,403,'DEMO_EXTERNAL_DISABLED','External accounts, fresh generation and real payments are disabled in this local demo.');
    app.use(['/api/chatgpt','/auth/chatgpt'],disabled);
    app.post('/api/cases',disabled);
    app.post('/api/cases/:id/generate-brief',disabled);
    app.use('/api/cases/:id',(req,res,next)=>{const c=getCase(req.params.id);if(c&&!c.is_sample)return disabled(req,res);next();});
    app.use('/api/sources/:id',(req,res,next)=>{const c=db.prepare('SELECT c.is_sample FROM cases c JOIN sources s ON s.case_id=c.id WHERE s.id=?').get(req.params.id) as any;if(c&&!c.is_sample)return disabled(req,res);next();});
    app.use('/api/approvals/:token',(req,res,next)=>{const c=db.prepare('SELECT c.is_sample FROM cases c JOIN approvals a ON a.case_id=c.id WHERE a.token=?').get(req.params.token) as any;if(c&&!c.is_sample)return disabled(req,res);next();});
    app.use('/api/operations/:id',(req,res,next)=>{const op=db.prepare('SELECT simulated FROM operations WHERE id=?').get(req.params.id) as any;if(op&&!op.simulated)return disabled(req,res);next();});
  }

  app.post("/api/chatgpt/connect", (_req, res) => {
    const start = chatgpt!.begin(`http://127.0.0.1:${config.port}/auth/chatgpt/callback`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Set-Cookie", `rb_oauth=${start.binding}; HttpOnly; SameSite=Lax; Path=/auth/chatgpt/callback; Max-Age=300`);
    res.json({ url: start.url });
  });
  app.get("/auth/chatgpt/callback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    const binding = /(?:^|;\s*)rb_oauth=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    res.setHeader("Set-Cookie", "rb_oauth=; HttpOnly; SameSite=Lax; Path=/auth/chatgpt/callback; Max-Age=0");
    const query: Record<string, string> = {};
    for (const key of ["code", "state", "client_id", "error"]) if (typeof req.query[key] === "string") query[key] = req.query[key] as string;
    try { await chatgpt!.complete(query, binding); res.redirect("/?chatgpt=connected#settings"); }
    catch { res.redirect("/?chatgpt=failed#settings"); }
  });
  app.post("/api/chatgpt/models", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json({ models: await chatgpt!.models() }); }
    catch { sendError(res, 502, "CHATGPT_CONNECTION", "Could not load ChatGPT models. Reconnect and check plan access."); }
  });
  app.post("/api/chatgpt/model", async (req, res) => {
    try { await chatgpt!.selectModel(String(req.body?.model ?? "")); res.json({ ok: true }); }
    catch { sendError(res, 400, "CHATGPT_MODEL", "Choose an available ChatGPT model. Reload the model list if access changed."); }
  });
  app.post("/api/chatgpt/disconnect", async (_req, res) => { res.json(await chatgpt!.disconnect()); });

  const paypalClient = (): PayPalClient => new PayPalClient(config.paypal, opts.paypalFetch ?? fetch);

  // ---- helpers ------------------------------------------------------------
  function getCase(id: string): any {
    return db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
  }
  function getSources(caseId: string): SourceDoc[] {
    return (db.prepare("SELECT * FROM sources WHERE case_id = ? ORDER BY sort_order, added_at").all(caseId) as any[]).map((r) => ({
      id: r.id,
      title: r.title,
      text: r.text,
      // extra fields kept for DTO
      ...(r as object),
    })) as unknown as SourceDoc[];
  }
  function currentBrief(caseId: string): any {
    return db.prepare("SELECT * FROM briefs WHERE case_id = ? ORDER BY version DESC LIMIT 1").get(caseId);
  }
  function operationsForCapture(captureId: string): any[] {
    return db.prepare("SELECT * FROM operations WHERE capture_id = ? ORDER BY created_at_ms").all(captureId) as any[];
  }
  function ledgerFor(captureId: string): LedgerRefund[] {
    return operationsForCapture(captureId).map((o) => ({
      amountPennies: o.amount_pennies,
      state: o.state as LedgerRefund["state"],
    }));
  }

  // Resolve a capture snapshot + remaining refundable. Sample cases use the
  // stored synthetic capture; owner cases require configured PayPal.
  async function resolveCapture(c: any): Promise<{ snapshot: CaptureSnapshot; details: CaptureDetails; configuredMerchantId: string }> {
    if (c.is_sample) {
      const details: CaptureDetails = {
        captureId: c.capture_id,
        merchantId: c.merchant_id,
        currency: "GBP",
        amountPennies: c.capture_amount_pennies,
        status: c.capture_status || "COMPLETED",
      };
      const remaining = computeRemainingRefundable(details, ledgerFor(c.capture_id));
      if (remaining === null) throw new ApprovalError("Refundable balance could not be established.", "APPROVAL_BALANCE_UNKNOWN");
      return { snapshot: { captureId: details.captureId, merchantId: details.merchantId, currency: "GBP", refundablePennies: remaining }, details, configuredMerchantId: c.merchant_id };
    }
    if (!config.paypal.configured || !config.paypal.merchantId) {
      throw new PayPalError("PayPal is not configured; connect sandbox credentials to work with real captures.", "PAYPAL_NOT_CONFIGURED");
    }
    const details = await paypalClient().getCapture(c.capture_id);
    // Persist the refreshed capture facts.
    db.prepare("UPDATE cases SET capture_amount_pennies = ?, paid_at = CASE WHEN capture_status='UNVERIFIED' THEN NULL ELSE paid_at END, capture_status = ?, merchant_id = ? WHERE id = ?").run(
      details.amountPennies, details.status, details.merchantId, c.id,
    );
    const remaining = computeRemainingRefundable(details, ledgerFor(c.capture_id));
    if (remaining === null) throw new ApprovalError("Refundable balance could not be established from PayPal; refusing to proceed.", "APPROVAL_BALANCE_UNKNOWN");
    return { snapshot: { captureId: details.captureId, merchantId: details.merchantId, currency: "GBP", refundablePennies: remaining }, details, configuredMerchantId: config.paypal.merchantId };
  }

  function caseSummaryDto(c: any) {
    return {
      id: c.id,
      title: c.title,
      isSample: !!c.is_sample,
      customerName: c.customer_name,
      amountFormatted: c.capture_status === "UNVERIFIED" ? null : formatPennies(c.paid_pennies ?? c.capture_amount_pennies),
      currency: c.currency,
      revision: c.revision,
      briefVersion: c.brief_version,
    };
  }

  function decisionsFor(c: any) {
    const rows = db.prepare("SELECT * FROM case_decisions WHERE case_id = ? ORDER BY rowid DESC").all(c.id) as any[];
    return rows.map(d => ({
      id: d.id, outcome: d.outcome, reason: d.reason, caseRevision: d.case_revision,
      briefVersion: d.brief_version, stale: d.case_revision !== c.revision || d.brief_version !== c.brief_version,
      superseded: !!d.superseded, createdAt: new Date(d.created_at_ms).toISOString(),
    }));
  }

  function latestCaptureDecisionId(captureId: string): string | null {
    const row = db.prepare("SELECT d.id FROM case_decisions d JOIN cases c ON c.id=d.case_id WHERE c.capture_id=? ORDER BY d.rowid DESC LIMIT 1").get(captureId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  async function caseDetailDto(c: any) {
    const sources = (db.prepare("SELECT * FROM sources WHERE case_id = ? ORDER BY sort_order, added_at").all(c.id) as any[]).map((s) => ({
      id: s.id, title: s.title, kind: s.kind, text: s.text,
    }));
    const briefRow = currentBrief(c.id);
    let brief = null as null | { version: number; kind: string; caseRevision: number; stale: boolean; data: unknown };
    if (briefRow) {
      brief = {
        version: briefRow.version,
        kind: briefRow.kind, // 'example' | 'live'
        caseRevision: briefRow.case_revision,
        stale: briefRow.case_revision !== c.revision,
        data: JSON.parse(briefRow.payload),
      };
    }
    const ops = operationsForCapture(c.capture_id).map((o) => ({
      id: o.id, state: o.state, simulated: !!o.simulated, amountFormatted: formatPennies(o.amount_pennies),
      refundId: o.refund_id, upstreamStatus: o.upstream_status, detail: o.detail,
      createdAt: new Date(o.created_at_ms).toISOString(),
    }));
    // remaining balance (best-effort; never calls PayPal here for owner cases to avoid surprise charges to rate limits)
    let remainingFormatted: string | null = null;
    if (c.is_sample) {
      const details: CaptureDetails = { captureId: c.capture_id, merchantId: c.merchant_id, currency: "GBP", amountPennies: c.capture_amount_pennies, status: c.capture_status };
      const r = computeRemainingRefundable(details, ledgerFor(c.capture_id));
      remainingFormatted = r === null ? null : formatPennies(r);
    }
    const activeApproval = db.prepare("SELECT * FROM approvals WHERE case_id = ? AND status = 'prepared' ORDER BY created_at_ms DESC LIMIT 1").get(c.id) as any;
    let approval = null as any;
    if (activeApproval && activeApproval.case_revision === c.revision && activeApproval.brief_version === c.brief_version && activeApproval.expires_at_ms > Date.now()) {
      approval = {
        token: activeApproval.token, amountFormatted: formatPennies(activeApproval.amount_pennies),
        purpose: activeApproval.purpose, expiresAt: new Date(activeApproval.expires_at_ms).toISOString(), decisionEvidence: issueLedger.snapshot(activeApproval.token),
      };
    }
    return {
      ...caseSummaryDto(c),
      captureId: c.capture_id,
      merchantId: c.merchant_id,
      paidAt: c.capture_status === "UNVERIFIED" ? null : c.paid_at,
      captureStatus: c.capture_status,
      remainingRefundableFormatted: remainingFormatted,
      sources,
      brief,
      operations: ops,
      approval,
      decision: decisionsFor(c)[0] ?? null,
      exampleAvailable: !!exampleBriefFor(c.id),
      ledger: issueLedger.view(c),
    };
  }

  function bumpRevision(caseId: string): void {
    db.prepare("UPDATE cases SET revision = revision + 1, ledger_version = ledger_version + 1 WHERE id = ?").run(caseId);
    db.prepare("UPDATE approvals SET status = 'invalidated' WHERE case_id = ? AND status = 'prepared'").run(caseId);
    audit(db, caseId, "evidence_changed");
  }

  // ---- routes -------------------------------------------------------------
  app.get("/api/session", (req, res) => {
    const sid = ensureSession(req, res);
    res.json({ csrfToken: csrfTokenFor(sid) });
  });

  app.get("/api/status", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const connection = demoMode ? {connected:false,ready:false,email:null,model:null} : chatgpt!.status();
    res.json({
      mode: "sandbox",
      demoMode,
      paypal: {
        configured: config.paypal.configured,
        baseUrl: config.paypal.baseUrl,
        merchantConfigured: !!config.paypal.merchantId,
      },
      ai: {
        enabled: connection.ready || config.ai.enabled,
        provider: connection.ready ? "ChatGPT" : config.ai.provider ?? null,
        model: connection.ready ? connection.model : config.ai.model ?? null,
        reason: connection.ready || config.ai.enabled ? null : config.ai.reason ?? "Connect ChatGPT and choose a model in Settings, or configure separately funded API access.",
      },
      chatgpt: connection,
    });
  });

  app.get("/api/cases", (_req, res) => {
    const rows = db.prepare("SELECT * FROM cases ORDER BY is_sample DESC, created_at").all() as any[];
    res.json({ cases: rows.map(caseSummaryDto) });
  });

  app.post("/api/cases", (req, res) => {
    const body = req.body ?? {};
    const title = String(body.title ?? "").trim();
    const captureId = String(body.captureId ?? "").trim();
    const customerName = body.customerName ? String(body.customerName).trim().slice(0, MAX_TITLE_LEN) : null;
    if (!title || title.length > MAX_TITLE_LEN) return sendError(res, 400, "VALIDATION", "A case title is required.");
    if (!captureId || captureId.length > MAX_TITLE_LEN) return sendError(res, 400, "VALIDATION", "A PayPal sandbox capture ID is required.");
    const id = `case-${randomUUID()}`;
    const now = new Date().toISOString();
    // Owner cases start empty: no amount suggestion, capture unverified until refreshed from PayPal.
    db.prepare(
      `INSERT INTO cases (id,title,is_sample,customer_name,capture_id,merchant_id,currency,paid_pennies,capture_amount_pennies,capture_status,paid_at,revision,brief_version,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, title, 0, customerName, captureId, config.paypal.merchantId ?? "unconfigured", "GBP", null, 0, "UNVERIFIED", null, 1, 0, now);
    audit(db, id, "case_created");
    const c = getCase(id);
    res.status(201).json(caseSummaryDto(c));
  });

  app.get("/api/cases/:id", async (req, res) => {
    const c = getCase(req.params.id);
    if (!c) return sendError(res, 404, "NOT_FOUND", "Case not found.");
    res.json(await caseDetailDto(c));
  });

  // Append-only issue and owner-review records. Expected versions are checked
  // inside the same transaction that appends the record and invalidates approval.
  app.post('/api/cases/:id/issues', (req, res) => {
    const issue = withImmediateTx(db, () => {
      const c = getCase(req.params.id); if (!c) throw new IssueError('Case not found.');
      issueLedger.assertBinding(c, req.body);
      return issueLedger.changeIssue(c, { ...req.body.issue, id: `owner-${randomUUID()}` });
    });
    res.status(201).json({ issue });
  });
  app.put('/api/cases/:id/issues/:recordId', (req, res) => {
    const issue = withImmediateTx(db, () => {
      const c = getCase(req.params.id); if (!c) throw new IssueError('Case not found.');
      issueLedger.assertBinding(c, req.body);
      return issueLedger.changeIssue(c, req.body.issue, req.params.recordId);
    });
    res.status(201).json({ issue });
  });
  app.post('/api/cases/:id/issues/:recordId/reviews', (req, res) => {
    const review = withImmediateTx(db, () => {
      const c = getCase(req.params.id); if (!c) throw new IssueError('Case not found.');
      issueLedger.assertBinding(c, req.body);
      return issueLedger.saveReview(c, req.params.recordId, req.body.review);
    });
    res.status(201).json({ review });
  });

  // Owner-written non-payment outcomes. No provider call or customer message.
  app.post("/api/cases/:id/decision", (req, res) => {
    const body = req.body ?? {};
    if (!["no_refund", "clarification_needed"].includes(body.outcome) || body.reviewed !== true ||
        typeof body.reason !== "string" || !body.reason.trim() || body.reason.trim().length > 1000) {
      return sendError(res, 400, "DECISION_INVALID", "Choose an outcome, write a reason (up to 1000 characters), and confirm your review.");
    }
    const result = withImmediateTx(db, () => {
        const c = getCase(req.params.id);
        if (!c) return { status: 404, code: "NOT_FOUND", message: "Case not found." };
        if (body.caseRevision !== c.revision || body.briefVersion !== c.brief_version) {
          return { status: 409, code: "DECISION_STALE", message: "The evidence or brief changed. Review the current case before recording your choice." };
        }
        if (operationsForCapture(c.capture_id).some(o => ["preparing", "pending", "unknown", "completed"].includes(o.state))) {
          return { status: 409, code: "DECISION_REFUND_EXISTS", message: "A refund is already recorded or unresolved. Review its operation before recording another outcome." };
        }
        const evidenceSnapshot = issueLedger.prepareSnapshot(c, body as LedgerBinding);
        // Local assessments belong to their case. A later refund review, in
        // contrast, supersedes assessments across cases sharing that payment.
        db.prepare("UPDATE case_decisions SET superseded=1 WHERE case_id=?").run(c.id);
        db.prepare("UPDATE approvals SET status='invalidated' WHERE capture_id=? AND status='prepared'").run(c.capture_id);
        const id = `decision-${randomUUID()}`;
        db.prepare("INSERT INTO case_decisions (id,case_id,case_revision,brief_version,outcome,reason,created_at_ms) VALUES (?,?,?,?,?,?,?)")
          .run(id, c.id, c.revision, c.brief_version, body.outcome, body.reason.trim(), Date.now());
        issueLedger.saveSnapshot(id, 'decision', c, evidenceSnapshot);
        audit(db, c.id, "owner_decision_recorded", { id, outcome: body.outcome, caseRevision: c.revision, briefVersion: c.brief_version });
        return { decision: decisionsFor(c)[0] };
    });
    if (result.status) return sendError(res, result.status, result.code, result.message);
    res.status(201).json(result);
  });

  app.post("/api/cases/:id/sources", (req, res) => {
    const c = getCase(req.params.id);
    if (!c) return sendError(res, 404, "NOT_FOUND", "Case not found.");
    const title = String(req.body?.title ?? "").trim();
    const kind = String(req.body?.kind ?? "note").trim().slice(0, 40);
    const text = String(req.body?.text ?? "");
    if (!title || title.length > MAX_TITLE_LEN) return sendError(res, 400, "VALIDATION", "A source title is required.");
    if (text.length > MAX_SOURCE_LEN) return sendError(res, 400, "VALIDATION", "Source text is too long.");
    const order = (db.prepare("SELECT COALESCE(MAX(sort_order)+1,0) AS n FROM sources WHERE case_id = ?").get(c.id) as any).n;
    const id = `src-${randomUUID()}`;
    db.prepare("INSERT INTO sources (id,case_id,title,kind,text,sort_order,added_at) VALUES (?,?,?,?,?,?,?)").run(
      id, c.id, title, kind, text, order, new Date().toISOString(),
    );
    bumpRevision(c.id);
    res.status(201).json({ id });
  });

  app.put("/api/sources/:id", (req, res) => {
    const s = db.prepare("SELECT * FROM sources WHERE id = ?").get(req.params.id) as any;
    if (!s) return sendError(res, 404, "NOT_FOUND", "Source not found.");
    const title = req.body?.title !== undefined ? String(req.body.title).trim() : s.title;
    const text = req.body?.text !== undefined ? String(req.body.text) : s.text;
    if (!title || title.length > MAX_TITLE_LEN) return sendError(res, 400, "VALIDATION", "A source title is required.");
    if (text.length > MAX_SOURCE_LEN) return sendError(res, 400, "VALIDATION", "Source text is too long.");
    db.prepare("UPDATE sources SET title = ?, text = ? WHERE id = ?").run(title, text, s.id);
    bumpRevision(s.case_id);
    res.json({ ok: true });
  });

  app.delete("/api/sources/:id", (req, res) => {
    const s = db.prepare("SELECT * FROM sources WHERE id = ?").get(req.params.id) as any;
    if (!s) return sendError(res, 404, "NOT_FOUND", "Source not found.");
    db.prepare("DELETE FROM sources WHERE id = ?").run(s.id);
    bumpRevision(s.case_id);
    res.json({ ok: true });
  });

  function storeBrief(c: any, raw: RawBrief, kind: "live" | "example"): any {
    return withImmediateTx(db, () => {
    const latest = getCase(c.id);
    if (!latest || latest.revision !== c.revision || latest.brief_version !== c.brief_version || latest.ledger_version !== c.ledger_version) throw new IssueError('The case or owner review changed before brief storage.', 'ISSUE_STALE');
    const sources = getSources(c.id);
    const validated = validateBrief(raw, sources, c.revision); // throws BriefError on bad shape/citations
    const version = c.brief_version + 1;
    db.prepare("INSERT INTO briefs (id,case_id,version,case_revision,kind,payload,created_at) VALUES (?,?,?,?,?,?,?)").run(
      `${c.id}-${kind}-${version}`, c.id, version, c.revision, kind, JSON.stringify(validated), new Date().toISOString(),
    );
    db.prepare("UPDATE cases SET brief_version = ? WHERE id = ?").run(version, c.id);
    issueLedger.registerBrief({ ...c, brief_version: version }, validated.issues);
    audit(db, c.id, "brief_stored", { kind, version });
    return validated;
    });
  }

  app.post("/api/cases/:id/load-example", (req, res) => {
    const c = getCase(req.params.id);
    if (!c) return sendError(res, 404, "NOT_FOUND", "Case not found.");
    const example = exampleBriefFor(c.id);
    if (!example) return sendError(res, 400, "NO_EXAMPLE", "This case has no stored example brief.");
    try {
      const validated = storeBrief(c, example, "example");
      res.json({ brief: { version: getCase(c.id).brief_version, kind: "example", data: validated, stale: false } });
    } catch (e) {
      if (e instanceof BriefError) return sendError(res, 422, e.code, `Example brief does not match current sources: ${e.message}`);
      throw e;
    }
  });

  app.post("/api/cases/:id/generate-brief", async (req, res) => {
    const c = getCase(req.params.id);
    if (!c) return sendError(res, 404, "NOT_FOUND", "Case not found.");
    if (!config.ai.enabled && !chatgpt!.status().ready) {
      return sendError(res, 503, "AI_NOT_CONFIGURED", config.ai.reason ?? "Live brief generation is not configured. See README AI setup.");
    }
    const sources = getSources(c.id);
    const ledgerAtGenerationStart = issueLedger.version(c);
    if (sources.length === 0) return sendError(res, 400, "NO_SOURCES", "Add at least one source document first.");
    try {
      const aiConfig = chatgpt!.status().ready ? await chatgpt!.credentials() : config.ai;
      const raw = (await generateBriefRaw(aiConfig, sources, opts.aiFetch ?? fetch)) as RawBrief;
      const latest = getCase(c.id);
      if (latest.revision !== c.revision || latest.brief_version !== c.brief_version || issueLedger.version(latest) !== ledgerAtGenerationStart) return sendError(res, 409, "AI_SOURCE_CHANGED", "Evidence or brief changed during generation. Generate again from the current sources.");
      if (!Array.isArray(raw.issues)) throw new IssueError('The upgraded brief must contain structured issues. No partial or legacy output was saved.');
      const validated = storeBrief(c, raw, "live");
      res.json({ brief: { version: getCase(c.id).brief_version, kind: "live", data: validated, stale: false } });
    } catch (e) {
      if (e instanceof BriefError) return sendError(res, 422, e.code, `The model output was rejected: ${e.message}`);
      if (e instanceof IssueError) return sendError(res, 422, e.code, `The model issue output was rejected: ${e.message}`);
      if (e instanceof AiError) return sendError(res, 502, e.code, `Live generation failed: ${e.message}`);
      if (e instanceof ChatGPTError) return sendError(res, 503, e.code, e.message);
      throw e;
    }
  });

  app.post("/api/cases/:id/prepare-approval", async (req, res) => {
    const c = getCase(req.params.id);
    if (!c) return sendError(res, 404, "NOT_FOUND", "Case not found.");
    const amountRaw = String(req.body?.amountRaw ?? "");
    const purpose = String(req.body?.purpose ?? "");
    const reviewed = req.body?.reviewed === true;
    if (!reviewed) return sendError(res, 400, "NOT_REVIEWED", "Confirm you have reviewed the amount and evidence.");
    if (c.brief_version === 0) return sendError(res, 400, "NO_BRIEF", "Produce or load a review brief before preparing an approval.");
    try {
      const ledgerAtStart = issueLedger.version(c);
      const evidenceSnapshot = issueLedger.prepareSnapshot(c, req.body as LedgerBinding);
      const decisionAtStart = latestCaptureDecisionId(c.capture_id);
      const { snapshot, configuredMerchantId } = await resolveCapture(c);
      const approval = withImmediateTx(db, () => {
        const latest = getCase(c.id);
        if (latest.revision !== c.revision || latest.brief_version !== c.brief_version || latestCaptureDecisionId(c.capture_id) !== decisionAtStart || issueLedger.version(latest) !== ledgerAtStart) {
          throw new ApprovalError("The evidence or owner outcome changed during payment inspection. Review the current case again.", "APPROVAL_DECISION_CHANGED");
        }
        const approval = prepareApproval({
          caseId: c.id, caseRevision: c.revision, briefVersion: c.brief_version,
          amountRaw, currency: "GBP", purpose, capture: snapshot,
          configuredMerchantId,
        });
        db.prepare(
          `INSERT INTO approvals (token,case_id,case_revision,brief_version,capture_id,merchant_id,amount_pennies,currency,purpose,created_at_ms,expires_at_ms,status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?, 'prepared')`,
        ).run(approval.token, approval.caseId, approval.caseRevision, approval.briefVersion, approval.captureId, approval.merchantId, approval.amountPennies, approval.currency, approval.purpose, approval.createdAtMs, approval.expiresAtMs);
        issueLedger.saveSnapshot(approval.token, 'approval', c, evidenceSnapshot);
        db.prepare("UPDATE case_decisions SET superseded=1 WHERE case_id IN (SELECT id FROM cases WHERE capture_id=?)").run(c.capture_id);
        audit(db, c.id, "approval_prepared", { token: approval.token, amount: approval.amountPennies });
        return approval;
      });
      res.json({
        token: approval.token,
        amountFormatted: formatPennies(approval.amountPennies),
        purpose: approval.purpose,
        expiresAt: new Date(approval.expiresAtMs).toISOString(),
        simulated: !!c.is_sample,
      });
    } catch (e) {
      if (e instanceof IssueError) return sendError(res, e.code === 'ISSUE_STALE' ? 409 : 422, e.code, e.message);
      if (e instanceof ApprovalError && e.code === "APPROVAL_DECISION_CHANGED") return sendError(res, 409, e.code, e.message);
      if (e instanceof ApprovalError || e instanceof MoneyError) return sendError(res, 422, (e as ApprovalError).code ?? "APPROVAL_INVALID", e.message);
      if (e instanceof PayPalError) return sendError(res, e.code === "PAYPAL_NOT_CONFIGURED" ? 503 : 502, e.code, e.message);
      throw e;
    }
  });

  // Load a stored approval by token (server-bound terms only).
  function loadApproval(token: string): (BoundApproval & { status: string }) | null {
    const a = db.prepare("SELECT * FROM approvals WHERE token = ?").get(token) as any;
    if (!a) return null;
    return {
      token: a.token, status: a.status, caseId: a.case_id, caseRevision: a.case_revision, briefVersion: a.brief_version,
      captureId: a.capture_id, merchantId: a.merchant_id, amountPennies: a.amount_pennies, currency: a.currency,
      purpose: a.purpose, createdAtMs: a.created_at_ms, expiresAtMs: a.expires_at_ms,
    };
  }

  function operationDto(o: any) {
    return {
      id: o.id, state: o.state as OperationState, simulated: !!o.simulated,
      amountFormatted: formatPennies(o.amount_pennies), refundId: o.refund_id,
      upstreamStatus: o.upstream_status, detail: o.detail,
      requestId: o.request_id,
      createdAt: new Date(o.created_at_ms).toISOString(),
    };
  }

  app.post("/api/approvals/:token/confirm", async (req, res) => {
    const approval = loadApproval(req.params.token);
    if (!approval) return sendError(res, 404, "NOT_FOUND", "Approval not found.");
    const c = getCase(approval.caseId);
    if (!c) return sendError(res, 404, "NOT_FOUND", "Case not found.");

    // Existing operations are receipts, never a dispatch. Contract changes do
    // not hide completed/pending/unknown history or turn a repeat into a retry.
    const recorded = db.prepare('SELECT * FROM operations WHERE approval_token=?').get(approval.token) as any;
    if(recorded)return res.json({operation:operationDto(recorded),receipt:receiptFor(recorded,c)});
    const ledgerAtConfirmationStart = issueLedger.version(c);
    const assertEvidenceCurrent = (current: any) => {
      if (issueLedger.version(current) !== ledgerAtConfirmationStart) throw new ApprovalError('The owner issue review changed during payment inspection.', 'APPROVAL_REVIEW_CHANGED');
      const snapshot = issueLedger.snapshot(approval.token);
      if ((snapshot && snapshot.reviewContractVersion!==2) || (!snapshot && issueLedger.view(current).enabled))throw new ApprovalError('Review the current contract and prepare a new approval.', 'APPROVAL_REVIEW_CHANGED');
      if (snapshot && snapshot.ledgerVersion !== issueLedger.version(current)) throw new ApprovalError('The owner issue review changed; prepare a new approval.', 'APPROVAL_REVIEW_CHANGED');
    };
    // Validate staleness against CURRENT server state — never trust client fields.
    try {
      assertEvidenceCurrent(c);
      assertApprovalUsable(approval, { currentCaseRevision: c.revision, currentBriefVersion: c.brief_version });
    } catch (e) {
      if (e instanceof ApprovalError) return sendError(res, 409, e.code, e.message);
      throw e;
    }

    if (approval.status === "invalidated") return sendError(res, 409, "APPROVAL_INVALIDATED", "This approval was cancelled by a newer owner decision for the same payment. Review the case again.");

    // Durable idempotent operation creation BEFORE any outbound call, serialised.
    let op: any;
    let created = false;
    try {
      op = withImmediateTx(db, () => {
        const currentCase = getCase(c.id);
        assertEvidenceCurrent(currentCase);
        assertApprovalUsable(approval, {currentCaseRevision:currentCase.revision,currentBriefVersion:currentCase.brief_version});
        const existing = db.prepare("SELECT * FROM operations WHERE approval_token = ?").get(approval.token) as any;
        if (existing) return existing;
        if (loadApproval(approval.token)?.status !== "prepared") throw new ApprovalError("Approval is no longer available. Review the case again.", "APPROVAL_INVALIDATED");
        const others = operationsForCapture(approval.captureId).map((o) => ({ state: o.state as OperationState }));
        assertCanStartRefund(others); // throws on pending/unknown/completed
        const id = `op-${randomUUID()}`;
        // Stable request id derived from the approval token — reused on every retry.
        const requestId = approval.token;
        const now = Date.now();
        db.prepare(
          `INSERT INTO operations (id,case_id,capture_id,approval_token,request_id,amount_pennies,currency,state,simulated,created_at_ms,updated_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(id, approval.caseId, approval.captureId, approval.token, requestId, approval.amountPennies, approval.currency, "preparing", c.is_sample ? 1 : 0, now, now);
        db.prepare("UPDATE approvals SET status = 'consumed' WHERE token = ?").run(approval.token);
        audit(db, approval.caseId, "operation_created", { id, requestId });
        created = true;
        return db.prepare("SELECT * FROM operations WHERE id = ?").get(id);
      });
    } catch (e) {
      if (e instanceof IdempotencyError || e instanceof ApprovalError) return sendError(res, 409, e.code, e.message);
      throw e;
    }

    // If a prior attempt already resolved this operation, return it idempotently.
    if (!created) {
      return res.json({ operation: operationDto(op), receipt: receiptFor(op, c) });
    }

    if (!c.is_sample) {
      try {
        const current = await resolveCapture(c);
        const latest = getCase(c.id);
        assertEvidenceCurrent(latest);
        assertApprovalUsable(approval, { currentCaseRevision: latest.revision, currentBriefVersion: latest.brief_version });
        if (approval.amountPennies > current.snapshot.refundablePennies) {
          throw new ApprovalError("Refundable balance changed; review the payment again.", "APPROVAL_OVER_REFUND");
        }
      } catch (e) {
        db.prepare("UPDATE operations SET state='refused', detail=?, updated_at_ms=? WHERE id=?").run(
          "Payment or evidence changed, or current ownership/balance could not be verified. No refund was sent.", Date.now(), op.id);
        audit(db,c.id,'refund_recheck_failed',{op:op.id,code:e instanceof PayPalError||e instanceof ApprovalError?e.code:'LOCAL_RECHECK_ERROR',...(e instanceof PayPalError&&e.httpStatus?{httpStatus:e.httpStatus}:{})});
        return sendError(res, 409, "REFUND_RECHECK_FAILED", "Current payment and evidence checks failed. No refund was sent; review the case again.");
      }
    }

    // ---- SAMPLE: explicitly simulated refund, no network, no PayPal mode ----
    if (c.is_sample) {
      const now = Date.now();
      db.prepare("UPDATE operations SET state='completed', refund_id=?, upstream_status=?, detail=?, updated_at_ms=? WHERE id=?").run(
        `SIMULATED-${op.id}`, "COMPLETED (SIMULATED)", "Simulated locally — no PayPal API call was made.", now, op.id,
      );
      audit(db, c.id, "refund_simulated", { op: op.id });
      const fresh = db.prepare("SELECT * FROM operations WHERE id = ?").get(op.id);
      return res.json({ operation: operationDto(fresh), receipt: receiptFor(fresh, c) });
    }

    // ---- OWNER: real sandbox refund via idempotent PayPal call --------------
    try {
      const result = await paypalClient().refundCapture({
        captureId: approval.captureId,
        requestId: op.request_id,
        amountValue: formatPennies(approval.amountPennies),
        invoiceNote: approval.purpose,
        beforeSend: () => {
          const latest = getCase(c.id);
          assertEvidenceCurrent(latest);
          assertApprovalUsable(approval, {currentCaseRevision:latest.revision,currentBriefVersion:latest.brief_version});
        },
      });
      const state = mapRefundStatus(result.status);
      const now = Date.now();
      db.prepare("UPDATE operations SET state=?, refund_id=?, upstream_status=?, updated_at_ms=? WHERE id=?").run(
        state, result.id, result.status, now, op.id,
      );
      audit(db, c.id, "refund_sent", { op: op.id, status: result.status });
    } catch (e) {
      const now = Date.now();
      if (e instanceof ApprovalError) {
        db.prepare("UPDATE operations SET state='refused', detail=?, updated_at_ms=? WHERE id=?").run('Owner review or evidence changed before dispatch. No refund request was sent.',now,op.id);
        audit(db,c.id,'refund_dispatch_cancelled',{op:op.id,code:e.code});
        return sendError(res,409,e.code,e.message);
      }
      if (e instanceof PayPalError && e.ambiguous) {
        // Unknown outcome — block new refunds, require manual reconciliation. Do NOT retry with a new key.
        db.prepare("UPDATE operations SET state='unknown', upstream_status=?, detail=?, updated_at_ms=? WHERE id=?").run(
          e.code, "Outcome unknown (network/timeout). Reconcile via status before any further action; never retry with a new key.", now, op.id,
        );
        audit(db, c.id, "refund_unknown", { op: op.id, code: e.code });
        const fresh = db.prepare("SELECT * FROM operations WHERE id = ?").get(op.id);
        return res.status(202).json({ operation: operationDto(fresh), receipt: receiptFor(fresh, c) });
      }
      if (e instanceof PayPalError && e.code === "PAYPAL_REFUND_REFUSED") {
        db.prepare("UPDATE operations SET state='refused', upstream_status=?, detail=?, updated_at_ms=? WHERE id=?").run(
          "REFUSED", e.message, now, op.id,
        );
        const fresh = db.prepare("SELECT * FROM operations WHERE id = ?").get(op.id);
        return res.status(200).json({ operation: operationDto(fresh), receipt: receiptFor(fresh, c) });
      }
      db.prepare("UPDATE operations SET state='unknown', upstream_status=?, detail=?, updated_at_ms=? WHERE id=?").run(
        "ERROR", (e as Error).message, now, op.id,
      );
      const fresh = db.prepare("SELECT * FROM operations WHERE id = ?").get(op.id);
      return res.status(202).json({ operation: operationDto(fresh), receipt: receiptFor(fresh, c) });
    }
    const fresh = db.prepare("SELECT * FROM operations WHERE id = ?").get(op.id);
    res.json({ operation: operationDto(fresh), receipt: receiptFor(fresh, c) });
  });

  function receiptFor(op: any, c: any): any {
    return {
      simulated: !!op.simulated,
      heading: op.simulated ? "Simulated refund receipt" : "Sandbox refund receipt",
      note: op.simulated
        ? "This is a SIMULATION for a sample case. No PayPal API call was made and no money moved."
        : "This refund was requested in the PayPal SANDBOX. A successful API response does not guarantee funds have reached the customer's bank.",
      caseTitle: c.title,
      amountFormatted: formatPennies(op.amount_pennies),
      state: op.state,
      refundId: op.refund_id,
      upstreamStatus: op.upstream_status,
    };
  }

  // Reconcile an operation's status (manual, explicit). Never auto-retries.
  app.post("/api/operations/:id/reconcile", async (req, res) => {
    const op = db.prepare("SELECT * FROM operations WHERE id = ?").get(req.params.id) as any;
    if (!op) return sendError(res, 404, "NOT_FOUND", "Operation not found.");
    if (op.state === "preparing" && Date.now() - op.updated_at_ms > 5 * 60 * 1000) {
      db.prepare("UPDATE operations SET state='unknown', detail=?, updated_at_ms=? WHERE id=? AND state='preparing'").run(
        "Interrupted execution. Verify the existing request in PayPal before any further refund; do not create a new request key.", Date.now(), op.id);
      op.state = "unknown";
    }
    if (op.simulated) return res.json({ operation: operationDto(op), note: "Simulated operation; nothing to reconcile upstream." });
    if (!op.refund_id) {
      // We never got a refund id. Owner must check the PayPal dashboard using the request id.
      return res.json({
        operation: operationDto(op),
        note: `No refund id was recorded. Check the PayPal sandbox dashboard for PayPal-Request-Id '${op.request_id}' before any further action. Do not submit a new refund with a new key.`,
      });
    }
    try {
      const r = await paypalClient().getRefund(op.refund_id);
      const state = mapRefundStatus(r.status);
      db.prepare("UPDATE operations SET state=?, upstream_status=?, updated_at_ms=? WHERE id=?").run(state, r.status, Date.now(), op.id);
      const fresh = db.prepare("SELECT * FROM operations WHERE id = ?").get(op.id);
      res.json({ operation: operationDto(fresh) });
    } catch (e) {
      if (e instanceof PayPalError) return sendError(res, 502, e.code, e.message);
      throw e;
    }
  });

  // Export the decision brief + audit history (safe JSON or plain text).
  app.get("/api/cases/:id/export", async (req, res) => {
    const c = getCase(req.params.id);
    if (!c) return sendError(res, 404, "NOT_FOUND", "Case not found.");
    const detail = await caseDetailDto(c);
    const audits = db.prepare("SELECT at,event,detail FROM audit_log WHERE case_id = ? ORDER BY id").all(c.id) as any[];
    const bundle = { reviewSemantics:{currentReviewContractVersion:2,historicalMissingVersion:1,modelOutput:'Proposal with attributed source passages; not verified truth.',ownerConclusion:'Owner conclusion — cited basis. A selected passage does not prove every part of a conclusion.',notMaterial:'Excluded by owner; not an established fact.',paymentState:'Read operation state and simulated flag separately; owner review does not verify provider state.'}, exportedAt: new Date().toISOString(), case: detail, decisions: decisionsFor(c), auditHistory: audits, decisionEvidence: issueLedger.snapshots(c.id), issueReviewHistory: issueLedger.reviewHistory(c.id), evidenceHistory: issueLedger.evidenceHistory(c.id) };
    if ((req.query.format ?? "json") === "text") {
      res.type("text/plain").send(renderText(bundle));
    } else {
      res.json(bundle);
    }
  });

  // Static production serving (optional).
  if (opts.serveStatic ?? process.env.NODE_ENV === "production") {
    const dist = resolve(process.cwd(), "dist");
    if (existsSync(dist)) {
      app.use(express.static(dist));
      app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(resolve(dist, "index.html")));
    }
  }

  // Fallback error handler -> envelope.
  app.use((err: any, _req: Request, res: Response, _next: any) => {
    if (err instanceof IssueError) return sendError(res, err.code === 'ISSUE_STALE' ? 409 : 422, err.code, err.message);
    sendError(res, 500, "INTERNAL", err?.message ?? "Unexpected error.");
  });

  return { app, db, config };
}

// Plain-text export without any HTML, safe to copy anywhere.
function renderText(bundle: any): string {
  const c = bundle.case;
  const lines: string[] = [];
  lines.push(`RefundBrief export — ${bundle.exportedAt}`);
  lines.push(`Case: ${c.title}${c.isSample ? " (SAMPLE — fictional)" : ""}`);
  lines.push(c.amountFormatted === null ? `Payment amount: unverified  Capture: ${c.captureId}` : `Amount paid: £${c.amountFormatted} ${c.currency}  Capture: ${c.captureId}`);
  lines.push("");
  lines.push('REVIEW SEMANTICS: Model proposals and attributed passages are not verified truth. Owner conclusion — cited basis records an owner interpretation; a selected reference does not prove every part. Not material means excluded by owner.');
  lines.push(`CONSENT FLOW: ${c.ledger?.enabled?'Owner review contract 2; missing historical version means contract 1.':'Legacy non-ledger brief — original consent flow.'}`);
  lines.push('PAYMENT STATE: Read operation state and SIMULATED labels separately from owner conclusions.');
  lines.push("SOURCES");
  for (const s of c.sources) lines.push(`- [${s.kind}] ${s.title}`);
  lines.push("");
  if (c.brief) {
    lines.push(`REVIEW BRIEF (v${c.brief.version}, ${c.brief.kind}${c.brief.stale ? ", STALE" : ""})`);
    lines.push(c.brief.data.summary);
    for (const t of c.brief.data.timeline) {
      lines.push(`  • ${t.title}${t.occurredAt ? ` (${t.occurredAt})` : ""}: ${t.detail}`);
      for (const cit of t.citations) lines.push(`      “${cit.quote}” — ${cit.sourceId}`);
    }
    if (c.brief.data.questions.length) lines.push(`  Questions: ${c.brief.data.questions.join("; ")}`);
  } else {
    lines.push("REVIEW BRIEF: none");
  }
  lines.push("");
  lines.push("OWNER OUTCOMES (local records; no customer message or payment)");
  for (const d of bundle.decisions ?? []) lines.push(`- ${d.createdAt} ${d.outcome}${d.stale ? " STALE" : ""}${d.superseded ? " SUPERSEDED" : ""}: ${d.reason}`);
  lines.push("");
  lines.push("DECISION EVIDENCE (immutable source/issue/owner-review snapshots)");
  for (const snapshot of bundle.decisionEvidence ?? []) lines.push(JSON.stringify(snapshot));
  lines.push("ISSUE REVIEW HISTORY");
  for (const review of bundle.issueReviewHistory ?? []) lines.push(JSON.stringify(review));
  lines.push("ORIGINAL EVIDENCE HISTORY");
  for (const evidence of bundle.evidenceHistory ?? []) lines.push(JSON.stringify(evidence));
  lines.push("OPERATIONS");
  for (const o of c.operations) lines.push(`- ${o.state}${o.simulated ? " (SIMULATED)" : ""} £${o.amountFormatted} ${o.refundId ?? ""} ${o.upstreamStatus ?? ""}`);
  lines.push("");
  lines.push("AUDIT");
  for (const a of bundle.auditHistory) lines.push(`- ${a.at} ${a.event} ${a.detail ?? ""}`);
  return lines.join("\n");
}
