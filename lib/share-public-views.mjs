import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sanitizeHtml from 'sanitize-html';
import { renderFile, esc } from './render.mjs';
import { fileNavigation } from './views.mjs';
import { t, lang, kindLabel } from './i18n.mjs';
import { kindOf } from './kinds.mjs';
import { shareResourcePath, resolveShareUrl, sanitiseSharedHtml } from './share-resources.mjs';
const APP=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cache=new Map();
let cacheBytes=0;
const MAX_CACHE_BYTES=32*1024*1024;
const data=o=>JSON.stringify(o).replace(/</g,'\\u003c');
const css=()=>fs.readFileSync(path.join(APP,'static','app.css'),'utf8').replaceAll('/static/','/_share/static/');
function skeleton({title=t('Document sharing'),body,nonce,config={}}) {
  const strings={
    'Copy code':t('Copy code'),
    'Copied':t('Copied'),
    'Select and copy the code.':t('Select and copy the code.'),
    'Enlarge image':t('Enlarge image'),
    'Time remaining':t('Time remaining'),
    'Checking connection…':t('Checking connection…'),
    'Access code is incorrect.':t('Access code is incorrect.'),
    'This share is no longer available.':t('This share is no longer available.'),
    'The document has been updated.':t('The document has been updated.'),
    'View update':t('View update'),
    'Close':t('Close'),
    'Your comment was sent.':t('Your comment was sent.'),
    'Your comment was not sent. Your text has been kept.':t('Your comment was not sent. Your text has been kept.'),
    'PDF download failed. Please try again.':t('PDF download failed. Please try again.'),
    'Preparing PDF…':t('Preparing PDF…'),
    'Download PDF':t('Download PDF'),
    'Connection unavailable. Please try again.':t('Connection unavailable. Please try again.'),
    'Too many attempts. Please try again later.':t('Too many attempts. Please try again later.'),
    'Loading PDF…':t('Loading PDF…'),
    '{n} page|{n} pages':t('{n} page|{n} pages'),
    'This page failed to render: {msg}':t('This page failed to render: {msg}')
  };
  return `<!doctype html><html lang="${lang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>${esc(title)} · mydash</title><link rel="icon" href="/_share/static/icon.svg"><link rel="stylesheet" href="/_share/static/app.css"><link rel="stylesheet" href="/_share/static/share-public.css"><link rel="stylesheet" href="/_share/vendor/hljs/github.min.css"><script nonce="${nonce}">window.__SHARE=${data(config)};window.__T=${data(strings)};</script><script src="/_share/static/file-nav.js" defer></script><script src="/_share/static/share-public.js" defer></script></head><body class="public-share"><header class="share-brand"><a href="https://github.com/vanmiku/mydash" target="_blank" rel="noopener noreferrer"><img src="/_share/static/icon.svg" alt="" width="30" height="30">mydash</a><div><a href="https://github.com/vanmiku/mydash" target="_blank" rel="noopener noreferrer">${t('Learn about mydash')}</a><button type="button" data-share-theme aria-label="${t('Appearance')}">◐</button></div></header>${body}<footer class="share-footer"><strong>${t('Shared with mydash')}</strong><p>${t('Read, review and share the documents your agents make.')}</p><a href="https://github.com/vanmiku/mydash" target="_blank" rel="noopener noreferrer">${t('Learn about mydash and get started')}</a></footer></body></html>`;
}
export function shareGatePage({id,nonce,unavailable=false}) {
  return skeleton({nonce,config:{id,gate:!unavailable},body:`<main class="share-gate"><h1>${unavailable?t('This share is no longer available.'):t('You received a document share')}</h1><p>${unavailable?t('Please contact the person who shared it.'):t('Enter the access code from the person who shared this document.')}</p>${unavailable?'':`<form data-share-unlock><label for="share-code">${t('Access code')}</label><input id="share-code" name="code" type="text" inputmode="numeric" autocomplete="off" maxlength="8" pattern="[0-9]{8}" required aria-describedby="share-error"><p id="share-error" class="share-error" role="status"></p><button type="submit" class="btn">${t('View document')}</button></form>`}</main>`});
}
export async function renderSharedFile(r,file,{embed=false}={}) {
  const snapshot=r.snapshot,rel=file||snapshot.main;
  const key=[snapshot.fingerprint,r.id,rel,embed,lang()].join('|');
  const info=snapshot.files.find(f=>f.path===rel),abs=shareResourcePath(snapshot,rel);
  if(!info||!abs)throw Object.assign(new Error('File is unavailable.'),{status:404});
  if(cache.has(key))return cache.get(key).value;
  const options={snapshot,rel,shareId:r.id,embed};
  let html,toc=[],needs={};
  if(info.kind==='html'){
    const raw=fs.readFileSync(abs,'utf8');
    const rewriteCss=(text,base)=>text.replace(/@import[^;]+;/gi,'').replace(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/gi,(_,url)=>`url("${resolveShareUrl(url,{...options,rel:base,asset:true,embed:true})}")`).replace(/</g,'\\3c ');
    let styles=[...raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(m=>rewriteCss(m[1],rel)).join('\n');
    for(const m of raw.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)){
      try{const p=path.posix.normalize(path.posix.join(path.posix.dirname(rel),decodeURIComponent(m[1].split(/[?#]/)[0])));const f=shareResourcePath(snapshot,p);if(f&&p.endsWith('.css'))styles+='\n'+rewriteCss(fs.readFileSync(f,'utf8'),p);}catch{}
    }
    const safe=sanitizeHtml(raw,{allowedTags:sanitizeHtml.defaults.allowedTags.concat(['img','figure','figcaption','details','summary']),allowedAttributes:{'*':['class','id','style'],img:['src','alt','width','height'],a:['href','title']},allowedSchemes:['data','http','https'],allowedStyles:{'*':{'color':[/^#[\da-f]+$/i,/^[a-z]+$/i],'background-color':[/^#[\da-f]+$/i,/^[a-z]+$/i],'font-size':[/^[\d.]+(?:px|em|rem|%)$/],'text-align':[/^(?:left|right|center|justify)$/]}},transformTags:{'*':(tag,a)=>({tagName:tag,attribs:{...a,...(tag==='img'?{src:resolveShareUrl(a.src,{...options,asset:true,embed:true})}:{}),...(tag==='a'?{href:resolveShareUrl(a.href,options)}:{})}})}});
    const doc=`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"><style>${styles}</style>${safe}`;
    html=`<p class="share-hint">${t('Web pages are shown as read-only previews; scripts are disabled.')}</p><iframe class="share-web-preview" sandbox title="${esc(rel)}" srcdoc="${esc(doc)}"></iframe>`;
  }else{
    const rendered=await renderFile({abs,rel,project:r.project,slug:r.slug,v:snapshot.version,fileSet:new Set(snapshot.resources)});
    html=sanitiseSharedHtml(rendered.html,options);toc=rendered.toc||[];needs=rendered.needs||{};
    if(info.kind==='pdf')html=`<div class="pdf-view" data-src="/s/${r.id}/asset?file=${encodeURIComponent(rel)}&amp;v=${snapshot.version}"><p class="pdf-status">${t('Loading PDF…')}</p></div>`;
  }
  const value={html,toc,needs,kind:info.kind,rel};
  const bytes=Buffer.byteLength(JSON.stringify(value));
  if(bytes<=8*1024*1024){
    if(cache.has(key)){cacheBytes-=cache.get(key).bytes;cache.delete(key);}
    while(cache.size&&(cache.size>=80||cacheBytes+bytes>MAX_CACHE_BYTES)){const oldest=cache.keys().next().value;cacheBytes-=cache.get(oldest).bytes;cache.delete(oldest);}
    cache.set(key,{value,bytes});cacheBytes+=bytes;
  }
  return value;
}
export async function shareReaderPage({share:r,file,nonce,csrf,pdfReady,comments=[],preview=false}) {
  const snapshot=r.snapshot,original=await renderSharedFile(r,file,{embed:preview});
  const rendered=preview?{...original,html:original.html.replaceAll(`/s/${r.id}/asset?`,`/share-preview/${r.id}/asset?`)}:original;
  const files=snapshot.files;
  const tabs=files.map(f=>`<a class="tab${f.path===rendered.rel?' on':''}"${f.path===rendered.rel?' aria-current="page"':''} href="/s/${r.id}?f=${encodeURIComponent(f.path)}"><span class="tab-kind">${esc(kindLabel(f.kind))}</span>${esc(f.path)}</a>`).join('');
  const canPdf=r.allowPdf&&['md','text','code','json','table','sheet','docx','pdf'].includes(rendered.kind);
  const toc=rendered.toc.map(x=>`<li class="d${x.depth}"><a href="#shared-${esc(x.id)}">${sanitizeHtml(x.text,{allowedTags:[],allowedAttributes:{}})}</a></li>`).join('');
  const config={id:r.id,file:rendered.rel,version:snapshot.version,expiresAt:r.expiresAt,csrf,mermaid:Boolean(rendered.needs.mermaid),pdf:rendered.kind==='pdf',gate:false,preview};
  const body=`<main class="share-main"><header><p class="share-hint">${t('Read-only document share')}</p><h1>${esc(r.title)}</h1><p class="share-meta">${r.publisher?esc(r.publisher)+' · ':''}v${snapshot.version} · ${t('Updated')} <time data-share-date datetime="${esc(snapshot.time||r.createdAt)}">${esc(snapshot.time||r.createdAt)}</time> · ${t('Expires')} <time data-share-date data-share-expiry datetime="${esc(r.expiresAt)}">${esc(r.expiresAt)}</time> <span data-share-countdown></span></p><div class="share-actions">${canPdf?`<button type="button" class="act" data-share-pdf${pdfReady?'':' disabled'}>${t('Download PDF')}</button>${pdfReady?'':`<small>${t('PDF downloads are not ready on the sharing computer.')}</small>`}`:''}${r.allowComments?`<a class="act" href="#share-comment-panel">${t('Leave a private comment')}</a>`:''}</div><div class="share-update" data-share-update hidden><span>${t('The document has been updated.')}</span><button type="button" class="act" data-share-refresh>${t('View update')}</button><button type="button" class="act" data-share-dismiss>${t('Close')}</button></div><p class="share-error" data-share-status role="status"></p>${files.length>1?fileNavigation(tabs,'shared-document-files'):''}<p class="share-current">${t('File')}: ${esc(rendered.rel)}</p></header><div class="share-reading"><div class="share-document"><div class="sheet kind-${esc(rendered.kind)}">${rendered.html}</div></div>${toc?`<aside class="share-toc"><details open><summary>${t('Contents')}</summary><ol>${toc}</ol></details></aside>`:''}</div>${r.allowComments?`<section id="share-comment-panel"><h2>${t('Leave a private comment')}</h2><p class="share-hint">${t('Only you and the person who shared this document can see your comments. Comments do not send instructions to an agent.')}</p><form data-share-comment><label>${t('Name (optional)')}<input name="nickname" maxlength="60" autocomplete="nickname"></label><label>${t('Comment')}<textarea name="text" maxlength="2000" required></textarea></label><button type="submit" class="btn">${t('Send comment')}</button></form><div class="share-comments">${comments.map(c=>`<article><strong>${esc(c.nickname||t('Anonymous visitor'))}</strong><small>${esc(c.file)} · v${c.version}</small><p>${esc(c.text)}</p></article>`).join('')}</div></section>`:''}</main>`;
  return skeleton({title:r.title,body:preview?body.replaceAll(`/s/${r.id}?`,`/share-preview/${r.id}?`):body,nonce,config});
}
export async function sharePdfHtml(r,file) {
  const rendered=await renderSharedFile(r,file,{embed:true});
  const fontDir=path.join(APP,'static','fonts');let fonts='';
  try{for(const n of fs.readdirSync(fontDir).filter(n=>/\.woff2$/.test(n)).slice(0,3))fonts+=`@font-face{font-family:${n.includes('Mono')?'"Geist Mono"':'"Geist"'};font-weight:100 900;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(fontDir,n)).toString('base64')})}`;}catch{}
  const mermaid=rendered.needs.mermaid?`<script>${fs.readFileSync(path.join(APP,'node_modules','mermaid','dist','mermaid.min.js'),'utf8').replace(/<\/script/gi,'<\\/script')}</script><script>mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral'});window.__shareDiagramsReady=mermaid.run({querySelector:'.mermaid'}).catch(()=>{});</script>`:'';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>${css()}${fonts}body{padding:0;color:#18191b;background:white;font-family:var(--sans)}.sheet{border:0;box-shadow:none;padding:0}.prose{font-size:12pt}pre,table,img{max-width:100%}thead{display:table-header-group}tr,img{break-inside:avoid}.prose h1,.prose h2,.prose h3{break-after:avoid}a{color:#304be9}footer{margin-top:24pt;color:#666;font-size:9pt}</style></head><body><h1>${esc(r.title)}</h1><p>${esc(file)} · v${r.snapshot.version} · ${esc(r.snapshot.time||'')}</p>${rendered.html}<footer>mydash · ${t('Shared with mydash')}</footer>${mermaid}</body></html>`;
}
