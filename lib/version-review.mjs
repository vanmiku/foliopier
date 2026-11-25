import fs from 'node:fs';
import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { readMeta, itemDir, versionFile, rawPath } from './store.mjs';
import { kindOf } from './kinds.mjs';
import { csvRows } from './csv.mjs';

const LIMIT = 2 * 1024 * 1024;
export const recordToken = id => crypto.createHash('sha256').update(id).digest('hex');
export const reviewable = file => ['image', 'pdf', 'table', 'sheet'].includes(kindOf(file));

export function exactFile(project, slug, version, file, meta = readMeta(project, slug)) {
  if (!Number.isInteger(version) || version < 1 || typeof file !== 'string') return null;
  const ver = meta?.versions.find(v => v.v === version);
  if (!ver?.files.some(f => f.path === file)) return null;
  const abs = versionFile(itemDir(project, slug), version, file);
  try {
    if (!abs || !fs.statSync(abs).isFile()) return null;
    return { abs, ver, url: rawPath(project, slug, version, file) };
  } catch { return null; }
}

function checkedTable(rows) {
  const [columns = [], ...records] = rows;
  if (!columns.length || columns.some(c => !c.trim()) || new Set(columns).size !== columns.length) return { code: 'headers' };
  if (columns.some(c => c.length > 512)) return { code: 'long-headers' };
  if (columns.length > 250 || records.length * columns.length > 250_000 || records.length > 5000) return { code: 'limit' };
  const bad = records.findIndex(row => row.length !== columns.length);
  if (bad !== -1) return { code: 'format', row: bad + 2 };
  return { columns, records };
}

function sheetRows(book, sheet) {
  const source = book.Sheets[sheet], ref = source?.['!ref'];
  if (!ref) return { code: 'headers' };
  const range = XLSX.utils.decode_range(source['!fullref'] || ref);
  if (range.e.r - range.s.r > 5000 || range.e.c - range.s.c >= 250 || (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 250_000) return { code: 'limit' };
  const options = { header: 1, defval: '', blankrows: true };
  const table = checkedTable(XLSX.utils.sheet_to_json(source, { ...options, raw: false }).map(row => row.map(String)));
  if (!table.code) table.values = XLSX.utils.sheet_to_json(source, { ...options, raw: true }).slice(1);
  return table;
}

export function reviewFiles(oldFile, newFile, file, { sheet = '', key = '' } = {}) {
  const type = kindOf(file);
  if (!oldFile || !newFile) return { code: 'missing' };
  if (type === 'pdf' || type === 'image') return { type };
  if (fs.statSync(oldFile.abs).size > LIMIT || fs.statSync(newFile.abs).size > LIMIT) return { code: 'limit' };
  let tables;
  let sheets = [];
  if (type === 'sheet') {
    const opts = { type: 'buffer', sheetRows: 5002, dense: true };
    const books = [oldFile, newFile].map(f => XLSX.read(fs.readFileSync(f.abs), { ...opts, bookSheets: true }));
    const names = new Set(books[1].SheetNames);
    sheets = books[0].SheetNames.filter(name => names.has(name));
    if (!sheets.length) return { code: 'sheet' };
    if (!sheets.includes(sheet)) return { sheets };
    tables = [oldFile, newFile].map(f => sheetRows(XLSX.read(fs.readFileSync(f.abs), { ...opts, sheets: [sheet] }), sheet));
  } else {
    tables = [oldFile, newFile].map(f => {
      const parsed = csvRows(fs.readFileSync(f.abs, 'utf8'), { strict: true, tsv: /\.tsv$/i.test(file) });
      return parsed.limit ? { code: 'limit' } : parsed.invalidAt ? { code: 'format', row: parsed.invalidAt } : checkedTable(parsed.rows);
    });
  }
  const bad = tables.findIndex(table => table.code);
  if (bad !== -1) return { ...tables[bad], version: [oldFile, newFile][bad].ver.v, sheets };
  const [oldTable, newTable] = tables;
  const keys = oldTable.columns.filter(col => newTable.columns.includes(col));
  if (!keys.includes(key)) return { keys, sheets, ...(key ? { code: 'key' } : {}) };
  const maps = [];
  for (const [i, table] of tables.entries()) {
    const at = table.columns.indexOf(key), seen = new Map(), problems = [];
    for (const [n, record] of table.records.entries()) {
      const id = record[at];
      if (!id.trim() || seen.has(id)) {
        if (problems.length < 5) problems.push({ row: n + 2, first: seen.get(id)?.row, id });
      } else seen.set(id, { row: n + 2, record, values: table.values?.[n] });
    }
    if (problems.length) return { code: 'duplicate', problems, version: [oldFile, newFile][i].ver.v, keys, sheets };
    maps.push(seen);
  }
  const columns = [...new Set([...oldTable.columns, ...newTable.columns])].map(name => ({
    name, old: oldTable.columns.indexOf(name), current: newTable.columns.indexOf(name),
  }));
  const [before, after] = maps, changes = [];
  for (const id of new Set([...after.keys(), ...before.keys()])) {
    const a = before.get(id), b = after.get(id);
    const cells = [];
    for (const col of columns) {
      const old = a?.record[col.old] ?? null, current = b?.record[col.current] ?? null;
      const oldValue = a?.values?.[col.old], currentValue = b?.values?.[col.current];
      if (old !== current) cells.push({ name: col.name, old, current });
      // Keep formatted IDs and existing comparisons. Show the underlying
      // numbers when the formatted labels would hide a change.
      else if (typeof oldValue === 'number' && typeof currentValue === 'number' && oldValue !== currentValue) {
        cells.push({ name: col.name, old: String(oldValue), current: String(currentValue) });
      }
    }
    if (cells.length) changes.push({ id, type: !a ? 'added' : !b ? 'removed' : 'changed', cells });
  }
  return { keys, sheets, columns, changes };
}

export function comparisonLink(project, slug, anchor, id = '') {
  const params = new URLSearchParams({ slug, file: anchor.file, base: anchor.base, v: anchor.v, key: anchor.key, sheet: anchor.sheet || '' });
  if (id) params.set('comment', id);
  return `/workflow/${encodeURIComponent(project)}/compare?${params}${id ? '#review-comment-' + encodeURIComponent(id) : ''}`;
}
