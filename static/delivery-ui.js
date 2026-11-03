// Shared, text-only delivery controls for articles and the standalone conversation.
(() => {
  const T = (key) => window.__T?.[key] || key;
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
  window.mydashRenderDeliveries = (container, rows = [], transport) => {
    const signature = JSON.stringify([rows, transport, document.body.dataset.lan]);
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    const open = rows.filter((r) => pending.has(r.state));
    const shown = open.length ? open : rows.slice(-1);
    const focused = container.contains(document.activeElement) ? document.activeElement.dataset.nonce : null,
      scroll = container.scrollTop;
    container.replaceChildren();
    container.hidden = !shown.length;
    container.dataset.state = shown.at(-1)?.state || '';
    if (!shown.length) {
      container.append(document.createElement('p'));
      return;
    }
    for (const row of shown) {
      const item = document.createElement('div'),
        label = document.createElement('p'),
        text = document.createElement('small');
      item.className = 'delivery-item';
      item.dataset.nonce = row.nonce;
      item.dataset.state = row.state;
      label.textContent = row.label || '';
      text.textContent = ['completed', 'cancelled', 'stopped'].includes(row.state)
        ? ''
        : (row.text || '').slice(-200) || (row.images || []).map((x) => x.name).join(', ');
      item.append(label, text);
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
    container.scrollTop = scroll;
    if (focused) {
      const next = [...container.querySelectorAll('button')].find((b) => b.dataset.nonce === focused);
      if (next) next.focus({ preventScroll: true });
      else {
        container.tabIndex = -1;
        container.focus({ preventScroll: true });
      }
    }
  };
})();
