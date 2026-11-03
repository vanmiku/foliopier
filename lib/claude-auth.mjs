// A login-session helper reads the unlocked keychain for the boot service.
// Access credentials travel only over a private socket, never a disk cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nodePath } from './sys.mjs';
const run = promisify(execFile),
  uid = () => process.getuid?.();
const privateOwned = (file, kind) => {
  try {
    const s = fs.lstatSync(file);
    return s[kind]() && (uid() === undefined || s.uid === uid()) && (s.mode & 0o077) === 0;
  } catch {
    return false;
  }
};
export const authBrokerDir = (home) => path.join(home, 'state/claude-auth');
export async function requestClaudeAccess(dir) {
  const socketPath = path.join(dir, 'access.sock');
  if (!privateOwned(dir, 'isDirectory') || !privateOwned(socketPath, 'isSocket')) return null;
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let data = '',
      done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(4000, () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('end', () => finish(null));
    socket.on('connect', () => socket.write('{"type":"access"}\n'));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 16384) return finish(null);
      if (!data.includes('\n')) return;
      try {
        const r = JSON.parse(data.split('\n')[0]);
        finish(
          typeof r.accessToken === 'string' &&
            r.accessToken.length < 8192 &&
            Number.isFinite(r.expiresAt) &&
            r.expiresAt > Date.now()
            ? { accessToken: r.accessToken, expiresAt: r.expiresAt }
            : null
        );
      } catch {
        finish(null);
      }
    });
  });
}
export async function startClaudeAuthBroker({ dir, readCredential, enabled }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!privateOwned(dir, 'isDirectory')) throw Error('unsafe-broker-directory');
  const socketPath = path.join(dir, 'access.sock');
  try {
    const old = fs.lstatSync(socketPath);
    if (!privateOwned(socketPath, 'isSocket')) throw Error('unsafe-broker-socket');
    const live = await new Promise((resolve) => {
      const s = net.createConnection(socketPath);
      s.setTimeout(300, () => {
        s.destroy();
        resolve(true);
      });
      s.on('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (live) throw Error('broker-already-running');
    if (fs.lstatSync(socketPath).ino !== old.ino) throw Error('broker-socket-changed');
    fs.unlinkSync(socketPath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const server = net.createServer((socket) => {
    let data = '',
      handled = false;
    socket.setTimeout(4500, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', async (chunk) => {
      if (handled) return;
      data += chunk.toString('utf8');
      if (data.length > 128) {
        socket.destroy();
        return;
      }
      if (!data.includes('\n')) return;
      handled = true;
      try {
        if (JSON.parse(data.split('\n')[0]).type !== 'access' || !enabled()) {
          socket.end('{}\n');
          return;
        }
        const c = await readCredential();
        const valid =
          typeof c?.accessToken === 'string' &&
          c.accessToken.length < 8192 &&
          Number.isFinite(c.expiresAt) &&
          c.expiresAt > Date.now();
        socket.end(
          JSON.stringify(valid ? { accessToken: c.accessToken, expiresAt: c.expiresAt } : {}) + '\n'
        );
      } catch {
        socket.end('{}\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  return server;
}
const labelFor = (home) =>
  'mydash.claude-auth' +
  (path.resolve(home) === path.join(os.homedir(), '.mydash')
    ? ''
    : '-' + crypto.createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 8));
const plistFor = (home) => path.join(os.homedir(), 'Library/LaunchAgents', labelFor(home) + '.plist');
const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const ensured = new Map();
export async function ensureClaudeAuthBroker(home) {
  if (process.platform !== 'darwin' || process.env.MYDASH_CLAUDE_HOME || process.env.MYDASH_CLAUDE_PROJECTS)
    return false;
  if (Date.now() - (ensured.get(home) || 0) < 60000) return true;
  ensured.set(home, Date.now());
  const script = path.join(home, 'app/bin/claude-auth-broker.mjs');
  if (!fs.existsSync(script)) return false;
  const label = labelFor(home),
    file = plistFor(home);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${escape(nodePath())}</string><string>${escape(script)}</string></array><key>EnvironmentVariables</key><dict><key>MYDASH_HOME</key><string>${escape(home)}</string><key>HOME</key><string>${escape(os.homedir())}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Interactive</string></dict></plist>\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== xml)
      fs.writeFileSync(file, xml, { mode: 0o600 });
    try {
      await run('/bin/launchctl', ['print', `gui/${uid()}/${label}`], { timeout: 2000 });
      return true;
    } catch {}
    await run('/bin/launchctl', ['bootstrap', `gui/${uid()}`, file], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
export async function removeClaudeAuthBroker(home) {
  if (process.platform !== 'darwin') return;
  await run('/bin/launchctl', ['bootout', `gui/${uid()}/${labelFor(home)}`], { timeout: 3000 }).catch(
    () => {}
  );
  fs.rmSync(plistFor(home), { force: true });
  fs.rmSync(authBrokerDir(home), { recursive: true, force: true });
}
