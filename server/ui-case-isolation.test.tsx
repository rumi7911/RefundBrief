import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { App } from "../src/App";
import type { CaseDetail } from "../src/types";

const api = vi.hoisted(() => ({
  status: vi.fn(), listCases: vi.fn(), getCase: vi.fn(), loadExample: vi.fn(),
  prepareApproval: vi.fn(), confirm: vi.fn(), reconcile: vi.fn(), recordDecision: vi.fn(), exportUrl: vi.fn(() => "/export"),
}));
vi.mock("../src/api", () => ({ api, ApiError: class ApiError extends Error {} }));

function fixture(id: string): CaseDetail {
  return {
    id, title: `Case ${id}`, isSample: true, customerName: null, amountFormatted: "45.00",
    currency: "GBP", revision: 1, briefVersion: 1, captureId: `sample-${id}`, merchantId: "sample",
    paidAt: null, captureStatus: "COMPLETED", remainingRefundableFormatted: "45.00",
    sources: [], operations: [], approval: null, exampleAvailable: true,
    brief: { version: 1, kind: "example", caseRevision: 1, stale: false,
      data: { summary: `Evidence for ${id}`, timeline: [], uncertainties: [], questions: [] } },
  };
}
const cases = [fixture("A"), fixture("B"), fixture("C")];
let view: ReactTestRenderer;
function text(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === "string" ? child : text(child)).join("");
}
function button(name: string) {
  return view.root.findAllByType("button").find(node => text(node).trim() === name)!;
}
async function clickCase(id: string) {
  await act(async () => {
    view.root.findAllByType("button").find(node =>
      node.props.className?.startsWith("caseitem") && text(node).startsWith(`Case ${id}`))!.props.onClick();
  });
}
async function enterDecision() {
  await act(async () => {
    view.root.findByProps({ id: "amt" }).props.onChange({ target: { value: "17.00" } });
    view.root.findByProps({ id: "reason" }).props.onChange({ target: { value: "Only for case A" } });
    view.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } });
  });
}
function expectBlank() {
  expect(view.root.findByProps({ id: "amt" }).props.value).toBe("");
  expect(view.root.findByProps({ id: "reason" }).props.value).toBe("");
  expect(view.root.findByProps({ type: "checkbox" }).props.checked).toBe(false);
  expect(button("Review refund").props.disabled).toBe(true);
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { hash: "" } });
  api.status.mockResolvedValue({ mode: "sandbox", paypal: { configured: false }, ai: { enabled: false } });
  api.listCases.mockResolvedValue({ cases });
  api.getCase.mockImplementation(async (id: string) => structuredClone(cases.find(c => c.id === id)!));
  api.loadExample.mockResolvedValue({});
  await act(async () => { view = create(<App />); });
});
afterEach(async () => {
  await act(async () => { view.unmount(); });
  vi.unstubAllGlobals();
});

test("switching cases clears amount, reason and evidence-review consent", async () => {
  await enterDecision();
  expect(button("Review refund").props.disabled).toBe(false);
  await clickCase("B");
  expectBlank();
  expect(api.prepareApproval).not.toHaveBeenCalled();
});

test("a pending case switch removes the old decision before the new case arrives", async () => {
  await enterDecision();
  let resolveB!: (value: CaseDetail) => void;
  api.getCase.mockImplementation((id: string) => id === "B"
    ? new Promise<CaseDetail>(resolve => { resolveB = resolve; }) : Promise.resolve(fixture(id)));
  await clickCase("B");
  expect(view.root.findAllByProps({ id: "amt" })).toHaveLength(0);
  expect(view.root.findAllByType("h1").map(text)).not.toContain("Case A");
  await act(async () => { resolveB(fixture("B")); });
  expectBlank();
});

test("late case responses cannot replace the most recently selected case", async () => {
  const pending = new Map<string, (value: CaseDetail) => void>();
  api.getCase.mockImplementation((id: string) => new Promise<CaseDetail>(resolve => { pending.set(id, resolve); }));
  await clickCase("B");
  await clickCase("C");
  await act(async () => { pending.get("C")!(fixture("C")); });
  await act(async () => { pending.get("B")!(fixture("B")); });
  expect(view.root.findAllByType("h1").map(text)).toContain("Case C");
  expect(view.root.findAllByType("h1").map(text)).not.toContain("Case B");
  expectBlank();
});

test("a refreshed brief requires a new decision and review consent", async () => {
  await enterDecision();
  const refreshed = fixture("A");
  refreshed.briefVersion = 2;
  refreshed.brief!.version = 2;
  api.getCase.mockResolvedValue(refreshed);
  await act(async () => { button("Load example brief").props.onClick(); });
  expectBlank();
});

