// 局域网访问：新浏览器凭访问码申请，由可信端逐台批准。
// 内容与授权状态只属于这一套安装；会话只存 token 哈希，服务端也检查有效期。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import qrcode from 'qrcode-generator';
import { HOME, readConfig, contentPort } from './store.mjs';
import { t } from './i18n.mjs';

const STATE = path.join(HOME, 'state', 'lan.json');
const REQUEST = new AsyncLocalStorage();
export const withLanRequest = (req, fn) => REQUEST.run(req, fn);
export const isLanRequest = () => REQUEST.getStore()?.mydashWhere === 'lan';
export const COOKIE = 'mydash_session'; // 旧浏览器的 cookie，迁移期仍识别
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REMEMBER = 30 * 86400_000, TEMPORARY = 12 * 3600_000, PENDING = 10 * 60_000;
export function lanEnabled() { return readConfig().lan === true; }
function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const equalCode = (a, b) => { const x = Buffer.from(normCode(a)), y = Buffer.from(normCode(b)); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
const randomCode = n => [...crypto.randomBytes(n)].map(x => ALPHABET[x % ALPHABET.length]).join('');
export const prettyCode = c => `${c.slice(0, 4)}-${c.slice(4)}`;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retryWindows(fn) {
  for (let n = 0; ; n++) {
    try { return fn(); } catch (e) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || n >= 8) throw e;
      sleep(Math.min(25 * 2 ** n, 250));
    }
  }
}
const replace = (from, to) => retryWindows(() => fs.renameSync(from, to));
const remove = file => retryWindows(() => fs.rmSync(file, { force: true }));
// 同步小事务只持锁几毫秒，避免 CLI 换码和浏览器申请/续期互相覆盖，恢复已撤销的权限。
function change(fn) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const lock = STATE + '.lock', owner = `${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
  const started = Date.now();
  for (;;) {
    try { fs.writeFileSync(lock, owner, { flag: 'wx', mode: 0o600 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') {
        // Windows may report a sharing violation while the previous owner removes
        // the lock. Retry creation only; never inspect or remove an unknown owner.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || Date.now() - started > 3000) throw e;
        sleep(10); continue;
      }
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8').split(':')[0]);
        if (pid) { try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') { remove(lock); continue; } } }
        else if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { remove(lock); continue; }
      } catch {}
      if (Date.now() - started > 3000) throw new Error('LAN authorization state is busy');
      sleep(10);
    }
  }
  const tmp = `${STATE}.${process.pid}.tmp`;
  try {
    const s = load(); s.sessions ||= {}; s.requests ||= {};
    for (const [id, x] of Object.entries(s.sessions)) if (expires(x) <= Date.now()) delete s.sessions[id];
    for (const [id, x] of Object.entries(s.requests)) if (!(Date.parse(x.expires) > Date.now())) delete s.requests[id];
    const result = fn(s);
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 }); replace(tmp, STATE);
    return result;
  } finally {
    try { remove(tmp); } catch {}
    try { if (fs.readFileSync(lock, 'utf8') === owner) remove(lock); } catch {}
  }
}
function identity(s) { return s.instanceId ||= crypto.randomBytes(12).toString('hex'); }
export function instanceId() { return load().instanceId || change(identity); }
export const cookieName = () => `${COOKIE}_${instanceId()}`;
export function accessCode() { return load().code || change(s => { identity(s); return s.code = randomCode(8); }); }
export function resetAccess() { return change(s => { identity(s); s.code = randomCode(8); s.sessions = {}; s.requests = {}; return s.code; }); }
export function checkCode(input) { return equalCode(input, accessCode()); }
function expires(x) { const n = x.expires ? Date.parse(x.expires) : Date.parse(x.created) + REMEMBER; return Number.isFinite(n) ? n : 0; }
function tokenHash(header) {
  const cookies = new Map(String(header || '').split(';').map(p => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const token = cookies.get(cookieName()) || cookies.get(COOKIE);
  return /^[A-Za-z0-9_-]{20,}$/.test(token || '') ? hash(token) : null;
}
export function sessionInfo(header) {
  const id = tokenHash(header), x = id && load().sessions?.[id];
  return x && expires(x) > Date.now() ? { id, expires: expires(x) } : null;
}
const touched = new Map();
export function validSession(header) {
  const x = sessionInfo(header); if (!x) return false;
  if (Date.now() - (touched.get(x.id) || 0) > 3600_000) {
    touched.set(x.id, Date.now());
    change(s => { if (s.sessions[x.id]) s.sessions[x.id].seen = new Date().toISOString(); });
  }
  return true;
}
export function sessionCookie(token, { remember = false } = {}) {
  return `${cookieName()}=${token}; HttpOnly; SameSite=Lax; Path=/${remember ? '; Max-Age=2592000' : ''}`;
}
export function clearSessionCookies() { return [cookieName(), COOKIE].map(n => `${n}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`); }
export function deviceName(ua) { return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : t('Browser device'); }
export function requestDevice({ code, name = '', ua = '', ip = '', remember = false }) {
  return change(s => {
    identity(s);
    if (!equalCode(code, s.code)) return { error: 'wrong-code' };
    const pending = Object.values(s.requests).filter(x => x.status === 'pending');
    if (pending.length >= 20 || pending.filter(x => x.ip === ip).length >= 3) return { error: 'too-many' };
    const token = crypto.randomBytes(32).toString('base64url'), id = hash(token), now = new Date().toISOString();
    s.requests[id] = { name: (String(name).trim() || deviceName(ua)).slice(0, 60), ua: String(ua).slice(0, 160), ip: String(ip).slice(0, 64),
      created: now, expires: new Date(Date.now() + PENDING).toISOString(), pairCode: randomCode(6), remember: Boolean(remember), status: 'pending' };
    return { token, id };
  });
}
export function pairStatus(header) {
  const id = tokenHash(header), s = load();
  if (id && s.sessions?.[id] && expires(s.sessions[id]) > Date.now()) return { state: 'approved' };
  const r = id && s.requests?.[id];
  return r && Date.parse(r.expires) > Date.now() ? { state: r.status, pairCode: r.pairCode, name: r.name, expires: r.expires } : { state: 'expired' };
}
export function accessDevices() {
  const s = load(), now = Date.now();
  return {
    pending: Object.entries(s.requests || {}).filter(([, x]) => x.status === 'pending' && Date.parse(x.expires) > now).map(([id, x]) => ({ id, name: x.name, pairCode: x.pairCode, ip: x.ip, created: x.created })),
    authorized: Object.entries(s.sessions || {}).filter(([, x]) => expires(x) > now).map(([id, x]) => ({ id, name: x.name || deviceName(x.ua || ''), created: x.created, seen: x.seen, expires: new Date(expires(x)).toISOString() })),
  };
}
export function approveDevice(id) {
  return change(s => {
    const r = s.requests[id]; if (!r || r.status !== 'pending' || Date.parse(r.expires) <= Date.now()) return false;
    const now = new Date().toISOString();
    s.sessions[id] = { name: r.name, ua: r.ua, created: now, seen: now, expires: new Date(Date.now() + (r.remember ? REMEMBER : TEMPORARY)).toISOString() };
    delete s.requests[id]; return true;
  });
}
export function rejectDevice(id) { return change(s => { if (!s.requests[id]) return false; s.requests[id].status = 'denied'; return true; }); }
export function revokeDevice(id) { return change(s => { const found = Boolean(s.sessions[id]); delete s.sessions[id]; touched.delete(id); return found; }); }
export function logoutSession(header) {
  const id = tokenHash(header); if (!id) return false;
  return change(s => { const found = Boolean(s.sessions[id] || s.requests[id]); delete s.sessions[id]; delete s.requests[id]; touched.delete(id); return found; });
}
export function deviceCount() { return accessDevices().authorized.length; }

// 失败太多次就先挡一会儿（每个 IP 15 分钟内最多 10 次）
const fails = new Map();
export function rateLimited(ip) { const now = Date.now(); const list = (fails.get(ip) || []).filter(t => now - t < 15 * 60_000); fails.set(ip, list); return list.length >= 10; }
export function noteFailure(ip) { const list = fails.get(ip) || []; list.push(Date.now()); fails.set(ip, list); }

// ---------- 请求来自哪里 ----------
function v4(ip) { const m = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i); return m ? m.slice(1).map(Number) : null; }
// 'local' 本机 · 'tailnet' Tailscale · 'lan' 局域网 · 'public' 其他
export function classify(addr) {
  const ip = String(addr || '');
  const a = v4(ip);
  if (a) {
    if (a[0] === 127) return 'local';
    if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return 'tailnet';
    if (a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) || (a[0] === 169 && a[1] === 254)) return 'lan';
    return 'public';
  }
  const x = ip.toLowerCase();
  if (x === '::1') return 'local';
  if (x.startsWith('fd7a:115c:a1e0:')) return 'tailnet';
  if (/^f[cd][0-9a-f]{2}:/.test(x) || /^fe[89ab][0-9a-f]:/.test(x)) return 'lan';
  return 'public';
}

// 这台机器在局域网里的名字和地址
let localHostName = null;
function bonjourName() {
  if (localHostName !== null) return localHostName;
  localHostName = '';
  if (process.platform === 'darwin') { try { localHostName = execFileSync('scutil', ['--get', 'LocalHostName'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim(); } catch {} }
  return localHostName;
}
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const x of list || []) {
      if (x.internal || x.family !== 'IPv4') continue;
      if (classify(x.address) !== 'lan') continue;
      if (/^(bridge|docker|veth|vmnet|utun|awdl|llw|virbr|br-)/.test(name)) continue; // 虚拟机、容器、VPN 的网卡
      out.push(x.address);
    }
  }
  return out;
}
export function lanNames() {
  const names = new Set();
  const h = os.hostname().toLowerCase(); names.add(h.endsWith('.local') ? h : `${h}.local`);
  const b = bonjourName(); if (b) names.add(`${b.toLowerCase()}.local`);
  return [...names];
}
// 局域网来的请求，Host 只能是本机的局域网地址或 .local 名字（防 DNS 重绑定）
export function lanHostOk(host, port) {
  const m = String(host || '').toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m || Number(m[2] || 80) !== Number(port)) return false;
  const name = m[1].replace(/^\[|\]$/g, '');
  if (lanNames().includes(name)) return true;
  for (const list of Object.values(os.networkInterfaces())) for (const x of list || []) if (!x.internal && x.address.toLowerCase() === name) return true;
  return false;
}

export function lanUrls(port = Number(readConfig().port || 4870)) {
  return [...lanNames().map(n => `http://${n}:${port}/`), ...lanAddresses().map(a => `http://${a}:${port}/`)];
}
// 访问码放在片段中，不进入 HTTP 请求或 Referer；扫码后仍需本机批准。
export function loginUrl(base) { return `${base.replace(/\/$/, '')}/login#code=${accessCode()}`; }
export function qrSvg(text) { const qr = qrcode(0, 'M'); qr.addData(text); qr.make(); return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
export function qrAscii(text) { const qr = qrcode(0, 'L'); qr.addData(text); qr.make(); return qr.createASCII(2, 2); }
export { contentPort };
