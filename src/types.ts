import type { LedgerView, DecisionEvidence } from "../shared/ledger";
export interface CaseSummary {
  id: string;
  title: string;
  isSample: boolean;
  customerName: string | null;
  amountFormatted: string | null;
  currency: string;
  revision: number;
  briefVersion: number;
}

export interface SourceDto {
  id: string;
  title: string;
  kind: string;
  text: string;
}

export interface Citation {
  sourceId: string;
  quote: string;
  offset: number;
}
export interface TimelineEntry {
  title: string;
  detail: string;
  occurredAt: string | null;
  citations: Citation[];
}
export interface BriefData {
  summary: string;
  timeline: TimelineEntry[];
  uncertainties: string[];
  questions: string[];
}
export interface BriefDto {
  version: number;
  kind: "example" | "live";
  caseRevision: number;
  stale: boolean;
  data: BriefData;
}

export interface OperationDto {
  id: string;
  state: "preparing" | "pending" | "completed" | "refused" | "unknown";
  simulated: boolean;
  amountFormatted: string;
  refundId: string | null;
  upstreamStatus: string | null;
  detail: string | null;
  createdAt: string;
}

export interface ApprovalDto {
  token: string;
  amountFormatted: string;
  purpose: string;
  expiresAt: string;
  decisionEvidence?: DecisionEvidence | null;
}

export interface CaseDetail extends CaseSummary {
  ledger?: LedgerView;
  decision?: {
    id: string; outcome: "no_refund" | "clarification_needed"; reason: string;
    caseRevision: number; briefVersion: number; stale: boolean; superseded: boolean; createdAt: string;
  } | null;
  captureId: string;
  merchantId: string;
  paidAt: string | null;
  captureStatus: string;
  remainingRefundableFormatted: string | null;
  sources: SourceDto[];
  brief: BriefDto | null;
  operations: OperationDto[];
  approval: ApprovalDto | null;
  exampleAvailable: boolean;
}

export interface StatusDto {
  demoMode?: boolean;
  mode: string;
  paypal: { configured: boolean; baseUrl: string; merchantConfigured: boolean };
  ai: { enabled: boolean; provider: string | null; model: string | null; reason: string | null };
  chatgpt?: { connected: boolean; ready: boolean; email: string | null; model: string | null };
}

export interface ApiError {
  error: { code: string; message: string };
}
