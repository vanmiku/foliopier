#!/usr/bin/env node
import { HOME, readConfig } from '../lib/store.mjs';
import { startClaudeAuthBroker, authBrokerDir } from '../lib/claude-auth.mjs';
import { readNativeClaudeCredentials } from '../lib/claude-remote.mjs';
import fs from 'node:fs';
import path from 'node:path';
if (process.platform !== 'darwin') process.exit(0);
await startClaudeAuthBroker({
  dir: authBrokerDir(HOME),
  readCredential: readNativeClaudeCredentials,
  enabled: () => readConfig().terminalSessions?.enabled === true,
});
const flag = path.join(HOME, 'app/.restart');
let stamp;
try {
  stamp = fs.statSync(flag).mtimeMs;
} catch {}
setInterval(() => {
  try {
    if (fs.statSync(flag).mtimeMs !== stamp) process.exit(0);
  } catch {}
}, 1000).unref();
