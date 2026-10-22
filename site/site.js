/* Contura site: shared shell. Theme (system or the status-bar switch), the gutter and status bar, scroll reveals,
   and the prototype download notice. Loaded in <head> so the saved theme applies before the first paint. */
(function () {
  'use strict';
  const root = document.documentElement;
  root.classList.add('js');
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : mq.matches);
  try { const saved = localStorage.getItem('contura-theme'); if (saved === 'dark' || saved === 'light') root.dataset.theme = saved; } catch (e) {}

  function paint() {
    const btn = document.querySelector('[data-theme-btn]');
    if (btn) btn.setAttribute('aria-label', isDark() ? 'Switch to Alucard, the light theme' : 'Switch to Dracula, the dark theme');
    document.dispatchEvent(new CustomEvent('contura:theme'));
  }
  mq.addEventListener && mq.addEventListener('change', paint);

  function ready() {
    paint();
    const tbtn = document.querySelector('[data-theme-btn]');
    if (tbtn) tbtn.addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('contura-theme', next); } catch (e) {}
      paint();
    });

    /* the gutter: current statement, read markers, status bar */
    const stmts = [...document.querySelectorAll('main .stmt')];
    const lnEl = document.querySelector('[data-ln]'), secEl = document.querySelector('[data-sec]'), pendingEl = document.querySelector('[data-pending]');
    const read = new Set();
    let cur = -1, saved = false;
    function update() {
      if (!stmts.length) return;
      const mid = innerHeight * 0.4;
      let idx = 0;
      stmts.forEach((s, i) => { if (s.getBoundingClientRect().top <= mid) idx = i; });
      if (innerHeight + scrollY >= root.scrollHeight - 4) idx = stmts.length - 1;
      for (let i = 0; i <= idx; i++) if (!read.has(i)) { read.add(i); stmts[i].classList.add('is-read'); }
      if (idx !== cur) {
        if (cur >= 0) stmts[cur].classList.remove('is-cur');
        cur = idx; stmts[cur].classList.add('is-cur');
        if (lnEl) lnEl.textContent = 'Ln ' + (cur + 1);
        if (secEl) secEl.textContent = stmts[cur].dataset.name || '';
      }
      if (pendingEl && !saved) pendingEl.textContent = read.size + ' pending' + (read.size === stmts.length ? ', ready to save' : '');
    }
    let ticking = false;
    addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; update(); }); } }, { passive: true });
    addEventListener('resize', update);
    update();

    /* reveals: only what starts below the fold waits; it fades up once when it enters view */
    const rev = [...document.querySelectorAll('[data-reveal]')];
    if (!reduce.matches && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.remove('pre'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
      rev.forEach((el) => { if (el.getBoundingClientRect().top > innerHeight * 0.92) { el.classList.add('pre'); io.observe(el); } });
    }

    /* the download is a prototype: say so where it was pressed */
    document.querySelectorAll('[data-download]').forEach((b) => b.addEventListener('click', (ev) => {
      ev.preventDefault();
      document.querySelectorAll('[data-note]').forEach((n) => { n.hidden = true; n.textContent = ''; });
      const box = b.closest('.dl-box'), n = box && box.querySelector('[data-note]');
      if (n) { n.hidden = false; n.textContent = 'Prototype build. Downloads open with the public release.'; }
      saved = true;
      if (pendingEl) { pendingEl.textContent = 'Nothing saved, prototype'; pendingEl.classList.add('done'); }
    }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
