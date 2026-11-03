import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startClaudeAuthBroker, requestClaudeAccess } from '../lib/claude-auth.mjs';
test('the private GUI-session broker relays only access credentials in memory and respects the sync switch', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix socket broker');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'broker');
  let enabled = true;
  const server = await startClaudeAuthBroker({
    dir,
    enabled: () => enabled,
    readCredential: () => ({
      accessToken: 'test-access',
      refreshToken: 'must-not-leave-broker',
      expiresAt: Date.now() + 60000,
    }),
  });
  t.after(() => new Promise((r) => server.close(r)));
  const auth = await requestClaudeAccess(dir);
  assert.equal(auth.accessToken, 'test-access');
  assert.equal('refreshToken' in auth, false);
  assert.deepEqual(fs.readdirSync(dir), ['access.sock']);
  assert.equal(fs.statSync(path.join(dir, 'access.sock')).mode & 0o077, 0);
  enabled = false;
  assert.equal(await requestClaudeAccess(dir), null);
  fs.chmodSync(dir, 0o755);
  assert.equal(await requestClaudeAccess(dir), null);
  fs.chmodSync(dir, 0o700);
});
test('the credential broker refuses unsafe socket paths and never follows symlinks', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix socket broker');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'broker');
  fs.mkdirSync(dir, { mode: 0o700 });
  const target = path.join(root, 'keep.txt');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, path.join(dir, 'access.sock'));
  assert.equal(await requestClaudeAccess(dir), null);
  await assert.rejects(() => startClaudeAuthBroker({ dir, enabled: () => true, readCredential: () => null }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});
