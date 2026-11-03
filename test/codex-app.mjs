import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const api = await import('../lib/codex-app.mjs').catch(() => ({}));
const sid = '11111111-1111-4111-8111-111111111111';
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ipc-'));
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(path.join(dir, 'ipc'), { mode: 0o700 });
  const socketPath = path.join(dir, 'ipc/ipc.sock'),
    calls = [],
    sockets = new Set();
  let revision = 0;
  const broadcast = () => {
    const m = {
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: options.version ?? 11,
      sourceClientId: 'owner',
      params: {
        hostId: 'local',
        conversationId: sid,
        change: { type: 'snapshot', revision: ++revision, conversationState: state },
      },
    };
    const b = Buffer.from(JSON.stringify(m)),
      h = Buffer.alloc(4);
    h.writeUInt32LE(b.length);
    for (const socket of sockets) socket.write(Buffer.concat([h, b]));
  };
  const state = {
    id: sid,
    cwd: dir,
    resumeState: 'resumed',
    threadRuntimeStatus: { type: 'idle' },
    requests: [],
    turns: [],
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    const send = (obj) => {
      const b = Buffer.from(JSON.stringify(obj)),
        h = Buffer.alloc(4);
      h.writeUInt32LE(b.length);
      socket.write(h.subarray(0, 2));
      socket.write(Buffer.concat([h.subarray(2), b]));
    };
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE()) {
        const n = buf.readUInt32LE(),
          m = JSON.parse(buf.subarray(4, n + 4));
        buf = buf.subarray(n + 4);
        calls.push(m);
        if (m.type === 'broadcast') {
          if (m.method === 'thread-stream-following-changed' && m.params.following)
            send({
              type: 'broadcast',
              method: 'thread-stream-state-changed',
              version: options.version ?? 11,
              sourceClientId: 'owner',
              params: {
                hostId: 'local',
                conversationId: m.params.conversationId,
                change: {
                  type: 'snapshot',
                  revision: 1,
                  conversationState: options.multi ? { ...state, id: m.params.conversationId } : state,
                },
              },
            });
          continue;
        }
        if (m.type !== 'request') continue;
        if (m.method === 'thread-owner-discovery' && options.noOwner) {
          send({ type: 'response', requestId: m.requestId, resultType: 'error', error: 'no-client-found' });
          continue;
        }
        const result =
          m.method === 'initialize'
            ? { clientId: 'mydash-client' }
            : m.method === 'thread-owner-discovery'
              ? { supportsUntrustedAppInput: true }
              : m.method === 'thread-follower-read-model-settings'
                ? { settings: { resumeState: 'resumed', model: 'same-model' } }
                : { result: 'new-turn' };
        if (m.method === 'thread-follower-start-turn' && options.dropSend) {
          socket.destroy();
          continue;
        }
        if (m.method === 'thread-follower-start-turn' && options.mirrorTurn) {
          const r = m.params.turnStart.request;
          result.result = 'new-turn-' + (state.turns.length + 1);
          state.turns.push({
            turnId: result.result,
            status: 'inProgress',
            turnStartedAtMs: Date.now(),
            items: [{ type: 'userMessage', clientId: r.clientUserMessageId, content: r.input }],
          });
          state.threadRuntimeStatus = { type: 'active' };
          broadcast();
        }
        send({
          type: 'response',
          requestId: m.requestId,
          resultType: 'success',
          method: m.method,
          handledByClientId: 'owner',
          result,
        });
      }
    });
  });
  await new Promise((r) => server.listen(socketPath, r));
  fs.chmodSync(socketPath, 0o600);
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, socketPath, calls, state, broadcast };
}
test('native App bridge binds the actual owner and snapshots, sends literal text without overriding permissions', async (t) => {
  if (process.platform === 'win32') return t.skip('desktop Unix IPC adapter');
  assert.equal(typeof api.CodexAppBridge, 'function', 'native App adapter must exist');
  const f = await fixture(t),
    b = new api.CodexAppBridge({ socketPath: f.socketPath, timeoutMs: 300 });
  t.after(() => b.close());
  const view = await b.observe(sid, f.dir);
  assert.equal(view.connected, true);
  assert.equal(view.state, 'idle');
  const text = 'Do not execute: $(touch /tmp/nope)\n`literal`';
  await b.start(sid, f.dir, { text, clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const m = f.calls.find((x) => x.method === 'thread-follower-start-turn');
  assert.equal(m.version, 2);
  assert.equal(m.targetClientId, 'owner');
  assert.equal(m.params.conversationId, sid);
  assert.equal(m.params.turnStart.request.threadId, sid);
  assert.equal(m.params.turnStart.request.input[0].text, text);
  for (const key of ['model', 'approvalPolicy', 'sandboxPolicy', 'permissions', 'cwd'])
    assert.equal(key in m.params.turnStart.request, false);
  assert.equal(m.params.turnStart.context.inheritThreadSettings, true);
});
test('wrong project, insecure socket and unsupported stream protocol never permit sending', async (t) => {
  if (process.platform === 'win32') return t.skip('desktop Unix IPC adapter');
  assert.equal(typeof api.CodexAppBridge, 'function', 'native App adapter must exist');
  const f = await fixture(t),
    b = new api.CodexAppBridge({ socketPath: f.socketPath, timeoutMs: 150 });
  t.after(() => b.close());
  assert.equal((await b.observe(sid, os.homedir())).connected, false);
  await assert.rejects(b.start(sid, os.homedir(), { text: 'no', clientId: 'a' }));
  assert.equal(
    f.calls.some((x) => x.method === 'thread-follower-start-turn'),
    false
  );
  fs.chmodSync(f.socketPath, 0o666);
  b.close();
  assert.equal((await b.observe(sid, f.dir)).connected, false);
  const g = await fixture(t, { version: 99 }),
    c = new api.CodexAppBridge({ socketPath: g.socketPath, timeoutMs: 150 });
  t.after(() => c.close());
  assert.equal((await c.observe(sid, g.dir)).connected, false);
});
test('App history supports paginated turns, preserves markdown and never exposes tools or reasoning', () => {
  assert.equal(typeof api.appView, 'function', 'App view projection must exist');
  const turn = {
    turnId: 't1',
    status: 'inProgress',
    turnStartedAtMs: 12345,
    items: [
      { type: 'userMessage', clientId: 'c', content: [{ type: 'text', text: 'Question' }] },
      { type: 'reasoning', content: 'private' },
      { type: 'commandExecution', aggregatedOutput: 'secret' },
      { type: 'agentMessage', id: 'a', text: '**Working**', phase: 'commentary' },
    ],
  };
  const state = {
    cwd: '/p',
    resumeState: 'resumed',
    threadRuntimeStatus: { type: 'active' },
    requests: [],
    turnHistory: { history: { entitiesByKey: { t: turn } } },
  };
  const view = api.appView(state);
  assert.equal(view.state, 'busy');
  assert.equal(view.turns[0].status, 'inProgress');
  assert.deepEqual(
    view.messages.map((x) => x.text),
    ['Question', '**Working**']
  );
  assert.equal(JSON.stringify(view).includes('private'), false);
  assert.equal(JSON.stringify(view).includes('secret'), false);
  turn.status = 'completed';
  turn.items.push({ type: 'agentMessage', text: 'Done', phase: 'final_answer' });
  state.threadRuntimeStatus = { type: 'idle' };
  assert.equal(api.appView(state).turns[0].status, 'completed');
  assert.equal(api.appView({ ...state, requests: [{ type: 'approval' }] }).state, 'needs_input');
});
test('stream patches reject unsafe paths and missing revisions instead of guessing completion', () => {
  assert.equal(typeof api.applyAppChange, 'function', 'validated stream patch handling must exist');
  const snapshot = { revision: 1, state: { turns: [{ status: 'inProgress' }] } };
  const next = api.applyAppChange(snapshot, {
    type: 'patches',
    baseRevision: 1,
    revision: 2,
    patches: [{ op: 'replace', path: ['turns', 0, 'status'], value: 'completed' }],
  });
  assert.equal(next.state.turns[0].status, 'completed');
  assert.throws(() =>
    api.applyAppChange(next, { type: 'patches', baseRevision: 1, revision: 3, patches: [] })
  );
  assert.throws(() =>
    api.applyAppChange(next, {
      type: 'patches',
      baseRevision: 2,
      revision: 3,
      patches: [{ op: 'add', path: ['__proto__', 'polluted'], value: true }],
    })
  );
  assert.equal({}.polluted, undefined);
});

test('durable App queue waits for idle, deduplicates retries and waits for the final turn status', async (t) => {
  const { AppDeliveryQueue } = await import('../lib/app-delivery.mjs').catch(() => ({}));
  assert.equal(typeof AppDeliveryQueue, 'function', 'durable delivery queue must exist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-app-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const views = { connected: true, state: 'busy', turns: [] };
  let sends = 0;
  const bridge = {
    observe: async () => views,
    start: async (id, cwd, msg) => {
      sends++;
      views.turns.push({
        id: 'reply-turn',
        status: 'inProgress',
        inputs: [{ text: msg.text, clientId: msg.clientId }],
        answer: '',
      });
      return { turnId: 'reply-turn' };
    },
  };
  const queue = new AppDeliveryQueue({ dir, bridge, enabled: () => true, resolve: () => ({ cwd: dir }) });
  const nonce = 'aaaaaaaaaaaaaaaa';
  const first = queue.enqueue(sid, { text: 'Question', nonce });
  assert.equal(first.state, 'queued');
  queue.enqueue(sid, { text: 'Question', nonce });
  assert.throws(() => queue.enqueue(sid, { text: 'Different', nonce }));
  await queue.tick();
  assert.equal(sends, 0);
  views.state = 'idle';
  await queue.tick();
  assert.equal(sends, 1);
  assert.equal(queue.list(sid)[0].state, 'working');
  views.turns[0].answer = 'An intermediate sentence';
  await queue.tick();
  assert.equal(queue.list(sid)[0].state, 'working');
  views.turns[0].status = 'completed';
  await queue.tick();
  assert.equal(queue.list(sid)[0].state, 'completed');
  const restarted = new AppDeliveryQueue({ dir, bridge, enabled: () => true, resolve: () => ({ cwd: dir }) });
  restarted.enqueue(sid, { text: 'Question', nonce });
  await restarted.tick();
  assert.equal(sends, 1);
});
test('queue cancellation, flag revocation and uncertain delivery never silently send or retry', async (t) => {
  const { AppDeliveryQueue } = await import('../lib/app-delivery.mjs').catch(() => ({}));
  assert.equal(typeof AppDeliveryQueue, 'function', 'durable delivery queue must exist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-app-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let enabled = true,
    sends = 0;
  const bridge = {
    observe: async () => ({ connected: true, state: 'idle', turns: [] }),
    start: async () => {
      sends++;
      const e = Error('lost');
      e.uncertain = true;
      throw e;
    },
  };
  const opts = { dir, bridge, enabled: () => enabled, resolve: () => ({ cwd: dir }) };
  const queue = new AppDeliveryQueue(opts);
  queue.enqueue(sid, { text: 'Cancel', nonce: 'aaaaaaaaaaaaaaaa' });
  assert.equal(queue.cancel(sid, 'aaaaaaaaaaaaaaaa'), true);
  await queue.tick();
  assert.equal(sends, 0);
  queue.enqueue(sid, { text: 'Pause', nonce: 'bbbbbbbbbbbbbbbb' });
  enabled = false;
  await queue.tick();
  assert.equal(sends, 0);
  enabled = true;
  await queue.tick();
  assert.equal(sends, 1);
  assert.equal(queue.list(sid).find((x) => x.nonce === 'bbbbbbbbbbbbbbbb').state, 'uncertain');
  const restarted = new AppDeliveryQueue(opts);
  await restarted.tick();
  assert.equal(sends, 1);
  assert.equal(restarted.cancel(sid, 'bbbbbbbbbbbbbbbb'), false);
  assert.equal(restarted.cancel(sid, 'bbbbbbbbbbbbbbbb', true), true);
  assert.equal(restarted.list(sid).find((x) => x.nonce === 'bbbbbbbbbbbbbbbb').state, 'stopped');
  await restarted.tick();
  assert.equal(sends, 1);
});

test('delivered Codex messages follow no-input retries after a processing error, including persisted failures', async (t) => {
  const { AppDeliveryQueue } = await import('../lib/app-delivery.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-app-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sends = 0,
    client;
  const view = { connected: true, state: 'idle', turns: [] };
  const bridge = {
    observe: async () => view,
    start: async (id, cwd, msg) => {
      sends++;
      client = msg.clientId;
      return { turnId: 'original-turn' };
    },
  };
  const opts = { dir, bridge, enabled: () => true, resolve: () => ({ cwd: dir }) };
  const q = new AppDeliveryQueue(opts),
    nonce = 'retry-message-111';
  q.enqueue(sid, { text: 'Continue working', nonce });
  await q.tick();
  view.turns = [
    {
      id: 'original-turn',
      status: 'failed',
      error: true,
      startedAt: Date.now(),
      inputs: [{ text: 'Continue working', clientId: client }],
    },
  ];
  await q.tick();
  assert.equal(q.list(sid)[0].state, 'processing_failed');
  // Simulate an old release having frozen the processing error as delivery failure.
  const file = path.join(dir, sid, nonce + '.json'),
    saved = JSON.parse(fs.readFileSync(file));
  saved.state = 'failed';
  saved.error = 'app-turn-failed';
  fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = new AppDeliveryQueue(opts);
  view.state = 'busy';
  view.turns.push(
    { id: 'retry-1', status: 'failed', error: true, startedAt: Date.now() + 1, inputs: [] },
    { id: 'retry-2', status: 'inProgress', error: false, startedAt: Date.now() + 2, inputs: [] }
  );
  await restarted.tick();
  assert.equal(restarted.list(sid)[0].state, 'working');
  assert.equal(restarted.list(sid)[0].turnId, 'retry-2');
  assert.equal(restarted.list(sid)[0].error, null);
  await restarted.tick();
  assert.equal(restarted.list(sid)[0].state, 'working');
  view.turns.at(-1).status = 'interrupted';
  await restarted.tick();
  assert.equal(restarted.list(sid)[0].state, 'interrupted');
  view.turns.push({
    id: 'retry-3',
    status: 'inProgress',
    error: false,
    startedAt: Date.now() + 3,
    inputs: [],
  });
  await restarted.tick();
  assert.equal(restarted.list(sid)[0].state, 'working');
  view.turns.at(-1).status = 'completed';
  view.state = 'idle';
  await restarted.tick();
  assert.equal(restarted.list(sid)[0].state, 'completed');
  assert.equal(restarted.list(sid)[0].delivered, true);
  assert.equal(sends, 1);
});

test('a processing failure does not block the next queued message or attach to another user turn', async (t) => {
  const { AppDeliveryQueue } = await import('../lib/app-delivery.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-app-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let client,
    sends = 0;
  const view = { connected: true, state: 'idle', turns: [] };
  const q = new AppDeliveryQueue({
    dir,
    enabled: () => true,
    resolve: () => ({ cwd: dir }),
    bridge: {
      observe: async () => view,
      start: async (id, cwd, msg) => {
        sends++;
        client = msg.clientId;
        return { turnId: 'sent-' + sends };
      },
    },
  });
  q.enqueue(sid, { text: 'First question', nonce: 'first-message-111' });
  await q.tick();
  view.turns = [
    {
      id: 'sent-1',
      status: 'failed',
      error: true,
      startedAt: Date.now(),
      inputs: [{ text: 'First question', clientId: client }],
    },
    {
      id: 'other-user',
      status: 'completed',
      startedAt: Date.now() + 1,
      inputs: [{ text: 'A different task', clientId: 'other-user' }],
    },
    { id: 'unrelated-continuation', status: 'inProgress', startedAt: Date.now() + 2, inputs: [] },
  ];
  view.state = 'busy';
  await q.tick();
  assert.equal(q.list(sid)[0].state, 'processing_failed');
  view.state = 'idle';
  q.enqueue(sid, { text: 'Second question', nonce: 'second-message-222' });
  await q.tick();
  assert.equal(sends, 2);
});

test('a stale acknowledged turn ID cannot override a different client message identity', async (t) => {
  const { AppDeliveryQueue } = await import('../lib/app-delivery.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-app-stale-id-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const view = {
    connected: true,
    state: 'idle',
    turns: [
      {
        id: 'old-turn',
        status: 'completed',
        startedAt: Date.now(),
        inputs: [{ clientId: 'another-client', text: 'Continue' }],
      },
    ],
  };
  let sends = 0;
  const q = new AppDeliveryQueue({
    dir,
    enabled: () => true,
    resolve: () => ({ cwd: dir }),
    bridge: {
      observe: async () => view,
      start: async () => {
        sends++;
        return { turnId: 'old-turn' };
      },
    },
  });
  q.enqueue(sid, { text: 'Continue', nonce: 'stale-ack-message-111' });
  await q.tick();
  await q.tick();
  assert.notEqual(q.list(sid)[0].state, 'completed');
  assert.equal(sends, 1);
});

test('HTTP send travels through the native socket and exposes completion only for its own turn', async (t) => {
  if (process.platform === 'win32') return t.skip('desktop Unix IPC adapter');
  const f = await fixture(t, { mirrorTurn: true });
  const appHome = path.join(f.dir, 'mydash'),
    registry = path.join(appHome, 'state/agents'),
    sessions = path.join(f.dir, 'sessions');
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(sessions);
  const transcript = path.join(sessions, 'rollout-' + sid + '.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { cwd: f.dir } }) + '\n');
  fs.writeFileSync(
    path.join(registry, sid + '.json'),
    JSON.stringify({ agent: 'codex', state: 'idle', at: new Date().toISOString(), transcript, cwd: f.dir })
  );
  async function freePort() {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    return p;
  }
  const port = await freePort(),
    contentPort = await freePort(),
    base = 'http://127.0.0.1:' + port;
  fs.writeFileSync(
    path.join(appHome, 'config.json'),
    JSON.stringify({
      port,
      contentPort,
      baseUrl: base,
      lang: 'en',
      access: 'local',
      terminalSessions: { enabled: true, send: true },
      update: { mode: 'off' },
    })
  );
  const { spawn } = await import('node:child_process');
  const launch = () =>
    spawn(process.execPath, ['server.mjs'], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      env: {
        ...process.env,
        MYDASH_HOME: appHome,
        MYDASH_CODEX_HOME: f.dir,
        MYDASH_PORT: String(port),
        MYDASH_CONTENT_PORT: String(contentPort),
      },
      stdio: 'ignore',
    });
  let child = launch();
  t.after(async () => {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  });
  async function until(fn) {
    for (let i = 0; i < 100; i++) {
      try {
        const value = await fn();
        if (value) return value;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error('condition timeout');
  }
  await until(async () => (await fetch(base + '/healthz')).ok);
  const get = async () => (await fetch(base + '/api/sessions/' + sid)).json();
  const post = async (route, body) => {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { 'X-Mydash': '1', 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  };
  assert.equal((await get()).session.canSend, true);
  const project = path.basename(f.dir),
    item = path.join(appHome, 'data', project, 'article');
  fs.mkdirSync(item, { recursive: true });
  fs.writeFileSync(
    path.join(item, 'meta.json'),
    JSON.stringify({
      project,
      slug: 'article',
      versions: [
        {
          v: 1,
          title: 'Article title',
          main: 'REPORT.md',
          cwd: f.dir,
          time: new Date().toISOString(),
          files: [{ path: 'REPORT.md', kind: 'md' }],
        },
      ],
    })
  );
  const body = {
    id: sid,
    text: '**Explain** the article',
    nonce: 'http-native-1111',
    quote: '',
    article: { id: project + '/article', v: 1, file: 'REPORT.md' },
  };
  assert.equal((await post('/api/sessions/send', body)).status, 202);
  assert.equal((await post('/api/sessions/send', body)).status, 202);
  await until(async () => (await get()).session.deliveries[0]?.state === 'working');
  assert.equal(f.calls.filter((x) => x.method === 'thread-follower-start-turn').length, 1);
  assert.ok((await get()).html.includes('Explain'));
  assert.equal(
    f.calls.find((x) => x.method === 'thread-follower-start-turn').params.turnStart.request.input[0].text,
    body.text
  );
  f.state.turns[0].items.push({ type: 'agentMessage', text: 'Intermediate progress', phase: 'commentary' });
  f.broadcast();
  assert.equal((await get()).session.deliveries[0].state, 'working');
  f.state.turns[0].items.push({ type: 'agentMessage', text: '**Final reply**', phase: 'final_answer' });
  f.state.turns[0].status = 'completed';
  f.state.threadRuntimeStatus = { type: 'idle' };
  f.broadcast();
  await until(async () => (await get()).session.deliveries[0].state === 'completed');
  assert.ok((await get()).html.includes('<strong>Final reply</strong>'));
  f.state.threadRuntimeStatus = { type: 'active' };
  f.broadcast();
  await post('/api/sessions/send', { id: sid, text: 'Do not dispatch', nonce: 'http-cancel-1111' });
  assert.equal((await post('/api/sessions/cancel', { id: sid, nonce: 'http-cancel-1111' })).ok, true);
  assert.equal((await get()).session.deliveries.at(-1).state, 'cancelled');
  assert.equal(f.calls.filter((x) => x.method === 'thread-follower-start-turn').length, 1);
  await post('/api/sessions/send', { id: sid, text: 'Survive service restart', nonce: 'http-restart-111' });
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
  f.state.threadRuntimeStatus = { type: 'idle' };
  child = launch();
  await until(async () => f.calls.filter((x) => x.method === 'thread-follower-start-turn').length === 2);
  assert.equal((await get()).session.deliveries.at(-1).text, 'Survive service restart');
  f.state.turns.at(-1).status = 'completed';
  f.state.threadRuntimeStatus = { type: 'idle' };
  f.broadcast();
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZfoAAAAASUVORK5CYII=';
  const largePng =
    'data:image/png;base64,' +
    Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.alloc(900 * 1024)]).toString('base64');
  const upload = await post('/api/sessions/images', { id: sid, name: 'screen.png', data: largePng });
  assert.equal(upload.status, 200);
  assert.equal('path' in upload.image, false);
  assert.equal((await fetch(base + upload.image.url)).status, 200);
  const imageBody = { ...body, text: '', images: [upload.image.id], nonce: 'http-images-1111' };
  assert.equal((await post('/api/sessions/send', imageBody)).status, 202);
  const cleaned = await post('/api/session-image-storage', { action: 'clean', includeCompleted: true });
  assert.equal(
    cleaned.removed,
    0,
    'queued or active images cannot be cleaned even with completed cleanup enabled'
  );
  assert.equal((await fetch(base + upload.image.url)).status, 200);
  assert.equal((await post('/api/sessions/send', imageBody)).status, 202);
  await until(async () => f.calls.filter((x) => x.method === 'thread-follower-start-turn').length === 3);
  const imageInput = f.calls.filter((x) => x.method === 'thread-follower-start-turn').at(-1).params.turnStart
    .request.input;
  assert.equal(imageInput.length, 1);
  assert.equal(imageInput[0].type, 'localImage');
  assert.equal(fs.existsSync(imageInput[0].path), true);
  assert.equal(
    (await post('/api/sessions/send', { ...imageBody, nonce: 'bad-image-11111', images: ['../../config'] }))
      .status,
    400
  );
});

test('native image-only messages use structured localImage inputs, not filenames in text', async (t) => {
  if (process.platform === 'win32') return t.skip('desktop Unix IPC adapter');
  const f = await fixture(t),
    b = new api.CodexAppBridge({ socketPath: f.socketPath, timeoutMs: 300 });
  t.after(() => b.close());
  const image = path.join(f.dir, 'image.png');
  fs.writeFileSync(image, 'fixture');
  await b.observe(sid, f.dir);
  await b.start(sid, f.dir, {
    text: '',
    images: [{ path: image }],
    clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  const m = f.calls.find((x) => x.method === 'thread-follower-start-turn');
  assert.deepEqual(m.params.turnStart.request.input, [{ type: 'localImage', path: image }]);
});

test('four recently viewed App conversations stay connected instead of silently evicting the first', async (t) => {
  if (process.platform === 'win32') return t.skip('desktop Unix IPC adapter');
  const f = await fixture(t, { multi: true }),
    b = new api.CodexAppBridge({ socketPath: f.socketPath, timeoutMs: 300 });
  t.after(() => b.close());
  const ids = [1, 2, 3, 4].map((n) => String(n).repeat(8) + '-1111-4111-8111-111111111111');
  for (const id of ids) assert.equal((await b.observe(id, f.dir)).connected, true);
  for (const id of ids)
    assert.equal(
      b.peek(id, f.dir).connected,
      true,
      'a fourth project must not turn another active project view-only'
    );
});
test('connection failures distinguish an unopened conversation from a project mismatch', async (t) => {
  if (process.platform === 'win32') return t.skip('desktop Unix IPC adapter');
  const f = await fixture(t, { noOwner: true }),
    b = new api.CodexAppBridge({ socketPath: f.socketPath, timeoutMs: 150 });
  t.after(() => b.close());
  assert.equal((await b.observe(sid, f.dir)).reason, 'app_not_open');
  const g = await fixture(t),
    c = new api.CodexAppBridge({ socketPath: g.socketPath, timeoutMs: 150 });
  t.after(() => c.close());
  assert.equal((await c.observe(sid, os.homedir())).reason, 'app_mismatch');
});

test('queue restart restores unfinished tasks beyond history limits and across all sessions', async (t) => {
  const { AppDeliveryQueue } = await import('../lib/app-delivery.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-queue-restore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { dir, bridge: {}, enabled: () => true, resolve: () => null };
  const queue = new AppDeliveryQueue(options);
  let last;
  for (let i = 0; i < 101; i++) {
    last = '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
    queue.enqueue(last, { text: 'Queued task', nonce: 'restart-boundary-111' });
    if (i < 100) queue.cancel(last, 'restart-boundary-111');
  }
  for (let i = 0; i < 55; i++) {
    const nonce = 'history-message-' + String(i).padStart(3, '0');
    queue.enqueue(last, { text: 'History', nonce });
    queue.cancel(last, nonce);
  }
  const restored = new AppDeliveryQueue(options);
  assert.equal(restored.list(last).find((x) => x.nonce === 'restart-boundary-111')?.state, 'queued');
});
