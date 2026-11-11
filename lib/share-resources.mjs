// An explicit, immutable resource boundary for the public reader. Never fetch URLs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { DATA_DIR, readMeta, readConfig } from './store.mjs';
import { kindOf, mimeOf } from './kinds.mjs';
import { findSecrets } from './secrets.mjs';

export const SHARE_MAX_BYTES = 20 * 1024 * 1024;
export const SHARE_KINDS = new Set(['md','pdf','image','html','table','sheet','docx','json','code','text']);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code, status: 400 }); };
function safePart(s) { return typeof s === 'string' && s.length > 0 && s.length <= 120 && !/[/\\:\x00-\x1f]/.test(s) && !s.startsWith('.'); }
export function safeShareRel(s) {
  return typeof s === 'string' && s.length <= 600 && s.split('/').every(safePart) && !path.posix.isAbsolute(s);
}
function sourcePath(project, slug, version, rel) {
  if (!safePart(project) || !safePart(slug) || !Number.isInteger(version) || version < 1 || !safeShareRel(rel)) return null;
  let cursor = DATA_DIR;
  try {
    for (const segment of [project, slug, `v${version}`, ...rel.split('/')]) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    return fs.statSync(cursor).isFile() ? cursor : null;
  } catch { return null; }
}
function relativeResource(value, rel) {
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/|#|\\)/i.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value.split(/[?#]/)[0]);
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(rel), decoded));
    return safeShareRel(p) ? p : null;
  } catch { return null; }
}
function embeddedRefs(text, rel, kind) {
  const refs = new Set();
  const add = value => { const p=relativeResource(value,rel); if(p)refs.add(p); };
  if (kind === 'md') {
    const marked = new Marked();
    marked.walkTokens(marked.lexer(text), token => { if(token.type==='image')add(token.href); });
  }
  if (kind === 'md' || kind === 'html') sanitizeHtml(text, {
    allowedTags: ['img','link'], allowedAttributes: { img:['src'],link:['rel','href'] },
    transformTags: {
      img: (tag, a) => { add(a.src); return {tagName:tag,attribs:a}; },
      link: (tag,a) => { if(a.rel==='stylesheet')add(a.href);return {tagName:tag,attribs:a}; },
    },
  });
  if (kind === 'css') for (const m of text.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/gi)) add(m[1]);
  return [...refs];
}
export function buildShareSnapshot({ project, slug, files, main, version, approvedResources }) {
  if (!safePart(project)||!safePart(slug)) fail('INVALID_FILE');
  const meta=readMeta(project,slug);
  if(!meta?.versions?.length) fail('SOURCE_MISSING');
  const ver=meta.versions.find(v=>v.v===version);
  if(!ver)fail('SOURCE_MISSING');
  if(!Array.isArray(files)||!files.length||files.length>128||!files.includes(main))fail('INVALID_FILE');
  const byPath=new Map(ver.files.map(f=>[f.path,f]));
  const selected=[...new Set(files)];
  const resources=new Set(), digests={}, selectedFiles=[];
  const entries=[];let totalSize=0;
  const add=(rel,dependent=false)=>{
    if(resources.has(rel))return;
    if(!safeShareRel(rel))fail('INVALID_FILE');
    const info=byPath.get(rel),abs=sourcePath(project,slug,version,rel);
    if(!info||!abs)fail(rel===main?'FILE_MISSING':'INVALID_FILE');
    const kind=kindOf(rel), ext=path.posix.extname(rel).toLowerCase();
    if(dependent&&!['image'].includes(kind)&&!['.css','.woff','.woff2','.ttf','.otf'].includes(ext))return;
    const b=fs.readFileSync(abs);
    totalSize+=b.length;
    if(totalSize>SHARE_MAX_BYTES||resources.size>=256)fail('TOO_LARGE');
    if(!['image','pdf','sheet','docx'].includes(kind)&&b.length>2*1024*1024)fail('TOO_LARGE');
    resources.add(rel);digests[rel]=hash(b);entries.push({dest:rel,content:b});
    const nestedKind=ext==='.css'?'css':kind;
    if(['md','html','css'].includes(nestedKind))for(const ref of embeddedRefs(b.toString('utf8'),rel,nestedKind))add(ref,true);
  };
  for(const rel of selected){
    const kind=kindOf(rel);
    if(!SHARE_KINDS.has(kind))fail('UNSUPPORTED_FILE');
    add(rel);
    const f=byPath.get(rel);
    selectedFiles.push({path:rel,kind,size:f.size});
  }
  if(approvedResources){
    const approved=new Set([...approvedResources,...selected]);
    if([...resources].some(p=>!approved.has(p)))fail('NEW_RESOURCES');
  }
  if(findSecrets(entries).length)fail('SENSITIVE_FILE');
  return {project,slug,version,main,files:selectedFiles,resources:[...resources],digests,totalSize,time:ver.time,
    fingerprint:hash(Buffer.from(JSON.stringify([version,selected,[...resources].map(p=>[p,digests[p]])])))};
}
export function shareResourcePath(snapshot, rel) {
  if(!snapshot?.resources?.includes(rel))return null;
  const abs=sourcePath(snapshot.project,snapshot.slug,snapshot.version,rel);
  if(!abs)return null;
  try{return hash(fs.readFileSync(abs))===snapshot.digests[rel]?abs:null;}catch{return null;}
}
export function resolveShareUrl(value,{snapshot,rel,shareId,asset=false,embed=false}) {
  if(!value)return '';
  if(/^https?:\/\//i.test(value)){
    const cfg=readConfig(),hosts=new Set(['localhost','127.0.0.1',...(cfg.tailnetNames||[])]);
    for(const candidate of [cfg.baseUrl,cfg.httpsUrl,cfg.sharing?.publicUrl,...(cfg.allowedHosts||[])])try{hosts.add(new URL(candidate.includes('://')?candidate:'http://'+candidate).hostname.toLowerCase());}catch{}
    try{const u=new URL(value);if(hosts.has(u.hostname.toLowerCase())){
      if(u.pathname.startsWith('/s/'))return asset?'':u.href;
      value=u.pathname+u.search+u.hash;
    }}catch{return '';}
  }
  if(value.startsWith('#'))return asset?'':`#shared-${value.slice(1)}`;
  const prefix=`/f/${encodeURIComponent(snapshot.project)}/${encodeURIComponent(snapshot.slug)}/v${snapshot.version}/`;
  let p;
  if(value.startsWith(prefix)) { try{p=decodeURIComponent(value.slice(prefix.length).split(/[?#]/)[0]);}catch{return '';} }
  else if(value.startsWith(`/p/${encodeURIComponent(snapshot.project)}/${encodeURIComponent(snapshot.slug)}`)) {
    try{p=new URL(value,'http://share.invalid').searchParams.get('f')||snapshot.main;}catch{return '';}
  } else if(/^https?:\/\//i.test(value)&&!asset) {
    try{const u=new URL(value);if(/^(localhost|127\.|0\.|10\.|192\.168\.|100\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname))return '';return u.href;}catch{return '';}
  } else if(/^mailto:/i.test(value)&&!asset)return value;
  else p=relativeResource(value,rel);
  if(!p||!snapshot.resources.includes(p))return '';
  if(!asset&&snapshot.files.some(f=>f.path===p))return `/s/${encodeURIComponent(shareId)}?f=${encodeURIComponent(p)}`;
  const kind=kindOf(p);
  if(asset&&kind!=='image'&&!/\.(woff2?|ttf|otf)$/i.test(p))return '';
  if(embed){
    const abs=shareResourcePath(snapshot,p);if(!abs)return '';
    return `data:${mimeOf(p).split(';')[0]};base64,${safeAssetBytes(abs,p).toString('base64')}`;
  }
  return `/s/${encodeURIComponent(shareId)}/asset?file=${encodeURIComponent(p)}&v=${snapshot.version}`;
}
export function safeAssetBytes(abs, rel) {
  const bytes=fs.readFileSync(abs);
  if(/\.svg$/i.test(rel))return Buffer.from(sanitizeHtml(bytes.toString('utf8'),{
    allowedTags:['svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','linearGradient','radialGradient','stop','clipPath','title','desc'],
    allowedAttributes:{'*':['viewBox','xmlns','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','transform','opacity','offset','stop-color','font-size','font-family','text-anchor','id']},
    parser:{lowerCaseTags:false,lowerCaseAttributeNames:false},
    transformTags:{'*':(tag,a)=>({tagName:tag,attribs:{...Object.fromEntries(Object.entries(a).filter(([,v])=>!/(?:url\(|https?:|data:|javascript:)/i.test(v))),...(tag==='svg'?{xmlns:'http://www.w3.org/2000/svg'}:{})}})},
  }));
  if(kindOf(rel)==='image') {
    const good=/\.(png)$/i.test(rel)?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      :/\.jpe?g$/i.test(rel)?bytes[0]===255&&bytes[1]===216
      :/\.gif$/i.test(rel)?/^GIF8[79]a/.test(bytes.subarray(0,6).toString())
      :/\.webp$/i.test(rel)?bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'
      :/\.(avif|heic)$/i.test(rel)?bytes.subarray(4,8).toString()==='ftyp'
      :/\.bmp$/i.test(rel)?bytes.subarray(0,2).toString()==='BM'
      :/\.ico$/i.test(rel)?bytes.subarray(0,4).equals(Buffer.from([0,0,1,0])):false;
    if(!good)fail('INVALID_IMAGE');
  }
  return bytes;
}
export function sanitiseSharedHtml(html,options) {
  const allowedTags=sanitizeHtml.defaults.allowedTags.concat(['img','figure','figcaption','article','details','summary','pre','kbd','samp','input']);
  return sanitizeHtml(html,{
    allowedTags, allowedAttributes:{'*':['class','id'],img:['src','alt','width','height','loading'],a:['href','title','rel','target','aria-hidden','tabindex'],td:['colspan','rowspan'],th:['colspan','rowspan','scope'],input:['type','checked','disabled']},
    allowedClasses:{'*':['anchor','frontmatter','prose','docx','table-wrap','data','code','standalone','hljs','mermaid-wrap','mermaid','shot','trunc',/^hljs-/,/^language-/]},
    allowedSchemes:['http','https','mailto','data'],allowProtocolRelative:false,
    exclusiveFilter:frame=>frame.attribs.class?.split(/\s+/).includes('frontmatter'),
    transformTags:{'*':(tag,a)=>{
      const out={...a};
      if(out.id)out.id='shared-'+out.id;
      if(tag==='a'){out.href=resolveShareUrl(a.href,options);out.rel='noopener noreferrer';if(/^https?:/.test(out.href))out.target='_blank';else delete out.target;}
      if(tag==='img'){out.src=resolveShareUrl(a.src,{...options,asset:true});out.loading='lazy';}
      if(tag==='input'){out.type='checkbox';out.disabled='';delete out.id;}
      return {tagName:tag,attribs:out};
    }},
  });
}
