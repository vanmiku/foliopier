// Responses only to existing, exactly matched native questions. Never approvals,
// model settings, a new conversation, or an unbound user message.
import crypto from 'node:crypto';
import { codexApp } from './codex-app.mjs';
import { SessionDiscovery, canonicalProject } from './session-discovery.mjs';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail = (reason, uncertain = false) => Object.assign(Error(reason), { reason, uncertain });
const same = (a, b) => Boolean(canonicalProject(a)) && canonicalProject(a) === canonicalProject(b);
const labels = (q) =>
  (Array.isArray(q?.options) ? q.options : []).map((x) => (typeof x === 'string' ? x : x?.label));
const questionText = (q) => q.question || q.title || '';
function matches(native, questions) {
  return (
    Array.isArray(native) &&
    native.length === questions.length &&
    native.every(
      (q, i) =>
        q &&
        !q.isSecret &&
        questionText(q) === questions[i].question &&
        JSON.stringify(labels(q)) === JSON.stringify(labels(questions[i]))
    )
  );
}
function items(state) {
  const source = state.turnHistory?.history?.entitiesByKey;
  const turns = (source ? Object.values(source) : state.turns || [])
    .slice()
    .sort((a, b) => (a.turnStartedAtMs || 0) - (b.turnStartedAtMs || 0));
  return turns.flatMap((t) => t.items || []);
}
function replies(state) {
  const result = new Map();
  for (const item of items(state)) {
    if (
      item.type !== 'userMessage' &&
      !(item.type === 'steeringUserMessage' && (!item.status || item.status === 'accepted'))
    )
      continue;
    const parts = item.content || item.input || [],
      text = parts
        .filter((x) => x.type === 'text')
        .map((x) => x.text || '')
        .join('\n')
        .trim();
    const match =
      /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      for (const r of Array.isArray(parsed) ? parsed : [parsed])
        if (
          typeof r.questionItemId === 'string' &&
          typeof r.answer === 'string' &&
          !result.has(r.questionItemId)
        )
          result.set(r.questionItemId, r);
    } catch {}
  }
  return result;
}
export function nativeQuestion(state, binding, questions) {
  if (!state || !binding?.callId || !Array.isArray(questions) || !questions.length) return null;
  if (binding.tool === 'request_user_input') {
    const r = (state.requests || []).find(
      (r) => r.method === 'item/tool/requestUserInput' && r.params?.itemId === binding.callId
    );
    if (!r || !matches(r.params.questions || [], questions)) return null;
    return { kind: 'sync', requestId: r.id, questions: r.params.questions };
  }
  if (binding.tool !== 'request_user_input_async') return null;
  const item = items(state).find(
    (x) => x.type === 'agentMessage' && x.id === binding.callId && matches(x.questions || [], questions)
  );
  if (!item) return null;
  const ids = questions.map((_, i) => JSON.stringify(['request_user_input_async', binding.callId, i]));
  const answered = replies(state),
    existing = ids.map((id) => answered.get(id));
  if (existing.some(Boolean))
    return {
      kind: 'async',
      ids,
      resolved: existing.every(Boolean),
      partial: !existing.every(Boolean),
      replies: existing,
    };
  return { kind: 'async', ids, questions: item.questions };
}
function equalAnswers(a, b) {
  const norm = (x) => (Array.isArray(x) ? x : x?.answers || [x]);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
export class CodexQuestions {
  constructor({ bridge = codexApp, resolve, receiptMs = 2000 } = {}) {
    this.bridge = bridge;
    const discovery = new SessionDiscovery();
    this.resolve = resolve || ((id) => discovery.get(id));
    this.receiptMs = receiptMs;
  }
  state(id, cwd) {
    const view = this.bridge.peek(id, cwd),
      state = this.bridge.snapshots.get(id)?.state;
    return view.connected && state?.id === id && same(state.cwd, cwd) ? state : null;
  }
  async question(p, { refresh = false } = {}) {
    if (
      p.tool !== 'codex' ||
      p.kind !== 'question' ||
      !UUID.test(p.session || '') ||
      !['request_user_input', 'request_user_input_async'].includes(p.native?.tool)
    )
      throw fail('question_unavailable');
    const record = this.resolve(p.session);
    if (!record || !same(record.cwd, p.cwd)) throw fail('question_project_mismatch');
    const view = refresh
      ? await this.bridge.refresh(p.session, record.cwd)
      : await this.bridge.observe(p.session, record.cwd);
    if (!view.connected) throw fail(view.reason || 'question_unavailable');
    let q = nativeQuestion(this.state(p.session, record.cwd), p.native, p.questions);
    if (q?.resolved) return { q, record, view };
    if (q?.partial) throw fail('question_partial');
    if (!q) throw fail('question_not_ready');
    const owner = await this.bridge.request(
      'thread-owner-discovery',
      { hostId: 'local', conversationId: p.session },
      1,
      view.owner
    );
    if (
      owner.handledByClientId !== view.owner ||
      owner.result?.supportsUntrustedAppInput !== true ||
      !this.bridge.secure()
    )
      throw fail('question_owner_changed');
    q = nativeQuestion(this.state(p.session, record.cwd), p.native, p.questions);
    if (q?.resolved) return { q, record, view };
    if (q?.partial) throw fail('question_partial');
    if (!q) throw fail('question_not_ready');
    return { q, record, view };
  }
  async check(p, { refresh = false } = {}) {
    const { q } = await this.question(p, { refresh });
    return { state: q.resolved ? 'answered' : 'ready' };
  }
  async answer(p, { answers }, { clientId = crypto.randomUUID(), authorize = () => true } = {}) {
    if (!UUID.test(clientId)) throw fail('question_unavailable');
    const { q, record, view } = await this.question(p);
    if (q.resolved) return { source: 'native' };
    if (!authorize()) throw fail('question_not_ready');
    const strings = p.questions.map((x) => {
      const a = answers?.[x.question];
      if (typeof a !== 'string' && !Array.isArray(a)) throw fail('question_invalid_answer');
      const v = Array.isArray(a) ? a.join('\n') : a;
      if (!v.trim() || v.length > 2000) throw fail('question_invalid_answer');
      return v;
    });
    let method, params;
    if (q.kind === 'sync') {
      method = 'thread-follower-submit-user-input';
      params = {
        conversationId: p.session,
        requestId: q.requestId,
        response: {
          answers: Object.fromEntries(q.questions.map((x, i) => [x.id, { answers: [strings[i]] }])),
        },
      };
    } else {
      const response = p.questions.map((x, i) => ({
        questionItemId: q.ids[i],
        question: x.question,
        answer: strings[i],
      }));
      const text =
        '<send_user_message_question_reply>\n' +
        JSON.stringify(response) +
        '\n</send_user_message_question_reply>';
      if (text.length > 12000) throw fail('question_too_long');
      const input = [{ type: 'text', text, text_elements: [] }];
      if (this.bridge.peek(p.session, record.cwd).state === 'busy') {
        method = 'thread-follower-steer-turn';
        // The desktop's steer handler dereferences this draft before dispatch.
        // Mirror the native question composer's restore data; inherit the
        // original thread's model, collaboration mode and permissions.
        const restoreMessage = {
          id: clientId,
          text,
          cwd: record.cwd,
          createdAt: Date.now(),
          context: {
            prompt: text,
            turnTrigger: 'send_user_message_async_question',
            addedFiles: [],
            fileAttachments: [],
            ideContext: null,
            imageAttachments: [],
          },
        };
        params = { conversationId: p.session, input, clientUserMessageId: clientId, restoreMessage };
      } else {
        method = 'thread-follower-start-turn';
        params = {
          conversationId: p.session,
          turnStart: {
            request: { threadId: p.session, input, clientUserMessageId: clientId },
            context: { inheritThreadSettings: true },
          },
        };
      }
    }
    const r = await this.bridge.request(method, params, 2, view.owner, true);
    if (r.handledByClientId !== view.owner) throw fail('question_owner_changed', true);
    try {
      const until = Date.now() + this.receiptMs;
      do {
        const state = this.state(p.session, record.cwd);
        if (!state) throw fail('question_receipt_unconfirmed', true);
        if (q.kind === 'async') {
          const receipt = nativeQuestion(state, p.native, p.questions);
          if (receipt?.resolved)
            return { source: receipt.replies.every((x, i) => x.answer === strings[i]) ? 'web' : 'native' };
        } else {
          const receipt = items(state).find(
            (x) => x.type === 'userInputResponse' && String(x.requestId) === String(q.requestId)
          );
          if (receipt)
            return {
              source: q.questions.every((x, i) => equalAnswers(receipt.answers?.[x.id], [strings[i]]))
                ? 'web'
                : 'native',
            };
        }
        await new Promise((r) => setTimeout(r, 20));
      } while (Date.now() < until);
      throw fail('question_receipt_unconfirmed', true);
    } catch (e) {
      e.uncertain = true;
      throw e;
    }
  }
}
