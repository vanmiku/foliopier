(() => {
  const form = document.getElementById('lan-login');
  if (form && location.hash.startsWith('#code=')) {
    const code = new URLSearchParams(location.hash.slice(1)).get('code');
    history.replaceState(null, '', location.pathname + location.search);
    if (code) { form.elements.code.value = code; form.elements.device.focus(); }
  }
  const pair = document.getElementById('lan-pair');
  if (!pair) return;
  let failures = 0, stopped = false;
  document.getElementById('pair-cancel')?.addEventListener('click', async e => {
    const button = e.currentTarget; button.disabled = true;
    try {
      const r = await fetch('/api/logout', { method: 'POST', headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' }, body: '{}' });
      if (!r.ok) throw new Error('offline');
      stopped = true; location.replace('/login?next=' + encodeURIComponent(pair.dataset.next));
    } catch { show('offline'); button.disabled = false; }
  });
  function show(state) {
    for (const el of pair.querySelectorAll('[data-pair]')) el.hidden = el.dataset.pair !== state;
    pair.dataset.state = state;
  }
  async function poll() {
    if (stopped) return;
    try {
      const r = await fetch('/api/pair', { cache: 'no-store' });
      if (!r.ok) throw new Error('offline');
      const s = await r.json(); failures = 0;
      if (s.state === 'approved') {
        stopped = true;
        const next = pair.dataset.next;
        location.replace(/^\/(?![\/\\])/.test(next) ? next : '/'); return;
      }
      show(s.state);
      if (s.state === 'expired' || s.state === 'denied') { stopped = true; return; }
    } catch { if (++failures >= 3) show('offline'); }
    setTimeout(poll, 2000);
  }
  show(pair.dataset.state); poll();
})();
