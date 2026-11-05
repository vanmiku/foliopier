import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-question-'));
process.env.MYDASH_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const api = await import('../lib/codex-questions.mjs').catch(() => ({}));
const sid = '11111111-1111-4111-8111-111111111111',
  call = 'call_question_1';
const questions = [{ question: 'Which route?', options: [{ label: 'A' }, { label: 'B' }] }];
const binding = { tool: 'request_user_input_async', callId: call };
const answers = { 'Which route?': 'A' };
function fixture(sync = false) {
  assert.equal(typeof api.CodexQuestions, 'function');
  const state = {
    id: sid,
    cwd: home,
    requests: sync
      ? [
          {
            id: 7,
            method: 'item/tool/requestUserInput',
            params: {
              itemId: call,
              turnId: 'turn-1',
              questions: [
                { id: 'route', question: 'Which route?', options: [{ label: 'A' }, { label: 'B' }] },
              ],
            },
          },
        ]
      : [],
    turns: [
      {
        turnId: 'turn-1',
        status: sync ? 'inProgress' : 'completed',
        turnStartedAtMs: Date.now(),
        items: sync
          ? []
          : [{ id: call, type: 'agentMessage', questions: [{ title: 'Which route?', options: ['A', 'B'] }] }],
      },
    ],
  };
  const calls = [];
  let connected = true;
  const bridge = {
    snapshots: new Map([[sid, { state }]]),
    observe: async () => ({
      connected,
      state: state.requests.length ? 'needs_input' : 'idle',
      owner: 'owner',
    }),
    peek: () => ({
      connected,
      owner: 'owner',
      state: state.requests.length ? 'needs_input' : state.turns[0].status === 'inProgress' ? 'busy' : 'idle',
    }),
    secure: () => true,
    request: async (method, params, version, owner, mutation) => {
      calls.push({ method, params, version, owner, mutation });
      // Local envelopes omit top-level hostId: match the App's method table.
      if (method === 'thread-follower-steer-turn' || method === 'thread-follower-submit-user-input')
        assert.equal(version, 1);
      if (method === 'thread-follower-start-turn') assert.equal(version, 2);
      if (method === 'thread-owner-discovery')
        return { handledByClientId: 'owner', result: { supportsUntrustedAppInput: true } };
      if (method === 'thread-follower-submit-user-input') {
        state.requests = [];
        state.turns[0].items.push({ type: 'userInputResponse', requestId: 7, answers: { route: ['A'] } });
      } else {
        if (method === 'thread-follower-steer-turn') {
          // The native App dereferences restoreMessage before dispatch.
          assert.equal(params.restoreMessage.cwd, home);
          assert.ok(params.restoreMessage.context);
        }
        const input = params.turnStart?.request?.input || params.input;
        state.turns.push({
          turnId: 'answer-turn',
          status: 'completed',
          turnStartedAtMs: Date.now() + 1,
          items: [{ type: 'userMessage', content: input }],
        });
      }
      return { handledByClientId: 'owner', result: { ok: true, result: 'answer-turn' } };
    },
  };
  const service = new api.CodexQuestions({ bridge, resolve: () => ({ id: sid, cwd: home }), receiptMs: 50 });
  const prompt = {
    id: 'ptest',
    tool: 'codex',
    kind: 'question',
    session: sid,
    cwd: home,
    questions,
    native: { ...binding, ...(sync ? { tool: 'request_user_input' } : {}) },
  };
  return { service, state, bridge, calls, prompt, disconnect: () => (connected = false) };
}
test('native synchronous question receives an exact request response without starting a turn or changing permissions', async () => {
  const f = fixture(true);
  const r = await f.service.answer(f.prompt, { answers });
  assert.equal(r.source, 'web');
  const write = f.calls.filter((x) => x.mutation);
  assert.equal(write.length, 1);
  assert.equal(write[0].method, 'thread-follower-submit-user-input');
  assert.equal(write[0].params.requestId, 7);
  assert.deepEqual(write[0].params.response, { answers: { route: { answers: ['A'] } } });
  assert.equal(write[0].version, 1);
});
test('async question response uses native question IDs and only the user-selected answer', async () => {
  const f = fixture();
  const r = await f.service.answer(f.prompt, { answers });
  assert.equal(r.source, 'web');
  const write = f.calls.find((x) => x.mutation);
  assert.equal(write.method, 'thread-follower-start-turn');
  const request = write.params.turnStart.request;
  assert.deepEqual(Object.keys(request).sort(), ['clientUserMessageId', 'input', 'threadId']);
  const text = request.input[0].text;
  assert.ok(text.includes(JSON.stringify(['request_user_input_async', call, 0]).replaceAll('"', '\\"')));
  assert.ok(text.includes('"answer":"A"'));
  assert.equal(text.includes('REPORT.md'), false);
});
test('a native answer already present wins without submitting a second answer', async () => {
  const f = fixture();
  f.state.turns.push({
    turnId: 'native-answer',
    turnStartedAtMs: Date.now() + 1,
    items: [
      {
        type: 'userMessage',
        content: [
          {
            type: 'text',
            text:
              '<send_user_message_question_reply>' +
              JSON.stringify([
                {
                  questionItemId: JSON.stringify(['request_user_input_async', call, 0]),
                  question: 'Which route?',
                  answer: 'B',
                },
              ]) +
              '</send_user_message_question_reply>',
          },
        ],
      },
    ],
  });
  assert.equal((await f.service.answer(f.prompt, { answers })).source, 'native');
  assert.equal(
    f.calls.some((x) => x.mutation),
    false
  );
});
test('wrong thread/project/call, changed question, secret question and command approval are never answered', async () => {
  for (const which of ['project', 'call', 'text', 'secret', 'permission']) {
    const f = fixture(true);
    if (which === 'project') f.prompt.cwd = os.tmpdir();
    if (which === 'call') f.prompt.native.callId = 'unrelated';
    if (which === 'text') f.prompt.questions = [{ question: 'Other question', options: [] }];
    if (which === 'secret') f.state.requests[0].params.questions[0].isSecret = true;
    if (which === 'permission') f.state.requests[0].method = 'item/commandExecution/requestApproval';
    await assert.rejects(f.service.answer(f.prompt, { answers }));
    assert.equal(
      f.calls.some((x) => x.mutation),
      false
    );
  }
});
test('active async questions use steering and a lost submission remains uncertain', async () => {
  const f = fixture();
  f.state.turns[0].status = 'inProgress';
  f.state.turns[0].turnStartedAtMs = Date.now() - 3 * 3600_000;
  f.prompt.at = new Date(Date.now() - 3 * 3600_000).toISOString();
  await f.service.answer(f.prompt, { answers });
  assert.equal(f.calls.find((x) => x.mutation).method, 'thread-follower-steer-turn');
  const g = fixture();
  g.bridge.request = async (method) => {
    if (method === 'thread-owner-discovery')
      return { handledByClientId: 'owner', result: { supportsUntrustedAppInput: true } };
    throw Object.assign(Error('lost receipt'), { uncertain: true });
  };
  await assert.rejects(g.service.answer(g.prompt, { answers }), (e) => e.uncertain === true);
});

