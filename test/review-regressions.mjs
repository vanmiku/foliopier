// Review regressions, plain Node and temporary storage: node --test test/review-regressions.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mydash-review-unit-'));
process.env.MYDASH_HOME = home;
process.env.MYDASH_LANG = 'en';
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { markdownHtml, renderFile } = await import('../lib/render.mjs');
const { questionsOf, validateAnswers } = await import('../lib/approval.mjs');
const { renderDiff } = await import('../lib/diff.mjs');
const { addApproval, readResponses } = await import('../lib/responses.mjs');

const block = questions => '```approval\n' + JSON.stringify({ questions }) + '\n```';

async function csvPreview(name, source) {
  const abs = path.join(home, name); fs.writeFileSync(abs, source);
  return (await renderFile({ abs, rel: name, project: 'test', slug: 'csv', v: 1 })).html;
}
test('CSV delimiter detection ignores separators and newlines inside quoted fields', async () => {
  const html = await csvPreview('quoted.csv', 'name,notes\nAlice,"one;two;three;four\nnext|part"\n');
  assert.equal((html.match(/<th[ >]/g) || []).length, 2);
  assert.match(html, /<td>one;two;three;four\nnext\|part<\/td>/);
  const semi = await csvPreview('semicolon.csv', 'name;notes\r\nAlice;"one,two,three,four"\r\n');
  assert.equal((semi.match(/<th[ >]/g) || []).length, 2);
  assert.match(semi, /<td>one,two,three,four<\/td>/);
});
test('CSV with carriage-return rows preserves escaped quotes and quoted CRLF', async () => {
  const html = await csvPreview('carriage.csv', 'name,notes\rAlice,"says ""hello""\r\nnext"\rBob,end\r');
  assert.equal((html.match(/<tr>/g) || []).length, 3);
  assert.match(html, /says &quot;hello&quot;\r\nnext/);
});
test('CSV decoding supports UTF-8 BOM, UTF-16 LE/BE and existing GBK files', async () => {
  const text = 'name,city\r\nAlice,北京\r\n';
  const le = Buffer.from(text, 'utf16le');
  for (const [name, source] of [
    ['utf8', Buffer.from('\uFEFF' + text)],
    ['utf16le', Buffer.concat([Buffer.from([255, 254]), le])],
    ['utf16be', Buffer.concat([Buffer.from([254, 255]), Buffer.from(le).swap16()])],
    ['gbk', Buffer.concat([Buffer.from('name,city\r\nAlice,'), Buffer.from('b1b1bea9', 'hex'), Buffer.from('\r\n')])],
  ]) {
    const html = await csvPreview(name + '.csv', source);
    assert.match(html, /<td>北京<\/td>/, name);
    assert.equal((html.match(/<tr>/g) || []).length, 2, name);
  }
});
test('CSV separator hints are not shown as headers and ragged columns are retained safely', async () => {
  const html = await csvPreview('ragged.csv', 'sep=;\r\nname;notes\r\nAlice;"<script>alert(1)</script>";extra\r\nBob\r\n');
  assert.equal((html.match(/<th[ >]/g) || []).length, 3);
  assert.equal((html.match(/<td[ >]/g) || []).length, 6);
  assert.match(html, /<td>extra<\/td>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|<th[^>]*>sep=/);
});
test('approval blocks render the same unique question IDs used to validate answers', () => {
  const md = block([{ type: 'choice', label: 'Publish?', options: ['Yes', 'No'], required: true }]) + '\n\n' +
    block([{ type: 'choice', label: 'Keep the old version?', options: ['Keep', 'Remove'], required: true }]);
  const ids = [...markdownHtml(md).matchAll(/data-q="([^"]+)"/g)].map(m => m[1]);
  const questions = questionsOf(md);
  assert.deepEqual(ids, questions.map(q => q.id));
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(validateAnswers(questions, { [ids[0]]: 'Yes', [ids[1]]: 'Keep' }).answers,
    { [questions[0].id]: 'Yes', [questions[1].id]: 'Keep' });
});

