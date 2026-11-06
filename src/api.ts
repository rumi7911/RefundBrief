import type { IssueInput, LedgerBinding, ReviewInput } from "../shared/ledger";
import type { CaseDetail, CaseSummary, StatusDto } from "./types";

let csrfToken = "";

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function init(): Promise<void> {
  if (csrfToken) return;
  const res = await fetch("/api/session");
  const json = await res.json();
  csrfToken = json.csrfToken;
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  if (method !== "GET") await init();
  const res = await fetch(`/api${path}`, {
    method,
    headers: method === "GET" ? {} : { "content-type": "application/json", "x-rb-csrf": csrfToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = json?.error ?? { code: "HTTP_" + res.status, message: "Request failed." };
    throw new ApiError(e.code, e.message);
  }
  return json as T;
}

export const api = {
  status: () => call<StatusDto>("/status"),
  connectChatGPT: () => call<{ url: string }>("/chatgpt/connect", "POST", {}),
  chatgptModels: () => call<{ models: { slug: string; displayName: string }[] }>("/chatgpt/models", "POST", {}),
  selectChatGPTModel: (model: string) => call<{ ok: true }>("/chatgpt/model", "POST", { model }),
  disconnectChatGPT: () => call<{ remoteRevoked: boolean }>("/chatgpt/disconnect", "POST", {}),
  listCases: () => call<{ cases: CaseSummary[] }>("/cases"),
  getCase: (id: string) => call<CaseDetail>(`/cases/${id}`),
  createCase: (title: string, captureId: string, customerName: string) =>
    call<CaseSummary>("/cases", "POST", { title, captureId, customerName }),
  addSource: (caseId: string, s: { title: string; kind: string; text: string }) =>
    call<{ id: string }>(`/cases/${caseId}/sources`, "POST", s),
  updateSource: (sourceId: string, s: { title?: string; text?: string }) =>
    call<{ ok: true }>(`/sources/${sourceId}`, "PUT", s),
  deleteSource: (sourceId: string) => call<{ ok: true }>(`/sources/${sourceId}`, "DELETE"),
  loadExample: (caseId: string) => call<unknown>(`/cases/${caseId}/load-example`, "POST", {}),
  generateBrief: (caseId: string) => call<unknown>(`/cases/${caseId}/generate-brief`, "POST", {}),
  prepareApproval: (caseId: string, amountRaw: string, purpose: string, binding?: LedgerBinding) =>
    call<{ token: string; amountFormatted: string; purpose: string; expiresAt: string; simulated: boolean }>(
      `/cases/${caseId}/prepare-approval`,
      "POST",
      { amountRaw, purpose, reviewed: true, ...binding },
    ),
  recordDecision: (caseId: string, outcome: "no_refund" | "clarification_needed", reason: string, caseRevision: number, briefVersion: number, ledgerVersion?: number) =>
    call<unknown>(`/cases/${caseId}/decision`, "POST", { outcome, reason, caseRevision, briefVersion, ledgerVersion, reviewed: true }),
  confirm: (token: string) => call<{ operation: unknown; receipt: Receipt }>(`/approvals/${token}/confirm`, "POST", {}),
  reconcile: (opId: string) => call<{ operation: unknown; note?: string }>(`/operations/${opId}/reconcile`, "POST", {}),
  saveIssue: (caseId: string, issue: IssueInput, binding: LedgerBinding, replaces?: string) => call<unknown>(`/cases/${caseId}/issues${replaces ? '/'+replaces : ''}`, replaces ? 'PUT' : 'POST', {...binding, issue}),
  saveIssueReview: (caseId: string, recordId: string, review: ReviewInput, binding: LedgerBinding) => call<unknown>(`/cases/${caseId}/issues/${recordId}/reviews`, 'POST', {...binding, review}),
  exportUrl: (caseId: string, format: "json" | "text") => `/api/cases/${caseId}/export?format=${format}`,
};

export interface Receipt {
  simulated: boolean;
  heading: string;
  note: string;
  caseTitle: string;
  amountFormatted: string;
  state: string;
  refundId: string | null;
  upstreamStatus: string | null;
}
