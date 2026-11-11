import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'mydash-share-rendering-'));process.env.MYDASH_HOME=home;
const {buildShareSnapshot}=await import('../lib/share-resources.mjs');const {renderSharedFile}=await import('../lib/share-public-views.mjs');
const root=path.join(home,'data','p','s','v1');fs.mkdirSync(path.join(root,'assets'),{recursive:true});
const files={'main.md':'# Main','page.html':'<html><head><link rel="stylesheet" href="assets/theme.css"></head><body><div class="hero">Public preview</div></body></html>','assets/theme.css':'.hero{background-image:url(chart.svg);height:20px}','assets/chart.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="3"/></svg>'};
for(const [p,s]of Object.entries(files))fs.writeFileSync(path.join(root,p),s);
fs.writeFileSync(path.join(root,'../meta.json'),JSON.stringify({versions:[{v:1,main:'main.md',time:new Date().toISOString(),files:Object.keys(files).map(p=>({path:p,size:fs.statSync(path.join(root,p)).size}))}]}));
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
test('static HTML preview resolves stylesheet images against the stylesheet directory',async()=>{
 const snapshot=buildShareSnapshot({project:'p',slug:'s',version:1,main:'main.md',files:['main.md','page.html']});
 const result=await renderSharedFile({id:'a'.repeat(32),project:'p',slug:'s',snapshot},'page.html');
 assert(result.html.includes('data:image/svg+xml;base64,'));assert(!result.html.includes('background-image:url(&quot;&quot;)'));
});
test('cached public rendering never bypasses a missing or changed source',async()=>{
 const snapshot=buildShareSnapshot({project:'p',slug:'s',version:1,main:'main.md',files:['main.md']});
 const r={id:'b'.repeat(32),project:'p',slug:'s',snapshot};await renderSharedFile(r,'main.md');
 fs.writeFileSync(path.join(root,'main.md'),'# Changed outside publishing');await assert.rejects(renderSharedFile(r,'main.md'));
 fs.rmSync(path.join(root,'main.md'));await assert.rejects(renderSharedFile(r,'main.md'));
});
