import { describe, it, expect } from "vitest";
import { computeRemainingRefundable, type CaptureDetails } from "./balance.ts";

const cap = (over: Partial<CaptureDetails> = {}): CaptureDetails => ({
  captureId: "CAP-1",
  merchantId: "MERCH-1",
  currency: "GBP",
  amountPennies: 18000,
  status: "COMPLETED",
  ...over,
});

describe("computeRemainingRefundable", () => {
  it("returns full amount when no prior refunds", () => {
    expect(computeRemainingRefundable(cap(), [])).toBe(18000);
  });

  it("subtracts completed and pending refunds from the ledger", () => {
    const r = computeRemainingRefundable(cap(), [
      { amountPennies: 6000, state: "completed" },
      { amountPennies: 2000, state: "pending" },
    ]);
    expect(r).toBe(10000);
  });

  it("treats unknown-outcome refunds as reserving balance (fail safe)", () => {
    expect(computeRemainingRefundable(cap(), [{ amountPennies: 5000, state: "unknown" }])).toBe(13000);
  });

  it("does not reserve refused/failed refunds", () => {
    expect(
      computeRemainingRefundable(cap(), [
        { amountPennies: 5000, state: "refused" },
        { amountPennies: 5000, state: "failed" },
      ]),
    ).toBe(18000);
  });

  it("returns 0 for a fully REFUNDED capture", () => {
    expect(computeRemainingRefundable(cap({ status: "REFUNDED" }), [])).toBe(0);
  });

  it("fails closed (null) for non-refundable status", () => {
    expect(computeRemainingRefundable(cap({ status: "PENDING" }), [])).toBeNull();
    expect(computeRemainingRefundable(cap({ status: "DECLINED" }), [])).toBeNull();
  });

  it("fails closed (null) when ledger exceeds capture", () => {
    expect(computeRemainingRefundable(cap(), [{ amountPennies: 20000, state: "completed" }])).toBeNull();
  });

  it("fails closed (null) for unsupported currency", () => {
    expect(computeRemainingRefundable(cap({ currency: "USD" as "GBP" }), [])).toBeNull();
  });
});
