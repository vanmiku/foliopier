// Shared, text-only delivery controls for articles and the standalone conversation.
(() => {
  const T = (key, vars = {}) => (window.__T?.[key] || key).replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? '');
  const pending = new Set([
    'queued',
    'waiting_receipt',
    'waiting_connection',
    'paused',
    'dispatching',
    'working',
    'needs_input',
    'processing_failed',
    'uncertain',
  ]);
  const finished = new Set(['completed', 'cancelled', 'stopped']);
  const attention = new Set([
    'needs_input',
    'processing_failed',
    'uncertain',
    'failed',
    'interrupted',
    'expired',
  ]);
  const views = new WeakMap(),
    stores = new Map();
  function notices(scope) {
    if (!stores.has(scope)) {
      let entries = [];
      try {
        entries = JSON.parse(sessionStorage.getItem('mydash.delivery-notices.' + scope) || '[]');
      } catch {}
      if (stores.size >= 100) stores.delete(stores.keys().next().value);
      stores.set(
        scope,
        new Map(
          Array.isArray(entries)
            ? entries
                .filter(
                  (x) => Array.isArray(x) && typeof x[0] === 'string' && x[1] && typeof x[1] === 'object'
                )
                .slice(-200)
            : []
        )
      );
    }
    return stores.get(scope);
  }
  function save(scope, store) {
    while (store.size > 200) store.delete(store.keys().next().value);
    try {
      sessionStorage.setItem('mydash.delivery-notices.' + scope, JSON.stringify([...store]));
    } catch {}
  }
  window.mydashRenderDeliveries = function render(container, rows = [], transport, scope = 'session') {
    const signature = JSON.stringify([scope, rows, transport, document.body.dataset.lan]);
    let view = views.get(container);
    if (!view) {
      view = { seen: new Map() };
      views.set(container, view);
    }
    if (view.scope !== scope) {
      view.scope = scope;
      view.seen = new Map();
    }
    view.latest = [container, rows, transport, scope];
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    clearTimeout(view.timer);
    const rerender = () => {
      delete container.dataset.signature;
      render(...view.latest);
    };
    const store = notices(scope),
      now = Date.now();
    const open = rows.filter((r) => pending.has(r.state));
    const candidates = open.length ? open : rows.slice(-1);
    let expiry = Infinity;
    const shown = candidates.filter((row) => {
      const info = store.get(row.nonce) || {};
      if (info.muted && (!attention.has(row.state) || info.muted === row.state)) return false;
      if (finished.has(row.state)) {
        if (info.finished !== row.state) {
          const recent = Number.isFinite(row.updatedAt) && row.updatedAt > now - 5000;
          info.until = recent
            ? Math.min(now + 5000, row.updatedAt + 5000)
            : pending.has(view.seen.get(row.nonce))
              ? now + 5000
              : 0;
          info.finished = row.state;
          store.set(row.nonce, info);
        }
        if (!(info.until > now)) return false;
        expiry = Math.min(expiry, info.until);
      }
      return true;
    });
    view.seen = new Map(rows.map((row) => [row.nonce, row.state]));
    save(scope, store);
    const hiddenPending = open.filter((row) => !shown.includes(row));
    const focused = container.contains(document.activeElement)
      ? {
          nonce: document.activeElement.dataset.nonce,
          dismiss: document.activeElement.hasAttribute('data-delivery-dismiss'),
          show: document.activeElement.hasAttribute('data-delivery-show'),
        }
      : null;
    const scroll = container.scrollTop;
    container.replaceChildren();
    container.hidden = !shown.length && !hiddenPending.length;
    container.dataset.state = shown.at(-1)?.state || (hiddenPending.length ? 'collapsed' : '');
    if (!shown.length && !hiddenPending.length) container.append(document.createElement('p'));
    for (const row of shown) {
      const item = document.createElement('div'),
        label = document.createElement('p'),
        text = document.createElement('small');
      item.className = 'delivery-item';
      item.dataset.nonce = row.nonce;
      item.dataset.state = row.state;
      label.textContent = row.label || '';
      text.textContent = finished.has(row.state)
        ? ''
        : (row.text || '').slice(-200) || (row.images || []).map((x) => x.name).join(', ');
      item.append(label, text);
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'linkish delivery-notice-close';
      dismiss.dataset.deliveryDismiss = '';
      dismiss.dataset.nonce = row.nonce;
      dismiss.textContent = '×';
      dismiss.setAttribute('aria-label', T('Dismiss status'));
      dismiss.title = T('Hide this notice. The message and Agent work are kept.');
      dismiss.addEventListener('click', () => {
        store.set(row.nonce, { ...store.get(row.nonce), muted: row.state });
        save(scope, store);
        rerender();
      });
      item.append(dismiss);
      if (
        document.body.dataset.lan !== '1' &&
        (row.transport || transport) === 'codex-app' &&
        ['queued', 'waiting_connection', 'paused', 'uncertain'].includes(row.state)
      ) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'linkish';
        button.dataset.articleCancelDelivery = '';
        button.dataset.sessionCancel = '';
        button.dataset.nonce = row.nonce;
        button.dataset.stopWaiting = String(row.state === 'uncertain');
        button.textContent =
          row.state === 'uncertain' ? T('I checked Codex App. Stop waiting.') : T('Cancel queued message');
        item.append(button);
      }
      container.append(item);
    }
    if (hiddenPending.length) {
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'linkish';
      show.dataset.deliveryShow = '';
      show.textContent = T('Show message status ({n})', { n: hiddenPending.length });
      show.setAttribute('aria-expanded', 'false');
      show.addEventListener('click', () => {
        for (const row of hiddenPending) {
          const info = store.get(row.nonce);
          if (info) delete info.muted;
        }
        save(scope, store);
        rerender();
      });
      container.append(show);
    }
    container.scrollTop = scroll;
    if (focused) {
      const next = [...container.querySelectorAll('button')].find(
        (b) =>
          b.dataset.nonce === focused.nonce &&
          b.hasAttribute('data-delivery-dismiss') === focused.dismiss &&
          b.hasAttribute('data-delivery-show') === focused.show
      );
      const fallback =
        next ||
        container.querySelector('button') ||
        container.parentElement.querySelector('.article-messages, #session-messages');
      if (fallback) {
        if (!fallback.hasAttribute('tabindex') && fallback.tagName !== 'BUTTON') fallback.tabIndex = -1;
        fallback.focus({ preventScroll: true });
      }
    }
    // A timer is necessary even if subsequent polls have an identical payload.
    if (Number.isFinite(expiry)) view.timer = setTimeout(rerender, Math.max(1, expiry - Date.now()));
  };
})();
