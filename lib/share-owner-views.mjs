import { t } from './i18n.mjs';
import { esc } from './render.mjs';
import { SHARE_KINDS } from './share-resources.mjs';

const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

function confirmDialog() {
  return `<dialog class="share-owner-dialog share-owner-confirm" data-sharing-confirm aria-labelledby="share-confirm-title">
    <h2 id="share-confirm-title">${t('Confirm sharing change')}</h2><p data-share-confirm-message></p>
    <div class="share-owner-actions"><button type="button" class="act" data-share-confirm-cancel>${t('Cancel')}</button><button type="button" class="act" data-share-confirm-manage hidden>${t('Manage and stop shares')}</button><button type="button" class="btn" data-share-confirm-accept>${t('Confirm')}</button></div>
  </dialog>`;
}

function setupControls({ settings = false } = {}) {
  return `<div class="share-owner-network" data-sharing-controls>
    <p class="share-owner-status" data-sharing-status role="status" aria-live="polite">${t('Checking sharing setup…')}</p>
    <div class="share-owner-actions" data-sharing-actions hidden>
      <a class="btn" data-sharing-auth hidden target="_blank" rel="noopener noreferrer">${t('Open Tailscale authorization')}</a>
      <a class="btn" data-sharing-install hidden href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">${t('Get Tailscale')}</a>
      <a class="btn" data-sharing-admin hidden target="_blank" rel="noopener noreferrer">${t('Open Tailscale admin settings')}</a>
      <button type="button" class="btn" data-sharing-connect hidden>${t('Connect Tailscale')}</button>
      <button type="button" class="btn" data-sharing-enable hidden>${t('Enable internet sharing')}</button>
      <button type="button" class="act" data-sharing-check hidden>${t('Check again')}</button>
      ${settings ? `<button type="button" class="act share-owner-danger" data-sharing-disable hidden>${t('Turn off all sharing')}</button>` : ''}
    </div>
    <details data-sharing-help hidden><summary>${t('Sharing setup help')}</summary>
      <div class="share-owner-actions">
        <a href="https://tailscale.com/docs/features/tailscale-funnel" target="_blank" rel="noopener noreferrer">${t('Tailscale Funnel instructions')}</a>
        <a data-sharing-client-help hidden href="https://tailscale.com/docs/concepts/macos-variants" target="_blank" rel="noopener noreferrer">${t('Supported Tailscale clients for macOS')}</a>
        <button type="button" class="act" data-sharing-copy>${t('Copy sharing diagnostics')}</button>
      </div>
      <output data-sharing-copy-status aria-live="polite"></output>
    </details>
  </div>`;
}

export function sharingButton() {
  return `<button type="button" class="act share-action" data-share-open aria-haspopup="dialog"><span>${t('Share')}</span><b data-share-unread hidden></b></button>`;
}

