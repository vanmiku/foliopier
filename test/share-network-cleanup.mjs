import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import fsp from 'node:fs/promises';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'mydash-share-cleanup-'));process.env.MYDASH_HOME=home;process.env.MYDASH_CODEX_HOME=path.join(home,'codex');process.env.MYDASH_CLAUDE_HOME=path.join(home,'claude');
const bin=path.join(home,'bin');fs.mkdirSync(bin);const configFile=path.join(home,'funnel.json'),calls=path.join(home,'calls.jsonl');
fs.writeFileSync(path.join(bin,'tailscale'),`#!${process.execPath}
const fs=require('fs'),p=${JSON.stringify(configFile)},log=${JSON.stringify(calls)},a=process.argv.slice(2);fs.appendFileSync(log,JSON.stringify(a)+'\\n');
if(a[0]==='status'){
 if(process.env.MYDASH_TEST_BACKEND_STATE==='fail'){console.error('temporary status failure');process.exitCode=1;}
 else console.log(JSON.stringify({BackendState:process.env.MYDASH_TEST_BACKEND_STATE||'Running',AuthURL:process.env.MYDASH_TEST_AUTH_URL,Self:{DNSName:'unit.tail.ts.net.'},CertDomains:['unit.tail.ts.net']}));
}
else if(a[0]==='up'){console.error('https://login.tailscale.com/a/unit-test');setInterval(()=>{},1000);}
else if(a.includes('status'))console.log(fs.existsSync(p)?fs.readFileSync(p,'utf8'):'{}');
else if(a.includes('off')){
 const port=a.find(x=>x.startsWith('--https=')).split('=')[1], config=JSON.parse(fs.readFileSync(p,'utf8'));
 for(const key of ['Web','AllowFunnel']){
  for(const host of Object.keys(config[key]||{}))if(host.endsWith(':'+port))delete config[key][host];
  if(!Object.keys(config[key]||{}).length)delete config[key];
 }
 fs.writeFileSync(p,JSON.stringify(config));
}
else if(a[0]==='funnel'){
 const mode=process.env.MYDASH_TEST_FUNNEL_FAIL;
 if(['authorization','authorization-exit-zero','authorization-wait'].includes(mode)){
  console.log('https://login.tailscale.com/f/unit-test');
  if(mode==='authorization'){console.error('waiting interrupted');process.exitCode=1;}
  if(mode==='authorization-wait')setInterval(()=>{},1000);
 } else if(mode==='policy'){
  console.error('Funnel not available; "funnel" node attribute not set. See https://tailscale.com/s/no-funnel.');
  process.exitCode=1;
 } else if(mode!=='no-route'){
  const port=Number(a.find(x=>x.startsWith('--https=')).split('=')[1]),proxy=a.find(x=>x.startsWith('http://'));
  const config=JSON.parse(fs.readFileSync(p,'utf8')),host='unit.tail.ts.net:'+port;
  fs.writeFileSync(p,JSON.stringify({...config,Web:{...config.Web,[host]:{Handlers:{'/':{Proxy:proxy}}}},AllowFunnel:{...config.AllowFunnel,[host]:true}}));
  if(mode==='1'){process.stderr.write('command failed after configuring');process.exitCode=1;}
 }
}
`);fs.chmodSync(path.join(bin,'tailscale'),0o755);process.env.PATH=bin+path.delimiter+process.env.PATH;
const {updateConfig,readConfig,INSTALL_ID}=await import('../lib/store.mjs');const {configureSharing,shareNetworkStatus}=await import('../lib/share-network.mjs');
const server=http.createServer((req,res)=>{res.writeHead(200,{'X-Mydash-Share-Id':INSTALL_ID});res.end('ok');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const seed=(enabled=true)=>updateConfig(()=>({access:'tailscale',service:'none',binDir:bin,port:4870,sharing:enabled
 ? {enabled,localPort:port,publicPort:8443,publicUrl:'https://unit.tail.ts.net:8443',routeOwner:INSTALL_ID}
 : {enabled,localPort:port}}));
const route=()=>fs.writeFileSync(configFile,JSON.stringify({Web:{'unit.tail.ts.net:8443':{Handlers:{'/':{Proxy:`http://127.0.0.1:${port}`}}}},AllowFunnel:{'unit.tail.ts.net:8443':true}}));
test.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(home,{recursive:true,force:true});});
test('failed enable cleans an already-created background route',{skip:process.platform==='win32'},async()=>{
 seed(false);fs.writeFileSync(configFile,'{}');process.env.MYDASH_TEST_FUNNEL_FAIL='1';
 try{await assert.rejects(configureSharing('enable'));}finally{delete process.env.MYDASH_TEST_FUNNEL_FAIL;}
 assert.equal(readConfig().sharing.enabled,false);assert.deepEqual(JSON.parse(fs.readFileSync(configFile,'utf8')),{});
});
test('Funnel authorization from stdout reaches the owner even with stderr or exit zero',{skip:process.platform==='win32'},async()=>{
 for(const mode of ['authorization','authorization-exit-zero','authorization-wait']){
  seed(false);fs.writeFileSync(configFile,'{}');process.env.MYDASH_TEST_FUNNEL_FAIL=mode;
  const started = Date.now();
  try{await assert.rejects(configureSharing('enable'),{code:'AUTHORIZATION_REQUIRED'});}
  finally{delete process.env.MYDASH_TEST_FUNNEL_FAIL;}
  const pending=await shareNetworkStatus({refresh:true});
  assert.equal(pending.phase,'authorization');assert.equal(pending.enabled,false);
  assert.equal(pending.authUrl,'https://login.tailscale.com/f/unit-test');
  assert.equal(readConfig().sharing.cleanupPending,false);
  if (mode === 'authorization-wait') assert.ok(Date.now() - started < 8000, 'do not wait for the command timeout to present authorization');
 }
 const ready=await configureSharing('enable');
 assert.equal(ready.phase,'configured');assert.equal(ready.enabled,true);assert.equal(ready.authUrl,'');
});
test('Funnel exit zero without the expected route does not enable sharing',{skip:process.platform==='win32'},async()=>{
 seed(false);fs.writeFileSync(configFile,'{}');process.env.MYDASH_TEST_FUNNEL_FAIL='no-route';
 try{await assert.rejects(configureSharing('enable'),{code:'SHARE_ROUTE_MISSING'});}
 finally{delete process.env.MYDASH_TEST_FUNNEL_FAIL;}
 assert.equal(readConfig().sharing.enabled,false);
 assert.equal((await shareNetworkStatus({refresh:true})).phase,'error');
});
test('a network policy error tells the owner to ask the Tailscale administrator',{skip:process.platform==='win32'},async()=>{
 seed(false);fs.writeFileSync(configFile,'{}');process.env.MYDASH_TEST_FUNNEL_FAIL='policy';
 try{await assert.rejects(configureSharing('enable'),{code:'TAILSCALE_FUNNEL_POLICY'});}
 finally{delete process.env.MYDASH_TEST_FUNNEL_FAIL;}
 const result = await shareNetworkStatus({refresh:true});
 assert.equal(result.errorCode,'TAILSCALE_FUNNEL_POLICY');
 assert.equal(result.enabled,false);
 assert.equal(result.authUrl,'');
});
test('connecting Tailscale returns a sign-in URL without configuring a public route',{skip:process.platform==='win32'},async()=>{
 seed();updateConfig(c=>({...c,sharing:{enabled:false,localPort:port}}));fs.writeFileSync(configFile,'{}');
 process.env.MYDASH_TEST_BACKEND_STATE='NeedsLogin';
 try {
   const before = fs.readFileSync(calls,'utf8').length;
   assert.equal((await shareNetworkStatus({refresh:true})).canConnect,true);
   const status = await configureSharing('connect');
   assert.equal(status.phase,'login');assert.equal(status.canConnect,true);
   assert.equal(status.authUrl,'https://login.tailscale.com/a/unit-test');
   assert.equal(status.enabled,false);
   const commands = fs.readFileSync(calls,'utf8').slice(before).trim().split('\n').map(JSON.parse);
   assert.ok(commands.some(args=>args.length===1&&args[0]==='up'));
   assert.ok(commands.every(args=>args[0]!=='funnel'));
 } finally {delete process.env.MYDASH_TEST_BACKEND_STATE;}
});
test('a matching proxy owned by another app survives a local listener conflict',{skip:process.platform==='win32'},async()=>{
 seed();updateConfig(c=>({...c,sharing:{localPort:port}}));route();
 const before=fs.readFileSync(configFile,'utf8');
 await assert.rejects(configureSharing('enable',{ensureListener:async()=>{throw Object.assign(new Error('busy'),{code:'EADDRINUSE'});}}),{code:'SHARE_LOCAL_PORT_BUSY'});
 assert.equal(fs.readFileSync(configFile,'utf8'),before);
 assert.equal(readConfig().sharing.routeOwner,undefined);
});
test('fresh setup picks a free public port and leaves the matching existing proxy alone',{skip:process.platform==='win32'},async()=>{
 seed(false);route();
 const preserved=JSON.parse(fs.readFileSync(configFile,'utf8'));
 const status=await configureSharing('enable');
 assert.equal(status.publicPort,10000);
 await configureSharing('disable');
 assert.deepEqual(JSON.parse(fs.readFileSync(configFile,'utf8')),preserved);
});
test('re-enabling a healthy share is a no-op and a failed probe never disables it',{skip:process.platform==='win32'},async()=>{
 seed();route();const before=fs.readFileSync(configFile,'utf8');
 updateConfig(c=>({...c,sharing:{...c.sharing,externalVerifiedAt:'2026-11-13T10:00:00.000Z'}}));
 const count=fs.readFileSync(calls,'utf8').length;
 assert.equal((await configureSharing('enable')).phase,'configured');
 assert.ok(!fs.readFileSync(calls,'utf8').slice(count).includes('--bg'));
 assert.equal(readConfig().sharing.externalVerifiedAt,'2026-11-13T10:00:00.000Z');
 process.env.MYDASH_TEST_BACKEND_STATE='fail';
 try{await assert.rejects(configureSharing('enable'),{code:'TAILSCALE_COMMAND_FAILED'});}
 finally{delete process.env.MYDASH_TEST_BACKEND_STATE;}
 assert.equal(fs.readFileSync(configFile,'utf8'),before);
 assert.equal(readConfig().sharing.enabled,true);
});
test('a stale cached sign-in URL expires and a pending login can request a replacement',{skip:process.platform==='win32'},async()=>{
 const expired='https://login.tailscale.com/a/expired';
 seed();updateConfig(c=>({...c,sharing:{enabled:false,localPort:port,errorCode:'TAILSCALE_LOGIN',authUrl:expired,authUrlAt:Date.now()-11*60_000}}));
 process.env.MYDASH_TEST_BACKEND_STATE='NeedsLogin';
 try{
  assert.equal((await shareNetworkStatus({refresh:true})).authUrl,'');
  assert.equal((await shareNetworkStatus({refresh:true})).canRefreshLogin,true);
  process.env.MYDASH_TEST_AUTH_URL=expired;
  const s=await configureSharing('refresh-login');
  assert.equal(s.authUrl,'https://login.tailscale.com/a/unit-test');
  assert.equal(s.enabled,false);
  assert.match(fs.readFileSync(calls,'utf8'), /\["up","--force-reauth"\]/);
  process.env.MYDASH_TEST_BACKEND_STATE='Running';
  const before = fs.readFileSync(calls,'utf8').length;
  await configureSharing('refresh-login');
  assert.doesNotMatch(fs.readFileSync(calls,'utf8').slice(before), /--force-reauth/);
 }finally{delete process.env.MYDASH_TEST_BACKEND_STATE;delete process.env.MYDASH_TEST_AUTH_URL;}
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

test('external verification is not presented when the public route is missing',{skip:process.platform==='win32'},async()=>{
 seed();route();updateConfig(c=>({...c,sharing:{...c.sharing,externalVerifiedAt:new Date().toISOString()}}));
 assert.equal((await shareNetworkStatus({refresh:true})).externalVerified,true);
 fs.writeFileSync(configFile,'{}');const status=await shareNetworkStatus({refresh:true});
 assert.equal(status.externalVerified,false);assert.equal(status.externalVerifiedAt,null);
});

test('missing dedicated node never cleans a different system node',{skip:process.platform==='win32'},async()=>{
 seed();route();updateConfig(c=>({...c,sharing:{...c.sharing,target:'tailscale-node'}}));
 const before=fs.existsSync(calls)?fs.readFileSync(calls,'utf8'):'';
 await assert.rejects(configureSharing('disable'),{code:'FUNNEL_CLEANUP_FAILED'});
 const s=readConfig().sharing;
 assert.equal(s.enabled,false);assert.equal(s.cleanupPending,true);assert.equal(s.routeOwner,INSTALL_ID);
 assert.equal(fs.existsSync(calls)?fs.readFileSync(calls,'utf8'):'',before);
 assert.notDeepEqual(JSON.parse(fs.readFileSync(configFile,'utf8')),{});
});

test('unavailable dedicated daemon keeps cleanup pinned to its socket',{skip:process.platform==='win32'},async()=>{
 seed();route();updateConfig(c=>({...c,sharing:{...c.sharing,target:'tailscale-node'}}));
 const {nodeTarget}=await import('../lib/tailscale.mjs');const tg=nodeTarget();
 fs.mkdirSync(path.dirname(tg.cli),{recursive:true});
 fs.writeFileSync(tg.cli,`#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');process.stderr.write('daemon socket unavailable');process.exitCode=1;\n`);fs.chmodSync(tg.cli,0o755);
 const before=fs.readFileSync(calls,'utf8');
 await assert.rejects(configureSharing('disable'),{code:'TAILSCALE_COMMAND_FAILED'});
 assert.equal(readConfig().sharing.cleanupPending,true);assert.equal(readConfig().sharing.routeOwner,INSTALL_ID);
 const added=fs.readFileSync(calls,'utf8').slice(before.length).trim().split('\n').map(JSON.parse);
 assert.equal(added.length,1);assert.equal(added[0][0],`--socket=${tg.socket}`);
});
