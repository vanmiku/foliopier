// Shared file navigation. No workbench APIs, session data or network requests.
(() => {
  for (const root of document.querySelectorAll('[data-file-nav]')) {
    const list = root.querySelector('.tabs');
    const previous = root.querySelector('[data-file-step="-1"]');
    const next = root.querySelector('[data-file-step="1"]');
    const position = root.querySelector('.file-nav-scroll');
    if (!list || !previous || !next || !position) continue;
    root.setAttribute('data-file-ready', '');
    const update = () => {
      if (!root.clientWidth) return;
      root.toggleAttribute('data-overflow', list.scrollWidth > root.clientWidth + 1);
      previous.disabled = list.scrollLeft < 2;
      next.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 2;
      const max = list.scrollWidth - list.clientWidth;
      position.value = String(max > 0 ? Math.round(list.scrollLeft / max * 1000) : 0);
      position.style.setProperty('--file-thumb-size', `${Math.max(24, list.clientWidth * list.clientWidth / Math.max(1, list.scrollWidth))}px`);
    };
    const move = amount => { list.scrollLeft += amount; update(); };
    previous.addEventListener('click', () => move(-Math.max(120, list.clientWidth * .8)));
    next.addEventListener('click', () => move(Math.max(120, list.clientWidth * .8)));
    position.addEventListener('input', () => {
      list.scrollLeft = Number(position.value) / 1000 * (list.scrollWidth - list.clientWidth);
      update();
    });
    list.addEventListener('scroll', update, { passive: true });
    list.addEventListener('keydown', e => {
      // Links retain normal Tab/Enter behavior. Arrow/Home/End move only this strip.
      const page = Math.max(120, list.clientWidth * .8);
      const amount = { ArrowLeft: -page, ArrowRight: page, Home: -list.scrollWidth, End: list.scrollWidth }[e.key];
      if (amount == null || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault(); move(amount);
    });
    const revealCurrent = () => {
      update();
      const current = list.querySelector('[aria-current="page"]');
      if (!current) return;
      const a = current.getBoundingClientRect(), b = list.getBoundingClientRect();
      if (a.left < b.left || a.width > b.width) move(a.left - b.left);
      else if (a.right > b.right) move(a.right - b.right);
    };
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(revealCurrent);
      observer.observe(root); observer.observe(list);
    } else window.addEventListener('resize', revealCurrent);
    revealCurrent();
    document.fonts?.ready.then(revealCurrent);
  }
})();
