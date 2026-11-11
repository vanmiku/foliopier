// Dedicated public listener: it has no routes, credentials or forwarding path to
// the workbench. Loopback/Tailnet identity never grants document access here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readConfig, INSTALL_ID } from './store.mjs';
import { withLang } from './i18n.mjs';
import { mimeOf } from './kinds.mjs';
import { currentShare, getShare, unlockShare, verifyShareSession, addShareComment, visitorShareComments } from './shares.mjs';
import { shareResourcePath, safeAssetBytes } from './share-resources.mjs';
import { shareGatePage, shareReaderPage, sharePdfHtml } from './share-public-views.mjs';
import { pdfFromHtml, findPdfBrowser } from './share-pdf.mjs';
const APP=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cookieName=id=>`mydash_share_${id}`;
const csrf=token=>crypto.createHash('sha256').update('share-csrf:'+token).digest('hex');
const sessionCookie=(id,token,expiresAt)=>`${cookieName(id)}=${token}; Path=/s/${id}; Max-Age=${Math.max(0,Math.floor((Date.parse(expiresAt)-Date.now())/1000))}; Secure; HttpOnly; SameSite=Strict`;
function tokenOf(req,id){return /(?:^|;\s*)/.test(req.headers.cookie||'')?(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName(id)+'='))?.slice(cookieName(id).length+1)||'':'';}
const headers={
  'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow, noarchive','Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()',
};
function send(res,status,body,type='text/html; charset=utf-8',extra={}){res.writeHead(status,{...headers,'Content-Type':type,...extra});res.end(body);}
const json=(res,status,value)=>send(res,status,JSON.stringify(value),'application/json; charset=utf-8');
const publicError=(res,status=410)=>json(res,status,{error:'This share is unavailable.',code:status===401?'SHARE_UNAUTHORIZED':status===429?'RATE_LIMITED':'SHARE_UNAVAILABLE'});
async function bodyOf(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')||req.headers['x-mydash-share']!=='1')throw Object.assign(new Error('Invalid content type.'),{status:415});
  let size=0,text='';for await(const chunk of req){size+=chunk.length;if(size>16384)throw Object.assign(new Error('Request too large.'),{status:413});text+=chunk;}
  try{return JSON.parse(text);}catch{throw Object.assign(new Error('Invalid JSON.'),{status:400});}
}
function allowedHost(req){
  const h=req.headers.host||'',port=req.socket.localPort;
  if([`127.0.0.1:${port}`,`localhost:${port}`].includes(h))return true;
  try{return new URL(readConfig().sharing?.publicUrl).host===h;}catch{return false;}
}
function validOrigin(req){try{const u=new URL(req.headers.origin);return u.host===req.headers.host&&['https:','http:'].includes(u.protocol);}catch{return false;}}
function asset(url){
  const rel=url.pathname.slice('/_share/'.length);
  if(!/^(?:static\/(?:app\.css|share-public\.css|file-nav\.js|share-public\.js|pdf-view\.mjs|icon\.svg|fonts\/[\w.-]+\.(?:woff2?|ttf))|vendor\/hljs\/github(?:-dark)?\.min\.css|vendor\/mermaid\.min\.js|vendor\/pdfjs\/(?:build\/pdf(?:\.worker)?\.min\.mjs|cmaps\/[\w.-]+\.bcmap|standard_fonts\/[\w.-]+))$/.test(rel))return null;
  let file=path.join(APP,rel);
  if(rel.startsWith('vendor/hljs/'))file=path.join(APP,'node_modules','highlight.js','styles',path.basename(rel));
  if(rel==='vendor/mermaid.min.js')file=path.join(APP,'node_modules','mermaid','dist','mermaid.min.js');
  if(rel.startsWith('vendor/pdfjs/'))file=path.join(APP,'node_modules','pdfjs-dist',rel.slice('vendor/pdfjs/'.length));
  try{let bytes=fs.readFileSync(file);if(rel==='static/app.css'||rel==='static/pdf-view.mjs')bytes=Buffer.from(bytes.toString().replaceAll('/static/','/_share/static/').replaceAll('/vendor/','/_share/vendor/'));return {bytes,type:mimeOf(file)};}catch{return null;}
}
export function createShareHandler({onComment=async()=>{}}={}){
  return (req,res)=>{
    let url;try{url=new URL(req.url,'http://share.invalid');}catch{return publicError(res,400);}
    const locale=url.searchParams.get('l')==='zh'||(!url.searchParams.get('l')&&/^zh/i.test(req.headers['accept-language']||''))?'zh':'en';
    return withLang(locale,async()=>{
      const nonce=crypto.randomBytes(18).toString('base64');
      const policy=`default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
      res.setHeader('Content-Security-Policy',policy);
      if(!allowedHost(req))return publicError(res,421);
      if(url.pathname==='/healthz'&&['GET','HEAD'].includes(req.method))return send(res,200,'ok','text/plain',{'X-Mydash-Share-Id':INSTALL_ID});
      if(readConfig().sharing?.enabled!==true)return publicError(res,410);
      if(url.pathname.startsWith('/_share/')&&['GET','HEAD'].includes(req.method)){
        const a=asset(url);return a?send(res,200,req.method==='HEAD'?'':a.bytes,a.type):publicError(res,404);
      }
      const match=/^\/s\/([a-f0-9]{32})(?:\/(unlock|status|asset|comments|pdf))?$/.exec(url.pathname);
      if(!match)return send(res,404,shareGatePage({id:'',nonce,unavailable:true}));
      const [,id,action]=match;
      let r;try{r=getShare(id);}catch{}
      if(!r)return action?publicError(res):send(res,410,shareGatePage({id,nonce,unavailable:true}));
      if(req.method==='POST'){
        if(!validOrigin(req))return publicError(res,403);
        const body=await bodyOf(req);
        if(action==='unlock'){
          if(!await currentShare(id))return publicError(res,410);
          // The listener only accepts loopback proxies; do not trust arbitrary
          // forwarded IP headers as a way to bypass global credential limits.
          const attempt=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`mydash_share_attempt_${id}=`))?.split('=')[1];
          const auth=await unlockShare(id,String(body.code||''),{clientKey:/^[a-f0-9]{32}$/.test(attempt||'')?attempt:req.socket.remoteAddress||'proxy'});
          return send(res,200,JSON.stringify({ok:true}),'application/json; charset=utf-8',{'Set-Cookie':sessionCookie(id,auth.token,auth.maximumExpiresAt)});
        }
        const token=tokenOf(req,id),auth=verifyShareSession(id,token);
        if(!auth||req.headers['x-share-csrf']!==csrf(token))return publicError(res,401);
        r=await currentShare(id);
        if(!r||!verifyShareSession(id,token))return publicError(res,410);
        if(action==='comments'){
          const comment=await addShareComment(id,auth.visitorId,body);
          await onComment(r,comment).catch(()=>{});
          return json(res,200,{ok:true,comment});
        }
        return publicError(res,404);
      }
      if(!['GET','HEAD'].includes(req.method))return publicError(res,405);
      const token=tokenOf(req,id),auth=verifyShareSession(id,token);
      if(!auth)return action?publicError(res,401):send(res,200,shareGatePage({id,nonce}),undefined,{'Set-Cookie':`mydash_share_attempt_${id}=${crypto.randomBytes(16).toString('hex')}; Path=/s/${id}; Max-Age=900; Secure; HttpOnly; SameSite=Strict`});
      r=await currentShare(id);
      if(!r||!verifyShareSession(id,token))return publicError(res,410);
      if(action==='asset'){
        const version=Number(url.searchParams.get('v'));
        if(version!==r.snapshot.version)return publicError(res,409);
        const rel=url.searchParams.get('file')||'';
        const abs=shareResourcePath(r.snapshot,rel);if(!abs)return publicError(res,404);
        const bytes=safeAssetBytes(abs,rel),type=mimeOf(rel);
        // Only document resources; scripts/styles from items cannot execute in
        // the reader origin. HTML previews are sanitized opaque srcdoc frames.
        if(!/^image\//.test(type)&&type!=='application/pdf'&&!/^font\//.test(type))return publicError(res,404);
        return send(res,200,req.method==='HEAD'?'':bytes,type,{'Content-Security-Policy':"default-src 'none'; sandbox"});
      }
      if(action==='comments')return json(res,200,{comments:visitorShareComments(id,auth.visitorId)});
      if(action==='status')return send(res,200,JSON.stringify({version:r.snapshot.version,expiresAt:r.expiresAt}),'application/json; charset=utf-8',{'Set-Cookie':sessionCookie(id,token,verifyShareSession(id,token).maximumExpiresAt)});
      const file=url.searchParams.get(action==='pdf'?'file':'f')||r.main;
      const entry=r.snapshot.files.find(f=>f.path===file);if(!entry)return publicError(res,404);
      if(action==='pdf'){
        if(!r.allowPdf)return publicError(res,403);
        const v=Number(url.searchParams.get('v')||r.snapshot.version);if(v!==r.snapshot.version)return publicError(res,409);
        if(!['md','text','code','json','table','sheet','docx','pdf'].includes(entry.kind))return publicError(res,400);
        const bytes=entry.kind==='pdf'?fs.readFileSync(shareResourcePath(r.snapshot,file)):await pdfFromHtml(await sharePdfHtml(r,file));
        const now=getShare(id);if(!now||!now.allowPdf||!verifyShareSession(id,token)||now.snapshot.fingerprint!==r.snapshot.fingerprint)return publicError(res,410);
        return send(res,200,req.method==='HEAD'?'':bytes,'application/pdf',{'Content-Disposition':`attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(path.basename(file).replace(/\.[^.]*$/,'')+'.pdf')}`});
      }
      if(action)return publicError(res,404);
      const html=await shareReaderPage({share:r,file,nonce,csrf:csrf(token),pdfReady:Boolean(findPdfBrowser()),comments:visitorShareComments(id,auth.visitorId)});
      if(!getShare(id)||!verifyShareSession(id,token))return publicError(res,410);
      return send(res,200,req.method==='HEAD'?'':html);
    }).catch(e=>{
      if(!res.headersSent)publicError(res,e.status||400);else res.end();
    });
  };
}
