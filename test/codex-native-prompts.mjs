import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
const sid = '22222222-2222-4222-8222-222222222222';
async function fixture(t) {
  const home = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'md-nq-'));
  fs.chmodSync(home, 0o700);
  const codex = path.join(home, 'codex'),
    project = path.join(home, 'project');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(codex, 'ipc'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(codex, 'ipc'), 0o700);
  const rollout = path.join(codex, 'sessions', '2026', '11', '04', 'rollout-' + sid + '.jsonl');
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(
    rollout,
    JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd: project, source: 'vscode' } }) + '\n'
  );
  const free = async () => {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const port = s.address().port;
    await new Promise((r) => s.close(r));
    return port;
  };
  const port = await free(),
    content = await free();
  const env = {
    ...process.env,
    MYDASH_HOME: home,
    MYDASH_PORT: String(port),
    MYDASH_CONTENT_PORT: String(content),
    MYDASH_CODEX_HOME: codex,
    MYDASH_CLAUDE_PROJECTS: path.join(home, 'claude'),
    MYDASH_LANG: 'en',
  };
  delete env.MYDASH_PROMPT_MODE;
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      port,
      contentPort: content,
      access: 'local',
      lang: 'en',
      prompts: { codexMode: 'parallel' },
    })
  );
  const state = {
      id: sid,
      cwd: project,
      resumeState: 'resumed',
      requests: [],
      threadRuntimeStatus: { type: 'idle' },
      turns: [],
    },
    clients = new Set(),
    writes = [];
  let hook,
    child,
    failures = '',
    onWrite,
    revision = 0;
  const send = (socket, value) => {
    const data = Buffer.from(JSON.stringify(value)),
      head = Buffer.alloc(4);
    head.writeUInt32LE(data.length);
    socket.write(Buffer.concat([head, data]));
  };
  const broadcast = () => {
    for (const socket of clients)
      send(socket, {
        type: 'broadcast',
        method: 'thread-stream-state-changed',
        version: 11,
        sourceClientId: 'owner',
        params: {
          hostId: 'local',
          conversationId: sid,
          change: { type: 'snapshot', revision: ++revision, conversationState: state },
        },
      });
  };
  const native = net.createServer((socket) => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const len = buffer.readUInt32LE(),
          q = JSON.parse(buffer.subarray(4, len + 4));
        buffer = buffer.subarray(len + 4);
        if (q.type === 'broadcast') {
          if (q.method === 'thread-stream-following-changed' && q.params.following) broadcast();
          continue;
        }
        if (q.type !== 'request') continue;
        (async () => {
          let result = {};
          if (q.method === 'initialize') result = { clientId: 'mydash-client' };
          else if (q.method === 'thread-follower-read-model-settings')
            result = { settings: { resumeState: 'resumed' } };
          else if (q.method === 'thread-owner-discovery') result = { supportsUntrustedAppInput: true };
          else if (q.method === 'thread-follower-start-turn' || q.method === 'thread-follower-steer-turn') {
            writes.push(q);
            if (onWrite) {
              const decision = await onWrite(q);
              if (decision === 'drop') {
                socket.destroy();
                return;
              }
            }
            const input = q.params.turnStart?.request.input || q.params.input;
            state.turns.push({
              turnId: 'response-' + writes.length,
              turnStartedAtMs: Date.now(),
              status: 'completed',
              items: [{ type: 'userMessage', content: input }],
            });
            broadcast();
            result = { result: 'native-answer' };
          }
          send(socket, {
            type: 'response',
            requestId: q.requestId,
            resultType: 'success',
            handledByClientId: 'owner',
            result,
          });
        })().catch((e) => {
          failures += String(e);
          socket.destroy();
        });
      }
    });
  });
  const sock = path.join(codex, 'ipc/ipc.sock');
  await new Promise((r) => native.listen(sock, r));
  fs.chmodSync(sock, 0o600);
  t.after(async () => {
    hook?.kill();
    child?.kill();
    if (child) await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    for (const s of clients) s.destroy();
    await new Promise((r) => native.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['server.mjs'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (b) => (failures += String(b)));
  const base = 'http://127.0.0.1:' + port;
  const wait = async (fn) => {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      try {
        if (await fn()) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('isolated server/receipt not ready: ' + failures);
  };
  await wait(async () => (await fetch(base + '/healthz')).ok);
  const post = async (url, body) => {
    const r = await fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mydash': '1', Origin: base },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  const saved = () => JSON.parse(fs.readFileSync(path.join(home, 'state/prompts.json'), 'utf8')).items;
  const prompt = async (id) => saved().find((p) => p.id === id);
  let count = 0;
  const ask = async () => {
    const call = 'call_native_' + ++count;
    state.turns = [
      {
        turnId: 'original',
        status: 'completed',
        turnStartedAtMs: Date.now(),
        items: [
          {
            type: 'agentMessage',
            id: call,
            questions: [{ title: 'Choose route ' + count, options: ['A', 'B'] }],
          },
        ],
      },
    ];
    broadcast();
    const input = {
      hook_event_name: 'PreToolUse',
      session_id: sid,
      cwd: project,
      tool_name: 'request_user_input_async',
      tool_use_id: call,
      transcript_path: rollout,
      tool_input: { questions: [{ title: 'Choose route ' + count, options: ['A', 'B'] }] },
    };
    hook = spawn(process.execPath, ['bin/agent-ask.mjs', 'codex'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    hook.stdout.on('data', (x) => (output += x));
    hook.stdin.end(JSON.stringify(input));
    await new Promise((r) => hook.once('exit', r));
    assert.equal(output, '', 'native tool must remain unblocked');
    let p;
    await wait(async () => {
      p = saved().find((p) => p.native?.callId === call);
      return !!p;
    });
    assert.equal(p.both, true);
    assert.equal(p.appOnly, undefined);
    return { p, call, text: 'Choose route ' + count };
  };
  return {
    home,
    base,
    post,
    prompt,
    ask,
    state,
    writes,
    broadcast,
    wait,
    setOnWrite: (fn) => (onWrite = fn),
    rollout,
  };
}
test('native and mydash both show the question; web receipt wins without a transcript race or duplicate submission', async (t) => {
  if (process.platform === 'win32') return t.skip('desktop Unix IPC adapter');
  const f = await fixture(t),
    { p, text } = await f.ask();
  const page = await (await fetch(f.base + '/prompts/' + p.id)).text();
  assert.match(page, /pr-acts/);
  assert.match(page, /at the same time/);
  f.setOnWrite(async () => {
    const cancelled = await f.post('/api/prompts/' + p.id + '/cancel', { reason: 'terminal' });
    assert.equal(cancelled.data.prompt.status, 'pending');
    await new Promise((r) => setTimeout(r, 50));
  });
  const sending = f.post('/api/prompts/' + p.id + '/answer', { answers: { [text]: 'A' } });
  await f.wait(() => f.writes.length === 1);
  const duplicate = await f.post('/api/prompts/' + p.id + '/answer', { answers: { [text]: 'A' } });
  assert.equal(duplicate.status, 423);
  const receipt = await sending;
  assert.equal(receipt.status, 200);
  assert.equal(receipt.data.prompt.status, 'answered');
  assert.equal(receipt.data.prompt.by, 'web');
  assert.equal(f.writes.length, 1);
});
test('a native answer closes the mirror and a stale web answer cannot create another user message', async (t) => {
  if (process.platform === 'win32') return t.skip('desktop Unix IPC adapter');
  const f = await fixture(t),
    { p, text, call } = await f.ask();
  const reply =
    '<send_user_message_question_reply>' +
    JSON.stringify([
      { questionItemId: JSON.stringify(['request_user_input_async', call, 0]), question: text, answer: 'B' },
    ]) +
    '</send_user_message_question_reply>';
  f.state.turns.push({
    turnId: 'native-first',
    turnStartedAtMs: Date.now() + 1,
    items: [{ type: 'userMessage', content: [{ type: 'text', text: reply }] }],
  });
  f.broadcast();
  const r = await f.post('/api/prompts/' + p.id + '/answer', { answers: { [text]: 'A' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.status, 'terminal');
  assert.equal(f.writes.length, 0);
});
test('lost native receipt keeps the question unconfirmed and blocks retry instead of falsely marking answered', async (t) => {
  if (process.platform === 'win32') return t.skip('desktop Unix IPC adapter');
  const f = await fixture(t),
    { p, text } = await f.ask();
  f.setOnWrite(async () => 'drop');
  const first = await f.post('/api/prompts/' + p.id + '/answer', { answers: { [text]: 'A' } });
  assert.equal(first.status, 423);
  assert.equal(first.data.uncertain, true);
  const second = await f.post('/api/prompts/' + p.id + '/answer', { answers: { [text]: 'A' } });
  assert.equal(second.status, 423);
  assert.equal(f.writes.length, 1);
  const saved = await f.prompt(p.id);
  assert.equal(saved.status, 'pending');
  assert.equal(saved.nativeDelivery.state, 'uncertain');
  const page = await (await fetch(f.base + '/prompts/' + p.id)).text();
  assert.match(page, /awaiting confirmation/);
  assert.doesNotMatch(page, /<div class="pr-acts">/);
});
