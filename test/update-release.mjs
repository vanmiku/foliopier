import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureDependencies, dependencyKey } from '../lib/dependencies.mjs';
import { releasePlan } from '../.github/scripts/release.mjs';
import fsp from 'node:fs/promises';
import { writeMetaAtomic } from '../lib/store.mjs';

test('Windows transient metadata replacement errors keep the old file and then commit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'meta.json'); fs.writeFileSync(file, JSON.stringify({ v: 1 }));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const rename = fsp.rename; let attempts = 0;
  t.mock.method(fsp, 'rename', async (from, to) => {
    attempts++;
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { v: 1 });
    if (attempts < 3) throw Object.assign(new Error('file busy'), { code: 'EPERM' });
    return rename(from, to);
  });
  try {
    await writeMetaAtomic(dir, { v: 2 });
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { v: 2 });
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

test('metadata replacement does not retry unrelated I/O errors', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'meta.json'); fs.writeFileSync(file, JSON.stringify({ v: 1 }));
  let attempts = 0;
  t.mock.method(fsp, 'rename', async () => { attempts++; throw Object.assign(new Error('disk failure'), { code: 'EIO' }); });
  await assert.rejects(writeMetaAtomic(dir, { v: 2 }), { code: 'EIO' });
  assert.equal(attempts, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { v: 1 });
});

test('a permanent Windows metadata lock stops retrying and retains old data', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'meta.json'); fs.writeFileSync(file, JSON.stringify({ v: 1 }));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let attempts = 0;
  t.mock.method(fsp, 'rename', async () => { attempts++; throw Object.assign(new Error('locked'), { code: 'EACCES' }); });
  try {
    await assert.rejects(writeMetaAtomic(dir, { v: 2 }), { code: 'EACCES' });
    assert.equal(attempts, 9);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { v: 1 });
    assert.deepEqual(fs.readdirSync(dir), ['meta.json']);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'dep'));
  fs.writeFileSync(path.join(dir, 'dep/package.json'), JSON.stringify({ name: 'local-dep', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'dep/index.js'), 'module.exports = 42;');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'local-dep': 'file:./dep' } }));
  const calls = [];
  const npm = args => {
    calls.push(args[0]);
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', timeout: 30_000,
      env: { ...process.env, npm_config_cache: path.join(dir, '.cache'), npm_config_offline: 'true' },
    });
    return { ok: r.status === 0, out: String(r.stderr || r.stdout || r.error || '') };
  };
  assert.equal(npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']).ok, true);
  calls.length = 0;
  return { dir, npm, calls };
}

test('a version-only update reuses installed, validated dependencies', t => {
  const { dir, npm, calls } = fixture(t);
  assert.equal(ensureDependencies(dir, npm).ok, true);
  const before = dependencyKey(dir);
  for (const file of ['package.json', 'package-lock.json']) {
    const f = path.join(dir, file), p = JSON.parse(fs.readFileSync(f));
    p.version = '1.0.1'; if (p.packages?.['']) p.packages[''].version = '1.0.1';
    fs.writeFileSync(f, JSON.stringify(p));
  }
  assert.equal(dependencyKey(dir), before);
  assert.deepEqual(ensureDependencies(dir, npm), { ok: true, reused: true });
  assert.equal(calls.filter(x => x === 'ci').length, 1);
  assert.equal(calls.filter(x => x === 'ls').length, 1);
});

test('missing installed dependency is repaired rather than reused', t => {
  const { dir, npm, calls } = fixture(t);
  assert.equal(ensureDependencies(dir, npm).ok, true);
  fs.rmSync(path.join(dir, 'node_modules/local-dep'), { recursive: true, force: true });
  assert.deepEqual(ensureDependencies(dir, npm), { ok: true, reused: false });
  assert.equal(calls.filter(x => x === 'ci').length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'node_modules/local-dep/index.js')));
});

test('dependency, lifecycle and Node ABI changes invalidate reuse', t => {
  const { dir } = fixture(t);
  const first = dependencyKey(dir);
  const file = path.join(dir, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(file)); lock.packages.dep.integrity = 'changed';
  fs.writeFileSync(file, JSON.stringify(lock));
  assert.notEqual(dependencyKey(dir), first);
  const beforeScript = dependencyKey(dir), p = path.join(dir, 'package.json'), pkg = JSON.parse(fs.readFileSync(p));
  pkg.scripts = { postinstall: 'node rebuild.mjs' }; fs.writeFileSync(p, JSON.stringify(pkg));
  assert.notEqual(dependencyKey(dir), beforeScript);
  assert.notEqual(dependencyKey(dir, { abi: 'old', platform: process.platform, arch: process.arch }), dependencyKey(dir));
});

test('failed dependency install cannot be mistaken for a reusable install', t => {
  const { dir, npm, calls } = fixture(t);
  const failed = ensureDependencies(dir, () => ({ ok: false, out: 'network unavailable' }));
  assert.equal(failed.ok, false);
  assert.equal(ensureDependencies(dir, npm).ok, true);
  assert.equal(calls.filter(x => x === 'ci').length, 1);
});

const input = { version: '0.1.4', lockVersion: '0.1.4', tags: ['v0.1.3'], commit: 'a'.repeat(40), main: 'a'.repeat(40),
  changelog: '# Changelog\n\n## Unreleased\n\nFuture work\n\n## 0.1.4 (2026-11-02)\n\n- Faster updates.\n\n## 0.1.3\n\nOld changes.\n' };
test('release uses only the matching version notes and tested commit', () => {
  assert.deepEqual(releasePlan(input), { tag: 'v0.1.4', commit: input.commit, notes: '- Faster updates.' });
});
test('existing releases and superseded CI cannot publish again', () => {
  assert.ok(releasePlan({ ...input, tags: ['v0.1.4'] }).skip);
  assert.ok(releasePlan({ ...input, tags: ['v0.2.0'] }).skip);
  assert.ok(releasePlan({ ...input, main: 'b'.repeat(40) }).skip);
});
test('release refuses mismatched lock versions or absent release notes', () => {
  assert.throws(() => releasePlan({ ...input, lockVersion: '0.1.3' }), /version/i);
  assert.throws(() => releasePlan({ ...input, changelog: '# Changelog\n## 0.1.3\nOld' }), /notes/i);
  assert.ok(releasePlan({ ...input, version: '0.1.4-rc1', lockVersion: '0.1.4-rc1' }).skip);
});

test('update discovery refreshes after an hour and manual checks bypass the cache', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-update-check-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'origin'); fs.mkdirSync(repo);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'release'], ['tag', 'v9.0.0']]) {
    assert.equal(spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).status, 0);
  }
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ sourceRemote: repo }));
  const script = `
    const { CHECK_EVERY, writeUpdate, checkForUpdate } = await import('./lib/update.mjs');
    const cached = () => ({ checkedAt: new Date(Date.now() - 30 * 60_000).toISOString(), latest: { version: '8.0.0', tag: 'v8.0.0' } });
    writeUpdate(cached); const fresh = (await checkForUpdate()).latest.version;
    writeUpdate(() => ({ ...cached(), checkedAt: new Date(Date.now() - 65 * 60_000).toISOString() }));
    const expired = (await checkForUpdate()).latest.version;
    writeUpdate(cached); const forced = (await checkForUpdate({ force: true })).latest.version;
    console.log(JSON.stringify({ interval: CHECK_EVERY, fresh, expired, forced }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, MYDASH_HOME: home, MYDASH_LANG: 'en' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { interval: 3600_000, fresh: '8.0.0', expired: '9.0.0', forced: '9.0.0' });
});
