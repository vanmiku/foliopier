// Run only in the release job after every required platform has passed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const semver = /^\d+\.\d+\.\d+$/;
const compare = (a, b) => {
  const x = a.replace(/^v/, '').split('.').map(Number), y = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
export function releasePlan({ version, lockVersion, tags, commit, main, changelog }) {
  if (!semver.test(version)) return { skip: 'Not a stable version.' };
  if (version !== lockVersion) throw new Error('Package and lock version differ.');
  if (commit !== main) return { skip: 'A newer main commit must pass CI first.' };
  const tag = `v${version}`;
  if (tags.some(t => /^v\d+\.\d+\.\d+$/.test(t) && compare(t, tag) >= 0)) return { skip: 'This version is already tagged, or a newer version exists.' };
  const escaped = version.replace(/\./g, '\\.');
  const notes = new RegExp(`^## ${escaped}(?:[ \\t][^\\n]*)?\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(changelog)?.[1]?.trim();
  if (!notes) throw new Error(`Release notes for ${version} are missing.`);
  return { tag, commit, notes };
}

export function main() {
  // A local invocation, pull request or manually dispatched workflow cannot publish.
  if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main') {
    console.log('Release skipped: only a tested push to main can publish.'); return;
  }
  const repo = process.env.GITHUB_REPOSITORY, commit = process.env.GITHUB_SHA;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Invalid release repository or commit.');
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const refs = JSON.parse(gh(['api', `repos/${repo}/git/matching-refs/tags/v`]));
  const head = JSON.parse(gh(['api', `repos/${repo}/git/ref/heads/main`])).object.sha;
  const plan = releasePlan({ version: pkg.version, lockVersion: lock.version, tags: refs.map(r => r.ref.replace('refs/tags/', '')),
    commit, main: head, changelog: fs.readFileSync('CHANGELOG.md', 'utf8') });
  if (plan.skip) { console.log(`Release skipped: ${plan.skip}`); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-release-'));
  try {
    const notes = path.join(dir, 'notes.md'); fs.writeFileSync(notes, plan.notes + '\n');
    console.log(gh(['release', 'create', plan.tag, '--repo', repo, '--target', plan.commit,
      '--title', `FolioPier AI ${pkg.version}`, '--notes-file', notes, '--latest']));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
