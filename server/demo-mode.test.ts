import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app';
import { resetSessions } from './security';
let built:ReturnType<typeof createApp>,server:any,dir:string;
afterEach(async()=>{if(server)await new Promise<void>(r=>server.close(r));built?.db.close();if(dir)rmSync(dir,{recursive:true,force:true});resetSessions();});
test('demo blocks every external capability before OAuth/credentials and transports despite configured providers',async()=>{
 dir=mkdtempSync(join(tmpdir(),'rb-demo-test-'));
 // Constructor would fail if demo tried to read even malformed saved credentials.
 writeFileSync(join(dir,'chatgpt.json'),'not-json');
 let calls=0;const reject:typeof fetch=async()=>{calls++;throw Error('Demo transport forbidden');};
 built=createApp({demoMode:true,dbFile:':memory:',config:{port:4184,host:'127.0.0.1',dataDir:dir,paypal:{configured:true,clientId:'fixture',clientSecret:'fixture',merchantId:'M',baseUrl:'https://api-m.sandbox.paypal.com'},ai:{enabled:true,provider:'openai',apiKey:'fixture',model:'fixture',baseUrl:'https://api.openai.com'}},aiFetch:reject,paypalFetch:reject,serveStatic:false});
 await new Promise<void>(r=>{server=built.app.listen(0,'127.0.0.1',r);});const base=`http://127.0.0.1:${server.address().port}`;
 const session=await fetch(base+'/api/session'),{csrfToken}=await session.json();const headers={cookie:session.headers.get('set-cookie')!.split(';')[0],'x-rb-csrf':csrfToken,'content-type':'application/json'};
 const status=await(await fetch(base+'/api/status')).json();expect(status).toMatchObject({demoMode:true,ai:{enabled:false},paypal:{configured:false},chatgpt:{connected:false,ready:false}});expect(JSON.stringify(status)).not.toContain('fixture');
 const paths=['/api/chatgpt/connect','/api/chatgpt/models','/api/chatgpt/model','/api/chatgpt/disconnect','/api/cases/sample-deep-clean/generate-brief','/api/cases'];
 for(const path of paths){const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify({title:'External case',captureId:'CAP',model:'fixture'})});expect(r.status,path).toBe(403);expect((await r.json()).error.code).toBe('DEMO_EXTERNAL_DISABLED');expect(r.headers.get('set-cookie')).toBeNull();}
 for(const path of ['/auth/chatgpt/callback?state=forged&code=code','/api/chatgpt/models']){const r=await fetch(base+path,{redirect:'manual'});expect(r.status).toBe(403);expect(r.headers.get('location')).toBeNull();}
 expect((await fetch(base+'/api/chatgpt/connect',{method:'POST'})).status).toBe(403);expect(calls).toBe(0);expect(readFileSync(join(dir,'chatgpt.json'),'utf8')).toBe('not-json');
 // Existing non-sample records cannot be used to reach PayPal from demo mode.
 built.db.prepare("UPDATE cases SET is_sample=0 WHERE id='sample-deep-clean'").run();
 const r=await fetch(base+'/api/cases/sample-deep-clean/prepare-approval',{method:'POST',headers,body:JSON.stringify({amountRaw:'1.00',purpose:'Test',reviewed:true})});expect(r.status).toBe(403);expect(calls).toBe(0);
});
