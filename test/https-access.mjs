import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../lib/https-access.mjs').catch(() => ({}));
const config = () => ({
  access: 'tailscale-node',
  tailnetNames: ['mydash'],
  httpsUrl: 'https://mydash.tail123.ts.net',
  httpsContentPort: 4872,
});
const req = (host = 'mydash', url = '/p/project/article?f=report.md') => ({
  method: 'GET',
  headers: { host },
  url,
  mydashWhere: 'tailnet',
});
function fixture(fetch) {
  let cfg = config(),
    now = 1000;
  assert.equal(typeof api.HttpsAccess, 'function');
  const gate = new api.HttpsAccess({
    config: () => cfg,
    installationId: 'this-install',
    fetch: fetch || (async () => ({ status: 200, headers: new Headers({ 'x-mydash-id': 'this-install' }) })),
    now: () => now,
    ttlMs: 30000,
  });
  return {
    gate,
    set: (v) => {
      cfg = v;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}
test('HTTPS redirect requires both verified origins and preserves the original path', async () => {
  const calls = [],
    f = fixture(async (url, opts) => {
      calls.push({ url, opts });
      return { status: 200, headers: new Headers({ 'x-mydash-id': 'this-install' }) };
    });
  assert.equal(f.gate.redirect(req()), null);
  await f.gate.refresh();
  assert.equal(f.gate.redirect(req()), 'https://mydash.tail123.ts.net/p/project/article?f=report.md');
  assert.deepEqual(calls.map((x) => x.url).sort(), [
    'https://mydash.tail123.ts.net/healthz',
    'https://mydash.tail123.ts.net:4872/healthz',
  ]);
  assert.ok(calls.every((x) => x.opts.redirect === 'manual' && x.opts.signal));
});
test('wrong installation, content failure, certificate failure and redirect responses retain HTTP', async () => {
  for (const mode of ['wrong', 'content', 'certificate', 'redirect']) {
    const f = fixture(async (url) => {
      if (mode === 'certificate') throw Object.assign(Error(), { cause: { code: 'CERT_HAS_EXPIRED' } });
      return {
        status: mode === 'redirect' ? 302 : mode === 'content' && url.includes(':4872') ? 503 : 200,
        headers: new Headers({ 'x-mydash-id': mode === 'wrong' ? 'another-install' : 'this-install' }),
      };
    });
    await f.gate.refresh();
    assert.equal(f.gate.redirect(req()), null);
    assert.equal(f.gate.peek().state, 'unavailable');
  }
});
test('stale readiness and a renamed device immediately stop redirecting', async () => {
  const f = fixture();
  await f.gate.refresh();
  f.advance(30001);
  assert.equal(f.gate.redirect(req()), null);
  await f.gate.refresh();
  assert.ok(f.gate.redirect(req()));
  f.set({ ...config(), tailnetNames: ['mydash-2'] });
  assert.equal(f.gate.redirect(req()), null);
});
test('configuration changes cannot be overwritten by an obsolete probe and concurrent probes are shared', async () => {
  let release,
    calls = 0;
  const wait = new Promise((r) => (release = r));
  const f = fixture(async () => {
    calls++;
    await wait;
    return { status: 200, headers: new Headers({ 'x-mydash-id': 'this-install' }) };
  });
  const a = f.gate.refresh(),
    b = f.gate.refresh();
  f.set({ ...config(), httpsUrl: 'https://mydash.tail456.ts.net' });
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 2);
  assert.equal(f.gate.redirect(req()), null);
  await f.gate.refresh();
  assert.match(f.gate.redirect(req()), /tail456/);
});
test('local, LAN, API, health, write and already-HTTPS requests never redirect', async () => {
  const f = fixture();
  await f.gate.refresh();
  for (const r of [
    req('127.0.0.1:4870'),
    req('localhost:4870'),
    req('another.tail123.ts.net'),
    req('mydash', '/api/settings'),
    req('mydash', '/healthz'),
    { ...req(), method: 'POST' },
    { ...req(), mydashWhere: 'lan' },
    { ...req(), headers: { host: 'mydash', 'x-forwarded-proto': 'https' } },
  ])
    assert.equal(f.gate.redirect(r), null);
  f.set({ ...config(), httpsRedirect: false });
  assert.equal(f.gate.redirect(req()), null);
  assert.equal(f.gate.peek().state, 'ready');
});
test('invalid, credentialed, wrong-host and non-HTTPS targets are not probed', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw Error('must not fetch');
  });
  for (const url of [
    'http://mydash.tail123.ts.net',
    'https://another.tail123.ts.net',
    'https://user:pass@mydash.tail123.ts.net',
    'https://mydash.tail123.ts.net/path',
    'https://external.example',
  ]) {
    f.set({ ...config(), httpsUrl: url });
    await f.gate.refresh();
    assert.equal(f.gate.redirect(req()), null);
  }
  assert.equal(calls, 0);
});

test('server retains HTTP for stale HTTPS and saves a strictly boolean preference without changing agent permissions', async (t) => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path'),
    net = await import('node:net'),
    { spawn } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-https-'));
  const port = async () => {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    return p;
  };
  const main = await port(),
    content = await port(),
    cfg = {
      port: main,
      contentPort: content,
      access: 'tailscale-node',
      tailnetNames: ['redirect-test'],
      httpsUrl: 'https://redirect-test.tail0.ts.net',
      terminalSessions: { enabled: true, send: false },
    };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  const child = spawn(process.execPath, ['server.mjs'], {
    env: {
      ...process.env,
      MYDASH_HOME: home,
      MYDASH_PORT: String(main),
      MYDASH_CONTENT_PORT: String(content),
      MYDASH_LANG: 'en',
      MYDASH_CODEX_HOME: path.join(home, 'codex'),
      MYDASH_CLAUDE_PROJECTS: path.join(home, 'claude'),
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + main;
  let up = false;
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(base + '/healthz')).ok) {
        up = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(up, 'isolated server starts');
  const page = await fetch(base + '/', { headers: { Host: 'redirect-test' }, redirect: 'manual' });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('location'), null);
  const post = (value) =>
    fetch(base + '/api/settings', {
      method: 'POST',
      headers: { 'X-Mydash': '1', 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ httpsRedirect: value }),
    });
  assert.equal((await post(false)).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'))).httpsRedirect, false);
  assert.equal((await post('true')).status, 400);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json')));
  assert.equal(saved.httpsRedirect, false);
  assert.deepEqual(saved.terminalSessions, cfg.terminalSessions);
  const settings = await (await fetch(base + '/settings')).text();
  assert.match(settings, /name="httpsRedirect" data-auto>/);
  assert.match(settings, /id="https-access"/);
  const status = await (await fetch(base + '/api/https-access')).json();
  assert.equal(status.redirectEnabled, false);
  assert.notEqual(status.state, 'ready');
});

test('switching to local access invalidates an already verified network candidate', async () => {
  const f = fixture();
  await f.gate.refresh();
  assert.ok(f.gate.redirect(req()));
  f.set({ ...config(), access: 'local' });
  assert.equal(f.gate.peek().state, 'unconfigured');
  assert.equal(f.gate.redirect(req()), null);
});
