import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-lan-test-'));
process.env.MYDASH_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const lan = await import('../lib/lan.mjs');

test('a correct code creates a pending request, not an authorized device', () => {
  assert.equal(typeof lan.requestDevice, 'function');
  lan.resetAccess();
  const r = lan.requestDevice({ code: lan.accessCode(), name: 'My phone', ua: 'test', ip: '192.168.1.9', remember: false });
  const cookie = lan.sessionCookie(r.token, { remember: false });
  assert.equal(lan.validSession(cookie), false);
  assert.equal(lan.pairStatus(cookie).state, 'pending');
  const list = lan.accessDevices();
  assert.equal(list.pending.length, 1);
  assert.equal(list.pending[0].name, 'My phone');
  assert.equal(JSON.stringify(list).includes(r.token), false);
  assert.equal(lan.approveDevice(list.pending[0].id), true);
  assert.equal(lan.validSession(cookie), true);
  assert.equal(lan.pairStatus(cookie).state, 'approved');
  assert.equal(lan.revokeDevice(list.pending[0].id), true);
  assert.equal(lan.validSession(cookie), false);
});

test('rejecting a request never grants access, and rotating the code revokes all devices', () => {
  lan.resetAccess();
  const a = lan.requestDevice({ code: lan.accessCode(), name: 'Unknown', ua: '', remember: true });
  const cookie = lan.sessionCookie(a.token, { remember: true });
  assert.equal(lan.rejectDevice(lan.accessDevices().pending[0].id), true);
  assert.equal(lan.pairStatus(cookie).state, 'denied');
  assert.equal(lan.validSession(cookie), false);
  const b = lan.requestDevice({ code: lan.accessCode(), name: 'Known', ua: '', remember: true });
  const second = lan.sessionCookie(b.token, { remember: true });
  lan.approveDevice(lan.accessDevices().pending[0].id);
  assert.equal(lan.validSession(second), true);
  const identity = lan.instanceId();
  lan.resetAccess();
  assert.equal(lan.instanceId(), identity);
  assert.equal(lan.validSession(second), false);
});

test('sessions and pending requests expire on the server', () => {
  lan.resetAccess();
  const r = lan.requestDevice({ code: lan.accessCode(), name: 'Temporary', remember: false });
  const cookie = lan.sessionCookie(r.token, { remember: false });
  const id = lan.accessDevices().pending[0].id;
  lan.approveDevice(id);
  const file = path.join(home, 'state/lan.json');
  const state = JSON.parse(fs.readFileSync(file)); state.sessions[id].expires = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(lan.validSession(cookie), false);
  assert.equal(lan.deviceCount(), 0);
});

test('temporary cookies are not persisted and QR codes keep credentials out of query strings', () => {
  const token = 'x'.repeat(32);
  assert.doesNotMatch(lan.sessionCookie(token, { remember: false }), /Max-Age=/);
  assert.match(lan.sessionCookie(token, { remember: true }), /Max-Age=2592000/);
  assert.match(lan.loginUrl('http://host:4870'), /\/login#code=/);
  assert.equal(new URL(lan.loginUrl('http://host:4870')).search, '');
});

test('expired requests cannot be approved, cancellation removes requests, and legacy sessions are bounded', () => {
  lan.resetAccess();
  const r = lan.requestDevice({ code: lan.accessCode(), name: 'Borrowed computer' });
  const cookie = lan.sessionCookie(r.token);
  assert.equal(lan.logoutSession(cookie), true);
  assert.equal(lan.pairStatus(cookie).state, 'expired');
  assert.equal(lan.approveDevice(r.id), false);
  const p = lan.requestDevice({ code: lan.accessCode() });
  const file = path.join(home, 'state/lan.json');
  let s = JSON.parse(fs.readFileSync(file));
  s.requests[p.id].expires = new Date(Date.now() - 1).toISOString();
  fs.writeFileSync(file, JSON.stringify(s));
  assert.equal(lan.approveDevice(p.id), false);
  s = JSON.parse(fs.readFileSync(file));
  s.sessions[p.id] = { created: new Date(Date.now() - 31 * 86400_000).toISOString() };
  fs.writeFileSync(file, JSON.stringify(s));
  assert.equal(lan.validSession(`${lan.COOKIE}=${p.token}`), false);
  s.sessions[p.id].created = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(s));
  assert.equal(lan.validSession(`${lan.COOKIE}=${p.token}`), true);
  // A foreign installation's cookie is never used as this installation's token.
  assert.equal(lan.validSession(`${lan.COOKIE}_another=${p.token}`), false);
});

test('concurrent CLI/server changes preserve every request without storing raw tokens', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  lan.resetAccess(); const code = lan.accessCode();
  const script = `const m=await import(${JSON.stringify(new URL('../lib/lan.mjs', import.meta.url).href)}); const r=m.requestDevice({code:process.argv[1],ip:process.argv[2]}); if(r.error)process.exit(1); console.log(r.token)`;
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, code, String(i)], { env: { ...process.env, MYDASH_HOME: home } })));
  assert.equal(lan.accessDevices().pending.length, 8);
  const raw = fs.readFileSync(path.join(home, 'state/lan.json'), 'utf8');
  for (const r of results) assert.equal(raw.includes(r.stdout.trim()), false);
});

