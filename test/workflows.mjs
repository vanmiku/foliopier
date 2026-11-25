import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import XLSX from 'xlsx';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foliopier-workflows-'));
process.env.MYDASH_HOME = home;
delete process.env.MYDASH_DATA;
const { updateConfig, DATA_DIR } = await import('../lib/store.mjs');
const { packageCandidate } = await import('../lib/package-snapshots.mjs');
const { publishPackage, resetShareCode, revokeShare } = await import('../lib/shares.mjs');
const { createShareHandler } = await import('../lib/share-server.mjs');
const { reviewFiles, exactFile } = await import('../lib/version-review.mjs');
const nonce = () => crypto.randomBytes(16).toString('hex');
updateConfig(() => ({ sharing: { enabled: true }, lang: 'en' }));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function version(p, slug, v, main, files) {
  const dir = path.join(DATA_DIR, p, slug);
  const root = path.join(dir, 'v' + v);
  fs.mkdirSync(root, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(root, name), bytes);
  const loc = path.join(dir, 'meta.json');
  const meta = fs.existsSync(loc) ? JSON.parse(fs.readFileSync(loc)) : { project: p, slug, versions: [] };
  meta.versions.push({ v, main, title: slug + ' edition ' + v, time: new Date().toISOString(),
    files: Object.entries(files).map(([path, bytes]) => ({ path, size: Buffer.byteLength(bytes) })) });
  fs.writeFileSync(loc, JSON.stringify(meta));
  return root;
}

test('a package revision is atomic, isolates assets and survives source cleanup', async () => {
  version('package', 'a', 1, 'main.md', { 'main.md': '![first](same.svg)\n\n[Other file](extra.csv)', 'same.svg':'<svg><rect width="11"/></svg>', 'extra.csv':'id,value\n001,5', 'excluded.txt': 'Keep private' });
  const srcB = version('package', 'b', 1, 'main.md', { 'main.md': '![second](same.svg)', 'same.svg':'<svg><rect width="22"/></svg>' });
  const pick = (slug, v) => ({ slug, version:v, main:'main.md', files: slug === 'a' && v === 1 ? ['main.md','extra.csv'] : ['main.md'] });
  const entries = [pick('a',1),pick('b',1)];
  const { share, code } = await publishPackage({ project:'package', revision:0, entries, title:'Customer package', draft: nonce() }, packageCandidate('package',entries));
  const server = http.createServer(createShareHandler());
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const host = 'http://127.0.0.1:' + server.address().port;
  const route = host + '/s/' + share.id;
  const unlock = async code => {
    const res = await fetch(route + '/unlock', { method:'POST', headers:{ Origin:host, 'X-Mydash-Share':'1', 'Content-Type':'application/json' }, body:JSON.stringify({code}) });
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie').split(';')[0];
  };
  try {
    const [a,b] = share.package.entries.map(e => e.id);
    assert.equal((await fetch(route + '/asset?entry='+a+'&rev=1&file=same.svg&v=1')).status,401);
    const cookie = await unlock(code);
    const get = suffix => fetch(route + suffix,{headers:{Cookie:cookie}});
    assert.match(await (await get('')).text(),/Customer package/);
    const html = await (await get('?entry='+a+'&rev=1')).text();
    assert.match(html,new RegExp('entry='+a+'&amp;rev=1'));
    assert.match(html,/Other file/);
    assert.match(await (await get('/asset?entry='+a+'&rev=1&file=same.svg&v=1')).text(),/width="11"/);
    assert.match(await (await get('/asset?entry='+b+'&rev=1&file=same.svg&v=1')).text(),/width="22"/);
    assert.equal((await get('?entry='+a+'&rev=1&f=excluded.txt')).status,404);
    fs.rmSync(srcB,{recursive:true});
    assert.match(await (await get('/asset?entry='+b+'&rev=1&file=same.svg&v=1')).text(),/width="22"/);
    const srcA2 = version('package','a',2,'main.md',{'main.md':'new report'});
    const selected = [pick('a',2), pick('b',1)];
    const draft = packageCandidate('package',selected,share.package);
    fs.writeFileSync(path.join(srcA2,'main.md'),'changed after preview');
    const update = { id:share.id, project:'package', revision:1, entries:selected, title:'Customer package', draft: nonce() };
    await assert.rejects(publishPackage(update,draft), { code: 'PACKAGE_SOURCE_CHANGED' });
    assert.equal((await get('?entry='+a+'&rev=1')).status,200);
    const newDraft = packageCandidate('package',selected,share.package);
    const updated = await publishPackage(update,newDraft);
    assert.equal(updated.share.id,share.id);
    assert.deepEqual(updated.share.package.entries.map(e=>e.change),['updated','']);
    assert.equal((await get('?entry='+a+'&rev=1')).status,409);
    assert.match(await (await get('?entry='+a+'&rev=2')).text(),/changed after preview/);
    assert.match(await (await get('/asset?entry='+b+'&rev=2&file=same.svg&v=1')).text(),/width="22"/);
    await resetShareCode(share.id);
    assert.equal((await get('/status')).status,401);
    await revokeShare(share.id);
    assert.equal((await get('')).status,410);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('CSV review matches literal IDs, tracks inserted/deleted columns and detects bad records', () => {
  version('review','rows',1,'table.csv',{'table.csv':'id,amount,note\n003,7,"你好, 两行\n第二行"\n001,1,hello\n002,6,bye\n'});
  version('review','rows',2,'table.csv',{'table.csv':'id,amount,note\n001,1.0,hello\n004,5,new\n003,7,"你好, 两行\n第二行"\n'});
  version('review','rows',3,'table.csv',{'table.csv':'id,amount,note\n003,7,one\n003,1,two\n'});
  const f = v => exactFile('review','rows',v,'table.csv');
  const result = reviewFiles(f(1), f(2), 'table.csv', { key:'id' });
  assert.deepEqual(result.changes.map(row => [row.id,row.type]),[['001','changed'],['004','added'],['002','removed']]);
  assert.deepEqual(result.changes[0].cells,[{name:'amount',old:'1',current:'1.0'}]);
  assert.deepEqual(reviewFiles(f(1), f(3), 'table.csv', { key:'id' }).problems, [{row:3,first:2,id:'003'}]);
});

test('Excel review selects a matching worksheet and compares literal IDs', () => {
  for (const v of [1, 2]) {
    const book = XLSX.utils.book_new();
    const records = XLSX.utils.aoa_to_sheet([['ID', 'Value'], ['0003', v]]);
    XLSX.utils.book_append_sheet(book, records, 'Records');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Only in this version']]), 'Other ' + v);
    version('review', 'excel', v, 'book.xlsx', { 'book.xlsx': XLSX.write(book, { bookType: 'xlsx', type: 'buffer' }) });
  }
  const file = v => exactFile('review', 'excel', v, 'book.xlsx');
  assert.deepEqual(reviewFiles(file(1), file(2), 'book.xlsx').sheets, ['Records']);
  const result = reviewFiles(file(1), file(2), 'book.xlsx', { sheet: 'Records', key: 'ID' });
  assert.deepEqual(result.changes, [{ id: '0003', type: 'changed', cells: [{ name: 'Value', old: '1', current: '2' }] }]);
});
