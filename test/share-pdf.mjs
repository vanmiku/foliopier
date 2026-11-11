import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'mydash-share-pdf-'));
process.env.MYDASH_HOME=home;
const {findPdfBrowser,pdfFromHtml}=await import('../lib/share-pdf.mjs');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
test('real PDF has a valid header, deduplicates work, and cannot fetch HTTP resources',{skip:!findPdfBrowser(),timeout:40000},async()=>{
  let requests=0;
  const server=http.createServer((req,res)=>{requests++;res.end('private');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const html=`<!doctype html><meta charset=utf-8><h1>中文分享文档</h1><p>Only public text.</p><img src="http://127.0.0.1:${server.address().port}/private">`;
    const [a,b]=await Promise.all([pdfFromHtml(html),pdfFromHtml(html)]);
    assert(a.subarray(0,5).equals(Buffer.from('%PDF-')));assert(a.length>1000);assert(a.equals(b));
    assert.equal(requests,0);
  }finally{server.close();}
});
