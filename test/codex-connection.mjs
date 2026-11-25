import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CodexConnection } from '../lib/codex-connection.mjs';
import { CodexNativeQueue } from '../lib/codex-native-queue.mjs';
import { CodexWake } from '../lib/codex-wake.mjs';
const id = '11111111-1111-4111-8111-111111111111';
function fixture(native, desktopView = { connected: false, reason: 'app_unavailable' }, queueView) {
  const calls = [];
  const route = (name, view) => ({
    peek: () => view,
    observe: async () => {
      calls.push(name + ':observe');
      return view;
    },
    start: async () => {
      calls.push(name + ':start');
      throw Object.assign(Error('lost receipt'), { uncertain: true });
    },
  });
  const daemon = route('daemon', native),
    desktop = route('desktop', desktopView),
    queue = route('queue', queueView || { connected: false });
  return { calls, connection: new CodexConnection({ daemon, desktop, queue }) };
}
test('shared native session wins over a stale desktop socket and dispatch never falls back after receipt loss', async () => {
  const { calls, connection } = fixture({ connected: true, state: 'idle' });
  assert.equal((await connection.observe(id, '/project')).connectionSource, 'daemon');
  assert.equal(connection.peek(id, '/project').connected, true);
  await assert.rejects(connection.start(id, '/project', {}), (e) => e.uncertain);
  assert.deepEqual(calls, ['daemon:observe', 'daemon:start']);
});
test('desktop-only installations retain their original connection', async () => {
  const { calls, connection } = fixture(
    { connected: false, reason: 'daemon_unavailable' },
    { connected: true, state: 'idle' }
  );
  assert.equal((await connection.observe(id, '/project')).connectionSource, 'desktop');
  await connection.observe(id, '/project');
  assert.deepEqual(calls, ['daemon:observe', 'desktop:observe', 'desktop:observe']);
});
test('native read-only, unloaded and mismatched threads cannot fall back or launch another executor', async () => {
  for (const reason of ['daemon_readonly', 'daemon_not_loaded', 'app_mismatch', 'app_incompatible']) {
    const { calls, connection } = fixture({ connected: false, reason }, { connected: true });
    assert.equal((await connection.observe(id, '/project')).reason, reason);
    let opens = 0;
    const wake = new CodexWake({
      bridge: connection,
      authorize: () => true,
      open: async () => {
        opens++;
      },
    });
    assert.equal((await wake.ensure(id, '/project')).reason, reason);
    assert.deepEqual(calls, ['daemon:observe']);
    assert.equal(opens, 0);
  }
});

test('an offline desktop can use the persisted queue without retrying a failed write', async () => {
  const { calls, connection } = fixture(
    { connected: false, reason: 'daemon_unavailable' },
    { connected: false, reason: 'app_ipc_offline' },
    { connected: true, state: 'unknown' }
  );
  assert.equal((await connection.observe(id, '/project')).connectionSource, 'queue');
  await assert.rejects(connection.start(id, '/project', {}), (e) => e.uncertain);
  assert.deepEqual(calls, ['daemon:observe', 'desktop:observe', 'queue:observe', 'queue:start']);
});

test('the native queue verifies the project and submits only to the original user thread', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-native-queue-'));
  const log = path.join(dir, 'calls.jsonl');
  const child = `
    const fs = require('node:fs'), id = process.argv[1], log = process.argv[2];
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const q = JSON.parse(line);
      fs.appendFileSync(log, line + '\\n');
      if (!q.id) return;
      const thread = { id, cwd: process.env.CODEX_HOME, threadSource: 'user', source: 'vscode',
        ephemeral: false, canAcceptDirectInput: null };
      const result = q.method === 'initialize' ? { codexHome: process.env.CODEX_HOME }
        : q.method === 'thread/read' ? { thread }
        : q.method === 'thread/queue/add' ? { queuedSubmission: { clientUserMessageId: q.params.clientUserMessageId } }
        : { data: [] };
      console.log(JSON.stringify({ id: q.id, result }));
    });
  `;
  const bridge = new CodexNativeQueue({
    codexHome: dir, binary: () => process.execPath,
    launch: (bin, args, options) => spawn(bin, ['-e', child, id, log], options),
  });
  t.after(() => {
    bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal((await bridge.observe(id, dir)).connected, true);
  assert.equal((await bridge.observe(id, os.homedir())).connected, false);
  await assert.rejects(bridge.start(id, dir, { text: 'Draft', clientId: id, authorize: () => false }));
  await assert.rejects(bridge.start(id, os.homedir(), { text: 'Draft', clientId: id }));
  assert.deepEqual(await bridge.start(id, dir, { text: 'Draft', clientId: id }), { queued: true });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every((q) => ['initialize', 'initialized', 'thread/read', 'thread/queue/list', 'thread/turns/list', 'thread/queue/add'].includes(q.method)));
  assert.deepEqual(calls.filter((q) => q.method === 'thread/queue/add').map((q) => q.params), [{
    threadId: id, clientUserMessageId: id, input: [{ type: 'text', text: 'Draft' }],
  }]);
});

test('a native queue receipt only counts as delivered after the original turn has the message ID', async (t) => {
  const { AppDeliveryQueue } = await import('../lib/app-delivery.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-queue-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const view = { connected: true, state: 'unknown', connectionSource: 'queue', turns: [], pendingClientIds: [] };
  let submitted;
  const queue = new AppDeliveryQueue({
    dir, enabled: () => true, resolve: () => ({ cwd: dir }),
    bridge: {
      observe: async () => view,
      start: async (id, cwd, { clientId }) => {
        assert.equal(submitted, undefined);
        submitted = clientId;
        view.pendingClientIds = [clientId];
        return { queued: true };
      },
    },
  });
  queue.enqueue(id, { text: 'Follow-up', nonce: 'native-queue-nonce' });
  await queue.tick();
  assert.equal(queue.list(id)[0].state, 'native_queued');
  assert.equal(queue.list(id)[0].delivered, false);
  view.turns = [{ id: 'unrelated', startedAt: Date.now(), inputs: [{ text: 'Follow-up' }], status: 'completed' }];
  await queue.tick();
  assert.equal(queue.list(id)[0].state, 'native_queued');
  view.pendingClientIds = [];
  view.turns.push({ id: 'original', startedAt: Date.now(), inputs: [{ clientId: submitted }], status: 'completed' });
  await queue.tick();
  assert.equal(queue.list(id)[0].state, 'completed');
  assert.equal(queue.list(id)[0].turnId, 'original');
  assert.equal(queue.list(id)[0].delivered, true);
});