test("an old mutation refresh cannot cancel the newly selected case load", async () => {
  let finishExample!: () => void;
  let finishB!: (value: CaseDetail) => void;
  api.loadExample.mockImplementation(() => new Promise<void>(resolve => { finishExample = resolve; }));
  await act(async () => { button("Load example brief").props.onClick(); });
  api.getCase.mockImplementation((id: string) => id === "B"
    ? new Promise<CaseDetail>(resolve => { finishB = resolve; }) : Promise.resolve(fixture(id)));
  await clickCase("B");
  await act(async () => { finishExample(); });
  await act(async () => { finishB(fixture("B")); });
  expect(view.root.findAllByType("h1").map(text)).toContain("Case B");
  expectBlank();
});

test("returning to the same case still ignores its older request", async () => {
  const pending = new Map<string, Array<(value: CaseDetail) => void>>();
  api.getCase.mockImplementation((id: string) => new Promise<CaseDetail>(resolve => {
    pending.set(id, [...pending.get(id) ?? [], resolve]);
  }));
  await clickCase("B");
  await clickCase("A");
  await clickCase("C");
  await clickCase("A");
  const latest = fixture("A");
  latest.brief!.data.summary = "Latest A evidence";
  await act(async () => { pending.get("A")![1](latest); });
  await act(async () => { pending.get("A")![0](fixture("A")); });
  expect(view.root.findAllByType("p").map(text)).toContain("Latest A evidence");
});

async function openConfirmation() {
  await enterDecision();
  const prepared = fixture("A");
  prepared.approval = { token: "approval-A", amountFormatted: "17.00", purpose: "Only for case A", expiresAt: "2026-11-02T12:00:00Z" };
  api.getCase.mockResolvedValue(prepared);
  await act(async () => { button("Review refund").props.onClick(); });
  await act(async () => { button("Confirm simulated refund").props.onClick(); });
  return view.root.findByProps({ role: "dialog" }).findAllByType("button")
    .find(node => text(node).trim() === "Confirm simulated refund")!.props.onClick;
}

test("clearing a prepared approval cannot restore a previously checked decision", async () => {
  const confirm = await openConfirmation();
  api.getCase.mockResolvedValue(fixture("A"));
  api.confirm.mockResolvedValue({ receipt: { simulated: true, heading: "Simulated receipt", note: "Test only", amountFormatted: "17.00", state: "completed" } });
  await act(async () => { confirm(); });
  expectBlank();
});

test('a rejected confirmation refreshes the operation and removes consumed consent',async()=>{
  const confirm=await openConfirmation();const refused=fixture('A');refused.operations=[{id:'refused-A',state:'refused',simulated:false,amountFormatted:'17.00',refundId:null,upstreamStatus:null,detail:'No request sent',createdAt:'2026-11-04T23:00:00Z'}];
  api.getCase.mockResolvedValue(refused);api.confirm.mockRejectedValue(new Error('Final recheck failed'));
  await act(async()=>{confirm();});
  expect(view.root.findAllByProps({role:'dialog'})).toHaveLength(0);
  expect(text(view.root.findByProps({'aria-label':'Workflow status'}))).toContain('Refund refused');
});

test("a confirmation callback retained from an old case cannot submit after navigation", async () => {
  const confirm = await openConfirmation();
  api.getCase.mockResolvedValue(fixture("B"));
  await clickCase("B");
  await act(async () => { confirm(); });
  expect(api.confirm).not.toHaveBeenCalled();
});

test("a reconciliation callback retained from an old case cannot run after navigation", async () => {
  const old = fixture("A");
  old.operations = [{ id: "op-A", state: "unknown", simulated: false, amountFormatted: "17.00", refundId: "refund-A", upstreamStatus: "UNKNOWN", detail: null, createdAt: "2026-11-02T10:00:00Z" }];
  api.getCase.mockResolvedValue(old);
  await act(async () => { button("Load example brief").props.onClick(); });
  const reconcile = button("Check / reconcile status").props.onClick;
  api.getCase.mockResolvedValue(fixture("B"));
  await clickCase("B");
  await act(async () => { reconcile(); });
  expect(api.reconcile).not.toHaveBeenCalled();
});

test("an ambiguous refund is never presented as no refund sent", async () => {
  const uncertain = fixture("A");
  uncertain.operations = [{ id: "op-A", state: "unknown", simulated: false, amountFormatted: "17.00", refundId: null, upstreamStatus: null, detail: "Timeout", createdAt: "2026-11-02T10:00:00Z" }];
  api.getCase.mockResolvedValue(uncertain);
  await act(async () => { button("Load example brief").props.onClick(); });
  const status = text(view.root.findByProps({ "aria-label": "Workflow status" }));
  expect(status).toContain("Refund outcome unknown");
  expect(status).not.toContain("No refund sent");
});

test("stale evidence is not labelled reviewed in the workspace status", async () => {
  const stale = fixture("A");
  stale.brief!.stale = true;
  stale.revision = 2;
  api.getCase.mockResolvedValue(stale);
  await act(async () => { button("Load example brief").props.onClick(); });
  const status = text(view.root.findByProps({ "aria-label": "Workflow status" }));
  expect(status).toContain("Brief stale");
  expect(status).not.toContain("Evidence reviewed");
});