test('receipt processing failures after submission remain uncertain and cannot invite a duplicate retry', async () => {
  const f = fixture();
  const request = f.bridge.request;
  f.bridge.request = async (...args) => {
    const r = await request(...args);
    if (args[4])
      f.bridge.peek = () => {
        throw Error('snapshot unavailable after native acceptance');
      };
    return r;
  };
  await assert.rejects(f.service.answer(f.prompt, { answers }), (e) => e.uncertain === true);
  assert.equal(f.calls.filter((x) => x.mutation).length, 1);
});

test('partly answered native groups stay unresolved and cannot resend the answered question', async () => {
  const f = fixture();
  f.prompt.questions = [...questions, { question: 'Anything else?', options: [] }];
  f.state.turns[0].items[0].questions.push({ title: 'Anything else?', options: [] });
  f.state.turns.push({
    turnStartedAtMs: Date.now() + 1,
    items: [
      {
        type: 'userMessage',
        content: [
          {
            type: 'text',
            text:
              '<send_user_message_question_reply>' +
              JSON.stringify([
                { questionItemId: JSON.stringify(['request_user_input_async', call, 0]), answer: 'A' },
              ]) +
              '</send_user_message_question_reply>',
          },
        ],
      },
    ],
  });
  await assert.rejects(
    f.service.answer(f.prompt, { answers: { ...answers, 'Anything else?': 'No' } }),
    (e) => e.reason === 'question_partial'
  );
  assert.equal(f.calls.filter((x) => x.mutation).length, 0);
});

