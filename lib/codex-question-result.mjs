import fs from 'node:fs';

export function cliQuestionResult(text, callId, turnId) {
  let cancelled = false;
  for (const line of text.split('\n')) {
    if (!line.includes(callId) && !line.includes(turnId)) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch { continue; }
    const p = row?.payload;
    if (row?.type === 'response_item' && p?.type === 'function_call_output' && p.call_id === callId) {
      const output = Array.isArray(p.output) ? p.output.find(x => x.type === 'input_text')?.text : p.output;
      try {
        const answers = JSON.parse(output)?.answers;
        if (answers && typeof answers === 'object') return { answers };
      } catch {}
      return { cancelled: true };
    }
    if (row?.type === 'event_msg' && p?.turn_id === turnId && ['task_complete', 'turn_aborted'].includes(p.type))
      cancelled = true;
  }
  return cancelled ? { cancelled: true } : null;
}

export function readCliQuestionResult(file, callId, turnId) {
  if (!file) return null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, length = Math.min(size, 2 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, size - length);
      return cliQuestionResult(buffer.toString('utf8', 0, read), callId, turnId);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
