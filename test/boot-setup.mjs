import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-boot-test-'));
process.env.MYDASH_HOME = home;
process.env.MYDASH_LANG = 'en';
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { installService, SERVICES, DAEMON_DIR } = await import('../lib/service.mjs');
const actions = await import('../lib/actions.mjs');

test('an already-correct boot service refreshes stale staging', { skip: process.platform !== 'darwin' }, async t => {
  const label = SERVICES.tailscaled.launchd;
  const stage = path.join(home, 'state/boot', label + '.plist');
  const args = ['/example/tailscaled', '--port=0'];
  const first = await installService('tailscaled', args, {}, 'launchd-boot');
  assert.equal(first.needsRoot, true);
  const desired = fs.readFileSync(stage, 'utf8');
  fs.writeFileSync(stage, desired.replace('/example/tailscaled', '/old/tailscaled'));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...rest) => file === path.join(DAEMON_DIR, label + '.plist') ? desired : read(file, ...rest));
  const result = await installService('tailscaled', args, {}, 'launchd-boot');
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(stage, 'utf8'), desired);
});

test('interaction unavailable is distinct from cancellation or denied credentials', () => {
  assert.equal(typeof actions.bootOutcome, 'function');
  const noUi = actions.bootOutcome(new Error('osascript'), 'execution error: 管理员用户名或密码不正确。 (-60007)');
  assert.equal(noUi.code, 'interaction-unavailable');
  assert.equal(noUi.canceled, false);
  assert.equal(actions.bootOutcome(new Error('cancel'), 'User canceled. (-128)').canceled, true);
  assert.equal(actions.bootOutcome(new Error('denied'), 'Denied (-60005)').code, 'denied');
  assert.equal(actions.bootOutcome(null, '').ok, true);
});

test('authorization agent is scoped to this installation and runs in the GUI session', () => {
  assert.equal(typeof actions.bootAgent, 'function');
  const plan = actions.bootAgent({ uid: 501, script: 'do shell script "safe"', node: '/example/node' });
  assert.equal(plan.domain, 'gui/501');
  assert.equal(plan.label, SERVICES.server.launchd + '.boot-setup');
  assert.match(plan.xml, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
  assert.match(plan.xml, /<string>\/example\/node<\/string>/);
  assert.doesNotMatch(plan.xml, /<key>UserName<\/key>|<key>KeepAlive<\/key><true/);
  assert.throws(() => actions.bootAgent({ uid: 0, script: '', node: '/example/node' }), /user/i);
});