test('reconnecting an old question refreshes only its original connection without submitting an answer', async () => {
  const f = fixture();
  let refreshed = null;
  f.bridge.refresh = async (id, cwd) => {
    refreshed = { id, cwd };
    return f.bridge.observe(id, cwd);
  };
  const result = await f.service.check(f.prompt, { refresh: true });
  assert.deepEqual(refreshed, { id: sid, cwd: home });
  assert.equal(result.state, 'ready');
  assert.equal(f.calls.filter((x) => x.mutation).length, 0);
});

test('explicit reconnect can wake an unloaded original App session without sending a choice', async () => {
  const f = fixture();
  let opened = 0,
    awake = false;
  const observe = f.bridge.observe,
    peek = f.bridge.peek;
  f.bridge.observe = async () => (awake ? observe() : { connected: false, reason: 'app_not_open' });
  f.bridge.refresh = f.bridge.observe;
  f.bridge.peek = () => (awake ? peek() : { connected: false, reason: 'app_not_open' });
  const service = new api.CodexQuestions({
    bridge: f.bridge,
    resolve: () => ({ cwd: home }),
    platform: 'darwin',
    open: async (id) => {
      assert.equal(id, sid);
      opened++;
      awake = true;
    },
    wakeOptions: { probeMs: 1, retryMs: 1, timeoutMs: 100 },
  });
  const result = await service.check(f.prompt, { refresh: true, recover: true });
  assert.equal(result.state, 'ready');
  assert.equal(opened, 1);
  assert.equal(f.calls.filter((x) => x.mutation).length, 0);
});
test('question wake cannot run for a changed project, revoked authorization or unconfirmed delivery', async () => {
  const f = fixture();
  let opened = 0;
  f.bridge.observe = async () => ({ connected: false, reason: 'app_not_open' });
  f.bridge.refresh = f.bridge.observe;
  f.bridge.peek = () => ({ connected: false, reason: 'app_not_open' });
  const service = new api.CodexQuestions({
    bridge: f.bridge,
    resolve: () => ({ cwd: home }),
    platform: 'darwin',
    open: async () => opened++,
    wakeOptions: { probeMs: 1, retryMs: 1, timeoutMs: 10 },
  });
  await assert.rejects(
    service.check({ ...f.prompt, cwd: path.dirname(home) }, { refresh: true, recover: true })
  );
  await assert.rejects(service.check(f.prompt, { refresh: true, recover: true, authorize: () => false }));
  await assert.rejects(
    service.check({ ...f.prompt, nativeDelivery: { state: 'uncertain' } }, { refresh: true, recover: true })
  );
  assert.equal(opened, 0);
  assert.equal(f.calls.filter((x) => x.mutation).length, 0);
});

test('a lost cached owner is refreshed before dispatch and the chosen answer is sent only once', async () => {
  const f = fixture();
  let ownerReads = 0,
    refreshes = 0;
  f.bridge.refresh = async () => {
    refreshes++;
    return f.bridge.observe();
  };
  const request = f.bridge.request;
  f.bridge.request = async (...args) => {
    if (args[0] === 'thread-owner-discovery' && ownerReads++ === 0)
      throw Object.assign(Error('no-client-found'), { uncertain: false });
    return request(...args);
  };
  await f.service.answer(f.prompt, { answers });
  assert.equal(refreshes, 1);
  assert.equal(ownerReads, 2);
  assert.equal(f.calls.filter((x) => x.mutation).length, 1);
});
