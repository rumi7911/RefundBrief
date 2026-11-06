import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGPTConnection } from "./chatgpt.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rb-chatgpt-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function setup(options: { nonce?: string; audience?: string; scope?: string; issuer?: string; subject?: string; expired?: boolean; badSignature?: boolean } = {}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  let authUrl: URL;
  let tokenCalls = 0;
  const fetchFake: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/oauth/token")) {
      tokenCalls++;
      const form = new URLSearchParams(String(init?.body));
      const key = options.badSignature ? (await generateKeyPair("RS256")).privateKey : privateKey;
      const jwt = await new SignJWT({ nonce: options.nonce ?? authUrl.searchParams.get("nonce"), email: "owner@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(options.issuer ?? "https://auth.openai.com")
        .setAudience(options.audience ?? "oaiapp_test").setSubject(options.subject ?? "owner-1").setIssuedAt().setExpirationTime(options.expired ? "-1h" : "1h").sign(key);
      return Response.json({ access_token: "access-private", refresh_token: "refresh-private", id_token: jwt,
        token_type: "Bearer", expires_in: form.get("grant_type") === "refresh_token" ? 7200 : 3600,
        scope: options.scope ?? "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" });
    }
    if (url.endsWith("/models")) return Response.json({ models: [{ slug: "allowed-model", display_name: "Allowed", visibility: "list" }, { slug: "hidden-model", visibility: "hidden" }] });
    throw new Error("Unexpected test network destination");
  };
  const connection = new ChatGPTConnection(dir, fetchFake);
  const start = connection.begin("http://127.0.0.1:4100/auth/chatgpt/callback");
  authUrl = new URL(start.url);
  const callback = { state: authUrl.searchParams.get("state")!, code: "auth-code", client_id: "oaiapp_test" };
  return { connection, start, authUrl, callback, calls: () => tokenCalls };
}

describe("ChatGPT public-client connection", () => {
  it("uses fresh PKCE state and a persistent host identity, without borrowing credentials", async () => {
    const { connection, authUrl } = await setup();
    const again = new URL(connection.begin("http://127.0.0.1:4100/auth/chatgpt/callback").url);
    expect(authUrl.origin).toBe("https://auth.openai.com");
    expect(authUrl.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authUrl.searchParams.get("agent_name_hint")).toBe("RefundBrief");
    expect(again.searchParams.get("ext_agent_host_id")).toBe(authUrl.searchParams.get("ext_agent_host_id"));
    expect(again.searchParams.get("state")).not.toBe(authUrl.searchParams.get("state"));
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(connection.status().connected).toBe(false);
  });
  it("rejects a callback without the initiating browser binding before token exchange", async () => {
    const s = await setup();
    await expect(s.connection.complete(s.callback, "wrong-browser")).rejects.toThrow();
    expect(s.calls()).toBe(0);
  });
  it("persists validated tokens privately, never in status; requires explicit model selection", async () => {
    const s = await setup();
    await s.connection.complete(s.callback, s.start.binding);
    expect(s.connection.status()).toMatchObject({ connected: true, ready: false, email: "owner@example.com" });
    expect(JSON.stringify(s.connection.status())).not.toContain("private");
    expect(statSync(join(dir, "chatgpt.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "chatgpt.json"), "utf8")).toContain("refresh-private");
    await expect(s.connection.selectModel("hidden-model")).rejects.toThrow();
    await s.connection.selectModel("allowed-model");
    expect(s.connection.status().ready).toBe(true);
    expect(await s.connection.credentials()).toMatchObject({ model: "allowed-model", apiKey: "access-private", stream: true });
  });
  it.each([{ nonce: "wrong" }, { audience: "other-app" }, { issuer: "https://evil.example" }, { scope: "openid email" }, { expired: true }, { badSignature: true }])("rejects invalid identity or insufficient usage permission: %j", async (options) => {
    const s = await setup(options);
    await expect(s.connection.complete(s.callback, s.start.binding)).rejects.toThrow();
    expect(s.connection.status().connected).toBe(false);
  });
  it("consumes an OAuth attempt once, including after user denial", async () => {
    const s = await setup();
    await expect(s.connection.complete({ ...s.callback, error: "access_denied" }, s.start.binding)).rejects.toThrow();
    await expect(s.connection.complete(s.callback, s.start.binding)).rejects.toThrow();
    expect(s.calls()).toBe(0);
  });
  it("retains the account registration and host ID after local disconnect", async () => {
    const s = await setup(); await s.connection.complete(s.callback, s.start.binding);
    const result = await s.connection.disconnect();
    expect(result.remoteRevoked).toBe(false);
    const saved = readFileSync(join(dir, "chatgpt.json"), "utf8");
    expect(saved).not.toContain("access-private"); expect(saved).not.toContain("refresh-private");
    const again = new URL(s.connection.begin("http://127.0.0.1:4100/auth/chatgpt/callback").url);
    expect(again.searchParams.get("client_id")).toBe("oaiapp_test");
    expect(s.connection.status().connected).toBe(false);
  });
  it("serializes token rotation when two requests encounter expiry", async () => {
    const s = await setup(); await s.connection.complete(s.callback, s.start.binding);
    await s.connection.selectModel("allowed-model");
    const file = join(dir, "chatgpt.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.profile.tokens.expiresAt = 0;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify(saved));
    let rotations = 0;
    const fake: typeof fetch = async (_url, init) => {
      if (++rotations > 1) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe("oaiapp_test");
      return Response.json({ access_token: "rotated", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 });
    };
    const c = new ChatGPTConnection(dir, fake);
    const results = await Promise.all([c.credentials(), c.credentials()]);
    expect(results.map((x) => x.apiKey)).toEqual(["rotated", "rotated"]);
    expect(rotations).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).profile.tokens.refresh).toBe("rotated-refresh");
  });
  it("clears a revoked session and stops reporting generation ready after refresh rejection", async () => {
    const s = await setup(); await s.connection.complete(s.callback, s.start.binding);
    await s.connection.selectModel("allowed-model");
    const file = join(dir, "chatgpt.json");
    const saved = JSON.parse(readFileSync(file, "utf8")); saved.profile.tokens.expiresAt = 0;
    const { writeFileSync } = await import("node:fs"); writeFileSync(file, JSON.stringify(saved));
    const c = new ChatGPTConnection(dir, async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(c.credentials()).rejects.toThrow();
    expect(c.status()).toMatchObject({ connected: false, ready: false });
    expect(readFileSync(file, "utf8")).not.toContain("refresh-private");
  });
});
