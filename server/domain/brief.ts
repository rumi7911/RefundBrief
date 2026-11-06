// Review-brief shape validation. The model may only produce cited facts,
// uncertainties and clarifying questions. It must NEVER emit a refund
// recommendation or any monetary instruction. Output is validated to a strict
// shape and every factual claim's citations are verified for quote existence.

import { validateIssues } from "./issues.ts";
import type { IssueDefinition } from "../../shared/ledger";
import { verifyCitations, type Citation, type SourceDoc, type VerifiedCitation } from "./citations.ts";

export class BriefError extends Error {
  code = "BRIEF_INVALID";
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BriefError";
    if (code) this.code = code;
  }
}

export interface RawTimelineEntry {
  title: unknown;
  detail: unknown;
  occurredAt?: unknown;
  citations: unknown;
}

export interface RawBrief {
  summary: unknown;
  timeline: unknown;
  uncertainties: unknown;
  questions: unknown;
  // Any of these forbidden keys cause rejection — the model must not advise money.
  [key: string]: unknown;
}

export interface TimelineEntry {
  title: string;
  detail: string;
  occurredAt: string | null;
  citations: VerifiedCitation[];
}

export interface ValidatedBrief {
  issues?: IssueDefinition[];
  summary: string;
  timeline: TimelineEntry[];
  uncertainties: string[];
  questions: string[];
}

const LIMITS = {
  summary: 1200,
  title: 200,
  detail: 1000,
  occurredAt: 60,
  timeline: 40,
  list: 30,
  listItem: 500,
};

// Keys that would indicate the model is trying to recommend money or actions.
const FORBIDDEN_KEYS = [
  "refund",
  "refundAmount",
  "recommendedAmount",
  "amount",
  "recommendation",
  "decision",
  "action",
  "payout",
  "tool",
  "tool_calls",
  "tools",
  "approve",
];

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") throw new BriefError(`Field '${field}' must be a string.`);
  const t = v.trim();
  if (t.length === 0) throw new BriefError(`Field '${field}' must not be empty.`);
  if (t.length > max) throw new BriefError(`Field '${field}' exceeds ${max} characters.`);
  return t;
}

function strList(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new BriefError(`Field '${field}' must be an array.`);
  if (v.length > LIMITS.list) throw new BriefError(`Field '${field}' has too many items.`);
  return v.map((item, i) => str(item, `${field}[${i}]`, LIMITS.listItem));
}

/**
 * Validate raw (model- or fixture-produced) brief JSON into a trusted brief.
 * Rejects forbidden keys, malformed shapes and unverifiable citations.
 */
export function validateBrief(raw: RawBrief, sources: SourceDoc[], caseRevision = 1): ValidatedBrief {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BriefError("Brief must be a JSON object.");
  }
  for (const key of FORBIDDEN_KEYS) {
    if (key in raw) {
      throw new BriefError(
        `Brief must not contain a '${key}' field; the model cannot recommend money or actions.`,
        "BRIEF_FORBIDDEN_FIELD",
      );
    }
  }

  const summary = str(raw.summary, "summary", LIMITS.summary);

  if (!Array.isArray(raw.timeline)) throw new BriefError("Field 'timeline' must be an array.");
  if (raw.timeline.length === 0) throw new BriefError("Timeline must have at least one entry.");
  if (raw.timeline.length > LIMITS.timeline) throw new BriefError("Timeline has too many entries.");

  const timeline: TimelineEntry[] = raw.timeline.map((entryRaw: unknown, i: number) => {
    if (entryRaw === null || typeof entryRaw !== "object") {
      throw new BriefError(`Timeline entry ${i} must be an object.`);
    }
    const e = entryRaw as RawTimelineEntry;
    const title = str(e.title, `timeline[${i}].title`, LIMITS.title);
    const detail = str(e.detail, `timeline[${i}].detail`, LIMITS.detail);
    let occurredAt: string | null = null;
    if (e.occurredAt !== undefined && e.occurredAt !== null) {
      occurredAt = str(e.occurredAt, `timeline[${i}].occurredAt`, LIMITS.occurredAt);
    }
    const citations = verifyCitations((e.citations ?? []) as Citation[], sources);
    if (citations.length === 0) {
      throw new BriefError(
        `Timeline entry ${i} ('${title}') has no verifiable citation.`,
        "BRIEF_UNCITED_CLAIM",
      );
    }
    return { title, detail, occurredAt, citations };
  });

  const uncertainties = strList(raw.uncertainties, "uncertainties");
  const questions = strList(raw.questions, "questions");

  return { summary, timeline, uncertainties, questions, ...(raw.issues === undefined ? {} : { issues: validateIssues(raw.issues, sources, caseRevision) }) };
}
