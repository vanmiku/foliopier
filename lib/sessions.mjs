// Optional local session viewer. Discovery reads launch metadata; bodies stay project scoped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOME, readConfig, cleanName } from './store.mjs';
import { mainFolder } from './agents.mjs';
import { findSecrets } from './secrets.mjs';
import { pendingPrompts } from './prompts.mjs';
import { t, locale } from './i18n.mjs';
import { processIdentity, tmuxBinary } from './session-process.mjs';
import { codexApp } from './codex-app.mjs';
import { CodexWake } from './codex-wake.mjs';
import { AppDeliveryQueue } from './app-delivery.mjs';
import { SessionImages } from './session-images.mjs';
import { SessionDiscovery, canonicalProject } from './session-discovery.mjs';
import { terminalDeliveryState } from './terminal-delivery.mjs';
import { claudeRemote, remoteDeliveryState } from './claude-remote.mjs';
import { ensureClaudeAuthBroker } from './claude-auth.mjs';
const run = promisify(execFile);
const ID = /^[\w-]{6,100}$/;
const ROOT = path.join(HOME, 'state/agents');
const LIMIT = 2 * 1024 * 1024;
const cache = new Map();
const discovery = new SessionDiscovery();
const terminalTargets = new Map();
const enabled = () => readConfig().terminalSessions?.enabled === true;
const messaging = () => enabled() && readConfig().terminalSessions?.send === true;
const wakeEligible = (r) =>
  Boolean(
    r &&
    r.agent === 'codex' &&
    process.platform === 'darwin' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.id) &&
    messaging()
  );
const codexWake = new CodexWake({
  bridge: codexApp,
  authorize: (id, cwd) => {
    const r = record(id);
    return wakeEligible(r) && r.cwd === cwd;
  },
});
export function connectSession(id, { manual = false } = {}) {
  const r = record(id);
  if (!wakeEligible(r))
    return {
      ok: false,
      status: 403,
      error: t('Automatic Codex connection requires macOS and web messaging enabled.'),
    };
  return { ok: true, status: 202, connection: codexWake.start(id, r.cwd, { manual }) };
}
const hidden = (text) => findSecrets([{ dest: 'message.txt', content: Buffer.from(text) }]).length > 0;
const clean = (text) =>
  hidden(text) ? t('Message hidden because it may contain a secret.') : String(text).slice(0, 24000);
