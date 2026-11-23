import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig, updateConfig, INSTALL_ID } from './store.mjs';
import { systemCli, nodeTarget } from './tailscale.mjs';
import { findPdfBrowser } from './share-pdf.mjs';
import { revokeAllShares } from './shares.mjs';
const exec = promisify(execFile);
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
let cached=null, cachedAt=0, changing=false;
const settings=()=>readConfig().sharing||{};
export function shareLocalPort() { const c=readConfig();return Number(c.sharing?.localPort||Number(process.env.MYDASH_PORT||c.port||4870)+3); }
function target() {
  const c=readConfig();
  // Persisted routes belong to this node, even while its daemon is unavailable.
  if((c.sharing?.target||c.access)==='tailscale-node'){
    const tg=nodeTarget();return fs.existsSync(tg.cli)?{...tg,kind:'tailscale-node'}:null;
  }
  const cli=systemCli();return cli?{cli,kind:'tailscale'}:null;
}
function authorizationUrl(text) {
  for (const raw of String(text || '').match(/https:\/\/[^\s<>"']+/g) || []) {
    try {
      const url = new URL(raw);
      if (['login.tailscale.com', 'console.tailscale.com'].includes(url.host)
        && !url.username && !url.password && url.pathname !== '/') return url.href;
    } catch {}
  }
  return '';
}
const setupError = (code, authUrl = '') => Object.assign(new Error('Sharing setup needs attention.'), { code, authUrl });
async function command(tg, args, { authorize = false } = {}) {
  let result;
  try {
    const operation = exec(tg.cli, [...(tg.socket ? [`--socket=${tg.socket}`] : []), ...args], {
      timeout: 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, TAILSCALE_BE_CLI: '1' },
    });
    if (authorize) {
      // Tailscale prints the URL before waiting for the user. Let the browser
      // handle that step and start a fresh command after approval.
      for (const stream of [operation.child.stdout, operation.child.stderr]) {
        let partial = '';
        stream.on('data', chunk => {
          const lines = (partial + chunk).split('\n');
          partial = lines.pop().slice(-4096);
          if (authorizationUrl(lines.join('\n'))) operation.child.kill();
        });
      }
    }
    result = await operation;
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n');
    const authUrl = authorize ? authorizationUrl(output) : '';
    if (authUrl) throw setupError('AUTHORIZATION_REQUIRED', authUrl);
    const detail = output || error.message;
    if (/not supported|unsupported|unknown flag|unknown subcommand/i.test(detail)) throw setupError('TAILSCALE_UNSUPPORTED');
    if (/permission|access denied|not permitted|operator/i.test(detail)) throw setupError('TAILSCALE_PERMISSION');
    if (/failed to connect|could not connect|daemon.*not running/i.test(detail)) throw setupError('TAILSCALE_OFFLINE');
    throw setupError('TAILSCALE_COMMAND_FAILED');
  }
  const authUrl = authorize ? authorizationUrl(`${result.stdout}\n${result.stderr}`) : '';
  if (authUrl) throw setupError('AUTHORIZATION_REQUIRED', authUrl);
  return result.stdout;
}
async function jsonCommand(tg, args) {
  const output = await command(tg, args);
  try {
    const value = JSON.parse(output);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw setupError('TAILSCALE_COMMAND_FAILED');
}
const portOf=host=>Number(host.split(':').pop());
export function ownedShareRoute(config,port,localPort) {
  const entries=Object.entries(config.Web||{}).filter(([host])=>portOf(host)===port);
  return entries.length===1&&Object.keys(entries[0][1]?.Handlers||{}).length===1
    &&entries[0][1].Handlers['/']?.Proxy===`http://127.0.0.1:${localPort}`;
}
export function chooseSharePort(config,localPort,preferred) {
  for(const port of [...new Set([preferred,8443,10000])].filter(p=>[8443,10000].includes(p))){
    const hasPort = routes => routes.TCP?.[port] || Object.keys(routes.Web || {}).some(h => portOf(h) === port);
    if (Object.values(config.Foreground || {}).some(hasPort)) continue;
    const busy=hasPort(config);
    if(!busy||ownedShareRoute(config,port,localPort))return port;
  }
  return null;
}
export async function shareNetworkStatus({refresh=false}={}) {
  if(!refresh&&cached&&Date.now()-cachedAt<5000)return cached;
  const s=settings(),tg=target();
  let status = null, config = {}, probeError = '';
  if (tg) {
    try {
      status = await jsonCommand(tg, ['status', '--json']);
      if (status?.BackendState === 'Running') config = await jsonCommand(tg, ['funnel', 'status', '--json']);
    } catch (error) { probeError = error.code || 'TAILSCALE_COMMAND_FAILED'; }
  }
  const domain=String(status?.Self?.DNSName||'').replace(/\.$/,'');
  const owned=Boolean(s.publicPort&&ownedShareRoute(config,s.publicPort,shareLocalPort()));
  const funnel=owned&&Object.entries(config.AllowFunnel||{}).some(([host,on])=>on===true&&portOf(host)===s.publicPort&&host.split(':')[0]===domain);
  let localReady=false;
  if(s.enabled)try{const r=await fetch(`http://127.0.0.1:${shareLocalPort()}/healthz`,{signal:AbortSignal.timeout(800)});localReady=r.ok&&r.headers.get('x-mydash-share-id')===INSTALL_ID;}catch{}
  const loggedIn = status?.BackendState === 'Running';
  const healthy = s.enabled && funnel && localReady;
  const authUrl = !loggedIn && status ? authorizationUrl(status.AuthURL)
    : s.errorCode === 'AUTHORIZATION_REQUIRED' ? authorizationUrl(s.authUrl) : '';
  const errorCode = healthy ? '' : !tg ? 'TAILSCALE_MISSING' : probeError
    || (!loggedIn ? (status?.BackendState === 'Stopped' ? 'TAILSCALE_OFFLINE' : 'TAILSCALE_LOGIN')
      : (s.errorCode !== 'TAILSCALE_LOGIN' && s.errorCode !== 'TAILSCALE_OFFLINE' && s.errorCode !== 'TAILSCALE_MISSING' ? s.errorCode : '') || (s.enabled ? 'SHARE_ROUTE_MISSING' : ''));
  const phase = healthy ? 'configured' : !tg ? 'not-installed' : authUrl && loggedIn ? 'authorization'
    : !loggedIn && status && status.BackendState !== 'Stopped' ? 'login' : errorCode ? 'error' : 'off';
  const c = readConfig();
  cached={enabled:s.enabled===true,cleanupPending:s.cleanupPending===true,phase,publicUrl:s.publicUrl||'',localPort:shareLocalPort(),publicPort:s.publicPort||null,target:tg?.kind||s.target||(c.access==='tailscale-node'?'tailscale-node':null),pdfReady:Boolean(findPdfBrowser()),
    checks:{installed:Boolean(tg),loggedIn,https:Boolean(status?.CertDomains?.length),configured:owned,funnel,localReady},
    authUrl,errorCode,diagnostics:{version,platform:process.platform,clientVersion:String(status?.Version || '').match(/^\d+\.\d+\.\d+/)?.[0] || ''},
    externalVerified:Boolean(healthy&&s.externalVerifiedAt),externalVerifiedAt:healthy?s.externalVerifiedAt||null:null};
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
    if(st.BackendState!=='Running')throw setupError(st.BackendState === 'Stopped' ? 'TAILSCALE_OFFLINE' : 'TAILSCALE_LOGIN', authorizationUrl(st.AuthURL));
    const domain=String(st.Self?.DNSName||'').replace(/\.$/,'');
    if(!/^[a-z\d.-]+\.ts\.net$/i.test(domain))throw Object.assign(new Error('MagicDNS is needed.'),{code:'MAGICDNS_REQUIRED'});
    const localPort=shareLocalPort();if(!Number.isInteger(localPort)||localPort<1024||localPort>65535)throw new Error('Invalid share port.');
    const config=await jsonCommand(tg,['funnel','status','--json']);const publicPort=chooseSharePort(config,localPort,settings().publicPort);
    if(!publicPort)throw Object.assign(new Error('Dedicated sharing ports are in use.'),{code:'SHARE_PORT_BUSY'});
    const publicUrl=`https://${domain}:${publicPort}`;
    updateConfig(c=>({...c,sharing:{...c.sharing,enabled:false,localPort,publicPort,publicUrl,target:tg.kind,routeOwner:INSTALL_ID,cleanupPending:true,errorCode:'',authUrl:'',externalVerifiedAt:null}}));
    try { await ensureListener(); }
    catch (error) { throw error.code === 'EADDRINUSE' ? setupError('SHARE_LOCAL_PORT_BUSY') : error; }
    const health=await fetch(`http://127.0.0.1:${localPort}/healthz`,{signal:AbortSignal.timeout(2000)});
    if(!health.ok||health.headers.get('x-mydash-share-id')!==INSTALL_ID)throw new Error('Share listener identity mismatch.');
    await command(tg,['funnel','--bg',`--https=${publicPort}`,`http://127.0.0.1:${localPort}`], { authorize: true });
    const applied = await jsonCommand(tg, ['funnel', 'status', '--json']);
    if (!ownedShareRoute(applied, publicPort, localPort) || applied.AllowFunnel?.[`${domain}:${publicPort}`] !== true) {
      throw setupError('SHARE_ROUTE_MISSING');
    }
    updateConfig(c=>({...c,sharing:{...c.sharing,enabled:true,cleanupPending:false}}));
    return await shareNetworkStatus({refresh:true});
  }catch(e){
    if(action==='enable'){
      updateConfig(c=>({...c,sharing:{...c.sharing,enabled:false,errorCode:e.code||'SETUP_FAILED',authUrl:e.authUrl||''}}));
      if(settings().routeOwner===INSTALL_ID)try{await stopOwnedRoute(settings());updateConfig(c=>({...c,sharing:{...c.sharing,cleanupPending:false,routeOwner:null}}));}catch{updateConfig(c=>({...c,sharing:{...c.sharing,cleanupPending:true}}));}
      await ensureListener().catch(() => {});
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
