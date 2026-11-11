import test from 'node:test';
import assert from 'node:assert/strict';
process.env.MYDASH_LANG = 'en';
const { sharingButton, sharingItemPanel, sharingSettingsSection } = await import('../lib/share-owner-views.mjs');

test('share action is named and private bootstrap omits source and agent metadata', () => {
  assert.match(sharingButton(), /data-share-open/);
  const meta = { project: 'test', slug: 'sample', cwd: '/private/path', host: 'private-host', session: 'private-session' };
  const ver = { title: 'Title </script>', main: 'report.md', files: [{ path: 'report.md', kind: 'md', size: 10 }, { path: 'rows.csv', kind: 'table', size: 12 }, { path: '_private.json', kind: 'json', size: 4 }, { path: 'movie.mp4', kind: 'video', size: 100 }] };
  const html = sharingItemPanel(meta, ver, 'report.md');
  assert.match(html, /data-share-create/);
  assert.match(html, /data-share-manage/);
  assert.match(html, /rows\.csv/);
  for (const secret of ['/private/path', 'private-host', 'private-session', '_private.json', 'movie.mp4']) assert.equal(html.includes(secret), false);
  assert.equal(html.includes('Title </script>'), false);
  const bootstrap = JSON.parse(html.match(/id="share-owner-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(bootstrap.title, ver.title);
  const unusual = sharingItemPanel(meta, { ...ver, main: 'name<part>.md', files: [{ path: 'name<part>.md', kind: 'md', size: 1 }] }, 'name<part>.md');
  assert.equal(JSON.parse(unusual.match(/id="share-owner-data">([\s\S]*?)<\/script>/)[1]).main, 'name<part>.md');
});

test('settings includes a setup wizard and explicit irreversible shutdown explanation', () => {
  const html = sharingSettingsSection();
  assert.match(html, /id="internet-sharing"/);
  assert.match(html, /data-sharing-enable/);
  assert.match(html, /data-sharing-check/);
  assert.match(html, /data-sharing-disable/);
  assert.match(html, /data-sharing-return/);
  assert.match(html, /data-sharing-management/);
  assert.match(html, /data-sharing-confirm/);
});
