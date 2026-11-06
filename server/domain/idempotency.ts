// Idempotency / operation-state rules for refund execution.
//
// An operation row is committed to SQLite BEFORE any outbound PayPal call. The
// row owns a stable PayPal-Request-Id that is reused on every retry of the same
// operation, so the upstream can de-duplicate. These pure helpers decide what a
// given operation state permits; the durable transaction lives in app.ts.

export type OperationState =
  | "preparing" // row created, request not yet sent
  | "pending" // PayPal accepted, refund not final
  | "completed" // refund COMPLETED upstream
  | "refused" // PayPal rejected (declined/failed) — balance released
  | "unknown"; // timeout / ambiguous — blocks new refunds until reconciled

export class IdempotencyError extends Error {
  code = "OPERATION_CONFLICT";
  constructor(message: string, code?: string) {
    super(message);
    this.name = "IdempotencyError";
    if (code) this.code = code;
  }
}

/** States that reserve the capture and therefore block starting a NEW refund. */
export function blocksNewRefund(state: OperationState): boolean {
  return state === "preparing" || state === "pending" || state === "completed" || state === "unknown";
}

/** An unknown outcome must be reconciled manually; never auto-retry with a new key. */
export function requiresReconciliation(state: OperationState): boolean {
  return state === "unknown";
}

/**
 * Decide whether a new refund operation may start given existing operations on
 * the same capture. Throws with a precise code otherwise.
 */
export function assertCanStartRefund(existing: { state: OperationState }[]): void {
  const blocking = existing.find((o) => blocksNewRefund(o.state));
  if (!blocking) return;
  if (blocking.state === "unknown") {
    throw new IdempotencyError(
      "A previous refund has an unknown outcome and must be reconciled before another refund can start.",
      "OPERATION_UNKNOWN_BLOCK",
    );
  }
  if (blocking.state === "completed") {
    throw new IdempotencyError(
      "This capture already has a completed refund operation.",
      "OPERATION_ALREADY_COMPLETED",
    );
  }
  throw new IdempotencyError(
    "A refund operation is already in progress for this capture.",
    "OPERATION_IN_PROGRESS",
  );
}

/** Map a PayPal refund status string to our operation state. */
export function mapRefundStatus(status: string | undefined | null): OperationState {
  switch ((status ?? "").toUpperCase()) {
    case "COMPLETED":
      return "completed";
    case "PENDING":
      return "pending";
    case "CANCELLED":
    case "FAILED":
    case "DECLINED":
      return "refused";
    default:
      return "unknown";
  }
}
