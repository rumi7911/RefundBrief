import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { resetSessions } from "./security.ts";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { get } from "node:http";

let dir = "";
let server: Server;
let closeDb: () => void;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb?.(); if (dir) rmSync(dir, { recursive: true, force: true }); resetSessions();
});
async function boot(aiFetch?: typeof fetch) {
  dir = mkdtempSync(join(tmpdir(), "rb-oauth-route-"));
  const result = createApp({ config: { port: 4100, host: "127.0.0.1", dataDir: dir,
    paypal: { configured: false, baseUrl: "https://api-m.sandbox.paypal.com" }, ai: aiFetch ? { enabled: true, provider: "openai", model: "fake-model", apiKey: "test-only", baseUrl: "https://api.openai.com" } : { enabled: false } }, aiFetch, serveStatic: false });
  closeDb = () => result.db.close();
  server = result.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
it("requires CSRF consent initiation and keeps OAuth credentials out of status", async () => {
  const base = await boot();
  const rejected = await fetch(base + "/api/chatgpt/connect", { method: "POST" });
  expect(rejected.status).toBe(403);
  const session = await fetch(base + "/api/session");
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const { csrfToken } = await session.json();
  const started = await fetch(base + "/api/chatgpt/connect", { method: "POST", headers: { cookie, "x-rb-csrf": csrfToken } });
  expect(started.status).toBe(200);
  expect(started.headers.get("set-cookie")).toContain("SameSite=Lax");
  expect(started.headers.get("set-cookie")).toContain("HttpOnly");
  expect(started.headers.get("cache-control")).toBe("no-store");
  const { url } = await started.json();
  expect(new URL(url).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4100/auth/chatgpt/callback");
  const status = await (await fetch(base + "/api/status")).json();
  expect(status.chatgpt).toMatchObject({ connected: false, ready: false });
  expect(JSON.stringify(status)).not.toMatch(/access_token|refresh_token|id_token/);
  expect((await fetch(base + "/api/chatgpt/models")).status).toBe(404);
  expect((await fetch(base + "/api/chatgpt/models", { method: "POST" })).status).toBe(403);
});
it("rejects forged callback state and non-loopback Host without exchanging credentials", async () => {
  const base = await boot();
  const result = await fetch(base + "/auth/chatgpt/callback?state=forged&code=stolen", { redirect: "manual" });
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toBe("/?chatgpt=failed#settings");
  expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  const remote = await new Promise<number | undefined>((resolve, reject) => {
    get(base + "/auth/chatgpt/callback", { headers: { host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  expect(remote).toBe(421);
});
it("does not save an in-flight AI brief after the owner edits its evidence", async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const base = await boot(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const source = JSON.parse(request.input).sources[0];
    entered(); await hold;
    return Response.json({ output_text: JSON.stringify({ summary: "Source review", timeline: [{ title: "Policy recorded", detail: "The supplied policy is recorded.", occurredAt: null,
      citations: [{ sourceId: source.sourceId, quote: source.text.slice(0, 50) }] }], uncertainties: [], questions: [] }) });
  });
  const session = await fetch(base + "/api/session");
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const { csrfToken } = await session.json();
  const headers = { cookie, "x-rb-csrf": csrfToken, "content-type": "application/json" };
  const before = await (await fetch(base + "/api/cases/sample-deep-clean")).json();
  const pending = fetch(base + "/api/cases/sample-deep-clean/generate-brief", { method: "POST", headers, body: "{}" });
  await enteredPromise;
  const edit = await fetch(base + "/api/sources/" + before.sources[0].id, { method: "PUT", headers, body: JSON.stringify({ title: "Updated policy title" }) });
  expect(edit.status).toBe(200); release();
  const response = await pending;
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("AI_SOURCE_CHANGED");
  const after = await (await fetch(base + "/api/cases/sample-deep-clean")).json();
  expect(after.brief.version).toBe(before.brief.version);
  expect(after.brief.stale).toBe(true);
});

it('rejects a late model response after an owner adds a material issue', async () => {
 let release!:()=>void,entered!:()=>void;
 const hold=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const base=await boot(async(_url,init)=>{const source=JSON.parse(JSON.parse(String(init?.body)).input).sources[0];entered();await hold;return Response.json({output_text:JSON.stringify({summary:'Recorded source',timeline:[{title:'Policy',detail:'Source policy',occurredAt:null,citations:[{sourceId:source.sourceId,quote:source.text.slice(0,50)}]}],questions:[],uncertainties:[],issues:[{id:'policy',title:'Policy authority?',why:'Need accepted terms',missing:['Accepted version'],relations:[]}]})});});
 const session=await fetch(base+'/api/session');const cookie=session.headers.get('set-cookie')!.split(';')[0];const {csrfToken}=await session.json();const headers={cookie,'x-rb-csrf':csrfToken,'content-type':'application/json'};
 const before=await(await fetch(base+'/api/cases/sample-deep-clean')).json();
 const pending=fetch(base+'/api/cases/sample-deep-clean/generate-brief',{method:'POST',headers,body:'{}'});
 await started;
 const edit=await fetch(base+'/api/cases/sample-deep-clean/issues',{method:'POST',headers,body:JSON.stringify({caseRevision:before.revision,briefVersion:before.briefVersion,ledgerVersion:before.ledger.version,issue:{title:'Owner material issue',why:'Must not disappear',missing:['Acceptance'],relations:[]}})});
 expect(edit.status).toBe(201);release();const result=await pending;expect(result.status).toBe(409);expect((await result.json()).error.code).toBe('AI_SOURCE_CHANGED');
 const after=await(await fetch(base+'/api/cases/sample-deep-clean')).json();expect(after.briefVersion).toBe(before.briefVersion);expect(after.ledger.issues[0].title).toBe('Owner material issue');
});
