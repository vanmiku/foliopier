import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const TOKEN = /^[a-f0-9]{40}$/,
  SESSION = /^[\w-]{6,100}$/;
export const IMAGE_LIMIT = 5 * 1024 * 1024;
function format(bytes) {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    const w = bytes.readUInt32BE(16),
      h = bytes.readUInt32BE(20);
    if (!w || !h || w * h > 40000000) throw Error('image-dimensions');
    return ['image/png', 'png'];
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return ['image/jpeg', 'jpg'];
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)))
    return ['image/gif', 'gif'];
  if (
    bytes.length >= 16 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return ['image/webp', 'webp'];
  throw Error('invalid-image');
}
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export class SessionImages {
  constructor({ dir, protectedIds = () => new Set(), maxBytes = 256 * 1024 * 1024 }) {
    this.dir = dir;
    this.protectedIds = protectedIds;
    this.maxBytes = maxBytes;
    this.lastPrune = 0;
  }
  public(meta) {
    return {
      id: meta.id,
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
      url: '/api/session-images/' + meta.id,
    };
  }
  save(sid, { name, data }) {
    if (!SESSION.test(sid) || typeof data !== 'string' || data.length > Math.ceil(IMAGE_LIMIT / 3) * 4 + 100)
      throw Error('invalid-image');
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
    if (!m) throw Error('invalid-image');
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length || bytes.length > IMAGE_LIMIT || bytes.toString('base64') !== m[2])
      throw Error('invalid-image');
    const [mime, ext] = format(bytes);
    if (mime !== m[1]) throw Error('invalid-image');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (Date.now() - this.lastPrune > 60000) {
      this.prune();
      this.lastPrune = Date.now();
    }
    const files = fs.readdirSync(this.dir);
    if (
      files.length > 2048 ||
      files.reduce((sum, f) => sum + fs.statSync(path.join(this.dir, f)).size, 0) + bytes.length >
        this.maxBytes
    )
      throw Error('image-storage-full');
    const id = crypto.randomBytes(20).toString('hex');
    const meta = {
      id,
      sid,
      mime,
      ext,
      name:
        String(name || 'image')
          .split(/[\\/]/)
          .at(-1)
          .replace(/[\x00-\x1f\x7f]/g, '')
          .slice(0, 120) || 'image',
      size: bytes.length,
      sha256: sha(bytes),
      createdAt: Date.now(),
    };
    const file = path.join(this.dir, id + '.' + ext);
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    try {
      fs.writeFileSync(path.join(this.dir, id + '.json'), JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      fs.unlinkSync(file);
      throw e;
    }
    return this.public(meta);
  }
  read(id) {
    if (!TOKEN.test(id)) throw Error('invalid-image');
    const meta = JSON.parse(fs.readFileSync(path.join(this.dir, id + '.json'), 'utf8'));
    if (
      meta.id !== id ||
      !SESSION.test(meta.sid) ||
      !['png', 'jpg', 'webp', 'gif'].includes(meta.ext) ||
      !Number.isSafeInteger(meta.size) ||
      meta.size > IMAGE_LIMIT
    )
      throw Error('invalid-image');
    const file = path.join(this.dir, id + '.' + meta.ext),
      st = fs.lstatSync(file);
    if (
      !st.isFile() ||
      st.size !== meta.size ||
      st.size > IMAGE_LIMIT ||
      (process.getuid && st.uid !== process.getuid()) ||
      (process.platform !== 'win32' && st.mode & 0o077)
    )
      throw Error('invalid-image');
    const bytes = fs.readFileSync(file);
    const [mime, ext] = format(bytes);
    if (sha(bytes) !== meta.sha256 || mime !== meta.mime || ext !== meta.ext) throw Error('invalid-image');
    if (Date.now() - (meta.lastAccessAt || meta.createdAt) > 12 * 3600000) {
      meta.lastAccessAt = Date.now();
      const tmp = path.join(this.dir, id + '.' + crypto.randomUUID() + '.tmp');
      fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
      fs.renameSync(tmp, path.join(this.dir, id + '.json'));
    }
    return { ...meta, path: file };
  }
  entries() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => TOKEN.test(f.slice(0, -5)) && f.endsWith('.json'))
        .flatMap((f) => {
          try {
            const m = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
            return m.id === f.slice(0, -5) && ['png', 'jpg', 'webp', 'gif'].includes(m.ext) ? [m] : [];
          } catch {
            return [];
          }
        });
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
  stats() {
    const entries = this.entries(),
      protectedIds = this.protectedIds(),
      active = this.protectedIds({ includeCompleted: true });
    let usedBytes = 0;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const st = fs.lstatSync(path.join(this.dir, f));
        if (st.isFile()) usedBytes += st.size;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return {
      usedBytes,
      maxBytes: this.maxBytes,
      count: entries.length,
      unused: entries.filter((m) => !protectedIds.has(m.id)).length,
      completed: entries.filter((m) => protectedIds.has(m.id) && !active.has(m.id)).length,
      inUse: entries.filter((m) => active.has(m.id)).length,
    };
  }
  discard(sid, id) {
    const m = this.read(id);
    if (m.sid !== sid) throw Error('invalid-image');
    if (this.protectedIds().has(id)) return false;
    this.remove(m);
    return true;
  }
  remove(meta) {
    fs.rmSync(path.join(this.dir, meta.id + '.' + meta.ext), { force: true });
    fs.rmSync(path.join(this.dir, meta.id + '.json'), { force: true });
  }
  prune({ includeRecent = false, includeCompleted = false, now = Date.now() } = {}) {
    const protectedIds = this.protectedIds({ includeCompleted });
    let removed = 0;
    for (const m of this.entries())
      if (
        !protectedIds.has(m.id) &&
        (includeRecent || m.discardedAt || now - (m.lastAccessAt || m.createdAt) > 30 * 86400000)
      ) {
        this.remove(m);
        removed++;
      }
    // A crash can leave an image without its manifest. Only old, unreferenced
    // orphans can be removed automatically.
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const match = /^([a-f0-9]{40})\.(png|jpg|webp|gif)$/.exec(f);
        if (!match || protectedIds.has(match[1]) || fs.existsSync(path.join(this.dir, match[1] + '.json')))
          continue;
        const st = fs.lstatSync(path.join(this.dir, f));
        if (st.isFile() && (includeRecent || now - st.mtimeMs > 30 * 86400000)) {
          fs.rmSync(path.join(this.dir, f));
          removed++;
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return { removed, ...this.stats() };
  }
  resolve(sid, ids = []) {
    if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length)
      throw Error('invalid-image');
    return ids.map((id) => {
      const meta = this.read(id);
      if (meta.sid !== sid) throw Error('invalid-image');
      return meta;
    });
  }
}
