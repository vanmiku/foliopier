import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig, updateConfig, INSTALL_ID } from './store.mjs';
import { systemCli, nodeTarget, NODE_SOCKET } from './tailscale.mjs';
import { findPdfBrowser } from './share-pdf.mjs';
import { revokeAllShares } from './shares.mjs';
const exec = promisify(execFile);
let cached=null, cachedAt=0, changing=false;
const settings=()=>readConfig().sharing||{};
export function shareLocalPort() { const c=readConfig();return Number(c.sharing?.localPort||Number(process.env.MYDASH_PORT||c.port||4870)+3); }
function target() {
  const c=readConfig();
  if((c.sharing?.target||c.access)==='tailscale-node'&&fs.existsSync(NODE_SOCKET)&&fs.existsSync(nodeTarget().cli))return {...nodeTarget(),kind:'tailscale-node'};
  const cli=systemCli();return cli?{cli,kind:'tailscale'}:null;
}
async function command(tg,args) {
  try{const r=await exec(tg.cli,[...(tg.socket?[`--socket=${tg.socket}`]:[]),...args],{timeout:12000,maxBuffer:2*1024*1024,windowsHide:true});return r.stdout;}
  catch(e){const text=String(e.stderr||e.stdout||e.message);const url=text.match(/https:\/\/(?:login|console)\.tailscale\.com\/[^\s<>"']+/)?.[0];const code=url?'AUTHORIZATION_REQUIRED':/not supported|unsupported|app store|macos variant/i.test(text)?'TAILSCALE_UNSUPPORTED':/permission|access denied|not permitted/i.test(text)?'TAILSCALE_PERMISSION':'TAILSCALE_COMMAND_FAILED';throw Object.assign(new Error('Tailscale configuration needs attention.'),{code,authUrl:url||''});}
}
const jsonCommand=async(tg,args)=>JSON.parse(await command(tg,args)||'{}');
const portOf=host=>Number(host.split(':').pop());
export function ownedShareRoute(config,port,localPort) {
  const entries=Object.entries(config.Web||{}).filter(([host])=>portOf(host)===port);
  return entries.length===1&&Object.keys(entries[0][1]?.Handlers||{}).length===1
    &&entries[0][1].Handlers['/']?.Proxy===`http://127.0.0.1:${localPort}`;
}
export function chooseSharePort(config,localPort,preferred) {
  for(const port of [...new Set([preferred,8443,10000])].filter(p=>[8443,10000].includes(p))){
    const busy=config.TCP?.[port]||Object.keys(config.Web||{}).some(h=>portOf(h)===port);
    if(!busy||ownedShareRoute(config,port,localPort))return port;
  }
  return null;
}
export async function shareNetworkStatus({refresh=false}={}) {
  if(!refresh&&cached&&Date.now()-cachedAt<5000)return cached;
  const s=settings(),tg=target();
  let status=null,config={};
  if(tg)try{[status,config]=await Promise.all([jsonCommand(tg,['status','--json']),jsonCommand(tg,['funnel','status','--json'])]);}catch{}
  const domain=String(status?.Self?.DNSName||'').replace(/\.$/,'');
  const owned=Boolean(s.publicPort&&ownedShareRoute(config,s.publicPort,shareLocalPort()));
  const funnel=owned&&Object.entries(config.AllowFunnel||{}).some(([host,on])=>on===true&&portOf(host)===s.publicPort&&host.split(':')[0]===domain);
  let localReady=false;
  if(s.enabled)try{const r=await fetch(`http://127.0.0.1:${shareLocalPort()}/healthz`,{signal:AbortSignal.timeout(800)});localReady=r.ok&&r.headers.get('x-mydash-share-id')===INSTALL_ID;}catch{}
  const phase=!tg?'not-installed':status?.BackendState!=='Running'?'login':s.errorCode==='AUTHORIZATION_REQUIRED'?'authorization':s.errorCode?'error':s.enabled&&funnel&&localReady?'configured':s.enabled?'error':'off';
  cached={enabled:s.enabled===true,cleanupPending:s.cleanupPending===true,phase,publicUrl:s.publicUrl||'',localPort:shareLocalPort(),publicPort:s.publicPort||null,target:tg?.kind||null,pdfReady:Boolean(findPdfBrowser()),
    checks:{installed:Boolean(tg),loggedIn:status?.BackendState==='Running',https:Boolean(status?.CertDomains?.length),configured:owned,funnel,localReady},
    authUrl:s.authUrl||'',errorCode:s.errorCode||'',externalVerified:Boolean(s.externalVerifiedAt),externalVerifiedAt:s.externalVerifiedAt||null};
  cachedAt=Date.now();return cached;
}
export async function configureSharing(action,{ensureListener=async()=>{}}={}) {
  if(changing)throw Object.assign(new Error('Sharing setup is already running.'),{status:409});
  changing=true;
  try{
    if(action==='check')return await shareNetworkStatus({refresh:true});
    if(action==='disable'){
      const old=settings();updateConfig(c=>({...c,sharing:{...c.sharing,enabled:false,epoch:crypto.randomBytes(16).toString('hex'),revocationPending:true,cleanupPending:c.sharing?.routeOwner===INSTALL_ID,externalVerifiedAt:null}}));
      await ensureListener();
      // Closing public access takes priority even if stored feedback is corrupt.
      let revocationError;
      try{await revokeAllShares();}catch(e){revocationError=e;}
      await stopOwnedRoute(old);
      updateConfig(c=>({...c,sharing:{...c.sharing,cleanupPending:false,routeOwner:null,authUrl:'',revocationPending:Boolean(revocationError),errorCode:revocationError?'SHARE_STATE_UNAVAILABLE':''}}));
      await ensureListener();
      if(revocationError)throw Object.assign(new Error('Share revocation needs attention.'),{code:'SHARE_STATE_UNAVAILABLE'});
      return await shareNetworkStatus({refresh:true});
    }
    if(action!=='enable')throw Object.assign(new Error('Invalid sharing action.'),{status:400});
    if(settings().revocationPending){await revokeAllShares();updateConfig(c=>({...c,sharing:{...c.sharing,revocationPending:false}}));}
    const tg=target();if(!tg)throw Object.assign(new Error('Tailscale is not installed.'),{code:'TAILSCALE_MISSING'});
    const st=await jsonCommand(tg,['status','--json']);
    if(st.BackendState!=='Running')throw Object.assign(new Error('Sign in to Tailscale first.'),{code:'TAILSCALE_LOGIN'});
    const domain=String(st.Self?.DNSName||'').replace(/\.$/,'');
    if(!/^[a-z\d.-]+\.ts\.net$/i.test(domain))throw Object.assign(new Error('MagicDNS is needed.'),{code:'MAGICDNS_REQUIRED'});
    const localPort=shareLocalPort();if(!Number.isInteger(localPort)||localPort<1024||localPort>65535)throw new Error('Invalid share port.');
    const config=await jsonCommand(tg,['funnel','status','--json']);const publicPort=chooseSharePort(config,localPort,settings().publicPort);
    if(!publicPort)throw Object.assign(new Error('Dedicated sharing ports are in use.'),{code:'SHARE_PORT_BUSY'});
    const publicUrl=`https://${domain}:${publicPort}`;
    updateConfig(c=>({...c,sharing:{...c.sharing,enabled:true,localPort,publicPort,publicUrl,target:tg.kind,routeOwner:INSTALL_ID,cleanupPending:true,errorCode:'',authUrl:'',externalVerifiedAt:null}}));
    await ensureListener();
    const health=await fetch(`http://127.0.0.1:${localPort}/healthz`,{signal:AbortSignal.timeout(2000)});
    if(!health.ok||health.headers.get('x-mydash-share-id')!==INSTALL_ID)throw new Error('Share listener identity mismatch.');
    await command(tg,['funnel','--bg',`--https=${publicPort}`,`http://127.0.0.1:${localPort}`]);
    updateConfig(c=>({...c,sharing:{...c.sharing,routeOwner:INSTALL_ID,cleanupPending:false}}));
    return await shareNetworkStatus({refresh:true});
  }catch(e){
    if(action==='enable'){
      updateConfig(c=>({...c,sharing:{...c.sharing,enabled:false,errorCode:e.code||'SETUP_FAILED',authUrl:e.authUrl||''}}));
      if(settings().routeOwner===INSTALL_ID)try{await stopOwnedRoute(settings());updateConfig(c=>({...c,sharing:{...c.sharing,cleanupPending:false,routeOwner:null}}));}catch{updateConfig(c=>({...c,sharing:{...c.sharing,cleanupPending:true}}));}
      await ensureListener();
    }
    if(action==='disable')updateConfig(c=>({...c,sharing:{...c.sharing,enabled:false,errorCode:e.code||'FUNNEL_CLEANUP_FAILED'}}));
    cached=null;throw e;
  }finally{changing=false;}
}
async function stopOwnedRoute(old) {
  if(old.routeOwner!==INSTALL_ID)return;
  const tg=target();if(!tg)throw Object.assign(new Error('Cannot verify Funnel cleanup.'),{code:'FUNNEL_CLEANUP_FAILED'});
  const config=await jsonCommand(tg,['funnel','status','--json']);
  if(ownedShareRoute(config,old.publicPort,old.localPort))await command(tg,['funnel',`--https=${old.publicPort}`,'off']);
  else if(Object.entries(config.Web||{}).filter(([h])=>portOf(h)===old.publicPort).some(([,v])=>Object.values(v.Handlers||{}).some(h=>h.Proxy===`http://127.0.0.1:${old.localPort}`)))throw Object.assign(new Error('Sharing route changed; cleanup needs attention.'),{code:'FUNNEL_CLEANUP_FAILED'});
}