test("owner can record clarification with a reason and fresh consent without a refund", async () => {
  await act(async () => { view.root.findByProps({ id: "outcome" }).props.onChange({ target: { value: "clarification_needed" } }); });
  expect(button("Record clarification needed").props.disabled).toBe(true);
  await act(async () => {
    view.root.findByProps({ id: "decision-note" }).props.onChange({ target: { value: "Please confirm the cancellation timestamp." } });
    view.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } });
  });
  await act(async () => { button("Record clarification needed").props.onClick(); });
  expect(api.recordDecision).toHaveBeenCalledWith("A", "clarification_needed", "Please confirm the cancellation timestamp.", 1, 1, undefined);
  expect(api.prepareApproval).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();
});

test("changing outcome clears financial inputs and prior review consent", async () => {
  await enterDecision();
  await act(async () => { view.root.findByProps({ id: "outcome" }).props.onChange({ target: { value: "no_refund" } }); });
  expect(view.root.findByProps({ type: "checkbox" }).props.checked).toBe(false);
  await act(async () => { view.root.findByProps({ id: "outcome" }).props.onChange({ target: { value: "refund" } }); });
  expectBlank();
});

test("an unverified case never displays a zero amount as paid", async () => {
  const unknown = fixture("B");
  unknown.isSample = false; unknown.amountFormatted = null; unknown.captureStatus = "UNVERIFIED";
  api.getCase.mockResolvedValue(unknown);
  await clickCase("B");
  expect(text(view.root.findByProps({ "aria-label": "Captured payment" }))).toContain("Payment unverified");
  expect(text(view.root.findByProps({ "aria-label": "Captured payment" }))).not.toContain("paid");
});

test('legacy ledger introduction and brief have distinct reconciliation identities',async()=>{
  const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
    const legacy=fixture('A');legacy.ledger={enabled:false,version:0,issues:[],history:[],reviews:[],stale:false};
    api.getCase.mockResolvedValue(legacy);
    await act(async()=>{button('Load example brief').props.onClick();});
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Encountered two children with the same key');
  }finally{errors.mockRestore();}
});

test.each(["preparing", "pending", "unknown", "completed", "refused"] as const)(
  "a %s refund operation is not presented as a decision still awaiting entry", async state => {
    const decided = fixture("B");
    decided.operations = [{ id: "op-B", state, simulated: false, amountFormatted: "1.00",
      refundId: state === "completed" ? "refund-B" : null, upstreamStatus: null, detail: null,
      createdAt: "2026-11-03T16:11:28Z" }];
    api.getCase.mockResolvedValue(decided);
    await clickCase("B");
    const status = text(view.root.findByProps({ "aria-label": "Workflow status" }));
    expect(status).toContain("Refund decision recorded");
    expect(status).not.toContain("Decision pending");
  },
);

test('confirmation exposes the selected cited basis and requests heading focus',async()=>{
 await enterDecision();const prepared=fixture('A');
 prepared.approval={token:'basis-A',amountFormatted:'17.00',purpose:'QA',expiresAt:'2026-11-12T12:00:00Z',decisionEvidence:{caseRevision:1,briefVersion:1,ledgerVersion:1,sources:[],unresolvedIssueIds:[],issues:[{recordId:'i',title:'Which policy?',review:{disposition:'evidence_resolved',interpretation:'Owner conclusion',resolvedBy:1},relations:[{quote:'Not selected',sourceTitle:'A'},{quote:'Chosen exact passage',sourceTitle:'Selected policy'}]} as any]}};
 api.getCase.mockResolvedValue(prepared);await act(async()=>button('Review refund').props.onClick());await act(async()=>button('Confirm simulated refund').props.onClick());
 const dialog=view.root.findByProps({role:'dialog'});expect(text(dialog)).toContain('Chosen exact passage');expect(text(dialog)).toContain('Selected policy');expect(text(dialog)).not.toContain('Not selected');expect(view.root.findByProps({id:'cf-h'}).props.tabIndex).toBe(-1);
});

test.each([
 {demo:true,present:true,sample:true,expected:'ledger-policy-conflict'},
 {demo:false,present:true,sample:true,expected:'A'},
 {demo:true,present:false,sample:true,expected:'A'},
 {demo:true,present:true,sample:false,expected:'A'},
])('initial case respects demo boundary and missing-fixture fallback: $demo/$present/$sample',async({demo,present,sample,expected})=>{
 await act(async()=>view.unmount());vi.clearAllMocks();
 const judge={...fixture('ledger-policy-conflict'),isSample:sample};const available=present?[...cases,judge]:cases;
 api.status.mockResolvedValue({demoMode:demo,mode:'sandbox',paypal:{configured:false},ai:{enabled:false}});
 api.listCases.mockResolvedValue({cases:available});api.getCase.mockImplementation(async(id:string)=>structuredClone(available.find(c=>c.id===id)!));
 await act(async()=>{view=create(<App/>);});expect(api.getCase).toHaveBeenCalledTimes(1);expect(api.getCase).toHaveBeenCalledWith(expected);
});
