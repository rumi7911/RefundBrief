import { afterEach, expect, test } from 'vitest';
import { openDb, withImmediateTx, activateReviewContractV2 } from './db';
import { IssueLedger } from './issue-ledger';
const db=openDb(':memory:');
const ledger=new IssueLedger(db);
let n=0;
function setup(){const id=`test-${++n}`;db.prepare(`INSERT INTO cases(id,title,capture_id,merchant_id,capture_amount_pennies,revision,brief_version,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(id,'Fictional','cap-'+id,'merchant',1000,1,1,'now');db.prepare('INSERT INTO sources(id,case_id,title,kind,text,sort_order,added_at) VALUES(?,?,?,?,?,?,?)').run('src-'+id,id,'Policy','policy','Accepted version is absent.',0,'now');db.prepare('INSERT INTO briefs(id,case_id,version,case_revision,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)').run('brief-'+id,id,1,1,'example','{}','now');return db.prepare('SELECT * FROM cases WHERE id=?').get(id) as any;}
function identity(c:any){const fresh=db.prepare('SELECT * FROM cases WHERE id=?').get(c.id) as any;return {caseRevision:fresh.revision,briefVersion:fresh.brief_version,ledgerVersion:fresh.ledger_version};}
function add(c:any){return withImmediateTx(db,()=>ledger.changeIssue(c,{id:'policy',title:'Which terms applied?',why:'No acceptance record',missing:['Accepted version'],relations:[]}));}
afterEach(()=>{});
test('unreviewed issues prevent a decision snapshot; explicit unresolved review permits owner judgement without resolving facts',()=>{
 const c=setup();const issue=add(c);
 expect(()=>ledger.prepareSnapshot(c,identity(c))).toThrow(/review/i);
 withImmediateTx(db,()=>ledger.saveReview(c,issue.recordId,{interpretation:'Acceptance remains absent; ask for it',disposition:'unresolved',consideredRelations:[]}));
 const snapshot=ledger.prepareSnapshot(c,identity(c))!;
 expect(snapshot.unresolvedIssueIds).toEqual(['policy']);expect(snapshot.sources[0].text).toBe('Accepted version is absent.');
 ledger.saveSnapshot('decision-test','decision',c,snapshot);
 const before=JSON.stringify(ledger.snapshots(c.id));
 withImmediateTx(db,()=>ledger.saveReview(c,issue.recordId,{interpretation:'Goodwill despite missing acceptance',disposition:'owner_judgement',consideredRelations:[]}));
 expect(JSON.stringify(ledger.snapshots(c.id))).toBe(before);
});
test('editing an issue appends a version, drops current review, and invalidates prepared approvals',()=>{
 const c=setup(), issue=add(c);
 withImmediateTx(db,()=>ledger.saveReview(c,issue.recordId,{interpretation:'Unknown',disposition:'unresolved',consideredRelations:[]}));
 db.prepare(`INSERT INTO approvals(token,case_id,case_revision,brief_version,capture_id,merchant_id,amount_pennies,currency,purpose,created_at_ms,expires_at_ms,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared')`).run('token-'+c.id,c.id,1,1,c.capture_id,'merchant',100,'GBP','test',0,9999999999999);
 withImmediateTx(db,()=>ledger.changeIssue(c,{id:'policy',title:'Revised question',why:'Still missing',missing:['Acceptance'],relations:[]},issue.recordId));
 expect(ledger.view(c).issues[0].version).toBe(2);expect(ledger.view(c).issues[0].review).toBeNull();
 expect((db.prepare('SELECT status FROM approvals WHERE token=?').get('token-'+c.id) as any).status).toBe('invalidated');
 expect(()=>ledger.saveReview(c,issue.recordId,{interpretation:'Old row',disposition:'unresolved',consideredRelations:[]})).toThrow(/current/i);
 expect(ledger.view(c).history).toHaveLength(2);
});
test('stale case/brief/ledger bindings reject review and retain original evidence in history',()=>{
 const c=setup(), issue=add(c), old=identity(c);
 withImmediateTx(db,()=>ledger.saveReview(c,issue.recordId,{interpretation:'Missing',disposition:'unresolved',consideredRelations:[]}));
 expect(()=>ledger.prepareSnapshot(c,old)).toThrow(/changed/i);
 db.prepare('UPDATE cases SET revision=2 WHERE id=?').run(c.id);
 const fresh=db.prepare('SELECT * FROM cases WHERE id=?').get(c.id) as any;
 expect(ledger.view(fresh).issues).toHaveLength(0);expect(ledger.view(fresh).history[0].caseRevision).toBe(1);
 expect(()=>ledger.changeIssue(fresh,{id:'new',title:'New',why:'New',missing:[],relations:[]})).toThrow(/brief/i);
});

test('regeneration cannot silently omit a prior owner issue, even when its supporting source changes',()=>{
 const c=setup(),issue=add(c);
 withImmediateTx(db,()=>ledger.saveReview(c,issue.recordId,{interpretation:'Need the accepted policy',disposition:'unresolved',consideredRelations:[]}));
 db.prepare('UPDATE cases SET brief_version=2,revision=2 WHERE id=?').run(c.id);
 db.prepare('UPDATE sources SET text=? WHERE case_id=?').run('New source text without accepted terms.',c.id);
 db.prepare('INSERT INTO briefs(id,case_id,version,case_revision,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)').run('brief2-'+c.id,c.id,2,2,'example','{}','now');
 const fresh=db.prepare('SELECT * FROM cases WHERE id=?').get(c.id) as any;
 withImmediateTx(db,()=>ledger.registerBrief(fresh,[{id:'other',title:'Other model issue',why:'Different concern',material:true,missing:[],relations:[]}]));
 const current=ledger.view(fresh).issues;
 expect(current.find(i=>i.id===issue.id)).toBeDefined();expect(current.find(i=>i.id===issue.id)?.review).toBeNull();
 expect(()=>ledger.prepareSnapshot(fresh,identity(fresh))).toThrow(/review/i);
});

test('an owner dismissal cannot silently survive changed evidence',()=>{
 const c=setup(),issue=add(c);
 withImmediateTx(db,()=>ledger.saveReview(c,issue.recordId,{interpretation:'Not material under these records',disposition:'not_material',consideredRelations:[]}));
 db.prepare('UPDATE cases SET revision=2,brief_version=2 WHERE id=?').run(c.id);
 db.prepare('INSERT INTO briefs(id,case_id,version,case_revision,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)').run('second-'+c.id,c.id,2,2,'example','{}','now');
 const fresh=db.prepare('SELECT * FROM cases WHERE id=?').get(c.id) as any;
 withImmediateTx(db,()=>ledger.registerBrief(fresh,undefined));
 expect(ledger.view(fresh).issues.find(i=>i.id===issue.id)?.review).toBeNull();
});
test('a structured brief missing its persisted issue rows fails closed',()=>{
 const c=setup();db.prepare('UPDATE briefs SET payload=? WHERE case_id=?').run(JSON.stringify({issues:[]}),c.id);
 expect(ledger.view(c).enabled).toBe(true);expect(()=>ledger.prepareSnapshot(c,identity(c))).toThrow(/review/i);
});
test('stored issue/review/decision bases reject update and deletion through SQLite',()=>{
 const c=setup(),issue=add(c);
 expect(()=>db.prepare('UPDATE review_issues SET payload=? WHERE record_id=?').run('{}',issue.recordId)).toThrow(/immutable/i);
 expect(()=>db.prepare('DELETE FROM review_issues WHERE record_id=?').run(issue.recordId)).toThrow(/immutable/i);
});

test('contract cutover is atomic/idempotent, hides legacy acknowledgement only in current view and preserves all original bytes',()=>{
 const c=setup(),issue=add(c);
 const payload=JSON.stringify({interpretation:'Historical conclusion',disposition:'evidence_resolved',consideredRelations:[],resolvedBy:null});
 db.prepare('INSERT INTO issue_reviews VALUES(?,?,?,?)').run('legacy-'+c.id,issue.recordId,payload,'then');
 db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run('old-'+c.id,c.id,1,1,c.capture_id,'merchant',100,'GBP','old',0,9999999999999,'prepared');
 db.prepare('INSERT INTO case_decisions VALUES(?,?,?,?,?,?,?,?)').run('outcome-'+c.id,c.id,1,1,'clarification_needed','old',0,0);
 db.prepare('INSERT INTO decision_evidence VALUES(?,?,?,?,?)').run('snap-'+c.id,'approval',c.id,'{"ledgerVersion":1,"basisHash":"original"}','then');
 db.prepare('INSERT INTO operations(id,case_id,capture_id,approval_token,request_id,amount_pennies,currency,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)').run('payment-'+c.id,c.id,c.capture_id,'done-'+c.id,'key',100,'GBP','completed',0,0);
 const raw=()=>JSON.stringify(['review_issues','issue_reviews','decision_evidence','operations'].map(t=>db.prepare('SELECT * FROM '+t).all()));
 const before=raw(),version=ledger.version(c);
 db.prepare("DELETE FROM audit_log WHERE event='review_contract_v2_activated'").run();
 activateReviewContractV2(db);
 expect(ledger.version(c)).toBe(version+1);expect(ledger.view(c).reviewContractVersion).toBe(2);
 expect(ledger.view(c).issues[0].review).toBeNull();expect(ledger.view(c).history[0].review?.interpretation).toBe('Historical conclusion');
 expect(ledger.view(c).reviews?.[0].reviewContractVersion).toBeUndefined();expect(raw()).toBe(before);
 expect((db.prepare('SELECT status FROM approvals WHERE token=?').get('old-'+c.id) as any).status).toBe('invalidated');
 expect((db.prepare('SELECT superseded FROM case_decisions WHERE id=?').get('outcome-'+c.id) as any).superseded).toBe(1);
 activateReviewContractV2(db);expect(ledger.version(c)).toBe(version+1);expect(raw()).toBe(before);
 expect(()=>ledger.prepareSnapshot(c,identity(c))).toThrow(/review/i);
 const review=withImmediateTx(db,()=>ledger.saveReview(c,issue.recordId,{interpretation:'Fresh review',disposition:'unresolved',consideredRelations:[]}));
 expect(review.reviewContractVersion).toBe(2);expect(ledger.prepareSnapshot(c,identity(c))?.reviewContractVersion).toBe(2);
 expect(ledger.view(c).reviews).toHaveLength(2);
});
test('carried and directly registered new issue versions neutralise old roles without changing old rows',()=>{
 const c=setup();const rel={sourceId:'src-'+c.id,quote:'Accepted',offset:0,sourceTitle:'Policy',sourceHash:'historical',caseRevision:1,role:'supports' as const};
 withImmediateTx(db,()=>ledger.registerBrief(c,[{id:'model',title:'Policy?',why:'Unknown',missing:[],material:true,relations:[rel]}]));
 expect(ledger.view(c).issues[0].relations[0].role).toBe('context');
});
