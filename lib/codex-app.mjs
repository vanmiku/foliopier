// Adapter for the desktop App's local, versioned follower protocol. No new executor.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { canonicalProject } from './session-discovery.mjs';
// Long native conversations include tool output in their private snapshots.
// Keep a hard bound, but accept the >32 MiB snapshots produced by the App.
const MAX_FRAME = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const sameFolder = (a, b) => {
  try {
    const root = canonicalProject(a);
    return Boolean(root) && root === canonicalProject(b);
  } catch {
    return false;
  }
};
export function applyAppChange(prior, change) {
  if (change.type === 'snapshot') {
    if (
      !Number.isSafeInteger(change.revision) ||
      !change.conversationState ||
      typeof change.conversationState !== 'object'
    )
      throw Error('snapshot');
    return { revision: change.revision, state: change.conversationState };
  }
  if (
    change.type !== 'patches' ||
    !prior ||
    change.baseRevision !== prior.revision ||
    !Number.isSafeInteger(change.revision) ||
    change.revision <= prior.revision ||
    !Array.isArray(change.patches)
  )
    throw Error('revision');
  const clone = (value) => (Array.isArray(value) ? value.slice() : { ...value });
  const state = clone(prior.state);
  for (const p of change.patches) {
    if (
      !Array.isArray(p.path) ||
      !p.path.length ||
      p.path.some((k) => forbidden.has(String(k))) ||
      !['add', 'remove', 'replace'].includes(p.op)
    )
      throw Error('patch');
    let parent = state;
    for (const k of p.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, k)) throw Error('path');
      if (!parent[k] || typeof parent[k] !== 'object') throw Error('path');
      parent[k] = clone(parent[k]);
      parent = parent[k];
    }
    const key = p.path.at(-1);
    if (!parent || typeof parent !== 'object') throw Error('path');
    if (Array.isArray(parent)) {
      if (
        !Number.isSafeInteger(key) ||
        key < 0 ||
        key > parent.length ||
        (p.op !== 'add' && key === parent.length)
      )
        throw Error('index');
      if (p.op === 'add') parent.splice(key, 0, p.value);
      else if (p.op === 'remove') parent.splice(key, 1);
      else parent[key] = p.value;
    } else {
      if (p.op !== 'add' && !Object.hasOwn(parent, key)) throw Error('key');
      if (p.op === 'remove') delete parent[key];
      else parent[key] = p.value;
    }
  }
  return { revision: change.revision, state };
}
const textParts = (xs) =>
  (Array.isArray(xs) ? xs : [])
    .filter((x) => ['text', 'input_text', 'output_text'].includes(x?.type))
    .map((x) => x.text || '')
    .join('\n');
