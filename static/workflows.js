(() => {
  const build = document.currentScript?.dataset.build || '';
  const find = (selector, root = document) => root.querySelector(selector);
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const data = id => JSON.parse(document.getElementById(id)?.textContent || 'null');
  const node = (tag, text = '') => Object.assign(document.createElement(tag), { textContent: text });
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  async function write(name, body) {
    const response = await fetch('/api/workflow/' + name, {
      method: 'POST', headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  async function run(control, line, fn) {
    if (control) control.disabled = true;
    if (line) line.textContent = '';
    try { await fn(); } catch (error) { if (line) line.textContent = error.message; }
    finally { if (control) control.disabled = false; }
  }

  function packages() {
    const info = data('package-data'), strings = data('package-strings');
    if (!info) return;
    const form = find('[data-work-form="package"]');
    const line = find('[data-work-status]'), result = find('[data-package-result]');
    function show(resultData) {
      result.replaceChildren();
      const paragraph = node('p', strings.link + ' ');
      const url = node('a', resultData.url);
      url.href = resultData.url;
      paragraph.append(url);
      result.append(paragraph);
      if (resultData.code) {
        const access = node('p', strings.code + ' ');
        access.append(node('code', resultData.code));
        result.append(access);
      }
      const manage = node('a', strings.manage);
      manage.href = '?id=' + resultData.share.id;
      result.append(manage);
      result.tabIndex = -1;
      result.focus();
    }
    for (const action of ['reset', 'revoke']) {
      const control = find(`[data-action="${action}-package"]`);
      control?.addEventListener('click', () => {
        if (!confirm(action === 'reset' ? strings.rotate : strings.revoke)) return;
        run(control, line || result, async () => {
          const response = await write('packages', { project: info.project, id: info.id, action });
          if (action === 'reset') show(response);
          else {
            result.textContent = strings.revoked;
            form.hidden = true;
            all('[data-action$="-package"]').forEach(e => { e.hidden = true; });
          }
        });
      });
    }
    if (!form) return;
    const entries = find('[data-package-entries]', form), picker = find('[data-package-picker]', form);
    const preview = find('[data-package-preview]', form), publish = find('[data-action="publish-package"]', form);
    let draft, previewGeneration = 0;
    function invalidate() {
      previewGeneration++;
      draft = null;
      preview.hidden = true;
      publish.hidden = true;
    }
    function add(slug, existing) {
      const doc = info.options.find(o => o.slug === slug);
      if (!doc || all('[data-package-entry]', entries).some(el => el.dataset.slug === slug) || entries.children.length >= 10) return;
      const entry = document.getElementById('package-entry-template').content.firstElementChild.cloneNode(true);
      entry.dataset.slug = slug;
      find('legend', entry).textContent = doc.title;
      const versions = find('[name=version]', entry), main = find('[name=main]', entry), files = find('[data-package-files]', entry);
      for (const v of doc.versions) versions.add(new Option('v' + v.v, v.v));
      if (existing) versions.value = existing.version;
      function fill(initial) {
        const version = doc.versions.find(v => String(v.v) === versions.value);
        main.replaceChildren(...version.files.map(f => new Option(f.path, f.path)));
        main.value = initial?.main || version.main || version.files[0]?.path;
        files.replaceChildren(...version.files.map((file) => {
          const label = node('label', file.path);
          label.className = 'workflow-check';
          const input = node('input');
          input.type = 'checkbox';
          input.value = file.path;
          input.checked = initial?.files.some(f => f.path === file.path) || file.path === main.value;
          label.prepend(input);
          return label;
        }));
        selectMain();
      }
      function selectMain() {
        for (const box of all('input', files)) {
          box.disabled = box.value === main.value;
          if (box.disabled) box.checked = true;
        }
      }
      fill(existing);
      versions.addEventListener('change', () => fill());
      main.addEventListener('change', selectMain);
      find('[data-action="up"]', entry).onclick = () => { entry.previousElementSibling?.before(entry); invalidate(); };
      find('[data-action="down"]', entry).onclick = () => { entry.nextElementSibling?.after(entry); invalidate(); };
      find('[data-action="remove"]', entry).onclick = () => { entry.remove(); invalidate(); };
      entries.append(entry);
    }
    for (const existing of info.entries) add(existing.slug, existing);
    find('[data-action="add-entry"]', form).onclick = () => { add(picker.value); invalidate(); };
    form.addEventListener('input', invalidate);
    invalidate();
    form.addEventListener('submit', event => {
      event.preventDefault();
      invalidate();
      const generation = previewGeneration;
      run(event.submitter, line, async () => {
        const inputs = new FormData(form);
        const picks = all('[data-package-entry]', form).map(entry => ({
          slug: entry.dataset.slug, version: Number(find('[name=version]', entry).value), main: find('[name=main]', entry).value,
          files: all('[data-package-files] input:checked', entry).map(input => input.value),
        }));
        if (!picks.length) throw new Error(strings.select);
        const settings = { title: inputs.get('title'), description: inputs.get('description'), allowPdf: inputs.has('allowPdf'),
          ...(inputs.get('expiresInHours') ? { expiresInHours: Number(inputs.get('expiresInHours')) } : {}) };
        let response;
        try {
          response = await write('packages', { ...settings, project: info.project, id: info.id, revision: info.revision, entries: picks, action: 'preview' });
        } catch (error) {
          if (generation === previewGeneration) throw error;
          return;
        }
        if (generation !== previewGeneration) return;
        draft = response.draft;
        preview.href = response.url;
        preview.textContent = strings.preview;
        preview.hidden = false;
        publish.hidden = false;
        preview.focus();
      });
    });
    publish.addEventListener('click', () => run(publish, line, async () => {
      if (!draft) return;
      const response = await write('packages', { action: 'publish', draft });
      show(response);
      form.hidden = true;
    }));
  }
  function actions() {
    for (const form of all('form[data-work-form]:not([data-work-form="package"])')) {
      const draft = fresh();
      form.addEventListener('submit', event => {
        event.preventDefault();
        const line = find('[data-work-status]', form);
        run(event.submitter, line, async () => {
          const params = new FormData(form);
          if (event.submitter?.name) params.set(event.submitter.name, event.submitter.value);
          const body = Object.fromEntries(params);
          const info = data('review-data');
          const response = await write(form.dataset.workForm, { ...body, project: info.project, requestId: draft });
          if (response.url) {
            const next = new URL(response.url, location.href);
            const samePage = next.pathname === location.pathname && next.search === location.search;
            location.assign(next.href);
            if (samePage) location.reload();
          }
        });
      });
    }
  }

  async function mediaReview() {
    const scope = find('[data-review-media]');
    if (!scope) return;
    const zoom = find('[data-review-zoom]', scope);
    if (zoom) zoom.oninput = () => scope.style.setProperty('--review-zoom', zoom.value + '%');
    const pageInput = find('[data-review-page]', scope);
    if (!pageInput) return;
    const strings = data('media-review-strings'), status = find('[data-work-status]', scope);
    const canvases = all('canvas[data-pdf-source]', scope);
    status.textContent = strings.loading;
    try {
      const { openPdf } = await import('/static/pdf-view.mjs?b=' + encodeURIComponent(build));
      const docs = await Promise.all(canvases.map(canvas => openPdf(canvas.dataset.pdfSource)));
      pageInput.max = Math.max(...docs.map(doc => doc.numPages));
      pageInput.disabled = false;
      let generation = 0;
      async function draw() {
        if (!pageInput.checkValidity()) return;
        const serial = ++generation, n = Number(pageInput.value);
        status.textContent = strings.loading;
        try {
          await Promise.all(docs.map(async (doc, i) => {
            const canvas = canvases[i], note = find('[data-pdf-note]', canvas.parentElement);
            if (n > doc.numPages) {
              canvas.hidden = true; note.textContent = strings.absent; return;
            }
            const page = await doc.getPage(n), base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: Math.min(1.8, 1800 / Math.max(base.width, base.height)) });
            const buffer = node('canvas');
            buffer.width = Math.ceil(viewport.width); buffer.height = Math.ceil(viewport.height);
            await page.render({ canvasContext: buffer.getContext('2d'), viewport }).promise;
            if (serial !== generation) return;
            canvas.width = buffer.width; canvas.height = buffer.height;
            canvas.getContext('2d').drawImage(buffer, 0, 0);
            canvas.hidden = false; note.textContent = '';
          }));
          if (serial === generation) status.textContent = '';
        } catch { if (serial === generation) status.textContent = strings.failed; }
      }
      pageInput.onchange = draw;
      await draw();
    } catch { status.textContent = strings.failed; }
  }

  packages();
  actions();
  mediaReview();
})();
