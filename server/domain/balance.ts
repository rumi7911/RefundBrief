// Remaining-refundable reconciliation.
//
// PayPal's capture resource does not expose a universally-supported
// "already refunded" total, so we derive the remaining balance from two
// trusted inputs: (1) the capture's original amount and status, and (2) our own
// durable ledger of refund operations we have attempted. If the capture status
// is REFUNDED the remaining is zero. If we cannot establish a trustworthy
// figure we FAIL CLOSED by returning null.

export interface CaptureDetails {
  captureId: string;
  merchantId: string;
  currency: "GBP";
  amountPennies: number;
  // COMPLETED | PARTIALLY_REFUNDED | REFUNDED | PENDING | DECLINED | ...
  status: string;
}

export interface LedgerRefund {
  // Amounts we have a durable record of attempting/holding against this capture.
  amountPennies: number;
  // completed | pending | unknown  -> any of these reserve balance.
  // refused | failed               -> released, do not reserve.
  state: "completed" | "pending" | "unknown" | "refused" | "failed";
}

const RESERVING: ReadonlySet<string> = new Set(["completed", "pending", "unknown"]);

/**
 * Compute remaining refundable pennies. Returns null when it cannot be
 * safely established (unknown currency, non-refundable status, arithmetic
 * out of range, or a negative result indicating ledger/capture disagreement).
 */
export function computeRemainingRefundable(
  capture: CaptureDetails,
  ledger: LedgerRefund[],
): number | null {
  if (capture.currency !== "GBP") return null;
  if (!Number.isInteger(capture.amountPennies) || capture.amountPennies < 0) return null;

  const status = capture.status.toUpperCase();
  if (status === "REFUNDED") return 0;
  // A local ledger cannot establish refunds issued through another interface.
  // This MVP permits one refund per capture and holds partial-history cases.
  if (status === "PARTIALLY_REFUNDED") return null;
  // Only a fully COMPLETED or PARTIALLY_REFUNDED capture can be refunded further.
  if (status !== "COMPLETED" && status !== "PARTIALLY_REFUNDED") return null;

  let reserved = 0;
  for (const r of ledger) {
    if (!Number.isInteger(r.amountPennies) || r.amountPennies < 0) return null;
    if (RESERVING.has(r.state)) {
      reserved += r.amountPennies;
      if (!Number.isSafeInteger(reserved)) return null;
    }
  }
  const remaining = capture.amountPennies - reserved;
  if (remaining < 0) return null; // ledger exceeds capture — disagreement, fail closed
  return remaining;
}
