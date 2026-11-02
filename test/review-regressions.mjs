// Review regressions, plain Node and temporary storage: node --test test/review-regressions.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-review-unit-'));
process.env.MYDASH_HOME = home;
process.env.MYDASH_LANG = 'en';
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { markdownHtml } = await import('../lib/render.mjs');
const { questionsOf, validateAnswers } = await import('../lib/approval.mjs');
const { renderDiff } = await import('../lib/diff.mjs');
const { addApproval, readResponses } = await import('../lib/responses.mjs');

const block = questions => '```approval\n' + JSON.stringify({ questions }) + '\n```';
test('approval blocks render the same unique question IDs used to validate answers', () => {
  const md = block([{ type: 'choice', label: 'Publish?', options: ['Yes', 'No'], required: true }]) + '\n\n' +
    block([{ type: 'choice', label: 'Keep the old version?', options: ['Keep', 'Remove'], required: true }]);
  const ids = [...markdownHtml(md).matchAll(/data-q="([^"]+)"/g)].map(m => m[1]);
  const questions = questionsOf(md);
  assert.deepEqual(ids, questions.map(q => q.id));
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(validateAnswers(questions, { [ids[0]]: 'Yes', [ids[1]]: 'Keep' }).answers,
    { [questions[0].id]: 'Yes', [questions[1].id]: 'Keep' });
});

test('explicit duplicate approval IDs also work in nested list blocks', () => {
  const a = block([{ id: 'same', type: 'text', label: 'First' }]);
  const b = block([{ id: 'same', type: 'line', label: 'Second' }]).split('\n').map(x => '  ' + x).join('\n');
  const md = a + '\n\n- Nested question\n\n' + b;
  assert.deepEqual([...markdownHtml(md).matchAll(/data-q="([^"]+)"/g)].map(m => m[1]), questionsOf(md).map(q => q.id));
});

test('extensive differences fall back within a bounded computation budget', () => {
  const a = Array.from({ length: 2500 }, (_, i) => `before_${i}`).join('\n');
  const b = Array.from({ length: 2500 }, (_, i) => `after_${i}`).join('\n');
  const result = renderDiff(a, b, { fromV: 1, toV: 2 });
  assert.equal(result.limited, true, 'entirely rewritten documents must not keep an unbounded trace');
  assert.match(result.html, /compare/i);
});

test('a small change in a long document still has an exact diff', () => {
  const a = Array.from({ length: 12000 }, (_, i) => `line_${i}`);
  const b = [...a]; b[6000] = 'the changed line';
  const result = renderDiff(a.join('\n'), b.join('\n'), { fromV: 1, toV: 2 });
  assert.notEqual(result.limited, true);
  assert.equal(result.added, 1); assert.equal(result.removed, 1);
});

test('concurrent retries save one approval, and a deliberate edit saves a new answer', async () => {
  const payload = { v: 1, answers: { go: 'Yes' }, from: 'test', requestId: 'same-confirmation-1' };
  const [a, b] = await Promise.all([addApproval('test', 'approval', payload), addApproval('test', 'approval', payload)]);
  assert.equal(a.id, b.id);
  assert.equal(readResponses('test', 'approval').approvals.length, 1);
  const edit = await addApproval('test', 'approval', { ...payload, answers: { go: 'No' }, requestId: 'deliberate-edit-2' });
  assert.notEqual(edit.id, a.id);
  assert.equal(readResponses('test', 'approval').approvals.length, 2);
});
