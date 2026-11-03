import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalDeliveryState } from '../lib/terminal-delivery.mjs';
const row = (type, uuid, parentUuid, extra = {}) => ({
  type,
  uuid,
  parentUuid,
  timestamp: new Date().toISOString(),
  ...extra,
});
const d = { text: 'literal message', createdAt: Date.now() - 1000 };
const user = row('user', 'u1', null, { message: { content: d.text } });
test('terminal reply completion requires the matching message and its turn boundary', () => {
  assert.equal(terminalDeliveryState([], d), 'waiting_receipt');
  const progress = row('assistant', 'a1', 'u1', {
    message: { content: [{ type: 'text', text: 'Working' }], stop_reason: 'tool_use' },
  });
  assert.equal(terminalDeliveryState([user, progress], d), 'working');
  const final = row('assistant', 'a2', 'a1', {
    message: { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' },
  });
  assert.equal(terminalDeliveryState([user, progress, final], d), 'working');
  assert.equal(
    terminalDeliveryState(
      [user, progress, final, row('system', 's1', 'a2', { subtype: 'turn_duration' })],
      d
    ),
    'completed'
  );
  assert.equal(
    terminalDeliveryState(
      [user, row('user', 'u2', 'u1', { message: { content: 'Another user prompt' } })],
      d
    ),
    'interrupted'
  );
  assert.equal(terminalDeliveryState([user, user], d), 'uncertain');
});
test('terminal tracking rejects old messages and distinguishes provider errors and missing receipts', () => {
  assert.equal(
    terminalDeliveryState([{ ...user, timestamp: new Date(0).toISOString() }], d),
    'waiting_receipt'
  );
  assert.equal(terminalDeliveryState([], { ...d, createdAt: Date.now() - 180000 }), 'uncertain');
  const err = row('assistant', 'a1', 'u1', { isApiErrorMessage: true, message: { content: 'Rate limited' } });
  assert.equal(
    terminalDeliveryState([user, err, row('system', 's', 'a1', { subtype: 'turn_duration' })], d),
    'failed'
  );
});

test('Codex terminal receipts use the matching task boundary, never an unrelated completion', () => {
  const event = (type, rest = {}) => ({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type, ...rest },
  });
  const rows = [
    event('task_started', { turn_id: 'turn-a' }),
    event('user_message', { message: d.text }),
    event('agent_message', { message: 'Progress' }),
  ];
  assert.equal(terminalDeliveryState(rows, d, 'codex'), 'working');
  assert.equal(
    terminalDeliveryState([...rows, event('task_complete', { turn_id: 'other' })], d, 'codex'),
    'working'
  );
  assert.equal(
    terminalDeliveryState([...rows, event('task_complete', { turn_id: 'turn-a' })], d, 'codex'),
    'completed'
  );
  assert.equal(
    terminalDeliveryState(
      [...rows, event('task_complete', { turn_id: 'retry-a', root_turn_id: 'turn-a' })],
      d,
      'codex'
    ),
    'completed'
  );
  assert.equal(
    terminalDeliveryState([...rows, event('turn_aborted', { turn_id: 'turn-a' })], d, 'codex'),
    'interrupted'
  );
  assert.equal(
    terminalDeliveryState(
      [
        ...rows,
        event('user_message', { message: 'Another question' }),
        event('task_complete', { turn_id: 'turn-a' }),
      ],
      d,
      'codex'
    ),
    'interrupted'
  );
});