test('explicit duplicate approval IDs also work in nested list blocks', () => {
  const a = block([{ id: 'same', type: 'text', label: 'First' }]);
  const b = block([{ id: 'same', type: 'line', label: 'Second' }]).split('\n').map(x => '  ' + x).join('\n');
  const md = a + '\n\n- Nested question\n\n' + b;
  assert.deepEqual([...markdownHtml(md).matchAll(/data-q="([^"]+)"/g)].map(m => m[1]), questionsOf(md).map(q => q.id));
});

test('extensive differences fall back within a bounded computation budget', () => {
  const a = Array.from({ length: 2500 }, (_, i) => `before_${i}`).join('\n');
  const b = Array.from({ length: 2500 }, (_, i) => `after_${i}`).join('\n');
  const result = renderDiff(a, b, { fromV: 1, toV: 2 });
  assert.equal(result.limited, true, 'entirely rewritten documents must not keep an unbounded trace');
  assert.match(result.html, /compare/i);
});

test('a small change in a long document still has an exact diff', () => {
  const a = Array.from({ length: 12000 }, (_, i) => `line_${i}`);
  const b = [...a]; b[6000] = 'the changed line';
  const result = renderDiff(a.join('\n'), b.join('\n'), { fromV: 1, toV: 2 });
  assert.notEqual(result.limited, true);
  assert.equal(result.added, 1); assert.equal(result.removed, 1);
});

test('concurrent retries save one approval, and a deliberate edit saves a new answer', async () => {
  const payload = { v: 1, answers: { go: 'Yes' }, from: 'test', requestId: 'same-confirmation-1' };
  const [a, b] = await Promise.all([addApproval('test', 'approval', payload), addApproval('test', 'approval', payload)]);
  assert.equal(a.id, b.id);
  assert.equal(readResponses('test', 'approval').approvals.length, 1);
  const edit = await addApproval('test', 'approval', { ...payload, answers: { go: 'No' }, requestId: 'deliberate-edit-2' });
  assert.notEqual(edit.id, a.id);
  assert.equal(readResponses('test', 'approval').approvals.length, 2);
});

test('a node found in a versioned Homebrew Cellar folder is written as the stable link to the same file', { skip: process.platform === 'win32' }, async () => {
  const { nodePath } = await import('../lib/sys.mjs');
  const cellar = path.join(home, 'Cellar', 'node', '25.8.0', 'bin'), bin = path.join(home, 'bin');
  fs.mkdirSync(cellar, { recursive: true }); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(cellar, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(path.join(cellar, 'node'), path.join(bin, 'node'));
  const saved = process.env.PATH;
  try {
    process.env.PATH = [cellar, bin].join(path.delimiter);  // 服务里的 PATH：node 所在的 Cellar 目录排在前面
    assert.equal(nodePath(), path.join(bin, 'node'));
    process.env.PATH = cellar;  // 找不到指向同一个文件的固定路径：就用找到的那个
    if (!['/opt/homebrew/bin/node', '/usr/local/bin/node'].some(p => { try { return fs.realpathSync(p) === fs.realpathSync(path.join(cellar, 'node')); } catch { return false; } })) assert.equal(nodePath(), path.join(cellar, 'node'));
  } finally { process.env.PATH = saved; }
});


test('a local URL bypasses Tailscale without changing share URLs or remote clients', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const config = path.join(home, 'config.json');
  const saved = fs.existsSync(config) ? fs.readFileSync(config) : null;
  const env = { ...process.env, MYDASH_HOME: home };
  for (const key of ['MYDASH_PORT', 'MYDASH_BASE_URL', 'MYDASH_REMOTE', 'MYDASH_TOKEN']) delete env[key];
  const cli = (...args) => execFileSync(process.execPath, ['bin/mydash.mjs', 'url', ...args], { env, encoding: 'utf8' }).trim();
  try {
    fs.writeFileSync(config, JSON.stringify({ port: 4915, access: 'tailscale-node', baseUrl: 'http://mydash', httpsUrl: 'https://mydash.example.ts.net' }));
    assert.equal(cli('--local'), 'http://127.0.0.1:4915/');
    assert.equal(cli('--local', 'project/article'), 'http://127.0.0.1:4915/p/project/article');
    assert.equal(cli(), 'http://mydash/');
    assert.equal(execFileSync(process.execPath, ['bin/mydash.mjs', 'url', '--local'], { env: { ...env, MYDASH_PORT: '4920' }, encoding: 'utf8' }).trim(), 'http://127.0.0.1:4920/');
    fs.writeFileSync(config, JSON.stringify({ remote: { url: 'https://remote.example', token: 'test-only' } }));
    assert.equal(cli(), 'https://remote.example/');
    const remote = spawnSync(process.execPath, ['bin/mydash.mjs', 'url', '--local'], { env, encoding: 'utf8' });
    assert.notEqual(remote.status, 0);
    assert.match(remote.stderr, /remote/i);
  } finally {
    if (saved) fs.writeFileSync(config, saved); else fs.rmSync(config, { force: true });
  }
});

test('doctor rejects a network address that answers for another installation or a generic HTTP server', async (t) => {
  const http = await import('node:http');
  const { health } = await import('../lib/checks.mjs');
  const { INSTALL_ID } = await import('../lib/store.mjs');
  const config = path.join(home, 'config.json');
  const saved = fs.existsSync(config) ? fs.readFileSync(config) : null;
  let peerId = 'another-installation';
  const server = http.createServer((req, res) => {
    const id = req.url.startsWith('/peer/') ? peerId : INSTALL_ID;
    res.writeHead(200, id ? { 'X-Mydash-Id': id } : {}); res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r));
    if (saved) fs.writeFileSync(config, saved); else fs.rmSync(config, { force: true }); });
  const port = server.address().port;
  fs.writeFileSync(config, JSON.stringify({ access: 'tailscale-node', service: 'none', office: 'no', port,
    contentPort: port, baseUrl: `http://127.0.0.1:${port}/peer` }));
  const check = async () => (await health()).checks.find((x) => x.id === 'url');
  assert.equal((await check()).ok, false, 'a name pointing at another installation must not pass');
  assert.match((await check()).detail, /this FolioPier AI installation/i);
  peerId = null;
  assert.equal((await check()).ok, false, 'a generic 200 response must not pass');
  peerId = INSTALL_ID;
  assert.equal((await check()).ok, true);
});

