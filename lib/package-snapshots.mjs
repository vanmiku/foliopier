import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, readMeta } from './store.mjs';
import { buildShareSnapshot, shareResourcePath } from './share-resources.mjs';

const ROOT = path.join(HOME, 'state', 'packages');
export const packageId = () => crypto.randomBytes(16).toString('hex');
export function packageError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

export function packageCandidate(project, selections, previous = null) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 10) throw packageError('PACKAGE_COUNT');
  const slugs = new Set();
  let bytes = 0;
  const entries = selections.map(({ slug, version, main, files }) => {
    if (slugs.has(slug)) throw packageError('PACKAGE_DUPLICATE');
    slugs.add(slug);
    const old = previous?.entries.find(e => e.snapshot.slug === slug);
    const id = old?.id || packageId();
    if (old && old.snapshot.version === version && old.snapshot.main === main
        && JSON.stringify(old.snapshot.files.map(f => f.path)) === JSON.stringify(files)) {
      bytes += old.snapshot.totalSize;
      return { ...old, change: '' };
    }
    const snapshot = buildShareSnapshot({ project, slug, version, main, files });
    bytes += snapshot.totalSize;
    const title = String(readMeta(project, slug)?.versions.find(v => v.v === version)?.title || slug).slice(0, 200);
    return { id, title, snapshot, change: old ? 'updated' : 'added' };
  });
  if (bytes > 50 * 1024 * 1024) throw packageError('PACKAGE_SIZE', 413);
  const removed = previous?.entries.filter(e => !slugs.has(e.snapshot.slug)).map(e => e.title) || [];
  return { revision: (previous?.revision || 0) + 1, entries, removed };
}

export function packageDraftMatches(current, draft) {
  return current.revision === draft.revision && current.entries.length === draft.entries.length
    && current.entries.every((entry, i) => entry.snapshot.fingerprint === draft.entries[i].snapshot.fingerprint);
}

export async function copyPackage(id, candidate) {
  const copy = packageId();
  const dir = path.join(ROOT, id, copy);
  try {
    for (const entry of candidate.entries) {
      const snapshot = entry.snapshot;
      const loc = [id, copy, entry.id].join('/');
      for (const rel of snapshot.resources) {
        const source = shareResourcePath(snapshot, rel);
        if (!source) throw packageError('PACKAGE_SOURCE_CHANGED', 409);
        const dest = path.join(ROOT, loc, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        const bytes = await fs.readFile(source);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== snapshot.digests[rel]) throw packageError('PACKAGE_SOURCE_CHANGED', 409);
        await fs.writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
      }
      entry.snapshot = { ...snapshot, copy: loc };
    }
    return dir;
  } catch (error) {
    await discardPackageCopy(dir);
    throw error;
  }
}

export async function discardPackageCopy(dir) {
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export function packageCopyDir(pkg) {
  const copy = pkg?.entries[0]?.snapshot.copy;
  return /^[a-f0-9]{32}\/[a-f0-9]{32}\/[a-f0-9]{32}$/.test(copy || '') ? path.join(ROOT, path.dirname(copy)) : null;
}

export async function prunePackageCopies(kept) {
  const list = async dir => fs.readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const safeDir = item => item.isDirectory() && /^[a-f0-9]{32}$/.test(item.name);
  for (const pkg of (await list(ROOT)).filter(safeDir)) {
    const parent = path.join(ROOT, pkg.name);
    for (const revision of (await list(parent)).filter(safeDir)) {
      const dir = path.join(parent, revision.name);
      if (!kept.has(dir)) await discardPackageCopy(dir);
    }
    await fs.rmdir(parent).catch(() => {});
  }
}
