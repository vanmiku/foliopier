// Connect only to the user's existing shared Codex daemon. Never start an executor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { canonicalProject } from './session-discovery.mjs';
import { appView } from './codex-app.mjs';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const same = (a, b) => {
  const root = canonicalProject(a);
  return Boolean(root) && root === canonicalProject(b);
};
const error = (reason, uncertain = false) => Object.assign(Error(reason), { reason, uncertain });
export class CodexDaemonBridge extends EventEmitter {
  constructor({
    codexHome = process.env.MYDASH_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    timeoutMs = 5000,
  } = {}) {
    super();
    Object.assign(this, { codexHome, timeoutMs });
    this.socketPath = path.join(codexHome, 'app-server-control/app-server-control.sock');
    this.pending = new Map();
    this.views = new Map();
    this.observing = new Map();
    this.approvals = new Map();
    this.ws = null;
    this.connecting = null;
  }
  secure() {
    try {
      const uid = process.getuid?.(),
        dir = fs.lstatSync(path.dirname(this.socketPath)),
        entry = fs.lstatSync(this.socketPath);
      // Codex 0.166 publishes an owned symlink from its private control directory
      // to a 0600 socket in a separate 0700 daemon directory. Validate both ends.
      const target = fs.realpathSync(this.socketPath),
        parent = fs.lstatSync(path.dirname(target)),
        socket = fs.lstatSync(target);
      return (
        uid != null &&
        dir.isDirectory() &&
        dir.uid === uid &&
        !(dir.mode & 0o077) &&
        (entry.isSocket() || entry.isSymbolicLink()) &&
        entry.uid === uid &&
        parent.isDirectory() &&
        parent.uid === uid &&
        !(parent.mode & 0o077) &&
        socket.isSocket() &&
        socket.uid === uid &&
        !(socket.mode & 0o077)
      );
    } catch {
      return false;
    }
  }
  close(reason = 'daemon_unavailable') {
    const ws = this.ws;
    this.ws = null;
    ws?.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error(reason, p.mutation));
    }
    this.pending.clear();
    this.views.clear();
    this.approvals.clear();
  }
  async connect() {
    if (!this.secure()) throw error('daemon_unavailable');
    if (this.connecting) return this.connecting;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.connecting = (async () => {
      const ws = new WebSocket('ws://localhost/', {
        createConnection: () => net.createConnection(this.socketPath),
        perMessageDeflate: false,
        maxPayload: 64 * 1024 * 1024,
        handshakeTimeout: this.timeoutMs,
        followRedirects: false,
      });
      this.ws = ws;
      ws.on('error', () => {});
      ws.on('close', () => {
        if (this.ws === ws) this.close();
      });
      ws.on('message', (data, binary) => {
        try {
          if (binary) throw error('app_incompatible');
          const m = JSON.parse(data.toString());
          if (Object.hasOwn(m, 'id') && !m.method) {
            const p = this.pending.get(m.id);
            if (!p) return;
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            if (m.error)
              p.reject(
                error(
                  [-32600, -32601, -32602].includes(m.error.code) ? 'app_incompatible' : 'daemon_unavailable',
                  p.mutation && ![-32600, -32601, -32602].includes(m.error.code)
                )
              );
            else p.resolve(m.result);
          } else {
            const id = m.params?.threadId;
            if (typeof id !== 'string') return;
            if (m.method?.endsWith('/requestApproval') || m.method === 'item/tool/requestUserInput')
              this.approvals.set(m.id, id);
            if (m.method === 'serverRequest/resolved') this.approvals.delete(m.params.requestId);
            const view = this.views.get(id);
            if (view) view.at = 0;
            this.emit('change');
          }
        } catch (e) {
          this.close(e.reason || 'app_incompatible');
        }
      });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      const init = await this.request('initialize', {
        clientInfo: { name: 'mydash', title: 'mydash', version: '0.2.5' },
        capabilities: {
          experimentalApi: true,
          // Snapshot polling needs lifecycle events, not every token/tool chunk.
          optOutNotificationMethods: [
            'item/agentMessage/delta',
            'item/commandExecution/outputDelta',
            'item/fileChange/outputDelta',
            'item/reasoning/textDelta',
            'item/reasoning/summaryTextDelta',
            'item/reasoning/summaryPartAdded',
          ],
        },
      });
      if (!init?.codexHome || fs.realpathSync(init.codexHome) !== fs.realpathSync(this.codexHome))
        throw error('app_incompatible');
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
      ws._socket?.unref();
    })();
    try {
      await this.connecting;
    } catch (e) {
      this.close();
      throw e;
    } finally {
      this.connecting = null;
    }
  }
  request(method, params, mutation = false) {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(error('daemon_unavailable'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(error('daemon_unavailable', mutation));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, mutation });
      this.ws.send(JSON.stringify({ id, method, params }), (e) => {
        if (e && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error('daemon_unavailable', mutation));
        }
      });
    });
  }
  peek(id, cwd) {
    const row = this.views.get(id);
    if (!this.secure() || this.ws?.readyState !== WebSocket.OPEN || !row)
      return { connected: false, reason: 'daemon_unavailable', connectionSource: 'daemon' };
    if (cwd && !same(row.cwd, cwd))
      return { connected: false, reason: 'app_mismatch', connectionSource: 'daemon' };
    return row.view;
  }
  async observe(id, cwd, { force = false } = {}) {
    const fail = (reason) => {
      const view = { connected: false, reason, connectionSource: 'daemon' };
      if (this.views.size >= 50 && !this.views.has(id)) this.views.delete(this.views.keys().next().value);
      this.views.set(id, { cwd, view, at: Date.now() });
      return view;
    };
    if (!UUID.test(id) || !this.secure()) return fail('daemon_unavailable');
    if (this.observing.has(id)) return this.observing.get(id);
    const cached = this.views.get(id);
    if (
      !force &&
      cached &&
      Date.now() - cached.at < 750 &&
      same(cached.cwd, cwd) &&
      this.ws?.readyState === WebSocket.OPEN
    )
      return cached.view;
    const task = (async () => {
      try {
        await this.connect();
        const { thread } = await this.request('thread/read', { threadId: id, includeTurns: false });
        if (!thread || thread.id !== id || !same(thread.cwd, cwd)) return fail('app_mismatch');
        if (thread.parentThreadId || thread.agentRole || thread.agentNickname) return fail('daemon_readonly');
        let loaded = false,
          cursor;
        for (let page = 0; page < 10; page++) {
          const list = await this.request('thread/loaded/list', {
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          if (!Array.isArray(list.data)) return fail('app_incompatible');
          if (list.data.includes(id)) {
            loaded = true;
            break;
          }
          cursor = list.nextCursor;
          if (!cursor) break;
        }
        if (!loaded) return fail('daemon_not_loaded');
        if (thread.canAcceptDirectInput !== true) return fail('daemon_readonly');
        const history = await this.request('thread/turns/list', {
          threadId: id,
          limit: 30,
          itemsView: 'summary',
          sortDirection: 'desc',
        });
        if (!Array.isArray(history.data)) return fail('app_incompatible');
        const ms = (v) => (Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : 0);
        const turns = history.data.map((t) => ({
          ...t,
          turnId: t.id,
          turnStartedAtMs: ms(t.startedAt),
          items: t.items || [],
        }));
        const flags = thread.status?.activeFlags || [];
        const needsInput =
          flags.includes('waitingOnApproval') ||
          flags.includes('waitingOnUserInput') ||
          [...this.approvals.values()].includes(id);
        const transcript = appView({
          cwd: thread.cwd,
          turns,
          threadRuntimeStatus: thread.status,
          requests: needsInput ? [{}] : [],
        });
        const view = {
          ...transcript,
          connected: true,
          connectionSource: 'daemon',
          state: needsInput
            ? 'needs_input'
            : thread.status?.type === 'active' || transcript.state === 'busy'
              ? 'busy'
              : thread.status?.type === 'idle'
                ? 'idle'
                : 'unknown',
        };
        if (this.views.size >= 50) this.views.delete(this.views.keys().next().value);
        this.views.set(id, { cwd, view, at: Date.now() });
        return view;
      } catch (e) {
        return fail(e.reason || 'daemon_unavailable');
      }
    })();
    this.observing.set(id, task);
    try {
      return await task;
    } finally {
      this.observing.delete(id);
    }
  }
  async start(id, cwd, { text, images = [], clientId, authorize = () => true }) {
    if (
      !UUID.test(id) ||
      !UUID.test(clientId) ||
      typeof text !== 'string' ||
      text.length > 12000 ||
      (!text.trim() && !images.length) ||
      images.length > 4 ||
      images.some((x) => !path.isAbsolute(x.path || ''))
    )
      throw error('invalid-input');
    const view = await this.observe(id, cwd, { force: true });
    if (!view.connected || view.state !== 'idle' || !authorize()) throw error('daemon_not_idle');
    const result = await this.request(
      'turn/start',
      {
        threadId: id,
        clientUserMessageId: clientId,
        input: [
          ...(text.trim() ? [{ type: 'text', text }] : []),
          ...images.map((x) => ({ type: 'localImage', path: x.path })),
        ],
      },
      true
    );
    if (!result?.turn?.id) throw error('daemon_unavailable', true);
    const cached = this.views.get(id);
    if (cached) cached.at = 0;
    return { turnId: result.turn.id };
  }
}
export const codexDaemon = new CodexDaemonBridge();
