import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const api = await import('../lib/codex-wake.mjs').catch(() => ({}));
const id = '11111111-1111-4111-8111-111111111111';
const cwd = os.tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fixture(overrides = {}) {
  let connected = false,
    opens = 0,
    permitted = true;
  const bridge = {
    peek: () => ({ connected }),
    observe: async () => ({ connected, reason: 'app_not_open' }),
  };
  const manager = new api.CodexWake({
    bridge,
    authorize: () => permitted,
    open: async () => {
      opens++;
      connected = true;
    },
    probeMs: 2,
    retryMs: 2,
    timeoutMs: 80,
    cooldownMs: 500,
    manualCooldownMs: 50,
    ...overrides,
  });
  return {
    manager,
    bridge,
    opens: () => opens,
    revoke: () => {
      permitted = false;
    },
  };
}
test('opens only the validated original thread through the logged-in user GUI, with no prompt or shell', async () => {
  assert.equal(typeof api.openCodexThread, 'function');
  const calls = [];
  const options = {
    platform: 'darwin',
    uid: 501,
    consoleUid: () => 501,
    run: async (...args) => {
      calls.push(args);
    },
  };
  await api.openCodexThread(id, options);
  assert.deepEqual(calls[0][1], [
    'asuser',
    '501',
    '/usr/bin/open',
    '-g',
    '-b',
    'com.openai.codex',
    'codex://threads/' + id,
  ]);
  assert.equal(calls[0][0], '/bin/launchctl');
  assert.equal(calls[0][2].shell, undefined);
  await assert.rejects(api.openCodexThread(id + '?prompt=send', options));
  await assert.rejects(api.openCodexThread(id, { ...options, consoleUid: () => 502 }), {
    reason: 'app_login_required',
  });
  await assert.rejects(api.openCodexThread(id, { ...options, platform: 'win32' }));
  assert.equal(calls.length, 1);
});
test('automatically wakes an unloaded conversation and deduplicates simultaneous requests', async () => {
  assert.equal(typeof api.CodexWake, 'function');
  const f = fixture();
  const results = await Promise.all([f.manager.ensure(id, cwd), f.manager.ensure(id, cwd)]);
  assert.equal(f.opens(), 1);
  assert.ok(results.every((x) => x.state === 'connected'));
});
test('already connected and incompatible threads are never opened', async () => {
  const f = fixture();
  f.bridge.peek = () => ({ connected: true });
  assert.equal((await f.manager.ensure(id, cwd)).state, 'connected');
  f.bridge.peek = () => ({ connected: false, reason: 'app_mismatch' });
  assert.equal((await f.manager.ensure(id, cwd)).reason, 'app_mismatch');
  assert.equal(f.opens(), 0);
});
test('history observation is independent of opening; a slow discovery does not prevent wake', async () => {
  const f = fixture();
  f.bridge.observe = () => new Promise(() => {});
  const result = await f.manager.ensure(id, cwd);
  assert.equal(f.opens(), 1);
  assert.equal(result.state, 'connected');
});
test('permission revocation while discovering prevents opening and submitting anything', async () => {
  const f = fixture();
  f.bridge.observe = async () => {
    await sleep(15);
    return { connected: false };
  };
  const task = f.manager.ensure(id, cwd);
  f.revoke();
  assert.equal((await task).reason, 'disabled');
  assert.equal(f.opens(), 0);
});
test('failed wake has bounded retries and manual retry cannot launch-spam the App', async () => {
  let opens = 0;
  const f = fixture({
    open: async () => {
      opens++;
      throw Object.assign(Error(), { reason: 'app_login_required' });
    },
  });
  assert.equal((await f.manager.ensure(id, cwd)).reason, 'app_login_required');
  await f.manager.ensure(id, cwd);
  await f.manager.ensure(id, cwd, { manual: true });
  assert.equal(opens, 1);
  await sleep(55);
  await f.manager.ensure(id, cwd, { manual: true });
  assert.equal(opens, 2);
});
test('wake timeout never sends input, and an unrelated project cannot reuse a pending wake', async () => {
  let opens = 0;
  const f = fixture({
    timeoutMs: 12,
    open: async () => {
      opens++;
    },
  });
  const task = f.manager.ensure(id, cwd);
  assert.equal((await f.manager.ensure(id, cwd + '/other')).reason, 'app_mismatch');
  assert.equal((await task).reason, 'app_wake_timeout');
  assert.equal(opens, 1);
});
test('a queued message cannot wake or dispatch after expiry or permission revocation', async (t) => {
  const { AppDeliveryQueue } = await import('../lib/app-delivery.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-wake-expire-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let allowed = true,
    opens = 0;
  const queue = new AppDeliveryQueue({
    dir,
    enabled: () => allowed,
    resolve: () => ({ cwd }),
    connect: () => {
      opens++;
    },
    bridge: { observe: async () => ({ connected: false }) },
  });
  queue.enqueue(id, { text: 'Expired', nonce: 'expired-waking-111' });
  queue.rows.get(id + '/expired-waking-111').createdAt -= 1800001;
  await queue.tick();
  assert.equal(queue.list(id)[0].state, 'expired');
  queue.enqueue(id, { text: 'Paused', nonce: 'paused-waking-1111' });
  allowed = false;
  await queue.tick();
  assert.equal(queue.list(id).at(-1).state, 'paused');
  assert.equal(opens, 0);
});
test('queued messages can be cancelled while waking without dispatch or further wake', async (t) => {
  const { AppDeliveryQueue } = await import('../lib/app-delivery.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-wake-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let wake = 0,
    connected = false,
    sends = 0;
  const queue = new AppDeliveryQueue({
    dir,
    enabled: () => true,
    resolve: () => ({ cwd }),
    connect: () => {
      wake++;
    },
    bridge: {
      observe: async () => ({ connected, state: 'idle', turns: [] }),
      start: async () => {
        sends++;
        return { turnId: 'turn' };
      },
    },
  });
  queue.enqueue(id, { text: 'Test', nonce: 'cancel-waking-111' });
  await queue.tick();
  assert.equal(wake, 1);
  assert.equal(queue.cancel(id, 'cancel-waking-111'), true);
  connected = true;
  await queue.tick();
  assert.equal(sends, 0);
  assert.equal(wake, 1);
  assert.equal(queue.list(id)[0].state, 'cancelled');
});
