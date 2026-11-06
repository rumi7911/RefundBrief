import { randomUUID, createHash } from 'node:crypto';
import { type DB, audit } from './db.ts';
import { IssueError, sourceDigest, validateIssues, validateIssueReview } from './domain/issues.ts';
import type { IssueDefinition, LedgerView, LedgerIssue, OwnerReview, DecisionEvidence, LedgerBinding, SnapshotSource } from '../shared/ledger';

type CaseIdentity={id:string;revision:number;brief_version:number};
/** Mutations run inside the caller's IMMEDIATE transaction with the decision write. */
export class IssueLedger {
 constructor(private db:DB){}
 private sources(c:CaseIdentity):SnapshotSource[]{
  return (this.db.prepare('SELECT id,title,kind,text FROM sources WHERE case_id=? ORDER BY sort_order,added_at').all(c.id) as Omit<SnapshotSource,'hash'>[]).map(s=>({...s,hash:sourceDigest(s)}));
 }
 version(c:CaseIdentity):number {return (this.db.prepare('SELECT ledger_version FROM cases WHERE id=?').get(c.id) as {ledger_version:number}).ledger_version;}
 assertBinding(c:CaseIdentity,binding:LedgerBinding):void{
  if(binding?.caseRevision!==c.revision||binding?.briefVersion!==c.brief_version||binding?.ledgerVersion!==this.version(c))throw new IssueError('The evidence, brief or issue review changed. Reload and review the current case.','ISSUE_STALE');
 }
 private assertBrief(c:CaseIdentity):void {
  if(!c.brief_version)return;
  const row=this.db.prepare('SELECT case_revision FROM briefs WHERE case_id=? AND version=?').get(c.id,c.brief_version) as {case_revision:number}|undefined;
  if(!row||row.case_revision!==c.revision)throw new IssueError('Refresh the stale brief before editing or reviewing issues.','ISSUE_STALE');
 }
 private evidence(c:CaseIdentity):SnapshotSource[]{
  const row=this.db.prepare('SELECT payload FROM brief_evidence WHERE case_id=? AND case_revision=? AND brief_version=?').get(c.id,c.revision,c.brief_version) as {payload:string}|undefined;
  if(row)return JSON.parse(row.payload);
  const sources=this.sources(c);
  this.db.prepare('INSERT INTO brief_evidence(case_id,case_revision,brief_version,payload) VALUES(?,?,?,?)').run(c.id,c.revision,c.brief_version,JSON.stringify(sources));
  return sources;
 }
 private advance(c:CaseIdentity):void {
  this.db.prepare('UPDATE cases SET ledger_version=ledger_version+1 WHERE id=?').run(c.id);
  this.db.prepare("UPDATE approvals SET status='invalidated' WHERE case_id=? AND status='prepared'").run(c.id);
  this.db.prepare('UPDATE case_decisions SET superseded=1 WHERE case_id=?').run(c.id);
 }
 registerBrief(c:CaseIdentity,issues:IssueDefinition[]|undefined):void {
  const sources=this.evidence(c);
  const prior=this.db.prepare('SELECT case_revision,brief_version FROM review_issues WHERE case_id=? ORDER BY rowid DESC LIMIT 1').get(c.id) as {case_revision:number;brief_version:number}|undefined;
  const carry=prior?this.view({id:c.id,revision:prior.case_revision,brief_version:prior.brief_version}).issues.filter(i=>i.review?.disposition!=='not_material'||i.caseRevision!==c.revision):[];
  if(carry.length+(issues?.length??0)>20)throw new IssueError('Too many carried and new issues. Explicitly review and mark irrelevant issues not material before regenerating.');
  const carriedIds=new Set(carry.map(i=>i.id));
  for(const old of carry){
    const relations=old.relations.filter(r=>sources.some(s=>s.id===r.sourceId&&s.hash===r.sourceHash)).map(r=>({...r,caseRevision:c.revision}));
    const missing=relations.length===old.relations.length?old.missing:[...old.missing.slice(0,7),'Earlier passages changed or were removed; inspect their historical originals and link current evidence.'];
    this.insert(c,{id:old.id,title:old.title,why:old.why,material:old.material,missing,relations,carriedFrom:old.recordId},'carried',old.version+1);
  }
  for(const issue of issues??[])this.insert(c,{...issue,id:carriedIds.has(issue.id)?`new-${randomUUID()}`:issue.id},'model',1);
  this.advance(c);
 }
 private insert(c:CaseIdentity,issue:IssueDefinition & {carriedFrom?:string},origin:'model'|'owner'|'carried',version:number):string{
  if(issue.relations.some(r=>!['supports','conflicts','context'].includes(r.role)))throw new IssueError('Relation role is invalid.');
  const id=`issue-${randomUUID()}`;
  this.db.prepare('INSERT INTO review_issues(record_id,case_id,case_revision,brief_version,issue_key,version,origin,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,c.id,c.revision,c.brief_version,issue.id,version,origin,JSON.stringify({...issue,relations:issue.relations.map(r=>({...r,role:'context'}))}),new Date().toISOString());
  return id;
 }
 private dto(row:any):LedgerIssue {
  const r=this.db.prepare('SELECT * FROM issue_reviews WHERE issue_record_id=? ORDER BY rowid DESC LIMIT 1').get(row.record_id) as any;
  const review:OwnerReview|null=r?{...JSON.parse(r.payload),id:r.id,issueRecordId:r.issue_record_id,createdAt:r.created_at}:null;
  return {...JSON.parse(row.payload),recordId:row.record_id,version:row.version,origin:row.origin,caseRevision:row.case_revision,briefVersion:row.brief_version,review};
 }
 view(c:CaseIdentity):LedgerView {
  const rows=this.db.prepare('SELECT * FROM review_issues WHERE case_id=? ORDER BY rowid').all(c.id) as any[];
  const current=new Map<string,LedgerIssue>();
  for(const row of rows)if(row.case_revision===c.revision&&row.brief_version===c.brief_version){const issue=this.dto(row);if(issue.review?.reviewContractVersion!==2)issue.review=null;current.set(row.issue_key,issue);}
  const brief=this.db.prepare('SELECT payload FROM briefs WHERE case_id=? AND version=?').get(c.id,c.brief_version) as {payload:string}|undefined;
  const structured=brief?Array.isArray(JSON.parse(brief.payload).issues):false;
  return {reviewContractVersion:2,enabled:rows.length>0||structured,version:this.version(c),issues:[...current.values()],history:rows.map(row=>this.dto(row)),reviews:this.reviewHistory(c.id) as OwnerReview[],stale:rows.length>0&&current.size===0};
 }
 changeIssue(c:CaseIdentity,raw:unknown,replaces?:string):LedgerIssue {
  this.assertBrief(c);
  let current=this.view(c);
  if(current.enabled&&!current.issues.length){this.registerBrief(c,undefined);current=this.view(c);}
  const old=replaces?current.issues.find(i=>i.recordId===replaces):null;
  if(replaces&&!old)throw new IssueError('Only the current issue version can be edited.','ISSUE_STALE');
  if(!replaces&&current.issues.length>=20)throw new IssueError('Review the existing issues; the case limit is twenty.');
  const [issue]=validateIssues([raw],this.evidence(c),c.revision);
  if(old&&old.id!==issue.id)throw new IssueError('The issue identity cannot change.');
  if(!old&&current.issues.some(i=>i.id===issue.id))throw new IssueError('Issue identity is duplicate.');
  const id=this.insert(c,issue,'owner',old?old.version+1:1);
  this.advance(c);audit(this.db,c.id,'issue_recorded',{recordId:id,issueId:issue.id,replaces:replaces??null});
  return this.view(c).issues.find(i=>i.recordId===id)!;
 }
 saveReview(c:CaseIdentity,recordId:string,raw:unknown):OwnerReview {
  this.assertBrief(c);
  const issue=this.view(c).issues.find(i=>i.recordId===recordId);
  if(!issue)throw new IssueError('Only the current issue version can be reviewed.','ISSUE_STALE');
  const input={...validateIssueReview(raw,issue),reviewContractVersion:2};
  const id=`review-${randomUUID()}`,createdAt=new Date().toISOString();
  this.db.prepare('INSERT INTO issue_reviews(id,issue_record_id,payload,created_at) VALUES(?,?,?,?)').run(id,recordId,JSON.stringify(input),createdAt);
  this.advance(c);audit(this.db,c.id,'issue_reviewed',{reviewId:id,issueRecordId:recordId,disposition:input.disposition});
  return {...input,id,issueRecordId:recordId,createdAt};
 }
 prepareSnapshot(c:CaseIdentity,binding:LedgerBinding):DecisionEvidence|null {
  const view=this.view(c);if(!view.enabled)return null;
  this.assertBinding(c,binding);this.assertBrief(c);
  if(!view.issues.length||view.issues.some(i=>!i.review))throw new IssueError('Record an owner review for every current issue, including unresolved or not-material issues.','ISSUE_REVIEW_REQUIRED');
  const sources=this.evidence(c),current=this.sources(c);
  if(sources.length!==current.length||sources.some(s=>!current.some(now=>now.id===s.id&&now.hash===s.hash)))throw new IssueError('Original evidence changed without a matching revision. Refresh the case.','ISSUE_STALE');
  for(const issue of view.issues)for(const r of issue.relations){
    const source=sources.find(s=>s.id===r.sourceId);
    if(!source||source.hash!==r.sourceHash||r.caseRevision!==c.revision||source.text.slice(r.offset,r.offset+r.quote.length)!==r.quote)throw new IssueError('An issue passage does not match its immutable source basis.','ISSUE_STALE');
  }
  const snapshot:DecisionEvidence={reviewContractVersion:2,caseRevision:c.revision,briefVersion:c.brief_version,ledgerVersion:view.version,sources,issues:view.issues,unresolvedIssueIds:view.issues.filter(i=>i.review?.disposition==='unresolved'||i.review?.disposition==='owner_judgement').map(i=>i.id)};
  snapshot.basisHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return snapshot;
 }
 saveSnapshot(id:string,type:'decision'|'approval',c:CaseIdentity,snapshot:DecisionEvidence|null):void {
  if(snapshot)this.db.prepare('INSERT INTO decision_evidence(id,record_type,case_id,payload,created_at) VALUES(?,?,?,?,?)').run(id,type,c.id,JSON.stringify(snapshot),new Date().toISOString());
 }
 snapshot(id:string):DecisionEvidence|null {const row=this.db.prepare('SELECT payload FROM decision_evidence WHERE id=?').get(id) as {payload:string}|undefined;return row?JSON.parse(row.payload):null;}
 snapshots(caseId:string):unknown[]{return (this.db.prepare('SELECT * FROM decision_evidence WHERE case_id=? ORDER BY rowid').all(caseId) as any[]).map(row=>({id:row.id,recordType:row.record_type,createdAt:row.created_at,data:JSON.parse(row.payload)}));}
 evidenceHistory(caseId:string):unknown[]{return (this.db.prepare('SELECT * FROM brief_evidence WHERE case_id=? ORDER BY rowid').all(caseId) as any[]).map(row=>({caseRevision:row.case_revision,briefVersion:row.brief_version,sources:JSON.parse(row.payload)}));}
 reviewHistory(caseId:string):unknown[]{return (this.db.prepare('SELECT r.* FROM issue_reviews r JOIN review_issues i ON i.record_id=r.issue_record_id WHERE i.case_id=? ORDER BY r.rowid').all(caseId) as any[]).map(row=>({id:row.id,issueRecordId:row.issue_record_id,createdAt:row.created_at,...JSON.parse(row.payload)}));}
}
