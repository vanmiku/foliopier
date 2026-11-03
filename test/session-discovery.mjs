import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionDiscovery } from '../lib/session-discovery.mjs';
const realPath = process.platform === 'win32' ? fs.realpathSync.native : fs.realpathSync;

test('project discovery finds pre-hook Codex sessions, excludes subagents, symlinks and same-name folders', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-discover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'work/biobook'),
    other = path.join(dir, 'other/biobook');
  for (const p of [root, other]) fs.mkdirSync(p, { recursive: true });
  const day = path.join(dir, 'codex/sessions/2026/11/03');
  fs.mkdirSync(day, { recursive: true });
  const write = (id, cwd, source = 'vscode') => {
    const f = path.join(day, `rollout-2026-11-03-${id}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id, cwd, source } }) + '\n');
    return f;
  };
  write('session-new-111', root);
  write('session-other-222', other);
  write('session-child-333', root, { subagent: { thread_spawn: {} } });
  const linked = write('session-linked-444', other);
  try {
    fs.symlinkSync(linked, path.join(day, 'rollout-link-session-linked-555.jsonl'));
  } catch (e) {
    if (process.platform !== 'win32') throw e;
  }
  const d = new SessionDiscovery({
    codexHome: path.join(dir, 'codex'),
    claudeHome: path.join(dir, 'claude'),
  });
  assert.deepEqual(
    d.forProject(root).map((x) => x.id),
    ['session-new-111']
  );
  assert.equal(d.get('session-new-111').transcript.endsWith('session-new-111.jsonl'), true);
  write('session-later-666', root);
  d.invalidate();
  assert.equal(d.forProject(root).length, 2);
});

test('Claude live registry is bound to process start, session and canonical cwd, without reading key material', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claude-discover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  const home = path.join(dir, 'claude');
  const projects = path.join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.mkdirSync(root);
  const write = (id, start, cwd = root) => {
    fs.writeFileSync(
      path.join(projects, id + '.jsonl'),
      JSON.stringify({ type: 'user', cwd, message: { content: 'Hi' } }) + '\n'
    );
    fs.writeFileSync(
      path.join(home, 'sessions', id === 'claude-live-111' ? '123.json' : '456.json'),
      JSON.stringify({
        pid: id === 'claude-live-111' ? 123 : 456,
        procStart: start,
        sessionId: id,
        cwd,
        status: 'idle',
        entrypoint: 'cli',
        kind: 'interactive',
      })
    );
  };
  write('claude-live-111', 'same start');
  write('claude-dead-222', 'old start');
  const d = new SessionDiscovery({
    codexHome: path.join(dir, 'codex'),
    claudeHome: home,
    processInfo: (pid) => ({ pid, started: 'same start', command: 'claude', tty: 'ttys002' }),
  });
  assert.deepEqual(
    d.forProject(root).map((x) => x.id),
    ['claude-live-111']
  );
  assert.equal(d.get('claude-live-111').live.process.pid, 123);
});

test('Desktop Code metadata discovers the exact local thread and its Remote Control binding, excluding cloud, SSH and archived sessions', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-desktop-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'),
    desktopRoot = path.join(dir, 'desktop');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(desktopRoot, 'account/org'), { recursive: true });
  for (const [suffix, extra] of [
    ['active-111', {}],
    ['archived-222', { isArchived: true }],
    ['ssh-3333', { sshConfig: { host: 'remote' } }],
    ['cloud-4444', { cloudSessionId: 'cse_cloud123' }],
  ]) {
    const sessionId = 'local_' + suffix;
    fs.writeFileSync(
      path.join(desktopRoot, 'account/org', sessionId + '.json'),
      JSON.stringify({
        sessionId,
        cliSessionId: suffix,
        cwd: root,
        title: 'App task',
        bridgeSessionIds: ['session_desktop12345'],
        ...extra,
      })
    );
  }
  const d = new SessionDiscovery({
    codexHome: path.join(dir, 'codex'),
    claudeHome: path.join(dir, 'claude'),
    desktopRoot,
  });
  const rows = d.forProject(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].desktop.remoteId, 'session_desktop12345');
  assert.equal(rows[0].id, 'active-111');
});

test('discovery budgets prioritize recent sessions, continue indexing old files and never starve Desktop', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-discovery-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'project'),
    old = path.join(dir, 'codex/sessions/2025/01/01'),
    recent = path.join(dir, 'codex/sessions/2026/11/03'),
    desktop = path.join(dir, 'desktop/account/org');
  for (const p of [cwd, old, recent, desktop]) fs.mkdirSync(p, { recursive: true });
  for (let i = 0; i < 8; i++)
    fs.writeFileSync(
      path.join(old, `rollout-old-old-session-${i}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id: 'old-session-' + i, cwd, source: 'cli' } }) + '\n'
    );
  fs.writeFileSync(
    path.join(recent, 'rollout-recent-new-session-111.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'new-session-111', cwd, source: 'cli' } }) + '\n'
  );
  fs.writeFileSync(
    path.join(desktop, 'local_desktop-111.json'),
    JSON.stringify({ sessionId: 'local_desktop-111', cwd })
  );
  const discovery = new SessionDiscovery({
    codexHome: path.join(dir, 'codex'),
    claudeHome: path.join(dir, 'claude'),
    desktopRoot: path.join(dir, 'desktop'),
    scanBudget: 2,
  });
  assert.equal(Boolean(discovery.get('new-session-111')), true);
  assert.equal(Boolean(discovery.get('local_desktop-111')), true);
  assert.ok(
    discovery.forProject(cwd).filter((x) => x.agent === 'codex').length <= 2,
    'cold scans must respect their metadata read budget'
  );
  for (let i = 0; i < 6; i++) {
    discovery.invalidate();
    discovery.refresh();
  }
  assert.equal(discovery.forProject(cwd).filter((x) => x.agent === 'codex').length, 9);
  // Known IDs remain directly discoverable even outside the incremental budget.
  assert.equal(Boolean(discovery.get('old-session-0')), true);
});

