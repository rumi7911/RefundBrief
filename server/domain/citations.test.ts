import { describe, it, expect } from "vitest";
import { verifyCitation, verifyCitations, CitationError, type SourceDoc } from "./citations.ts";

const sources: SourceDoc[] = [
  { id: "policy", title: "Policy", text: "Cancellations made at least 24 hours before the visit are eligible for a full refund." },
  { id: "message", title: "Message", text: "I need to cancel Friday's deep clean. Please confirm I'll receive a refund." },
];

describe("verifyCitation", () => {
  it("verifies an exact quote present in the source", () => {
    const v = verifyCitation({ sourceId: "policy", quote: "eligible for a full refund" }, sources);
    expect(v.offset).toBeGreaterThanOrEqual(0);
  });

  it("rejects an empty quote", () => {
    expect(() => verifyCitation({ sourceId: "policy", quote: "" }, sources)).toThrow(/non-empty/i);
  });

  it("rejects an unknown source", () => {
    try {
      verifyCitation({ sourceId: "ghost", quote: "anything" }, sources);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CitationError).code).toBe("CITATION_UNKNOWN_SOURCE");
    }
  });

  it("rejects a quote not found verbatim (no fabrication)", () => {
    try {
      verifyCitation({ sourceId: "policy", quote: "no refund will ever be given" }, sources);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CitationError).code).toBe("CITATION_NOT_FOUND");
    }
  });
});

describe("verifyCitations", () => {
  it("collapses exact duplicates", () => {
    const out = verifyCitations(
      [
        { sourceId: "policy", quote: "full refund" },
        { sourceId: "policy", quote: "full refund" },
      ],
      sources,
    );
    expect(out).toHaveLength(1);
  });

  it("rejects the whole set if any citation is invalid", () => {
    expect(() =>
      verifyCitations(
        [
          { sourceId: "policy", quote: "full refund" },
          { sourceId: "message", quote: "I promise double your money back" },
        ],
        sources,
      ),
    ).toThrow(CitationError);
  });

  it("proves existence, not entailment — a real quote verifies regardless of meaning", () => {
    // The quote exists verbatim; verification says nothing about what it implies.
    const out = verifyCitations([{ sourceId: "message", quote: "receive a refund" }], sources);
    expect(out[0].quote).toBe("receive a refund");
  });
});

it('rejects an ambiguous repeated quote unless its exact occurrence is provided', () => {
 const repeated=[{id:'s',title:'Repeat',text:'same / same'}];
 expect(()=>verifyCitation({sourceId:'s',quote:'same'},repeated)).toThrow(/ambiguous/i);
 expect(verifyCitation({sourceId:'s',quote:'same',offset:7},repeated).offset).toBe(7);
 expect(()=>verifyCitation({sourceId:'s',quote:'same',offset:2},repeated)).toThrow(/offset/i);
 expect(verifyCitations([{sourceId:'s',quote:'same',offset:0},{sourceId:'s',quote:'same',offset:7}],repeated)).toHaveLength(2);
});
