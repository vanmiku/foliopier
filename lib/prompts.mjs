// 终端里的提问汇总到 mydash：Claude Code / Codex 弹出选择题、计划确认、权限确认（命令审批）时，
// 钩子（bin/agent-ask.mjs）先把它交给 mydash，在网页上答完再把答案交回去；终端和 Claude App 都不再显示这道题。
// 网页上点「回终端答」、mydash 没开着、或者总开关关了（config.prompts.enabled = false），就照常在终端问。
// 也给别的工具用：mydash ask "问题" --option A --option B。
//   kind：question（选择题，可以一次几道、可以多选）· plan（计划确认）· permission（要不要允许执行）
//   status：pending 等你答 · answered 在 mydash 答了 · terminal 在终端答了 · released 回终端答 · cancelled 终端那边取消了 / 等的进程没了
// 存在 state/prompts.json（最多留 1000 条，等你答的不删）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, readConfig } from './store.mjs';
import { t } from './i18n.mjs';

const FILE = path.join(HOME, 'state', 'prompts.json');
const KEEP = 1000;
let cache = null;
let lastSavedAt = 0;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')).items || []; } catch { cache = []; }
  return cache;
}
function save() {
  const list = load();
  const pending = list.filter(p => p.status === 'pending');
  const rest = list.filter(p => p.status !== 'pending').slice(-KEEP);
  cache = [...rest, ...pending].sort((a, b) => a.at.localeCompare(b.at));
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ items: cache }, null, 1)); fs.renameSync(tmp, FILE); lastSavedAt = Date.now();
}

export const promptsEnabled = () => readConfig().prompts?.enabled !== false;
export const allPrompts = () => load();
export const getPrompt = id => load().find(p => p.id === id) || null;
export const pendingPrompts = () => load().filter(p => p.status === 'pending');

const str = (x, n) => String(x ?? '').slice(0, n);
// 只留认得的字段，长度都截一下（题目、计划、命令都可能很长）
function cleanPayload(kind, p = {}) {
  if (kind === 'question') {
    const qs = (Array.isArray(p.questions) ? p.questions : []).slice(0, 8).map(q => ({
      question: str(q.question, 2000), header: str(q.header, 60), multiSelect: Boolean(q.multiSelect),
      options: (Array.isArray(q.options) ? q.options : []).slice(0, 12).map(o => (typeof o === 'string' ? { label: str(o, 300), description: '' } : { label: str(o.label, 300), description: str(o.description, 600) })).filter(o => o.label),
    })).filter(q => q.question);
    return qs.length ? { questions: qs } : null;
  }
  if (kind === 'plan') return p.plan ? { plan: str(p.plan, 60_000) } : null;
  if (kind === 'permission') {
    return { toolName: str(p.toolName, 120) || 'tool', description: str(p.description, 2000), input: str(p.input, 8000), suggestions: Array.isArray(p.suggestions) ? p.suggestions.slice(0, 10) : [] };
  }
  return null;
}

// both：终端（或软件）里也同时在问，哪边先答算哪边（Claude Code 默认这样）；页面上就不放「交回」按钮
// appOnly：用户选择仅在原客户端作答，网页显示镜像和提醒。
export function createPrompt({ tool = 'cli', kind, project, session = '', cwd = '', payload, both = false, appOnly = false, native }) {
  const data = cleanPayload(kind, payload);
  if (!data) return null;
  const p = { id: 'p' + crypto.randomBytes(5).toString('hex'), tool: str(tool, 20), kind, project: str(project, 120), session: str(session, 100), cwd: str(cwd, 500), at: new Date().toISOString(), status: 'pending', polledAt: Date.now(), ...(both ? { both: true } : {}), ...(appOnly ? { appOnly: true } : {}), ...data };
  if (tool === 'codex' && kind === 'question' && both && !appOnly &&
      ['request_user_input', 'request_user_input_async'].includes(native?.tool) &&
      typeof native.callId === 'string' && native.callId.length > 0 && native.callId.length <= 200 && !/[\x00-\x1f]/.test(native.callId))
    p.native = { tool: native.tool, callId: native.callId };
  load().push(p); save();
  return p;
}