export function sharingItemPanel(meta, ver, rel) {
  const files = ver.files.filter(f => SHARE_KINDS.has(f.kind) && !f.path.split('/').some(p => p.startsWith('.')) && !f.path.startsWith('_'))
    .map(f => ({ path: f.path, kind: f.kind, size: f.size }));
  const main = files.find(f => f.path === rel && f.kind === 'md')?.path || files.find(f => f.path === ver.main && f.kind === 'md')?.path || files.find(f => f.kind === 'md')?.path || '';
  const data = { project: meta.project, slug: meta.slug, title: ver.title, version: ver.v, main, files };
  return `<script type="application/json" id="share-owner-data">${json(data)}</script>
  <dialog class="share-owner-dialog" id="share-owner-dialog" aria-labelledby="share-owner-title">
    <header class="share-owner-head"><h2 id="share-owner-title">${t('Share document')}</h2><button type="button" class="act" data-share-close>${t('Close')}</button></header>
    <nav class="share-owner-tabs" aria-label="${t('Sharing options')}"><button type="button" class="act on" data-share-tab="create" aria-pressed="true">${t('Create share')}</button><button type="button" class="act" data-share-tab="manage" aria-pressed="false">${t('Manage shares')} <span data-share-count></span></button></nav>
    <p class="share-owner-status" data-share-owner-status role="status" aria-live="polite"></p>
    <div data-share-create>
      <p class="share-owner-hint">${t('Share selected published files with a link and access code. Agent conversations and internal feedback stay private.')}</p>
      ${main ? setupControls() : ''}
      <div data-sharing-article-pdf class="share-owner-hint" hidden>${t('PDF downloads are not ready on the sharing computer. Install Chrome or Edge there before offering PDF downloads.')} <a data-share-setup-link>${t('Set up PDF downloads')}</a></div>
      ${main ? `<form id="share-create-form">
        <label class="share-owner-field">${t('Public title')}<input name="title" maxlength="300" value="${esc(ver.title)}" required></label>
        <label class="share-owner-field">${t('Public name (optional)')}<input name="publisher" maxlength="100" autocomplete="off"></label>
        <fieldset class="share-owner-files"><legend>${t('Files to share')}</legend><p class="share-owner-hint">${t('Share the latest published files. Select only the attachments you want visitors to see.')}</p><div class="share-owner-actions share-owner-selection-tools"><button type="button" class="act" data-share-select-all>${t('Select all files')}</button><button type="button" class="act" data-share-select-main>${t('Main document only')}</button><output data-share-selected-count aria-live="polite">${t('{n} file selected|{n} files selected', { n: 1 })}</output></div><label><input type="checkbox" name="files" value="${esc(main)}" checked disabled><span>${esc(main)} <small>${t('Main document')}</small></span></label>${files.filter(f => f.path !== main).map(f => `<label><input type="checkbox" name="files" value="${esc(f.path)}"><span>${esc(f.path)} <small>${esc(f.kind.toUpperCase())}</small></span></label>`).join('')}</fieldset>
        <div class="share-owner-grid"><label class="share-owner-field">${t('Share duration')}<select name="duration"><option value="1">${t('1 hour')}</option><option value="24" selected>${t('24 hours')}</option><option value="168">${t('7 days')}</option><option value="custom">${t('Custom expiry')}</option></select></label><label class="share-owner-field">${t('Document updates')}<select name="mode"><option value="latest">${t('Follow published updates')}</option><option value="fixed">${t('Fix this version (v{v})', { v: ver.v })}</option></select></label></div>
        <label class="share-owner-field" data-share-custom-expiry hidden>${t('Expires at (your local time)')}<input name="expiresAt" type="datetime-local"></label>
        <p class="share-owner-hint">${t('New attachments require your approval. Existing selected documents follow updates unless the version is fixed.')}</p>
        <div class="share-owner-checks"><label><input type="checkbox" name="allowPdf" checked>${t('Allow PDF downloads')}</label><label><input type="checkbox" name="allowComments" checked>${t('Allow private comments')}</label></div>
        <p class="share-owner-hint">${t('Anyone with the link and code can forward them. Stopping a share cannot recall files already saved.')}</p>
        <div class="share-owner-actions"><button type="button" class="act" data-share-preview>${t('Preview as a visitor')}</button><button type="submit" class="btn" data-share-submit disabled>${t('Create link and code')}</button></div>
      </form>` : `<p>${t('This item needs a Markdown document before it can be shared.')}</p>`}
      <div class="share-owner-result" data-share-result hidden></div>
      <section class="share-owner-preview" data-share-preview-panel hidden><div class="share-owner-head"><h3>${t('Visitor preview')}</h3><button type="button" class="act" data-share-preview-close>${t('Close preview')}</button></div><p class="share-owner-hint">${t('Private preview only. This does not create a public share.')}</p><iframe title="${t('Visitor preview')}" sandbox="allow-scripts allow-same-origin" data-share-preview-frame></iframe></section>
    </div>
    <section data-share-manage hidden><div data-sharing-management></div></section>
  </dialog>${confirmDialog()}`;
}

export function sharingSettingsSection({ lan = false } = {}) {
  if (lan) return `<section class="set-sec" aria-labelledby="internet-sharing-title">
    <h2 id="internet-sharing-title">${t('Internet document sharing')}</h2>
    <p class="set-hint">${t('To set up internet sharing, open FolioPier AI on the computer hosting your documents or through its trusted Tailscale address.')}</p>
  </section>`;
  return `<section class="set-sec share-owner-settings" id="internet-sharing" tabindex="-1" aria-labelledby="internet-sharing-title">
    <h2 id="internet-sharing-title">${t('Internet document sharing')}</h2>
    <p class="set-hint">${t('People can read your selected documents using a link and access code, without installing Tailscale.')}</p>
    ${setupControls({ settings: true })}
    <p class="set-hint">${t('Keep this computer online with FolioPier AI and Tailscale running. Your device domain appears in public certificate records.')}</p>
    <p class="set-hint" data-sharing-public-url></p><p class="set-hint" data-sharing-external></p>
    <p class="set-hint" data-sharing-pdf-help hidden>${t('Install Chrome or Edge on the computer running FolioPier AI to enable one-click PDF downloads.')} <a href="https://www.google.com/chrome/" target="_blank" rel="noopener noreferrer">${t('Get Chrome')}</a></p>
    <p><a class="act" data-sharing-return hidden>${t('Return to document and continue sharing')}</a></p>
    <h3>${t('Manage shares')}</h3><div data-sharing-management></div>
  </section>${confirmDialog()}`;
}
