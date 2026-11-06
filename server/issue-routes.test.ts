import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app';
import { resetSessions } from './security';
let built:ReturnType<typeof createApp>,server:any,origin:string,dir:string,headers:Record<string,string>;
let captureGate:Promise<void>|null=null,onCapture=()=>{},refundPosts=0;
let tokenGate:Promise<void>|null=null,onToken=()=>{},tokenRequests=0;
const id='sample-deep-clean',base=`/api/cases/${id}`;
async function get(){return (await fetch(origin+base)).json();}
async function send(path:string,body:any,method='POST'){return fetch(origin+path,{method,headers,body:JSON.stringify(body)});}
function binding(c:any){return {caseRevision:c.revision,briefVersion:c.briefVersion,ledgerVersion:c.ledger.version};}
async function add(){const c=await get();const r=await send(base+'/issues',{...binding(c),issue:{title:'Which accepted terms governed?',why:'Acceptance record is missing',missing:['Accepted terms'],relations:[]}});expect(r.status).toBe(201);return (await r.json()).issue;}
async function review(issue:any){const c=await get();const r=await send(base+`/issues/${issue.recordId}/reviews`,{...binding(c),review:{interpretation:'Terms still unknown; goodwill is owner discretion',disposition:'owner_judgement',consideredRelations:[]}});expect(r.status).toBe(201);}
beforeEach(async()=>{
 captureGate=null;onCapture=()=>{};refundPosts=0;tokenGate=null;onToken=()=>{};tokenRequests=0;
 resetSessions();dir=mkdtempSync(join(tmpdir(),'rb-ledger-'));
 built=createApp({dbFile:':memory:',paypalFetch:async(url)=>{
  const path=String(url);
  if(path.endsWith('/v1/oauth2/token')){tokenRequests++;if(tokenGate&&tokenRequests>=3){onToken();await tokenGate;}return Response.json({access_token:'fake-token',expires_in:3600});}
  if(path.endsWith('/refund')){refundPosts++;return Response.json({id:'FAKE-REFUND',status:'COMPLETED'});}
  if(path.includes('/v2/payments/captures/')){onCapture();if(captureGate)await captureGate;return Response.json({id:path.split('/').pop(),status:'COMPLETED',amount:{value:'180.00',currency_code:'GBP'},payee:{merchant_id:'M'}});}
  return Response.json({}, {status:500});
 },config:{port:4100,host:'127.0.0.1',dataDir:dir,paypal:{configured:false,baseUrl:'https://api-m.sandbox.paypal.com'},ai:{enabled:false}},serveStatic:false});
 await new Promise<void>(r=>{server=built.app.listen(0,'127.0.0.1',r);});origin=`http://127.0.0.1:${server.address().port}`;
 const res=await fetch(origin+'/api/session');const body=await res.json();headers={'content-type':'application/json',cookie:res.headers.get('set-cookie')!.split(';')[0],'x-rb-csrf':body.csrfToken};
});
afterEach(async()=>{await new Promise<void>(r=>server.close(r));built.db.close();rmSync(dir,{recursive:true,force:true});});
test('new issues cannot silently become reviewed; snapshot survives later review changes and export',async()=>{
 const issue=await add();let c=await get();
 expect((await send(base+'/prepare-approval',{amountRaw:'1.00',purpose:'Goodwill',reviewed:true,...binding(c)})).status).toBe(422);
 await review(issue);c=await get();
 const prep=await send(base+'/prepare-approval',{amountRaw:'1.00',purpose:'Goodwill despite missing terms',reviewed:true,...binding(c)});expect(prep.status).toBe(200);const approval=await prep.json();
 const before=await (await fetch(origin+base+'/export')).json();expect(before.decisionEvidence[0].data.unresolvedIssueIds).toContain(issue.id);
 await review(issue);
 const confirm=await send(`/api/approvals/${approval.token}/confirm`,{});expect(confirm.status).toBe(409);
 const after=await (await fetch(origin+base+'/export')).json();expect(after.decisionEvidence[0]).toEqual(before.decisionEvidence[0]);expect(after.issueReviewHistory).toHaveLength(2);
 expect(await (await fetch(origin+base+'/export?format=text')).text()).toContain('DECISION EVIDENCE');
});
test('stale body and issue versions cannot overwrite current review',async()=>{
 const issue=await add(),c=await get();await review(issue);
 expect((await send(base+`/issues/${issue.recordId}/reviews`,{...binding(c),review:{interpretation:'late edit',disposition:'unresolved',consideredRelations:[]}})).status).toBe(409);
 const fresh=await get();const edit=await send(base+`/issues/${issue.recordId}`,{...binding(fresh),issue:{id:issue.id,title:'Edited question',why:'Changed interpretation',missing:['Terms'],relations:[]}},'PUT');expect(edit.status).toBe(201);
 expect((await get()).ledger.issues[0].review).toBeNull();
});
test('evidence edit preserves history and makes earlier issue review stale',async()=>{
 const issue=await add();await review(issue);let c=await get();
 expect((await send(`/api/sources/${c.sources[0].id}`,{text:c.sources[0].text+'\nNew evidence arrived.'},'PUT')).status).toBe(200);
 c=await get();expect(c.ledger.stale).toBe(true);expect(c.ledger.history).toHaveLength(1);
 expect((await send(base+`/issues/${issue.recordId}/reviews`,{...binding(c),review:{interpretation:'old',disposition:'unresolved',consideredRelations:[]}})).status).toBe(409);
});