test('a resumed old thread is indexed before recent inactive threads using native activity metadata', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-resumed-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'project'),
    codex = path.join(dir, 'codex'),
    old = path.join(codex, 'sessions/2025/01/01'),
    recent = path.join(codex, 'sessions/2026/11/03');
  for (const p of [cwd, old, recent]) fs.mkdirSync(p, { recursive: true });
  for (const [folder, id] of [
    [old, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    [recent, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  ])
    fs.writeFileSync(
      path.join(folder, 'rollout-fixture-' + id + '.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'cli' } }) + '\n'
    );
  fs.writeFileSync(
    path.join(codex, 'session_index.jsonl'),
    JSON.stringify({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      thread_name: 'Resumed task',
      updated_at: new Date().toISOString(),
    }) + '\n'
  );
  const d = new SessionDiscovery({ codexHome: codex, claudeHome: path.join(dir, 'claude'), scanBudget: 1 });
  assert.equal(d.forProject(cwd)[0]?.id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(d.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').title, 'Resumed task');
});

test('ordinary project identity checks avoid Git subprocesses on the request path', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-root-fast-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.git'));
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = new URL('../lib/session-discovery.mjs', import.meta.url).href;
  const script = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';let calls=0;cp.execFileSync=()=>{calls++;throw Error('unexpected subprocess')};syncBuiltinESMExports();const {canonicalProject}=await import(${JSON.stringify(moduleUrl)});const root=canonicalProject(${JSON.stringify(dir)});console.log(JSON.stringify({root,calls}));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.root, realPath(dir));
  assert.equal(d.calls, 0);
});

test('fast project identity follows changed worktree metadata and removed folders immediately', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { canonicalProject } = await import('../lib/session-discovery.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-root-worktree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { stdio: 'ignore' });
  const root = path.join(dir, 'repo'),
    wt = path.join(dir, 'tree');
  fs.mkdirSync(root);
  git('-C', root, 'init', '-q');
  git(
    '-C',
    root,
    '-c',
    'user.name=test',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  );
  git('-C', root, 'worktree', 'add', '-q', '-b', 'test', wt);
  assert.equal(canonicalProject(wt), realPath(root));
  assert.equal(canonicalProject(root), canonicalProject(realPath(root)));
  fs.renameSync(path.join(wt, '.git'), path.join(wt, '.git-saved'));
  assert.equal(canonicalProject(wt), realPath(wt));
  fs.renameSync(path.join(wt, '.git-saved'), path.join(wt, '.git'));
  assert.equal(canonicalProject(wt), realPath(root));
  fs.rmSync(wt, { recursive: true, force: true });
  assert.equal(canonicalProject(wt), null);
});
