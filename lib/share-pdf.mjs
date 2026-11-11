// Chrome's private CDP pipe is used instead of an externally reachable debug port.
// The fresh browser profile never loads the user's history, cookies or extensions.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HOME } from './store.mjs';
import { which } from './sys.mjs';

export function findPdfBrowser() {
  const candidates=[process.env.MYDASH_PDF_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...['google-chrome','google-chrome-stable','chromium','chromium-browser','msedge'].map(which),
    ...[process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean).flatMap(p=>[path.join(p,'Google','Chrome','Application','chrome.exe'),path.join(p,'Microsoft','Edge','Application','msedge.exe')])];
  return candidates.find(p=>p&&fs.existsSync(p))||null;
}
let queue=Promise.resolve(), queued=0;
const pending=new Map();
export function pdfFromHtml(html) {
  const key=crypto.createHash('sha256').update(html).digest('hex');
  if(pending.has(key))return pending.get(key);
  if(queued>=6)return Promise.reject(Object.assign(new Error('PDF queue is full.'),{status:429}));
  queued++;
  const task=queue.catch(()=>{}).then(async()=>{
    const dir=path.join(HOME,'state','share-pdf');await fsp.mkdir(dir,{recursive:true,mode:0o700});
    const file=path.join(dir,key+'.pdf');
    try{const b=await fsp.readFile(file);if(b.subarray(0,5).toString()==='%PDF-')return b;}catch{}
    const bytes=await print(html);
    await fsp.writeFile(file,bytes,{mode:0o600});
    const old=(await fsp.readdir(dir)).filter(n=>n.endsWith('.pdf'));
    if(old.length>64){const entries=await Promise.all(old.map(async n=>({n,time:(await fsp.stat(path.join(dir,n))).mtimeMs})));entries.sort((a,b)=>a.time-b.time);for(const x of entries.slice(0,old.length-64))await fsp.rm(path.join(dir,x.n),{force:true});}
    return bytes;
  }).finally(()=>{queued--;pending.delete(key);});
  pending.set(key,task);queue=task;return task;
}
async function print(html) {
  const browser=findPdfBrowser();
  if(!browser)throw Object.assign(new Error('A Chrome or Edge browser is needed for PDF downloads.'),{code:'PDF_BROWSER_MISSING',status:503});
  const profile=await fsp.mkdtemp(path.join(os.tmpdir(),'mydash-pdf-'));
  const child=spawn(browser,['--headless=new','--remote-debugging-pipe',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-extensions','--disable-sync','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-dev-shm-usage','about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe'],windowsHide:true});
  const waiting=new Map();let next=0,buffer=Buffer.alloc(0),ended=false;
  const failAll=e=>{for(const p of waiting.values()){clearTimeout(p.timer);p.reject(e);}waiting.clear();};
  const pipeFailed=e=>{ended=true;failAll(e instanceof Error?e:new Error('PDF browser pipe closed.'));};
  child.on('error',pipeFailed);child.on('exit',()=>pipeFailed(new Error('PDF browser exited.')));
  child.stderr.on('error',()=>{});child.stderr.resume();
  child.stdio[3].on('error',pipeFailed);child.stdio[4].on('error',pipeFailed);
  child.stdio[3].on('close',()=>pipeFailed(new Error('PDF browser input closed.')));
  child.stdio[4].on('close',()=>pipeFailed(new Error('PDF browser output closed.')));
  child.stdio[4].on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);if(buffer.length>64*1024*1024){pipeFailed(new Error('PDF result is too large.'));child.kill();return;}let end;
    while((end=buffer.indexOf(0))>=0){const line=buffer.subarray(0,end).toString();buffer=buffer.subarray(end+1);let msg;try{msg=JSON.parse(line);}catch{continue;}
      const p=waiting.get(msg.id);if(!p)continue;waiting.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result);
    }
  });
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    if(ended)return reject(new Error('PDF browser is closed.'));
    const id=++next,timer=setTimeout(()=>{waiting.delete(id);reject(new Error('PDF generation timed out.'));},25000);
    waiting.set(id,{resolve,reject,timer});
    try{child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0',e=>{if(e)pipeFailed(e);});}catch(e){pipeFailed(e);}
  });
  const deadline=setTimeout(()=>child.kill(),35000);
  try{
    const {targetId}=await call('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
    await call('Page.enable',{},sessionId);await call('Network.enable',{},sessionId);
    await call('Network.setBlockedURLs',{urls:['http://*','https://*','file://*','ftp://*','ws://*','wss://*']},sessionId);
    await call('Page.setLifecycleEventsEnabled',{enabled:true},sessionId);
    const {frameTree}=await call('Page.getFrameTree',{},sessionId);
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html},sessionId);
    await call('Runtime.evaluate',{expression:`Promise.race([Promise.all([document.fonts.ready,...Array.from(document.images).map(i=>i.complete?Promise.resolve():new Promise(r=>{i.onload=r;i.onerror=r}))]),new Promise(r=>setTimeout(r,8000))])`,awaitPromise:true},sessionId);
    await call('Runtime.evaluate',{expression:'window.__shareDiagramsReady || Promise.resolve()',awaitPromise:true},sessionId);
    const {data}=await call('Page.printToPDF',{printBackground:true,preferCSSPageSize:true,marginTop:.45,marginBottom:.55,marginLeft:.4,marginRight:.4},sessionId);
    const bytes=Buffer.from(data,'base64');if(bytes.subarray(0,5).toString()!=='%PDF-')throw new Error('Invalid PDF result.');
    return bytes;
  }finally{
    clearTimeout(deadline);failAll(new Error('PDF browser closed.'));child.kill();
    if(!ended)await new Promise(r=>{child.once('exit',r);setTimeout(r,1500).unref();});
    await fsp.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
