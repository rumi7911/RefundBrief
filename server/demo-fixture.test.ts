import { expect,test } from 'vitest';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from './app';
import { installJudgeFixture } from './demo-fixture';
test('safe judge fixture preserves complete original output, every issue and source; transformations and hashes are explicit',()=>{
 const root='fixtures/judge-policy-conflict/';const manifest=JSON.parse(readFileSync(root+'transformation-manifest.json','utf8'));
 for(const [name,hash] of Object.entries(manifest.sha256))expect(createHash('sha256').update(readFileSync(root+name)).digest('hex')).toBe(hash);
 const originalText=readFileSync(root+'original-model-output.txt','utf8');const original=JSON.parse(originalText.slice(originalText.indexOf('{'),originalText.lastIndexOf('}')+1));const transformed=JSON.parse(readFileSync(root+'neutral-fixture.json','utf8'));
 expect(transformed.brief.issues).toHaveLength(original.issues.length);expect(transformed.brief.issues[1].title).toBe(original.issues[1].title);
 expect(transformed.brief.issues.flatMap((i:any)=>i.relations).every((r:any)=>r.role==='context')).toBe(true);
 const dirs=[mkdtempSync(join(tmpdir(),'rb-fresh-')),mkdtempSync(join(tmpdir(),'rb-fresh-'))];
 try{for(const dir of dirs){const built=createApp({demoMode:true,config:{port:4184,host:'127.0.0.1',dataDir:dir,paypal:{configured:false,baseUrl:''},ai:{enabled:false}},serveStatic:false});try{installJudgeFixture(built.db);expect(built.db.prepare('SELECT * FROM review_issues WHERE case_id=?').all('ledger-policy-conflict')).toHaveLength(original.issues.length);expect(built.db.prepare('SELECT * FROM issue_reviews').all()).toHaveLength(0);expect(built.db.prepare('SELECT * FROM operations').all()).toHaveLength(0);}finally{built.db.close();}}}finally{dirs.forEach(dir=>rmSync(dir,{recursive:true,force:true}));}
});
