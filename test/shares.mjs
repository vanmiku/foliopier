import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-shares-test-'));
process.env.MYDASH_HOME = home;
process.env.MYDASH_DATA = path.join(home, 'data');
after(() => fs.rmSync(home, { recursive: true, force: true }));
const stateFile = path.join(home, 'state', 'shares.json');
const config = value => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ sharing: { enabled: value } }));
config(true);
const shares = await import('../lib/shares.mjs');

let sequence = 0;
function fixture() {
  const slug = 'document-' + (++sequence), dir = path.join(home, 'data', 'test', slug);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { schema: 1, project: 'test', slug, title: 'Private internal title', versions: [] };
  function publish(files) {
    const v = meta.versions.length + 1, vdir = path.join(dir, 'v' + v);
    fs.mkdirSync(vdir);
    for (const [rel, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(vdir, rel)), { recursive: true });
      fs.writeFileSync(path.join(vdir, rel), contents);
    }
    meta.versions.push({ v, main: 'main.md', title: 'Private internal title', time: new Date().toISOString(), files: Object.keys(files).map(rel => ({ path: rel, kind: rel.endsWith('.md') ? 'md' : rel.endsWith('.csv') ? 'table' : 'image', size: Buffer.byteLength(files[rel]) })) });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    return v;
  }
  publish({ 'main.md': '# Shared text\n\nPublic document.', 'result.csv': 'name,value\nA,1\n' });
  return { dir, slug, publish, create: extra => shares.createShare({ project: 'test', slug, main: 'main.md', files: ['main.md', 'result.csv'], title: 'Public title', ...extra }) };
}

test('creation requires sharing enabled and persists only a salted code hash', async () => {
  const doc = fixture(); config(false);
  await assert.rejects(doc.create(), { code: 'SHARING_DISABLED' }); config(true);
  const result = await doc.create();
  assert.match(result.share.id, /^[a-f0-9]{32,}$/);
  assert.match(result.code, /^\d{8}$/);
  assert.equal(result.share.title, 'Public title');
  assert.equal(result.share.version, 1);
  assert.equal(result.share.mode, 'latest');
  assert.equal(result.share.allowComments, true);
  assert.equal(result.share.allowPdf, true);
  const raw = fs.readFileSync(stateFile, 'utf8');
  assert.equal(raw.includes(result.code), false);
  assert.equal(JSON.stringify(result.share).includes('codeHash'), false);
  if(process.platform!=='win32')assert.equal(fs.statSync(stateFile).mode & 0o077, 0);
});

