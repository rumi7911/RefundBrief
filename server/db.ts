// Durable storage on node:sqlite (built-in). One SQLite file under .data/.
// The file is git-ignored and never contains secrets. A single connection is
// used; write transactions use BEGIN IMMEDIATE so concurrent double-submits
// serialise and cannot create two differing refund requests.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

// node:sqlite is a recent Node builtin that some bundlers (Vite/vitest) fail to
// resolve statically, so we load it at runtime via createRequire — invisible to
// static analysis and identical to a normal import at run time.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export type DB = InstanceType<typeof DatabaseSync>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brief_evidence (
 case_id TEXT NOT NULL REFERENCES cases(id), case_revision INTEGER NOT NULL, brief_version INTEGER NOT NULL,
 payload TEXT NOT NULL, PRIMARY KEY(case_id,case_revision,brief_version)
);
CREATE TABLE IF NOT EXISTS review_issues (
 record_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), case_revision INTEGER NOT NULL,
 brief_version INTEGER NOT NULL, issue_key TEXT NOT NULL, version INTEGER NOT NULL, origin TEXT NOT NULL,
 payload TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(case_id,case_revision,brief_version,issue_key,version)
);
CREATE TABLE IF NOT EXISTS issue_reviews (
 id TEXT PRIMARY KEY, issue_record_id TEXT NOT NULL REFERENCES review_issues(record_id), payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decision_evidence (
 id TEXT PRIMARY KEY, record_type TEXT NOT NULL, case_id TEXT NOT NULL REFERENCES cases(id), payload TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  is_sample INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT,
  capture_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  paid_pennies INTEGER,
  capture_amount_pennies INTEGER NOT NULL,
  capture_status TEXT NOT NULL DEFAULT 'COMPLETED',
  paid_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  brief_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  case_revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  token TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  case_revision INTEGER NOT NULL,
  brief_version INTEGER NOT NULL,
  capture_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  amount_pennies INTEGER NOT NULL,
  currency TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared'
);
CREATE TABLE IF NOT EXISTS case_decisions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  case_revision INTEGER NOT NULL,
  brief_version INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('no_refund','clarification_needed')),
  reason TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  capture_id TEXT NOT NULL,
  approval_token TEXT NOT NULL,
  request_id TEXT NOT NULL,
  amount_pennies INTEGER NOT NULL,
  currency TEXT NOT NULL,
  state TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0,
  refund_id TEXT,
  upstream_status TEXT,
  detail TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
-- At most one non-refused operation may be bound to a given approval token.
CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_token ON operations(approval_token);
CREATE INDEX IF NOT EXISTS idx_operations_capture ON operations(capture_id);
CREATE INDEX IF NOT EXISTS idx_sources_case ON sources(case_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT
);
`;

export function openDb(filePath: string): DB {
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Additive migration: preserve all existing case/source/payment data.
  const columns = db.prepare('PRAGMA table_info(cases)').all() as { name:string }[];
  if (!columns.some(column=>column.name==='ledger_version')) db.exec('ALTER TABLE cases ADD COLUMN ledger_version INTEGER NOT NULL DEFAULT 0');
  for (const table of ['brief_evidence','review_issues','issue_reviews','decision_evidence']) {
    for (const action of ['UPDATE','DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'Immutable evidence record'); END;`);
  }
  activateReviewContractV2(db);
  return db;
}

/** Run fn inside an IMMEDIATE (write-reserving) transaction. */
export function withImmediateTx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (e) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function audit(db: DB, caseId: string | null, event: string, detail?: unknown): void {
  db.prepare("INSERT INTO audit_log (case_id, at, event, detail) VALUES (?, ?, ?, ?)").run(
    caseId,
    new Date().toISOString(),
    event,
    detail === undefined ? null : JSON.stringify(detail),
  );
}

/** One-time contract cutover. Immutable payloads and all payment operations stay unchanged. */
export function activateReviewContractV2(db:DB):void {
 withImmediateTx(db,()=>{
  if(db.prepare("SELECT id FROM audit_log WHERE event='review_contract_v2_activated' AND case_id IS NULL").get())return;
  const cases=db.prepare('SELECT DISTINCT case_id FROM review_issues').all() as {case_id:string}[];
  for(const {case_id} of cases){
   db.prepare('UPDATE cases SET ledger_version=ledger_version+1 WHERE id=?').run(case_id);
   db.prepare("UPDATE approvals SET status='invalidated' WHERE case_id=? AND status='prepared'").run(case_id);
   db.prepare('UPDATE case_decisions SET superseded=1 WHERE case_id=? AND superseded=0').run(case_id);
   audit(db,case_id,'review_contract_v2_case_invalidated',{reviewContractVersion:2});
  }
  audit(db,null,'review_contract_v2_activated',{reviewContractVersion:2,affectedCases:cases.length});
 });
}