test('Windows lock creation retries transient sharing violations without losing authorizations', t => {
  lan.resetAccess(); const code = lan.accessCode();
  const existing = lan.requestDevice({ code, name: 'Existing device' });
  assert.equal(lan.approveDevice(existing.id), true);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const write = fs.writeFileSync; let attempts = 0;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (file === path.join(home, 'state/lan.json.lock') && options?.flag === 'wx') {
      const code = ['EPERM', 'EACCES', 'EBUSY'][attempts++];
      if (code) throw Object.assign(new Error('Windows sharing violation'), { code });
    }
    return write(file, data, options);
  });
  try {
    const added = lan.requestDevice({ code, name: 'New device' });
    assert(added.token); assert.equal(attempts, 4);
    assert.equal(lan.accessDevices().pending.length, 1);
    assert.equal(lan.validSession(lan.sessionCookie(existing.token)), true);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

test('persistent Windows lock errors stay bounded and preserve existing state', t => {
  lan.resetAccess(); const code = lan.accessCode(), file = path.join(home, 'state/lan.json');
  const before = fs.readFileSync(file, 'utf8'), write = fs.writeFileSync;
  const lock = file + '.lock', owner = `${process.pid}:another-owner`;
  fs.writeFileSync(lock, owner);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  let clock = Date.now(), attempts = 0;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.mock.method(Date, 'now', () => (clock += 1000));
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (file === path.join(home, 'state/lan.json.lock') && options?.flag === 'wx') {
      attempts++; throw Object.assign(new Error('Lock access denied'), { code: 'EACCES' });
    }
    return write(file, data, options);
  });
  try {
    assert.throws(() => lan.requestDevice({ code }), { code: 'EACCES' });
    assert.equal(attempts, 4);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readFileSync(lock, 'utf8'), owner);
  } finally { Object.defineProperty(process, 'platform', descriptor); fs.rmSync(lock, { force: true }); }
});

