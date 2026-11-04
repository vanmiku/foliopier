import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const SID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i,
  NONCE = /^[a-zA-Z0-9_-]{12,80}$/;
const active = new Set([
  'queued',
  'waiting_connection',
  'paused',
  'dispatching',
  'working',
  'needs_input',
  'uncertain',
]);
const queued = new Set(['queued', 'waiting_connection', 'paused']);
const digest = (text, images = []) =>
  crypto
    .createHash('sha256')
    .update(text + (images.length ? '\0' + images.map((x) => x.id + ':' + x.sha256).join('|') : ''))
    .digest('hex');
export class AppDeliveryQueue {
  constructor({ dir, bridge, enabled, resolve, resolveImages = (id, images) => images, connect = () => {} }) {
    Object.assign(this, { dir, bridge, enabled, resolve, resolveImages, connect });
    this.rows = new Map();
    this.ticking = false;
    const recent = [];
    try {
      for (const sid of fs.readdirSync(dir).filter((x) => SID.test(x))) {
        const folder = path.join(dir, sid);
        const files = fs
          .readdirSync(folder)
          .filter((x) => x.endsWith('.json') && NONCE.test(x.slice(0, -5)))
          .sort(
            (a, b) => fs.statSync(path.join(folder, b)).mtimeMs - fs.statSync(path.join(folder, a)).mtimeMs
          );
        for (const file of files)
          try {
            const row = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'));
            if (
              row.id !== sid ||
              row.nonce !== file.slice(0, -5) ||
              !NONCE.test(row.nonce) ||
              typeof row.text !== 'string' ||
              row.text.length > 12000 ||
              row.hash !== digest(row.text, row.images || []) ||
              !Number.isFinite(row.createdAt)
            )
              continue;
            if (row.state === 'dispatching') row.state = 'uncertain';
            // Older previews confused an accepted turn's processing error with
            // failure to deliver, then stopped observing its retries.
            if (row.state === 'failed' && row.error === 'app-turn-failed') {
              row.state = 'processing_failed';
              row.acceptedAt ||= row.updatedAt || row.createdAt;
            }
            if (
              active.has(row.state) ||
              (['processing_failed', 'interrupted'].includes(row.state) &&
                Date.now() - (row.updatedAt || row.createdAt) < 86400000)
            )
              this.rows.set(sid + '/' + row.nonce, row);
            else {
              recent.push(row);
              if (recent.length > 400) {
                recent.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
                recent.length = 400;
              }
            }
          } catch {}
      }
    } catch {}
    for (const row of recent) this.rows.set(row.id + '/' + row.nonce, row);
  }
  file(row) {
    return path.join(this.dir, row.id, row.nonce + '.json');
  }
  save(row) {
    const folder = path.dirname(this.file(row));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const tmp = this.file(row) + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(row), { mode: 0o600 });
    fs.renameSync(tmp, this.file(row));
  }
  public(row) {
    return {
      nonce: row.nonce,
      state: row.state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt || row.createdAt,
      text: row.text,
      images: (row.images || []).map(({ id, name, mime, size }) => ({
        id,
        name,
        mime,
        size,
        url: '/api/session-images/' + id,
      })),
      turnId: row.turnId || null,
      error: row.error || null,
      delivered: Boolean(row.acceptedAt),
      transport: 'codex-app',
    };
  }
  list(id) {
    const rows = new Map([...this.rows.values()].filter((x) => x.id === id).map((x) => [x.nonce, x]));
    if (SID.test(id))
      try {
        const folder = path.join(this.dir, id);
        const files = fs
          .readdirSync(folder)
          .filter((f) => f.endsWith('.json') && NONCE.test(f.slice(0, -5)))
          .sort(
            (a, b) => fs.statSync(path.join(folder, b)).mtimeMs - fs.statSync(path.join(folder, a)).mtimeMs
          )
          .slice(0, 20);
        for (const file of files) {
          try {
            const row = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'));
            if (
              row.id === id &&
              row.nonce === file.slice(0, -5) &&
              typeof row.text === 'string' &&
              row.hash === digest(row.text, row.images || []) &&
              !rows.has(row.nonce)
            )
              rows.set(row.nonce, row);
          } catch {}
        }
      } catch {}
    const ordered = [...rows.values()].sort((a, b) => a.createdAt - b.createdAt),
      recent = new Set(ordered.slice(-20));
    return ordered.filter((row) => active.has(row.state) || recent.has(row)).map((row) => this.public(row));
  }
  enqueue(id, { text, nonce, images = [] }) {
    if (
      !SID.test(id) ||
      !NONCE.test(nonce) ||
      typeof text !== 'string' ||
      (!text.trim() && !images.length) ||
      !Array.isArray(images) ||
      images.length > 4 ||
      text.length > 12000
    )
      throw Error('invalid-message');
    const key = id + '/' + nonce,
      prior = this.rows.get(key);
    if (prior) {
      if (prior.hash !== digest(text, images)) throw Error('nonce-mismatch');
      return this.public(prior);
    }
    if ([...this.rows.values()].filter((x) => x.id === id && active.has(x.state)).length >= 5)
      throw Error('queue-full');
    const row = {
      id,
      nonce,
      text,
      hash: digest(text, images),
      images: images.map(({ id, name, mime, size, sha256 }) => ({ id, name, mime, size, sha256 })),
      clientId: crypto.randomUUID(),
      createdAt: Date.now(),
      state: 'queued',
    };
    const folder = path.dirname(this.file(row));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(this.file(row), JSON.stringify(row), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const saved = JSON.parse(fs.readFileSync(this.file(row), 'utf8'));
      if (saved.hash !== row.hash) throw Error('nonce-mismatch');
      this.rows.set(key, saved);
      return this.public(saved);
    }
    this.rows.set(key, row);
    return this.public(row);
  }
  update(row, state, error = null, details = {}) {
    if (row.state === state && row.error === error && Object.entries(details).every(([k, v]) => row[k] === v))
      return;
    Object.assign(row, details, { state, error, updatedAt: Date.now() });
    this.save(row);
  }
  cancel(id, nonce, stopWaiting = false) {
    const row = this.rows.get(id + '/' + nonce);
    if (!row) return false;
    if (row.state === 'uncertain' && stopWaiting) {
      this.update(row, 'stopped');
      return true;
    }
    if (!queued.has(row.state)) return false;
    this.update(row, 'cancelled');
    return true;
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const groups = new Map();
      for (const row of this.rows.values())
        if (
          active.has(row.state) ||
          (['processing_failed', 'interrupted'].includes(row.state) &&
            Date.now() - (row.updatedAt || row.createdAt) < 86400000)
        ) {
          if (!groups.has(row.id)) groups.set(row.id, []);
          groups.get(row.id).push(row);
        }
      for (const [id, rows] of groups) {
        rows.sort((a, b) => a.createdAt - b.createdAt);
        if (!this.enabled()) {
          for (const row of rows) if (queued.has(row.state)) this.update(row, 'paused');
          if (rows.every((row) => queued.has(row.state))) continue;
        }
        const record = this.resolve(id);
        if (!record && !this.enabled()) continue;
        const view = record && (await this.bridge.observe(id, record.cwd));
        if (!view?.connected) {
          for (const row of rows)
            if (queued.has(row.state))
              this.update(row, Date.now() - row.createdAt > 1800000 ? 'expired' : 'waiting_connection');
          if (record && this.enabled() && rows.some((row) => row.state === 'waiting_connection'))
            this.connect(id, record.cwd);
          continue;
        }
        for (const row of rows)
          if (!queued.has(row.state)) {
            const turns = [...view.turns].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
            const clientMatches = turns.filter((t) =>
              t.inputs.some(
                (x) =>
                  typeof row.clientId === 'string' &&
                  typeof x.clientId === 'string' &&
                  x.clientId.toLowerCase() === row.clientId.toLowerCase()
              )
            );
            const knownId = row.messageTurnId || row.turnId;
            const compatible = (t) =>
              !t.inputs.some((x) => x.clientId) ||
              t.inputs.some(
                (x) =>
                  typeof x.clientId === 'string' &&
                  x.clientId.toLowerCase() === String(row.clientId).toLowerCase()
              );
            const matches = clientMatches.length
              ? [clientMatches.at(-1)]
              : knownId
                ? turns.filter((t) => t.id === knownId && compatible(t))
                : [];
            if (!matches.length && row.turnId && row.turnId !== knownId)
              matches.push(...turns.filter((t) => t.id === row.turnId && compatible(t)));
            const fallback = matches.length
              ? matches
              : row.images?.length
                ? []
                : turns.filter(
                    (t) =>
                      t.startedAt >= row.createdAt - 1000 &&
                      t.inputs.some((x) => !x.clientId && digest(x.text) === row.hash)
                  );
            if (fallback.length !== 1) {
              if (
                row.state !== 'uncertain' &&
                !['processing_failed', 'interrupted'].includes(row.state) &&
                Date.now() - row.createdAt > 30000
              )
                this.update(row, 'uncertain');
              continue;
            }
            const anchor = fallback[0];
            let turn = anchor;
            // An empty-input turn immediately after an errored/interrupted turn
            // continues the same user task. Never cross another user's message.
            const unknownUserBoundary = turns.some(
              (t) => t !== anchor && t.inputs.length && !(t.startedAt > 0)
            );
            for (const next of unknownUserBoundary ? [] : turns.slice(turns.indexOf(anchor) + 1)) {
              if (!['failed', 'interrupted'].includes(turn.status) || next.inputs.length) break;
              if (!(next.startedAt >= turn.startedAt && next.startedAt > 0)) break;
              turn = next;
            }
            const state =
              turn.status === 'completed'
                ? 'completed'
                : turn.status === 'failed'
                  ? 'processing_failed'
                  : turn.status === 'interrupted'
                    ? 'interrupted'
                    : turn.status === 'inProgress'
                      ? view.state === 'needs_input'
                        ? 'needs_input'
                        : 'working'
                      : 'uncertain';
            this.update(row, state, state === 'processing_failed' ? 'app-turn-failed' : null, {
              turnId: turn.id,
              messageTurnId: row.messageTurnId || anchor.id,
              acceptedAt: row.acceptedAt || Date.now(),
            });
          }
        if (rows.some((r) => !queued.has(r.state) && active.has(r.state))) continue;
        const row = rows.find((r) => queued.has(r.state));
        if (!row) continue;
        if (Date.now() - row.createdAt > 1800000) {
          this.update(row, 'expired');
          continue;
        }
        if (!this.enabled()) continue;
        this.update(row, 'queued');
        if (view.state !== 'idle') continue;
        // A durable claim is written before dispatch. A crash never automatically repeats a submission.
        try {
          fs.writeFileSync(this.file(row) + '.claim', 'dispatched', { flag: 'wx', mode: 0o600 });
        } catch (e) {
          if (e.code === 'EEXIST') {
            this.update(row, 'uncertain');
            continue;
          }
          throw e;
        }
        this.update(row, 'dispatching');
        try {
          const result = await this.bridge.start(id, record.cwd, {
            text: row.text,
            images: this.resolveImages(
              id,
              (row.images || []).map((x) => x.id)
            ),
            clientId: row.clientId,
            authorize: () => this.enabled() && Boolean(this.resolve(id)),
          });
          row.turnId = result.turnId;
          this.update(row, 'working', null, { acceptedAt: Date.now() });
        } catch (e) {
          this.update(row, e.uncertain ? 'uncertain' : 'failed', 'app-delivery-failed');
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
