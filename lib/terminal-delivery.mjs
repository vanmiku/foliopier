// Never infer completion from an idle terminal or a progress message alone.
export function terminalDeliveryState(records, delivery, agent = 'claude') {
  if (agent === 'codex') return codexTerminalState(records, delivery);
  const text = (content) =>
    typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content : [])
          .filter((x) => x.type === 'text')
          .map((x) => x.text || '')
          .join('\n');
  const matches = records
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        r.type === 'user' &&
        (!r.isMeta || r.uuid === delivery.clientId) &&
        Date.parse(r.timestamp) >= delivery.createdAt - 1000 &&
        (delivery.clientId ? r.uuid === delivery.clientId : text(r.message?.content) === delivery.text)
    );
  if (!matches.length) return Date.now() - delivery.createdAt > 120000 ? 'uncertain' : 'waiting_receipt';
  if (matches.length !== 1) return 'uncertain';
  const { r: user, i } = matches[0],
    chain = new Set([user.uuid]);
  let error = false,
    answer = false;
  for (const r of records.slice(i + 1)) {
    if (r.type === 'user' && !r.isMeta && text(r.message?.content).trim()) return 'interrupted';
    if (!chain.has(r.parentUuid)) continue;
    if (r.uuid) chain.add(r.uuid);
    if (r.type === 'assistant') {
      error ||= Boolean(r.isApiErrorMessage);
      answer ||= Boolean(text(r.message?.content).trim());
    }
    if (r.type === 'system' && r.subtype === 'turn_duration')
      return error ? 'failed' : answer ? 'completed' : 'interrupted';
  }
  return 'working';
}

function codexTerminalState(records, delivery) {
  const matches = records.flatMap((r, i) =>
    r.type === 'event_msg' &&
    r.payload?.type === 'user_message' &&
    r.payload.message === delivery.text &&
    Date.parse(r.timestamp) >= delivery.createdAt - 1000
      ? [i]
      : []
  );
  if (!matches.length) return Date.now() - delivery.createdAt > 120000 ? 'uncertain' : 'waiting_receipt';
  if (matches.length !== 1) return 'uncertain';
  const start = matches[0];
  const task = records
    .slice(0, start + 1)
    .findLast((r) => r.type === 'event_msg' && r.payload?.type === 'task_started')?.payload.turn_id;
  for (const r of records.slice(start + 1)) {
    if (r.type !== 'event_msg') continue;
    const p = r.payload || {};
    if (p.type === 'user_message') return 'interrupted';
    if (task && p.turn_id !== task && p.root_turn_id !== task) continue;
    if (p.type === 'turn_aborted') return 'interrupted';
    if (p.type === 'task_complete') return p.error ? 'failed' : 'completed';
  }
  return 'working';
}