test('invalid expiration, file selections and ambiguous update modes are rejected', async () => {
  const doc = fixture();
  for (const expiresInHours of [0, -1, 721, NaN]) await assert.rejects(doc.create({ expiresInHours }));
  await assert.rejects(doc.create({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
  await assert.rejects(doc.create({ files: ['result.csv'] }));
  await assert.rejects(doc.create({ files: ['main.md', '../not-shared.md'] }));
  await assert.rejects(doc.create({ mode: 'everything' }));
});

test('unlock tokens are share scoped, persisted as hashes and invalidated by code reset/revocation', async () => {
  const doc = fixture(), a = await doc.create(), b = await doc.create();
  const auth = await shares.unlockShare(a.share.id, a.code, { clientKey: 'browser-A' });
  assert.equal(shares.verifyShareSession(a.share.id, auth.token).visitorId, auth.visitorId);
  assert.equal(shares.verifyShareSession(b.share.id, auth.token), null);
  assert.equal(fs.readFileSync(stateFile, 'utf8').includes(auth.token), false);
  const restarted = await import('../lib/shares.mjs?persisted=' + Date.now());
  assert.equal(restarted.verifyShareSession(a.share.id, auth.token).visitorId, auth.visitorId);
  const reset = await shares.resetShareCode(a.share.id);
  assert.match(reset.code, /^\d{8}$/);
  assert.equal(shares.verifyShareSession(a.share.id, auth.token), null);
  const next = await shares.unlockShare(a.share.id, reset.code, { clientKey: 'browser-A' });
  await shares.revokeShare(a.share.id);
  assert.equal(shares.getShare(a.share.id), null);
  assert.equal(shares.verifyShareSession(a.share.id, next.token), null);
  assert.equal(shares.getShare(a.share.id, { inactive: true }).revoked, true);
});

test('wrong-code retries are bounded and do not disclose the title or code', async () => {
  const { share, code } = await fixture().create();
  const wrong = code === '00000000' ? '11111111' : '00000000';
  for (let i = 0; i < 10; i++) {
    await assert.rejects(shares.unlockShare(share.id, wrong, { clientKey: 'wrong-code-browser' }), error => {
      assert.equal(String(error).includes(share.title), false);
      assert.equal(String(error).includes(code), false);
      return ['INVALID_CODE', 'RATE_LIMITED'].includes(error.code);
    });
  }
  await assert.rejects(shares.unlockShare(share.id, code, { clientKey: 'wrong-code-browser' }), { code: 'RATE_LIMITED' });
  assert.ok(await shares.unlockShare(share.id, code, { clientKey: 'different-browser' }));
});

test('expiry, disabling and significant clock rollback fail closed', async () => {
  const { share, code } = await fixture().create();
  const auth = await shares.unlockShare(share.id, code);
  const mutate = fn => { const state = JSON.parse(fs.readFileSync(stateFile)); fn(state); fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 }); };
  const state = JSON.parse(fs.readFileSync(stateFile));
  mutate(s => { s.shares[share.id].expiresAt = new Date(Date.now() - 1).toISOString(); });
  assert.equal(shares.verifyShareSession(share.id, auth.token), null);
  assert.equal(await shares.currentShare(share.id), null);
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  config(false); assert.equal(shares.verifyShareSession(share.id, auth.token), null);
  config(true);
  mutate(s => { s.maxObservedNow = Date.now() + 10 * 60_000; });
  assert.equal(shares.verifyShareSession(share.id, auth.token), null);
  assert.equal(await shares.currentShare(share.id), null);
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
});

test('comments are private, durable, versioned and idempotent under concurrent retries', async () => {
  const doc = fixture(), { share, code } = await doc.create();
  const a = await shares.unlockShare(share.id, code, { clientKey: 'comments-A' });
  const b = await shares.unlockShare(share.id, code, { clientKey: 'comments-B' });
  const text = '<script>alert(1)</script> Plain text only';
  const results = await Promise.all(Array.from({ length: 5 }, () => shares.addShareComment(share.id, a.visitorId, { file: 'result.csv', version: 1, text, nickname: 'Reader', requestId: 'same-attempt' })));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  assert.equal(shares.visitorShareComments(share.id, a.visitorId).length, 1);
  assert.equal(shares.visitorShareComments(share.id, b.visitorId).length, 0);
  assert.equal(results[0].file, 'result.csv');
  assert.equal(results[0].version, 1);
  assert.equal(results[0].text, text);
  assert.equal(shares.ownerShareComments({ project: 'test', slug: doc.slug }).length, 1);
  await assert.rejects(shares.addShareComment(share.id, a.visitorId, { file: 'secret.md', version: 1, text: 'No' }));
  await assert.rejects(shares.addShareComment(share.id, a.visitorId, { file: 'main.md', version: 90, text: 'No' }));
  await shares.resolveShareComment(share.id, results[0].id);
  assert.equal(shares.ownerShareComments({ project: 'test', slug: doc.slug })[0].status, 'resolved');
  await shares.updateShare(share.id, { allowComments: false });
  await assert.rejects(shares.addShareComment(share.id, a.visitorId, { file: 'main.md', version: 1, text: 'Closed' }), { code: 'COMMENTS_DISABLED' });
});

test('latest updates preserve selected files and hold new image dependencies until owner approval', async () => {
  const doc = fixture(), { share } = await doc.create();
  doc.publish({ 'main.md': '# Updated\n\nNew body.', 'result.csv': 'name,value\nA,2\n', 'extra.md': '# Do not expose' });
  let current = await shares.currentShare(share.id);
  assert.equal(current.snapshot.version, 2);
  assert.deepEqual(current.files, ['main.md', 'result.csv']);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=', 'base64');
  doc.publish({ 'main.md': '# Updated\n\n![New image](new.png)', 'result.csv': 'name,value\nA,3\n', 'new.png': png });
  current = await shares.currentShare(share.id);
  assert.equal(current.snapshot.version, 2);
  assert.equal(current.pendingVersion, 3);
  await shares.updateShare(share.id, { approveVersion: true });
  current = await shares.currentShare(share.id);
  assert.equal(current.snapshot.version, 3);
  assert.ok(current.snapshot.resources.includes('new.png'));
  await shares.updateShare(share.id, { files: ['main.md'] });
  current = await shares.currentShare(share.id);
  assert.deepEqual(current.files, ['main.md']);
  assert.equal(current.snapshot.files.some(f => f.path === 'result.csv'), false);
});

test('fixed shares keep their published version and missing/deleted documents become inactive', async () => {
  const doc = fixture(), fixed = await doc.create({ mode: 'fixed' }), following = await doc.create();
  doc.publish({ 'main.md': '# Updated', 'result.csv': 'a,b\n1,2\n' });
  assert.equal((await shares.currentShare(fixed.share.id)).snapshot.version, 1);
  doc.publish({ 'result.csv': 'a,b\n1,2\n' });
  assert.equal(await shares.currentShare(following.share.id), null);
  fs.rmSync(path.join(doc.dir, 'meta.json'));
  assert.equal(await shares.currentShare(fixed.share.id), null);
});

test('a removed secondary file is inaccessible even when new dependencies hold the next version', async () => {
  const doc = fixture(), { share } = await doc.create();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=', 'base64');
  doc.publish({ 'main.md': '# Next\n\n![New image](new.png)', 'new.png': png });
  const current = await shares.currentShare(share.id);
  assert.equal(current.pendingVersion, 2);
  assert.deepEqual(current.files, ['main.md']);
  assert.equal(current.snapshot.version, 1);
  assert.equal(current.snapshot.files.some(f => f.path === 'result.csv'), false);
  assert.equal(current.snapshot.resources.includes('result.csv'), false);
});

test('editing file selection cannot approve a pending main-document resource', async () => {
  const doc = fixture(), { share, code } = await doc.create();
  const auth = await shares.unlockShare(share.id, code, { clientKey: 'selection-edit' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=', 'base64');
  doc.publish({ 'main.md': '# Next\n\n![New image](new.png)', 'result.csv': 'name,value\nA,2\n', 'new.png': png, 'new.md': '# Newly added document' });
  const held = await shares.currentShare(share.id);
  assert.equal(held.snapshot.version, 1);
  assert.equal(held.pendingVersion, 2);
  const updated = await shares.updateShare(share.id, { files: ['main.md'] });
  assert.equal(updated.version, 1);
  assert.equal(updated.pendingVersion, 2);
  let current = shares.getShare(share.id);
  assert.equal(current.snapshot.resources.includes('new.png'), false);
  assert.equal(current.snapshot.resources.includes('result.csv'), false);
  assert.equal(shares.verifyShareSession(share.id, auth.token), null);
  await assert.rejects(shares.updateShare(share.id, { files: ['main.md', 'new.md'] }));
  current = await shares.currentShare(share.id);
  assert.equal(current.snapshot.version, 1);
  assert.equal(current.pendingVersion, 2);
  await shares.updateShare(share.id, { approveVersion: true, files: ['main.md', 'new.md'] });
  current = shares.getShare(share.id);
  assert.equal(current.snapshot.version, 2);
  assert.ok(current.snapshot.resources.includes('new.png'));
});

test('oversized comments are rejected without silently discarding a trailing suffix', async () => {
  const { share, code } = await fixture().create();
  const auth = await shares.unlockShare(share.id, code, { clientKey: 'oversized-comment' });
  await assert.rejects(shares.addShareComment(share.id, auth.visitorId, {
    file: 'main.md', version: 1, text: 'a'.repeat(2000) + ' ' + 'important suffix'.repeat(50), requestId: 'too-long'
  }), { code: 'INVALID_COMMENT' });
  assert.equal(shares.visitorShareComments(share.id, auth.visitorId).length, 0);
});

test('listing several shares parses the shared state only once', async () => {
  const doc = fixture();
  for (let i = 0; i < 5; i++) await doc.create();
  const read = fs.readFileSync; let count = 0;
  fs.readFileSync = function(file, ...args) { if (String(file) === stateFile) count++; return read.call(this, file, ...args); };
  try { assert.equal(shares.listShares({ project: 'test', slug: doc.slug }).length, 5); }
  finally { fs.readFileSync = read; }
  assert.equal(count, 1);
});

test('unchanged and already-pending public reads do not rewrite state on every request', async () => {
  const doc = fixture(), { share } = await doc.create();
  let before = fs.readFileSync(stateFile), modified = fs.statSync(stateFile).mtimeMs;
  for (let i = 0; i < 8; i++) assert.equal((await shares.currentShare(share.id)).snapshot.version, 1);
  assert.deepEqual(fs.readFileSync(stateFile), before);
  assert.equal(fs.statSync(stateFile).mtimeMs, modified);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=', 'base64');
  doc.publish({ 'main.md': '# Next\n\n![New image](new.png)', 'result.csv': 'a,b\n1,2\n', 'new.png': png });
  assert.equal((await shares.currentShare(share.id)).pendingVersion, 2);
  before = fs.readFileSync(stateFile); modified = fs.statSync(stateFile).mtimeMs;
  for (let i = 0; i < 8; i++) assert.equal((await shares.currentShare(share.id)).snapshot.version, 1);
  assert.deepEqual(fs.readFileSync(stateFile), before);
  assert.equal(fs.statSync(stateFile).mtimeMs, modified);
});

test('global feedback budgets reject new storage without blocking visitor unlock or revoke', async () => {
  const doc = fixture(), a = await doc.create(), b = await doc.create(), c = await doc.create();
  const auth = await shares.unlockShare(a.share.id, a.code, { clientKey: 'quota-existing' });
  const other = await shares.unlockShare(c.share.id, c.code, { clientKey: 'quota-other' });
  const original = fs.readFileSync(stateFile);
  try {
    let state = JSON.parse(original);
    const comment = { id: 'seed', visitorId: 'seed', file: 'main.md', version: 1, text: 'small fixture', createdAt: '2020-01-01T00:00:00.000Z', status: 'open' };
    state.shares[a.share.id].comments = Array.from({ length: 5000 }, (_, i) => ({ ...comment, id: 'a' + i }));
    state.shares[b.share.id].comments = Array.from({ length: 5000 }, (_, i) => ({ ...comment, id: 'b' + i }));
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    await assert.rejects(shares.addShareComment(c.share.id, other.visitorId, { file: 'main.md', version: 1, text: 'one more' }), { code: 'SHARE_STORAGE_FULL' });
    assert.ok(await shares.unlockShare(a.share.id, a.code, { clientKey: 'quota-new' }));
    assert.ok(await shares.currentShare(a.share.id));
    await shares.revokeShare(b.share.id);
    assert.equal(shares.getShare(b.share.id), null);
    state = JSON.parse(original); state.budgetFixture = 'x'.repeat(12 * 1024 * 1024);
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    const before = fs.readFileSync(stateFile);
    await assert.rejects(shares.addShareComment(a.share.id, auth.visitorId, { file: 'main.md', version: 1, text: 'over bytes' }), { code: 'SHARE_STORAGE_FULL' });
    assert.deepEqual(fs.readFileSync(stateFile), before);
    assert.ok(await shares.unlockShare(a.share.id, a.code, { clientKey: 'byte-quota-new' }));
    assert.ok(shares.verifyShareSession(a.share.id, auth.token));
    assert.ok(await shares.resetShareCode(a.share.id));
    await shares.revokeAllShares();
    assert.equal(shares.getShare(a.share.id), null);
  } finally { fs.writeFileSync(stateFile, original, { mode: 0o600 }); }
});

test('owners can disable comments and PDF downloads after the content budget is full', async () => {
  const { share, code } = await fixture().create();
  const auth = await shares.unlockShare(share.id, code, { clientKey: 'quota-safety-controls' });
  const original = fs.readFileSync(stateFile);
  try {
    const state = JSON.parse(original); state.budgetFixture = 'x'.repeat(12 * 1024 * 1024);
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const result = await shares.updateShare(share.id, { allowComments: false, allowPdf: false, expiresAt });
    assert.equal(result.allowComments, false); assert.equal(result.allowPdf, false);
    assert.equal(shares.getShare(share.id).allowComments, false);
    assert.equal(shares.getShare(share.id).allowPdf, false);
    assert.equal(shares.getShare(share.id).expiresAt, expiresAt);
    await assert.rejects(shares.addShareComment(share.id, auth.visitorId, { file: 'main.md', version: 1, text: 'closed' }), { code: 'COMMENTS_DISABLED' });
    await shares.updateShare(share.id, { allowComments: true });
    await assert.rejects(shares.addShareComment(share.id, auth.visitorId, { file: 'main.md', version: 1, text: 'still over quota' }), { code: 'SHARE_STORAGE_FULL' });
    const removed = await shares.updateShare(share.id, { files: ['main.md'] });
    assert.deepEqual(removed.files, ['main.md']);
  } finally { fs.writeFileSync(stateFile, original, { mode: 0o600 }); }
});

test('rotating visitor cookies cannot bypass a share code failure budget', async()=>{
  const {share,code}=await fixture().create();
  const wrong=code==='00000000'?'11111111':'00000000';
  for(let i=0;i<50;i++)await assert.rejects(shares.unlockShare(share.id,wrong,{clientKey:'rotated-'+i}),{code:'INVALID_CODE'});
  await assert.rejects(shares.unlockShare(share.id,code,{clientKey:'rotated-again'}),{code:'RATE_LIMITED'});
  const reset=await shares.resetShareCode(share.id);
  assert.ok(await shares.unlockShare(share.id,reset.code,{clientKey:'after-owner-reset'}));
});
