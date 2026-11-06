import { describe, it, expect } from "vitest";
import {
  assertCanStartRefund,
  blocksNewRefund,
  requiresReconciliation,
  mapRefundStatus,
  IdempotencyError,
} from "./idempotency.ts";

describe("blocksNewRefund", () => {
  it("blocks for preparing/pending/completed/unknown and allows after refused", () => {
    expect(blocksNewRefund("preparing")).toBe(true);
    expect(blocksNewRefund("pending")).toBe(true);
    expect(blocksNewRefund("completed")).toBe(true);
    expect(blocksNewRefund("unknown")).toBe(true);
    expect(blocksNewRefund("refused")).toBe(false);
  });
});

describe("assertCanStartRefund", () => {
  it("allows when there are no operations or only refused ones", () => {
    expect(() => assertCanStartRefund([])).not.toThrow();
    expect(() => assertCanStartRefund([{ state: "refused" }])).not.toThrow();
  });

  it("blocks a second refund while one is pending", () => {
    try {
      assertCanStartRefund([{ state: "pending" }]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as IdempotencyError).code).toBe("OPERATION_IN_PROGRESS");
    }
  });

  it("blocks and demands reconciliation on an unknown outcome", () => {
    try {
      assertCanStartRefund([{ state: "unknown" }]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as IdempotencyError).code).toBe("OPERATION_UNKNOWN_BLOCK");
    }
  });

  it("blocks a duplicate after a completed refund", () => {
    try {
      assertCanStartRefund([{ state: "completed" }]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as IdempotencyError).code).toBe("OPERATION_ALREADY_COMPLETED");
    }
  });
});

describe("mapRefundStatus / reconciliation", () => {
  it("maps upstream statuses to operation states", () => {
    expect(mapRefundStatus("COMPLETED")).toBe("completed");
    expect(mapRefundStatus("PENDING")).toBe("pending");
    expect(mapRefundStatus("CANCELLED")).toBe("refused");
    expect(mapRefundStatus("FAILED")).toBe("refused");
    expect(mapRefundStatus("something-weird")).toBe("unknown");
    expect(mapRefundStatus(null)).toBe("unknown");
  });

  it("flags unknown state as requiring manual reconciliation", () => {
    expect(requiresReconciliation("unknown")).toBe(true);
    expect(requiresReconciliation("pending")).toBe(false);
  });
});
