import { CheckCircle2, XCircle } from "lucide-react";
import type { StatusDto } from "../types";
import { useState } from "react";
import { api } from "../api";

function Row({ ok, label, children }: { ok: boolean; label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
        {ok ? <CheckCircle2 size={18} color="var(--deepgreen)" /> : <XCircle size={18} color="var(--muted)" />}
        {label}
      </span>
      <span style={{ color: "var(--muted)", textAlign: "right", maxWidth: 420 }}>{children}</span>
    </div>
  );
}

export function SettingsPanel({ status, onRefresh }: { status: StatusDto | null; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(() => {
    const result = new URLSearchParams(window.location.search).get("chatgpt");
    return result === "connected" ? "Signed in. Load your available models and choose one to enable brief generation." :
      result === "failed" ? "ChatGPT sign-in did not complete. Try again and check that plan usage is permitted for your account." : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<{ slug: string; displayName: string }[]>([]);
  const [model, setModel] = useState("");
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Connection request failed."); }
    finally { await onRefresh().catch(() => {}); setBusy(false); }
  };
  if (!status) return null;
  if(status.demoMode)return <div className="content"><div className="hero"><h1>Local judge build</h1><p>Stored AI output · payments simulated</p></div><section className="panel"><p>External accounts, fresh AI generation and real cases are disabled. No model or payment account is needed.</p><p>Select the policy-conflict fixture in Cases. Source edits make the stored brief stale. Stop and restart the demo to restore its original fictional inputs; this does not generate new AI output.</p></section></div>;
  return (
    <div className="content">
      <div className="hero">
        <h1>Settings & connection status</h1>
        <p>Connect your services here. Sample payments always remain simulations.</p>
      </div>
      <section className="panel" style={{ maxWidth: 760, marginBottom: 20 }} aria-labelledby="chatgpt-heading">
        <h2 id="chatgpt-heading">Use your ChatGPT plan</h2>
        <p>Sign in to authorise RefundBrief to generate briefs using your eligible ChatGPT plan. Usage shares your plan limits. Your password stays with OpenAI.</p>
        <p className="subtle" style={{ textAlign: "left" }}>This connection is for this locally hosted app. Hosting a shared version requires separate access arrangements. No brief is generated automatically.</p>
        {message && <p role="status">{message}</p>}
        {error && <p role="alert" style={{ color: "#993c27" }}>{error}</p>}
        {status.chatgpt?.connected && <p>Signed in as <strong>{status.chatgpt.email ?? "your ChatGPT account"}</strong>. {status.chatgpt.ready ? `Selected model: ${status.chatgpt.model}.` : "Choose a model to enable generation."}</p>}
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <button className="secondary" data-oai-siwc-button="" disabled={busy} onClick={() => run(async () => {
            const { url } = await api.connectChatGPT(); window.location.assign(url);
          })}>Continue with ChatGPT</button>
          {status.chatgpt?.connected && <>
            <button className="secondary" disabled={busy} onClick={() => run(async () => {
              const result = await api.chatgptModels(); setModels(result.models);
              setModel(result.models.some((m) => m.slug === status.chatgpt?.model) ? status.chatgpt!.model! : result.models[0]?.slug ?? "");
              if (!result.models.length) setMessage("No models are currently available for this account. Check plan access in ChatGPT.");
            })}>Load available models</button>
            <button className="secondary" disabled={busy} onClick={() => run(async () => {
              const result = await api.disconnectChatGPT(); setModels([]); setModel(""); await onRefresh();
              setMessage(result.remoteRevoked ? "Disconnected from ChatGPT." : "Disconnected on this device. Remote revocation was not confirmed; remove RefundBrief in ChatGPT Settings to end its access there.");
            })}>Disconnect ChatGPT</button>
          </>}
        </div>
        {models.length > 0 && <div style={{ marginTop: 16 }}>
          <label htmlFor="chatgpt-model">Available ChatGPT model</label>
          <select id="chatgpt-model" value={model} disabled={busy} onChange={(e) => setModel(e.target.value)} style={{ display: "block", maxWidth: "100%", padding: 10, margin: "8px 0" }}>
            {models.map((m) => <option key={m.slug} value={m.slug}>{m.displayName}</option>)}
          </select>
          <button className="primary" disabled={busy || !model} onClick={() => run(async () => {
            await api.selectChatGPTModel(model); await onRefresh(); setMessage("Ready. Return to the workspace and choose Generate review brief when you want to send its sources to OpenAI.");
          })}>Use selected model</button>
        </div>}
      </section>
      <section className="panel settings" style={{ maxWidth: 760 }}>
        <Row ok={status.paypal.configured} label="PayPal sandbox">
          {status.paypal.configured ? (
            <>Credentials configured. A successful sandbox payment and refund still need separate verification.</>
          ) : (
            <>Not configured. Add <span className="kbd">PAYPAL_CLIENT_ID</span>, <span className="kbd">PAYPAL_CLIENT_SECRET</span> and <span className="kbd">PAYPAL_MERCHANT_ID</span> to <span className="kbd">app.env.local</span>. Sample cases still work as simulations.</>
          )}
        </Row>
        <Row ok={status.paypal.merchantConfigured} label="Merchant ID">
          {status.paypal.merchantConfigured ? "Set — capture ownership is enforced." : "Not set — required before real refunds."}
        </Row>
        <Row ok={status.ai.enabled} label="Live AI brief generation">
          {status.ai.enabled ? (
            <>Enabled: <span className="kbd">{status.ai.provider}</span> / <span className="kbd">{status.ai.model}</span></>
          ) : (
            <>Connect ChatGPT and choose a model above. Explicitly funded API access is an optional alternative described in the README.</>
          )}
        </Row>
        <Row ok={true} label="Mode">
          Sandbox only. Live PayPal hosts are refused at startup. Inherited provider API keys are deliberately ignored.
        </Row>
      </section>
    </div>
  );
}
