import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appView } from './codex-app.mjs';
import { canonicalProject } from './session-discovery.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const unavailable = () => ({ connected: false, reason: 'native_queue_unavailable' });
const sameFolder = (a, b) => {
  const folder = canonicalProject(a);
  return Boolean(folder) && folder === canonicalProject(b);
};

function bundledCodex() {
  if (process.platform !== 'darwin') return null;
  for (const root of ['/Applications', path.join(os.homedir(), 'Applications')])
    for (const app of ['ChatGPT.app', 'Codex.app']) {
      const binary = path.join(root, app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
      try {
        fs.accessSync(binary, fs.constants.X_OK);
        return binary;
      } catch {}
    }
  return null;
}

// A stdio client of Codex's persisted queue. No thread resume, turn start,
// listener or changes to the desktop process. The original owner drains the queue.
export class CodexNativeQueue {
  constructor({
    codexHome = process.env.MYDASH_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    binary = bundledCodex,
    launch = spawn,
    timeoutMs = 5000,
  } = {}) {
    Object.assign(this, { codexHome, binary, launch, timeoutMs });
    this.views = new Map();
    this.observing = new Map();
    this.connection = null;
  }

  close(connection = this.connection) {
    if (!connection || this.connection !== connection) return;
    this.connection = null;
    clearTimeout(connection.idle);
    for (const finish of connection.pending.values()) finish(null);
    connection.pending.clear();
    connection.child.kill();
  }

  async connect() {
    if (this.connection) return this.connection.ready;
    const command = this.binary();
    if (!command) return null;
    const child = this.launch(command, ['app-server', '--listen', 'stdio://'], {
      cwd: this.codexHome,
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const connection = { child, nextId: 0, pending: new Map(), idle: null };
    this.connection = connection;
    child.on('error', () => this.close(connection));
    child.on('exit', () => this.close(connection));
    child.stdin.on('error', () => this.close(connection));
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const { id, result, error } = JSON.parse(line);
        connection.pending.get(id)?.({ result, error });
      } catch {
        this.close(connection);
      }
    });
    connection.ready = (async () => {
      const reply = await this.rpc(connection, 'initialize', {
        clientInfo: { name: 'foliopier-queue', version: '1' },
        capabilities: { experimentalApi: true },
      });
      if (!reply?.result || !sameFolder(reply.result.codexHome, this.codexHome)) {
        this.close(connection);
        return null;
      }
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      return connection;
    })();
    return connection.ready;
  }

  async rpc(connection, method, params) {
    if (!connection || this.connection !== connection) return null;
    clearTimeout(connection.idle);
    const id = ++connection.nextId;
    return new Promise((resolve) => {
      const finish = (reply) => {
        clearTimeout(timer);
        connection.pending.delete(id);
        if (this.connection === connection && !connection.pending.size) {
          connection.idle = setTimeout(() => this.close(connection), 30000);
          connection.idle.unref();
        }
        resolve(reply);
      };
      const timer = setTimeout(() => this.close(connection), this.timeoutMs);
      connection.pending.set(id, finish);
      connection.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) this.close(connection);
      });
    });
  }

  async thread(connection, id, cwd) {
    const reply = await this.rpc(connection, 'thread/read', { threadId: id, includeTurns: false });
    const thread = reply?.result?.thread;
    if (!thread || thread.id !== id || !sameFolder(thread.cwd, cwd)) return null;
    if (thread.threadSource !== 'user' || !['vscode', 'appServer'].includes(thread.source) ||
        thread.ephemeral !== false || thread.parentThreadId || thread.agentRole || thread.agentNickname ||
        thread.canAcceptDirectInput === false) return null;
    return thread;
  }

  peek(id, cwd) {
    const row = this.views.get(id);
    return row && (!cwd || sameFolder(row.cwd, cwd)) && Date.now() - row.at < 20000
      ? row.view
      : unavailable();
  }

  async observe(id, cwd) {
    if (!UUID.test(id) || !cwd) return unavailable();
    const waiting = this.observing.get(id);
    if (waiting && sameFolder(waiting.cwd, cwd)) return waiting.task;
    const task = (async () => {
      const remember = (view) => {
        if (this.views.size >= 50 && !this.views.has(id)) this.views.delete(this.views.keys().next().value);
        this.views.set(id, { cwd, at: Date.now(), view });
        return view;
      };
      try {
        const connection = await this.connect();
        const thread = await this.thread(connection, id, cwd);
        if (!thread) return remember(unavailable());
        const [queue, history] = await Promise.all([
          this.rpc(connection, 'thread/queue/list', { threadId: id, limit: 100 }),
          this.rpc(connection, 'thread/turns/list', { threadId: id, limit: 30, itemsView: 'summary', sortDirection: 'desc' }),
        ]);
        if (!Array.isArray(queue?.result?.data) || !Array.isArray(history?.result?.data))
          return remember(unavailable());
        const { turns } = appView({
          turns: history.result.data.map((turn) => ({
            ...turn,
            turnId: turn.id,
            turnStartedAtMs: Number.isFinite(turn.startedAt) ? turn.startedAt * 1000 : 0,
          })),
        });
        return remember({
          connected: true,
          state: 'unknown',
          turns,
          pendingClientIds: queue.result.data.map((row) => row.clientUserMessageId),
        });
      } catch {
        return remember(unavailable());
      }
    })();
    const row = { cwd, task };
    this.observing.set(id, row);
    try {
      return await task;
    } finally {
      if (this.observing.get(id) === row) this.observing.delete(id);
    }
  }

  async start(id, cwd, { text, images = [], clientId, authorize = () => true }) {
    if (!UUID.test(id) || !UUID.test(clientId) || typeof text !== 'string' || text.length > 12000 ||
        (!text.trim() && !images.length) || images.length > 4 || images.some((x) => !path.isAbsolute(x.path || '')))
      throw Error('invalid-input');
    const connection = await this.connect();
    if (!await this.thread(connection, id, cwd) || !authorize()) throw Error('native-queue-unavailable');
    const reply = await this.rpc(connection, 'thread/queue/add', {
      threadId: id,
      clientUserMessageId: clientId,
      input: [
        ...(text.trim() ? [{ type: 'text', text }] : []),
        ...images.map((x) => ({ type: 'localImage', path: x.path })),
      ],
    });
    if (reply?.result?.queuedSubmission?.clientUserMessageId === clientId) return { queued: true };
    throw Object.assign(Error('native-queue-unconfirmed'), {
      uncertain: ![-32600, -32601, -32602].includes(reply?.error?.code),
    });
  }
}

export const codexNativeQueue = new CodexNativeQueue();
