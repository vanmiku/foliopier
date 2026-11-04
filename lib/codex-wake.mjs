// Opens an existing desktop thread only. No prompt, new executor or permission changes.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const blocked = new Set(['app_mismatch', 'app_incompatible', 'app_history_limit']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (reason) => Object.assign(Error(reason), { reason });
export async function openCodexThread(
  id,
  {
    platform = process.platform,
    uid = process.getuid?.(),
    consoleUid = () => fs.statSync('/dev/console').uid,
    run = runFile,
  } = {}
) {
  if (!UUID.test(id) || platform !== 'darwin') throw failure('app_wake_unsupported');
  if (!Number.isInteger(uid) || uid <= 0 || consoleUid() !== uid) throw failure('app_login_required');
  // The boot service runs outside the GUI namespace. Enter this user's GUI
  // namespace and use Launch Services' registered bundle ID (not a guessed path).
  await run(
    '/bin/launchctl',
    ['asuser', String(uid), '/usr/bin/open', '-g', '-b', 'com.openai.codex', 'codex://threads/' + id],
    { timeout: 10000, maxBuffer: 8192 }
  );
}
export class CodexWake {
  constructor({
    bridge,
    authorize,
    open = openCodexThread,
    probeMs = 750,
    retryMs = 500,
    timeoutMs = 30000,
    cooldownMs = 120000,
    manualCooldownMs = 5000,
  }) {
    Object.assign(this, {
      bridge,
      authorize,
      open,
      probeMs,
      retryMs,
      timeoutMs,
      cooldownMs,
      manualCooldownMs,
    });
    this.entries = new Map();
  }
  peek(id) {
    const e = this.entries.get(id);
    return e ? { state: e.state, reason: e.reason, at: e.at } : null;
  }
  start(id, cwd, options) {
    this.ensure(id, cwd, options).catch(() => {});
    return this.peek(id);
  }
  ensure(id, cwd, { manual = false } = {}) {
    const denied = (reason) => Promise.resolve({ state: 'failed', reason });
    if (!UUID.test(id) || !this.authorize(id, cwd)) return denied('disabled');
    const view = this.bridge.peek(id, cwd);
    if (view.connected) return Promise.resolve({ state: 'connected', reason: null });
    if (blocked.has(view.reason)) return denied(view.reason);
    const prior = this.entries.get(id);
    // A changed project binding must never reuse an in-flight wake for another folder.
    if (prior?.cwd === cwd) {
      if (prior.task) return prior.task;
      if (Date.now() - prior.at < (manual ? this.manualCooldownMs : this.cooldownMs))
        return Promise.resolve(this.peek(id));
    } else if (prior?.task) return denied('app_mismatch');
    if ([...this.entries.values()].filter((e) => e.task).length >= 4) return denied('app_wake_busy');
    for (const [key, e] of this.entries)
      if (!e.task && (Date.now() - e.at > this.cooldownMs || this.entries.size >= 100))
        this.entries.delete(key);
    const e = { cwd, at: Date.now(), state: 'connecting', reason: null };
    this.entries.set(id, e);
    const set = (state, reason = null) => {
      Object.assign(e, { state, reason });
      return this.peek(id);
    };
    e.task = (async () => {
      try {
        const observe = () =>
          this.bridge.observe(id, cwd).catch(() => ({ connected: false, reason: 'app_unavailable' }));
        const probe = await Promise.race([
          observe(),
          sleep(this.probeMs).then(() => this.bridge.peek(id, cwd)),
        ]);
        if (!this.authorize(id, cwd)) return set('failed', 'disabled');
        if (probe.connected) return set('connected');
        if (blocked.has(probe.reason)) return set('failed', probe.reason);
        set('opening');
        await this.open(id);
        set('connecting');
        const until = Date.now() + this.timeoutMs;
        while (Date.now() < until) {
          if (!this.authorize(id, cwd)) return set('failed', 'disabled');
          const cached = this.bridge.peek(id, cwd);
          if (cached.connected) return set('connected');
          if (blocked.has(cached.reason)) return set('failed', cached.reason);
          const next = await Promise.race([
            observe(),
            sleep(Math.min(this.retryMs, until - Date.now())).then(() => null),
          ]);
          if (!this.authorize(id, cwd)) return set('failed', 'disabled');
          if (next?.connected) return set('connected');
          if (blocked.has(next?.reason)) return set('failed', next.reason);
          if (next) await sleep(this.retryMs);
        }
        return set('failed', 'app_wake_timeout');
      } catch (error) {
        return set('failed', error.reason || 'app_wake_failed');
      } finally {
        e.task = null;
      }
    })();
    return e.task;
  }
}
