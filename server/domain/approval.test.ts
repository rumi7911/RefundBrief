import { describe, it, expect } from "vitest";
import { prepareApproval, assertApprovalUsable, ApprovalError, type PrepareInput } from "./approval.ts";

function baseInput(overrides: Partial<PrepareInput> = {}): PrepareInput {
  return {
    caseId: "case-1",
    caseRevision: 3,
    briefVersion: 2,
    amountRaw: "60.00",
    currency: "GBP",
    purpose: "Goodwill adjustment",
    capture: { captureId: "CAP-1", merchantId: "MERCH-1", currency: "GBP", refundablePennies: 18000 },
    configuredMerchantId: "MERCH-1",
    nowMs: 1_000_000,
    ttlMs: 1000,
    ...overrides,
  };
}

describe("prepareApproval", () => {
  it("binds exact reviewed terms into an opaque token", () => {
    const a = prepareApproval(baseInput());
    expect(a.token).toMatch(/[0-9a-f-]{36}/);
    expect(a.amountPennies).toBe(6000);
    expect(a.caseRevision).toBe(3);
    expect(a.briefVersion).toBe(2);
    expect(a.captureId).toBe("CAP-1");
    expect(a.expiresAtMs).toBe(1_001_000);
  });

  it("rejects an amount over the refundable balance", () => {
    try {
      prepareApproval(baseInput({ amountRaw: "200.00" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ApprovalError).code).toBe("APPROVAL_OVER_REFUND");
    }
  });

  it("rejects currency mismatch and unsupported currency", () => {
    expect(() => prepareApproval(baseInput({ currency: "USD" }))).toThrow(ApprovalError);
  });

  it("rejects a capture not owned by the configured merchant", () => {
    try {
      prepareApproval(baseInput({ configuredMerchantId: "OTHER" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ApprovalError).code).toBe("APPROVAL_MERCHANT_MISMATCH");
    }
  });

  it("fails closed when the refundable balance is unknown", () => {
    try {
      prepareApproval(baseInput({ capture: { captureId: "CAP-1", merchantId: "MERCH-1", currency: "GBP", refundablePennies: -1 } }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ApprovalError).code).toBe("APPROVAL_BALANCE_UNKNOWN");
    }
  });

  it("rejects zero and invalid amounts", () => {
    expect(() => prepareApproval(baseInput({ amountRaw: "0" }))).toThrow(ApprovalError);
    expect(() => prepareApproval(baseInput({ amountRaw: "1e2" }))).toThrow(ApprovalError);
  });
});

describe("assertApprovalUsable", () => {
  it("accepts a fresh approval bound to current revision and brief", () => {
    const a = prepareApproval(baseInput());
    expect(() => assertApprovalUsable(a, { currentCaseRevision: 3, currentBriefVersion: 2, nowMs: 1_000_500 })).not.toThrow();
  });

  it("rejects an expired approval", () => {
    const a = prepareApproval(baseInput());
    try {
      assertApprovalUsable(a, { currentCaseRevision: 3, currentBriefVersion: 2, nowMs: 9_000_000 });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ApprovalError).code).toBe("APPROVAL_EXPIRED");
    }
  });

  it("rejects a stale approval after evidence edit (revision bump)", () => {
    const a = prepareApproval(baseInput());
    try {
      assertApprovalUsable(a, { currentCaseRevision: 4, currentBriefVersion: 2, nowMs: 1_000_500 });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ApprovalError).code).toBe("APPROVAL_STALE_REVISION");
    }
  });

  it("rejects a stale approval after brief regeneration", () => {
    const a = prepareApproval(baseInput());
    try {
      assertApprovalUsable(a, { currentCaseRevision: 3, currentBriefVersion: 3, nowMs: 1_000_500 });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ApprovalError).code).toBe("APPROVAL_STALE_BRIEF");
    }
  });
});
