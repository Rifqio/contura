/* Contura site: design frames of the real app window, drawn in shadow roots (shared by every page).

   Mount:  <div class="fr-host" data-frame="sources" data-frames-src="frames-safety.json" data-v="import"></div>
     data-frame        the frame id inside the payload
     data-frames-src   the per-page payload, a URL relative to the page. It may sit on the host or on any ancestor
                       (body works). Without it the page's own name is used: safety.html -> frames-safety.json.
     data-v            optional: the state shown first (default: the first state)
     data-tabs="off"   optional: no state tabs (drive it with ConturaFrames.show)
     data-frames-css   optional: the shared stylesheet URL (default frames.css, published beside the page)
   Payload (JSON): { version: 1,
     sheets: { name: "css" },            extra CSS for frames from a source whose rules differ from frames.css
     icons: "<svg>...<symbol id=..>",     the <symbol> sprite the frames' <use href="#id"> point at
     frames: { id: { states: [ { v, label, w, h, sheet|null, aria, html, focus? } ] } } }
   focus (optional, added 2026-10-21 for ai.html): a selector inside the desk that narrow hosts zoom to, the way they
   zoom to a dialog, for states whose point is one panel (the Ask panel, the Settings page).
   html is one rendered .desk element (w x h, usually 1280x800 or 1440x900). Tokens in frames.css sit on .fz and
   .fz[data-theme="dark"], so the frame follows the page theme (the contura:theme event).
   Frames are pictures: pointer-events none, inert, and the host is role="img" with the state's aria text.
   With more than one state, a .win-ctl row of .seg tabs is added after the host.
   It loads when the host comes within about 900px of the viewport.

   API: window.ConturaFrames = { mount(host), show(host, v), states(host), ready(host) -> Promise }
   Event: the host fires 'contura:frame' with detail { v } on every state change. */