test('unrelated Windows lock I/O errors are not retried', t => {
  lan.resetAccess(); const code = lan.accessCode(), write = fs.writeFileSync;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform'); let attempts = 0;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (file === path.join(home, 'state/lan.json.lock') && options?.flag === 'wx') {
      attempts++; throw Object.assign(new Error('Disk I/O failure'), { code: 'EIO' });
    }
    return write(file, data, options);
  });
  try {
    assert.throws(() => lan.requestDevice({ code }), { code: 'EIO' });
    assert.equal(attempts, 1);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

test('live LAN switch, owner approval, revocation and logout protect both ports', { timeout: 35_000 }, async t => {
  const ip = lan.lanAddresses()[0];
  if (!ip) return t.skip('No private LAN interface on this runner');
  const http = await import('node:http');
  const net = await import('node:net');
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { setTimeout: delay } = await import('node:timers/promises');
  async function reserve() {
    const a = net.createServer(); a.listen(0, '127.0.0.1'); await once(a, 'listening');
    const port = a.address().port; await new Promise(r => a.close(r));
    const b = net.createServer();
    try { b.listen(port + 1, '127.0.0.1'); await once(b, 'listening'); await new Promise(r => b.close(r)); return port; }
    catch { return reserve(); }
  }
  const port = await reserve(), fixture = path.join(home, 'server'); fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'config.json'), JSON.stringify({ port, contentPort: port + 1, lan: false, access: 'local', update: { mode: 'off' }, lang: 'en' }));
  const env = { ...process.env, MYDASH_HOME: fixture };
  for (const key of ['MYDASH_DATA', 'MYDASH_PORT', 'MYDASH_CONTENT_PORT', 'MYDASH_BASE_URL', 'MYDASH_REMOTE', 'MYDASH_TOKEN']) delete env[key];
  const server = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
  t.after(async () => { if (server.exitCode === null) { server.kill(); await once(server, 'exit'); } });
  function request(host, route, { method = 'GET', body, cookie, headers = {}, content = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host, port: port + (content ? 1 : 0), path: route, method, timeout: 3000,
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
        let text = ''; res.on('data', b => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers, cookie: res.headers['set-cookie']?.map(x => x.split(';')[0]).join('; ') }));
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end(body);
    });
  }
  async function until(fn) { for (let i = 0; i < 100; i++) { try { if (await fn()) return; } catch {} await delay(40); } throw new Error('server did not become ready: ' + logs); }
  const owner = '127.0.0.1';
  const post = (action, extra = {}, host = owner, cookie) => request(host, '/api/access', { method: 'POST', cookie, body: JSON.stringify({ action, ...extra }), headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' } });
  await until(async () => (await request(owner, '/healthz')).status === 200);
  let response = await post('set', { enabled: true }); assert.equal(response.status, 200);
  let info = JSON.parse(response.text); assert.equal(info.lan, true);
  assert.equal(info.local, `http://127.0.0.1:${port}/`);
  await until(async () => (await request(ip, '/healthz')).status === 200);
  assert.equal((await request(ip, '/api/index')).status, 401);
  const signIn = await request(ip, '/login'); assert.equal(signIn.status, 200); assert.match(signIn.text, /id="lan-login"/);
  assert.equal((await request(ip, '/events')).status, 401);
  assert.equal((await request(ip, '/f/secret/item/v1/index.html', { content: true })).status, 401);
  assert.equal((await request(ip, '/api/pair', { method: 'DELETE' })).status, 405);
  async function apply(name = 'My phone') {
    const data = new URLSearchParams({ code: info.code, device: name });
    const r = await request(ip, '/login', { method: 'POST', body: data.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 303); assert.match(r.headers.location, /^\/pair/); assert.match(r.cookie, /^mydash_session_[a-f0-9]{24}=/);
    assert.equal((await request(ip, '/api/index', { cookie: r.cookie })).status, 401);
    assert.equal((await request(ip, '/f/secret/item/v1/index.html', { content: true, cookie: r.cookie })).status, 401);
    return r.cookie;
  }
  let cookie = await apply();
  const pair = JSON.parse((await request(ip, '/api/pair', { cookie })).text); assert.equal(pair.state, 'pending');
  const waiting = await request(ip, '/pair', { cookie }); assert.equal(waiting.status, 200); assert.match(waiting.text, /id="lan-pair"/);
  assert.equal((await request(ip, '/api/access', { cookie })).status, 401);
  assert.equal((await post('set', { enabled: false }, ip, cookie)).status, 401);
  info = JSON.parse((await request(owner, '/api/access')).text);
  assert.equal(info.pending[0].pairCode, pair.pairCode);
  const id = info.pending[0].id;
  assert.equal((await request(owner, '/api/access', { method: 'POST', body: '{"action":"approve"}', headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await request(owner, '/api/access', { method: 'POST', body: JSON.stringify({ action: 'approve', id }), headers: { 'Content-Type': 'application/json', 'X-Mydash': '1', Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await post('approve', { id })).status, 200);
  assert.doesNotMatch((await request(ip, '/', { cookie })).text, /data-session-feature=/);
  assert.equal(JSON.parse((await request(ip, '/api/pair', { cookie })).text).state, 'approved');
  assert.equal((await request(ip, '/api/index', { cookie })).status, 200);
  assert.equal((await request(ip, '/missing', { cookie, content: true })).status, 404);
  assert.equal((await request(ip, '/api/access', { cookie })).status, 403);
  assert.equal((await post('reset', {}, ip, cookie)).status, 403);
  assert.equal((await request(ip, '/api/sessions/connect', { method: 'POST', cookie, body: JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' }), headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' } })).status, 403);
  const html = (await request(ip, '/', { cookie })).text;
  assert.match(html, /lan-logout/);
  assert.doesNotMatch(html, /name="mydash-local-url"/);
  const eventRequest = http.get({ host: ip, port, path: '/events', headers: { Cookie: cookie } });
  eventRequest.on('error', () => {});
  const [events] = await once(eventRequest, 'response'); events.resume();
  const closed = new Promise(resolve => events.once('close', resolve)); events.on('error', () => {});
  assert.equal((await post('revoke', { id })).status, 200);
  await closed;
  assert.equal((await request(ip, '/api/index', { cookie })).status, 401);
  cookie = await apply('Borrowed computer');
  let logout = await request(ip, '/api/logout', { method: 'POST', cookie, body: '{}', headers: { 'Content-Type': 'application/json', 'X-Mydash': '1' } });
  assert.equal(logout.status, 200);
  assert.equal(JSON.parse((await request(owner, '/api/access')).text).pending.length, 0);
  cookie = await apply('Remember me');
  const pending = JSON.parse((await request(owner, '/api/access')).text).pending[0];
  await post('approve', { id: pending.id });
  logout = await request(ip, '/api/logout', { method: 'POST', cookie, body: '{}', headers: { 'Content-Type': 'application/json', 'X-Mydash': '1' } });
  assert.equal(logout.status, 200); assert.ok(logout.headers['set-cookie'].every(x => /Max-Age=0/.test(x)));
  assert.equal((await request(ip, '/api/index', { cookie })).status, 401);
  cookie = await apply();
  info = JSON.parse((await post('reset')).text); assert.equal(info.pending.length, 0);
  assert.equal(JSON.parse((await request(ip, '/api/pair', { cookie })).text).state, 'expired');
  assert.equal((await post('set', { enabled: false })).status, 200);
  await until(async () => { try { await request(ip, '/healthz'); return false; } catch { return true; } });
  response = await post('set', { enabled: true }); info = JSON.parse(response.text);
  await until(async () => (await request(ip, '/healthz')).status === 200);
  assert.equal((await request(ip, '/api/index', { cookie })).status, 401);
  assert.equal((await request(owner, '/healthz')).status, 200);
});
