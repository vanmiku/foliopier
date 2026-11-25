import { recordToken } from './version-review.mjs';
import { t } from './i18n.mjs';
import { esc } from './render.mjs';
import { workflowPage, workflowHref, itemHref, link, option, button, statusLine, jsonBlock, hidden } from './workflow-views.mjs';

function errorMessage(model) {
  switch (model.code) {
    case 'missing': return t('One of the exact source versions is unavailable.');
    case 'limit': return t('The comparison limit is 2 MB per file, 5,000 rows, 250 columns and 250,000 cells. Open the originals to review the full files.');
    case 'headers': return t('Version {v} has missing or repeated column headers.', { v: model.version });
    case 'long-headers': return t('Version {v} has a column header longer than 512 characters.', { v: model.version });
    case 'format': return t('Check the CSV format at record {row} in v{v}.', { row: model.row, v: model.version });
    case 'key': return t('Choose a column that exists in both versions.');
    case 'sheet': return t('The workbooks have no sheets with the same name.');
    case 'duplicate': return t('Version {v} has blank or duplicate record IDs.', { v: model.version });
    case 'unreadable': return t('The comparison could not read these files.');
    default: return '';
  }
}

export function comparisonPage(ctx) {
  const { project, slug, file, base, v, meta, sheet, key, oldFile, newFile, result, anchor } = ctx;
  const { changes, sheets, keys, type } = result;
  const params = { slug, file, base, v, sheet, key };
  const search = String(ctx.search || '').slice(0, 200);
  const filter = ['added', 'removed', 'changed'].includes(ctx.filter) ? ctx.filter : '';
  const choice = (name, items, label) => `<label>${label}<select name="${name}">${items.join('')}</select></label>`;
  const versionChoices = selected => [...(meta?.versions || [])].reverse().filter(ver => ver.files.some(f => f.path === file)).map(ver => option(ver.v, 'v' + ver.v, ver.v === selected));
  const filters = { added: t('Added rows'), removed: t('Removed rows'), changed: t('Changed rows') };
  const known = changes || [];
  const highlighted = anchor && known.find(row => anchor.comparison.recordToken ? recordToken(row.id) === anchor.comparison.recordToken : row.id === anchor.comparison.record);
  const filtered = highlighted ? [highlighted] : known.filter(row => (!filter || row.type === filter) && (!search || row.id.toLocaleLowerCase().includes(search.toLocaleLowerCase())));
  const total = filtered.reduce((sum, row) => sum + row.cells.length, 0);
  const pageSize = 24, maxPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(maxPage, Math.max(1, Number(ctx.page) || 1));
  let seen = 0;
  const entries = [];
  for (const row of filtered) {
    const offset = (page - 1) * pageSize;
    const cells = row.cells.slice(Math.max(0, offset - seen), Math.max(0, offset + pageSize - seen));
    seen += row.cells.length;
    if (!cells.length) continue;
    entries.push(`<section class="review-row"><h3>${esc(row.id.slice(0, 1000))} <small>${filters[row.type]}</small></h3>${cells.map(cell => cellReview(params, row, cell)).join('')}</section>`);
    if (seen >= offset + pageSize) break;
  }
  const pagination = num => workflowHref(project, 'compare', { ...params, search, filter, page: num });
  const originals = [oldFile, newFile].filter(Boolean).map(f => link(f.url, t('Read v{v}', { v: f.ver.v }), 'act')).join('');
  const title = t('Version review');
  return workflowPage(project, title, `<p>${link(itemHref(project, slug), t('Back to the document'))} · <code>${esc(file)}</code></p>
    <div class="workflow-actions">${originals}</div>
    <form method="get" class="review-filters">${hidden('slug', slug)}${hidden('file', file)}
      <div class="workflow-row">${choice('base', versionChoices(base), t('Previous version'))}${choice('v', versionChoices(v), t('Version to review'))}
      ${sheets?.length ? choice('sheet', [option('', t('Choose a sheet')), ...sheets.map(n => option(n, n, n === sheet))], t('Worksheet')) : ''}
      ${keys?.length ? choice('key', [option('', t('Choose an ID column')), ...keys.map(n => option(n, n, key === n))], t('Record ID column')) : ''}
      ${button(t('Compare'))}</div>
      ${changes ? `<div class="workflow-row">${choice('filter', [option('', t('All changes')), ...Object.entries(filters).map(([value, label]) => option(value, label, filter === value))], t('Filter'))}
      <label>${t('Search record IDs')}<input name="search" value="${esc(search)}" maxlength="200"></label>${button(t('Apply filters'))}</div>` : ''}
    </form>
    ${anchor ? savedComment(anchor, result, highlighted) : ''}
    ${result.code ? `<p role="status">${esc(errorMessage(result))}</p>` : ''}
    ${result.problems ? `<ul>${result.problems.map(p => `<li>${esc(p.first ? t('Record {row} repeats the ID from record {first}.', p) : t('Record {row} is missing an ID.', p))}</li>`).join('')}</ul>` : ''}
    ${type ? mediaReview(type, oldFile, newFile, file) : ''}
    ${changes ? `<p>${t('{n} changed record|{n} changed records', { n: known.length })} · ${t('{n} matching record|{n} matching records', { n: filtered.length })}</p>
      ${entries.join('')}
      ${!entries.length ? `<p>${t('No matching changes.')}</p>` : ''}
      ${maxPage > 1 ? `<nav class="workflow-actions">${page > 1 ? link(pagination(page - 1), t('Previous page')) : ''}<span>${t('Page {n} of {total}', { n: page, total: maxPage })}</span>${page < maxPage ? link(pagination(page + 1), t('Next page')) : ''}</nav>` : ''}
      ${jsonBlock('review-data', { project })}` : ''}`);
}