(function () {
  'use strict';
  if (window.ConturaFrames) return;
  const doc = document, root = doc.documentElement;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const dark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : mq.matches);
  const cache = {};
  const get = (url, json) => cache[url] || (cache[url] = fetch(url).then((r) => { if (!r.ok) throw new Error(url + ' ' + r.status); return json ? r.json() : r.text(); }).catch((e) => { delete cache[url]; throw e; }));
  const pageName = () => (location.pathname.split('/').pop() || 'index.html').replace(/\.html?$/, '');
  const srcOf = (h) => { const a = h.closest('[data-frames-src]'); return a ? a.getAttribute('data-frames-src') : 'frames-' + pageName() + '.json'; };
  const cssOf = (h) => { const a = h.closest('[data-frames-css]'); return a ? a.getAttribute('data-frames-css') : 'frames.css'; };
  const BASE = ':host{all:initial;display:block;contain:layout paint}' +
    '.vp{position:relative;overflow:hidden;border-radius:10px;border:1px solid var(--c-border);background:var(--c-bg-app);box-shadow:0 24px 60px -32px rgb(0 0 0 / .45)}' +
    '.sc{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;user-select:none}' +
    '.sc .desk{transition:none}.fz{display:block}' +
    '.err{font:12px/1.5 "JetBrains Mono",Consolas,monospace;padding:16px;color:var(--c-text-subtle)}';
  const S = new WeakMap();

  function mount(host) {
    if (S.has(host)) return S.get(host).ready;
    const st = { host, v: host.dataset.v || null, data: null, fr: null, cur: null };
    S.set(host, st);
    host.classList.add('fr-host');
    host.setAttribute('role', 'img');
    const sr = host.shadowRoot || host.attachShadow({ mode: 'open' });
    st.sr = sr;
    st.ready = Promise.all([get(srcOf(host), true), get(cssOf(host), false)]).then(([data, css]) => {
      const fr = data.frames && data.frames[host.dataset.frame];
      if (!fr) throw new Error('No frame "' + host.dataset.frame + '" in ' + srcOf(host));
      st.data = data; st.fr = fr;
      sr.innerHTML = '<style>' + BASE + '</style><style>' + css + '</style><style data-sheet></style>' +
        '<div class="fz" aria-hidden="true"><div class="vp"><div class="sc" inert>' + (data.icons || '') + '<div data-desk></div></div></div></div>';
      st.fz = sr.querySelector('.fz'); st.vp = sr.querySelector('.vp'); st.sc = sr.querySelector('.sc'); st.desk = sr.querySelector('[data-desk]'); st.sheet = sr.querySelector('[data-sheet]');
      theme();
      if (fr.states.length > 1 && host.dataset.tabs !== 'off') tabs(host, st);
      show(host, st.v && fr.states.some((s) => s.v === st.v) ? st.v : fr.states[0].v);
      if ('ResizeObserver' in window) new ResizeObserver(() => fit(st)).observe(host); else addEventListener('resize', () => fit(st));
      host.classList.add('is-mounted');
      return host;
    }).catch((e) => {
      sr.innerHTML = '<style>' + BASE + '</style><p class="err">This picture of the app window did not load. ' + String(e.message || e).replace(/</g, '&lt;') + '</p>';
      host.classList.add('is-failed');
      throw e;
    });
    st.ready.catch(() => {});
    doc.addEventListener('contura:theme', theme);
    mq.addEventListener && mq.addEventListener('change', theme);
    return st.ready;
    function theme() { if (st.fz) st.fz.dataset.theme = dark() ? 'dark' : 'light'; }
  }

  function tabs(host, st) {
    const id = host.id || (host.id = 'fr-' + host.dataset.frame + '-' + Math.random().toString(36).slice(2, 6));
    const ctl = doc.createElement('div');
    ctl.className = 'win-ctl fr-tabs';
    ctl.innerHTML = '<span id="' + id + '-l">' + (host.dataset.tabsLabel || 'Show') + '</span><div class="seg" role="group" aria-labelledby="' + id + '-l" aria-controls="' + id + '">' +
      st.fr.states.map((s) => '<button type="button" data-v="' + s.v + '" aria-pressed="false">' + s.label + '</button>').join('') + '</div>';
    host.after(ctl);
    st.ctl = ctl;
    ctl.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) show(host, b.dataset.v); });
  }

  function fit(st) {
    if (!st.cur) return;
    const w = st.cur.w || 1280, h = st.cur.h || 800;
    const avail = st.host.clientWidth;
    st.sc.style.width = w + 'px'; st.sc.style.height = h + 'px';
    /* narrow hosts: zoom to the state's dialog, if it has one, so its text stays readable (data-zoom="off" turns it off) */
    const dlg = avail < 700 && st.host.dataset.zoom !== 'off' ? (st.cur.focus && st.desk.querySelector(st.cur.focus)) || st.desk.querySelector('.dlg, [role="dialog"]') : null;
    if (dlg) {
      st.sc.style.transform = 'none';
      const r = dlg.getBoundingClientRect(), s0 = st.sc.getBoundingClientRect(), pad = 16;
      const x = Math.max(0, r.left - s0.left - pad), y = Math.max(0, r.top - s0.top - pad);
      const dw = Math.min(w - x, r.width + 2 * pad), dh = Math.min(h - y, r.height + 2 * pad);
      const k = Math.min(1, (avail - 2) / dw);
      st.sc.style.transform = 'scale(' + k + ') translate(' + -x + 'px,' + -y + 'px)';
      st.vp.style.height = Math.round(dh * k) + 2 + 'px';
      st.host.dataset.zoomed = 'dialog';
      return;
    }
    delete st.host.dataset.zoomed;
    const sc = Math.min(1, Math.max(0.05, (avail - 2) / w));
    st.sc.style.transform = 'scale(' + sc + ')';
    st.vp.style.height = Math.round(h * sc) + 2 + 'px';
  }

  function show(host, v) {
    const st = S.get(host);
    if (!st || !st.fr) { if (st) st.v = v; return; }
    const s = st.fr.states.find((x) => x.v === v) || st.fr.states[0];
    st.cur = s; st.v = s.v;
    st.sheet.textContent = s.sheet && st.data.sheets ? st.data.sheets[s.sheet] || '' : '';
    st.desk.innerHTML = s.html;
    host.setAttribute('aria-label', s.aria || s.label);
    host.dataset.state = s.v;
    if (st.ctl) st.ctl.querySelectorAll('button[data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === s.v)));
    fit(st);
    host.dispatchEvent(new CustomEvent('contura:frame', { detail: { v: s.v } }));
  }

  const states = (host) => { const st = S.get(host); return st && st.fr ? st.fr.states.map((s) => ({ v: s.v, label: s.label })) : []; };
  const ready = (host) => mount(host);

  function scan() {
    const hosts = [...doc.querySelectorAll('[data-frame]')];
    if (!('IntersectionObserver' in window)) { hosts.forEach(mount); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); mount(e.target); } }), { rootMargin: '900px 0px 900px 0px' });
    hosts.forEach((h) => io.observe(h));
  }
  window.ConturaFrames = { mount, show, states, ready };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', scan); else scan();
})();
