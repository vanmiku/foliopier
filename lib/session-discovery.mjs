// Read launch metadata, not conversation bodies, to find sessions created before
// the mydash hooks were installed. Project identity is always a canonical folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mainFolder } from './agents.mjs';
import { processIdentity } from './session-process.mjs';
const ID = /^[\w-]{6,100}$/;
export const canonicalProject = (cwd) => {
  try {
    if (!path.isAbsolute(cwd)) return null;
    const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`,
      cut = cwd.indexOf(marker);
    if (cut > 0) return fs.realpathSync(cwd.slice(0, cut));
    if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_WORK_TREE)
      return fs.realpathSync(mainFolder(cwd));
    const real = fs.realpathSync(cwd);
    // Read Git's small worktree markers directly. Spawning two synchronous Git
    // processes for every identity check blocked the shared HTTP event loop.
    for (let dir = real; ; dir = path.dirname(dir)) {
      const file = path.join(dir, '.git');
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      }
      if (stat) {
        let own;
        if (stat.isDirectory()) own = fs.realpathSync(file);
        else if (stat.isFile() && stat.size < 65536) {
          const match = /^gitdir:\s*([^\r\n]+)\s*$/i.exec(fs.readFileSync(file, 'utf8').trim());
          if (!match) return fs.realpathSync(mainFolder(cwd));
          own = fs.realpathSync(path.resolve(dir, match[1].trim()));
        } else return fs.realpathSync(mainFolder(cwd));
        const commonFile = path.join(own, 'commondir');
        let common;
        try {
          if (fs.statSync(commonFile).size > 65536) return fs.realpathSync(mainFolder(cwd));
          common = fs.realpathSync(path.resolve(own, fs.readFileSync(commonFile, 'utf8').trim()));
        } catch (e) {
          if (e.code === 'ENOENT') return real;
          return fs.realpathSync(mainFolder(cwd));
        }
        if (
          !fs.statSync(path.join(own, 'HEAD')).isFile() ||
          !fs.statSync(path.join(common, 'objects')).isDirectory()
        )
          return fs.realpathSync(mainFolder(cwd));
        return own !== common && path.basename(common) === '.git'
          ? fs.realpathSync(path.dirname(common))
          : real;
      }
      if (path.dirname(dir) === dir) return real;
    }
  } catch {
    return null;
  }
};
function head(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return '';
    const b = Buffer.alloc(Math.min(stat.size, 65536));
    return b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)).toString();
  } finally {
    fs.closeSync(fd);
  }
}
export class SessionDiscovery {
  constructor({
    codexHome,
    claudeHome,
    claudeProjects,
    desktopRoot,
    processInfo = processIdentity,
    scanBudget = 1000,
  } = {}) {
    this.codexHome =
      codexHome ||
      process.env.MYDASH_CODEX_HOME ||
      process.env.CODEX_HOME ||
      path.join(os.homedir(), '.codex');
    this.claudeHome =
      claudeHome ||
      process.env.MYDASH_CLAUDE_HOME ||
      (process.env.MYDASH_CLAUDE_PROJECTS
        ? path.dirname(process.env.MYDASH_CLAUDE_PROJECTS)
        : path.join(os.homedir(), '.claude'));
    this.claudeProjects =
      claudeProjects || process.env.MYDASH_CLAUDE_PROJECTS || path.join(this.claudeHome, 'projects');
    this.desktopRoot =
      desktopRoot ||
      (process.env.MYDASH_CLAUDE_HOME || process.env.MYDASH_CLAUDE_PROJECTS
        ? path.join(this.claudeHome, 'desktop-sessions')
        : process.platform === 'darwin'
          ? path.join(os.homedir(), 'Library/Application Support/Claude/claude-code-sessions')
          : path.join(
              process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
              'Claude/claude-code-sessions'
            ));
    this.processInfo = processInfo;
    this.rows = new Map();
    this.headers = new Map();
    this.desktopHeaders = new Map();
    this.directoryCache = new Map();
    this.scanBudget = Math.max(1, scanBudget);
    this.paths = { codex: [], desktop: [] };
    this.names = new Map();
    this.indexKey = '';
    this.pendingIndexing = false;
    this.next = 0;
  }
  invalidate() {
    this.next = 0;
  }
  refresh() {
    let liveMtime = 0;
    try {
      liveMtime = fs.statSync(path.join(this.claudeHome, 'sessions')).mtimeMs;
    } catch {}
    if (Date.now() < this.next && this.liveMtime === liveMtime) return;
    this.liveMtime = liveMtime;
    this.next = Date.now() + 5000;
    this.readNames();
    this.pendingIndexing = false;
    const rows = new Map();
    for (const meta of this.scan('codex', path.join(this.codexHome, 'sessions'), 3))
      rows.set(meta.id, { ...meta, ...this.names.get(meta.id) });
    let files = [];
    const dir = path.join(this.claudeHome, 'sessions');
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => /^\d+\.json$/.test(f))
        .slice(0, 500);
    } catch {}
    for (const f of files)
      try {
        const file = path.join(dir, f),
          stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 65536 || (process.getuid && stat.uid !== process.getuid()))
          continue;
        const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (
          !ID.test(meta.sessionId) ||
          Number(path.basename(f, '.json')) !== meta.pid ||
          typeof meta.cwd !== 'string' ||
          !path.isAbsolute(meta.cwd) ||
          meta.spare ||
          meta.kind === 'subagent'
        )
          continue;
        const info = this.processInfo(meta.pid);
        if (
          !info ||
          !/^claude(?:\.exe)?$/.test(info.command) ||
          !meta.procStart ||
          info.started !== meta.procStart.replace(/\s+/g, ' ')
        )
          continue;
        const transcript = path.join(
          this.claudeProjects,
          meta.cwd.replace(/[^A-Za-z0-9]/g, '-'),
          meta.sessionId + '.jsonl'
        );
        if (!fs.existsSync(transcript)) continue;
        rows.set(meta.sessionId, {
          id: meta.sessionId,
          agent: 'claude',
          cwd: meta.cwd,
          transcript,
          state: ['busy', 'idle'].includes(meta.status) ? meta.status : 'unknown',
          discovered: true,
          live: { ...meta, process: info },
        });
      } catch {}
    for (const m of this.scan('desktop', this.desktopRoot, 2)) {
      const native = rows.get(m.id);
      rows.set(m.id, { ...m, ...native, desktop: m.desktop });
    }
    this.rows = rows;
  }
  files(root, kind, maxDepth, depth = 0) {
    let entries;
    try {
      const stat = fs.statSync(root),
        cached = this.directoryCache.get(root);
      if (cached?.mtime === stat.mtimeMs && Date.now() - cached.at < 30000) entries = cached.entries;
      else {
        entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
        this.directoryCache.set(root, { mtime: stat.mtimeMs, entries, at: Date.now() });
      }
    } catch {
      this.directoryCache.delete(root);
      return [];
    }
    return entries.flatMap((f) => {
      const file = path.join(root, f.name);
      if (
        f.isDirectory() &&
        depth < maxDepth &&
        (kind === 'codex' ? /^\d+$/.test(f.name) : /^[\w-]+$/.test(f.name))
      )
        return this.files(file, kind, maxDepth, depth + 1);
      return f.isFile() &&
        (kind === 'codex' ? /^rollout-.+\.jsonl$/.test(f.name) : /^local_[\w-]{8,100}\.json$/.test(f.name))
        ? [file]
        : [];
    });
  }
  parseFile(file, kind) {
    if (kind === 'codex') {
      const first = JSON.parse(head(file).split('\n')[0]),
        p = first.payload;
      if (
        first.type !== 'session_meta' ||
        !ID.test(p?.id) ||
        typeof p.cwd !== 'string' ||
        !path.isAbsolute(p.cwd) ||
        typeof p.source === 'object' ||
        !file.endsWith('-' + p.id + '.jsonl')
      )
        return null;
      return { id: p.id, agent: 'codex', cwd: p.cwd, transcript: file, discovered: true };
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || (process.getuid && stat.uid !== process.getuid()))
      return null;
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      m.sessionId !== path.basename(file, '.json') ||
      !path.isAbsolute(m.cwd || '') ||
      m.isArchived ||
      m.sshConfig ||
      m.wslConfig ||
      m.movedToCloud ||
      m.cloudSessionId
    )
      return null;
    const id = ID.test(m.cliSessionId || '') ? m.cliSessionId : m.sessionId;
    const remoteId =
      [...(Array.isArray(m.bridgeSessionIds) ? m.bridgeSessionIds : []), m.remoteControlSpawn?.ccrSessionId]
        .filter((x) => /^(?:session|cse)_[A-Za-z0-9]{8,120}$/.test(x || ''))
        .at(-1) || null;
    return {
      id,
      agent: 'claude',
      cwd: m.cwd,
      discovered: true,
      state: 'unknown',
      at: new Date(m.lastActivityAt || m.createdAt || stat.mtimeMs).toISOString(),
      title: typeof m.title === 'string' ? m.title : undefined,
      desktop: { file, localId: m.sessionId, remoteId },
    };
  }
  readNames() {
    try {
      const file = path.join(this.codexHome, 'session_index.jsonl'),
        st = fs.lstatSync(file),
        key = st.mtimeMs + '|' + st.size;
      if (!st.isFile() || st.size > 8 * 1024 * 1024 || key === this.indexKey) return;
      const names = new Map();
      for (const line of fs.readFileSync(file, 'utf8').split('\n'))
        try {
          const m = JSON.parse(line);
          if (ID.test(m.id) && Number.isFinite(Date.parse(m.updated_at)))
            names.set(m.id, {
              at: m.updated_at,
              ...(typeof m.thread_name === 'string' ? { title: m.thread_name.slice(0, 100) } : {}),
            });
        } catch {}
      this.names = names;
      this.indexKey = key;
    } catch {}
  }
  scan(kind, root, depth) {
    const files = this.files(root, kind, depth),
      cache = kind === 'codex' ? this.headers : this.desktopHeaders,
      seen = new Set(files),
      rows = [];
    if (kind === 'codex' && this.names.size) {
      const activity = (file) => {
        const match = /rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(path.basename(file));
        const id = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(file)?.[1];
        return (
          Date.parse(this.names.get(id)?.at) ||
          (match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) : 0)
        );
      };
      const dates = new Map(files.map((f) => [f, activity(f)]));
      files.sort((a, b) => dates.get(b) - dates.get(a) || b.localeCompare(a));
    }
    this.paths[kind] = files;
    let budget = this.scanBudget;
    for (const file of files)
      try {
        let saved = cache.get(file);
        if (kind === 'codex' && saved?.meta) {
          rows.push(saved.meta);
          continue;
        }
        const st = fs.statSync(file),
          key = st.mtimeMs + '|' + st.size;
        if (!saved || saved.key !== key) {
          if (budget-- <= 0) {
            this.pendingIndexing = true;
            continue;
          }
          let meta = null;
          try {
            meta = this.parseFile(file, kind);
          } catch {}
          saved = { key, meta };
          cache.set(file, saved);
        }
        if (saved.meta) rows.push(saved.meta);
      } catch {}
    for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
    return rows;
  }
  all() {
    this.refresh();
    return [...this.rows.values()];
  }
  forProject(cwd) {
    const root = canonicalProject(cwd);
    if (!root) return [];
    const folders = new Map();
    return this.all().filter((r) => {
      if (!folders.has(r.cwd)) folders.set(r.cwd, canonicalProject(r.cwd));
      return folders.get(r.cwd) === root;
    });
  }
  get(id) {
    this.refresh();
    if (this.rows.has(id)) return this.rows.get(id);
    // A known thread can be opened immediately, beyond the incremental listing budget.
    for (const kind of ['codex', 'desktop']) {
      const file = this.paths[kind].find((f) =>
        kind === 'codex' ? f.endsWith('-' + id + '.jsonl') : path.basename(f, '.json') === id
      );
      if (!file) continue;
      try {
        const meta = this.parseFile(file, kind);
        if (meta?.id === id) {
          this.rows.set(id, { ...meta, ...(kind === 'codex' ? this.names.get(id) : {}) });
          if (kind === 'codex') this.headers.set(file, { meta });
          return this.rows.get(id);
        }
      } catch {}
    }
    return null;
  }
}
