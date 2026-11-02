// Reuse only a previously installed dependency graph for this runtime, after npm
// confirms nothing is missing or invalid. A version bump alone changes no graph.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STAMP = '.mydash-dependencies.json';
export function dependencyKey(dir, runtime = { abi: process.versions.modules, platform: process.platform, arch: process.arch }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  delete lock.version;
  if (lock.packages?.['']) delete lock.packages[''].version;
  const scripts = Object.fromEntries(['preinstall', 'install', 'postinstall', 'prepare'].map(k => [k, pkg.scripts?.[k] || null]));
  const spec = { lock, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, optionalDependencies: pkg.optionalDependencies,
    peerDependencies: pkg.peerDependencies, overrides: pkg.overrides, workspaces: pkg.workspaces, engines: pkg.engines, scripts, runtime };
  const npmrc = path.join(dir, '.npmrc');
  if (fs.existsSync(npmrc)) spec.npmrc = fs.readFileSync(npmrc, 'utf8');
  return crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

export function ensureDependencies(dir, npm) {
  let key;
  try { key = dependencyKey(dir); } catch (e) { return { ok: false, reused: false, out: e.message }; }
  const stamp = path.join(dir, 'node_modules', STAMP);
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(stamp, 'utf8')).key; } catch {}
  if (previous === key && npm(['ls', '--omit=dev', '--all', '--json']).ok) return { ok: true, reused: true };
  // Invalidate first: an interrupted/failed reinstall must never leave a valid stamp.
  try {
    fs.rmSync(stamp, { force: true });
    const r = npm(['ci', '--omit=dev', '--no-audit', '--no-fund']);
    if (!r.ok) return { ...r, reused: false };
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, JSON.stringify({ key }) + '\n');
    return { ok: true, reused: false };
  } catch (e) { return { ok: false, reused: false, out: e.message }; }
}
