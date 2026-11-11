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
      <div class="share-owner-network" data-share-network></div>
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

export function sharingSettingsSection() {
  return `<section class="set-sec share-owner-settings" id="internet-sharing" tabindex="-1" aria-labelledby="internet-sharing-title">
    <h2 id="internet-sharing-title">${t('Internet document sharing')}</h2>
    <p class="set-hint">${t('People can read your selected documents using a link and access code, without installing Tailscale.')}</p>
    <p class="share-owner-status" data-sharing-status role="status" aria-live="polite">${t('Checking sharing setup…')}</p>
    <ol class="share-owner-steps"><li><strong>${t('Check Tailscale')}</strong><span data-sharing-step="installed"></span></li><li><strong>${t('Sign in and authorize')}</strong><span data-sharing-step="loggedIn"></span></li><li><strong>${t('Open the document-only entry')}</strong><span data-sharing-step="funnel"></span></li><li><strong>${t('Check PDF downloads')}</strong><span data-sharing-step="pdf"></span></li></ol>
    <p class="set-hint">${t('Keep this computer online with mydash and Tailscale running. Your device domain appears in public certificate records.')}</p>
    <div class="share-owner-actions"><button type="button" class="btn" data-sharing-enable>${t('Enable internet sharing')}</button><button type="button" class="act" data-sharing-check>${t('Check again')}</button><a class="act" data-sharing-auth hidden target="_blank" rel="noopener noreferrer">${t('Open Tailscale authorization')}</a><button type="button" class="act share-owner-danger" data-sharing-disable hidden>${t('Turn off all sharing')}</button></div>
    <p class="set-hint" data-sharing-public-url></p><p class="set-hint" data-sharing-external></p>
    <p class="set-hint" data-sharing-pdf-help hidden>${t('Install Chrome or Edge on the computer running mydash to enable one-click PDF downloads.')} <a href="https://www.google.com/chrome/" target="_blank" rel="noopener noreferrer">${t('Get Chrome')}</a></p>
    <p class="set-hint" data-sharing-client-help hidden><a href="https://tailscale.com/docs/concepts/macos-variants" target="_blank" rel="noopener noreferrer">${t('Supported Tailscale clients for macOS')}</a></p>
    <p><a class="act" data-sharing-return hidden>${t('Return to document and continue sharing')}</a></p>
    <details><summary>${t('Sharing setup help')}</summary><p class="set-hint">${t('An administrator may need to enable MagicDNS, HTTPS and Funnel for this device. Unsupported clients or occupied sharing ports are shown here; mydash keeps your existing workbench address.')}</p><a href="https://tailscale.com/docs/features/tailscale-funnel" target="_blank" rel="noopener noreferrer">${t('Tailscale Funnel instructions')}</a></details>
    <h3>${t('Manage shares')}</h3><div data-sharing-management></div>
  </section>${confirmDialog()}`;
}
