// HTTPS readiness is deliberately ephemeral. A saved URL is a candidate, never
// evidence that its certificate and both isolated origins are still usable.
export class HttpsAccess {
  constructor({
    config,
    installationId,
    fetch = globalThis.fetch,
    now = Date.now,
    ttlMs = 30000,
    timeoutMs = 2500,
    contentPort,
  } = {}) {
    Object.assign(this, { config, installationId, fetch, now, ttlMs, timeoutMs, contentPort });
    this.result = null;
    this.pending = null;
  }
  target() {
    const c = this.config();
    if (!c.httpsUrl || c.access === 'local') return { state: 'unconfigured', key: '' };
    try {
      const u = new URL(c.httpsUrl),
        names = c.tailnetNames || [];
      const port =
        this.contentPort?.() ||
        Number(c.httpsContentPort || Number(c.contentPort || Number(c.port || 4870) + 1) + 1);
      if (
        u.protocol !== 'https:' ||
        u.username ||
        u.password ||
        u.pathname !== '/' ||
        u.search ||
        u.hash ||
        !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(u.hostname) ||
        !names.some((n) => n.toLowerCase() === u.hostname || n.toLowerCase() === u.hostname.split('.')[0]) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        port === Number(u.port || 443)
      )
        throw Error();
      const content = new URL(u.origin);
      content.port = String(port);
      const main = u.origin;
      return {
        state: 'checking',
        main,
        content: content.origin,
        hostname: u.hostname,
        names,
        key: JSON.stringify([main, content.origin, names, c.access]),
      };
    } catch {
      return { state: 'invalid', key: '' };
    }
  }
  peek() {
    const t = this.target(),
      current = this.result;
    const fresh = current?.key === t.key && this.now() - current.checkedAt < this.ttlMs;
    return {
      state: t.key ? (fresh ? current.state : 'checking') : t.state,
      reason: fresh ? current.reason : null,
      checkedAt: fresh ? current.checkedAt : null,
      httpsUrl: t.main || '',
      redirectEnabled: this.config().httpsRedirect !== false,
    };
  }
  refresh({ force = false } = {}) {
    const t = this.target();
    if (!t.key) return Promise.resolve(this.peek());
    if (this.pending?.key === t.key) return this.pending.promise;
    const current = this.result;
    if (current?.key === t.key && this.now() - current.checkedAt < (force ? 5000 : this.ttlMs))
      return Promise.resolve(this.peek());
    const check = async (origin, side) => {
      try {
        // Native fetch verifies TLS normally. Never follow redirects to another host.
        const r = await this.fetch(origin + '/healthz', {
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        r.body?.cancel().catch(() => {});
        if (r.status !== 200) return side;
        return r.headers.get('x-mydash-id') === this.installationId ? null : 'identity';
      } catch (e) {
        return /CERT|TLS|SSL|ISSUER|SELF_SIGNED/.test(e.cause?.code || e.code || '') ? 'certificate' : side;
      }
    };
    const promise = Promise.all([check(t.main, 'workbench'), check(t.content, 'content')])
      .then((reasons) => {
        if (this.target().key === t.key) {
          const reason = reasons.find(Boolean) || null;
          this.result = {
            key: t.key,
            checkedAt: this.now(),
            state: reason ? 'unavailable' : 'ready',
            reason,
          };
        }
        return this.peek();
      })
      .finally(() => {
        if (this.pending?.promise === promise) this.pending = null;
      });
    this.pending = { key: t.key, promise };
    return promise;
  }
  redirect(req) {
    const c = this.config(),
      t = this.target();
    if (
      c.httpsRedirect === false ||
      this.peek().state !== 'ready' ||
      req.mydashWhere === 'lan' ||
      !['GET', 'HEAD'].includes(req.method) ||
      req.headers['x-forwarded-proto'] === 'https'
    )
      return null;
    let from;
    try {
      from = new URL(req.url, 'http://local');
    } catch {
      return null;
    }
    if (from.pathname.startsWith('/api/') || from.pathname === '/healthz') return null;
    let host;
    try {
      host = new URL('http://' + req.headers.host);
    } catch {
      return null;
    }
    if (
      ![t.hostname, ...t.names].includes(host.hostname) ||
      !['', '80', String(c.publicPort || 80)].includes(host.port)
    )
      return null;
    return t.main + from.pathname + from.search;
  }
}
