// Runtime configuration, loaded from app.env.local (git-ignored) and the
// process environment. The app is designed to run as an honest SAMPLE when no
// credentials are present. Nothing here ever invents credentials, and inherited
// ANTHROPIC_API_KEY / OPENAI_API_KEY are deliberately NOT read — the AI key must
// be supplied explicitly as REFUNDBRIEF_AI_KEY.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface PayPalConfig {
  configured: boolean;
  clientId?: string;
  clientSecret?: string;
  merchantId?: string;
  baseUrl: string;
}

export interface AiConfig {
  enabled: boolean;
  provider?: "anthropic" | "openai";
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  reason?: string; // why disabled, for honest setup messaging
  stream?: boolean; // required for app-owned ChatGPT plan OAuth credentials
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  paypal: PayPalConfig;
  ai: AiConfig;
}

const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
// Only official provider hosts are allowed unless an https gateway is explicitly
// configured. This is a server-side SSRF guard; it is not browser-configurable.
const OFFICIAL_AI_HOSTS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

function parseEnvFile(path: string): Record<string, string> {
  try {
    const raw = readFileSync(path, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function loadPayPal(env: Record<string, string>): PayPalConfig {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  const merchantId = env.PAYPAL_MERCHANT_ID?.trim();
  const base = (env.PAYPAL_BASE_URL?.trim() || SANDBOX_BASE).replace(/\/+$/, "");

  // Refuse any live configuration outright — sandbox only.
  if (/api-m\.paypal\.com/.test(base) || !/sandbox/.test(base)) {
    if (base !== SANDBOX_BASE) {
      throw new Error(
        `Refusing to start: PAYPAL_BASE_URL '${base}' is not the PayPal sandbox. ` +
          `Only ${SANDBOX_BASE} is permitted.`,
      );
    }
  }
  const configured = Boolean(clientId && clientSecret && merchantId);
  return { configured, clientId, clientSecret, merchantId, baseUrl: SANDBOX_BASE };
}

function loadAi(env: Record<string, string>): AiConfig {
  const allow = env.AI_ALLOW_REQUESTS?.trim() === "true";
  const provider = env.AI_PROVIDER?.trim() as "anthropic" | "openai" | undefined;
  const model = env.AI_MODEL?.trim();
  const apiKey = env.REFUNDBRIEF_AI_KEY?.trim();
  const customBase = env.AI_BASE_URL?.trim();

  if (!allow) return { enabled: false, reason: "AI_ALLOW_REQUESTS is not 'true' (live generation is opt-in and funding-gated)." };
  if (provider !== "anthropic" && provider !== "openai") {
    return { enabled: false, reason: "AI_PROVIDER must be 'anthropic' or 'openai'." };
  }
  if (!model) return { enabled: false, reason: "AI_MODEL must be set explicitly (no guessed 'latest')." };
  if (!apiKey) return { enabled: false, reason: "REFUNDBRIEF_AI_KEY is not set (inherited provider keys are ignored by design)." };

  let baseUrl = OFFICIAL_AI_HOSTS[provider];
  if (customBase) {
    if (!/^https:\/\//.test(customBase)) {
      return { enabled: false, reason: "AI_BASE_URL must be an https URL." };
    }
    baseUrl = customBase.replace(/\/+$/, "");
  }
  return { enabled: true, provider, model, apiKey, baseUrl };
}

let cached: AppConfig | null = null;

export function loadConfig(opts: { refresh?: boolean; envPath?: string } = {}): AppConfig {
  if (cached && !opts.refresh) return cached;
  const envPath = opts.envPath ?? resolve(process.cwd(), "app.env.local");
  const fileEnv = parseEnvFile(envPath);
  // File takes precedence for app-specific keys; fall back to process.env for
  // operational knobs only (never for provider keys we intentionally ignore).
  const env: Record<string, string> = { ...fileEnv };
  for (const k of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_MERCHANT_ID", "PAYPAL_BASE_URL", "AI_ALLOW_REQUESTS", "AI_PROVIDER", "AI_MODEL", "REFUNDBRIEF_AI_KEY", "AI_BASE_URL"]) {
    if (env[k] === undefined && process.env[k] !== undefined) env[k] = process.env[k] as string;
  }

  cached = {
    port: Number(process.env.PORT ?? 4100),
    host: "127.0.0.1",
    dataDir: resolve(process.cwd(), ".data"),
    paypal: loadPayPal(env),
    ai: loadAi(env),
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
