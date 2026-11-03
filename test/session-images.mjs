import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const api = await import('../lib/session-images.mjs').catch(() => ({}));
const sid = '11111111-1111-4111-8111-111111111111';
const data =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZfoAAAAASUVORK5CYII=';
test('uploaded images are validated, private, session-bound and addressed by opaque identifiers', (t) => {
  assert.equal(typeof api.SessionImages, 'function', 'image upload store must exist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-images-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new api.SessionImages({ dir });
  const image = store.save(sid, { name: '../../screen.png', data });
  assert.equal(image.name, 'screen.png');
  assert.equal('path' in image, false);
  const [local] = store.resolve(sid, [image.id]);
  assert.ok(path.isAbsolute(local.path));
  assert.equal(fs.readFileSync(local.path).length, image.size);
  if (process.platform !== 'win32') assert.equal(fs.statSync(local.path).mode & 0o077, 0);
  assert.throws(() => store.resolve('22222222-2222-4222-8222-222222222222', [image.id]));
  assert.throws(() => store.resolve(sid, ['../../config']));
  const manifest = path.join(dir, image.id + '.json'),
    meta = JSON.parse(fs.readFileSync(manifest));
  fs.writeFileSync(manifest, JSON.stringify({ ...meta, mime: 'text/html' }));
  assert.throws(() => store.resolve(sid, [image.id]));
  fs.writeFileSync(manifest, JSON.stringify(meta));
  fs.appendFileSync(local.path, 'tamper');
  assert.throws(() => store.resolve(sid, [image.id]));
});
test('fake image content, SVG, malformed base64 and excess attachments are rejected', (t) => {
  assert.equal(typeof api.SessionImages, 'function', 'image upload store must exist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-images-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new api.SessionImages({ dir });
  for (const data of [
    'data:image/png;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,@@@@',
  ])
    assert.throws(() => store.save(sid, { name: 'bad.png', data }));
  const image = store.save(sid, { name: 'valid.png', data });
  assert.throws(() => store.resolve(sid, Array(5).fill(image.id)));
  assert.throws(() =>
    store.save(sid, {
      name: 'big.png',
      data: 'data:image/png;base64,' + Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
    })
  );
});

test('image cleanup releases unused uploads while retaining queued and sent attachments by default', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-images-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pending = new Set(),
    sent = new Set();
  const store = new api.SessionImages({
    dir,
    protectedIds: ({ includeCompleted = false } = {}) =>
      new Set([...pending, ...(includeCompleted ? [] : sent)]),
  });
  const unused = store.save(sid, { name: 'unused.png', data }),
    queued = store.save(sid, { name: 'queued.png', data }),
    done = store.save(sid, { name: 'sent.png', data });
  pending.add(queued.id);
  sent.add(done.id);
  assert.equal(store.stats().count, 3);
  store.discard(sid, unused.id);
  store.prune();
  assert.equal(store.stats().count, 2);
  store.discard(sid, queued.id);
  store.prune({ includeRecent: true });
  assert.ok(store.resolve(sid, [queued.id]));
  assert.ok(store.resolve(sid, [done.id]));
  store.prune({ includeRecent: true, includeCompleted: true });
  assert.equal(store.stats().count, 1);
  assert.ok(store.resolve(sid, [queued.id]));
});

test('expired unused images release upload capacity while protected images survive expiration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-images-expiry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const protectedIds = new Set();
  const store = new api.SessionImages({ dir, maxBytes: 800, protectedIds: () => protectedIds });
  const old = store.save(sid, { name: 'old.png', data });
  const file = path.join(dir, old.id + '.json'),
    meta = JSON.parse(fs.readFileSync(file));
  meta.createdAt = Date.now() - 31 * 86400000;
  fs.writeFileSync(file, JSON.stringify(meta));
  protectedIds.add(old.id);
  store.prune();
  assert.equal(store.stats().count, 1);
  protectedIds.clear();
  assert.equal(store.prune().removed, 1);
  assert.equal(store.stats().usedBytes, 0);
  assert.ok(store.save(sid, { name: 'new.png', data }).id);
});