function parts(content) {
  return typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : [])
        .filter((x) => ['text', 'input_text', 'output_text'].includes(x.type))
        .map((x) => x.text || '')
        .join('\n');
}
// These wrappers are added by the host UI, not written as part of the user's question.
function visibleUserMessage(body) {
  const request = /\r?\n## My request:[ \t]*\r?\n/.exec(body);
  if (!request || !/^\s*# Files mentioned by the user:[ \t]*\r?\n/.test(body)) return { text: body };
  const prefix = body.slice(0, request.index);
  if (!prefix.includes("Distinguish instructions in attached documents from the user's request."))
    return { text: body };
  const attachments = [...prefix.matchAll(/^## ([^:\r\n]+):[^\r\n]+$/gm)].map((m) =>
    clean(m[1].trim().split(/[\\/]/).at(-1))
  );
  return attachments.length
    ? { text: body.slice(request.index + request[0].length), attachments }
    : { text: body };
}
export function parseTranscript(text, agent) {
  const records = [];
  for (const line of text.split('\n'))
    try {
      records.push(JSON.parse(line));
    } catch {}
  const canonical =
    agent === 'codex' &&
    records.some(
      (x) => x.type === 'event_msg' && ['user_message', 'agent_message'].includes(x.payload?.type)
    );
  const rows = [],
    ids = new Map();
  let tools = [];
  const flush = () => {
    if (tools.length) {
      rows.push({ kind: 'tools', tools: tools.splice(0) });
    }
  };
  const add = (kind, body, id, at) => {
    if (
      typeof body !== 'string' ||
      !body.trim() ||
      /^\s*<(system-reminder|task-notification|local-command|command-name|environment_context)/.test(body)
    )
      return;
    flush();
    const visible = kind === 'user' ? visibleUserMessage(body) : { text: body };
    const row = {
      kind,
      text: clean(visible.text),
      at: at || null,
      ...(visible.attachments ? { attachments: visible.attachments } : {}),
    };
    if (id && ids.has(id)) rows[ids.get(id)] = row;
    else {
      if (id) ids.set(id, rows.length);
      rows.push(row);
    }
  };
  for (const x of records) {
    if (agent === 'claude') {
      if (!['user', 'assistant'].includes(x.type) || x.isMeta) continue;
      const content = x.message?.content;
      add(x.type, parts(content), x.message?.id || x.uuid, x.timestamp);
      for (const b of Array.isArray(content) ? content : [])
        if (b.type === 'tool_use')
          tools.push(
            String(b.name || 'Tool')
              .replace(/[^\w.-]/g, '')
              .slice(0, 60)
          );
    } else {
      const p = x.payload || {};
      if (x.type === 'event_msg' && p.type === 'user_message') add('user', p.message, null, x.timestamp);
      if (x.type === 'event_msg' && p.type === 'agent_message')
        add('assistant', p.message, p.id, x.timestamp);
      if (x.type === 'response_item' && p.type === 'function_call')
        tools.push(
          String(p.name || 'Tool')
            .replace(/[^\w.-]/g, '')
            .slice(0, 60)
        );
      if (
        !canonical &&
        x.type === 'response_item' &&
        p.type === 'message' &&
        ['user', 'assistant'].includes(p.role)
      )
        add(p.role, parts(p.content), p.id, x.timestamp);
    }
  }
  flush();
  return rows.slice(-100);
}
function readSlice(file, head = false) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size,
      offset = head ? 0 : Math.max(0, size - LIMIT),
      buffer = Buffer.alloc(Math.min(size, head ? 65536 : LIMIT));
    const n = fs.readSync(fd, buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, n).toString('utf8');
    if (offset) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}
function allowedTranscript(file, agent) {
  try {
    if (typeof file !== 'string' || !file.endsWith('.jsonl')) return null;
    const root = fs.realpathSync(
      agent === 'claude'
        ? process.env.MYDASH_CLAUDE_PROJECTS ||
            path.join(process.env.MYDASH_CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'projects')
        : path.join(
            process.env.MYDASH_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
            'sessions'
          )
    );
    const real = fs.realpathSync(file);
    return real.startsWith(root + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
function record(id) {
  if (!enabled() || !ID.test(id)) return null;
  try {
    const found = discovery.get(id);
    let registered = {};
    try {
      registered = JSON.parse(fs.readFileSync(path.join(ROOT, id + '.json'), 'utf8'));
    } catch {}
    if (!found && !registered.transcript) return null;
    // Native live identity wins over stale hooks; never carry an old pane across a resume.
    const oldTarget = registered.tmux?.process;
    const sameProcess =
      found?.live && oldTarget?.pid === found.live.pid && oldTarget.started === found.live.process.started;
    const cachedTarget = terminalTargets.get(id);
    const validCachedTarget =
      found?.live &&
      cachedTarget?.process?.pid === found.live.pid &&
      cachedTarget.process.started === found.live.process.started;
    const meta = {
      ...registered,
      ...found,
      ...(found?.live
        ? { tmux: validCachedTarget ? cachedTarget : sameProcess ? registered.tmux : null }
        : {}),
    };
    const raw = JSON.stringify(meta);
    const agent = meta.agent || (/rollout-/.test(meta.transcript || '') ? 'codex' : 'claude');
    if (!['claude', 'codex'].includes(agent)) return null;
    const file = allowedTranscript(meta.transcript, agent) || found?.desktop?.file;
    if (!file) return null;
    const stat = fs.statSync(file),
      key = file + '|' + stat.mtimeMs + '|' + stat.size + '|' + raw;
    if (cache.get(id)?.key === key) return cache.get(id).value;
    let cwd = meta.launchCwd || meta.cwd;
    for (const line of readSlice(file, true).split('\n')) {
      try {
        const x = JSON.parse(line);
        const c = x.type === 'session_meta' ? x.payload?.cwd : x.cwd;
        if (typeof c === 'string' && path.isAbsolute(c)) {
          cwd = c;
          break;
        }
      } catch {}
    }
    if (!cwd || !path.isAbsolute(cwd)) return null;
    const root = mainFolder(cwd);
    const project = cleanName(path.resolve(root) === os.homedir() ? 'home' : path.basename(root));
    const active =
      Boolean(meta.live) ||
      meta.discovered ||
      Date.now() - Math.max(Date.parse(meta.at) || 0, stat.mtimeMs) < 86400_000;
    const messages = meta.transcript ? parseTranscript(readSlice(file), agent) : [];
    const value = {
      id,
      agent,
      project,
      state:
        active && meta.state !== 'ended'
          ? ['busy', 'idle'].includes(meta.state)
            ? meta.state
            : 'unknown'
          : 'ended',
      at: new Date(Math.max(Date.parse(meta.at) || 0, stat.mtimeMs)).toISOString(),
      messages,
      cwd,
      title: clean(meta.title || messages.find((x) => x.kind === 'user')?.text || id).slice(0, 100),
      file,
      meta,
    };
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    cache.set(id, { key, value });
    return value;
  } catch {
    return null;
  }
}
function protectedImageIds({ includeCompleted = false } = {}) {
  const protectedIds = new Set(),
    root = path.join(HOME, 'state/app-deliveries');
  let folders = [];
  try {
    folders = fs.readdirSync(root);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const id of folders.filter((x) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(x))) {
    const folder = path.join(root, id);
    if (!fs.lstatSync(folder).isDirectory()) continue;
    const rows = fs
      .readdirSync(folder)
      .filter((x) => /^[a-zA-Z0-9_-]{12,80}\.json$/.test(x))
      .flatMap((f) => {
        try {
          return [
            {
              ...JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')),
              claimed: fs.existsSync(path.join(folder, f + '.claim')),
            },
          ];
        } catch {
          return [];
        }
      });
    const running =
      (codexApp.peek(id).connected && codexApp.peek(id).state !== 'idle') ||
      rows.some((row) =>
        [
          'queued',
          'waiting_connection',
          'paused',
          'dispatching',
          'working',
          'needs_input',
          'uncertain',
        ].includes(row.state)
      );
    for (const row of rows) {
      if (!row.acceptedAt && !row.claimed && ['cancelled', 'expired', 'failed'].includes(row.state)) continue;
      if (
        includeCompleted &&
        !running &&
        (row.state === 'completed' ||
          (['interrupted', 'processing_failed', 'stopped'].includes(row.state) &&
            Date.now() - (row.updatedAt || row.createdAt) > 86400000))
      )
        continue;
      for (const image of row.images || [])
        if (/^[a-f0-9]{40}$/.test(image.id || '')) protectedIds.add(image.id);
    }
  }
  return protectedIds;
}
const sessionImages = new SessionImages({
  dir: path.join(HOME, 'state/session-images'),
  protectedIds: protectedImageIds,
});
export const sessionImageStorage = () => sessionImages.stats();
export const cleanSessionImages = (options) => sessionImages.prune(options);
export function discardSessionImage(id, image) {
  return record(id) && sessionImages.discard(id, image);
}

export function uploadSessionImage(id, image) {
  const r = record(id);
  if (!r || r.agent !== 'codex' || readConfig().terminalSessions?.send !== true) return null;
  return sessionImages.save(id, image);
}
export function readSessionImage(id) {
  const image = sessionImages.read(id);
  return record(image.sid) ? image : null;
}
const appQueue = new AppDeliveryQueue({
  dir: path.join(HOME, 'state/app-deliveries'),
  bridge: codexApp,
  enabled: () => enabled() && readConfig().terminalSessions?.send === true,
  resolve: (id) => record(id),
  resolveImages: (id, images) => sessionImages.resolve(id, images),
  connect: (id, cwd) => codexWake.start(id, cwd),
});
let appWorker;
function startAppWorker() {
  if (appWorker) return;
  appWorker = setInterval(() => {
    appQueue.tick().catch(() => {});
  }, 2000);
  appWorker.unref();
}
// Accepted messages resume after a service restart even with no browser open.
startAppWorker();
const deliveryLabel = (state) =>
  ({
    waiting_receipt: t('Sent to the original session. Waiting for it to accept the message.'),
    queued: t('Queued. Waiting for Codex App to finish its current turn.'),
    waiting_connection: t('Waiting for Codex App to reconnect.'),
    paused: t('Sending is paused in Settings.'),
    dispatching: t('Sending to Codex App…'),
    working: t('Codex is working. Waiting for its reply…'),
    needs_input: t('Codex needs your confirmation. Open Codex App to continue.'),
    completed: t('Codex has finished replying.'),
    failed: t('The message could not be sent to Codex App. Check its connection.'),
    processing_failed: t(
      'Message delivered. Codex encountered an error while working. Check the original conversation.'
    ),
    interrupted: t('Message delivered. Codex was interrupted before finishing.'),
    cancelled: t('Queued message cancelled.'),
    expired: t('The queued message expired without being sent.'),
    stopped: t('Stopped waiting. This does not cancel work already in Codex App.'),
    uncertain: t('Delivery is unconfirmed. Check Codex App before sending again.'),
  })[state] || t('Waiting for Codex App to reconnect.');
export function cancelAppDelivery(id, nonce, stopWaiting = false) {
  return enabled() && ID.test(id) && appQueue.cancel(id, nonce, stopWaiting);
}
export async function refreshSession(id, { transport, waitForApp = true } = {}) {
  let r = record(id);
  if (!r && enabled() && ID.test(id)) {
    discovery.invalidate();
    r = record(id);
  }
  if (!r) return null;
  if (r.agent === 'codex') {
    startAppWorker();
    const observing = codexApp.observe(id, r.cwd);
    if (waitForApp) await observing;
    else observing.catch(() => {});
  } else if (r.meta.live) {
    const target = await discoverTmux(r.meta.live, r.meta.tmux);
    if (target) terminalTargets.set(id, target);
    else terminalTargets.delete(id);
  }
  if (
    r.agent === 'claude' &&
    (r.meta.desktop || !terminalTargets.has(id) || transport === 'claude-remote') &&
    remoteBinding(r).remoteId
  ) {
    await ensureClaudeAuthBroker(HOME);
    await claudeRemote.observe(id, remoteBinding(r));
  }
  return readSession(id);
}
const remoteBinding = (r) => {
  let sinceSequence;
  if (r.agent === 'claude')
    try {
      const dir = path.join(HOME, 'state/session-deliveries', r.id);
      const sequences = fs
        .readdirSync(dir)
        .filter((f) => /^[a-zA-Z0-9_-]{12,80}\.json$/.test(f))
        .flatMap((f) => {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (
              d.transport !== 'claude-remote' ||
              !Number.isSafeInteger(d.sequence) ||
              fs.existsSync(path.join(dir, d.nonce + '.status.json'))
            )
              return [];
            return [d.sequence];
          } catch {
            return [];
          }
        });
      if (sequences.length) sinceSequence = Math.min(...sequences);
    } catch {}
  return {
    cwd: r.cwd,
    remoteId: r.meta.desktop ? r.meta.desktop.remoteId : r.meta.live?.bridgeSessionId || null,
    sinceSequence,
  };
};
function publicRecord(r, full = false) {
  const remote = r.agent === 'claude' ? claudeRemote.peek(r.id, remoteBinding(r)) : null;
  const app =
    r.agent === 'codex'
      ? codexApp.peek(r.id, r.cwd)
      : remote?.events
        ? {
            ...remote,
            messages: parseTranscript(
              remote.events
                .map((e) => JSON.stringify({ ...e.payload, timestamp: e.payload.timestamp || e.created_at }))
                .join('\n'),
              'claude'
            ),
          }
        : { connected: false, reason: remote?.reason };
  let state = app.connected ? app.state : r.state;
  const appActivity = app.connected
    ? Math.max(0, ...(app.turns || []).map((turn) => turn.startedAt || 0))
    : 0;
  const remoteBusy = r.agent === 'claude' && app.connected && state !== 'idle';
  const connection = r.agent === 'codex' && !app.connected ? codexWake.peek(r.id) : null;
  const canConnect =
    wakeEligible(r) && !['app_mismatch', 'app_incompatible', 'app_history_limit'].includes(app.reason);
  if (!app.connected && r.meta.tmux?.process?.pid)
    try {
      process.kill(r.meta.tmux.process.pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') state = 'ended';
    }
  return {
    id: r.id,
    agent: r.agent,
    project: r.project,
    state,
    at: new Date(Math.max(Date.parse(r.at) || 0, appActivity)).toISOString(),
    title:
      r.title === r.id
        ? t('Session updated {time}', {
            time: new Date(r.at).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' }),
          })
        : r.title,
    preview:
      r.messages
        .filter((x) => x.text)
        .at(-1)
        ?.text.slice(0, 160) || '',
    canConnect,
    connection,
    canSend:
      readConfig().terminalSessions?.send === true &&
      !remoteBusy &&
      state !== 'ended' &&
      (app.connected || Boolean(r.meta.tmux?.process)),
    transport: app.connected
      ? r.agent === 'codex'
        ? 'codex-app'
        : 'claude-remote'
      : r.meta.tmux?.process
        ? 'tmux'
        : null,
    appUrl:
      r.agent === 'claude' && /^(?:session|cse)_[A-Za-z0-9]{8,120}$/.test(remoteBinding(r).remoteId || '')
        ? 'claude://code/' + remoteBinding(r).remoteId.replace(/^cse_/, 'session_')
        : null,
    sendReason:
      state === 'ended' && !canConnect
        ? 'ended'
        : readConfig().terminalSessions?.send !== true
          ? 'disabled'
          : remoteBusy
            ? 'claude_busy'
            : !app.connected && !r.meta.tmux?.process
              ? connection?.reason || app.reason || 'not_connected'
              : null,
    ...(full
      ? {
          messages: app.messages?.length
            ? app.messages.map((row) => {
                const visible = row.kind === 'user' ? visibleUserMessage(row.text) : { text: row.text };
                return {
                  ...row,
                  text: clean(visible.text),
                  ...(visible.attachments ? { attachments: visible.attachments } : {}),
                };
              })
            : r.messages,
          deliveries: [
            ...(r.agent === 'codex'
              ? appQueue.list(r.id).map((row) => ({ ...row, label: deliveryLabel(row.state) }))
              : []),
            ...terminalDeliveries(r).map((row) => ({
              ...row,
              label: r.agent === 'codex' ? codexTerminalLabel(row.state) : terminalLabel(row.state),
            })),
          ]
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((row) => ({ ...row, text: clean(row.text) })),
        }
      : {}),
  };
}
const codexTerminalLabel = (state) =>
  state === 'failed'
    ? t('Codex stopped with an error. Check the original terminal.')
    : state === 'uncertain'
      ? t('The session has not confirmed this message. Check the original session before retrying.')
      : deliveryLabel(state);
const terminalLabel = (state) =>
  ({
    waiting_receipt: t('Sent to the original session. Waiting for it to accept the message.'),
    working: t('Claude Code is working. Waiting for its reply…'),
    completed: t('Claude Code replied.'),
    failed: t('Claude Code stopped with an error. Check the conversation for details.'),
    not_sent: t('This message was not sent. Restore the connection and try again.'),
    interrupted: t('Another message or an interruption ended this wait. Check the conversation.'),
    uncertain: t('The session has not confirmed this message. Check the original session before retrying.'),
  })[state] || t('Waiting for the conversation to update.');
function terminalDeliveries(r) {
  const dir = path.join(HOME, 'state/session-deliveries', r.id);
  try {
    const rows = fs
      .readdirSync(dir)
      .filter((f) => /^[a-zA-Z0-9_-]{12,80}\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .filter((d) => d.createdAt && d.text)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-10);
    const raw = (r.meta.transcript ? readSlice(r.file) : '').split('\n').flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    return rows.map((d) => {
      const receipt = path.join(dir, d.nonce + '.status.json');
      let saved;
      try {
        saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      } catch {}
      const state = ['completed', 'failed', 'interrupted'].includes(saved?.state)
        ? saved.state
        : d.safeRetry
          ? 'not_sent'
          : d.transport === 'claude-remote'
            ? remoteDeliveryState(claudeRemote.peek(r.id, remoteBinding(r)).events || [], d)
            : terminalDeliveryState(raw, d, r.agent);
      if (['completed', 'failed', 'interrupted'].includes(state) && saved?.state !== state) {
        const tmp = receipt + '.' + crypto.randomUUID() + '.tmp';
        try {
          fs.writeFileSync(tmp, JSON.stringify({ state }), { mode: 0o600 });
          fs.renameSync(tmp, receipt);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      }
      return {
        nonce: d.nonce,
        text: d.text,
        state,
        createdAt: d.createdAt,
        transport: d.transport || 'tmux',
      };
    });
  } catch {
    return [];
  }
}
function hookFiles() {
  try {
    return fs.readdirSync(ROOT).filter((f) => f.endsWith('.json') && ID.test(f.slice(0, -5)));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
export function listSessions(project) {
  if (!enabled()) return [];
  const candidates = new Map();
  for (const m of discovery.all()) candidates.set(m.id, m);
  try {
    for (const file of hookFiles()) {
      const id = file.slice(0, -5);
      if (!candidates.has(id))
        try {
          candidates.set(id, { ...JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')), id });
        } catch {}
    }
  } catch {}
  const folders = new Map();
  const rootOf = (cwd) => {
    if (!folders.has(cwd)) folders.set(cwd, canonicalProject(cwd));
    return folders.get(cwd);
  };
  return [...candidates.values()]
    .flatMap((m) => {
      const root = rootOf(m.cwd || m.launchCwd || '');
      if (
        project &&
        root &&
        cleanName(path.resolve(root) === os.homedir() ? 'home' : path.basename(root)) !== project
      )
        return [];
      let time = Date.parse(m.at) || 0;
      try {
        time = Math.max(time, fs.statSync(m.transcript || m.desktop.file).mtimeMs);
      } catch {}
      return [{ id: m.id, time }];
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, 100)
    .map((x) => record(x.id))
    .filter((r) => r && (!project || r.project === project))
    .map((r) => publicRecord(r));
}
// A project name is not an identity: different folders can share the same basename.
export function articleSessions(project, ver) {
  if (ver.remote || !ver.cwd) return [];
  const known = new Map(listSessions(project).map((s) => [s.id, s]));
  if (enabled())
    for (const meta of discovery
      .forProject(ver.cwd)
      .map((m) => {
        let time = Date.parse(m.at) || 0;
        try {
          time = Math.max(time, fs.statSync(m.transcript || m.desktop.file).mtimeMs);
        } catch {}
        return { meta: m, time };
      })
      .sort((a, b) => b.time - a.time)
      .slice(0, 100)
      .map((x) => x.meta)) {
      const r = record(meta.id);
      if (r) known.set(r.id, publicRecord(r));
    }
  if (ver.session) {
    const original = record(ver.session);
    if (original) known.set(original.id, publicRecord(original));
  }
  const sessions = [...known.values()]
    .filter((s) => sessionMatches(s.id, ver.cwd))
    .map((s) => ({ ...s, original: s.id === ver.session }))
    .sort(
      (a, b) =>
        Number(a.state === 'ended') - Number(b.state === 'ended') ||
        Date.parse(b.at) - Date.parse(a.at) ||
        a.id.localeCompare(b.id)
    );
  const active = new Set();
  return sessions.map((s) => {
    const current = s.state !== 'ended' && !active.has(s.agent);
    if (current) active.add(s.agent);
    return { ...s, current };
  });
}
export function projectConversationContext(project, articles, fallback = null) {
  if (!enabled()) return { scope: null, sessions: [] };
  if (fallback?.remote) return { scope: null, sessions: [], reason: 'project_remote' };
  const candidates = articles.filter((m) => m.project === project).flatMap((m) => m.versions || []);
  const roots = new Map();
  for (const ver of [...(fallback ? [fallback] : []), ...candidates]) {
    if (ver.remote || !ver.cwd) continue;
    const root = canonicalProject(ver.cwd);
    if (root)
      try {
        if (fs.statSync(root).isDirectory() && !roots.has(root)) roots.set(root, ver);
      } catch {}
  }
  const anchor = fallback?.cwd && canonicalProject(fallback.cwd);
  const root = anchor && roots.has(anchor) ? anchor : roots.size === 1 ? roots.keys().next().value : null;
  if (!root)
    return { scope: null, sessions: [], reason: roots.size > 1 ? 'project_ambiguous' : 'project_missing' };
  const scope = crypto
    .createHash('sha256')
    .update(project + '\0' + root)
    .digest('hex')
    .slice(0, 24);
  const sessions = articleSessions(project, roots.get(root));
  return {
    scope,
    sessions,
    ...(!sessions.length && discovery.pendingIndexing ? { reason: 'discovering' } : {}),
  };
}
export function sessionMatches(id, cwd) {
  const r = record(id);
  if (!r || typeof cwd !== 'string') return false;
  try {
    const root = canonicalProject(cwd);
    return Boolean(root) && root === canonicalProject(r.cwd);
  } catch {
    return false;
  }
}
export function readSession(id) {
  const r = record(id);
  return r ? publicRecord(r, true) : null;
}
// This is intentionally strict. An empty prompt must be at the live cursor row,
// not an old prompt somewhere in scrollback. Screen inspection is not a protocol.
export function guardTmux(x, target, pending) {
  if (
    x.pane !== target.pane ||
    x.tty !== target.tty ||
    !/^claude(?:\.exe)?$|^codex(?:\.exe)?$/.test(x.command) ||
    x.dead ||
    x.inputOff ||
    x.inMode ||
    x.synchronized ||
    x.bracketed === false ||
    (target.agent && !x.command.startsWith(target.agent)) ||
    (target.serverPid && Number(x.serverPid) !== Number(target.serverPid))
  )
    return 'target';
  if (pending) return 'approval';
  if (Date.now() / 1000 - Number(x.lastInput || 0) < 10) return 'typing';
  const lines = x.screen.split('\n');
  const tail = lines.slice(-12).join('\n');
  if (
    /(?:enter to (?:select|confirm)|esc(?:ape)? to cancel|yes.*no.*cancel|允许一次|始终允许|确认执行)/i.test(
      tail
    )
  )
    return 'dialog';
  const line = Number.isInteger(x.cursorY) ? lines[x.cursorY] : null;
  if (!/^\s*[❯›]\s*$/.test(line || '')) return 'draft';
  return null;
}
const errors = () => ({
  target: t('This terminal is no longer connected to this session.'),
  approval: t('Answer the pending approval before sending a message.'),
  typing: t('You recently typed in this terminal. Wait 10 seconds and try again.'),
  dialog: t('The terminal may be showing a confirmation. Check it before sending.'),
  draft: t('The terminal input is not confirmed empty. Check it before sending.'),
});
// Claude publishes a PID + process-start + session mapping. Match its TTY to a
// pane instead of guessing from a folder name or the newest transcript.
async function discoverTmux(live, registered) {
  const bin = tmuxBinary(),
    info = processIdentity(live.pid);
  if (!bin || !info || info.started !== live.process.started || info.tty === '??') return null;
  try {
    const socketArgs =
      registered?.socket && path.isAbsolute(registered.socket) ? ['-S', registered.socket] : [];
    const { stdout } = await run(
      bin,
      [
        '-u',
        ...socketArgs,
        'list-panes',
        '-a',
        '-F',
        '#{pane_id}|#{pane_tty}|#{socket_path}|#{pid}|#{pane_current_command}',
      ],
      { timeout: 2000 }
    );
    for (const line of stdout.trim().split('\n')) {
      const fields = line.split('|');
      if (fields.length !== 5) continue;
      const [pane, tty, socket, serverPid, command] = fields;
      if (tty?.replace(/^\/dev\//, '') !== info.tty || !/^claude(?:\.exe)?$/.test(command)) continue;
      if (live.tmux && !live.tmux.endsWith('.' + pane)) continue;
      return { pane, tty, socket, serverPid: Number(serverPid), process: info };
    }
  } catch {}
  return null;
}
async function tmuxSnapshot(target, bin) {
  const args = ['-u', '-S', target.socket];
  const { stdout } = await run(
    bin,
    [
      ...args,
      'display-message',
      '-p',
      '-t',
      target.pane,
      '#{pane_id}|#{pane_tty}|#{pane_current_command}|#{pane_dead}|#{pane_in_mode}|#{synchronize-panes}|#{bracket_paste_flag}|#{cursor_y}|#{pid}|#{pane_input_off}',
    ],
    { timeout: 2000 }
  );
  const [pane, tty, command, dead, inMode, sync, bracketed, cursor, serverPid, inputOff] = stdout
    .trimEnd()
    .split('|');
  const clients = await run(bin, [...args, 'list-clients', '-F', '#{client_activity}'], { timeout: 2000 });
  const captured = await run(bin, [...args, 'capture-pane', '-p', '-t', target.pane], {
    timeout: 2000,
    maxBuffer: 256 * 1024,
  });
  return {
    pane,
    tty,
    command,
    serverPid,
    inputOff: inputOff === '1',
    dead: dead === '1',
    inMode: inMode !== '0',
    synchronized: sync === '1' || sync === 'on',
    bracketed: bracketed === '1' ? true : bracketed === '0' ? false : null,
    cursorY: Number(cursor),
    lastInput: Math.max(0, ...clients.stdout.trim().split('\n').map(Number).filter(Number.isFinite)),
    screen: captured.stdout,
  };
}
const sending = new Set();
export async function sendSession(id, { text, nonce, images = [] }) {
  if (!enabled() || readConfig().terminalSessions?.send !== true)
    return { ok: false, status: 403, error: t('Session messaging is turned off.') };
  await refreshSession(id, { waitForApp: false });
  const r = record(id);
  if (!r) return { ok: false, status: 404, error: t('This session is not available.') };
  let attachments;
  try {
    attachments = sessionImages.resolve(id, images);
  } catch {
    return {
      ok: false,
      status: 400,
      error: t('Choose PNG, JPEG, WebP or GIF images, up to 5 MB each (4 images max).'),
    };
  }
  if (
    typeof text !== 'string' ||
    (!text.trim() && !attachments.length) ||
    text.length > 12000 ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(text)
  )
    return {
      ok: false,
      status: 400,
      error: t('Enter a message of up to 12000 characters without control characters.'),
    };
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(nonce || ''))
    return { ok: false, status: 400, error: t('Invalid message identifier.') };
  if (r.agent === 'codex') {
    const prior = appQueue.list(id).some((row) => row.nonce === nonce);
    const app = wakeEligible(r) ? codexApp.peek(id, r.cwd) : await codexApp.observe(id, r.cwd);
    if (
      prior ||
      app.connected ||
      (wakeEligible(r) && !['app_mismatch', 'app_incompatible', 'app_history_limit'].includes(app.reason))
    ) {
      try {
        const delivery = appQueue.enqueue(id, { text, nonce, images: attachments });
        if (!app.connected && !['cancelled', 'expired', 'failed', 'completed'].includes(delivery.state))
          codexWake.start(id, r.cwd);
        startAppWorker();
        return {
          ok: true,
          status: 202,
          transport: 'codex-app',
          delivery: { ...delivery, label: deliveryLabel(delivery.state) },
        };
      } catch (error) {
        return {
          ok: false,
          status: 409,
          error:
            error.message === 'nonce-mismatch'
              ? t('This message identifier was already used for different text.')
              : t('The Codex message queue is full. Wait for a reply or cancel a queued message.'),
        };
      }
    }
  }
  if (attachments.length)
    return { ok: false, status: 409, error: t('Images require a connected Codex App conversation.') };
  if (r.agent === 'claude' && claudeRemote.peek(id, remoteBinding(r)).connected)
    return sendClaudeRemote(r, { text, nonce });
  if (r.state === 'ended') return { ok: false, status: 409, error: t('This session has ended.') };
  const target = r.meta.tmux ? { ...r.meta.tmux, agent: r.agent } : null,
    bin = tmuxBinary();
  if (!target || !bin || !/^%\d+$/.test(target.pane || '') || !path.isAbsolute(target.socket || ''))
    return {
      ok: false,
      status: 409,
      error: t('This session is view-only. A verified tmux terminal is required.'),
    };
  try {
    const socket = fs.statSync(target.socket);
    if (!socket.isSocket() || (typeof process.getuid === 'function' && socket.uid !== process.getuid()))
      throw Error();
  } catch {
    return { ok: false, status: 409, error: t('This terminal is no longer connected to this session.') };
  }
  if (sending.has(id))
    return { ok: false, status: 409, error: t('A message is already being handed to this terminal.') };
  sending.add(id);
  const dir = path.join(HOME, 'state/session-deliveries', id),
    file = path.join(dir, nonce + '.json');
  let handed = false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return saved.hash === hash
        ? saved.result
        : {
            ok: false,
            status: 409,
            error: t('This message identifier was already used for different text.'),
          };
    }
    const hasPending = () => pendingPrompts().some((p) => p.session === id);
    const processOk = () => {
      const old = target.process,
        now = old && processIdentity(old.pid);
      return (
        now &&
        now.started === old.started &&
        now.tty === target.tty.replace(/^\/dev\//, '') &&
        (now.command === r.agent || now.command === r.agent + '.exe')
      );
    };
    if (!processOk()) return { ok: false, status: 409, error: errors().target };

    let snapshot = await tmuxSnapshot(target, bin);
    let reason = guardTmux(snapshot, target, hasPending());
    if (reason) return { ok: false, status: 409, error: errors()[reason] };
    // Re-read registry and screen immediately before handing off; never retry keys.
    discovery.invalidate();
    const current = record(id);
    const other = hookFiles()
      .filter((f) => f.endsWith('.json') && f !== id + '.json')
      .some((f) => {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
          return (
            m.tmux?.pane === target.pane &&
            m.tmux?.socket === target.socket &&
            Date.parse(m.at) > Date.parse(r.meta.at)
          );
        } catch {
          return false;
        }
      });
    if (
      other ||
      current?.meta.tmux?.pane !== target.pane ||
      current?.meta.tmux?.tty !== target.tty ||
      current.meta.tmux.socket !== target.socket ||
      (r.meta.live && current.meta.live?.sessionId !== r.meta.live.sessionId)
    )
      return { ok: false, status: 409, error: errors().target };
    snapshot = await tmuxSnapshot(target, bin);
    reason = guardTmux(snapshot, target, hasPending());
    if (reason) return { ok: false, status: 409, error: errors()[reason] };
    if (!processOk()) return { ok: false, status: 409, error: errors().target };
    const uncertain = {
      ok: false,
      status: 409,
      uncertain: true,
      error: t('Check the terminal before retrying. The previous delivery may have reached it.'),
    };
    const tracking = { hash, nonce, text, createdAt: Date.now(), transport: 'tmux' };
    fs.writeFileSync(file, JSON.stringify({ ...tracking, result: uncertain }), { mode: 0o600, flag: 'wx' });
    const buffer = 'mydash-' + crypto.randomBytes(8).toString('hex');
    try {
      // Buffer stdin avoids shell interpretation; bracketed paste keeps newlines literal.
      await new Promise((resolve, reject) => {
        const child = execFile(
          bin,
          ['-u', '-S', target.socket, 'load-buffer', '-b', buffer, '-'],
          { timeout: 2000 },
          (e) => (e ? reject(e) : resolve())
        );
        child.stdin.on('error', () => {});
        child.stdin.end(text);
      });
      handed = true;
      await run(
        bin,
        [
          '-u',
          '-S',
          target.socket,
          'paste-buffer',
          '-p',
          '-r',
          '-d',
          '-b',
          buffer,
          '-t',
          target.pane,
          ';',
          'send-keys',
          '-t',
          target.pane,
          'Enter',
        ],
        { timeout: 3000 }
      );
    } finally {
      await run(bin, ['-u', '-S', target.socket, 'delete-buffer', '-b', buffer], { timeout: 1000 }).catch(
        () => {}
      );
    }
    const result = { ok: true, status: 200, transport: 'tmux', delivery: 'terminal', nonce };
    fs.writeFileSync(file, JSON.stringify({ ...tracking, result }), { mode: 0o600 });
    return result;
  } catch {
    return {
      ok: false,
      status: 409,
      uncertain: handed,
      error: t('Check the terminal before retrying. The previous delivery may have reached it.'),
    };
  } finally {
    sending.delete(id);
  }
}

async function sendClaudeRemote(r, { text, nonce }) {
  const id = r.id,
    dir = path.join(HOME, 'state/session-deliveries', id),
    file = path.join(dir, nonce + '.json');
  if (sending.has(id))
    return { ok: false, status: 409, error: t('A message is already being handed to this terminal.') };
  sending.add(id);
  try {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    let prior;
    if (fs.existsSync(file)) {
      prior = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prior.hash !== hash)
        return {
          ok: false,
          status: 409,
          error: t('This message identifier was already used for different text.'),
        };
      if (!prior.safeRetry) return prior.result;
    }
    const binding = remoteBinding(r),
      clientId = prior?.clientId || crypto.randomUUID();
    const authorize = () => {
      discovery.invalidate();
      const current = record(id);
      return (
        enabled() &&
        readConfig().terminalSessions?.send === true &&
        current?.cwd === r.cwd &&
        remoteBinding(current).remoteId === binding.remoteId
      );
    };
    if (!authorize()) return { ok: false, status: 409, error: t('This session is not available.') };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tracking = {
      hash,
      nonce,
      text,
      clientId,
      createdAt: Date.now(),
      transport: 'claude-remote',
      remoteId: binding.remoteId,
    };
    const uncertain = {
      ok: false,
      status: 409,
      uncertain: true,
      error: t('The session has not confirmed this message. Check the original session before retrying.'),
    };
    fs.writeFileSync(file, JSON.stringify({ ...tracking, result: uncertain }), {
      flag: prior ? 'w' : 'wx',
      mode: 0o600,
    });
    try {
      const sent = await claudeRemote.start(id, binding, { text, clientId, authorize });
      const result = {
        ok: true,
        status: 202,
        transport: 'claude-remote',
        delivery: { nonce, text, state: 'waiting_receipt', label: terminalLabel('waiting_receipt') },
      };
      fs.writeFileSync(file, JSON.stringify({ ...tracking, ...sent, result }), { mode: 0o600 });
      return result;
    } catch (e) {
      const result = e.uncertain
        ? uncertain
        : {
            ok: false,
            status: 409,
            error: t(
              'Claude Remote Control is unavailable. Check the connection in Claude App and try again.'
            ),
          };
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...tracking,
          safeRetry: !e.uncertain && (e.beforeSend || (e.status && e.status < 500)),
          result,
        }),
        { mode: 0o600 }
      );
      return result;
    }
  } finally {
    sending.delete(id);
  }
}

// Only preview an adjacent response to a marked document message. If another user
// speaks first, leave attribution unresolved rather than guessing.
export function replyAfter(rows, marker) {
  const start = rows.findIndex((r) => r.kind === 'user' && r.text?.startsWith(marker + '\n'));
  if (start < 0) return null;
  for (const r of rows.slice(start + 1)) {
    if (r.kind === 'user') return null;
    if (r.kind === 'assistant') return r.text.slice(0, 400);
  }
  return null;
}
