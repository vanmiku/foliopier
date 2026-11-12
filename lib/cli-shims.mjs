import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PRIMARY_COMMAND } from './brand.mjs';

const commands = [PRIMARY_COMMAND, 'mydash'];
const names = windows => commands.flatMap(name => windows ? [name, `${name}.cmd`] : [name]);
const normalized = value => String(value).replaceAll('\\', '/');
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function owned(file, entry) {
  try {
    if (!fs.lstatSync(file).isFile()) return false;
    const body = fs.readFileSync(file, 'utf8');
    return (normalized(body).includes(`"${normalized(entry)}"`) || body.includes(shellQuote(normalized(entry)))) && body.includes('mydash.mjs');
  } catch { return false; }
}

export function writeCliShims({ binDir, node, home, entry, windows = process.platform === 'win32' }) {
  fs.mkdirSync(binDir, { recursive: true });
  const targets = names(windows).map(name => path.join(binDir, name));
  // Check every target first, including dangling links. Never replace another tool.
  for (const file of targets) {
    let exists = false;
    try { fs.lstatSync(file); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists && !owned(file, entry)) throw new Error(`Command already exists and is not this installation: ${file}`);
  }
  const custom = path.resolve(home) !== path.join(os.homedir(), '.mydash');
  for (const file of targets) {
    const cmd = file.endsWith('.cmd');
    const body = cmd
      ? `@echo off\r\n${custom ? `set "MYDASH_HOME=${home}"\r\n` : ''}"${node}" "${entry}" %*\r\n`
      : `#!/bin/sh\n${custom ? `MYDASH_HOME=${shellQuote(normalized(home))} ` : ''}exec ${shellQuote(normalized(node))} ${shellQuote(normalized(entry))} "$@"\n`;
    const tmp = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, body, { mode: 0o755 }); fs.renameSync(tmp, file); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  return path.join(binDir, PRIMARY_COMMAND + (windows ? '.cmd' : ''));
}

export function removeCliShims({ binDir, entry, windows = process.platform === 'win32' }) {
  const removed = [];
  for (const name of names(windows)) {
    const file = path.join(binDir, name);
    if (owned(file, entry)) { fs.rmSync(file); removed.push(file); }
  }
  return removed;
}
