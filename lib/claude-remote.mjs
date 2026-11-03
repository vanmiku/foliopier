// Claude Desktop Code opts into Remote Control. This adapter joins that same
// session as a controller; it never starts a second CLI or changes permissions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requestClaudeAccess, authBrokerDir } from './claude-auth.mjs';
const REMOTE = /^(?:session|cse)_[A-Za-z0-9]{8,120}$/;
const alias = (id) => String(id).replace(/^cse_/, 'session_');
function visibleEvent(e) {
  const p = e.payload;
  if (!p || !['user', 'assistant', 'result', 'system'].includes(p.type)) return null;
  const content = p.message?.content;
  const body =
    typeof content === 'string'
      ? content.slice(0, 24000)
      : (Array.isArray(content) ? content : []).flatMap((b) =>
          b.type === 'text'
            ? [{ type: 'text', text: String(b.text || '').slice(0, 24000) }]
            : b.type === 'tool_use'
              ? [{ type: 'tool_use', name: String(b.name || 'Tool').slice(0, 60) }]
              : []
        );
  return {
    sequence_num: e.sequence_num,
    source: e.source,
    created_at: e.created_at,
    payload: {
      type: p.type,
      uuid: p.uuid,
      parentUuid: p.parentUuid,
      isMeta: p.isMeta,
      timestamp: p.timestamp,
      subtype: p.subtype,
      is_error: p.is_error,
      ...(p.message ? { message: { id: p.message.id, content: body } } : {}),
    },
  };
}
let login,
  nextLogin = 0;
