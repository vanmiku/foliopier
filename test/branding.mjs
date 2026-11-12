import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeCliShims, removeCliShims } from '../lib/cli-shims.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foliopier-brand-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home with $dollar and 'quote");
  const entry = path.join(home, 'app', 'bin', 'mydash.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'console.log(JSON.stringify({home:process.env.MYDASH_HOME,args:process.argv.slice(2)}));');
  return { root, home, entry, binDir: path.join(root, 'bin'), node: process.execPath };
}

test('primary and legacy POSIX commands bind the same home and preserve quoted arguments', t => {
  const f = fixture(t);
  assert.equal(writeCliShims({ ...f, windows: false }), path.join(f.binDir, 'foliopier'));
  for (const name of ['foliopier', 'mydash']) {
    assert.ok(fs.existsSync(path.join(f.binDir, name)));
    if (process.platform !== 'win32') {
      const r = spawnSync(path.join(f.binDir, name), ['publish', "a 'quoted' $file.md"], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { home: f.home, args: ['publish', "a 'quoted' $file.md"] });
    }
  }
  // Reinstalling is safe and keeps both aliases bound to the original installation.
  writeCliShims({ ...f, windows: false });
  assert.equal(removeCliShims({ ...f, windows: false }).length, 2);
});

test('Windows install writes both cmd and Git Bash aliases and removes only its own files', t => {
  const f = fixture(t);
  assert.equal(writeCliShims({ ...f, windows: true }), path.join(f.binDir, 'foliopier.cmd'));
  for (const name of ['foliopier', 'mydash', 'foliopier.cmd', 'mydash.cmd']) assert.ok(fs.existsSync(path.join(f.binDir, name)));
  assert.match(fs.readFileSync(path.join(f.binDir, 'foliopier.cmd'), 'utf8'), /%\*/);
  fs.writeFileSync(path.join(f.binDir, 'foliopier'), '# user replaced this command\n');
  assert.equal(removeCliShims({ ...f, windows: true }).length, 3);
  assert.equal(fs.readFileSync(path.join(f.binDir, 'foliopier'), 'utf8'), '# user replaced this command\n');
});

test('a command collision is detected before either alias is replaced', t => {
  const f = fixture(t);fs.mkdirSync(f.binDir);
  fs.writeFileSync(path.join(f.binDir, 'foliopier'), 'unrelated tool\n');
  assert.throws(() => writeCliShims({ ...f, windows: false }), /Command already exists/);
  assert.equal(fs.readFileSync(path.join(f.binDir, 'foliopier'), 'utf8'), 'unrelated tool\n');
  assert.equal(fs.existsSync(path.join(f.binDir, 'mydash')), false);
});

test('the legacy installer shim can be upgraded while another installation remains untouched', t => {
  const f = fixture(t);fs.mkdirSync(f.binDir);
  fs.writeFileSync(path.join(f.binDir, 'mydash'), `#!/bin/sh\nexec "${f.node}" "${f.entry}" "$@"\n`);
  writeCliShims({ ...f, windows: false });
  assert.equal(removeCliShims({ binDir: f.binDir, entry: path.join(f.root, 'different', 'bin', 'mydash.mjs'), windows: false }).length, 0);
  assert.ok(fs.existsSync(path.join(f.binDir, 'foliopier')));
});


test('brand upgrade aliases only retained Claude and Codex permissions', t => {
  const f = fixture(t);
  const env = { ...process.env, MYDASH_HOME: f.home, MYDASH_CLAUDE_HOME: path.join(f.root, 'claude'), MYDASH_CODEX_HOME: path.join(f.root, 'codex'), MYDASH_LANG: 'en' };
  const script = String.raw`
    const fs = await import('node:fs'); const path = await import('node:path');
    const { integrate, refresh } = await import('./lib/integrate.mjs');
    for (const agent of ['claude', 'codex']) integrate(agent).forEach(step => step.apply?.());
    const settings = path.join(process.env.MYDASH_CLAUDE_HOME, 'settings.json');
    const stateFile = path.join(process.env.MYDASH_HOME, 'state/integrations.json');
    const j = JSON.parse(fs.readFileSync(settings)); const state = JSON.parse(fs.readFileSync(stateFile));
    j.permissions.allow = j.permissions.allow.filter(p => !p.includes('foliopier ') && p !== 'Bash(mydash ask:*)');
    state.claude.permissionsAdded = state.claude.permissionsAdded.filter(p => !p.includes('foliopier '));
    fs.writeFileSync(settings, JSON.stringify(j)); fs.writeFileSync(stateFile, JSON.stringify(state));
    const rules = path.join(process.env.MYDASH_CODEX_HOME, 'rules/mydash.rules');
    const hookRules = path.join(process.env.MYDASH_CODEX_HOME, 'rules/mydash-ask.rules');
    const body = fs.readFileSync(rules, 'utf8').split('\n').filter(p => !p.includes('foliopier') && !p.includes('"publish"')).join('\n');
    fs.writeFileSync(rules, body); fs.rmSync(hookRules);
    refresh('claude'); refresh('codex');
    const first = JSON.parse(fs.readFileSync(settings)).permissions.allow;
    const current = JSON.parse(fs.readFileSync(settings)); current.permissions.allow.push('Bash(mydash ask:*)'); fs.writeFileSync(settings, JSON.stringify(current));
    refresh('claude');
    console.log(JSON.stringify({ first, later: JSON.parse(fs.readFileSync(settings)).permissions.allow, rules: fs.readFileSync(rules, 'utf8'), hookFile: fs.existsSync(hookRules) }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.ok(result.first.includes('Bash(foliopier publish:*)'));
  assert.ok(!result.first.includes('Bash(foliopier ask:*)'));
  assert.ok(!result.later.includes('Bash(foliopier ask:*)'));
  assert.ok(!result.rules.includes('"publish"'));
  assert.ok(result.rules.includes('["foliopier", ["ls", "url", "doctor", "feedback"]]'));
  assert.equal(result.hookFile, false);
});


test('a default legacy Codex rule migration remains healthy and removable', t => {
  const f = fixture(t);
  const env = { ...process.env, MYDASH_HOME: f.home, MYDASH_CODEX_HOME: path.join(f.root, 'codex'), MYDASH_LANG: 'en' };
  const script = String.raw`
    const fs = await import('node:fs'); const path = await import('node:path');
    const { integrate, refresh, status } = await import('./lib/integrate.mjs');
    integrate('codex').forEach(step => step.apply?.());
    const rules = path.join(process.env.MYDASH_CODEX_HOME, 'rules/mydash.rules');
    const asks = path.join(process.env.MYDASH_CODEX_HOME, 'rules/mydash-ask.rules');
    for (const file of [rules, asks]) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter(line => !line.includes('"foliopier"')).join('\n'));
    refresh('codex'); const healthy = status('codex').rules;
    integrate('codex', { remove: true }).forEach(step => step.apply?.());
    console.log(JSON.stringify({ healthy, removed: !fs.existsSync(rules) && !fs.existsSync(asks) }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { healthy: true, removed: true });
});


test('ordinary publication notifications include new and existing robot keywords', async t => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  });
  const { sendTo } = await import('../lib/notify.mjs');
  const result = await sendTo({ type: 'webhook', url: 'https://oapi.dingtalk.com/robot/send?access_token=synthetic' }, { title: 'Delivery review', body: 'studio' });
  assert.equal(result.ok, true);
  assert.match(bodies[0].text.content, /\[FolioPier AI\] \[mydash\] Delivery review/);
});
