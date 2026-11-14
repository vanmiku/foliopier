import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-choice-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  return (message, { agent = 'claude', active = false, config = {}, form = false,
    event = 'Stop', entrypoint = 'cli' } = {}) => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(home, 'state/open-items.json'), JSON.stringify(form ? {
      'project/approval': { session: 'choice-session', kind: 'approval', state: 'pending' },
    } : {}));
    const r = spawnSync(process.execPath, ['bin/agent-state.mjs', event === 'UserPromptSubmit' ? 'busy' : 'idle', agent], {
      env: { ...process.env, MYDASH_HOME: home, MYDASH_LANG: 'en', CLAUDE_CODE_ENTRYPOINT: entrypoint },
      input: JSON.stringify({ session_id: 'choice-session', hook_event_name: event,
        stop_hook_active: active, last_assistant_message: message }), encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    let output = null;
    if (r.stdout) { try { output = JSON.parse(r.stdout); } catch { output = r.stdout; } }
    return { output,
      state: fs.existsSync(path.join(home, 'state/agents/choice-session.json'))
        ? JSON.parse(fs.readFileSync(path.join(home, 'state/agents/choice-session.json'))).state : null };
  };
}

test('Claude asks for a native choice when its final reply defers a decision without a question mark', (t) => {
  const run = fixture(t);
  for (const message of [
    '下一步建议：先把这批数据重新跑一遍。你说做我再做，不说我就停在这里。',
    '我建议先修这个错误。要修的话你说一声；另外四户得你在页面上框一次。',
    '代码已在本地验证。要继续就告诉我。',
    '改动已准备好，等你确认后我再推送。',
    '测试通过。请选择现在发布或先保留分支。',
    'The change is ready. Let me know if you want me to deploy it.',
    'Tests passed. Please confirm whether I should continue.',
  ]) {
    const r = run(message);
    assert.ok(r.output, message);
    assert.match(r.output.hookSpecificOutput?.additionalContext || r.output.reason, /AskUserQuestion/, message);
    assert.equal(r.state, 'busy', message);
  }
});

test('decision detection ignores code, quotes, links and ordinary completed work', (t) => {
  const run = fixture(t);
  for (const message of [
    '本地测试已通过，分支已保留。',
    '用户已经确认后再推送的流程，配置已保存。',
    '需要你在页面上框出住户，才能测量另外四户。',
    '审批表的说明是：\n> 要继续就告诉我。\n\n说明已保存。',
    '说明已更新。示例：`要继续就告诉我`。\n```text\n你说做我再做。\n```',
    'See [Let me know if you want me to continue](https://example.com/a?b=1).',
    'The model now waits for confirmation before deploying. All checks passed.',
    '查到原因了：Claude 只写“你说做我再做”，没有调用选择题；旧检查只认问号，所以漏掉了。',
    '已修复「要修的话你说一声」这类提问的漏检。',
    'The example was "Let me know if you want me to continue". The guard is now fixed.',
  ]) {
    assert.equal(run(message).output, null, message);
  }
});

test('question safeguards retain opt-outs, pending forms, batch runs and the one-retry limit', (t) => {
  const run = fixture(t), message = '要修的话你说一声。';
  for (const options of [
    { active: true }, { form: true }, { config: { prompts: { enabled: false } } },
    { config: { prompts: { chat: false } } }, { event: 'StopFailure' }, { entrypoint: 'sdk-ts' },
  ]) assert.equal(run(message, options).output, null, JSON.stringify(options));
  assert.ok(run('要不要现在发布？').output, 'existing questions still trigger the guard');
});

test('Codex does not turn ordinary reply checks into visible continuation prompts', (t) => {
  const run = fixture(t);
  for (const message of ['要不要现在发布？', '要修的话你说一声。',
    '已修复“你说做我再做”的提问漏检，测试通过。']) {
    const r = run(message, { agent: 'codex' });
    assert.equal(r.output, null, message);
    assert.equal(r.state, 'idle', message);
  }
});

test('Codex receives choice reminders as private context on each user turn', (t) => {
  const run = fixture(t);
  for (let i = 0; i < 2; i++) {
    const r = run('', { agent: 'codex', event: 'UserPromptSubmit' });
    assert.equal(r.output?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    assert.match(r.output.hookSpecificOutput.additionalContext, /request_user_input_async/);
    assert.equal(r.output.decision, undefined);
    assert.equal(r.output.reason, undefined);
    assert.equal(r.output.systemMessage, undefined);
  }
  for (const config of [{ prompts: { chat: false } }, { prompts: { enabled: false } }]) {
    assert.equal(run('', { agent: 'codex', event: 'UserPromptSubmit', config }).output, null);
  }
});