// 网页上的回答，按题型检查：
//   question：{ answers: { 题目原文: "选项" 或 ["选项", …]（多选）或 { other: "自己写的" } } }，每道题都要答
//   plan：{ approve: true } 或 { approve: false, feedback: "要改什么" }
//   permission：{ decision: allow | always | deny, message? }（always 只有给了 suggestions 时才行）
export function validatePromptAnswer(p, input) {
  if (!p) return { ok: false, code: 404, error: 'no such prompt' };
  if (p.status !== 'pending') return { ok: false, code: 409, error: 'already ' + p.status, status: p.status };
  let answer = null;
  if (p.kind === 'question') {
    const out = {};
    for (const q of p.questions) {
      let a = input?.answers?.[q.question];
      if (a && typeof a === 'object' && !Array.isArray(a)) a = String(a.other || '').trim();
      if (Array.isArray(a)) a = a.map(x => (x && typeof x === 'object' ? String(x.other || '').trim() : String(x))).filter(Boolean);
      if (Array.isArray(a) ? !a.length : !String(a || '').trim()) return { ok: false, code: 422, error: 'unanswered', question: q.question };
      out[q.question] = Array.isArray(a) ? (q.multiSelect ? a : a.slice(0, 1)).map(x => str(x, 2000)) : str(a, 2000);
    }
    answer = { answers: out };
  } else if (p.kind === 'plan') {
    answer = input?.approve ? { approve: true } : { approve: false, feedback: str(input?.feedback, 4000) };
  } else {
    const d = ['allow', 'always', 'deny'].includes(input?.decision) ? input.decision : null;
    if (!d || (d === 'always' && !p.suggestions?.length)) return { ok: false, code: 422, error: 'bad decision' };
    answer = { decision: d, ...(input?.message ? { message: str(input.message, 2000) } : {}) };
  }
  return { ok: true, answer };
}
export function setNativeDelivery(id, delivery) {
  const p = getPrompt(id); if (!p?.native) return null;
  if (delivery) p.nativeDelivery = delivery; else delete p.nativeDelivery;
  save(); return p;
}
export function answerPrompt(id, input, { by = 'web' } = {}) {
  const p = getPrompt(id), checked = validatePromptAnswer(p, input);
  if (!checked.ok) return checked;
  const answer = checked.answer;
  Object.assign(p, { status: 'answered', answer, by, answeredAt: new Date().toISOString() });
  save();
  return { ok: true, prompt: p };
}

export function setPromptStatus(id, status) {
  const p = getPrompt(id);
  if (!p || p.status !== 'pending') return p;
  Object.assign(p, { status, endedAt: new Date().toISOString() }); save();
  return p;
}
// 等答案的进程每次来问都记一下；太久没来（被终端取消、进程被杀）就算取消了
export function touchPrompt(id) {
  const p = getPrompt(id);
  if (p) {
    p.polledAt = Date.now();
    // The Stop hook reads this file in another process. Keep its heartbeat
    // fresh during long waits, without rewriting the store on every poll.
    if (p.polledAt - lastSavedAt >= 15_000) save();
  }
  return p;
}
export function reapPrompts(maxIdleMs = 45_000) {
  const gone = pendingPrompts().filter(p => Date.now() - (p.polledAt || 0) > maxIdleMs);
  for (const p of gone) Object.assign(p, { status: 'cancelled', endedAt: new Date().toISOString() });
  if (gone.length) save();
  return gone;
}

// 一句话标题：选择题的第一道题、计划的第一行、权限的工具和说明
export function promptTitle(p) {
  if (p.kind === 'question') return p.questions[0]?.question || '';
  if (p.kind === 'plan') return (p.plan.split('\n').find(l => l.trim()) || '').replace(/^#+\s*/, '').slice(0, 120);
  return `${p.toolName}${p.description ? ': ' + p.description : p.input ? ': ' + p.input.slice(0, 100) : ''}`;
}

// Keep a bounded diagnostic code, never raw native errors or conversation text.
export function nativeFailureReason(reason) {
  return ['question_partial', 'question_not_ready', 'question_project_mismatch', 'question_owner_changed',
    'app_mismatch', 'app_closed', 'app_not_open', 'app_incompatible', 'app_history_limit', 'app_unavailable'].includes(reason)
    ? reason : 'question_unavailable';
}
export function nativeFailureMessage(reason) {
  if (reason === 'question_partial') return t('Some questions were answered in Codex. Finish the remaining questions there.');
  if (reason === 'app_mismatch' || reason === 'question_project_mismatch') return t('The Codex project does not match this question. Nothing was sent; reconnect the original session.');
  if (reason === 'question_not_ready') return t('The original question is not in the loaded Codex history. Reconnect the original session; your choice is kept.');
  if (reason === 'app_closed' || reason === 'app_not_open') return t('Codex is closed or the original session is not loaded. Open it on the hosting computer, then reconnect.');
  if (reason === 'question_owner_changed') return t('The Codex connection changed. Reconnect the original session; your choice is kept.');
  if (reason === 'app_incompatible') return t('This Codex App version cannot accept this answer. Continue in Codex; your choice is kept.');
  if (reason === 'app_history_limit') return t('The Codex session history exceeds the connection limit. Continue in the original Codex session.');
  return t('The native Codex question is not connected yet. Your choice is kept; retry or answer in Codex.');
}
export function setNativeFailure(id, reason) {
  const p = getPrompt(id); if (!p?.native) return null;
  if (reason) p.nativeFailure = { reason: nativeFailureReason(reason), at: Date.now() };
  else delete p.nativeFailure;
  save(); return p;
}
