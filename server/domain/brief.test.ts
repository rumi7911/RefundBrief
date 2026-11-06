import { describe, it, expect } from "vitest";
import { validateBrief, BriefError, type RawBrief } from "./brief.ts";
import type { SourceDoc } from "./citations.ts";

const sources: SourceDoc[] = [
  { id: "policy", title: "Policy", text: "Cancellations made at least 24 hours before the visit are eligible for a full refund." },
  { id: "message", title: "Message", text: "Customer cancelled the booking on 14 Mar 2024, before the scheduled visit." },
];

function goodBrief(): RawBrief {
  return {
    summary: "Customer cancelled a booking before the visit and asked for a refund.",
    timeline: [
      {
        title: "Visit cancelled",
        detail: "Customer cancelled before the scheduled visit.",
        occurredAt: "14 Nov 2026",
        citations: [{ sourceId: "message", quote: "cancelled the booking on 14 Mar 2024" }],
      },
    ],
    uncertainties: ["Unclear whether staff time was already reserved."],
    questions: ["Was the cancellation received before the visit started?"],
  };
}

describe("validateBrief", () => {
  it("accepts a well-formed, fully-cited brief", () => {
    const b = validateBrief(goodBrief(), sources);
    expect(b.timeline).toHaveLength(1);
    expect(b.questions.length).toBeGreaterThan(0);
  });

  it("rejects a brief that recommends a refund amount", () => {
    const raw = { ...goodBrief(), refundAmount: "60.00" } as RawBrief;
    try {
      validateBrief(raw, sources);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as BriefError).code).toBe("BRIEF_FORBIDDEN_FIELD");
    }
  });

  it("rejects any recommendation/decision/action/tool field", () => {
    for (const key of ["recommendation", "decision", "action", "tool_calls", "amount"]) {
      expect(() => validateBrief({ ...goodBrief(), [key]: "x" } as RawBrief, sources)).toThrow(BriefError);
    }
  });

  it("rejects a timeline claim with no verifiable citation", () => {
    const raw = goodBrief();
    (raw.timeline as any[])[0].citations = [{ sourceId: "message", quote: "this text does not exist" }];
    expect(() => validateBrief(raw, sources)).toThrow(/not found|verifiable/i);
  });

  it("rejects malformed shapes", () => {
    expect(() => validateBrief({ ...goodBrief(), summary: 123 } as unknown as RawBrief, sources)).toThrow(BriefError);
    expect(() => validateBrief({ ...goodBrief(), timeline: [] } as RawBrief, sources)).toThrow(BriefError);
    expect(() => validateBrief({ ...goodBrief(), questions: "no" } as unknown as RawBrief, sources)).toThrow(BriefError);
  });

  it("requires uncertainties and questions arrays to exist", () => {
    const { summary, timeline } = goodBrief();
    expect(() => validateBrief({ summary, timeline } as RawBrief, sources)).toThrow(BriefError);
  });
});
