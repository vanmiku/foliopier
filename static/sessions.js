(() => {
  const T =
    window.T ||
    ((key, vars = {}) => {
      const l = window.__LANG || 'en';
      const v = l === 'en' ? key : window.__T?.[key] || key;
      return v.replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? '');
    });
  const newId = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('.cm-agent');
    if (!b || document.getElementById('article-session-data')) return;
    b.disabled = true;
    b.dataset.nonce ||= newId();
    saveDraft();
    try {
      const r = await fetch('/api/sessions/comment', {
        method: 'POST',
        headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: document.body.dataset.id,
          cid: b.dataset.comment,
          nonce: b.dataset.nonce,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      location.assign(data.url);
    } catch (error) {
      const toast = document.querySelector('.toast');
      if (toast) {
        toast.textContent = error.message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 6000);
      }
      b.disabled = false;
    }
  });
  if (matchMedia('(max-width: 639px)').matches)
    document.querySelector('.session-section')?.removeAttribute('open');
  const list = document.querySelector('[data-session-list]'),
    chat = document.getElementById('session-chat');
  async function read(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw Error(r.status);
    return r.json();
  }
  const status = document.querySelector('.session-send-status');
  const form = document.getElementById('session-send'),
    text = document.getElementById('session-text');
  let last = '',
    busy = false,
    nonce = null,
    savedText = null;
  const key = chat ? 'mydash.session.draft.' + chat.dataset.sessionId : null;
  function saveDraft() {
    try {
      sessionStorage.setItem(key, JSON.stringify({ text: text.value, nonce, savedText }));
    } catch {}
  }
  try {
    if (text) {
      const raw = sessionStorage.getItem(key) || '';
      try {
        const d = JSON.parse(raw);
        text.value = typeof d.text === 'string' ? d.text : '';
        nonce = d.nonce || null;
        savedText = d.savedText || null;
      } catch {
        text.value = raw;
      }
    }
  } catch {}
  text?.addEventListener('input', () => {
    nonce = null;
    saveDraft();
  });
  async function poll() {
    if (document.hidden || busy) return;
    try {
      if (list) {
        const data = await read('/api/sessions?project=' + encodeURIComponent(list.dataset.project));
        if (data.html !== last) {
          const endedOpen = list.querySelector('.session-ended')?.open;
          list.innerHTML = data.html;
          if (endedOpen && list.querySelector('.session-ended'))
            list.querySelector('.session-ended').open = true;
          last = data.html;
        }
      }
      if (chat) {
        const data = await read('/api/sessions/' + encodeURIComponent(chat.dataset.sessionId));
        document.querySelector('[data-session-state]').textContent = data.stateLabel;
        const box = document.getElementById('session-messages');
        if (data.html !== last) {
          const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
          box.innerHTML = data.html;
          last = data.html;
          if (atBottom) form.scrollIntoView({ block: 'end' });
        }
        const delivery = data.session.deliveries?.at(-1);
        if (delivery) status.textContent = delivery.label;
        window.mydashRenderDeliveries(
          document.querySelector('.session-deliveries'),
          data.session.deliveries,
          data.session.transport
        );
        const hint = document.querySelector('[data-session-send-hint]');
        hint.textContent = data.session.canSend
          ? data.session.transport === 'codex-app'
            ? T('Connected to Codex App')
            : data.session.transport === 'claude-remote'
              ? T('Connected to Claude Remote Control')
              : T('Connected to the original tmux session')
          : data.session.sendReason === 'claude_busy'
            ? T('Claude is working or waiting for approval. Send when it is idle, or continue in Claude App.')
            : T('Sending is unavailable. Check the connection or messaging settings.');
        text.disabled = !data.session.canSend;
        form.querySelector('button').disabled = !data.session.canSend;
      }
    } catch {
      if (status) status.textContent = T('The session is unavailable. Your draft is kept.');
    }
  }
  if (document.getElementById('cm-data'))
    setInterval(async () => {
      if (document.hidden || !document.querySelector('.cm-item a[href^="/sessions/"]')) return;
      try {
        const data = await read(
          '/api/session-comment-replies?id=' + encodeURIComponent(document.body.dataset.id)
        );
        for (const reply of data.replies) {
          const card = document.getElementById('cm-' + reply.cid);
          if (!card) continue;
          let p = card.querySelector('.cm-agent-reply');
          if (!p) {
            p = document.createElement('p');
            p.className = 'cm-agent-reply';
            card.appendChild(p);
          }
          p.textContent = reply.text;
        }
      } catch {}
    }, 3000);
  if (list || chat) {
    setInterval(poll, 3000);
    poll();
  }
  document.querySelector('.session-deliveries')?.addEventListener('click', async (event) => {
    const b = event.target.closest('[data-session-cancel]');
    if (!b || b.disabled) return;
    b.disabled = true;
    try {
      const r = await fetch('/api/sessions/cancel', {
        method: 'POST',
        headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: chat.dataset.sessionId,
          nonce: b.dataset.nonce,
          stopWaiting: b.dataset.stopWaiting === 'true',
        }),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      await poll();
    } catch (e) {
      status.textContent = e.message;
    } finally {
      b.disabled = false;
    }
  });
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !text.value.trim()) return;
    busy = true;
    form.querySelector('button').disabled = true;
    if (savedText !== text.value) {
      nonce = newId();
      savedText = text.value;
    }
    nonce ||= newId();
    saveDraft();
    try {
      const r = await fetch('/api/sessions/send', {
        method: 'POST',
        headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: chat.dataset.sessionId, text: text.value, nonce }),
      });
      const data = await r.json();
      if (!r.ok) {
        throw Error(data.error || T('That did not work. Try again in a moment.'));
      }
      if (text.value === savedText) {
        text.value = '';
        try {
          sessionStorage.removeItem(key);
        } catch {}
      }
      nonce = null;
      savedText = null;
      if (text.value) saveDraft();
      status.textContent = ['codex-app', 'claude-remote'].includes(data.transport)
        ? data.delivery.label
        : T('Handed to the terminal. Waiting for the conversation to update.');
    } catch (e) {
      saveDraft();
      status.textContent =
        e.message || T('Check the terminal before retrying. The previous delivery may have reached it.');
    } finally {
      busy = false;
      form.querySelector('button').disabled = false;
    }
  });
})();
