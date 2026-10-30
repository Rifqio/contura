/* Contura site, index.html (the single launch page): the section links in the top bar, the heavy demos loaded only
   when their section comes near, the board's Follow highlight, and the held write in the Safety section.
   Without this script every section is placed and still: the board is drawn, the held write shows its question. */
(function () {
  'use strict';
  const doc = document;
  const $ = (s, r) => (r || doc).querySelector(s), $$ = (s, r) => [...(r || doc).querySelectorAll(s)];

  /* ---------------- the top bar marks the section in view ---------------- */
  const links = $$('.nav a[href^="#"]');
  const secs = links.map((a) => doc.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
  let curLink = null;
  function mark() {
    const mid = innerHeight * 0.4;
    let on = null;
    secs.forEach((s) => { const r = s.getBoundingClientRect(); if (r.top <= mid && r.bottom > mid) on = s; });
    const a = on ? links.find((l) => l.getAttribute('href') === '#' + on.id) : null;
    if (a === curLink) return;
    if (curLink) curLink.removeAttribute('aria-current');
    curLink = a;
    if (a) a.setAttribute('aria-current', 'true');
  }
  let tick = false;
  addEventListener('scroll', () => { if (!tick) { tick = true; requestAnimationFrame(() => { tick = false; mark(); }); } }, { passive: true });
  addEventListener('resize', mark);
  mark();

  /* ---------------- heavy demos: load the script when its section is about a screen away ---------------- */
  const loaded = new Set();
  function load(src) {
    if (loaded.has(src)) return;
    loaded.add(src);
    const s = doc.createElement('script');
    s.src = src; s.async = false;
    s.onload = () => doc.dispatchEvent(new CustomEvent('contura:lazy', { detail: src }));
    doc.head.appendChild(s);
  }
  const lazy = $$('[data-lazy]');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); load(e.target.dataset.lazy); } }), { rootMargin: '100% 0px 100% 0px' });
    lazy.forEach((el) => io.observe(el));
  } else lazy.forEach((el) => load(el.dataset.lazy));

  /* ---------------- the board: point at a part, or Follow one, and it shows in every frame ---------------- */
  const board = $('[data-board]');
  if (board) {
    const btns = $$('[data-follow]', board);
    let pinned = '';
    const show = (k) => {
      board.classList.toggle('is-follow', !!k);
      $$('[data-k]', board).forEach((el) => el.classList.toggle('on', !!k && el.dataset.k.split(' ').includes(k)));
    };
    btns.forEach((b) => b.addEventListener('click', () => {
      pinned = pinned === b.dataset.follow ? '' : b.dataset.follow;
      btns.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.follow === pinned)));
      show(pinned);
    }));
    if (matchMedia('(hover: hover)').matches) {
      $$('.bd-svg', board).forEach((svg) => {
        svg.addEventListener('pointerover', (e) => { const g = e.target.closest('[data-k]'); const k = g && g.dataset.k.split(' ')[0]; if (k) show(k); });
        svg.addEventListener('pointerleave', () => show(pinned));
      });
    }
  }

  /* ---------------- Safety: one held write (from the former Safety page) ---------------- */
  const K = window.ConturaKit;
  function createHold(host, seg) {
    let mode = 'prod', state = 'idle', note = '';
    const SQL = '<ol><li><span class="c">-- Query 1 on freight-prod</span></li>' +
      '<li class="w"><span><span class="k">UPDATE</span> billing.invoices <span class="k">SET</span> status = <span class="s">\'void\'</span></span></li>' +
      '<li class="w"><span><span class="k">WHERE</span> number = <span class="s">\'INV-2026-0042\'</span>;</span></li></ol>';
    const pill = () => (mode === 'prod' ? '<span class="pill prod">PROD</span>' : '<span class="pill prod">PROD</span><span class="pill ro">Read-only</span>');
    function paint(focusSel) {
      let h = '<div class="hold-h"><p class="t">Query 1</p><span class="meta">freight-prod</span>' + pill() + '</div><div class="sql" tabindex="0" role="region" aria-label="The statement, exactly as it will run">' + SQL + '</div>';
      if (state === 'idle') h += '<div class="hold-st"><p>One statement that writes.</p><div class="acts"><button type="button" class="btn sm" data-go>Run</button></div></div>';
      else if (state === 'held') h += '<div class="hold-st held"><span class="tag">Waiting for your review</span><p>freight-prod is a Production Connection. This UPDATE writes to billing.invoices, shown above exactly as it will run. Run it?</p><div class="acts"><button type="button" class="btn sm" data-yes>Run on PROD</button><button type="button" class="ghost" data-no>Cancel</button></div></div>';
      else if (state === 'blocked') h += '<div class="hold-st blocked"><span class="tag">Blocked</span><p>freight-prod is Read-only, so Contura does not send writes, and the server session is read-only as a backstop.</p><div class="acts"><button type="button" class="ghost" data-reset>Back</button></div></div>';
      else if (state === 'ran') h += '<div class="hold-st"><p><b>Ran after your yes.</b> ' + note + '</p><div class="acts"><button type="button" class="ghost" data-reset>Back</button></div></div>';
      else h += '<div class="hold-st"><p>Cancelled. <b>Nothing ran.</b></p><div class="acts"><button type="button" class="ghost" data-reset>Back</button></div></div>';
      host.innerHTML = h;
      host.dataset.state = state; host.dataset.mode = mode;
      if (focusSel) { const f = $(focusSel, host); f && f.focus({ preventScroll: true }); }
    }
    async function yes() {
      note = '1 row updated on freight-prod, in this page\'s sample.';
      try {
        const db = await K.getDB();
        db.exec("UPDATE billing.invoices SET status = 'void' WHERE number = 'INV-2026-0042'");
        const n = db.getRowsModified();
        note = (n === 1 ? '1 row' : n + ' rows') + ' updated on freight-prod, in this page\'s sample.';
        doc.dispatchEvent(new CustomEvent('contura:data'));
      } catch (e) { note = 'The sample database did not load, so nothing ran here.'; }
      state = 'ran'; paint('[data-reset]');
    }
    const go = () => { state = mode === 'prod' ? 'held' : 'blocked'; paint(mode === 'prod' ? '[data-yes]' : '[data-reset]'); };
    const no = () => { state = 'cancel'; paint('[data-reset]'); };
    const reset = () => { state = 'idle'; paint(); };
    function setMode(m) {
      mode = m; state = 'idle';
      $$('button[data-v]', seg).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === m)));
      paint();
    }
    host.addEventListener('click', (e) => {
      if (e.target.closest('[data-go]')) go();
      else if (e.target.closest('[data-yes]')) yes();
      else if (e.target.closest('[data-no]')) no();
      else if (e.target.closest('[data-reset]')) { reset(); const g = $('[data-go]', host); g && g.focus({ preventScroll: true }); }
    });
    seg.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b && b.dataset.v !== mode) setMode(b.dataset.v); });
    paint();
  }
  const holdHost = $('[data-hold]'), holdSeg = holdHost && doc.getElementById(holdHost.dataset.hold);
  if (holdHost && holdSeg && K) createHold(holdHost, holdSeg);

})();
