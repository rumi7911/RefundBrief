// Loopback-only security: Host/Origin validation (reject remote binding and
// cross-origin), a per-session double-submit anti-CSRF token, and body-size
// bounds. There is no CORS wildcard — the UI is same-origin (direct or via the
// Vite dev proxy). This is a single-owner local app.

import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const sessions = new Map<string, { csrf: string; createdAt: number }>();
const SESSION_TTL = 12 * 60 * 60 * 1000;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hostIsLoopback(host: string | undefined, _port: number): boolean {
  if (!host) return false;
  // Accept only loopback hostnames (any local port). A remote Host is rejected.
  const hostname = host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function originIsLoopback(value: string | undefined, port: number): boolean {
  if (!value) return true; // same-origin requests may omit Origin
  try {
    const u = new URL(value);
    return (
      (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
      (u.port === String(port) || u.port === "5173" || u.port === "")
    );
  } catch {
    return false;
  }
}

export function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function hostGuard(port: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!hostIsLoopback(req.headers.host, port)) {
      return sendError(res, 421, "NON_LOOPBACK_HOST", "This service only accepts loopback requests.");
    }
    next();
  };
}

export function ensureSession(req: Request, res: Response): string {
  const cookies = parseCookies(req.headers.cookie);
  let sid = cookies["rb_sess"];
  if (!sid || !sessions.has(sid)) {
    sid = randomBytes(18).toString("hex");
    sessions.set(sid, { csrf: randomBytes(18).toString("hex"), createdAt: Date.now() });
    res.setHeader("Set-Cookie", `rb_sess=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
  }
  return sid;
}

export function csrfTokenFor(sid: string): string {
  return sessions.get(sid)?.csrf ?? "";
}

export function csrfGuard(port: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!originIsLoopback(req.headers.origin as string | undefined, port)) {
      return sendError(res, 403, "BAD_ORIGIN", "Cross-origin request rejected.");
    }
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies["rb_sess"];
    const provided = req.headers["x-rb-csrf"];
    if (!sid || !sessions.has(sid) || typeof provided !== "string" || provided !== sessions.get(sid)!.csrf) {
      return sendError(res, 403, "CSRF_INVALID", "Missing or invalid anti-CSRF token. Reload the page.");
    }
    next();
  };
}

export function resetSessions(): void {
  sessions.clear();
}
