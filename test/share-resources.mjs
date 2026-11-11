import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-share-resources-'));
process.env.MYDASH_HOME = home;
const { buildShareSnapshot, shareResourcePath, sanitiseSharedHtml, resolveShareUrl, safeAssetBytes } = await import('../lib/share-resources.mjs');
const root = path.join(home, 'data', 'project', 'doc', 'v1');
fs.mkdirSync(path.join(root, 'images'), { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4boAAAAASUVORK5CYII=', 'base64');
fs.writeFileSync(path.join(root, 'main.md'), '# Report\n\n![chart](images/chart.png)\n\n[private](private.json)');
fs.writeFileSync(path.join(root, 'images/chart.png'), png);
fs.writeFileSync(path.join(root, 'private.json'), '{"private":true}');
fs.writeFileSync(path.join(root, 'second.md'), '# Second');
fs.writeFileSync(path.join(root, '..', 'meta.json'), JSON.stringify({ project: 'project', slug: 'doc', versions: [{ v: 1, main: 'main.md', title: 'Private title', time: new Date().toISOString(), files: ['main.md','second.md','private.json','images/chart.png'].map(p => ({ path:p, kind:p.endsWith('.md')?'md':p.endsWith('.json')?'json':'image', size:fs.statSync(path.join(root,p)).size })) }] }));
test.after(() => fs.rmSync(home, { recursive:true, force:true }));
const args = { project:'project', slug:'doc', main:'main.md', files:['main.md','second.md'], version:1 };
test('snapshot includes only selected files and their image dependencies', () => {
  const s = buildShareSnapshot(args);
  assert.deepEqual(s.files.map(x=>x.path), ['main.md','second.md']);
  assert(s.resources.includes('images/chart.png'));
  assert(!s.resources.includes('private.json'));
  assert.equal(shareResourcePath({ ...s, project:'project', slug:'doc' }, 'private.json'), null);
});
test('rejects traversal, hidden files, symlinks and new unapproved dependencies', () => {
  assert.throws(()=>buildShareSnapshot({...args,files:['../meta.json']}));
  assert.throws(()=>buildShareSnapshot({...args,project:'../project'}));
  assert.throws(()=>buildShareSnapshot({...args,approvedResources:[]}));
  if(process.platform!=='win32') {
    fs.symlinkSync('/etc/hosts',path.join(root,'link.txt'));
    assert.throws(()=>buildShareSnapshot({...args,files:['main.md','link.txt']}));
  }
});
test('public HTML removes forms, raw properties, scripts, tracking images and unsafe links', () => {
  const s = {...buildShareSnapshot(args),project:'project',slug:'doc'};
  const html = sanitiseSharedHtml('<details class="frontmatter">secret-source</details><script>steal()</script><img src="https://tracker.invalid/pixel" onerror="steal()"><a href="javascript:steal()">bad</a><a href="private.json">private</a><img src="images/chart.png"><form action="/api/settings"><input name="token"></form>', { snapshot:s, rel:'main.md', shareId:'example' });
  assert(!html.includes('secret-source')); assert(!html.includes('steal'));
  assert(!html.includes('tracker.invalid')); assert(!html.includes('/api/settings'));
  assert(!html.includes('private.json')); assert(html.includes('/s/example/asset?'));
});
test('relative document links map to selected public files only', () => {
  const s=buildShareSnapshot(args);
  assert(resolveShareUrl('second.md',{snapshot:s,rel:'main.md',shareId:'example'}).includes('/s/example?f='));
  assert.equal(resolveShareUrl('private.json',{snapshot:s,rel:'main.md',shareId:'example'}),'');
  assert.equal(resolveShareUrl('/api/sessions',{snapshot:s,rel:'main.md',shareId:'example'}),'');
});
test('SVG sanitation preserves the XML namespace while removing active URL attributes',()=>{
  const file=path.join(root,'icon.svg');fs.writeFileSync(file,'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="3" fill="red"/><image href="http://tracker.invalid/pixel"/><script>steal()</script></svg>');
  const svg=safeAssetBytes(file,'icon.svg').toString();
  assert(svg.includes('xmlns="http://www.w3.org/2000/svg"'));assert(!svg.includes('tracker.invalid'));assert(!svg.includes('steal'));
});
test('absolute workbench links do not disclose private projects or bypass selected files',()=>{
 fs.writeFileSync(path.join(home,'config.json'),JSON.stringify({baseUrl:'http://mydash',httpsUrl:'https://mydash.tail.ts.net',sharing:{publicUrl:'https://mydash.tail.ts.net:8443'}}));
 const options={snapshot:buildShareSnapshot(args),rel:'main.md',shareId:'example'};
 assert.equal(resolveShareUrl('http://mydash/p/private-project/secret-slug',options),'');
 assert.equal(resolveShareUrl('https://mydash.tail.ts.net/p/project/doc?f=private.json',options),'');
 assert(resolveShareUrl('http://mydash/p/project/doc?f=second.md',options).includes('/s/example?f='));
 assert.equal(resolveShareUrl('https://github.com/vanmiku/mydash',options),'https://github.com/vanmiku/mydash');
});
