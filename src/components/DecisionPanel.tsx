import { useState } from "react";
import { ShieldCheck, RefreshCw, AlertTriangle } from "lucide-react";
import type { CaseDetail, OperationDto } from "../types";

function OperationRow({ op, onReconcile, busy }: { op: OperationDto; onReconcile: () => void; busy: boolean }) {
  return (
    <div className="op">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <span className={`state ${op.state}`}>{op.state}{op.simulated ? " (simulated)" : ""}</span>
        <span>£{op.amountFormatted}</span>
      </div>
      {op.upstreamStatus && <div className="ss" style={{ color: "var(--muted)", fontSize: 13 }}>Status: {op.upstreamStatus}{op.refundId ? ` · ${op.refundId}` : ""}</div>}
      {op.detail && <div className="ss" style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>{op.detail}</div>}
      {op.state === "unknown" && !op.simulated && (
        <div className="callout" style={{ marginTop: 10 }}>
          <AlertTriangle size={16} aria-hidden />
          <span>
            Outcome unknown. Reconcile the real status below before any further action — never submit a new refund with a new key.
            <br />
            <button className="secondary" style={{ marginTop: 8 }} onClick={onReconcile} disabled={busy}>
              <RefreshCw size={14} aria-hidden /> Check / reconcile status
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

export function DecisionPanel(props: {
  detail: CaseDetail;
  busy: boolean;
  onPrepare: (amountRaw: string, purpose: string) => void;
  onConfirm: (token: string) => void;
  onReconcile: (opId: string) => void;
  onRecordDecision: (outcome: "no_refund" | "clarification_needed", reason: string) => void;
}) {
  const { detail } = props;
  const [amount, setAmount] = useState(""); // blank by default, never pre-filled/suggested
  const [purpose, setPurpose] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [outcome, setOutcome] = useState<"refund" | "no_refund" | "clarification_needed">(
    detail.approval ? "refund" : detail.decision && !detail.decision.stale && !detail.decision.superseded ? detail.decision.outcome : detail.ledger?.enabled ? "clarification_needed" : "refund",
  );
  const [note, setNote] = useState("");
  const blocksOutcome = detail.operations.some(op => ["preparing", "pending", "unknown", "completed"].includes(op.state));
  const ledgerReady = !detail.ledger?.enabled || (!detail.ledger.stale && detail.ledger.issues.length > 0 && detail.ledger.issues.every(issue=>!!issue.review));
  const canPrepare = ledgerReady && !!detail.brief && !detail.brief.stale && amount.trim() !== "" && purpose.trim() !== "" && reviewed && !props.busy;

  return (
    <section className="panel" aria-labelledby="decision-h">
      <h3 id="decision-h">Your decision</h3>
      <p className="lead">You choose the outcome and the amount. PayPal processes the refund — the assistant never does.</p>

      {!ledgerReady && <div className="callout" role="status">Review every current issue before recording a decision. Reviewed-but-unresolved issues can support a documented goodwill or clarification decision; they are not automatically resolved.</div>}
      {detail.decision && (
        <div className="callout" style={{ display: "block", marginBottom: 16 }}>
          <strong>{detail.decision.stale ? "Earlier outcome — evidence or brief changed" : detail.decision.superseded ? "Earlier outcome — review changed" : "Recorded owner outcome"}</strong>
          <p>{detail.decision.outcome === "no_refund" ? "No refund" : "Clarification needed"}: {detail.decision.reason}</p>
          <p className="subtle">Saved {new Date(detail.decision.createdAt).toLocaleString()}. No customer message or payment was sent by recording this outcome.</p>
        </div>
      )}

      <div className="field">
        <label htmlFor="outcome">Choose an outcome</label>
        <select id="outcome" value={outcome} disabled={props.busy} onChange={event => {
          setOutcome(event.target.value as typeof outcome);
          setAmount(""); setPurpose(""); setNote(""); setReviewed(false);
        }}>
          <option value="refund">Prepare a refund</option>
          <option value="no_refund">Record no refund</option>
          <option value="clarification_needed">Record clarification needed</option>
        </select>
      </div>

      {outcome !== "refund" && (
        <>
          <p className="subtle">Record your own assessment of the current sources. This cancels outstanding refund reviews for this payment. It does not send a customer message or call PayPal.</p>
          <div className="field">
            <label htmlFor="decision-note">Reason and next step</label>
            <textarea id="decision-note" className="reason" value={note} maxLength={1000} onChange={event => setNote(event.target.value)} />
          </div>
          <label className="check">
            <input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
            I reviewed the current evidence and chose this outcome.
          </label>
          {blocksOutcome && <p className="subtle">A refund is already recorded or unresolved. Review its operation before recording another outcome.</p>}
          <button className="primary" disabled={props.busy || blocksOutcome || !ledgerReady || !note.trim() || !reviewed} onClick={() => props.onRecordDecision(outcome, note.trim())}>
            {outcome === "no_refund" ? "Record no refund" : "Record clarification needed"}
          </button>
        </>
      )}

      {outcome === "refund" && detail.remainingRefundableFormatted && (
        <p className="subtle" style={{ textAlign: "left" }}>Remaining refundable balance: £{detail.remainingRefundableFormatted}</p>
      )}

      {outcome === "refund" && !detail.approval && (
        <>
          <div className="field">
            <label htmlFor="amt">Refund amount</label>
            <div className="amountwrap">
              <span aria-hidden>£</span>
              <input
                id="amt"
                inputMode="decimal"
                value={amount}
                placeholder="0.00"
                onChange={(e) => setAmount(e.target.value)}
                aria-describedby="amt-help"
              />
            </div>
            <p id="amt-help" className="subtle" style={{ textAlign: "left" }}>Enter whole pounds and pence, e.g. 60.00. No amount is suggested for you.</p>
          </div>
          <div className="field">
            <label htmlFor="reason">Reason for this amount</label>
            <textarea id="reason" className="reason" maxLength={500} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Goodwill adjustment" />
          </div>
          <label className="check">
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
            I have reviewed this amount and the supporting evidence.
          </label>
          <button className="primary" disabled={!canPrepare} onClick={() => props.onPrepare(amount.trim(), purpose.trim())}>
            Review refund
          </button>
          {!detail.brief && <p className="subtle">Produce or load a review brief first.</p>}
          {detail.brief?.stale && <p className="subtle">The brief is stale after an evidence edit — refresh it first.</p>}
        </>
      )}

      {outcome === "refund" && detail.approval && (
        <div className="callout" style={{ background: "var(--green-soft)", borderColor: "var(--green-ring)", color: "var(--ink)", display: "block" }}>
          <strong>Confirm this refund</strong>
          <p style={{ margin: "8px 0" }}>
            Refund <strong>£{detail.approval.amountFormatted}</strong> — {detail.approval.purpose}.
            {detail.isSample ? " This will be SIMULATED (no PayPal call)." : " This will request a real SANDBOX refund."}
          </p>
          <p className="subtle" style={{ textAlign: "left", color: "var(--deepgreen-700)" }}>
            Bound to case revision {detail.revision}, brief v{detail.briefVersion}. Expires {new Date(detail.approval.expiresAt).toLocaleTimeString()}.
          </p>
          <button className="primary" disabled={props.busy} onClick={() => props.onConfirm(detail.approval!.token)}>
            <ShieldCheck size={16} aria-hidden /> {detail.isSample ? "Confirm simulated refund" : "Confirm sandbox refund"}
          </button>
        </div>
      )}

      {detail.operations.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 16 }}>Refund operations</h3>
          {detail.operations.map((op) => (
            <OperationRow key={op.id} op={op} busy={props.busy} onReconcile={() => props.onReconcile(op.id)} />
          ))}
        </div>
      )}
    </section>
  );
}
