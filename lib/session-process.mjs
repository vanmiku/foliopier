import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { which } from './sys.mjs';
export function tmuxBinary() {
  return (
    which('tmux') ||
    (process.platform === 'darwin'
      ? ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].find((p) => {
          try {
            const s = fs.statSync(p);
            return s.isFile() && Boolean(s.mode & 0o111);
          } catch {
            return false;
          }
        })
      : null)
  );
}
const ps = (pid, format) =>
  execFileSync('ps', ['-p', String(pid), '-o', format], { timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
export function processIdentity(pid) {
  if (process.platform === 'win32' || !Number.isInteger(Number(pid)) || Number(pid) < 2) return null;
  try {
    const command = path.basename(ps(pid, 'comm='));
    return {
      pid: Number(pid),
      command,
      started: ps(pid, 'lstart=').replace(/\s+/g, ' '),
      tty: ps(pid, 'tty=').replace(/^\/dev\//, ''),
    };
  } catch {
    return null;
  }
}
export function parentAgent(agent) {
  let pid = process.ppid;
  for (let i = 0; i < 10 && pid > 1; i++) {
    const info = processIdentity(pid);
    if (!info) return null;
    if (info.command === agent || info.command === agent + '.exe') return info;
    try {
      pid = Number(ps(pid, 'ppid='));
    } catch {
      return null;
    }
  }
  return null;
}
