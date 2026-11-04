import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
const api = await import('../lib/codex-daemon.mjs').catch(() => ({}));
const id = '11111111-1111-4111-8111-111111111111';
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'md-daemon-'));
  fs.chmodSync(dir, 0o700);
  const control = path.join(dir, 'app-server-control');
  fs.mkdirSync(control, { mode: 0o700 });
  const socketPath = path.join(control, 'app-server-control.sock');
  const server = http.createServer(),
    wss = new WebSocketServer({ server, perMessageDeflate: false });
  const thread = {
    id,
    cwd: dir,
    status: { type: 'idle' },
    canAcceptDirectInput: true,
    parentThreadId: null,
    ...options.thread,
  };
  const turns = [],
    calls = [];
  wss.on('connection', (s) =>
    s.on('message', (data) => {
      const q = JSON.parse(data);
      calls.push(q);
      if (!Object.hasOwn(q, 'id')) return;
      if (q.method === 'turn/start' && options.dropSend) {
        s.terminate();
        return;
      }
      const result =
        q.method === 'initialize'
          ? { codexHome: dir }
          : q.method === 'thread/loaded/list'
            ? { data: options.unloaded ? [] : [id], nextCursor: null }
            : q.method === 'thread/read'
              ? { thread }
              : q.method === 'thread/turns/list'
                ? { data: [...turns].reverse(), nextCursor: null }
                : q.method === 'turn/start'
                  ? (() => {
                      const turn = {
                        id: 'daemon-turn',
                        status: 'inProgress',
                        startedAt: Date.now() / 1000,
                        items: [
                          {
                            type: 'userMessage',
                            clientId: q.params.clientUserMessageId,
                            content: q.params.input,
                          },
                        ],
                      };
                      turns.push(turn);
                      thread.status = { type: 'active', activeFlags: [] };
                      return { turn };
                    })()
                  : {};
      s.send(JSON.stringify({ id: q.id, result }));
    })
  );
  await new Promise((r) => server.listen(socketPath, r));
  fs.chmodSync(socketPath, 0o600);
  t.after(async () => {
    for (const s of wss.clients) s.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, socketPath, thread, turns, calls, wss };
}
test('shared daemon connects to the already loaded original thread without resuming or changing settings', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix adapter');
  assert.equal(typeof api.CodexDaemonBridge, 'function');
  const f = await fixture(t),
    b = new api.CodexDaemonBridge({ codexHome: f.dir, timeoutMs: 200 });
  t.after(() => b.close());
  const view = await b.observe(id, f.dir);
  assert.equal(view.connected, true);
  assert.equal(view.connectionSource, 'daemon');
  assert.equal(view.state, 'idle');
  const opts = f.calls.find((x) => x.method === 'initialize').params.capabilities.optOutNotificationMethods;
  assert.ok(opts.includes('item/commandExecution/outputDelta'));
  assert.equal(
    opts.some((x) => x.endsWith('requestApproval')),
    false
  );
  assert.deepEqual(
    f.calls.filter((x) => x.id).map((x) => x.method),
    ['initialize', 'thread/read', 'thread/loaded/list', 'thread/turns/list']
  );
  assert.equal(
    f.calls.some((x) => ['thread/resume', 'thread/start', 'turn/start'].includes(x.method)),
    false
  );
});
test('daemon refuses unloaded, read-only, subagent and mismatched project targets', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix adapter');
  for (const options of [
    { unloaded: true },
    { thread: { canAcceptDirectInput: false } },
    { thread: { parentThreadId: 'parent' } },
    { thread: { cwd: os.homedir() } },
  ]) {
    const f = await fixture(t, options),
      b = new api.CodexDaemonBridge({ codexHome: f.dir, timeoutMs: 200 });
    t.after(() => b.close());
    assert.equal((await b.observe(id, f.dir)).connected, false);
    await assert.rejects(b.start(id, f.dir, { text: 'Do not send', clientId: id }));
    assert.equal(
      f.calls.some((x) => ['thread/resume', 'turn/start'].includes(x.method)),
      false
    );
  }
});
test('daemon submits literal text and structured images once, preserving original model and permission settings', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix adapter');
  const f = await fixture(t),
    b = new api.CodexDaemonBridge({ codexHome: f.dir, timeoutMs: 200 });
  t.after(() => b.close());
  await b.observe(id, f.dir);
  const result = await b.start(id, f.dir, {
    text: 'Literal $(do-not-execute)',
    images: [{ path: path.join(f.dir, 'image.png') }],
    clientId: id,
    authorize: () => true,
  });
  assert.equal(result.turnId, 'daemon-turn');
  const params = f.calls.find((x) => x.method === 'turn/start').params;
  assert.deepEqual(Object.keys(params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.equal(params.input[0].text, 'Literal $(do-not-execute)');
  assert.equal(params.input[1].type, 'localImage');
  f.turns[0].status = 'completed';
  f.thread.status = { type: 'idle' };
  f.turns[0].items.push({ type: 'agentMessage', text: '**Reply**', phase: 'final_answer' });
  const view = await b.observe(id, f.dir, { force: true });
  assert.equal(view.turns[0].inputs[0].clientId, id);
  assert.equal(view.turns[0].status, 'completed');
  assert.equal(view.messages.at(-1).text, '**Reply**');
});
test('daemon connection loss after submission is uncertain and never retries input', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix adapter');
  const f = await fixture(t, { dropSend: true }),
    b = new api.CodexDaemonBridge({ codexHome: f.dir, timeoutMs: 200 });
  t.after(() => b.close());
  await b.observe(id, f.dir);
  await assert.rejects(b.start(id, f.dir, { text: 'Once', clientId: id }), (e) => e.uncertain === true);
  assert.equal(f.calls.filter((x) => x.method === 'turn/start').length, 1);
});
test('daemon honors permission revocation, pending approval and private socket protection', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix adapter');
  const f = await fixture(t),
    b = new api.CodexDaemonBridge({ codexHome: f.dir, timeoutMs: 200 });
  t.after(() => b.close());
  await b.observe(id, f.dir);
  await assert.rejects(b.start(id, f.dir, { text: 'Do not send', clientId: id, authorize: () => false }));
  f.thread.status = { type: 'active', activeFlags: ['waitingOnApproval'] };
  assert.equal((await b.observe(id, f.dir, { force: true })).state, 'needs_input');
  await assert.rejects(b.start(id, f.dir, { text: 'Do not send', clientId: id }));
  fs.chmodSync(f.socketPath, 0o666);
  assert.equal((await b.observe(id, f.dir, { force: true })).connected, false);
  assert.equal(
    f.calls.some((x) => x.method === 'turn/start'),
    false
  );
});

