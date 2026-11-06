// Approval preparation and confirmation rules.
//
// Preparing an approval binds the exact terms the owner reviewed: case
// revision, brief version, captureId, amount (pennies), currency, purpose and
// an expiry. Final confirmation must present the opaque server-issued token;
// the server re-reads the bound terms and NEVER trusts amount/currency sent by
// the client at confirm time. Editing evidence bumps the case revision, which
// invalidates any approval bound to an older revision.

import { randomUUID } from "node:crypto";
import { parseGbpToPennies, assertSupportedCurrency } from "./money.ts";

export class ApprovalError extends Error {
  code = "APPROVAL_INVALID";
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApprovalError";
    if (code) this.code = code;
  }
}

export interface CaptureSnapshot {
  captureId: string;
  merchantId: string;
  currency: "GBP";
  /** Remaining refundable balance in pennies, established at prepare time. */
  refundablePennies: number;
}

export interface PrepareInput {
  caseId: string;
  caseRevision: number;
  briefVersion: number;
  amountRaw: string;
  currency: string;
  purpose: string;
  capture: CaptureSnapshot;
  configuredMerchantId: string;
  nowMs?: number;
  ttlMs?: number;
}

export interface BoundApproval {
  token: string;
  caseId: string;
  caseRevision: number;
  briefVersion: number;
  captureId: string;
  merchantId: string;
  amountPennies: number;
  currency: "GBP";
  purpose: string;
  createdAtMs: number;
  expiresAtMs: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_PURPOSE = 500;

/** Build a bound approval after enforcing all deterministic money/ownership checks. */
export function prepareApproval(input: PrepareInput): BoundApproval {
  const now = input.nowMs ?? Date.now();
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;

  let currency: "GBP";
  try {
    currency = assertSupportedCurrency(input.currency);
  } catch {
    throw new ApprovalError("Only GBP is supported.", "APPROVAL_CURRENCY_UNSUPPORTED");
  }
  if (input.capture.currency !== currency) {
    throw new ApprovalError("Refund currency does not match the capture currency.", "APPROVAL_CURRENCY_MISMATCH");
  }
  if (input.capture.merchantId !== input.configuredMerchantId) {
    throw new ApprovalError("Capture is not owned by the configured merchant.", "APPROVAL_MERCHANT_MISMATCH");
  }

  let amountPennies: number;
  try {
    amountPennies = parseGbpToPennies(input.amountRaw);
  } catch (e) {
    throw new ApprovalError(
      e instanceof Error ? e.message : "Refund amount is invalid.",
      "APPROVAL_AMOUNT_INVALID",
    );
  }
  if (amountPennies <= 0) {
    throw new ApprovalError("Refund amount must be greater than zero.", "APPROVAL_AMOUNT_ZERO");
  }
  if (!Number.isInteger(input.capture.refundablePennies) || input.capture.refundablePennies < 0) {
    // Fail closed when the remaining balance could not be established.
    throw new ApprovalError("Refundable balance could not be established.", "APPROVAL_BALANCE_UNKNOWN");
  }
  if (amountPennies > input.capture.refundablePennies) {
    throw new ApprovalError(
      "Refund amount exceeds the remaining refundable balance.",
      "APPROVAL_OVER_REFUND",
    );
  }

  const purpose = String(input.purpose ?? "").trim();
  if (purpose.length === 0) throw new ApprovalError("A reason for the amount is required.", "APPROVAL_PURPOSE_REQUIRED");
  if (purpose.length > MAX_PURPOSE) throw new ApprovalError("Reason is too long.");

  return {
    token: randomUUID(),
    caseId: input.caseId,
    caseRevision: input.caseRevision,
    briefVersion: input.briefVersion,
    captureId: input.capture.captureId,
    merchantId: input.capture.merchantId,
    amountPennies,
    currency,
    purpose,
    createdAtMs: now,
    expiresAtMs: now + ttl,
  };
}

export interface ConfirmContext {
  currentCaseRevision: number;
  currentBriefVersion: number;
  nowMs?: number;
}

/**
 * Validate a stored approval is still usable at confirm time. The caller must
 * pass the server-stored approval (looked up by token) — never client fields.
 */
export function assertApprovalUsable(approval: BoundApproval, ctx: ConfirmContext): void {
  const now = ctx.nowMs ?? Date.now();
  if (now >= approval.expiresAtMs) {
    throw new ApprovalError("Approval has expired; re-review and prepare again.", "APPROVAL_EXPIRED");
  }
  if (approval.caseRevision !== ctx.currentCaseRevision) {
    throw new ApprovalError(
      "Evidence changed since this approval was prepared; re-review and prepare again.",
      "APPROVAL_STALE_REVISION",
    );
  }
  if (approval.briefVersion !== ctx.currentBriefVersion) {
    throw new ApprovalError(
      "The review brief changed since this approval was prepared; re-review and prepare again.",
      "APPROVAL_STALE_BRIEF",
    );
  }
}
