import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'mydash-sharing-workbench-'));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const port=await freePort(),content=await freePort(),share=await freePort();
fs.writeFileSync(path.join(home,'config.json'),JSON.stringify({port,contentPort:content,access:'local',baseUrl:`http://127.0.0.1:${port}`,lang:'en',update:{mode:'off'},prompts:{pushDelay:-1},sharing:{enabled:true,localPort:share}}));
const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,MYDASH_HOME:home,MYDASH_PORT:String(port),MYDASH_CONTENT_PORT:String(content),MYDASH_BASE_URL:`http://127.0.0.1:${port}`,MYDASH_CODEX_HOME:path.join(home,'codex'),MYDASH_CLAUDE_HOME:path.join(home,'claude')},stdio:'ignore'});
let ready=false;for(let n=0;n<100;n++){try{ready=(await fetch(`http://127.0.0.1:${port}/healthz`)).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,50));}
test.after(async()=>{child.kill();await new Promise(r=>child.once('exit',r));fs.rmSync(home,{recursive:true,force:true});});
test('owner share APIs exist only on the private workbench, never the content or public listeners',async()=>{
 assert(ready);
 assert.equal((await fetch(`http://127.0.0.1:${content}/api/shares`)).status,404);
 assert.equal((await fetch(`http://127.0.0.1:${content}/api/sharing/status`)).status,404);
 assert.equal((await fetch(`http://127.0.0.1:${port}/api/shares`)).status,200);
 assert.equal((await fetch(`http://127.0.0.1:${share}/api/shares`)).status,404);
});
