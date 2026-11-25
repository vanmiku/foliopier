import { layout, buildStamp } from './views.mjs';
import { esc } from './render.mjs';
import { SHARE_KINDS, safeShareRel } from './share-resources.mjs';
import { kindOf } from './kinds.mjs';
import { t } from './i18n.mjs';

export const itemHref = (p, s) => `/p/${encodeURIComponent(p)}/${encodeURIComponent(s)}`;
export const projectHref = p => `/p/${encodeURIComponent(p)}`;
export function workflowHref(project, name, query = {}) {
  const params = new URLSearchParams(query).toString();
  return `/workflow/${encodeURIComponent(project)}/${name}${params ? '?' + params : ''}`;
}
export const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value ?? '')}">`;
export const jsonBlock = (id, value) => `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;
export const option = (value, label, selected = false) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
export const link = (href, label, css = '') => `<a ${css ? `class="${css}" ` : ''}href="${esc(href)}">${esc(label)}</a>`;
export const button = (label, action = '', css = 'act') => `<button class="${css}" ${action ? `type="button" data-action="${action}"` : 'type="submit"'}>${esc(label)}</button>`;
export const statusLine = '<p data-work-status role="status" aria-live="polite"></p>';

export function workflowPage(project, title, body) {
  return layout({ title, page: 'workflow', crumbs: [{ text: project, href: projectHref(project) }, { text: title }],
    head: `<link rel="stylesheet" href="/static/workflows.css?b=${buildStamp()}"><script defer src="/static/workflows.js?b=${buildStamp()}" data-build="${buildStamp()}"></script>`,
    body: `<div class="workflow"><h1>${esc(title)}</h1>${body}</div>` });
}

export function packageOwnerPage(project, documents, packages, current, settings) {
  const home = workflowHref(project, 'packages');
  const enabled = settings?.enabled === true && Boolean(settings.publicUrl);
  const saved = new Map((current?.package.entries || []).map(e => [e.snapshot.slug, e]));
  const options = documents.map(m => {
    const versions = m.versions.slice().reverse().map(v => {
      const files = v.files.filter(f => safeShareRel(f.path) && SHARE_KINDS.has(kindOf(f.path))).map(f => ({ path: f.path }));
      return { v: v.v, main: files.find(f => f.path === v.main)?.path || files[0]?.path, files };
    }).filter(v => v.files.length);
    return { slug: m.slug, title: m.versions.at(-1).title, versions };
  }).filter(doc => doc.versions.length);
  for (const [slug, entry] of saved) {
    const v = { v: entry.snapshot.version, main: entry.snapshot.main, files: entry.snapshot.files };
    const doc = options.find(o => o.slug === slug);
    if (!doc) options.push({ slug, title: entry.title, versions: [v] });
    else if (!doc.versions.some(x => x.v === v.v)) doc.versions.push(v);
  }
  const title = t('Delivery packages');
  const list = packages.map(pkg => `<li>${link(workflowHref(project, 'packages', { id: pkg.id }), pkg.title)} · ${t('Revision {n}', { n: pkg.package.revision })} · ${esc(statusLabel(pkg.status))}</li>`).join('');
  const unfinished = current && current.status !== 'active';
  const expiryOptions = [24, 168, 720].map((n, index) => option(n, [t('24 hours'), t('7 days'), t('30 days')][index])).join('');
  const form = `<form data-work-form="package">
    <h2>${current ? t('Update delivery package') : t('Create delivery package')}</h2>
    <label>${t('Title')}<input name="title" maxlength="200" value="${esc(current?.title || '')}" required></label>
    <label>${t('Description')}<textarea name="description" maxlength="2000">${esc(current?.description || '')}</textarea></label>
    <div class="workflow-row"><label>${t('Expires')}<select name="expiresInHours">${current ? option('', t('Keep current expiry')) : ''}${expiryOptions}</select></label>
    <label class="workflow-check"><input name="allowPdf" type="checkbox"${current?.allowPdf ? ' checked' : ''}>${t('Allow PDF downloads')}</label></div>
    <div data-package-entries></div>
    <div class="workflow-actions"><select aria-label="${t('Choose a document')}" data-package-picker>${option('', t('Choose a document'))}${options.map(m => option(m.slug, m.title)).join('')}</select>${button(t('Add document'), 'add-entry')}</div>
    <div class="workflow-actions">${button(t('Preview as a visitor'), '', 'btn')}<a class="act" data-package-preview hidden target="_blank" rel="noopener"></a>${button(t('Publish this revision'), 'publish-package', 'btn')}</div>
    ${statusLine}
  </form>
  <template id="package-entry-template"><fieldset data-package-entry><legend></legend><div class="workflow-actions">${button(t('Move up'), 'up')}${button(t('Move down'), 'down')}${button(t('Remove'), 'remove')}</div>
  <label>${t('Version')}<select name="version"></select></label><label>${t('Open first')}<select name="main"></select></label>
  <div data-package-files aria-label="${t('Files visitors can open')}"></div></fieldset></template>`;
  return workflowPage(project, title, `<p>${link(projectHref(project), t('Back to project'))}</p>
    ${list ? `<ul>${list}</ul>` : ''}
    ${current ? `<div class="workflow-actions">${link(home, t('Create delivery package'), 'act')}${enabled && !unfinished ? `${settings.publicUrl ? link(settings.publicUrl + '/s/' + current.id, t('Open shared link'), 'act') : ''}${button(t('Reset access code'), 'reset-package')}${button(t('Revoke link'), 'revoke-package')}` : ''}</div><section data-package-result aria-live="polite"></section>` : '<section data-package-result aria-live="polite"></section>'}
    ${enabled && !unfinished ? form : enabled ? '' : `<p>${link('/settings#internet-sharing', t('Set up internet sharing'))}</p>`}
    ${jsonBlock('package-data', { project, id: current?.id, revision: current?.package.revision || 0, options, entries: [...saved.values()].map(e => e.snapshot) })}
    ${jsonBlock('package-strings', { preview: t('Open visitor preview'), link: t('Share link'), code: t('Access code'), manage: t('Manage delivery package'), revoked: t('This share is no longer available.'), select: t('Select at least one document.'), revoke: t('Revoke the link for this entire package?'), rotate: t('Reset the code and end all current visitor sessions?') })}`);
}

function statusLabel(status) {
  switch (status) {
    case 'active': return t('Active');
    case 'expired': return t('Expired');
    case 'revoked': return t('Revoked');
    default: return t('Unavailable');
  }
}
