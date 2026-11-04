#!/usr/bin/env node
// Read-only support probe, also usable with an existing 0.2.4 installation.
// Never imports sessions.mjs (which starts the durable delivery worker).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const codes = new Set([
  'ECONNREFUSED',
  'EACCES',
  'EPERM',
  'ENOENT',
  'ETIMEDOUT',
  'request-version-mismatch',
  'no-handler-for-request',
  'no-client-found',
  'request-timeout',
  'connect-timeout',
  'insecure-or-missing-socket',
]);
const codeOf = (e) => (codes.has(e.code) ? e.code : codes.has(e.message) ? e.message : 'other-error');
const json = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const result = { readOnly: true, platform: process.platform, connected: false, rpc: [] };
function socketInfo(file) {
  try {
    const st = fs.lstatSync(file);
    return {
      present: true,
      socket: st.isSocket(),
      directory: st.isDirectory(),
      ownedByCurrentUser: st.uid === process.getuid?.(),
      privatePermissions: (st.mode & 0o077) === 0,
    };
  } catch {
    return { present: false };
  }
}
function appVersion() {
  if (process.platform !== 'darwin') return null;
  for (const root of ['/Applications', path.join(os.homedir(), 'Applications')])
    for (const name of ['Codex.app', 'ChatGPT.app']) {
      const file = path.join(root, name, 'Contents/Info.plist');
      if (!fs.existsSync(file)) continue;
      try {
        const get = (key) =>
          execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, file], {
            timeout: 1000,
            stdio: ['ignore', 'pipe', 'ignore'],
          })
            .toString()
            .trim();
        if (get('CFBundleIdentifier') !== 'com.openai.codex') continue;
        const version = get('CFBundleShortVersionString');
        return /^[\w.+-]{1,80}$/.test(version) ? version : null;
      } catch {}
    }
  return null;
}
let bridge;
try {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--session', '--app-dir'].includes(args[i]) || !args[i + 1]) throw Error('invalid-options');
    options[args[i]] = args[i + 1];
  }
  const id = options['--session'];
  if (!UUID.test(id || '')) throw Error('invalid-session');
  const home = process.env.MYDASH_HOME || path.join(os.homedir(), '.mydash');
  const app = path.resolve(options['--app-dir'] || path.join(home, 'app'));
  const { CodexAppBridge } = await import(pathToFileURL(path.join(app, 'lib/codex-app.mjs')).href);
  const { SessionDiscovery } = await import(pathToFileURL(path.join(app, 'lib/session-discovery.mjs')).href);
  const version = json(path.join(app, 'package.json')).version;
  result.mydashVersion = /^[\w.+-]{1,80}$/.test(version || '') ? version : null;
  result.codexAppVersion = appVersion();
  const config = json(path.join(home, 'config.json'));
  result.service = ['none', 'launchd', 'launchd-boot', 'systemd', 'startup'].includes(config.service)
    ? config.service
    : null;
  const record = new SessionDiscovery().get(id) || json(path.join(home, 'state/agents', id + '.json'));
  const cwd = record.launchCwd || record.cwd;
  result.sessionFound = Boolean(cwd && path.isAbsolute(cwd));
  if (!result.sessionFound) throw Error('session-not-found');
  const daemonFile = path.join(app, 'lib/codex-daemon.mjs');
  if (fs.existsSync(daemonFile)) {
    const { CodexDaemonBridge } = await import(pathToFileURL(daemonFile).href);
    const daemon = new CodexDaemonBridge({ timeoutMs: 5000 });
    const request = daemon.request.bind(daemon);
    const allowed = new Set(['initialize', 'thread/read', 'thread/loaded/list', 'thread/turns/list']);
    daemon.request = (method, params, mutation) => {
      if (mutation || !allowed.has(method)) throw Error('diagnostic-write-blocked');
      return request(method, params, false);
    };
    try {
      const view = await daemon.observe(id, cwd);
      result.sharedDaemon = {
        secureSocket: daemon.secure(),
        connected: Boolean(view.connected),
        reason: view.reason || null,
      };
      if (view.connected) {
        result.connected = true;
        result.connectionSource = 'daemon';
        result.reason = null;
      }
    } finally {
      daemon.close();
    }
  }
  if (!result.connected) {
    bridge = new CodexAppBridge({ timeoutMs: 5000 });
    result.socket = socketInfo(bridge.socketPath);
    result.socketDirectory = socketInfo(path.dirname(bridge.socketPath));
    result.secureSocket = bridge.secure();
    const write = bridge.write.bind(bridge),
      request = bridge.request.bind(bridge),
      connect = bridge.connect.bind(bridge);
    const methods = new Set(['initialize', 'thread-follower-read-model-settings', 'thread-owner-discovery']);
    bridge.write = (message) => {
      if (
        !(message.type === 'request' && methods.has(message.method)) &&
        !(message.type === 'broadcast' && message.method === 'thread-stream-following-changed') &&
        message.type !== 'client-discovery-response'
      )
        throw Error('diagnostic-write-blocked');
      return write(message);
    };
    bridge.request = async (...params) => {
      const at = Date.now(),
        row = { method: params[0], version: params[2], targeted: Boolean(params[3]) };
      try {
        const response = await request(...params);
        row.ok = true;
        return response;
      } catch (e) {
        row.ok = false;
        row.code = codeOf(e);
        throw e;
      } finally {
        row.elapsedMs = Date.now() - at;
        result.rpc.push(row);
      }
    };
    bridge.connect = async () => {
      try {
        return await connect();
      } catch (e) {
        result.connectError = codeOf(e);
        throw e;
      }
    };
    const view = await bridge.observe(id, cwd);
    result.connected = Boolean(view.connected);
    result.reason = view.reason || null;
    result.connectionSource = 'desktop';
  }
} catch (e) {
  result.error = ['invalid-options', 'invalid-session', 'session-not-found'].includes(e.message)
    ? e.message
    : 'diagnostic-unavailable';
} finally {
  bridge?.close();
}
result.ok = result.connected;
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.connected ? 0 : 1;