test('daemon accepts the native private symlink layout but rejects an exposed target directory', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix adapter');
  const f = await fixture(t),
    targetDir = path.join(f.dir, 'daemon');
  fs.mkdirSync(targetDir, { mode: 0o700 });
  const target = path.join(targetDir, 'actual.sock');
  fs.renameSync(f.socketPath, target);
  fs.symlinkSync(target, f.socketPath);
  const b = new api.CodexDaemonBridge({ codexHome: f.dir, timeoutMs: 200 });
  t.after(() => b.close());
  assert.equal((await b.observe(id, f.dir)).connected, true);
  fs.chmodSync(targetDir, 0o755);
  assert.equal((await b.observe(id, f.dir, { force: true })).connected, false);
  assert.equal(
    f.calls.some((x) => x.method === 'turn/start'),
    false
  );
});

test('durable queue waits while native session is busy and follows the matching receipt to completion', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix adapter');
  const { AppDeliveryQueue } = await import('../lib/app-delivery.mjs');
  const f = await fixture(t, { thread: { status: { type: 'active', activeFlags: [] } } });
  const b = new api.CodexDaemonBridge({ codexHome: f.dir, timeoutMs: 200 });
  t.after(() => b.close());
  // Force fresh native observations so this test does not rely on wall-clock sleeps.
  const queue = new AppDeliveryQueue({
    dir: path.join(f.dir, 'deliveries'),
    enabled: () => true,
    resolve: () => ({ cwd: f.dir }),
    bridge: {
      observe: (id, cwd) => b.observe(id, cwd, { force: true }),
      start: (...args) => b.start(...args),
    },
  });
  queue.enqueue(id, { text: 'Native queue test', nonce: 'daemon-queue-test-111' });
  await queue.tick();
  assert.equal(queue.list(id)[0].state, 'queued');
  assert.equal(f.calls.filter((x) => x.method === 'turn/start').length, 0);
  f.thread.status = { type: 'idle' };
  await queue.tick();
  assert.equal(queue.list(id)[0].state, 'working');
  f.turns[0].status = 'completed';
  f.thread.status = { type: 'idle' };
  f.turns[0].items.push({ type: 'agentMessage', text: 'Done', phase: 'final_answer' });
  await queue.tick();
  await queue.tick();
  assert.equal(queue.list(id)[0].state, 'completed');
  assert.equal(queue.list(id)[0].delivered, true);
  assert.equal(f.calls.filter((x) => x.method === 'turn/start').length, 1);
});

test('a running native turn keeps the queue busy even if the earlier status snapshot was idle', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix adapter');
  const f = await fixture(t),
    b = new api.CodexDaemonBridge({ codexHome: f.dir, timeoutMs: 200 });
  t.after(() => b.close());
  f.turns.push({ id: 'running', status: 'inProgress', startedAt: Date.now() / 1000, items: [] });
  assert.equal((await b.observe(id, f.dir)).state, 'busy');
  await assert.rejects(b.start(id, f.dir, { text: 'Wait', clientId: id }));
  assert.equal(
    f.calls.some((x) => x.method === 'turn/start'),
    false
  );
});
