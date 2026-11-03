import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeRemoteBridge, remoteDeliveryState } from '../lib/claude-remote.mjs';
const binding = { remoteId: 'session_123456789abc', cwd: '/project' };
test('Claude Remote Control checks liveness, authenticates only to Anthropic and sends literal text once', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return new Response(
      JSON.stringify(
        url.includes('/events')
          ? opts.method === 'POST'
            ? { results: [{ sequence_num: 17 }] }
            : { data: [] }
          : {
              response_shape: {
                id: binding.remoteId,
                connection_status: 'connected',
                status: 'active',
                worker_status: 'idle',
                security_tier: 'standard',
                environment_kind: 'bridge',
              },
            }
      ),
      { status: 200 }
    );
  };
  const b = new ClaudeRemoteBridge({ credentials: () => ({ accessToken: 'private-test-token' }), fetchImpl });
  assert.equal((await b.observe('local-111', binding)).connected, true);
  await b.start('local-111', binding, {
    text: 'Only my text\n$(literal)',
    clientId: 'user-uuid',
    authorize: () => true,
  });
  assert.equal(calls.filter((x) => x.opts.method === 'POST').length, 1);
  const sent = calls.at(-1);
  assert.equal(new URL(sent.url).origin, 'https://api.anthropic.com');
  assert.equal(sent.opts.redirect, 'error');
  assert.deepEqual(JSON.parse(sent.opts.body).events[0].payload.message, {
    role: 'user',
    content: 'Only my text\n$(literal)',
  });
  assert.equal(sent.opts.headers.Authorization, 'Bearer private-test-token');
  await assert.rejects(() =>
    b.start('local-111', binding, { text: 'no', clientId: 'u2', authorize: () => false })
  );
  assert.equal(calls.filter((x) => x.opts.method === 'POST').length, 1);
});
test('Claude Remote Control refuses trusted-device sessions, offline workers, expired login and malformed IDs', async () => {
  for (const [response, status, reason] of [
    [{}, 401, 'claude_login'],
    [{}, 403, 'claude_forbidden'],
    [
      {
        response_shape: {
          id: binding.remoteId,
          connection_status: 'disconnected',
          status: 'active',
          security_tier: 'standard',
        },
      },
      200,
      'claude_offline',
    ],
    [
      {
        response_shape: {
          id: binding.remoteId,
          connection_status: 'connected',
          status: 'active',
          security_tier: 'trusted',
        },
      },
      200,
      'claude_trusted',
    ],
  ]) {
    const b = new ClaudeRemoteBridge({
      credentials: () => ({ accessToken: 'x' }),
      fetchImpl: async (url) =>
        new Response(JSON.stringify(url.includes('/events') ? { data: [] } : response), { status }),
    });
    assert.equal((await b.observe('local-111', binding)).reason, reason);
  }
  const b = new ClaudeRemoteBridge({
    credentials: () => ({ accessToken: 'x' }),
    fetchImpl: () => {
      throw Error('must not fetch');
    },
  });
  assert.equal(
    (await b.observe('local-111', { ...binding, remoteId: 'https://evil.example/' })).connected,
    false
  );
});
test('remote reply tracking follows the exact UUID and waits for a worker result, not progress text', () => {
  const d = { clientId: 'our-user', createdAt: Date.now() };
  const user = {
    sequence_num: 1,
    source: 'worker',
    payload: { type: 'user', uuid: 'our-user', message: { content: 'Hi' } },
  };
  const progress = {
    sequence_num: 2,
    source: 'worker',
    payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'Working' }] } },
  };
  assert.equal(remoteDeliveryState([], d), 'waiting_receipt');
  assert.equal(remoteDeliveryState([user, progress], d), 'working');
  assert.equal(
    remoteDeliveryState(
      [
        user,
        progress,
        {
          sequence_num: 3,
          source: 'worker',
          payload: { type: 'result', subtype: 'success', is_error: false },
        },
      ],
      d
    ),
    'completed'
  );
  assert.equal(
    remoteDeliveryState(
      [
        user,
        {
          sequence_num: 2,
          source: 'worker',
          payload: { type: 'user', uuid: 'someone-else', message: { content: 'another' } },
        },
      ],
      d
    ),
    'interrupted'
  );
  assert.equal(
    remoteDeliveryState(
      [
        { ...user, source: 'client' },
        { sequence_num: 2, source: 'worker', payload: { type: 'result', subtype: 'success' } },
      ],
      d
    ),
    'waiting_receipt'
  );
});