export function appView(state) {
  const source = state.turnHistory?.history?.entitiesByKey;
  const turns = (source ? Object.values(source) : state.turns || [])
    .filter((t) => t && typeof t === 'object')
    .sort((a, b) => (a.turnStartedAtMs || 0) - (b.turnStartedAtMs || 0));
  const messages = [],
    summaries = [];
  for (const turn of turns.slice(-100)) {
    const at = Number.isFinite(turn.turnStartedAtMs) ? new Date(turn.turnStartedAtMs).toISOString() : null;
    const users = (turn.items || []).filter((x) => x.type === 'userMessage');
    const inputs = users.map((x) => ({
      text: textParts(x.content),
      clientId: x.clientId,
      attachments: (x.content || [])
        .filter((p) => ['localImage', 'image'].includes(p.type))
        .map((p) => path.basename(p.path || 'image')),
    }));
    if (!inputs.length && turn.params?.input?.length)
      inputs.push({ text: textParts(turn.params.input), clientId: turn.params.clientUserMessageId });
    for (const input of inputs)
      if (input.text.trim() || input.attachments?.length)
        messages.push({
          kind: 'user',
          text: input.text,
          at,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        });
    let answer = '';
    for (const item of turn.items || [])
      if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
        const ms = item.startedAtMs;
        messages.push({
          kind: 'assistant',
          text: item.text,
          at: Number.isFinite(ms) ? new Date(ms).toISOString() : at,
        });
        if (item.phase === 'final_answer') answer = item.text;
      }
    summaries.push({
      id: turn.turnId || null,
      status: turn.status || 'unknown',
      inputs,
      answer,
      startedAt: turn.turnStartedAtMs || 0,
      error: Boolean(turn.error),
    });
  }
  const active = state.threadRuntimeStatus?.type === 'active' || summaries.at(-1)?.status === 'inProgress';
  return {
    cwd: state.cwd,
    resumeState: state.resumeState,
    state: state.requests?.length ? 'needs_input' : active ? 'busy' : 'idle',
    messages: messages.slice(-100),
    turns: summaries,
  };
}
export class CodexAppBridge extends EventEmitter {
  constructor({ socketPath, timeoutMs = 10000 } = {}) {
    super();
    this.socketPath =
      socketPath ||
      path.join(
        process.env.MYDASH_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
        'ipc/ipc.sock'
      );
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.connecting = null;
    this.pending = new Map();
    this.snapshots = new Map();
    this.watches = new Map();
    this.observing = new Map();
    this.failures = new Map();
    this.clientId = 'initializing-client';
    this.resetReader();
  }
  resetReader() {
    this.header = Buffer.alloc(4);
    this.headerBytes = 0;
    this.frame = null;
    this.frameBytes = 0;
  }
  secure() {
    try {
      const uid = process.getuid?.();
      if (uid == null) return false;
      const dir = fs.lstatSync(path.dirname(this.socketPath)),
        sock = fs.lstatSync(this.socketPath);
      return (
        dir.isDirectory() &&
        sock.isSocket() &&
        dir.uid === uid &&
        sock.uid === uid &&
        (dir.mode & 0o077) === 0 &&
        (sock.mode & 0o077) === 0
      );
    } catch {
      return false;
    }
  }
  async connect() {
    if (!this.secure()) throw Error('insecure-or-missing-socket');
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed && this.clientId !== 'initializing-client') return;
    const task = (async () => {
      const socket = net.createConnection(this.socketPath);
      this.socket = socket;
      this.resetReader();
      socket.on('data', (b) => this.read(b));
      socket.on('error', () => {});
      socket.on('close', () => this.disconnected(socket));
      socket.unref();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(Error('connect-timeout'));
        }, this.timeoutMs);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      const r = await this.request('initialize', { clientType: 'mydash' }, 0);
      this.clientId = r.result?.clientId;
      if (!this.clientId) throw Error('initialize');
    })();
    this.connecting = task;
    try {
      await task;
    } catch (e) {
      this.close();
      throw e;
    } finally {
      this.connecting = null;
    }
  }
  disconnected(socket, reason = 'app_unavailable') {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clientId = 'initializing-client';
    this.resetReader();
    for (const id of this.observing.keys()) this.failures.set(id, reason);
    this.snapshots.clear();
    this.watches.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      const e = Error('connection-closed');
      e.reason = reason;
      e.uncertain = p.mutation;
      p.reject(e);
    }
    this.pending.clear();
    this.emit('change');
  }
  close(reason = 'app_unavailable') {
    this.socket?.destroy();
    this.disconnected(this.socket, reason);
  }
  write(m) {
    if (!this.socket || this.socket.destroyed) throw Error('not-connected');
    const b = Buffer.from(JSON.stringify(m));
    if (b.length > MAX_FRAME) throw Error('frame');
    const h = Buffer.alloc(4);
    h.writeUInt32LE(b.length);
    this.socket.write(Buffer.concat([h, b]));
  }
  request(method, params, version, targetClientId, mutation = false) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      // Allow the native broker to return no-client-found (about ten seconds).
      // Other RPCs retain their normal bound.
      const timer = setTimeout(
        () => {
          this.pending.delete(requestId);
          const e = Error('request-timeout');
          e.uncertain = mutation;
          reject(e);
        },
        method === 'thread-owner-discovery' ||
          (method === 'thread-follower-read-model-settings' && !targetClientId)
          ? Math.max(this.timeoutMs, 12000)
          : this.timeoutMs
      );
      this.pending.set(requestId, { resolve, reject, timer, mutation });
      try {
        this.write({
          type: 'request',
          requestId,
          sourceClientId: this.clientId,
          method,
          params,
          version,
          ...(targetClientId ? { targetClientId } : {}),
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }
  broadcast(method, params, version, targetClientId) {
    this.write({
      type: 'broadcast',
      method,
      params,
      version,
      sourceClientId: this.clientId,
      targetClientIds: [targetClientId],
    });
  }
  follow(id, owner, following = true) {
    this.broadcast(
      'thread-stream-following-changed',
      { hostId: 'local', conversationId: id, following },
      1,
      owner
    );
  }
  read(chunk) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.frame) {
          const count = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + count);
          this.headerBytes += count;
          offset += count;
          if (this.headerBytes < 4) continue;
          const n = this.header.readUInt32LE();
          if (n > MAX_FRAME) throw Object.assign(Error('frame'), { reason: 'app_history_limit' });
          if (!n) throw Error('frame');
          this.headerBytes = 0;
          this.frame = Buffer.allocUnsafe(n);
        }
        // Copy each incoming byte once. Repeatedly concatenating an entire
        // growing snapshot made large, fragmented frames quadratic in cost.
        const count = Math.min(this.frame.length - this.frameBytes, chunk.length - offset);
        chunk.copy(this.frame, this.frameBytes, offset, offset + count);
        this.frameBytes += count;
        offset += count;
        if (this.frameBytes === this.frame.length) {
          const frame = this.frame;
          this.frame = null;
          this.frameBytes = 0;
          this.handle(JSON.parse(frame.toString('utf8')));
        }
      }
    } catch (e) {
      this.close(e.reason || 'app_unavailable');
    }
  }
  handle(m) {
    if (m.type === 'response') {
      const p = this.pending.get(m.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.requestId);
      if (m.resultType === 'success') p.resolve(m);
      else {
        const e = Error(m.error || 'app-error');
        e.uncertain =
          p.mutation &&
          !['no-client-found', 'no-handler-for-request', 'request-version-mismatch'].includes(m.error);
        p.reject(e);
      }
      return;
    }
    if (m.type === 'client-discovery-request') {
      this.write({
        type: 'client-discovery-response',
        requestId: m.requestId,
        response: { canHandle: false },
      });
      return;
    }
    if (
      m.type === 'broadcast' &&
      m.method === 'client-status-changed' &&
      m.params?.status === 'disconnected'
    ) {
      for (const [id, w] of this.watches)
        if (w.owner === m.params.clientId) {
          this.watches.delete(id);
          this.snapshots.delete(id);
        }
      this.emit('change');
      return;
    }
    if (m.type !== 'broadcast' || m.method !== 'thread-stream-state-changed') return;
    const p = m.params,
      w = this.watches.get(p?.conversationId);
    if (!w || m.sourceClientId !== w.owner || p.hostId !== 'local') return;
    if (m.version !== 11) {
      w.incompatible = true;
      this.snapshots.delete(p.conversationId);
      this.emit('change');
      return;
    }
    try {
      const next = applyAppChange(this.snapshots.get(p.conversationId), p.change);
      if (next.state.id !== p.conversationId) throw Error('thread');
      this.snapshots.set(p.conversationId, next);
      w.updated = Date.now();
      this.emit('change', p.conversationId);
    } catch {
      this.snapshots.delete(p.conversationId);
      try {
        this.follow(p.conversationId, w.owner, false);
        this.follow(p.conversationId, w.owner);
      } catch {}
    }
  }
  peek(id, cwd) {
    const w = this.watches.get(id),
      snapshot = this.snapshots.get(id);
    if (
      !w ||
      w.incompatible ||
      !snapshot ||
      !this.socket ||
      this.socket.destroyed ||
      (cwd && !sameFolder(snapshot.state.cwd, cwd))
    )
      return {
        connected: false,
        reason: w?.incompatible
          ? 'app_incompatible'
          : snapshot && cwd && !sameFolder(snapshot.state.cwd, cwd)
            ? 'app_mismatch'
            : this.failures.get(id) || null,
      };
    return { connected: true, owner: w.owner, ...appView(snapshot.state) };
  }
  async observe(id, cwd) {
    const fail = (reason) => {
      if (this.failures.size > 100) this.failures.delete(this.failures.keys().next().value);
      this.failures.set(id, reason);
      return { connected: false, reason };
    };
    if (!UUID.test(id)) return fail('not_connected');
    if (!this.secure()) return fail('app_closed');
    const cached = this.peek(id, cwd);
    if (cached.connected) {
      this.watches.get(id).touched = Date.now();
      return cached;
    }
    if (this.observing.has(id)) return this.observing.get(id);
    const task = (async () => {
      try {
        await this.connect();
        // A background owner can miss the App's short broadcast discovery
        // deadline even while its original thread is running. Route a read-only
        // settings request first, then verify that exact owner and capability.
        const settings = await this.request('thread-follower-read-model-settings', { conversationId: id }, 1);
        const owner = settings.handledByClientId;
        if (!owner || settings.result?.settings?.resumeState !== 'resumed') return fail('app_not_open');
        const r = await this.request(
          'thread-owner-discovery',
          { hostId: 'local', conversationId: id },
          1,
          owner
        );
        if (r.handledByClientId !== owner || r.result?.supportsUntrustedAppInput !== true)
          return fail('app_incompatible');
        this.failures.delete(id);
        this.watches.set(id, { owner, touched: Date.now() });
        // Keep multiple recently viewed projects connected. Evict oldest inactive views first.
        for (const [key, w] of [...this.watches].sort((a, b) => a[1].touched - b[1].touched))
          if (key !== id && (Date.now() - w.touched > 120000 || this.watches.size > 8)) {
            this.follow(key, w.owner, false);
            this.watches.delete(key);
            this.snapshots.delete(key);
          }
        this.follow(id, owner);
        const deadline = Date.now() + this.timeoutMs;
        while (Date.now() < deadline) {
          const v = this.peek(id, cwd);
          if (v.connected) {
            this.failures.delete(id);
            return v;
          }
          if (v.reason === 'app_mismatch') return fail('app_mismatch');
          if (!this.socket || this.socket.destroyed) return fail(v.reason || 'app_unavailable');
          if (this.watches.get(id)?.incompatible) return fail('app_incompatible');
          await new Promise((r) => setTimeout(r, 20));
        }
      } catch (error) {
        return fail(
          error.reason || (error.message === 'no-client-found' ? 'app_not_open' : 'app_unavailable')
        );
      }
      return fail('app_unavailable');
    })();
    this.observing.set(id, task);
    try {
      return await task;
    } finally {
      this.observing.delete(id);
    }
  }
  async start(id, cwd, { text, clientId, images = [], authorize = () => true }) {
    if (
      typeof text !== 'string' ||
      (!text.trim() && !images.length) ||
      text.length > 12000 ||
      !UUID.test(clientId) ||
      images.length > 4 ||
      images.some((image) => !path.isAbsolute(image.path || ''))
    )
      throw Error('invalid-input');
    const view = await this.observe(id, cwd);
    if (!view.connected || view.state !== 'idle') throw Error('app-not-idle');
    const owner = await this.request(
      'thread-owner-discovery',
      { hostId: 'local', conversationId: id },
      1,
      view.owner
    );
    if (
      owner.handledByClientId !== view.owner ||
      owner.result?.supportsUntrustedAppInput !== true ||
      !this.secure()
    )
      throw Error('owner-changed');
    const latest = this.peek(id, cwd);
    if (!authorize() || !latest.connected || latest.state !== 'idle') throw Error('app-not-idle');
    const r = await this.request(
      'thread-follower-start-turn',
      {
        conversationId: id,
        turnStart: {
          request: {
            threadId: id,
            input: [
              ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
              ...images.map((image) => ({ type: 'localImage', path: image.path })),
            ],
            clientUserMessageId: clientId,
          },
          context: { inheritThreadSettings: true },
        },
      },
      2,
      view.owner,
      true
    );
    if (r.handledByClientId !== view.owner) {
      const e = Error('owner-changed');
      e.uncertain = true;
      throw e;
    }
    const result = r.result?.result;
    return { turnId: typeof result === 'string' ? result : result?.turnId || result?.turn?.id || null };
  }
}
export const codexApp = new CodexAppBridge();
