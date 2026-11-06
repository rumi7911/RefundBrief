// Free local judge build. Each launch owns a fresh fictional OS-temp workspace.
import express from 'express';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createApp } from '../server/app.ts';
import { installJudgeFixture } from '../server/demo-fixture.ts';
const dir=mkdtempSync(join(tmpdir(),'refundbrief-demo-'));
let providerAttempts=0;
const reject:typeof fetch=async()=>{providerAttempts++;throw Error('DEMO_EXTERNAL_DISABLED: no provider transport permitted.');};
const built=createApp({demoMode:true,dbFile:resolve(dir,'refundbrief.sqlite'),config:{port:4184,host:'127.0.0.1',dataDir:dir,paypal:{configured:false,baseUrl:'https://api-m.sandbox.paypal.com'},ai:{enabled:false}},aiFetch:reject,paypalFetch:reject,serveStatic:false});
installJudgeFixture(built.db);
built.app.get('/qa/axe.js',(_req,res)=>res.sendFile(resolve('node_modules/axe-core/axe.min.js')));
built.app.get('/qa/accessibility',(_req,res)=>{
 const html=readFileSync('dist/index.html','utf8');
 const tools=`<script src="/qa/axe.js"></script><script>
 addEventListener('load',()=>{
  const tools=document.createElement('aside');tools.id='qa-tools';tools.setAttribute('aria-label','Local QA controls');tools.style.cssText='position:fixed;right:8px;bottom:8px;z-index:9999;background:white;color:black;border:2px solid black;padding:12px;max-width:420px;max-height:40vh;overflow:auto';
  const button=document.createElement('button');button.textContent='Run accessibility audit';button.id='qa-run';tools.append(button);
  const result=document.createElement('pre');result.id='qa-results';result.style.cssText='white-space:pre-wrap;font-size:12px';tools.append(result);document.body.append(tools);
  button.addEventListener('click',async()=>{
   result.textContent='Running';button.disabled=true;
   try{const data=await axe.run(document,{exclude:[['#qa-tools']],runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});result.textContent=JSON.stringify({version:axe.version,url:location.href,recordedAt:new Date().toISOString(),violations:data.violations,passes:data.passes.length,incomplete:data.incomplete},null,2);}catch(error){result.textContent=String(error);}finally{button.disabled=false;}
  });
 });
 </script>`;
 res.type('html').send(html.replace('</body>',tools+'</body>'));
});
built.app.use(express.static(resolve('dist')));
built.app.get('/',(_req,res)=>res.sendFile(resolve('dist/index.html')));
const server=built.app.listen(4184,'127.0.0.1',()=>{
 console.log('RefundBrief local judge build: http://127.0.0.1:4184');
 console.log('Stored AI output · payments simulated. External accounts and generation disabled.');
 console.log('Fresh fictional workspace: '+dir);
 console.log('Opens Policy conflict — stored AI review fixture automatically. Use left-rail Cases to return to it. Ctrl+C then npm run demo restores the original fictional fixture.');
});
server.on('error',error=>{console.error('Demo could not start: '+error.message);built.db.close();process.exitCode=1;});
function stop(){server.close(()=>{built.db.close();console.log('Provider transport attempts: '+providerAttempts);process.exitCode=providerAttempts?1:0;});}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
