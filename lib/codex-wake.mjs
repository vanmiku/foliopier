// Opens an existing desktop thread only. No prompt, new executor or permission changes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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
    home = process.env.MYDASH_HOME || path.join(os.homedir(), '.mydash'),
  } = {}
) {
  if (!UUID.test(id) || platform !== 'darwin') throw failure('app_wake_unsupported');
  if (!Number.isInteger(uid) || uid <= 0 || consoleUid() !== uid) throw failure('app_login_required');
  // The boot service runs outside the GUI namespace. Enter this user's GUI
  // namespace and use Launch Services' registered bundle ID (not a guessed path).
  const args = ['/usr/bin/open', '-g', '-b', 'com.openai.codex', 'codex://threads/' + id];
  try {
    await run('/bin/launchctl', ['asuser', String(uid), ...args], { timeout: 10000, maxBuffer: 8192 });
    return;
  } catch {}
  // An unprivileged system LaunchDaemon can be denied `asuser`. Bootstrap a
  // fixed, one-shot open command directly into its owner's existing GUI domain.
  // No helper server, shell, administrator authorization or persistent agent.
  if (consoleUid() !== uid) throw failure('app_login_required');
  const state = path.join(home, 'state');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(state, 'codex-wake-'));
  const label = 'mydash.codex-wake.' + crypto.randomUUID();
  const domain = `gui/${uid}`,
    job = domain + '/' + label;
  const xml = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]
    );
  const file = path.join(dir, 'open.plist');
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((a) => '<string>' + xml(a) + '</string>').join('')}</array><key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(os.userInfo().homedir)}</string></dict><key>RunAtLoad</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string><key>ProcessType</key><string>Interactive</string></dict></plist>\n`,
    { mode: 0o600 }
  );
  try {
    await run('/bin/launchctl', ['bootstrap', domain, file], { timeout: 5000, maxBuffer: 8192 });
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const { stdout } = await run('/bin/launchctl', ['print', job], { timeout: 2000, maxBuffer: 32768 });
      const code = /last exit code = (\d+)/.exec(stdout)?.[1];
      if (code !== undefined) {
        if (Number(code) !== 0) throw failure('app_wake_failed');
        return;
      }
      await sleep(100);
    }
    throw failure('app_wake_timeout');
  } finally {
    await run('/bin/launchctl', ['bootout', job], { timeout: 3000, maxBuffer: 8192 }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
