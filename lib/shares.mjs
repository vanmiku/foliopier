// Public-document credentials and feedback are separate from workbench identities.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HOME, readConfig, readMeta, latest, withLock } from './store.mjs';
import { buildShareSnapshot } from './share-resources.mjs';

const DIR = path.join(HOME, 'state');
const FILE = path.join(DIR, 'shares.json');
const HOUR = 3600_000, DAY = 24 * HOUR, MAX_DAYS = 30;
const CODE_WINDOW = 15 * 60_000, MAX_CLOCK_ROLLBACK = 5 * 60_000;
// Keep the single-file store bounded. New content stops at 12 MiB, leaving
// 4 MiB for bounded auth/rate state and maintenance (revoke/reset still work).
const CONTENT_BYTES = 12 * 1024 * 1024, MAX_COMMENTS = 10_000, MAX_SESSIONS = 4096;
const CHECKPOINT = 60_000, NO_WRITE = Symbol('unchanged share read');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomId = () => crypto.randomBytes(16).toString('hex');
const newCode = () => String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
const scrypt = promisify(crypto.scrypt);
let activeHashes = 0;

function fail(code, status = 400) {
  const error = new Error(code);
  error.code = code; error.status = status;
  return error;
}
function empty() { return { schema: 1, shares: {}, maxObservedNow: 0, attempts: {}, globalAttempts: {} }; }
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (s.schema !== 1 || !s.shares || typeof s.shares !== 'object' || Array.isArray(s.shares)) throw fail('SHARE_STATE_UNAVAILABLE', 503);
    s.attempts ||= {}; s.globalAttempts ||= {}; s.maxObservedNow ||= 0;
    return s;
  } catch (e) { if (e.code === 'ENOENT') return empty(); throw fail('SHARE_STATE_UNAVAILABLE', 503); }
}
function clockOK(s, now = Date.now()) { return now + MAX_CLOCK_ROLLBACK >= Number(s.maxObservedNow || 0); }
function enabled() { return readConfig().sharing?.enabled === true; }
const epoch = cfg => String(cfg?.epoch || 'initial');
function active(s, r, now = Date.now()) {
  const cfg=readConfig().sharing||{};
  return Boolean(cfg.enabled===true && clockOK(s, now) && r && epoch({epoch:r.sharingEpoch})===epoch(cfg) && !r.revoked && Date.parse(r.expiresAt) > now);
}
function status(s, r, now = Date.now(), cfg = readConfig().sharing||{}) {
  if (r.revoked || epoch({epoch:r.sharingEpoch})!==epoch(cfg)) return 'revoked';
  if (Date.parse(r.expiresAt) <= now) return 'expired';
  if (!clockOK(s, now)) return 'clock-unverified';
  if (cfg.enabled!==true) return 'disabled';
  return 'active';
}
function capacity(s) {
  if (Buffer.byteLength(JSON.stringify(s)) > CONTENT_BYTES) throw fail('SHARE_STORAGE_FULL', 429);
}
const unchanged = value => ({ [NO_WRITE]: true, value });
async function save(s) {
  const tmp = `${FILE}.${process.pid}.${randomId()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(s) + '\n', { mode: 0o600 });
  try {
    for (let n = 0; ; n++) {
      try { await fsp.rename(tmp, FILE); return; }
      catch (e) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || n >= 8) throw e;
        await new Promise(r => setTimeout(r, Math.min(25 * 2 ** n, 250)));
      }
    }
  } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}
async function change(fn, { requireClock = true, contentBudget = false } = {}) {
  return withLock(DIR, async () => {
    const s = load(), now = Date.now();
    if (requireClock && !clockOK(s, now)) throw fail('CLOCK_UNVERIFIED', 503);
    const checkpointDue = now - Number(s.maxObservedNow || 0) >= CHECKPOINT;
    s.maxObservedNow = Math.max(Number(s.maxObservedNow || 0), now);
    for (const [key, x] of Object.entries(s.attempts)) if (now - x.at >= CODE_WINDOW) delete s.attempts[key];
    for (const r of Object.values(s.shares)) for (const [key, auth] of Object.entries(r.sessions || {})) if (Date.parse(auth.expiresAt) <= now) delete r.sessions[key];
    const result = await fn(s, now, { checkpointDue });
    if (result?.[NO_WRITE]) return result.value;
    if (typeof contentBudget === 'function' ? contentBudget() : contentBudget) capacity(s);
    await save(s);
    return result;
  }, { name: '.shares-lock', waitMs: 10_000 });
}
function record(s, id, requireActive = true) {
  const r = typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? s.shares[id] : null;
  if (!r || (requireActive && !active(s, r))) throw fail('SHARE_UNAVAILABLE', 410);
  return r;
}
const string = (v, max) => String(v || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max);
function selection(files, main) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 200 || typeof main !== 'string') throw fail('INVALID_SHARE_FILES');
  const out = [...new Set(files)];
  if (!out.includes(main) || out.some(f => typeof f !== 'string' || !f || f.length > 1024 || f.includes('\\') || f.startsWith('/') || f.split('/').some(p => !p || p.startsWith('.')))) throw fail('INVALID_SHARE_FILES');
  return out;
}
function expiration(opts, now, fallback) {
  if (opts.expiresAt === undefined && opts.expiresInHours === undefined && fallback) return fallback;
  let ms;
  if (opts.expiresAt !== undefined) ms = Date.parse(opts.expiresAt);
  else {
    const hours = opts.expiresInHours === undefined ? 24 : Number(opts.expiresInHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_DAYS * 24) throw fail('INVALID_SHARE_EXPIRATION');
    ms = now + hours * HOUR;
  }
  if (!Number.isFinite(ms) || ms <= now || ms > now + MAX_DAYS * DAY) throw fail('INVALID_SHARE_EXPIRATION');
  return new Date(ms).toISOString();
}
function documentVersion(project, slug, version) {
  const meta = readMeta(project, slug);
  if (!meta || !Array.isArray(meta.versions) || !meta.versions.length) throw fail('DOCUMENT_UNAVAILABLE', 404);
  const v = version === undefined ? latest(meta) : meta.versions.find(x => x.v === version);
  if (!v) throw fail('DOCUMENT_UNAVAILABLE', 404);
  return v;
}
function identities(project, slug) {
  for (const value of [project, slug]) if (typeof value !== 'string' || !value || value.length > 160 || value.startsWith('.') || /[\\/\x00-\x1f]/.test(value)) throw fail('INVALID_SHARE_DOCUMENT');
}
async function codeCredentials(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = await scrypt(code, salt, 32, { N: 16384, maxmem: 64 * 1024 * 1024 });
  return { codeSalt: salt, codeHash: digest.toString('hex') };
}
function invalidate(r) { r.authRevision = (r.authRevision || 0) + 1; r.sessions = {}; }
function snapshotFor(r, version, approve = false) {
  return buildShareSnapshot({ project: r.project, slug: r.slug, main: r.main, files: r.files, version,
    ...(approve ? {} : { approvedResources: r.snapshot.resources }) });
}
function rememberSnapshot(r, snapshot) {
  r.snapshot = snapshot;
  r.servedVersions ||= [];
  if (!r.servedVersions.some(x => x.version === snapshot.version)) r.servedVersions.push({ version: snapshot.version, files: snapshot.files.map(f => f.path) });
  // Retain the versions visitors may be writing comments about, without copying document bytes.
  if (r.servedVersions.length > 100) r.servedVersions.splice(0, r.servedVersions.length - 100);
  delete r.pendingVersion; delete r.pendingReason;
}

export function ownerShare(r, context = {}) {
  if (!r) return null;
  const s = context.state || load(), now = context.now ?? Date.now();
  const cfg=context.settings||readConfig().sharing||{};
  return { id: r.id, project: r.project, slug: r.slug, main: r.main, files: [...r.files], title: r.title,
    publisher: r.publisher, mode: r.mode, createdAt: r.createdAt, expiresAt: r.expiresAt,
    allowPdf: r.allowPdf, allowComments: r.allowComments, status: status(s, r, now, cfg), revoked: Boolean(r.revoked||epoch({epoch:r.sharingEpoch})!==epoch(cfg)),
    version: r.snapshot.version, fileMetadata: r.snapshot.files.map(f => ({ path: f.path, kind: f.kind, size: f.size })),
    pendingVersion: r.pendingVersion || null, pendingReason: r.pendingReason || '',
    commentCount: (r.comments || []).filter(c => c.status === 'open').length };
}
export function listShares({ project, slug } = {}) {
  const s = load(), context = { state: s, now: Date.now(), settings: readConfig().sharing||{} };
  return Object.values(s.shares).filter(r => (!project || r.project === project) && (!slug || r.slug === slug))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(r => ownerShare(r, context));
}
export function getShare(id, { inactive = false } = {}) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return null;
  const s = load(), r = s.shares[id];
  return r && (inactive || active(s, r)) ? structuredClone(r) : null;
}
export async function createShare(opts = {}) {
  if (!enabled()) throw fail('SHARING_DISABLED', 409);
  identities(opts.project, opts.slug);
  const newest = documentVersion(opts.project, opts.slug);
  const v = opts.version === undefined ? newest : documentVersion(opts.project, opts.slug, Number(opts.version));
  if ((opts.mode || 'latest') === 'latest' && v.v !== newest.v) throw fail('DOCUMENT_UPDATED', 409);
  const main = opts.main || v.main;
  const files = selection(opts.files || [main], main);
  const mode = opts.mode === undefined ? 'latest' : opts.mode;
  if (!['latest', 'fixed'].includes(mode)) throw fail('INVALID_SHARE_MODE');
  const code = newCode(), credentials = await codeCredentials(code);
  const snapshot = buildShareSnapshot({ project: opts.project, slug: opts.slug, files, main, version: v.v });
  return change((s, now) => {
    if (!enabled()) throw fail('SHARING_DISABLED', 409);
    if (Object.keys(s.shares).length >= 1000) throw fail('SHARE_LIMIT_REACHED', 429);
    const id = randomId();
    const r = { id, project: opts.project, slug: opts.slug, files, main, mode,
      title: string(opts.title || 'Shared document', 300).trim() || 'Shared document', publisher: string(opts.publisher, 100).trim(),
      createdAt: new Date(now).toISOString(), expiresAt: expiration(opts, now),
      allowPdf: opts.allowPdf !== false, allowComments: opts.allowComments !== false,
      authRevision: 1, sharingEpoch:epoch(readConfig().sharing), revoked: false, sessions: {}, comments: [], ...credentials };
    rememberSnapshot(r, snapshot); s.shares[id] = r;
    return { share: ownerShare(r, { state: s, now }), code };
  }, { contentBudget: true });
}
export async function updateShare(id, patch = {}) {
  let contentGrowth = false;
  return change((s, now) => {
    const r = record(s, id, false);
    if (r.revoked) throw fail('SHARE_UNAVAILABLE', 410);
    if (!enabled()) throw fail('SHARING_DISABLED', 409);
    if (patch.mode !== undefined && !['latest', 'fixed'].includes(patch.mode)) throw fail('INVALID_SHARE_MODE');
    const priorFiles = [...r.files];
    if (patch.files !== undefined) r.files = selection(patch.files, r.main);
    if (patch.mode !== undefined) r.mode = patch.mode;
    if (patch.title !== undefined) {
      r.title = string(patch.title, 300).trim(); if (!r.title) throw fail('INVALID_SHARE_TITLE');
    }
    if (patch.publisher !== undefined) r.publisher = string(patch.publisher, 100).trim();
    if (patch.allowPdf !== undefined) r.allowPdf = patch.allowPdf === true;
    if (patch.allowComments !== undefined) r.allowComments = patch.allowComments === true;
    r.expiresAt = expiration(patch, now, r.expiresAt);
    for(const auth of Object.values(r.sessions||{}))auth.expiresAt=new Date(Math.min(Date.parse(r.expiresAt),Date.parse(auth.maximumExpiresAt||auth.expiresAt))).toISOString();
    const selectionChanged = JSON.stringify(priorFiles) !== JSON.stringify(r.files);
    contentGrowth = patch.approveVersion === true || r.files.some(file => !priorFiles.includes(file));
    if (patch.approveVersion === true || selectionChanged || patch.mode !== undefined) {
      const approve = patch.approveVersion === true;
      const pendingVersion = r.pendingVersion, pendingReason = r.pendingReason;
      // Selection edits authorize only a change to the already served version.
      // In particular, removing one file must never approve a pending version's
      // unrelated new dependencies. New-version approval is always explicit.
      const v = documentVersion(r.project, r.slug, approve ? undefined : r.snapshot.version);
      rememberSnapshot(r, snapshotFor(r, v.v, approve));
      if (!approve && pendingVersion) {
        r.pendingVersion = pendingVersion; r.pendingReason = pendingReason;
      }
    }
    if (selectionChanged) {
      invalidate(r);
      for (const version of r.servedVersions) version.files = version.files.filter(f => r.files.includes(f));
    }
    r.updatedAt = new Date(now).toISOString();
    return ownerShare(r, { state: s, now });
  }, { contentBudget: () => contentGrowth });
}
export async function resetShareCode(id) {
  const code = newCode(), credentials = await codeCredentials(code);
  return change(s => {
    const r = record(s, id); Object.assign(r, credentials); delete r.codeAttempts; invalidate(r);
    return { share: ownerShare(r, { state: s }), code };
  });
}
export async function revokeShare(id) {
  return change(s => {
    const r = record(s, id, false); r.revoked = true; r.revokedAt = new Date().toISOString(); invalidate(r);
    return ownerShare(r, { state: s });
  }, { requireClock: false });
}
export async function revokeAllShares() {
  return change(s => {
    let count = 0;
    for (const r of Object.values(s.shares)) if (!r.revoked) { r.revoked = true; r.revokedAt = new Date().toISOString(); invalidate(r); count++; }
    return count;
  }, { requireClock: false });
}
export async function currentShare(id) {
  const initial = load(); if (!active(initial, initial.shares[id])) return null;
  const first = initial.shares[id];
  let version;
  try { version = documentVersion(first.project, first.slug, first.mode === 'fixed' ? first.snapshot.version : undefined); }
  catch { /* The locked path below records revocation. */ }
  if (version?.files?.some(f => f.path === first.main)
      && (version.v === first.snapshot.version || version.v === first.pendingVersion)
      && Date.now() - Number(initial.maxObservedNow || 0) < CHECKPOINT) return structuredClone(first);
  return change((s, now, { checkpointDue }) => {
    const r = s.shares[id]; if (!active(s, r)) return null;
    let v;
    try { v = documentVersion(r.project, r.slug, r.mode === 'fixed' ? r.snapshot.version : undefined); }
    catch { r.revoked = true; invalidate(r); return null; }
    if (!v.files?.some(f => f.path === r.main)) { r.revoked = true; invalidate(r); return null; }
    if (v.v === r.snapshot.version || v.v === r.pendingVersion)
      return checkpointDue ? structuredClone(r) : unchanged(structuredClone(r));
    if (v.v !== r.snapshot.version) {
      // A removed secondary file ceases to be available; new files never join automatically.
      const liveFiles = new Set(v.files.map(f => f.path));
      const selected = r.files.filter(f => liveFiles.has(f));
      if (selected.length !== r.files.length) {
        r.files = selected; invalidate(r);
        for (const served of r.servedVersions) served.files = served.files.filter(f => selected.includes(f));
        // Rebuild the fallback version with the reduced selection as well. A
        // later new-resource failure must not keep a removed file in its cache.
        try { rememberSnapshot(r, snapshotFor(r, r.snapshot.version)); }
        catch { r.revoked = true; return null; }
      }
      try {
        const candidate = structuredClone(r);
        rememberSnapshot(candidate, snapshotFor(r, v.v));
        capacity({ ...s, shares: { ...s.shares, [id]: candidate } });
        Object.assign(r, candidate);
      }
      catch (e) { r.pendingVersion = v.v; r.pendingReason = string(e.code || 'VERSION_NEEDS_REVIEW', 100); }
    }
    return structuredClone(r);
  });
}

export async function unlockShare(id, code, { clientKey = 'local' } = {}) {
  if (activeHashes >= 4) throw fail('RATE_LIMITED', 429);
  const credentials = await change((s, now) => {
    const r = record(s, id), key = hash(id + ':' + string(clientKey, 200));
    let attempt = s.attempts[key];
    if (!attempt && Object.keys(s.attempts).length >= 2000) throw fail('RATE_LIMITED', 429);
    attempt ||= { at: now, count: 0 };
    if (attempt.count >= 10) throw fail('RATE_LIMITED', 429);
    let failures=r.codeAttempts;
    if(!failures||now-failures.at>=CODE_WINDOW)failures={at:now,count:0};
    if(failures.count>=50)throw fail('RATE_LIMITED',429);
    r.codeAttempts=failures;failures.count++;
    const global = s.globalAttempts;
    if (!global.at || now - global.at > 60_000) { global.at = now; global.count = 0; }
    if (global.count >= 600) throw fail('RATE_LIMITED', 429);
    global.count++; attempt.count++; s.attempts[key] = attempt;
    return { salt: r.codeSalt, hash: r.codeHash, revision: r.authRevision, key, attemptWindow:failures.at };
  });
  let digest;
  if (typeof code !== 'string' || !/^\d{8}$/.test(code)) throw fail('INVALID_CODE', 401);
  // Recheck after the asynchronous lock reservation: simultaneous requests may
  // all have passed the earlier guard before any hash actually started.
  if (activeHashes >= 4) throw fail('RATE_LIMITED', 429);
  activeHashes++;
  try { digest = await scrypt(code, credentials.salt, 32, { N: 16384, maxmem: 64 * 1024 * 1024 }); }
  finally { activeHashes--; }
  const expected = Buffer.from(credentials.hash, 'hex');
  if (digest.length !== expected.length || !crypto.timingSafeEqual(digest, expected)) throw fail('INVALID_CODE', 401);
  const token = crypto.randomBytes(32).toString('hex');
  return change((s, now) => {
    const r = record(s, id);
    if (r.authRevision !== credentials.revision || r.codeHash !== credentials.hash) throw fail('INVALID_CODE', 401);
    if (Object.keys(r.sessions).length >= 1000 || Object.values(s.shares).reduce((n, x) => n + Object.keys(x.sessions || {}).length, 0) >= MAX_SESSIONS) throw fail('SHARE_VISITOR_LIMIT', 429);
    const visitorId = randomId(), expiresAt = new Date(Math.min(Date.parse(r.expiresAt), now + DAY)).toISOString();
    r.sessions[hash(token)] = { visitorId, expiresAt, maximumExpiresAt:new Date(now+DAY).toISOString(), authRevision: r.authRevision };
    delete s.attempts[credentials.key];
    if(r.codeAttempts?.at===credentials.attemptWindow)r.codeAttempts.count=Math.max(0,r.codeAttempts.count-1);
    return { token, visitorId, expiresAt, maximumExpiresAt:r.sessions[hash(token)].maximumExpiresAt };
  });
}
export function verifyShareSession(id, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const s = load(), r = s.shares[id];
  if (!active(s, r)) return null;
  const auth = r.sessions?.[hash(token)];
  return auth && auth.authRevision === r.authRevision && Date.parse(auth.expiresAt) > Date.now()
    ? { visitorId: auth.visitorId, expiresAt: auth.expiresAt, maximumExpiresAt:auth.maximumExpiresAt||auth.expiresAt, shareId: id, authRevision: auth.authRevision } : null;
}
function visitorPresent(r, visitorId) {
  return typeof visitorId === 'string' && Object.values(r.sessions || {}).some(auth => auth.visitorId === visitorId && auth.authRevision === r.authRevision && Date.parse(auth.expiresAt) > Date.now());
}
function visitorComment(c) {
  return { id: c.id, file: c.file, version: c.version, v: c.version, text: c.text, nickname: c.nickname,
    createdAt: c.createdAt, status: c.status };
}
export async function addShareComment(id, visitorId, opts = {}) {
  return change((s, now) => {
    const r = record(s, id);
    if (!visitorPresent(r, visitorId)) throw fail('SHARE_UNAUTHORIZED', 401);
    if (!r.allowComments) throw fail('COMMENTS_DISABLED', 403);
    const requestId = string(opts.requestId, 100);
    const existing = requestId && r.comments.find(c => c.visitorId === visitorId && c.requestId === requestId);
    if (existing) return visitorComment(existing);
    const version = Number(opts.version ?? opts.v), file = String(opts.file || '');
    if (!r.files.includes(file) || !r.servedVersions.some(v => v.version === version && v.files.includes(file))) throw fail('SHARE_FILE_UNAVAILABLE', 404);
    const text = String(opts.text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
    if (!text || text.length > 2000) throw fail('INVALID_COMMENT');
    if (r.comments.length >= 5000 || Object.values(s.shares).reduce((n, x) => n + x.comments.length, 0) >= MAX_COMMENTS) throw fail('SHARE_STORAGE_FULL', 429);
    if (r.comments.filter(c => c.visitorId === visitorId && now - Date.parse(c.createdAt) < 60_000).length >= 5) throw fail('RATE_LIMITED', 429);
    const c = { id: randomId(), shareId: id, visitorId, file, version, text, nickname: string(opts.nickname, 80).trim(),
      createdAt: new Date(now).toISOString(), requestId, status: 'open' };
    r.comments.push(c); return visitorComment(c);
  }, { contentBudget: true });
}
export function visitorShareComments(id, visitorId) {
  const s = load(), r = s.shares[id];
  if (!active(s, r) || !visitorPresent(r, visitorId)) return [];
  return r.comments.filter(c => c.visitorId === visitorId).map(visitorComment);
}
export function ownerShareComments({ project, slug } = {}) {
  const s = load();
  return Object.values(s.shares).filter(r => (!project || r.project === project) && (!slug || r.slug === slug))
    .flatMap(r => r.comments.map(c => ({ ...visitorComment(c), shareId: r.id, project: r.project, slug: r.slug, shareTitle: r.title, from: 'external' })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function resolveShareComment(id, cid) {
  return change(s => {
    const r = record(s, id, false), c = r.comments.find(c => c.id === cid);
    if (!c) throw fail('COMMENT_UNAVAILABLE', 404);
    c.status = 'resolved'; c.resolvedAt = new Date().toISOString(); return visitorComment(c);
  }, { requireClock: false });
}
