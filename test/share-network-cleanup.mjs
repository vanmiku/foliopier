import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import fsp from 'node:fs/promises';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'mydash-share-cleanup-'));process.env.MYDASH_HOME=home;process.env.MYDASH_CODEX_HOME=path.join(home,'codex');process.env.MYDASH_CLAUDE_HOME=path.join(home,'claude');
const bin=path.join(home,'bin');fs.mkdirSync(bin);const configFile=path.join(home,'funnel.json'),calls=path.join(home,'calls.jsonl');
fs.writeFileSync(path.join(bin,'tailscale'),`#!${process.execPath}
const fs=require('fs'),p=${JSON.stringify(configFile)},log=${JSON.stringify(calls)},a=process.argv.slice(2);fs.appendFileSync(log,JSON.stringify(a)+'\\n');
if(a[0]==='status')console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'unit.tail.ts.net.'},CertDomains:['unit.tail.ts.net']}));
else if(a.includes('status'))console.log(fs.existsSync(p)?fs.readFileSync(p,'utf8'):'{}');
else if(a.includes('off'))fs.writeFileSync(p,'{}');
else if(a[0]==='funnel'){const port=Number(a.find(x=>x.startsWith('--https=')).split('=')[1]),proxy=a.find(x=>x.startsWith('http://'));fs.writeFileSync(p,JSON.stringify({Web:{['unit.tail.ts.net:'+port]:{Handlers:{'/':{Proxy:proxy}}}},AllowFunnel:{['unit.tail.ts.net:'+port]:true}}));if(process.env.MYDASH_TEST_FUNNEL_FAIL==='1'){process.stderr.write('command failed after configuring');process.exitCode=1;}}
`);fs.chmodSync(path.join(bin,'tailscale'),0o755);process.env.PATH=bin+path.delimiter+process.env.PATH;
const {updateConfig,readConfig,INSTALL_ID}=await import('../lib/store.mjs');const {configureSharing}=await import('../lib/share-network.mjs');
const server=http.createServer((req,res)=>{res.writeHead(200,{'X-Mydash-Share-Id':INSTALL_ID});res.end('ok');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const seed=()=>updateConfig(()=>({access:'tailscale',service:'none',binDir:bin,port:4870,sharing:{enabled:true,localPort:port,publicPort:8443,publicUrl:'https://unit.tail.ts.net:8443',routeOwner:INSTALL_ID}}));
const route=()=>fs.writeFileSync(configFile,JSON.stringify({Web:{'unit.tail.ts.net:8443':{Handlers:{'/':{Proxy:`http://127.0.0.1:${port}`}}}},AllowFunnel:{'unit.tail.ts.net:8443':true}}));
test.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(home,{recursive:true,force:true});});
test('failed enable cleans an already-created background route',{skip:process.platform==='win32'},async()=>{
 seed();fs.writeFileSync(configFile,'{}');process.env.MYDASH_TEST_FUNNEL_FAIL='1';
 try{await assert.rejects(configureSharing('enable'));}finally{delete process.env.MYDASH_TEST_FUNNEL_FAIL;}
 assert.equal(readConfig().sharing.enabled,false);assert.deepEqual(JSON.parse(fs.readFileSync(configFile,'utf8')),{});
});
test('uninstall removes an owned public Funnel before removing code',{skip:process.platform==='win32'},async()=>{
 seed();route();const {uninstall}=await import('../lib/setup.mjs');const r=await uninstall();
 assert.equal(r.ok,true);assert.deepEqual(JSON.parse(fs.readFileSync(configFile,'utf8')),{});
 const all=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);assert(all.some(a=>a[0]==='funnel'&&a.includes('off')));assert(!all.some(a=>a.includes('reset')));
});
test('failed state revocation cannot resurrect old shares on the next enable',{skip:process.platform==='win32'},async()=>{
 seed();fs.writeFileSync(configFile,'{}');const dir=path.join(home,'data','p','s','v1');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'main.md'),'# Shared');fs.writeFileSync(path.join(dir,'../meta.json'),JSON.stringify({versions:[{v:1,main:'main.md',time:new Date().toISOString(),files:[{path:'main.md',kind:'md',size:8}]}]}));
 const {createShare,unlockShare,verifyShareSession}=await import('../lib/shares.mjs');const {share,code}=await createShare({project:'p',slug:'s',files:['main.md'],main:'main.md'});const auth=await unlockShare(share.id,code);
 const rename=fsp.rename;fsp.rename=async(a,b)=>{if(b===path.join(home,'state','shares.json'))throw Object.assign(new Error('read-only state'),{code:'EACCES'});return rename(a,b);};
 try{await configureSharing('disable').catch(()=>{});}finally{fsp.rename=rename;}
 updateConfig(c=>({...c,sharing:{...c.sharing,enabled:true}}));assert.equal(verifyShareSession(share.id,auth.token),null);
});