function cellReview(params, row, cell) {
  return `<details ${row.cells.length === 1 ? 'open' : ''} class="review-cell"><summary>${esc(cell.name)}</summary>
    <div class="review-values"><div><strong>v${params.base}</strong><pre>${display(cell.old)}</pre></div><div><strong>v${params.v}</strong><pre>${display(cell.current)}</pre></div></div>
    <form data-work-form="review-comment">
      ${Object.entries({ ...params, record: recordToken(row.id), column: cell.name }).map(([name, value]) => hidden(name, value)).join('')}
      <label>${t('Cell comment')}<textarea name="text" maxlength="5000" required></textarea></label>
      <div>${button(t('Save comment'))}</div>${statusLine}
    </form>
  </details>`;
}

function display(value) {
  return value === null ? esc(t('Absent')) : value === '' ? esc(t('Empty value')) : esc(value.length > 1600 ? value.slice(0, 1600) + '…' : value);
}

function savedComment(comment, result, highlighted) {
  const anchored = comment.comparison;
  const cell = highlighted?.cells.find(c => c.name === anchored.column);
  const exists = cell && (cell.old?.slice(0, 1000) ?? null) === anchored.old && (cell.current?.slice(0, 1000) ?? null) === anchored.current;
  return `<section id="review-comment-${esc(comment.id)}" class="review-row" tabindex="-1"><h2>${t('Saved cell comment')}</h2>
    <p>${esc(anchored.record)} · ${esc(anchored.column)} · v${anchored.base} → v${anchored.v}</p>
    <div class="review-values"><pre>${display(anchored.old)}</pre><pre>${display(anchored.current)}</pre></div>
    <p>${esc(comment.text)}</p>${!exists && !result.code ? `<p>${t('The original change needs to be checked again. The saved comment is shown above.')}</p>` : ''}</section>`;
}

function mediaReview(type, oldFile, newFile, file) {
  const panes = [oldFile, newFile].map(source => `<figure><figcaption>v${source.ver.v}</figcaption>
    <div class="review-media-pane">${type === 'image' ? `<img src="${esc(source.url)}" alt="${esc(file)}">` : `<canvas data-pdf-source="${esc(source.url)}"></canvas><p data-pdf-note></p>`}</div></figure>`).join('');
  const controls = type === 'image' ? `<label>${t('Zoom both images')}<input type="range" min="100" max="300" value="100" step="10" data-review-zoom></label>`
    : `<label>${t('Show page in both versions')}<input type="number" min="1" value="1" step="1" data-review-page disabled></label>`;
  return `<section data-review-media>${controls}<div class="review-media-panes">${panes}</div>${statusLine}${jsonBlock('media-review-strings', { loading: t('Loading PDF…'), failed: t('The PDF preview is unavailable. Open the original file.'), absent: t('This version has no page with that number.') })}</section>`;
}
