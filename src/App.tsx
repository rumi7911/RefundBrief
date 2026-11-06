import type { IssueInput, ReviewInput } from "../shared/ledger";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ShieldCheck, X } from "lucide-react";
import { api, ApiError, type Receipt } from "./api";
import type { CaseDetail, CaseSummary, StatusDto } from "./types";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { EvidencePanel } from "./components/EvidencePanel";
import { LedgerPanel } from "./components/LedgerPanel";
import { BriefPanel } from "./components/BriefPanel";
import { DecisionPanel } from "./components/DecisionPanel";
import { ModalFrame } from "./components/ModalFrame";
import { SettingsPanel } from "./components/SettingsPanel";

type Tab = "workspace" | "how" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>(() => window.location.hash === "#settings" ? "settings" : "workspace");
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const selectedCase = useRef<string | null>(null);
  const detailRequest = useRef(0);
  const [loadingCase, setLoadingCase] = useState(false);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [focus, setFocus] = useState<{ sourceId: string; quote: string; offset?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCaseOpen, setNewCaseOpen] = useState(false);
  const [confirmToken, setConfirmToken] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const refreshCases = useCallback(async () => {
    const { cases } = await api.listCases();
    setCases(cases);
    return cases;
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    // An old mutation may finish after navigation. It must neither replace the
    // selected case nor invalidate that case's newer in-flight request.
    if (selectedCase.current !== id) return;
    const request = ++detailRequest.current;
    setLoadingCase(true);
    try {
      const d = await api.getCase(id);
      if (selectedCase.current === id && detailRequest.current === request) setDetail(d);
    } finally {
      if (selectedCase.current === id && detailRequest.current === request) setLoadingCase(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [st, cs] = await Promise.all([api.status(), api.listCases()]);
        setStatus(st);
        setCases(cs.cases);
        const initialCase = (st.demoMode
          ? cs.cases.find(c => c.id === "ledger-policy-conflict" && c.isSample)
          : undefined) ?? cs.cases[0];
        if (initialCase) {
          selectedCase.current = initialCase.id;
          setActiveId(initialCase.id);
          await loadDetail(initialCase.id);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load workspace.");
      }
    })();
  }, [loadDetail]);

  const select = useCallback(async (id: string) => {
    selectedCase.current = id;
    setActiveId(id);
    setDetail(null);
    setFocus(null);
    setConfirmToken(null);
    setReceipt(null);
    setError(null);
    setTab("workspace");
    try {
      await loadDetail(id);
    } catch (e) {
      if (selectedCase.current === id) setError(e instanceof Error ? e.message : "Failed to load case.");
    }
  }, [loadDetail]);

  // Wrap a mutating action: handle busy, errors, and refresh.
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const afterChange = useCallback(async () => {
    if (activeId) await loadDetail(activeId);
    await refreshCases();
  }, [activeId, loadDetail, refreshCases]);

  const onPrepare = (amountRaw: string, purpose: string) =>
    run(async () => {
      if (!detail || detail.id !== selectedCase.current) return;
      await api.prepareApproval(detail.id, amountRaw, purpose, detail.ledger?.enabled ? {caseRevision:detail.revision,briefVersion:detail.briefVersion,ledgerVersion:detail.ledger.version} : undefined);
      await afterChange();
    });

  const doConfirm = (token: string) => {
    if (!detail || detail.id !== selectedCase.current || detail.approval?.token !== token) return;
    return run(async () => {
      let receipt: Receipt;
      try { ({receipt} = await api.confirm(token)); }
      catch (error) {
        // A rejected response can still have created a durable refused/unknown
        // operation. Remove old consent and read server state before recovery.
        if (selectedCase.current === detail.id) setConfirmToken(null);
        await afterChange().catch(() => {});
        throw error;
      }
      if (selectedCase.current === detail.id) {
        setConfirmToken(null);
        setReceipt(receipt);
      }
      await afterChange();
    });
  };

  const onReconcile = (opId: string) => {
    if (!detail || detail.id !== selectedCase.current || !detail.operations.some(op => op.id === opId)) return;
    return run(async () => {
      await api.reconcile(opId);
      await afterChange();
    });
  };

  const onRecordDecision = (outcome: "no_refund" | "clarification_needed", reason: string) => {
    if (!detail || detail.id !== selectedCase.current) return;
    return run(async () => {
      await api.recordDecision(detail.id, outcome, reason, detail.revision, detail.briefVersion, detail.ledger?.enabled ? detail.ledger.version : undefined);
      await afterChange();
    });
  };

  const saveIssue = async (issue: IssueInput, replaces?: string): Promise<boolean> => {
    let saved = false;
    await run(async () => {
      if (!detail || detail.id !== selectedCase.current || !detail.ledger) return;
      await api.saveIssue(detail.id, issue, {caseRevision:detail.revision,briefVersion:detail.briefVersion,ledgerVersion:detail.ledger.version}, replaces);
      saved = true;
      await afterChange();
    });
    return saved;
  };
  const saveReview = (recordId: string, review: ReviewInput) => run(async () => {
    if (!detail || detail.id !== selectedCase.current || !detail.ledger) return;
    await api.saveIssueReview(detail.id, recordId, review, {caseRevision:detail.revision,briefVersion:detail.briefVersion,ledgerVersion:detail.ledger.version});
    await afterChange();
  });

  const createCase = (title: string, captureId: string, customerName: string) =>
    run(async () => {
      const c = await api.createCase(title, captureId, customerName);
      setNewCaseOpen(false);
      await refreshCases();
      selectedCase.current = c.id;
      setActiveId(c.id);
      setDetail(null);
      setFocus(null);
      setConfirmToken(null);
      setReceipt(null);
      await loadDetail(c.id);
      setTab("workspace");
    });

  const aiEnabled = !!status?.ai.enabled;
  const aiReason = status?.ai.reason ?? null;
  const operations = detail?.operations ?? [];
  const refundStatus = operations.some(op => op.state === "unknown") ? "Refund outcome unknown"
    : operations.some(op => op.state === "preparing") ? "Refund in progress"
    : operations.some(op => op.state === "pending") ? "Refund pending"
    : operations.some(op => op.state === "completed" && !op.simulated) ? "Sandbox refund recorded"
    : operations.some(op => op.state === "completed") ? "Simulated refund recorded"
    : operations.some(op => op.state === "refused") ? "Refund refused"
    : "No refund requested";

  return (
    <div className="app">
      <Header tab={tab} onTab={setTab} status={status} />
      <Sidebar demoMode={!!status?.demoMode} cases={cases} activeId={activeId} onSelect={select} onNew={() => setNewCaseOpen(true)} />
      <main className="main">


        {tab === "settings" && <SettingsPanel status={status} onRefresh={async () => { setStatus(await api.status()); }} />}
        {tab === "how" && <HowItWorks />}

        {tab === "workspace" && (
          <div className="content">
            <div className="breadcrumb">Cases <span aria-hidden>/</span> {detail?.title ?? 'Workspace'}</div>

            {error && <div className="errbar" role="alert">{error}</div>}

            {!detail && <p className="subtle">{loadingCase ? "Loading case…" : "Select a case, or create a new one to begin."}</p>}

            {detail && (
              <>
                <div className="casehead">
                  <div className="row">
                    <h1>{detail.title}</h1>
                    {detail.isSample ? (
                      <span className="tag sample">Sample case — simulated</span>
                    ) : (
                      <span className="tag">Your case</span>
                    )}
                    <div className="spacer" style={{ flex: 1 }} />
                    <a className="secondary" href={api.exportUrl(detail.id, "json")} target="_blank" rel="noreferrer">
                      <Download size={15} aria-hidden /> Export JSON
                    </a>
                    <a className="secondary" href={api.exportUrl(detail.id, "text")} target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>
                      <Download size={15} aria-hidden /> Export text
                    </a>
                  </div>
                  <div className="sub">
                    <span>Evidence revision {detail.revision} · brief {detail.briefVersion}</span>
                    {detail.paidAt && <span>· Paid {detail.paidAt}</span>}
                    {detail.customerName && <span>· Customer: {detail.customerName}</span>}
                    <span>· Capture {detail.captureId}</span>
                  </div>
                </div>

                <div className="case-overview">
                  <section className="payment-summary" aria-label="Captured payment"><span>{detail.isSample ? 'Sample payment · simulated' : 'Recorded capture amount'}</span><strong>{detail.amountFormatted === null ? 'Payment unverified' : `£${detail.amountFormatted}`}</strong><span>{detail.currency} · {detail.isSample ? 'Local simulation' : 'PayPal Sandbox'}</span></section>
                  <section className="workflow-summary" aria-label="Workflow status" aria-live="polite" aria-atomic="true">
                    <div><strong>Evidence</strong><span>{detail.brief?.stale ? 'Brief stale' : detail.ledger?.enabled ? `${detail.ledger.issues.filter(i=>!!i.review).length}/${detail.ledger.issues.length} issues reviewed · ${detail.ledger.issues.filter(i=>!i.review||['unresolved','owner_judgement'].includes(i.review.disposition)).length} need follow-up` : detail.brief ? 'Needs owner review' : 'No brief yet'}</span></div>
                    <div><strong>Decision</strong><span>{detail.approval ? 'Awaiting confirmation' : detail.decision && !detail.decision.stale && !detail.decision.superseded ? 'Outcome recorded' : operations.length ? 'Refund decision recorded' : 'Not recorded'}</span></div>
                    <div><strong>Payment</strong><span>{refundStatus}</span></div>
                  </section>
                </div>
                {detail.ledger && <LedgerPanel key={`ledger:${detail.id}:${detail.revision}:${detail.briefVersion}`} detail={detail} busy={busy} aiEnabled={aiEnabled} onSaveIssue={saveIssue} onReview={saveReview} onFocusCitation={(sourceId,quote,offset)=>setFocus({sourceId,quote,offset})} onGenerate={()=>run(async()=>{try{await api.generateBrief(detail.id);await afterChange();}finally{await api.status().then(setStatus).catch(()=>{});}})}/>}
                    {!detail.ledger?.enabled && <BriefPanel key={`brief:${detail.id}:${detail.revision}:${detail.briefVersion}`}
                      brief={detail.brief}
                      sources={detail.sources}
                      aiEnabled={aiEnabled}
                      aiReason={aiReason}
                      exampleAvailable={detail.exampleAvailable}
                      busy={busy}
                      onGenerate={() => run(async () => {
                        try { await api.generateBrief(detail.id); await afterChange(); }
                        finally { await api.status().then(setStatus).catch(() => {}); }
                      })}
                      onLoadExample={() => run(async () => { await api.loadExample(detail.id); await afterChange(); })}
                      onFocusCitation={(sourceId, quote) => setFocus({ sourceId, quote })}
                    />}

                <details className="source-disclosure" open={focus ? true : undefined}>
                  <summary>Source documents <span>{detail.sources.length} originals · view or edit</span></summary>
                  <EvidencePanel
                    sources={detail.sources}
                    focus={focus}
                    onSave={(id, patch) => run(async () => { await api.updateSource(id, patch); await afterChange(); })}
                    onDelete={(id) => run(async () => { await api.deleteSource(id); await afterChange(); })}
                    onAdd={(s) => run(async () => { await api.addSource(detail.id, s); await afterChange(); })}
                  />
                </details>
                <div className="decision-region">
                    <DecisionPanel
                      key={`${detail.id}:${detail.revision}:${detail.briefVersion}:${detail.ledger?.version ?? 0}:${detail.approval?.token ?? "unprepared"}:${detail.decision?.id ?? "undecided"}`}
                      detail={detail}
                      busy={busy}
                      onPrepare={onPrepare}
                      onConfirm={(token) => setConfirmToken(token)}
                      onReconcile={onReconcile}
                      onRecordDecision={onRecordDecision}
                    />
                </div>

              </>
            )}
          </div>
        )}
      </main>

      {newCaseOpen && (
        <NewCaseModal
          busy={busy}
          paypalConfigured={!!status?.paypal.configured}
          onClose={() => setNewCaseOpen(false)}
          onCreate={createCase}
        />
      )}

      {confirmToken && detail?.approval?.token === confirmToken && (
        <ConfirmModal
          key={confirmToken}
          detail={detail}
          busy={busy}
          onCancel={() => setConfirmToken(null)}
          onConfirm={() => doConfirm(confirmToken)}
        />
      )}

      {receipt && <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

function NewCaseModal(props: {
  busy: boolean;
  paypalConfigured: boolean;
  onClose: () => void;
  onCreate: (title: string, captureId: string, customerName: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [captureId, setCaptureId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const canCreate = title.trim() !== "" && captureId.trim() !== "" && !props.busy;
  return (
    <ModalFrame labelledBy="nc-h" onClose={props.onClose} busy={props.busy}>
      <div className="modal">
        <div style={{ display: "flex", alignItems: "center" }}>
          <h3 id="nc-h" style={{ flex: 1 }}>New case</h3>
          <button className="linkbtn" aria-label="Close" onClick={props.onClose}><X size={18} aria-hidden /></button>
        </div>
        <p className="subtle" style={{ textAlign: "left", marginTop: 0 }}>
          A real case works against a live PayPal sandbox capture you own. No amount is suggested, and the capture is only verified when you prepare a refund.
        </p>
        {!props.paypalConfigured && (
          <div className="callout">
            PayPal sandbox is not configured yet. You can create the case, but preparing a real refund is blocked until credentials are set (see Settings).
          </div>
        )}
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="nc-title">Case title</label>
          <input id="nc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Disputed subscription charge" />
        </div>
        <div className="field">
          <label htmlFor="nc-cap">PayPal sandbox capture ID</label>
          <input id="nc-cap" value={captureId} onChange={(e) => setCaptureId(e.target.value)} placeholder="e.g. 3XY12345ABC678901" />
        </div>
        <div className="field">
          <label htmlFor="nc-cust">Customer name (optional)</label>
          <input id="nc-cust" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
        </div>
        <div className="btnrow" style={{ justifyContent: "flex-end" }}>
          <button className="secondary" onClick={props.onClose}>Cancel</button>
          <button className="primary" style={{ width: "auto" }} disabled={!canCreate} onClick={() => props.onCreate(title.trim(), captureId.trim(), customerName.trim())}>
            Create case
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

function ConfirmModal(props: { detail: CaseDetail; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { detail } = props;
  const approval = detail.approval!;
  const simulated = detail.isSample;
  // Real sandbox refunds require typing the exact amount back as a deliberate confirmation.
  const [typed, setTyped] = useState("");
  const match = simulated || typed.trim() === approval.amountFormatted;
  return (
    <ModalFrame initialFocusId="cf-h" labelledBy="cf-h" onClose={props.onCancel} busy={props.busy}>
      <div className="modal">
        <h3 id="cf-h" tabIndex={-1}>{simulated ? "Confirm simulated refund" : "Confirm sandbox refund"}</h3>
        <p>
          You are about to {simulated ? "simulate" : "request in the PayPal sandbox"} a refund of{" "}
          <strong>£{approval.amountFormatted}</strong> on case <strong>{detail.title}</strong>.
        </p>
        <p className="subtle" style={{ textAlign: "left" }}>Reason: {approval.purpose}</p>
        <p className="subtle" style={{ textAlign: "left" }}>
          Bound to case revision {detail.revision}, brief v{detail.briefVersion}. Expires {new Date(approval.expiresAt).toLocaleTimeString()}.
        </p>
        {approval.decisionEvidence && <div className="confirmation-basis"><strong>Owner review basis · ledger {approval.decisionEvidence.ledgerVersion}</strong><p>{approval.decisionEvidence.issues.length} issue reviews bound to this approval. Model proposals are not verified truth. Owner conclusions record your interpretation; a cited passage does not prove every part. Not material means excluded by you. Payment state is recorded separately.</p>{approval.decisionEvidence.issues.map(i=><div key={i.recordId} className="callout"><strong>{i.title}</strong><p>{i.review?.interpretation}</p>{i.review?.disposition==='evidence_resolved'&&i.review.resolvedBy!==null&&i.review.resolvedBy!==undefined&&i.relations[i.review.resolvedBy]&&<div className="evidence-excerpt"><strong>Cited basis: {i.relations[i.review.resolvedBy].sourceTitle}</strong><blockquote>{i.relations[i.review.resolvedBy].quote}</blockquote></div>}<small>{i.review?.disposition==='evidence_resolved'?'Owner conclusion — cited basis':i.review?.disposition==='not_material'?'Excluded by owner; no fact established':'Needs follow-up; facts remain uncertain'}. This records owner judgement, not established entitlement or provider verification.</small></div>)}</div>}
        {simulated ? (
          <div className="callout">This is a SAMPLE case. No PayPal API call is made and no money moves.</div>
        ) : (
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="cf-amt">Type the amount <span className="kbd">{approval.amountFormatted}</span> to confirm</label>
            <input id="cf-amt" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={approval.amountFormatted} />
          </div>
        )}
        <div className="btnrow" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button className="secondary" onClick={props.onCancel} disabled={props.busy}>Cancel</button>
          <button className="primary" style={{ width: "auto" }} disabled={!match || props.busy} onClick={props.onConfirm}>
            <ShieldCheck size={16} aria-hidden /> {simulated ? "Confirm simulated refund" : "Confirm sandbox refund"}
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

function ReceiptModal(props: { receipt: Receipt; onClose: () => void }) {
  const r = props.receipt;
  return (
    <ModalFrame labelledBy="rc-h" onClose={props.onClose}>
      <div className={`modal receipt${r.simulated ? " sim" : ""}`}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <h3 id="rc-h" style={{ flex: 1 }}>{r.heading}</h3>
          <button className="linkbtn" aria-label="Close" onClick={props.onClose}><X size={18} aria-hidden /></button>
        </div>
        <div className="amount">£{r.amountFormatted}</div>
        <p><span className={`state ${r.state}`}>{r.state}</span>{r.simulated ? " (simulated)" : ""}</p>
        {r.upstreamStatus && <p className="subtle" style={{ textAlign: "left" }}>Status: {r.upstreamStatus}{r.refundId ? ` · ${r.refundId}` : ""}</p>}
        <div className="callout" style={{ marginTop: 12 }}>{r.note}</div>
        <div className="btnrow" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button className="primary" style={{ width: "auto" }} onClick={props.onClose}>Done</button>
        </div>
      </div>
    </ModalFrame>
  );
}

function HowItWorks() {
  return (
    <div className="content">
      <div className="hero">
        <h1>How it works</h1>
        <p>RefundBrief turns scattered evidence into a source-linked brief, then hands the money decision to you.</p>
      </div>
      <section className="panel" style={{ maxWidth: 760 }}>
        <ol className="timeline">
          {[
            ["Gather the evidence", "Add the policy, delivery records and customer messages as source documents. Editing evidence bumps the case revision and invalidates any brief or prepared approval."],
            ["Produce a review brief", "Generate a live AI brief (when configured) or load a clearly-labelled stored example. Every timeline claim quotes its source; the assistant never recommends an amount."],
            ["Decide the amount", "You enter the refund amount and reason. Nothing is pre-filled. You confirm you have reviewed the evidence."],
            ["Prepare and confirm", "Preparing binds the amount to the current case revision and brief version. A confirmation modal states the exact terms before anything is sent."],
            ["PayPal processes it", "Sample cases are simulated locally. Real cases request a refund in the PayPal sandbox using an idempotent request id. Unknown outcomes are reconciled, never blindly retried."],
          ].map(([t, d], i) => (
            <li className="tlitem" key={i}>
              <span className="dot">{i + 1}</span>
              <span><span className="tt">{t}</span><span className="td"> — {d}</span></span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