export function readNativeClaudeCredentials() {
  if (Date.now() < nextLogin) return login;
  nextLogin = Date.now() + 30000;
  login = null;
  const home = process.env.MYDASH_CLAUDE_HOME || path.join(os.homedir(), '.claude');
  try {
    const file = path.join(home, '.credentials.json'),
      stat = fs.lstatSync(file);
    if (
      stat.isFile() &&
      stat.size < 65536 &&
      (process.platform === 'win32' || (stat.mode & 0o077) === 0) &&
      (!process.getuid || stat.uid === process.getuid())
    )
      login = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
  } catch {}
  if (
    !login &&
    process.platform === 'darwin' &&
    !process.env.MYDASH_CLAUDE_HOME &&
    !process.env.MYDASH_CLAUDE_PROJECTS
  )
    try {
      login = JSON.parse(
        execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      ).claudeAiOauth;
    } catch {}
  return login;
}
async function credentials() {
  const local = readNativeClaudeCredentials();
  if (local?.accessToken) return local;
  if (process.platform !== 'darwin' || process.env.MYDASH_CLAUDE_HOME || process.env.MYDASH_CLAUDE_PROJECTS)
    return null;
  return requestClaudeAccess(authBrokerDir(process.env.MYDASH_HOME || path.join(os.homedir(), '.mydash')));
}
export class ClaudeRemoteBridge {
  constructor({ credentials: readCredentials = credentials, fetchImpl = (...args) => fetch(...args) } = {}) {
    this.credentials = readCredentials;
    this.fetchImpl = fetchImpl;
    this.views = new Map();
    this.pending = new Map();
  }
  peek(id, binding) {
    const v = this.views.get(id);
    return v && v.remoteId === binding?.remoteId && v.cwd === binding.cwd && Date.now() - v.at < 30000
      ? v
      : { connected: false, reason: binding?.remoteId ? 'claude_connecting' : 'claude_remote_off' };
  }
  async request(remoteId, suffix = '', body) {
    if (!REMOTE.test(remoteId)) throw Object.assign(Error('binding'), { reason: 'claude_remote_off' });
    const token = (await this.credentials())?.accessToken;
    if (!token) throw Object.assign(Error('login'), { reason: 'claude_login' });
    const r = await this.fetchImpl('https://api.anthropic.com/v1/code/sessions/' + remoteId + suffix, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: 'Bearer ' + token,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'ccr-byoc-2025-07-29',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (r.status === 401) {
      nextLogin = 0;
      login = null;
    }
    if (!r.ok)
      throw Object.assign(Error('remote-response'), {
        reason:
          r.status === 401
            ? 'claude_login'
            : r.status === 403
              ? 'claude_forbidden'
              : r.status === 404
                ? 'claude_remote_off'
                : 'claude_unavailable',
        status: r.status,
      });
    const chunks = [],
      reader = r.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024) {
          await reader.cancel();
          throw Error('response-too-large');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return JSON.parse(text);
  }
  async observe(id, binding, force = false) {
    if (!binding?.remoteId || !REMOTE.test(binding.remoteId))
      return { connected: false, reason: 'claude_remote_off' };
    const prior = this.peek(id, binding);
    if (!force && prior.at && Date.now() - prior.at < 2500) return prior;
    if (this.pending.has(id)) return this.pending.get(id);
    const work = (async () => {
      let view;
      try {
        const data = await this.request(binding.remoteId),
          s = data.response_shape;
        if (!s || alias(s.id) !== alias(binding.remoteId)) throw Error('identity');
        if (s.security_tier && s.security_tier !== 'standard')
          throw Object.assign(Error('trusted-device-required'), { reason: 'claude_trusted' });
        const online = s.connection_status === 'connected' && s.status === 'active';
        const samePrior = this.views.get(id)?.remoteId === binding.remoteId ? this.views.get(id) : null;
        const since = Math.min(
          binding.sinceSequence || Infinity,
          samePrior?.events?.at(-1)?.sequence_num || Infinity
        );
        let cursor,
          raw = [];
        for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
          const page = await this.request(
            binding.remoteId,
            '/events?limit=100&sort_order=desc' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
          );
          if (!Array.isArray(page.data)) throw Error('events');
          const rows = page.data.filter(
            (e) => Number.isSafeInteger(e.sequence_num) && e.payload && typeof e.payload === 'object'
          );
          raw.push(...rows);
          if (
            !rows.length ||
            since === Infinity ||
            Math.min(...rows.map((e) => e.sequence_num)) <= since ||
            !page.next_cursor ||
            page.next_cursor === cursor
          )
            break;
          cursor = page.next_cursor;
        }
        const merged = new Map((samePrior?.events || []).map((e) => [e.sequence_num, e]));
        for (const e of raw) {
          const visible = visibleEvent(e);
          if (visible) merged.set(e.sequence_num, visible);
        }
        const events = [...merged.values()].sort((a, b) => a.sequence_num - b.sequence_num).slice(-2000);
        view = {
          connected: online,
          ...(!online ? { reason: 'claude_offline' } : {}),
          state:
            s.worker_status === 'working' || s.worker_status === 'busy'
              ? 'busy'
              : s.status_bucket === 'requires_action'
                ? 'needs_input'
                : 'idle',
          events,
        };
      } catch (e) {
        view = { connected: false, reason: e.reason || 'claude_unavailable' };
      }
      view = { ...view, at: Date.now(), remoteId: binding.remoteId, cwd: binding.cwd };
      this.views.delete(id);
      this.views.set(id, view);
      while (this.views.size > 20) this.views.delete(this.views.keys().next().value);
      return view;
    })();
    this.pending.set(id, work);
    try {
      return await work;
    } finally {
      this.pending.delete(id);
    }
  }
  async start(id, binding, { text, clientId, authorize }) {
    if (!authorize()) throw Object.assign(Error('authorization'), { beforeSend: true });
    const view = await this.observe(id, binding, true);
    if (!view.connected || !authorize())
      throw Object.assign(Error('unavailable'), { reason: view.reason, beforeSend: true });
    const payload = {
      type: 'user',
      uuid: clientId,
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: text },
    };
    let result;
    try {
      result = await this.request(binding.remoteId, '/events', { events: [{ payload }] });
    } catch (e) {
      if (!e.status || e.status >= 500) e.uncertain = true;
      throw e;
    }
    const sequence = result.results?.[0]?.sequence_num;
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw Object.assign(Error('unconfirmed'), { uncertain: true });
    this.views.delete(id);
    return { sequence };
  }
}
export function remoteDeliveryState(events, delivery) {
  const sorted = [...events].sort((a, b) => a.sequence_num - b.sequence_num);
  const index = sorted.findIndex(
    (e) => e.source === 'worker' && e.payload?.type === 'user' && e.payload.uuid === delivery.clientId
  );
  if (index < 0) return Date.now() - delivery.createdAt > 120000 ? 'uncertain' : 'waiting_receipt';
  let state = 'waiting_receipt';
  for (const e of sorted.slice(index + 1)) {
    const p = e.payload;
    if (e.source !== 'worker') continue;
    if (
      p?.type === 'user' &&
      p.uuid !== delivery.clientId &&
      !p.isMeta &&
      (typeof p.message?.content === 'string' || p.message?.content?.some?.((b) => b.type === 'text'))
    )
      return 'interrupted';
    if (p.type === 'assistant') state = 'working';
    if (p.type === 'result')
      return p.is_error || (p.subtype && p.subtype !== 'success') ? 'failed' : 'completed';
  }
  return state;
}
export const claudeRemote = new ClaudeRemoteBridge();
