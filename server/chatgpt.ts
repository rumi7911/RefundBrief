// App-owned OAuth registration only. Never reads Codex/Claude credential stores.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { AiConfig } from "./config.ts";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
type Tokens = { access: string; refresh: string; id: string; expiresAt: number; scopes: string[] };
type Profile = { clientId: string; subject: string; email?: string; model?: string; tokens?: Tokens };
type Saved = { hostId: string; profile?: Profile };
type Pending = { binding: string; nonce: string; verifier: string; redirect: string; expiresAt: number; clientId?: string; subject?: string; epoch: number };

export class ChatGPTError extends Error {
  readonly code = "CHATGPT_CONNECTION";
  constructor(message: string, readonly httpStatus?: number) { super(message); }
}

export class ChatGPTConnection {
  private saved: Saved;
  private path: string;
  private pending = new Map<string, Pending>();
  private refreshing: Promise<string> | null = null;
  private epoch = 0;
  private jwks;
  constructor(private dir: string, private fetchImpl: typeof fetch = fetch) {
    this.path = join(dir, "chatgpt.json");
    this.saved = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : { hostId: `urn:uuid:${randomUUID()}` };
    if (typeof this.saved.hostId !== "string" || !this.saved.hostId.startsWith("urn:uuid:")) throw new ChatGPTError("Invalid local ChatGPT connection record.");
    this.jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), { [customFetch]: fetchImpl, timeoutDuration: 15000 });
  }
  private persist() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600, flag: "wx" });
    renameSync(temp, this.path); chmodSync(this.path, 0o600);
  }
  private async request(url: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new ChatGPTError(`ChatGPT connection request returned HTTP ${res.status}. Reconnect if access has expired or was revoked.`, res.status);
    return res.json();
  }
  status() {
    const p = this.saved.profile;
    const connected = !!p?.tokens?.scopes.includes("chatgpt.tokens.use.direct");
    return { connected, ready: connected && !!p?.model, email: connected ? p?.email ?? null : null, model: p?.model ?? null };
  }
  begin(redirect: string) {
    const uri = new URL(redirect);
    if (uri.protocol !== "http:" || uri.hostname !== "127.0.0.1" || uri.pathname !== "/auth/chatgpt/callback" || uri.search || uri.hash) throw new ChatGPTError("ChatGPT requires the exact loopback callback.");
    this.persist();
    this.pending.clear(); // one owner, one active sign-in; starting again cancels the prior attempt
    const state = randomBytes(32).toString("base64url");
    const binding = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const p = this.saved.profile;
    this.pending.set(state, { binding, nonce, verifier, redirect, expiresAt: Date.now() + 300000, clientId: p?.clientId, subject: p?.subject, epoch: this.epoch });
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    const params: Record<string, string> = { client_id: p?.clientId ?? "dynamic_agent_client", ext_agent_host_id: this.saved.hostId,
      response_type: "code", redirect_uri: redirect, scope: SCOPE, resource: RESOURCE, state, nonce,
      code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") };
    if (!p) params.agent_name_hint = "RefundBrief";
    if (p?.tokens?.id) params.id_token_hint = p.tokens.id;
    if (p?.email) params.login_hint = p.email;
    url.search = new URLSearchParams(params).toString();
    return { url: url.toString(), binding };
  }
  async complete(query: Record<string, string>, binding: string) {
    const p = this.pending.get(query.state);
    if (!p || p.binding !== binding || p.expiresAt < Date.now() || p.epoch !== this.epoch) throw new ChatGPTError("Sign-in expired or did not match this browser. Start again from Settings.");
    this.pending.delete(query.state);
    if (query.error) throw new ChatGPTError("ChatGPT sign-in was declined. Start again when ready.");
    const clientId = query.client_id ?? p.clientId;
    if (!query.code || !clientId || !clientId.startsWith("oaiapp_") || (p.clientId && p.clientId !== clientId)) throw new ChatGPTError("ChatGPT registration did not return the expected client ID.");
    const token = await this.request(`${ISSUER}/api/accounts/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: query.code, code_verifier: p.verifier, redirect_uri: p.redirect, resource: RESOURCE }) });
    if (typeof token.id_token !== "string") throw new ChatGPTError("ChatGPT identity token is missing.");
    const { payload } = await jwtVerify(token.id_token, this.jwks, { issuer: ISSUER, audience: clientId, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5 });
    if (payload.nonce !== p.nonce || !payload.sub || (p.subject && payload.sub !== p.subject)) throw new ChatGPTError("ChatGPT identity did not match this sign-in attempt.");
    const tokens = this.readTokens(token);
    if (p.epoch !== this.epoch) throw new ChatGPTError("Connection changed while signing in; start again.");
    this.saved.profile = { clientId, subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined, tokens };
    this.epoch++; this.persist();
  }
  private readTokens(token: any, previous?: Tokens): Tokens {
    const scopes = typeof token.scope === "string" ? token.scope.split(/\s+/) : previous?.scopes ?? [];
    if (token.token_type?.toLowerCase() !== "bearer" || typeof token.access_token !== "string" || !token.access_token ||
      !Number.isFinite(token.expires_in) || token.expires_in <= 0 || !scopes.includes("chatgpt.tokens.use.direct") || !scopes.includes("resource.invoke")) {
      throw new ChatGPTError("ChatGPT plan usage permission was not granted. Reconnect and review the requested permissions.");
    }
    const refresh = token.refresh_token ?? previous?.refresh;
    if (typeof refresh !== "string" || !refresh) throw new ChatGPTError("ChatGPT renewable session is missing.");
    return { access: token.access_token, refresh, id: previous?.id ?? token.id_token, expiresAt: Date.now() + token.expires_in * 1000, scopes };
  }
  private async accessToken(): Promise<string> {
    const p = this.saved.profile;
    if (!p?.tokens) throw new ChatGPTError("Continue with ChatGPT in Settings first.");
    if (p.tokens.expiresAt > Date.now() + 60000) return p.tokens.access;
    if (this.refreshing) return this.refreshing;
    const epoch = this.epoch;
    this.refreshing = (async () => {
      try {
        const token = await this.request(`${ISSUER}/api/accounts/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: p.clientId, refresh_token: p.tokens!.refresh, resource: RESOURCE }) });
        if (epoch !== this.epoch) throw new ChatGPTError("ChatGPT connection changed during refresh.");
        p.tokens = this.readTokens(token, p.tokens); this.persist(); return p.tokens.access;
      } catch (error) {
        if (epoch === this.epoch && error instanceof ChatGPTError && (error.httpStatus === 400 || error.httpStatus === 401)) {
          delete p.tokens; delete p.model; this.persist();
        }
        throw error;
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async models(): Promise<{ slug: string; displayName: string }[]> {
    const epoch = this.epoch;
    const access = await this.accessToken();
    const data = await this.request(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${access}` } });
    if (epoch !== this.epoch || !Array.isArray(data.models)) throw new ChatGPTError("Could not load models for this ChatGPT connection.");
    return data.models.filter((m: any) => m.visibility === "list" && typeof m.slug === "string" && m.slug.length <= 200)
      .map((m: any) => ({ slug: m.slug, displayName: typeof m.display_name === "string" ? m.display_name : m.slug }));
  }
  async selectModel(model: string) {
    const epoch = this.epoch;
    const models = await this.models();
    if (epoch !== this.epoch || !this.saved.profile?.tokens || !models.some((m) => m.slug === model)) throw new ChatGPTError("Choose an available model from your account's catalog.");
    this.saved.profile.model = model; this.persist();
  }
  async credentials(): Promise<AiConfig> {
    if (!this.status().ready) throw new ChatGPTError("Connect ChatGPT and choose a model in Settings first.");
    const epoch = this.epoch;
    const access = await this.accessToken();
    if (epoch !== this.epoch) throw new ChatGPTError("ChatGPT connection changed.");
    return { enabled: true, provider: "openai", apiKey: access, model: this.saved.profile!.model, baseUrl: "https://api.openai.com", stream: true };
  }
  async disconnect() {
    const p = this.saved.profile;
    const token = p?.tokens?.refresh;
    this.epoch++; this.pending.clear();
    if (p) { delete p.tokens; delete p.model; this.persist(); }
    let remoteRevoked = false;
    if (token && p) {
      try {
        const discovery = await this.request(`${ISSUER}/.well-known/openid-configuration`);
        const endpoint = new URL(discovery.revocation_endpoint);
        if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password) throw new Error("Invalid revocation endpoint");
        const res = await this.fetchImpl(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: p.clientId }) });
        remoteRevoked = res.status === 200;
      } catch { /* local disconnect succeeds even if remote revocation cannot be confirmed */ }
    }
    return { remoteRevoked };
  }
}