test('doctor requires both forwards for a running standalone Tailscale node', { skip: process.platform === 'win32' }, async (t) => {
  const { health } = await import('../lib/checks.mjs');
  const config = path.join(home, 'config.json'), saved = fs.existsSync(config) ? fs.readFileSync(config) : null;
  const bin = path.join(home, 'ts/bin'), map = path.join(home, 'fake-serve.json');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(map, '{}');
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\ncase "$*" in *"serve status --json"*) cat '${map}';; *) echo '{"BackendState":"Running","Self":{"DNSName":"mydash-1.example.ts.net."}}';; esac\n`, { mode: 0o755 });
  fs.writeFileSync(config, JSON.stringify({ access: 'tailscale-node', service: 'none', office: 'no', port: 4998, contentPort: 4999, baseUrl: 'http://127.0.0.1:1' }));
  t.after(() => { fs.rmSync(path.join(home, 'ts'), { recursive: true, force: true }); fs.rmSync(map, { force: true });
    if (saved) fs.writeFileSync(config, saved); else fs.rmSync(config, { force: true }); });
  const check = async () => (await health()).checks.find((x) => x.id === 'tailscale-serve');
  assert.equal((await check())?.ok, false, 'Running alone does not make the web service reachable');
  fs.writeFileSync(map, JSON.stringify({ Web: { 'mydash-1:80': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4998' } } } } }));
  assert.equal((await check())?.ok, false, 'the content port must also be forwarded');
  fs.writeFileSync(map, JSON.stringify({ Web: { 'mydash-1:80': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4998' } } }, 'mydash-1:4999': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4999' } } } } }));
  assert.equal((await check())?.ok, true);
});