function ownerMode(){built.config.paypal={configured:true,clientId:'fake',clientSecret:'fake',merchantId:'M',baseUrl:'https://api-m.sandbox.paypal.com'};built.db.prepare("UPDATE cases SET is_sample=0,merchant_id='M' WHERE id=?").run(id);}
function holdCapture(){let release!:()=>void;captureGate=new Promise<void>(r=>release=r);const entered=new Promise<void>(r=>onCapture=r);return {release,entered};}
test('a current structured review can complete the owner-mode refund path',async()=>{
 const issue=await add();await review(issue);ownerMode();const c=await get();
 const prep=await send(base+'/prepare-approval',{amountRaw:'1.00',purpose:'Controlled acceptance',reviewed:true,...binding(c)});expect(prep.status).toBe(200);
 const response=await send(`/api/approvals/${(await prep.json()).token}/confirm`,{});expect(response.status).toBe(200);expect((await response.json()).operation.state).toBe('completed');expect(refundPosts).toBe(1);
});
test('review changes while capture inspection is pending invalidate preparation',async()=>{
 const issue=await add();await review(issue);ownerMode();const c=await get(),gate=holdCapture();
 const pending=send(base+'/prepare-approval',{amountRaw:'1.00',purpose:'Goodwill',reviewed:true,...binding(c)});
 await gate.entered;await review(issue);gate.release();const response=await pending;
 expect(response.status).toBe(409);expect((await response.json()).error.code).toBe('APPROVAL_DECISION_CHANGED');expect((await get()).approval).toBeNull();
});
test('legacy approval cannot execute if an issue is added during final capture recheck',async()=>{
 ownerMode();let c=await get();const prep=await send(base+'/prepare-approval',{amountRaw:'1.00',purpose:'Technical test',reviewed:true});expect(prep.status).toBe(200);const approval=await prep.json();
 const gate=holdCapture();const pending=send(`/api/approvals/${approval.token}/confirm`,{});await gate.entered;
 await add();gate.release();const response=await pending;expect(response.status).toBe(409);expect(refundPosts).toBe(0);
 c=await get();expect(c.operations[0].state).toBe('refused');
 const exported=await(await fetch(origin+base+'/export')).json();expect(exported.auditHistory.some((event:any)=>event.event==='refund_recheck_failed')).toBe(true);
});

test('a review change during refund OAuth stops the refund before its POST',async()=>{
 const issue=await add();await review(issue);ownerMode();const c=await get();
 const prepared=await send(base+'/prepare-approval',{amountRaw:'1.00',purpose:'Goodwill',reviewed:true,...binding(c)});expect(prepared.status).toBe(200);const approval=await prepared.json();
 let release!:()=>void;tokenGate=new Promise<void>(r=>release=r);const entered=new Promise<void>(r=>onToken=r);
 const pending=send(`/api/approvals/${approval.token}/confirm`,{});await entered;await review(issue);release();
 const response=await pending;expect(response.status).toBe(409);expect(refundPosts).toBe(0);expect((await get()).operations[0].state).toBe('refused');
});
test('source kind, anchor digest and immutable decision basis agree',async()=>{
 let c=await get();const source=c.sources[0];const added=await send(base+'/issues',{...binding(c),issue:{title:'Source basis?',why:'Inspect original text',missing:[],relations:[{sourceId:source.id,quote:source.text.slice(0,20),role:'supports'}]}});expect(added.status).toBe(201);const issue=(await added.json()).issue;
 c=await get();expect((await send(base+`/issues/${issue.recordId}/reviews`,{...binding(c),review:{interpretation:'Owner inspected this passage',disposition:'evidence_resolved',consideredRelations:[0],resolvedBy:0}})).status).toBe(201);
 c=await get();const decision=await send(base+'/decision',{...binding(c),outcome:'clarification_needed',reason:'Owner requests fuller records.',reviewed:true});expect(decision.status).toBe(201);
 const data=await(await fetch(origin+base+'/export')).json(),snapshot=data.decisionEvidence[0].data;
 expect(snapshot.sources.find((s:any)=>s.id===source.id).hash).toBe(snapshot.issues[0].relations[0].sourceHash);expect(snapshot.basisHash).toMatch(/^[a-f0-9]{64}$/);
});

test('server rejects supplied review-contract metadata on decisions, approvals and review envelopes',async()=>{
 const issue=await add();await review(issue);const c=await get();
 for(const [path,body] of [
  [base+'/decision',{outcome:'no_refund',reason:'Owner reason',reviewed:true}],
  [base+'/prepare-approval',{amountRaw:'1.00',purpose:'Owner reason',reviewed:true}],
  [base+`/issues/${issue.recordId}/reviews`,{review:{interpretation:'Owner reason',disposition:'unresolved',consideredRelations:[]}}],
 ] as const){const response=await send(path,{...body,...binding(c),reviewContractVersion:2});expect(response.status).toBe(422);}
});
test('a legacy structured snapshot cannot dispatch even with a matching epoch; completed receipts remain readable',async()=>{
 const issue=await add();await review(issue);const c=await get();
 const prep=await send(base+'/prepare-approval',{amountRaw:'1.00',purpose:'Test',reviewed:true,...binding(c)});const approval=await prep.json();
 // Simulate a historical snapshot, preserving its bytes after insertion.
 built.db.exec('DROP TRIGGER immutable_decision_evidence_update');
 const row=built.db.prepare('SELECT payload FROM decision_evidence WHERE id=?').get(approval.token) as any;
 const old=JSON.parse(row.payload);delete old.reviewContractVersion;
 built.db.prepare('UPDATE decision_evidence SET payload=? WHERE id=?').run(JSON.stringify(old),approval.token);
 expect((await send(`/api/approvals/${approval.token}/confirm`,{})).status).toBe(409);expect((await get()).operations).toHaveLength(0);
});
