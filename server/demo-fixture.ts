// Public-safe stored fictional fixture. This module never reads private evidence.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { type DB, withImmediateTx } from './db';
import { validateBrief } from './domain/brief';
import { IssueLedger } from './issue-ledger';
export function installJudgeFixture(db:DB):void {
 const root=resolve('fixtures/judge-policy-conflict');
 const manifest=JSON.parse(readFileSync(resolve(root,'transformation-manifest.json'),'utf8'));
 for(const [name,hash] of Object.entries(manifest.sha256)){
  if(!['original-source-packet.json','original-model-output.txt','neutral-fixture.json'].includes(name))throw Error('Unexpected fixture input.');
  if(createHash('sha256').update(readFileSync(resolve(root,name))).digest('hex')!==hash)throw Error('Judge fixture hash mismatch.');
 }
 const {caseId:id,sources,brief:raw}=JSON.parse(readFileSync(resolve(root,'neutral-fixture.json'),'utf8'));
 const brief=validateBrief(raw,sources,1);
 withImmediateTx(db,()=>{
  const now=new Date().toISOString();
  db.prepare('INSERT INTO cases(id,title,is_sample,capture_id,merchant_id,currency,paid_pennies,capture_amount_pennies,capture_status,revision,brief_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'Policy conflict — stored AI review fixture',1,'SAMPLE-LEDGER-CAP','sample','GBP',1000,1000,'COMPLETED',1,1,now);
  sources.forEach((s:any,n:number)=>db.prepare('INSERT INTO sources(id,case_id,title,kind,text,sort_order,added_at) VALUES(?,?,?,?,?,?,?)').run(s.id,id,s.title,s.kind,s.text,n,now));
  db.prepare('INSERT INTO briefs(id,case_id,version,case_revision,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)').run('ledger-brief-1',id,1,1,'example',JSON.stringify(brief),now);
  new IssueLedger(db).registerBrief({id,revision:1,brief_version:1},brief.issues);
 });
}
