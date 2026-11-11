import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('a broken browser pipe rejects PDF generation without crashing the server',{skip:process.platform==='win32',timeout:15000},()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'mydash-pdf-pipe-'));
 try{
  const fake=path.join(home,'browser');fs.writeFileSync(fake,`#!${process.execPath}
const fs=require('fs');let b='';fs.createReadStream(null,{fd:3,autoClose:false}).on('data',c=>{b+=c.toString();if(b.includes('\\0')){const m=JSON.parse(b.split('\\0')[0]);fs.writeSync(4,JSON.stringify({id:m.id,result:{targetId:'fake'}})+'\\0');fs.closeSync(3);setTimeout(()=>process.exit(0),600);}});
`);fs.chmodSync(fake,0o755);
  const code=`import {pdfFromHtml} from ${JSON.stringify(new URL('../lib/share-pdf.mjs',import.meta.url).href)};try{await pdfFromHtml('<h1>test</h1>');process.exitCode=2}catch(e){console.log('caught',e.message)}`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,MYDASH_HOME:home,MYDASH_PDF_BROWSER:fake},encoding:'utf8',timeout:12000});
  assert.equal(r.status,0,r.stderr);assert(r.stdout.includes('caught'));assert(!r.stderr.includes('Unhandled'));
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
