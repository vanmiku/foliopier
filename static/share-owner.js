// Owner-only sharing controls. Public readers never load this script.
(() => {
  if (document.body.dataset.lan === '1') return;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const T = (key, vars) => {
    let text = window.__T?.[key] || key;
    if (text.includes('|')) text = text.split('|')[vars?.n === 1 ? 0 : 1];
    return vars ? text.replace(/\{(\w+)\}/g, (all, key) => key in vars ? String(vars[key]) : all) : text;
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dialog = $('#share-owner-dialog'), settings = $('#internet-sharing');
  if (!dialog && !settings) return;
  let boot = null;
  try { boot = JSON.parse($('#share-owner-data')?.textContent || 'null'); } catch {}
  const form = $('#share-create-form'), result = $('[data-share-result]');
  const manager = $('[data-sharing-management]');
  const codes = new Map();
  let network, shareList = [], feedback = [], editingId = '', posting = false, refreshing = false;
  let activeTab = 'create', opener = null;
  const storage = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} } };
  const draftKey = boot ? `mydash.share.draft:${boot.project}/${boot.slug}` : '';
  const dateText = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString(document.documentElement.lang || undefined, { timeZoneName: 'short' }) : ''; };
  const localDate = value => { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
  const safeReturn = value => { try { const u = new URL(value, location.origin); return u.origin === location.origin && u.pathname.startsWith('/p/') ? u.pathname + u.search : ''; } catch { return ''; } };
  const publicUrl = id => network?.publicUrl ? `${network.publicUrl}/s/${id}` : '';
  function message(text, error = false) {
    const target = $('[data-share-owner-status]') || $('[data-sharing-status]');
    if (target) { target.textContent = text; target.classList.toggle('error', error); }
  }
  function errorText(code) {
    const messages = {
      SHARING_DISABLED: T('Enable internet sharing in Settings first.'),
      DOCUMENT_UPDATED: T('The document has changed. Open the latest version before creating this share.'),
      NEW_RESOURCES: T('New files or images need explicit approval. Review the latest document first.'),
      SHARE_STORAGE_FULL: T('Sharing storage is full. Existing shares can still be stopped or restricted.'),
      SHARE_PORT_BUSY: T('The dedicated sharing ports are in use. Existing services were kept.'),
      AUTHORIZATION_REQUIRED: T('Tailscale needs authorization. Open the authorization page, then check again.'),
      TAILSCALE_MISSING: T('Install Tailscale on the computer running mydash first.'),
      TAILSCALE_LOGIN: T('Sign in to Tailscale on the computer running mydash first.'),
      TAILSCALE_UNSUPPORTED: T('This Tailscale client does not support Funnel. On macOS, use a supported open-source client and follow the official instructions.'),
      TAILSCALE_PERMISSION: T('Tailscale denied permission. Complete authorization on the computer running mydash, then check again.'),
      FUNNEL_CLEANUP_FAILED: T('Document access is disabled, but the public entry could not be removed. Retry turning off sharing before uninstalling.'),
      MAGICDNS_REQUIRED: T('Ask your Tailscale administrator to enable MagicDNS and HTTPS.'),
      CLOCK_UNVERIFIED: T('Check the clock on the sharing computer before continuing.'),
      SHARE_UNAVAILABLE: T('This share is no longer available.'),
      INVALID_SHARE_EXPIRATION: T('Choose a future expiry within 30 days.'),
    };
    return messages[code] || '';
  }
  function failure(error) {
    message(errorText(error.code) || error.message || T('Sharing could not be updated. Try again.'), true);
    if (error.code === 'DOCUMENT_UPDATED' && boot) {
      const target = $('[data-share-owner-status]'), link = document.createElement('a');
      link.href = sourceLink(boot); link.textContent = T('Open latest version');
      target.append(document.createTextNode(' '), link);
    }
  }
  async function request(url, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const r = await fetch(url, { signal: controller.signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const data = await r.json();
      if (!r.ok) throw Object.assign(new Error(data.error || T('Sharing could not be updated. Try again.')), { code: data.code, state: data.status });
      return data;
    } finally { clearTimeout(timer); }
  }
  function openDialog(element) {
    if (!element || element.open) return;
    element.showModal();
  }
  function confirmChange(text, action, { manageShares = false } = {}) {
    const confirmation = $('[data-sharing-confirm]');
    if (!confirmation) return Promise.resolve(false);
    $('[data-share-confirm-message]', confirmation).textContent = text;
    const accept = $('[data-share-confirm-accept]', confirmation), cancel = $('[data-share-confirm-cancel]', confirmation);
    const manage = $('[data-share-confirm-manage]', confirmation);
    manage.hidden = !manageShares;
    accept.textContent = action;
    return new Promise(resolve => {
      const end = answer => { confirmation.close(); accept.onclick = cancel.onclick = manage.onclick = null; confirmation.removeEventListener('cancel', onCancel); resolve(answer); };
      const onCancel = e => { e.preventDefault(); end(false); };
      accept.onclick = () => end(true); cancel.onclick = () => end(false);
      manage.onclick = () => { end(false); openShare(); tab('manage'); };
      confirmation.addEventListener('cancel', onCancel); openDialog(confirmation); cancel.focus();
    });
  }
  async function copy(text, host = result || settings) {
    if (!text) return;
    try { if (!navigator.clipboard?.writeText || !window.isSecureContext) throw new Error(); await navigator.clipboard.writeText(text); message(T('Copied.')); }
    catch {
      let box = $('.share-owner-copybox', host);
      if (!box) { box = document.createElement('textarea'); box.className = 'share-owner-copybox'; box.readOnly = true; box.setAttribute('aria-label', T('Share information to copy')); host.append(box); }
      box.value = text; box.focus(); box.select(); message(T('The text is selected. Use Copy to copy it.'));
    }
  }
  function sharingText(share, code) {
    return `${share.title}\n${publicUrl(share.id)}${code ? `\n${T('Access code')}: ${code}` : ''}\n${T('Expires')}: ${dateText(share.expiresAt)}`;
  }
  function setupLink() {
    const next = safeReturn(location.pathname + location.search);
    if (next) storage.set('mydash.share.return', next);
    return `/settings${next ? '?shareNext=' + encodeURIComponent(next) : ''}#internet-sharing`;
  }
  function phaseText(s) {
    if (s.errorCode) return errorText(s.errorCode) || T('Sharing needs attention. Check the setup steps below.');
    if (s.phase === 'configured') return T('Configured. Internet access has not yet been independently verified.');
    if (s.phase === 'not-installed') return T('Tailscale is not installed on the sharing computer.');
    if (s.phase === 'login') return T('Sign in to Tailscale on the sharing computer.');
    if (s.phase === 'authorization') return T('Tailscale needs administrator authorization.');
    if (s.phase === 'error') return T('Sharing needs attention. Check the setup steps below.');
    return T('Internet sharing is off.');
  }
  function renderNetwork(s) {
    network = s;
    const summary = $('[data-share-network]');
    if (summary) summary.innerHTML = `<p>${esc(phaseText(s))}</p>${s.phase !== 'configured' ? `<a class="act" data-share-setup-link href="${esc(setupLink())}">${esc(T('Set up internet sharing'))}</a>` : `<small>${esc(T('Keep the sharing computer online. New public DNS records may take time to become reachable.'))}</small>`}${s.pdfReady ? '' : `<p data-sharing-article-pdf>${esc(T('PDF downloads are not ready on the sharing computer. Install Chrome or Edge there before offering PDF downloads.'))} <a data-share-setup-link href="${esc(setupLink())}">${esc(T('Set up PDF downloads'))}</a></p>`}`;
    if ($('[data-share-submit]')) $('[data-share-submit]').disabled = s.phase !== 'configured' || posting;
    if (!settings) return;
    $('[data-sharing-status]').textContent = phaseText(s);
    const values = { installed: s.checks?.installed, loggedIn: s.checks?.loggedIn, funnel: s.checks?.funnel && s.checks?.localReady, pdf: s.pdfReady };
    for (const [key, yes] of Object.entries(values)) $(`[data-sharing-step="${key}"]`).textContent = yes ? T('Ready') : T('Not ready');
    $('[data-sharing-disable]').hidden = !s.enabled && !s.cleanupPending;
    $('[data-sharing-disable]').textContent = s.cleanupPending ? T('Finish disabling sharing') : T('Turn off all sharing');
    $('[data-sharing-enable]').hidden = s.phase === 'configured';
    $('[data-sharing-public-url]').textContent = s.publicUrl ? `${T('Sharing address')}: ${s.publicUrl}` : '';
    $('[data-sharing-external]').textContent = s.externalVerified ? T('Internet access was verified from outside this Tailnet.') : T('To verify access, open a share on mobile data with Tailscale disconnected. Local checks do not prove internet access.');
    $('[data-sharing-pdf-help]').hidden = s.pdfReady;
    const auth = $('[data-sharing-auth]'); auth.hidden = true;
    try { const u = new URL(s.authUrl); if (u.protocol === 'https:' && ['login.tailscale.com', 'console.tailscale.com'].includes(u.hostname)) { auth.href = u.href; auth.hidden = false; } } catch {}
    $('[data-sharing-client-help]').hidden = s.errorCode !== 'TAILSCALE_UNSUPPORTED';
  }
  async function refreshNetwork() { const data = await request('/api/sharing/status'); renderNetwork(data); return data; }
  function persistDraft() {
    if (!form || !draftKey) return;
    const values = {};
    for (const input of form.elements) if (input.name && input.name !== 'files') values[input.name] = input.type === 'checkbox' ? input.checked : input.value;
    values.files = $$('[name="files"]:checked', form).map(i => i.value);
    storage.set(draftKey, JSON.stringify(values));
  }
  function restoreDraft() {
    if (!form) return;
    try {
      const values = JSON.parse(storage.get(draftKey) || 'null');
      if (values) for (const input of form.elements) {
        if (!input.name) continue;
        if (input.name === 'files') input.checked = input.disabled || values.files?.includes(input.value);
        else if (input.name in values) { if (input.type === 'checkbox') input.checked = values[input.name]; else input.value = values[input.name]; }
      }
    } catch {}
    customExpiry();
    selectionCount();
  }
  function selectionCount() {
    if (!form) return;
    $('[data-share-selected-count]', form).textContent = T('{n} file selected|{n} files selected', { n: $$('[name="files"]:checked', form).length });
  }
  function customExpiry() {
    if (!form) return;
    const custom = form.elements.duration.value === 'custom';
    $('[data-share-custom-expiry]').hidden = !custom; form.elements.expiresAt.required = custom;
  }
  function formPayload() {
    if (!form?.reportValidity()) throw new Error(T('Complete the sharing options first.'));
    const data = { project: boot.project, slug: boot.slug, version: boot.version, main: boot.main,
      files: $$('[name="files"]:checked', form).map(i => i.value), title: form.elements.title.value.trim(), publisher: form.elements.publisher.value.trim(),
      mode: form.elements.mode.value, allowPdf: form.elements.allowPdf.checked, allowComments: form.elements.allowComments.checked };
    if (form.elements.duration.value === 'custom') {
      const until = new Date(form.elements.expiresAt.value).getTime();
      if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + 30 * 86400_000) throw new Error(T('Choose a future expiry within 30 days.'));
      data.expiresAt = new Date(until).toISOString();
    } else data.expiresInHours = Number(form.elements.duration.value);
    return data;
  }
  function renderResult(data) {
    const share = data.share; codes.set(share.id, data.code);
    result.hidden = false;
    result.innerHTML = `<h3>${esc(T('Share created'))}</h3><a href="${esc(data.url)}" target="_blank" rel="noopener noreferrer">${esc(data.url)}</a><p>${esc(T('Access code'))}<code>${esc(data.code)}</code></p><p>${esc(T('Expires'))}: ${esc(dateText(share.expiresAt))}</p><p class="share-owner-hint">${esc(T('The access code is shown only when created or reset. Keep it before leaving this page.'))}</p><div class="share-owner-actions"><button type="button" class="act" data-result-copy="all">${esc(T('Copy share information'))}</button><button type="button" class="act" data-result-copy="url">${esc(T('Copy link'))}</button><button type="button" class="act" data-result-copy="code">${esc(T('Copy code'))}</button></div>`;
    $$('[data-result-copy]', result).forEach(b => b.onclick = () => copy(b.dataset.resultCopy === 'all' ? sharingText(share, data.code) : b.dataset.resultCopy === 'code' ? data.code : data.url));
    result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function sourceLink(s) { return `/p/${encodeURIComponent(s.project)}/${encodeURIComponent(s.slug)}${s.main ? '?f=' + encodeURIComponent(s.main) : ''}`; }
  function statusLabel(status) { return ({ active: T('Active share'), expired: T('Expired share'), revoked: T('Stopped share'), disabled: T('Sharing is off'), 'clock-unverified': T('Clock needs checking') })[status] || status; }
  function renderManagement() {
    if (!manager || editingId) return;
    if (!shareList.length) { manager.innerHTML = `<p class="share-owner-hint">${esc(T('No shares yet.'))}</p>`; return; }
    manager.innerHTML = shareList.map(s => {
      const comments = feedback.filter(c => c.shareId === s.id);
      return `<article class="share-owner-card" data-share-id="${s.id}"><div class="share-owner-head"><h3>${esc(s.title)}</h3><span class="share-owner-badge">${esc(statusLabel(s.status))}</span></div><p class="share-owner-hint">${esc(s.mode === 'fixed' ? T('Fixed version') : T('Following published updates'))} · v${s.version} · ${esc(T('Expires'))} ${esc(dateText(s.expiresAt))}</p>${s.pendingVersion ? `<p class="share-owner-status">${esc(T('Version {v} needs approval. Visitors still see the previous shared version.', { v: s.pendingVersion }))}</p><a href="${esc(sourceLink(s))}" target="_blank" rel="noopener">${esc(T('Review the latest document'))}</a>` : ''}<div class="share-owner-actions">${publicUrl(s.id) ? `<a class="act" href="${esc(publicUrl(s.id))}" target="_blank" rel="noopener noreferrer">${esc(T('Open share link'))}</a>` : ''}<button type="button" class="act" data-share-action="copy-link">${esc(T('Copy link'))}</button><button type="button" class="act" data-share-action="edit"${s.revoked ? ' disabled' : ''}>${esc(T('Edit share'))}</button>${!s.revoked ? `<button type="button" class="act" data-share-action="extend">${esc(T('Extend 24 hours'))}</button>` : ''}<button type="button" class="act" data-share-action="reset-code"${s.status !== 'active' ? ' disabled' : ''}>${esc(T('Reset access code'))}</button>${s.pendingVersion ? `<button type="button" class="act" data-share-action="approve-version"${s.revoked ? ' disabled' : ''}>${esc(T('Approve new version'))}</button>` : ''}<button type="button" class="act share-owner-danger" data-share-action="revoke"${s.revoked ? ' disabled' : ''}>${esc(T('Stop share'))}</button></div>${codes.has(s.id) ? `<p>${esc(T('Access code'))}: <code>${esc(codes.get(s.id))}</code> <button type="button" class="act" data-share-action="copy-code">${esc(T('Copy code'))}</button> <button type="button" class="act" data-share-action="copy-information">${esc(T('Copy share information'))}</button></p>` : ''}<div data-share-edit-host></div><details${comments.some(c => c.status === 'open') ? ' open' : ''}><summary>${esc(T('External comments'))} (${comments.length})</summary>${comments.map(c => `<article class="share-owner-comment"><strong>${esc(c.nickname || T('Anonymous visitor'))}</strong><small>${esc(c.file)} · v${c.version} · ${esc(dateText(c.createdAt))}</small><p>${esc(c.text)}</p>${c.status === 'open' ? `<button type="button" class="act" data-share-resolve="${esc(c.id)}">${esc(T('Mark handled'))}</button>` : `<small>${esc(T('Handled'))}</small>`}</article>`).join('')}</details></article>`;
    }).join('');
  }
  function showEdit(s, card) {
    editingId = s.id;
    // The article may be older than the share. Its bootstrap is an additional
    // source of choices, never an authoritative replacement for selected files.
    const offered = [...(s.fileMetadata || []), ...(boot?.project === s.project && boot?.slug === s.slug ? boot.files : []),
      ...s.files.map(path => ({ path })), { path: s.main }];
    const byPath = new Map();
    for (const file of offered) if (!byPath.has(file.path)) byPath.set(file.path, file);
    const candidates = [...byPath.values()];
    const host = $('[data-share-edit-host]', card);
    host.innerHTML = `<form class="share-owner-edit"><label class="share-owner-field">${esc(T('Public title'))}<input name="title" maxlength="300" value="${esc(s.title)}" required></label><label class="share-owner-field">${esc(T('Expires at (your local time)'))}<input type="datetime-local" name="expiresAt" value="${esc(localDate(s.expiresAt))}" required></label><label class="share-owner-field">${esc(T('Document updates'))}<select name="mode"><option value="latest"${s.mode === 'latest' ? ' selected' : ''}>${esc(T('Follow published updates'))}</option><option value="fixed"${s.mode === 'fixed' ? ' selected' : ''}>${esc(T('Fixed version'))}</option></select></label><fieldset class="share-owner-files"><legend>${esc(T('Files to share'))}</legend>${candidates.map(f => `<label><input type="checkbox" name="files" value="${esc(f.path)}"${s.files.includes(f.path) ? ' checked' : ''}${f.path === s.main ? ' disabled' : ''}><span>${esc(f.path)}</span></label>`).join('')}</fieldset><p class="share-owner-hint">${esc(T('To add new files, open the document and review its latest content.'))} <a href="${esc(sourceLink(s))}">${esc(T('Open document'))}</a></p><div class="share-owner-checks"><label><input type="checkbox" name="allowPdf"${s.allowPdf ? ' checked' : ''}>${esc(T('Allow PDF downloads'))}</label><label><input type="checkbox" name="allowComments"${s.allowComments ? ' checked' : ''}>${esc(T('Allow private comments'))}</label><label><input type="checkbox" name="approveVersion">${esc(T('Approve latest resources after reviewing them'))}</label></div><div class="share-owner-actions"><button type="submit" class="btn">${esc(T('Save'))}</button><button type="button" class="act" data-share-edit-cancel>${esc(T('Cancel'))}</button></div></form>`;
    $('[data-share-edit-cancel]', host).onclick = () => { editingId = ''; renderManagement(); };
    $('form', host).onsubmit = async e => {
      e.preventDefault(); const f = e.currentTarget;
      const expiry = new Date(f.elements.expiresAt.value).getTime();
      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 30 * 86400_000) { message(T('Choose a future expiry within 30 days.'), true); return; }
      try {
        $('button[type="submit"]', f).disabled = true;
        await request('/api/shares/' + s.id, { action: 'update', title: f.elements.title.value.trim(), mode: f.elements.mode.value,
          expiresAt: new Date(expiry).toISOString(), files: $$('[name="files"]:checked', f).map(i => i.value), allowPdf: f.elements.allowPdf.checked, allowComments: f.elements.allowComments.checked, approveVersion: f.elements.approveVersion.checked });
        editingId = ''; message(T('Sharing options saved.')); await refreshList(true);
      } catch (error) { failure(error); if (f.isConnected) $('button[type="submit"]', f).disabled = false; }
    };
  }
  async function refreshList(forceDetails = false) {
    const details = forceDetails || Boolean(settings) || dialog?.open && activeTab === 'manage';
    const params = new URLSearchParams({ details: details ? '1' : '0', ...(boot ? { project: boot.project, slug: boot.slug } : {}) });
    const data = await request('/api/shares?' + params);
    shareList = data.shares || []; if (details) feedback = data.comments || [];
    if (!network && data.publicUrl) network = { publicUrl: data.publicUrl };
    const pending = shareList.reduce((n, s) => n + (s.commentCount || 0), 0);
    const badge = $('[data-share-unread]'); if (badge) { badge.textContent = String(pending); badge.hidden = !pending; badge.setAttribute('aria-hidden', 'true'); }
    const openerButton = $('[data-share-open]'); if (openerButton) openerButton.title = pending ? T('{n} pending external comments', { n: pending }) : T('Share');
    if ($('[data-share-count]')) $('[data-share-count]').textContent = shareList.length ? `(${shareList.length})` : '';
    if (details) renderManagement();
  }
  manager?.addEventListener('click', async e => {
    const action = e.target.closest('[data-share-action]'), resolve = e.target.closest('[data-share-resolve]');
    const button = action || resolve; if (!button) return;
    const card = button.closest('[data-share-id]'), s = shareList.find(x => x.id === card.dataset.shareId); if (!s) return;
    const kind = action?.dataset.shareAction;
    if (kind === 'edit') { showEdit(s, card); return; }
    if (kind === 'copy-link' || kind === 'copy-information' || kind === 'copy-code') { await copy(kind === 'copy-link' ? publicUrl(s.id) : kind === 'copy-code' ? codes.get(s.id) : sharingText(s, codes.get(s.id)), card); return; }
    if (kind === 'revoke' && !await confirmChange(T('Stop this share now? All visitor sessions and downloads will stop. Saved files cannot be recalled.'), T('Stop share'))) return;
    if (kind === 'reset-code' && !await confirmChange(T('Reset the code? Everyone who unlocked this share must enter the new code.'), T('Reset access code'))) return;
    if (kind === 'approve-version' && !await confirmChange(T('Approve the latest selected documents and their new resources? Review the document before continuing.'), T('Approve new version'))) return;
    button.disabled = true;
    try {
      const data = await request('/api/shares/' + s.id + (resolve ? '/comments/' + resolve.dataset.shareResolve : ''), kind === 'extend' ? { action: 'update', expiresAt: new Date(Math.min(Date.now() + 30 * 86400_000, Math.max(Date.now(), Date.parse(s.expiresAt)) + 86400_000)).toISOString() } : { action: resolve ? 'resolve' : kind });
      if (data.code) { codes.set(s.id, data.code); message(T('Access code reset. Copy the new code from this share.')); }
      else message(T('Sharing options saved.'));
      await refreshList(true);
    } catch (error) { failure(error); button.disabled = false; }
  });
  async function setup(action, button) {
    if (action === 'disable' && !await confirmChange(T('Turn off internet sharing? Every existing share and visitor session will be stopped. Turning sharing on again will not restore these links.'), T('Turn off all sharing'))) return;
    const controls = $$('[data-sharing-enable], [data-sharing-check], [data-sharing-disable]'); controls.forEach(b => b.disabled = true);
    message(T('Updating sharing setup…'));
    try { renderNetwork(await request('/api/sharing/setup', { action })); await refreshList(true); }
    catch (error) { if (error.state) renderNetwork(error.state); failure(error); }
    finally { controls.forEach(b => b.disabled = false); }
  }
  $('[data-sharing-enable]')?.addEventListener('click', e => setup('enable', e.currentTarget));
  $('[data-sharing-check]')?.addEventListener('click', e => setup('check', e.currentTarget));
  $('[data-sharing-disable]')?.addEventListener('click', e => setup('disable', e.currentTarget));
  function tab(name) {
    activeTab = name; $('[data-share-create]').hidden = name !== 'create'; $('[data-share-manage]').hidden = name !== 'manage';
    $$('[data-share-tab]').forEach(b => { const on = b.dataset.shareTab === name; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    if (name === 'manage') refreshList(true).catch(failure);
  }
  $$('[data-share-tab]').forEach(b => b.addEventListener('click', () => tab(b.dataset.shareTab)));
  async function openShare(button) {
    opener = button || $('[data-share-open]'); openDialog(dialog);
    try { await Promise.all([refreshNetwork(), refreshList(activeTab === 'manage')]); } catch (error) { failure(error); }
  }
  $('[data-share-open]')?.addEventListener('click', e => openShare(e.currentTarget));
  // The archive handler awaits this hook before changing the item's list state.
  // Archiving deliberately does not revoke otherwise valid public shares.
  window.mydashBeforeArchive = async () => {
    if (!boot) return true;
    await refreshList();
    const count = shareList.filter(share => share.status === 'active').length;
    if (!count) return true;
    return confirmChange(T('Archiving does not stop the {n} active shares for this document. Visitors can still read them. Manage and stop shares first, or archive anyway.', { n: count }), T('Archive anyway'), { manageShares: true });
  };
  $('[data-share-close]')?.addEventListener('click', () => dialog.close());
  dialog?.addEventListener('close', () => { persistDraft(); opener?.focus(); });
  dialog?.addEventListener('click', e => { if (e.target.closest('[data-share-setup-link]')) persistDraft(); });
  if (form) {
    restoreDraft(); form.addEventListener('input', persistDraft); form.addEventListener('change', () => { customExpiry(); selectionCount(); persistDraft(); });
    const selectFiles = all => { $$('[name="files"]', form).forEach(input => { input.checked = input.disabled || all; }); selectionCount(); persistDraft(); };
    $('[data-share-select-all]').onclick = () => selectFiles(true);
    $('[data-share-select-main]').onclick = () => selectFiles(false);
    form.onsubmit = async e => {
      e.preventDefault(); if (posting) return;
      try {
        const data = formPayload(); posting = true; $('[data-share-submit]').disabled = true; message(T('Creating share…'));
        const created = await request('/api/shares', data); renderResult(created); message(T('Share created. Internet access still needs an external check.')); await refreshList();
      } catch (error) { failure(error); }
      finally { posting = false; if ($('[data-share-submit]')) $('[data-share-submit]').disabled = network?.phase !== 'configured'; }
    };
    $('[data-share-preview]').onclick = async e => {
      e.currentTarget.disabled = true;
      try {
        const data = await request('/api/shares/preview', formPayload());
        if (!/^\/share-preview\/[a-f0-9]{32}$/.test(data.url)) throw new Error(T('Preview could not be opened.'));
        $('[data-share-preview-panel]').hidden = false; $('[data-share-preview-frame]').src = data.url;
        $('[data-share-preview-panel]').scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (error) { failure(error); }
      finally { $('[data-share-preview]').disabled = false; }
    };
    $('[data-share-preview-close]').onclick = () => { $('[data-share-preview-panel]').hidden = true; $('[data-share-preview-frame]').removeAttribute('src'); };
  }
  if (settings) {
    const next = safeReturn(new URLSearchParams(location.search).get('shareNext') || storage.get('mydash.share.return'));
    if (next) { const link = $('[data-sharing-return]'), url = new URL(next, location.origin); url.searchParams.set('sharing', '1'); link.href = url.pathname + url.search; link.hidden = false; }
    refreshNetwork().catch(failure); refreshList(true).catch(failure);
  } else {
    refreshList().catch(() => {});
    const url = new URL(location.href);
    if (url.searchParams.get('sharing') === '1') { url.searchParams.delete('sharing'); history.replaceState(null, '', url.pathname + url.search + url.hash); openShare(); }
  }
  async function poll() {
    if (!document.hidden && !refreshing) {
      refreshing = true;
      try { await refreshList(); if (settings || dialog?.open) await refreshNetwork(); } catch {} finally { refreshing = false; }
    }
    setTimeout(poll, 30_000);
  }
  setTimeout(poll, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !refreshing) refreshList().catch(() => {}); });
})();
