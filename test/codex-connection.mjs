import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexConnection } from '../lib/codex-connection.mjs';
import { CodexWake } from '../lib/codex-wake.mjs';
const id = '11111111-1111-4111-8111-111111111111';
function fixture(native, desktopView = { connected: false, reason: 'app_unavailable' }) {
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
    desktop = route('desktop', desktopView);
  return { calls, connection: new CodexConnection({ daemon, desktop }) };
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
