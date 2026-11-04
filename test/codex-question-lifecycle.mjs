import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const sid = 'native-question-lifecycle';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-native-lifecycle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  const prompt = {
    id: 'p1234567890',
    tool: 'codex',
    kind: 'question',
    session: sid,
    status: 'pending',
    both: true,
    polledAt: Date.now(),
    native: { tool: 'request_user_input_async', callId: 'native-call' },
  };
  function run({
    prompts = [prompt],
    config = {},
    agent = 'codex',
    event = 'Stop',
    active = false,
    state = 'idle',
  } = {}) {
    fs.writeFileSync(path.join(home, 'state/prompts.json'), JSON.stringify({ items: prompts }));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    const r = spawnSync(process.execPath, ['bin/agent-state.mjs', state, agent], {
      env: { ...process.env, MYDASH_HOME: home, MYDASH_LANG: 'en' },
      input: JSON.stringify({
        session_id: sid,
        hook_event_name: event,
        stop_hook_active: active,
        last_assistant_message: 'Work complete.',
      }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return {
      output: r.stdout,
      state: JSON.parse(fs.readFileSync(path.join(home, 'state/agents', sid + '.json'))),
    };
  }
  return { run, prompt };
}
test('an unanswered native async question prevents completion that would hide its App card', (t) => {
  const f = fixture(t),
    r = f.run();
  assert.equal(JSON.parse(r.output).decision, 'block');
  assert.match(JSON.parse(r.output).reason, /wait/i);
  assert.match(JSON.parse(r.output).reason, /do not.*(ask|question)/i);
  assert.equal(r.state.state, 'busy');
});
test('the lifecycle guard fails open for stale, handled, other-session, permission and non-native prompts', (t) => {
  const f = fixture(t);
  for (const change of [
    { status: 'answered' },
    { status: 'released' },
    { status: 'cancelled' },
    { session: 'other-session' },
    { tool: 'claude' },
    { kind: 'permission' },
    { appOnly: true },
    { native: null },
    { native: { tool: 'request_user_input', callId: 'sync' } },
    { polledAt: Date.now() - 60_000 },
  ]) {
    assert.equal(f.run({ prompts: [{ ...f.prompt, ...change }] }).output, '', JSON.stringify(change));
  }
  for (const config of [
    { prompts: { enabled: false } },
    { prompts: { codexMode: 'app' } },
    { prompts: { codexMode: 'hold' } },
  ])
    assert.equal(f.run({ config }).output, '');
  assert.equal(f.run({ agent: 'claude' }).output, '');
  assert.equal(f.run({ event: 'StopFailure' }).output, '');
  assert.equal(f.run({ active: true }).output, '', 'must not create an endless stop-hook loop');
});
test('the first-message reminder includes the asynchronous native tool instead of defaulting to CLI', (t) => {
  const f = fixture(t);
  const r = f.run({ state: 'busy', event: 'UserPromptSubmit', prompts: [] });
  assert.match(r.output, /request_user_input_async/);
});
