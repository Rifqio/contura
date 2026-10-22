/* Contura site, Model page (model.html): three live demos and their playback.
   1. Schema Builder [data-md-dbml]: the billing tables of ConturaKit.T typed in as DBML, cards and Ref lines drawn as
      each block lands, hover linking between text, columns and relations (ported from the single-page site's
      [data-dbml] engine: paintLine, build, layout, frame, play), plus "Edit it": the same text in an editor that
      re-parses and redraws on every change (ported from the "Contura" line page's model parse / render / draw).
   2. Schema Compare [data-md-compare]: a new app window in a shadow root (ConturaKit APP_CSS and PG_CSS): the
      differences tree, the Sync Script with one tick per change, dependants that untick together, a data-loss item
      that starts unticked, a freight-stg / freight-prod switch and the Production confirm listing the exact statements.
   3. Diagrams [data-md-diagrams]: the nine-kind .flow gallery, loaded from model-diagrams.js when the section is about
      one screen away.
   Playback for each through window.ConturaPlay, driven by the same functions the controls call. */
(function () {
  'use strict';
  const K = window.ConturaKit;
  const doc = document;
  const q = new URLSearchParams(location.search);
  const rm = matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => rm.matches || q.get('reduce') === '1';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const $ = (s, r) => (r || doc).querySelector(s), $$ = (s, r) => [...(r || doc).querySelectorAll(s)];
  const autoPlay = () => window.ConturaPlay ? window.ConturaPlay.auto() : (q.get('play') === '1' || (q.get('play') !== '0' && (matchMedia('(max-width: 760px)').matches || matchMedia('(pointer: coarse)').matches)));

  /* ConturaPlay is shared and may load after this file: attach now, or when it says it is ready */
  const queued = [];
  function play(figure, steps, opts) { if (figure) queued.push([figure, steps, opts]); flush(); }
  function flush() { const P = window.ConturaPlay; if (!P) return; queued.splice(0).forEach(([f, s, o]) => { f._pb = P.attach(f, s, o); }); }
  doc.addEventListener('contura:play-ready', flush);
  const until = async (ctx, test, max) => { const t0 = performance.now(); while (!test()) { if (performance.now() - t0 > (max || 30000)) return; await ctx.wait(150); } };

  /* ================================================================== */
  /*                  1. SCHEMA BUILDER: DBML TO MODEL                    */
  /* ================================================================== */
  const TYPES = 'bigint|integer|int|smallint|text|char|varchar|numeric|decimal|date|timestamptz|timestamp|boolean|uuid|serial|bigserial|real|json|jsonb';
  function paintLine(t) {
    const re = new RegExp("(//.*$)|('[^']*')|\\b(Table|Ref|Enum|pk|note|ref|not null|unique|default)\\b|\\b(" + TYPES + ")\\b|\\b(\\d+)\\b|([{}\\[\\]()<>:,.-])", 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(t))) {
      out += esc(t.slice(last, m.index));
      const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : m[4] ? 't' : m[5] ? 'n' : 'p';
      out += '<span class="md-' + cls + '">' + esc(m[0]) + '</span>'; last = re.lastIndex;
      if (m[0] === '') re.lastIndex++;
    }
    return out + esc(t.slice(last));
  }
  /* the DBML of the kit's billing tables, parents first, so each Ref has both ends drawn when it lands */
  function dbmlOf() {
    const T = K.T, FT = K.FULLTYPE || {};
    const ty = (t, c, x) => FT[t + '.' + c] || ({ int8: 'bigint', int4: 'integer' })[x] || x;
    const NOTE = { 'customers.country': 'ISO 3166 code', 'invoices.status': 'open, paid or void' };
    const order = ['plans', 'customers', 'invoices', 'payments', 'orders', 'order_items'].filter((t) => T[t]);
    Object.keys(T).forEach((t) => { if (!order.includes(t)) order.push(t); });
    const L = ['// billing on freight-stg, the Query page sample', ''];
    const refs = [];
    order.forEach((t) => {
      L.push('Table ' + t + ' {');
      T[t].forEach((c) => {
        const at = [];
        if (c[2] === 'pk') at.push('pk');
        if (NOTE[t + '.' + c[0]]) at.push("note: '" + NOTE[t + '.' + c[0]] + "'");
        L.push('  ' + c[0] + ' ' + ty(t, c[0], c[1]) + (at.length ? ' [' + at.join(', ') + ']' : ''));
        if (c[2] === 'fk') refs.push('Ref: ' + t + '.' + c[0] + ' > ' + c[3] + '.id');
      });
      L.push('}', '');
    });
    return L.concat(refs).join('\n');
  }
  /* the DBML reader: Table blocks, columns with [pk] and [note], Ref lines with > < or - (the line page's model.parse, widened) */
  function parse(src) {
    const tables = [], refs = [], issues = [], keys = [];
    let cur = null;
    src.split('\n').forEach((raw, i) => {
      const line = raw.replace(/\/\/.*$/, '').trim();
      keys[i] = '';
      if (!line) return;
      let m;
      if ((m = /^Table\s+([A-Za-z_][\w.]*)\s*\{?$/.exec(line))) { cur = { name: m[1].replace(/^\w+\./, ''), cols: [], line: i }; tables.push(cur); keys[i] = 't:' + cur.name; return; }
      if (line === '}') { if (cur) keys[i] = 'e:' + cur.name; cur = null; return; }
      if ((m = /^Ref\s*\w*\s*:\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*([<>-])\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(line))) {
        const a = [m[1], m[2]], b = [m[4], m[5]];
        keys[i] = 'r:' + refs.length;
        refs.push(m[3] === '<' ? { from: b, to: a, line: i } : { from: a, to: b, line: i }); return;
      }
      if (cur && (m = /^([A-Za-z_]\w*)\s+([A-Za-z_][\w(), ]*?)\s*(\[([^\]]*)\])?$/.exec(line))) {
        const at = m[4] || '', note = /note:\s*'([^']*)'/.exec(at);
        cur.cols.push({ name: m[1], type: m[2].replace(/\s+/g, ''), pk: /\bpk\b/.test(at), note: note && note[1], line: i });
        keys[i] = 'c:' + cur.name + '.' + m[1]; return;
      }
      if (/^(Ref|Table)\b/.test(line)) return; // partly typed
      issues.push('line ' + (i + 1) + ' was skipped');
    });
    return { tables, refs, issues, keys };
  }
  const KEY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.5 4a3.5 3.5 0 1 1-.02 7A3.5 3.5 0 0 1 5.5 4zm0 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM8.6 6.6H15v2h-1.4v2h-2v-2H8.6z"/></svg>';
  const ORDER3 = ['plans', 'customers', 'orders', 'payments', 'invoices', 'order_items'];
  const ORDER2 = ['plans', 'customers', 'orders', 'invoices', 'order_items', 'payments'];

  function createDbml(host) {
    const START = dbmlOf();
    const S = { text: START, mode: 'type', model: null, t: 0, last: 0, playing: false, visible: false, played: false, sticky: '', done: new Set(), drawn: new Set(), seen: new Set(), cols: 0, raf: 0 };
    host.innerHTML =
      '<div class="md-db" data-mode="type">' +
      '<div class="md-db-head"><b>billing.dbml</b><span>Schema Builder</span><span class="md-db-st" role="status" aria-live="polite"></span><button type="button" class="md-db-again" hidden>Type it again</button></div>' +
      '<div class="md-db-code">' +
      '<div class="md-db-lines" aria-label="DBML lines. Use the arrow keys to move between them."></div>' +
      '<div class="md-db-ed" hidden><div class="md-db-gut" aria-hidden="true"></div><div class="md-db-box"><pre class="md-db-hl" aria-hidden="true"></pre>' +
      '<textarea class="md-db-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="DBML text of the model, editable. The diagram redraws as you type."></textarea></div></div>' +
      '</div>' +
      '<div class="md-db-dia" role="img" aria-label="Model diagram"><svg class="md-db-rel" aria-hidden="true"></svg><div class="md-db-grid"></div></div>' +
      '</div>';
    const root = $('.md-db', host), linesEl = $('.md-db-lines', root), ed = $('.md-db-ed', root), gut = $('.md-db-gut', root), pre = $('.md-db-hl', root), ta = $('.md-db-ta', root);
    const dia = $('.md-db-dia', root), grid = $('.md-db-grid', root), svg = $('.md-db-rel', root), st = $('.md-db-st', root), again = $('.md-db-again', root), code = $('.md-db-code', root);
    let byKey = {}, lines = [], starts = [], END = 0;
    const CPS = 120;

    /* the line view (typed mode) */
    function buildLines() {
      const L = S.text.split('\n');
      let first = true;
      linesEl.innerHTML = L.map((t, i) => {
        const k = S.model.keys[i] || '';
        const tab = k ? (first ? ' tabindex="0"' : ' tabindex="-1"') : '';
        if (k) first = false;
        return '<div class="md-line"' + (k ? ' data-k="' + esc(k) + '"' : '') + tab + ' style="--c:' + t.length + '"><span class="no" aria-hidden="true">' + (i + 1) + '</span><span class="tx"><span class="in">' + (paintLine(t) || ' ') + '</span></span></div>';
      }).join('');
      lines = $$('.md-line', linesEl);
      starts = []; let acc = 0.3;
      L.forEach((t, i) => { starts.push(acc); const k = S.model.keys[i] || ''; acc += t.length / CPS + (t ? (k[0] === 'e' ? 0.25 : 0.05) : 0.15); });
      END = acc + 0.3;
    }
    /* the cards, in an order that keeps every Ref short; a table the text adds goes after the known ones */
    function buildCards(pre) {
      const m = S.model;
      const has = (t, c) => m.tables.some((x) => x.name === t && x.cols.some((y) => y.name === c));
      const fks = new Set(m.refs.filter((r) => has(r.from[0], r.from[1]) && has(r.to[0], r.to[1])).map((r) => r.from.join('.')));
      S.cols = dia.clientWidth >= 640 ? 3 : 2;
      const ord = S.cols === 3 ? ORDER3 : ORDER2;
      const ts = m.tables.slice().sort((a, b) => { const ia = ord.indexOf(a.name), ib = ord.indexOf(b.name); return (ia < 0 ? 99 + a.line : ia) - (ib < 0 ? 99 + b.line : ib); });
      grid.style.setProperty('--cols', S.cols);
      grid.innerHTML = ts.map((t) => {
        const fresh = !pre && S.mode === 'edit' && !S.seen.has('t:' + t.name);
        return '<div class="md-card' + (pre ? ' pre' : '') + (fresh ? ' new' : '') + '" data-k="t:' + esc(t.name) + '"><div class="md-ch">' + esc(t.name) + '</div>' +
          t.cols.map((c) => {
            const k = 'c:' + t.name + '.' + c.name, fr = !pre && S.mode === 'edit' && !S.seen.has(k);
            const mk = c.pk ? KEY : fks.has(t.name + '.' + c.name) ? '<span class="fk">FK</span>' : '';
            return '<div class="md-row' + (pre ? ' pre' : '') + (fr ? ' new' : '') + '" data-k="' + esc(k) + '"><span class="mk">' + mk + '</span><span class="cn">' + esc(c.name) + '</span><span class="ty">' + esc(c.type) + '</span>' + (c.note ? '<span class="md-note">' + esc(c.note) + '</span>' : '') + '</div>';
          }).join('') + '</div>';
      }).join('') || '<p class="md-db-empty">Write a Table block to see its card.</p>';
      S.seen = new Set();
      m.tables.forEach((t) => { S.seen.add('t:' + t.name); t.cols.forEach((c) => S.seen.add('c:' + t.name + '.' + c.name)); });
      index();
      layout();
      const ok = okRefs().length, bad = m.refs.length - ok;
      st.textContent = m.tables.length + (m.tables.length === 1 ? ' table, ' : ' tables, ') + ok + (ok === 1 ? ' Ref drawn' : ' Refs drawn') +
        (bad && S.mode === 'edit' ? '; ' + bad + (bad === 1 ? ' Ref points' : ' Refs point') + ' at a missing column' : '') + (m.issues.length && S.mode === 'edit' ? '; ' + m.issues[0] : '');
      dia.setAttribute('aria-label', 'Model diagram: ' + (m.tables.map((t) => t.name).join(', ') || 'empty') + '. ' + ok + ' relations.');
    }
    function index() { byKey = {}; $$('[data-k]', root).forEach((el) => { (byKey[el.dataset.k] = byKey[el.dataset.k] || []).push(el); }); }
    const rowOf = (t, c) => (byKey['c:' + t + '.' + c] || []).find((e) => e.classList.contains('md-row'));
    const okRefs = () => S.model.refs.map((r, i) => ({ r, i })).filter(({ r }) => rowOf(r.from[0], r.from[1]) && rowOf(r.to[0], r.to[1]));
    function box(el) { const a = el.getBoundingClientRect(), b = dia.getBoundingClientRect(); return { l: a.left - b.left, r: a.right - b.left, t: a.top - b.top, b: a.bottom - b.top, y: (a.top + a.bottom) / 2 - b.top }; }
    function layout() {
      const W = dia.clientWidth, H = dia.clientHeight;
      svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      let h = '';
      okRefs().forEach(({ r, i }, n) => {
        const ra = rowOf(r.from[0], r.from[1]), rb = rowOf(r.to[0], r.to[1]);
        const A = box(ra), B = box(rb), cA = box(ra.parentElement), cB = box(rb.parentElement);
        const ya = Math.round(A.y), yb = Math.round(B.y);
        let d, la, lb;
        if (cA.r < cB.l - 4) { const m = Math.round((cA.r + cB.l) / 2) + (n % 3 - 1) * 5; d = 'M' + cA.r + ' ' + ya + 'H' + m + 'V' + yb + 'H' + cB.l; la = [cA.r + 5, ya - 5, 'start']; lb = [cB.l - 5, yb - 5, 'end']; }
        else if (cB.r < cA.l - 4) { const m = Math.round((cA.l + cB.r) / 2) + (n % 3 - 1) * 5; d = 'M' + cA.l + ' ' + ya + 'H' + m + 'V' + yb + 'H' + cB.r; la = [cA.l - 5, ya - 5, 'end']; lb = [cB.r + 5, yb - 5, 'start']; }
        else { const x = Math.round(Math.max(cA.r, cB.r)) + 10 + (n % 3) * 5; d = 'M' + cA.r + ' ' + ya + 'H' + x + 'V' + yb + 'H' + cB.r; la = [cA.r + 4, ya - 5, 'start']; lb = [cB.r + 4, yb - 5, 'start']; }
        const k = 'r:' + i, on = S.drawn.has(i);
        h += '<g data-k="' + k + '"><path class="md-hit" d="' + d + '"/><path class="md-ln" d="' + d + '"/>' +
          '<text x="' + la[0] + '" y="' + la[1] + '" text-anchor="' + la[2] + '"' + (on ? '' : ' class="off"') + '>*</text><text x="' + lb[0] + '" y="' + lb[1] + '" text-anchor="' + lb[2] + '"' + (on ? '' : ' class="off"') + '>1</text></g>';
      });
      svg.innerHTML = h;
      $$('path.md-ln', svg).forEach((p) => { const k = +p.parentNode.dataset.k.slice(2); const len = Math.ceil(p.getTotalLength()); p.style.strokeDasharray = len; p.style.strokeDashoffset = S.drawn.has(k) ? 0 : len; });
      $$('g[data-k]', svg).forEach((g) => (byKey[g.dataset.k] = (byKey[g.dataset.k] || []).filter((e) => e.isConnected).concat([g])));
      hl(S.sticky);
    }
    /* hover linking: a line, a column or a relation lights its matches */
    function expand(k) {
      if (!k) return [];
      if (k[0] === 'e') return ['t:' + k.slice(2)];
      if (k[0] === 'r') { const r = S.model.refs[+k.slice(2)]; return r ? [k, 'c:' + r.from.join('.'), 'c:' + r.to.join('.')] : [k]; }
      if (k[0] === 'c') { const out = [k]; S.model.refs.forEach((r, i) => { if ('c:' + r.from.join('.') === k || 'c:' + r.to.join('.') === k) out.push('r:' + i); }); return out; }
      return [k];
    }
    function hl(k) {
      $$('.hl', root).forEach((e) => e.classList.remove('hl'));
      expand(k).forEach((x) => (byKey[x] || []).forEach((e) => e.classList.add('hl')));
    }
    const keyOf = (e) => { const el = e.target.closest && e.target.closest('[data-k]'); return el && root.contains(el) ? el.dataset.k : ''; };
    root.addEventListener('pointerover', (e) => { if (e.pointerType === 'mouse') hl(keyOf(e) || S.sticky); });
    root.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hl(S.sticky); });
    root.addEventListener('click', (e) => { if (e.target.closest('button,textarea')) return; const k = keyOf(e); S.sticky = S.sticky === k ? '' : k; hl(S.sticky); });
    root.addEventListener('focusin', (e) => { if (e.target.classList.contains('md-line')) hl(e.target.dataset.k); });
    root.addEventListener('focusout', () => hl(S.sticky));
    linesEl.addEventListener('keydown', (e) => {
      const ls = lines.filter((l) => l.dataset.k);
      const at = ls.indexOf(doc.activeElement); if (at < 0) return;
      let nx = at;
      if (e.key === 'ArrowDown') nx = Math.min(ls.length - 1, at + 1); else if (e.key === 'ArrowUp') nx = Math.max(0, at - 1);
      else if (e.key === 'Home') nx = 0; else if (e.key === 'End') nx = ls.length - 1; else return;
      e.preventDefault(); ls[at].tabIndex = -1; ls[nx].tabIndex = 0; ls[nx].focus();
    });

    /* typing: one clock, lines type in at their start times, each landed line shows its card, row or relation */
    function setLine(i, c) { const l = lines[i]; if (l && l._c !== c) { l._c = c; l.style.setProperty('--c', c); } }
    function land(i) {
      const k = S.model.keys[i] || '';
      if (k[0] === 't' || k[0] === 'c') (byKey[k] || []).forEach((e) => e.classList.remove('pre'));
      if (k[0] === 'r') { const n = +k.slice(2); S.drawn.add(n); (byKey[k] || []).forEach((g) => { if (g.tagName !== 'g') return; const p = $('path.md-ln', g); if (p) p.style.strokeDashoffset = 0; $$('text', g).forEach((t) => t.classList.remove('off')); }); }
    }
    function follow(i) {
      const l = lines[i]; if (!l) return;
      const top = l.offsetTop, h = code.clientHeight;
      if (top < code.scrollTop + 8 || top + l.offsetHeight > code.scrollTop + h - 24) code.scrollTop = Math.max(0, top - h * 0.45);
    }
    function reset() {
      stopType();
      S.t = 0; S.done.clear(); S.drawn.clear(); again.hidden = true; S.played = false;
      S.model = parse(S.text); buildLines(); buildCards(true);
      lines.forEach((l, i) => setLine(i, 0));
      code.scrollTop = 0;
    }
    function complete() {
      stopType();
      S.model = S.model || parse(S.text);
      const L = S.text.split('\n'); lines.forEach((l, i) => { setLine(i, (L[i] || '').length); l.classList.remove('typing'); });
      S.model.keys.forEach((k, i) => land(i));
      $$('.pre', root).forEach((e) => e.classList.remove('pre'));
      S.done = new Set(S.model.keys.map((k, i) => i));
      again.hidden = S.mode !== 'type';
      layout();
    }
    function startType() { if (S.mode !== 'type') return; reset(); S.playing = true; S.played = true; S.last = 0; kick(); }
    function stopType() { S.playing = false; if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } lines.forEach((l) => l.classList.remove('typing')); }
    function kick() { if (!S.raf && S.playing) S.raf = requestAnimationFrame(frame); }
    function frame(now) {
      S.raf = 0;
      if (!S.playing) return;
      const dt = S.last ? Math.min(0.05, (now - S.last) / 1000) : 0; S.last = now;
      if (!(S.visible || S.forced)) { S.last = 0; return; }
      S.t += dt;
      const L = S.text.split('\n');
      let typing = -1;
      L.forEach((t, i) => {
        const c = Math.max(0, Math.min(t.length, Math.floor((S.t - starts[i]) * CPS)));
        setLine(i, c);
        const on = S.t >= starts[i] && c < t.length && t.length > 0;
        lines[i].classList.toggle('typing', on); if (on) typing = i;
        if (S.t >= starts[i] + t.length / CPS && !S.done.has(i)) { S.done.add(i); land(i); }
      });
      if (typing >= 0) follow(typing);
      if (S.t >= END) { S.playing = false; again.hidden = false; layout(); return; }
      kick();
    }
    again.addEventListener('click', () => { startType(); });

    /* edit mode: the same text in an editor; every change re-parses and redraws */
    function paintEditor() {
      const L = ta.value.split('\n'), keys = S.model ? S.model.keys : [];
      pre.innerHTML = L.map((t, i) => '<span class="l"' + (keys[i] ? ' data-k="' + esc(keys[i]) + '"' : '') + '>' + (paintLine(t) || ' ') + '</span>').join('\n') + '\n';
      gut.innerHTML = L.map((_, i) => '<span>' + (i + 1) + '</span>').join('');
      ta.style.height = 'auto';
      const box2 = ta.parentNode; box2.style.minWidth = '';
    }
    let deb = 0;
    function onInput() {
      S.text = ta.value;
      if (deb) return;
      deb = requestAnimationFrame(() => { deb = 0; redraw(); });
    }
    function redraw() { S.model = parse(S.text); S.drawn = new Set(S.model.refs.map((r, i) => i)); paintEditor(); buildCards(false); index(); }
    ta.addEventListener('input', onInput);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        // two spaces, as DBML is indented; Escape then Tab leaves the editor
        if (ta._esc) { ta._esc = false; return; }
        e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); onInput();
      } else ta._esc = e.key === 'Escape';
    });

    function setMode(m, focus) {
      if (m === S.mode) return;
      S.mode = m; root.dataset.mode = m;
      stopType();
      if (m === 'edit') {
        linesEl.hidden = true; ed.hidden = false; again.hidden = true;
        ta.value = S.text; redraw();
        if (focus) ta.focus({ preventScroll: true });
      } else {
        ed.hidden = true; linesEl.hidden = false;
        S.model = parse(S.text); buildLines(); buildCards(false); complete();
      }
      host.dispatchEvent(new CustomEvent('md:mode', { detail: { mode: m } }));
    }

    /* first look: type when a third of it is in view (phones play it through the playback bar instead) */
    S.model = parse(S.text);
    buildLines(); buildCards(true);
    if (still()) complete(); else reset();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((es) => es.forEach((e) => {
        S.visible = e.isIntersecting;
        if (S.visible && !S.played && !still() && !autoPlay() && S.mode === 'type') startType();
        kick();
      }), { threshold: 0.3 }).observe(root);
    } else complete();
    let w0 = 0;
    if ('ResizeObserver' in window) new ResizeObserver(() => {
      const w = dia.clientWidth; if (w === w0) return; w0 = w;
      const cols = w >= 640 ? 3 : 2;
      if (cols !== S.cols) {
        buildCards(false);
        if (S.mode === 'type' && S.playing) { const landed = new Set([...S.done].map((i) => S.model.keys[i])); $$('.md-card, .md-row', grid).forEach((e) => { if (!landed.has(e.dataset.k)) e.classList.add('pre'); }); }
      }
      layout();
    }).observe(dia);
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(() => layout());

    return {
      root, ta, START,
      get mode() { return S.mode; }, get playing() { return S.playing; }, get text() { return S.text; }, get model() { return S.model; },
      setMode, hl: (k) => { S.sticky = k; hl(k); }, reset, complete,
      type() { S.forced = true; startType(); },
      lineOf(k) { return S.model.keys.indexOf(k); },
      showLine(k) { const i = S.model.keys.indexOf(k); if (i >= 0 && S.mode === 'type') follow(i); },
      setText(t) { S.text = t; if (S.mode === 'edit') { ta.value = t; redraw(); } else { S.model = parse(t); buildLines(); buildCards(false); complete(); } },
      insert(at, str) { ta.setRangeText(str, at, at, 'end'); onInput(); },
      refKey(from) { const i = S.model.refs.findIndex((r) => r.from.join('.') === from); return 'r:' + i; },
    };
  }

  function mountDbml() {
    const host = $('[data-md-dbml]'); if (!host || !K) return;
    const api = createDbml(host);
    const seg = $('#seg-dbml'), fig = host.closest('figure');
    const paint = () => $$('button[data-mode]', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === api.mode)));
    seg.addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) { api.setMode(b.dataset.mode, true); paint(); } });
    host.addEventListener('md:mode', paint);
    paint();
    play(fig, [
      { caption: 'The DBML types itself in. Each table card appears as its block lands, and each Ref draws its line.', ms: 1400, run: async (c) => {
        api.setMode('type'); api.hl('');
        if (c.reduce) { api.complete(); return; }
        api.type(); await c.wait(400); await until(c, () => !api.playing, 40000);
      } },
      { caption: 'Point at the Ref for invoices.customer_id: the line, both columns and the relation light up.', ms: 2600, run: async () => { const k = api.refKey('invoices.customer_id'); api.showLine(k); api.hl(k); } },
      { caption: 'Point at payments.invoice_id: its Foreign Key leads back to invoices.', ms: 2400, run: async () => { api.hl('c:payments.invoice_id'); } },
      { caption: 'Switch to Edit it. The same text is now an editor, and the diagram follows every change.', ms: 1600, run: async () => { api.hl(''); api.setMode('edit'); } },
      { caption: 'Add a column to payments, refunded_at timestamptz. The card redraws as each letter lands.', ms: 2600, run: async (c) => {
        const t = api.ta.value, a = t.indexOf('Table payments {'), end = t.indexOf('\n}', a);
        if (a < 0 || end < 0) return;
        const add = '\n  refunded_at timestamptz';
        api.ta.scrollIntoView && api.ta.closest('.md-db-code').scrollTo({ top: Math.max(0, (t.slice(0, end).split('\n').length - 6) * 20) });
        if (c.reduce) { api.insert(end, add); } else { for (let i = 0; i < add.length; i++) { api.insert(end + i, add[i]); await c.wait(i < 3 ? 120 : 55); } }
        api.hl('c:payments.refunded_at');
      } },
    ], { reset: async () => { api.setMode('type'); api.setText(api.START); api.hl(''); api.reset(); }, done: 'That is the whole run. Press Edit it and change the text yourself.' });
  }

  /* ================================================================== */
  /*                       2. SCHEMA COMPARE WINDOW                       */
  /* ================================================================== */
  const CHANGES = [
    { id: 'fax', grp: 'Drop', mark: 'r', table: 'customers', name: 'fax', what: 'varchar(32)', loss: 12,
      sql: 'ALTER TABLE billing.customers DROP COLUMN fax;', label: 'DROP COLUMN customers.fax' },
    { id: 'total', grp: 'Change', mark: 'c', table: 'invoices', name: 'total', what: 'numeric(10,2) to numeric(12,2)',
      sql: 'ALTER TABLE billing.invoices ALTER COLUMN total TYPE numeric(12,2);', label: 'invoices.total to numeric(12,2)' },
    { id: 'col', grp: 'Create', mark: 'a', table: 'payments', name: 'refunded_at', what: 'timestamptz',
      sql: 'ALTER TABLE billing.payments ADD COLUMN refunded_at timestamptz;', label: 'ADD COLUMN payments.refunded_at' },
    { id: 'idx', grp: 'Create', mark: 'a', table: 'payments', name: 'payments_refunded_at_idx', what: 'index', needs: ['col'],
      sql: 'CREATE INDEX payments_refunded_at_idx\n  ON billing.payments (refunded_at);', label: 'INDEX payments_refunded_at_idx' },
    { id: 'tbl', grp: 'Create', mark: 'a', table: 'refunds', name: 'refunds', what: 'table',
      sql: 'CREATE TABLE billing.refunds (\n  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n  payment_id bigint NOT NULL,\n  amount numeric(12,2) NOT NULL,\n  created_at timestamptz NOT NULL DEFAULT now()\n);', label: 'CREATE TABLE refunds' },
    { id: 'fk', grp: 'Create', mark: 'a', table: 'refunds', name: 'refunds_payment_fk', what: 'foreign key', needs: ['tbl'],
      sql: 'ALTER TABLE billing.refunds ADD CONSTRAINT refunds_payment_fk\n  FOREIGN KEY (payment_id) REFERENCES billing.payments (id);', label: 'FOREIGN KEY refunds_payment_fk' },
  ];
  const byId = (id) => CHANGES.find((c) => c.id === id);
  const MARKW = { a: ['+', 'added', 'in freight-dev only'], r: ['-', 'removed', 'in the target only'], c: ['~', 'changed', 'differs'] };
  const SQLKW = /\b(ALTER|TABLE|DROP|COLUMN|ADD|TYPE|CREATE|INDEX|ON|CONSTRAINT|FOREIGN|KEY|REFERENCES|PRIMARY|NOT|NULL|DEFAULT|GENERATED|BY|AS|IDENTITY)\b/g;
  const hlSql = (s) => esc(s).replace(/\b(bigint|integer|numeric\(\d+,\d+\)|timestamptz|varchar\(\d+\)|text)\b/g, '\u0001$1\u0002').replace(SQLKW, '<span class="x-k">$1</span>').replace(/\u0001([^\u0002]*)\u0002/g, '<span class="x-t">$1</span>').replace(/\bnow\(\)/g, '<span class="x-f">now</span>()');

  const CMP_CSS = `
[hidden]{display:none!important}
.cw{display:flex;flex-direction:column;border-radius:10px;overflow:hidden;border:1px solid var(--border);box-shadow:var(--sh2);position:relative}
.cw .tab.cur{box-shadow:inset 0 -2px 0 var(--grp)}
.cw .tab .chip,.cw .chip.prod{background:var(--prod-sub);color:var(--prod-t);font-weight:600;font-size:11px;height:18px;letter-spacing:.04em}
.isl{margin:0 6px;flex:1;min-height:0;background:var(--surface);border:1px solid var(--bsub);border-radius:8px;display:flex;flex-direction:column;overflow:hidden}
.isl.prod{box-shadow:inset 0 2px 0 var(--prod)}
.ch{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:8px 10px;border-bottom:1px solid var(--bsub);min-width:0}
.ch .lab{font-size:12px;color:var(--subtle)}
.cbx{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);white-space:nowrap;min-width:0}
.cbx b{font-weight:600}
.cbx .sch{color:var(--subtle)}
.ch .arr{color:var(--subtle)}
.ch .sp{flex:1}
.again{height:26px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text)}
.cm{flex:1;min-height:0;display:grid;grid-template-columns:minmax(260px,34%) minmax(0,1fr)}
.S .cm{grid-template-columns:minmax(0,1fr)}
.tr{border-right:1px solid var(--bsub);background:var(--panel);display:flex;flex-direction:column;min-width:0;min-height:0}
.S .tr{border-right:0;border-bottom:1px solid var(--bsub)}
.ph{height:34px;flex-shrink:0;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--bsub);font-weight:600;white-space:nowrap;min-width:0}
.ph .n{font-weight:400;color:var(--subtle);font-size:12px;overflow:hidden;text-overflow:ellipsis}
.tl{flex:1;overflow:auto;padding:6px 4px;scrollbar-width:thin}
.tg{display:flex;align-items:center;gap:6px;height:26px;padding:0 8px;color:var(--muted);font-size:12px;white-space:nowrap}
.tg .ui{color:var(--subtle)}
.ti{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-height:28px;padding:3px 8px 3px var(--in,22px);border-radius:4px;cursor:pointer;white-space:nowrap;min-width:0}
.ti:hover{background:var(--hover)}
.ti:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.ti.sel{background:var(--active)}
.ti .nm{font-family:"JetBrains Mono",Consolas,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ti .ty2{font-size:11.5px;color:var(--type);font-style:italic;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ti .out{margin-left:auto;font-size:11px;color:var(--subtle);flex-shrink:0}
.ti.off .nm{color:var(--subtle)}
.ti.done .out{color:var(--ok)}
.dm{width:16px;height:16px;border-radius:3px;display:inline-grid;place-items:center;font:700 12px/1 "JetBrains Mono",Consolas,monospace;flex-shrink:0}
.dm.a{background:var(--ok-sub);color:var(--ok)}
.dm.r{background:var(--bad-sub);color:var(--bad)}
.dm.c{background:var(--warn-sub);color:var(--warn-t)}
.lossc{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 5px;border-radius:4px;background:var(--bad-sub);color:var(--bad);font-size:11px;font-weight:600;flex-shrink:0}
.legend{padding:8px 10px;border-top:1px solid var(--bsub);font-size:11.5px;color:var(--subtle);display:flex;flex-wrap:wrap;gap:4px 12px}
.legend span{display:inline-flex;align-items:center;gap:5px}
.sy{display:flex;flex-direction:column;min-width:0;min-height:0}
.sy.prodwash{background:color-mix(in srgb,var(--prod) 5%,var(--surface))}
.sl{flex:1;overflow:auto;padding:4px 0 10px;scrollbar-width:thin}
.gh{padding:10px 12px 4px;font-size:12px;font-weight:600;color:var(--muted)}
.stm{display:grid;grid-template-columns:22px minmax(0,1fr);gap:0 6px;align-items:start;padding:5px 12px 6px 10px;border-left:2px solid transparent;cursor:pointer}
.stm:hover{background:var(--hover)}
.stm.sel{border-left-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
.stm .cb{margin-top:3px}
.stm pre{margin:0;font:12px/18px "JetBrains Mono","Cascadia Mono",Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}
.stm.off pre{color:var(--subtle);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--subtle) 60%,transparent)}
.stm.off pre span{color:inherit}
.stm .why{grid-column:2;font-size:11.5px;line-height:16px;color:var(--subtle);margin-top:2px}
.stm .why.bad{color:var(--bad)}
.x-k{color:var(--kw)}.x-t{color:var(--type);font-style:italic}.x-f{color:var(--fn)}
.ban{display:flex;align-items:flex-start;gap:8px;margin:6px 12px 2px 38px;padding:7px 10px;border-radius:6px;font-size:12px;line-height:17px}
.ban svg{flex-shrink:0;margin-top:1px}
.ban p{margin:0;flex:1;min-width:0}
.ban.warn{background:var(--warn-sub);color:var(--text)}
.ban.warn svg{color:var(--warn-t)}
.ban.bad{background:var(--bad-sub);color:var(--text)}
.ban.bad svg{color:var(--bad)}
.ban.ok{background:var(--ok-sub);color:var(--text);margin:8px 12px}
.ban.ok svg{color:var(--ok)}
.mono{font-family:"JetBrains Mono",Consolas,monospace;font-size:11.5px}
.cf{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;padding:8px 10px;border-top:1px solid var(--bsub);min-width:0}
.cf .hint{flex:1 1 220px;min-width:0;font-size:12px;color:var(--subtle)}
.b-sec,.b-pri,.b-prod,.b-danger{height:28px;padding:0 12px;display:inline-flex;align-items:center;gap:6px;border-radius:4px;white-space:nowrap;font-weight:600}
.b-sec{font-weight:400;background:var(--surface);border:1px solid var(--border);color:var(--text)}
.b-prod{background:var(--prod);color:#16181a}
.b-danger{background:var(--bad);color:#fff}
.t-dark .b-danger{color:#16181a}
.btn[aria-disabled="true"]{opacity:.5;cursor:default}
.kbd2{font-family:"JetBrains Mono",Consolas,monospace;font-size:11px;font-weight:400;opacity:.8}
.fine .coarse-only{display:none}
.coarse .ti{min-height:40px}
.coarse .stm{padding-top:10px;padding-bottom:10px}
.coarse .b-sec,.coarse .b-pri,.coarse .b-prod,.coarse .b-danger,.coarse .again{height:40px}
.coarse .cb{width:20px;height:20px}
.scr{position:absolute;inset:0;background:var(--scrim);z-index:20;display:grid;place-items:center;padding:16px}
.scr[hidden]{display:none}
.dlg{width:min(620px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--raised);border:1px solid var(--border);border-radius:8px;box-shadow:var(--sh2);overflow:hidden;animation:dlgin .16s cubic-bezier(.2,0,0,1)}
@keyframes dlgin{from{opacity:0;transform:translateY(6px) scale(.98)}}
.dlg .dh{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--bsub);min-width:0;flex-wrap:wrap}
.dlg .dh b{font-size:14px;font-weight:600;min-width:0}
.dlg .bd{padding:12px;display:flex;flex-direction:column;gap:10px;overflow:auto;min-height:0}
.dlg .bd p{margin:0}
.dlg .ban{margin:0}
.dlg .dbd{border:1px solid var(--bsub);border-radius:6px;background:var(--surface);overflow:auto;max-height:260px;font:12px/18px "JetBrains Mono","Cascadia Mono",Consolas,monospace;padding:6px 0}
.dlg .dbd:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--accent)}
.dlg .sq{display:grid;grid-template-columns:34px minmax(0,1fr);background:color-mix(in srgb,var(--prod) 8%,transparent)}
.dlg .sq .no{color:var(--faint);text-align:right;padding-right:10px;user-select:none}
.dlg .sq code{white-space:pre-wrap;overflow-wrap:anywhere;padding-right:10px;font:inherit}
.dlg .tag{display:inline-block;margin-left:8px;padding:0 6px;border-radius:4px;font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;font-size:11px;font-weight:600;line-height:16px;background:var(--prod-sub);color:var(--prod-t);vertical-align:top}
.dlg .tag.d{background:var(--bad-sub);color:var(--bad)}
.dlg .hint{font-size:12px;color:var(--subtle)}
.dlg .df{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding:10px 12px;border-top:1px solid var(--bsub)}
.x{all:unset;box-sizing:border-box;width:28px;height:28px;display:grid;place-items:center;border-radius:4px;color:var(--muted);cursor:pointer;margin-left:auto}
.x:hover{background:var(--hover)}
.x:focus-visible{outline:2px solid var(--accent)}
.S .tl{max-height:none;overflow:visible}
.S .sl{overflow:visible}
.S .ch .cbx{max-width:100%}
.S .legend{display:none}
.S .scr{align-items:end;padding:8px}
.S .dlg .dbd{max-height:220px}
@media (prefers-reduced-motion: reduce){.dlg{animation:none}}
`;
  const WARN = '<svg class="ui" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 3 19.5h18z"/><path d="M12 10v4.5M12 17v.2"/></svg>';
  const OKI = '<svg class="ui" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function createCompare(host) {
    const { APP_CSS, PG_CSS, DEFS, ic, MARK, bus } = K;
    const sr = host.attachShadow({ mode: 'open' });
    const coarse = matchMedia('(pointer: coarse)');
    sr.innerHTML = '<style>' + APP_CSS + PG_CSS + CMP_CSS + '</style>' +
      '<div class="win cw t-' + bus.theme + ' L ' + (coarse.matches ? 'coarse' : 'fine') + '">' + DEFS +
      '<header class="tbar"><div class="mk">' + MARK + '</div>' +
      '<div class="hm">' + ic('i-home', 18, 'ic f-none') + '<span>Home</span></div>' +
      '<div style="width:1px;height:18px;background:var(--border);margin:0 6px;flex-shrink:0"></div>' +
      '<div class="gs"><span class="gsq">F</span><span style="font-weight:600">Freight</span></div>' +
      '<nav class="tabs" aria-label="Tabs"><div class="tab cur" aria-current="page">' + ic('i-compare', 16, 'ic f-obj') + '<span data-tabname></span><span class="chip" data-tabprod hidden>PROD</span>' + ic('u-x', 14, 'ui', 'color:var(--subtle)') + '</div></nav>' +
      '<span class="wbtn wb">' + ic('u-min', 14) + '</span><span class="wbtn wb">' + ic('u-max', 13) + '</span><span class="wbtn wb">' + ic('u-x', 14) + '</span></header>' +
      '<section class="isl" aria-label="Schema Compare">' +
      '<div class="ch"><span class="lab">Source</span><span class="cbx">' + ic('u-db', 14, 'ui', 'color:var(--pg)') + '<b>freight-dev</b><span class="sch">billing</span></span>' +
      '<span class="arr" aria-hidden="true">' + ic('u-right', 14) + '</span>' +
      '<span class="lab">Target</span><span class="cbx" data-tgt></span><span class="sp"></span>' +
      '<button class="btn again" type="button" data-again>' + ic('u-tidy', 14) + 'Compare again<span class="kbd2">F5</span></button></div>' +
      '<div class="cm">' +
      '<div class="tr"><div class="ph">Differences<span class="n" data-dn></span></div><div class="tl" role="tree" aria-label="Differences" data-tree></div>' +
      '<div class="legend"><span><i class="dm a">+</i>in freight-dev only</span><span><i class="dm r">-</i>in the target only</span><span><i class="dm c">~</i>differs</span></div></div>' +
      '<div class="sy" data-sy><div class="ph">Sync Script<span class="n" data-sn></span></div><div data-result></div><div class="sl" data-list></div></div>' +
      '</div>' +
      '<div class="cf"><span class="hint" data-hint></span><button class="btn b-sec" type="button" data-copy>' + ic('u-copy', 14) + 'Copy script</button><button class="btn" type="button" data-apply></button></div>' +
      '</section>' +
      '<footer class="sbar"><span class="sp" data-sbconn style="display:inline-flex;align-items:center;gap:6px"></span><span class="sp" data-sbmid></span><span class="sp tnum" style="margin-left:auto" data-sbr></span></footer>' +
      '<div class="scr" hidden data-scr></div>' +
      '<div class="vh" role="status" aria-live="polite" data-live></div></div>';
    const $s = (s) => sr.querySelector(s), $$s = (s) => [...sr.querySelectorAll(s)];
    const win = $s('.win');
    const S = { on: {}, prod: false, sel: 'fax', applied: null, busy: false, dialog: false };
    const say = (t) => { const l = $s('[data-live]'); l.textContent = ''; setTimeout(() => { l.textContent = t; }, 30); };
    const tname = () => (S.prod ? 'freight-prod' : 'freight-stg');
    const ticked = () => CHANGES.filter((c) => S.on[c.id]);
    const dependants = (id) => { const out = []; const walk = (x) => CHANGES.forEach((c) => { if ((c.needs || []).includes(x) && !out.includes(c.id)) { out.push(c.id); walk(c.id); } }); walk(id); return out; };
    const needsOf = (id) => { const out = []; const walk = (x) => (byId(x).needs || []).forEach((n) => { if (!out.includes(n)) { out.push(n); walk(n); } }); walk(id); return out; };
    function fresh() { CHANGES.forEach((c) => { S.on[c.id] = !c.loss; }); S.applied = null; }

    function tree() {
      const item = (c, lvl) => '<button type="button" role="treeitem" class="ti' + (S.on[c.id] ? '' : ' off') + (S.sel === c.id ? ' sel' : '') + (S.applied && S.applied.includes(c.id) ? ' done' : '') + '" style="--in:' + (8 + lvl * 16) + 'px" data-sel="' + c.id + '" aria-selected="' + (S.sel === c.id) + '" aria-label="' + esc(MARKW[c.mark][1] + ': ' + c.label + (S.on[c.id] ? ', in the script' : ', left out of the script')) + '">' +
        '<i class="dm ' + c.mark + '" aria-hidden="true">' + MARKW[c.mark][0] + '</i>' + ic(c.what === 'table' ? 'i-table' : c.what === 'index' || c.what === 'foreign key' ? 'u-key' : 'u-db', 14, 'ui', 'color:var(--subtle)') +
        '<span class="nm">' + esc(c.name) + '</span><span class="ty2">' + esc(c.what) + '</span>' + (c.loss ? '<span class="lossc">data loss</span>' : '') +
        '<span class="out">' + (S.applied && S.applied.includes(c.id) ? 'applied' : S.on[c.id] ? '' : 'left out') + '</span></button>';
      const tab = (name, mark, kids) => '<div class="tg" style="padding-left:24px">' + ic('u-chev', 14) + '<i class="dm ' + mark + '" aria-hidden="true">' + MARKW[mark][0] + '</i>' + ic('i-table', 14, 'ic f-obj') + '<span class="mono" style="font-size:12px;color:var(--text)">' + name + '</span></div>' + kids;
      const of = (t) => CHANGES.filter((c) => c.table === t);
      return '<div class="tg">' + ic('u-chev', 14) + '<span>billing</span><span style="margin-left:auto">' + CHANGES.length + '</span></div>' +
        tab('customers', 'c', of('customers').map((c) => item(c, 2)).join('')) +
        tab('invoices', 'c', of('invoices').map((c) => item(c, 2)).join('')) +
        tab('payments', 'c', of('payments').map((c) => item(c, 2)).join('')) +
        item(byId('tbl'), 1) + item(byId('fk'), 2);
    }
    function list() {
      let h = '', g = '';
      CHANGES.forEach((c) => {
        if (c.grp !== g) { g = c.grp; h += '<div class="gh">' + (['Drop', 'Change', 'Create'].indexOf(g) + 1) + '. ' + g + '</div>'; }
        const need = (c.needs || []).map((n) => byId(n).label);
        const deps = dependants(c.id).map((n) => byId(n).label);
        let why = '';
        if (c.loss) why = '<span class="why bad">Drops the values in ' + c.loss + ' rows of customers</span>';
        else if (need.length) why = '<span class="why">Needs ' + esc(need.join(', ')) + '</span>';
        else if (deps.length) why = '<span class="why">Needed by ' + esc(deps.join(', ')) + '</span>';
        h += '<label class="stm' + (S.on[c.id] ? '' : ' off') + (S.sel === c.id ? ' sel' : '') + '" data-st="' + c.id + '"><input type="checkbox" class="cb" data-tick="' + c.id + '"' + (S.on[c.id] ? ' checked' : '') + ' aria-label="Include ' + esc(c.label) + '"><pre>' + hlSql(c.sql) + '</pre>' + why + '</label>';
        if (c.loss) h += S.on[c.id]
          ? '<div class="ban bad">' + WARN + '<p>Ticked. Apply drops <span class="mono">customers.fax</span> on ' + tname() + ' and its values in ' + c.loss + ' rows go with it. A backup is the only way back.</p></div>'
          : '<div class="ban warn">' + WARN + '<p>Dropping <span class="mono">fax</span> removes its values in ' + c.loss + ' rows on ' + tname() + '. Data-loss items start unticked; tick it only if you mean it.</p></div>';
      });
      return h;
    }
    function paint() {
      const n = ticked().length;
      $s('[data-tabname]').textContent = 'freight-dev to ' + tname();
      $s('[data-tabprod]').hidden = !S.prod;
      $s('[data-tgt]').innerHTML = ic('u-db', 14, 'ui', 'color:var(--pg)') + '<b>' + tname() + '</b>' + (S.prod ? '<span class="chip prod">PROD</span>' : '') + '<span class="sch">billing</span>';
      $s('.isl').classList.toggle('prod', S.prod);
      $s('[data-sy]').classList.toggle('prodwash', S.prod);
      const tl = $s('[data-tree]'), sl = $s('[data-list]'), tsc = tl.scrollTop, ssc = sl.scrollTop;
      tl.innerHTML = tree(); sl.innerHTML = list(); tl.scrollTop = tsc; sl.scrollTop = ssc;
      $s('[data-dn]').textContent = CHANGES.length + ' differences';
      $s('[data-sn]').textContent = n + ' of ' + CHANGES.length + ' statements, PostgreSQL';
      $s('[data-hint]').textContent = S.applied ? 'Applied. Compare again to read the two databases afresh.' : n + ' of ' + CHANGES.length + ' changes ticked. Changes ' + tname() + ' to match freight-dev' + (S.prod ? ', on Production.' : '.');
      const ap = $s('[data-apply]');
      ap.className = 'btn ' + (S.prod ? 'b-prod' : 'b-pri');
      ap.innerHTML = ic('u-play', 14) + (S.busy ? 'Applying...' : S.prod ? 'Apply on PROD...' : 'Apply') + '<span class="kbd2">Ctrl+Enter</span>';
      const off = !n || S.busy || !!S.applied;
      ap.setAttribute('aria-disabled', String(off));
      ap.title = !n ? 'Tick at least one change' : S.applied ? 'Already applied. Compare again first.' : '';
      $s('[data-sbconn]').innerHTML = ic('u-db', 13, 'ui', 'color:var(--pg)') + tname() + (S.prod ? ' <b style="color:var(--prod-t);font-weight:600">PROD</b>' : '');
      $s('[data-sbmid]').textContent = CHANGES.length + ' differences';
      $s('[data-sbr]').textContent = n + ' statements ticked';
      const r = $s('[data-result]');
      r.innerHTML = S.applied ? '<div class="ban ok">' + OKI + '<p>Applied ' + S.applied.length + (S.applied.length === 1 ? ' statement' : ' statements') + ' on ' + tname() + ' in one transaction. On this page the run is scripted; nothing left the browser.</p></div>' : '';
    }
    function setTick(id, on, quiet) {
      if (S.applied || S.busy) return;
      const set = on ? [id].concat(needsOf(id)) : [id].concat(dependants(id));
      const changed = set.filter((x) => S.on[x] !== on);
      set.forEach((x) => { S.on[x] = on; });
      S.sel = id;
      paint();
      if (!quiet) {
        const others = changed.filter((x) => x !== id).map((x) => byId(x).label);
        say((on ? 'Ticked ' : 'Unticked ') + byId(id).label + (others.length ? (on ? ', and ' : ', and what needs it: ') + others.join(', ') : '') + '.');
      }
      return changed;
    }
    function select(id) {
      S.sel = id; paint();
      const row = $s('[data-st="' + id + '"]'), sl = $s('[data-list]');
      if (row && sl.scrollHeight > sl.clientHeight) sl.scrollTop = Math.max(0, row.offsetTop - sl.offsetTop - 30);
    }
    function setTarget(p) {
      if (S.dialog) return;
      S.prod = p === 'prod' || p === true;
      if (S.applied) fresh();
      paint();
      host.dispatchEvent(new CustomEvent('md:target', { detail: { prod: S.prod } }));
      say('Target ' + tname() + (S.prod ? ', a Production Connection. Apply asks first.' : '.'));
    }
    function run() {
      const n = ticked().length;
      S.busy = true; paint();
      setTimeout(() => { S.busy = false; S.applied = ticked().map((c) => c.id); paint(); say('Applied ' + n + ' statements on ' + tname() + ' in one transaction.'); }, still() ? 0 : 700);
    }
    function apply() {
      if (!ticked().length || S.busy || S.applied || S.dialog) return;
      if (S.prod) openDialog(); else run();
    }
    /* Production: one in-window confirm with the exact statements */
    function dialogHtml() {
      const list = ticked(), loss = list.filter((c) => c.loss);
      let ln = 0;
      const sql = list.map((c) => c.sql.split('\n').map((t, i) => { ln++; return '<div class="sq"><span class="no">' + ln + '</span><code>' + hlSql(t) + (i === 0 ? '<span class="tag' + (c.loss ? ' d' : '') + '">' + (c.loss ? 'drops data' : 'writes') + '</span>' : '') + '</code></div>'; }).join('')).join('');
      return '<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="cm-dt">' +
        '<div class="dh">' + ic('i-compare', 18, 'ic f-obj') + '<b id="cm-dt">Apply Sync Script on freight-prod</b><span class="chip prod">PROD</span><span style="color:var(--subtle);font-size:12px">billing</span><button class="x" type="button" data-dx aria-label="Cancel">' + ic('u-x', 14) + '</button></div>' +
        '<div class="bd">' +
        (loss.length ? '<div class="ban bad">' + WARN + '<p><b>1 statement drops data.</b> <span class="mono">DROP COLUMN fax</span> removes its values in ' + loss[0].loss + ' rows.</p><button class="btn b-sec" type="button" data-untick>Untick it</button></div>' : '') +
        '<p>' + list.length + ' of ' + list.length + ' statements write. They run in one transaction: if one fails, nothing changes.</p>' +
        '<div class="dbd" tabindex="0" aria-label="The statements that will run">' + sql + '</div>' +
        '<p class="hint">Enter runs only when Apply on freight-prod has focus. Press Tab to reach it, or click it.</p></div>' +
        '<div class="df"><button class="btn b-sec" type="button" data-dno>Cancel<span class="kbd2">Esc</span></button><button class="btn ' + (loss.length ? 'b-danger' : 'b-prod') + '" type="button" data-dyes>Apply on freight-prod</button></div></div>';
    }
    function openDialog() {
      S.dialog = true;
      const scr = $s('[data-scr]'); scr.innerHTML = dialogHtml(); scr.hidden = false;
      $s('.isl').inert = true;
      const loss = ticked().some((c) => c.loss);
      say('Apply Sync Script on freight-prod. ' + ticked().length + ' statements write' + (loss ? '; one drops data.' : '.'));
      const d = $s('.dbd'); if (d) d.focus({ preventScroll: true });
      const dl = $s('.dlg'), r = dl && dl.getBoundingClientRect();
      // bring the dialog into view by scrolling the page only (scrollIntoView would also scroll the clipped window)
      if (r && (r.top < 110 || r.bottom > innerHeight - 40)) {
        const to = r.height > innerHeight - 150 ? r.top - 110 : r.top - (innerHeight - r.height) / 2;
        scrollBy({ top: to, behavior: still() ? 'auto' : 'smooth' });
      }
    }
    function closeDialog(yes) {
      if (!S.dialog) return;
      S.dialog = false;
      const scr = $s('[data-scr]'); scr.hidden = true; scr.innerHTML = '';
      $s('.isl').inert = false;
      if (yes) run(); else say('Cancelled. Nothing ran on freight-prod.');
      const ap = $s('[data-apply]'); if (ap && host.matches(':focus-within')) ap.focus({ preventScroll: true });
    }
    function untickInDialog() { setTick('fax', false, true); $s('[data-scr]').innerHTML = dialogHtml(); say('Unticked the drop of customers.fax.'); const y = $s('[data-dyes]'); if (y) y.focus({ preventScroll: true }); }
    function reset() { closeDialog(false); fresh(); S.busy = false; S.sel = 'fax'; paint(); }

    sr.addEventListener('click', (e) => {
      const t = e.target;
      const tk = t.closest('[data-tick]');
      if (tk) { e.preventDefault(); setTick(tk.dataset.tick, !S.on[tk.dataset.tick]); const nb = $s('[data-tick="' + tk.dataset.tick + '"]'); if (nb) nb.focus({ preventScroll: true }); return; }
      const stm = t.closest('[data-st]');
      if (stm) { e.preventDefault(); setTick(stm.dataset.st, !S.on[stm.dataset.st]); const nb = $s('[data-tick="' + stm.dataset.st + '"]'); if (nb) nb.focus({ preventScroll: true }); return; }
      const si = t.closest('[data-sel]'); if (si) { select(si.dataset.sel); const nb = $s('[data-sel="' + si.dataset.sel + '"]'); if (nb) nb.focus({ preventScroll: true }); return; }
      if (t.closest('[data-apply]')) { if ($s('[data-apply]').getAttribute('aria-disabled') !== 'true') apply(); return; }
      if (t.closest('[data-again]')) { reset(); say('Compared again: ' + CHANGES.length + ' differences.'); return; }
      if (t.closest('[data-copy]')) { const txt = '-- Sync Script: make ' + tname() + '.billing match freight-dev\n' + ticked().map((c) => c.sql).join('\n'); try { navigator.clipboard.writeText(txt).then(() => say('Copied ' + ticked().length + ' statements.'), () => say('Copy is not allowed here.')); } catch (er) { say('Copy is not allowed here.'); } return; }
      if (t.closest('[data-dx]') || t.closest('[data-dno]')) { closeDialog(false); return; }
      if (t.closest('[data-dyes]')) { closeDialog(true); return; }
      if (t.closest('[data-untick]')) { untickInDialog(); return; }
    });
    sr.addEventListener('keydown', (e) => {
      if (S.dialog) {
        if (e.key === 'Escape') { e.preventDefault(); closeDialog(false); return; }
        if (e.key === 'Enter' && !(sr.activeElement && sr.activeElement.matches('button'))) { e.preventDefault(); return; }
        if (e.key === 'Tab') {
          const f = $$s('.dlg button, .dlg [tabindex="0"]'); if (!f.length) return;
          const i = f.indexOf(sr.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); }
      else if (e.key === 'F5') { e.preventDefault(); reset(); }
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sr.activeElement && sr.activeElement.matches('.ti')) {
        e.preventDefault(); const all = $$s('.ti'), i = all.indexOf(sr.activeElement), nx = all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        select(nx.dataset.sel); const nb = $s('[data-sel="' + nx.dataset.sel + '"]'); if (nb) nb.focus({ preventScroll: true });
      }
    });
    function theme(t) { win.classList.toggle('t-dark', t === 'dark'); win.classList.toggle('t-light', t === 'light'); }
    bus.on('theme', theme);
    let mode = 'L';
    function size() { const w = host.clientWidth, m = w >= 1000 ? 'L' : w >= 700 ? 'M' : 'S'; if (m !== mode) { win.classList.remove(mode); mode = m; win.classList.add(m); } }
    if ('ResizeObserver' in window) new ResizeObserver(size).observe(host);
    size();
    coarse.addEventListener && coarse.addEventListener('change', () => { win.classList.toggle('coarse', coarse.matches); win.classList.toggle('fine', !coarse.matches); });
    fresh(); paint();
    return {
      sr, setTick, select, setTarget, apply, reset, untickInDialog,
      confirm: (yes) => closeDialog(yes),
      get dialog() { return S.dialog; }, get prod() { return S.prod; }, get on() { return Object.assign({}, S.on); }, get applied() { return S.applied; }, get busy() { return S.busy; },
    };
  }

  function mountCompare() {
    const host = $('[data-md-compare]'); if (!host || !K) return;
    const api = createCompare(host);
    const seg = $('#seg-cmp'), fig = host.closest('figure');
    const paint = () => $$('button[data-target]', seg).forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.target === 'prod') === api.prod)));
    seg.addEventListener('click', (e) => { const b = e.target.closest('button[data-target]'); if (b) api.setTarget(b.dataset.target); });
    host.addEventListener('md:target', paint);
    paint();
    play(fig, [
      { caption: 'Six differences between freight-dev and freight-stg. Each one is a ticked statement in the Sync Script, except the drop of customers.fax.', ms: 2800, run: async () => { api.select('fax'); } },
      { caption: 'Untick the new column payments.refunded_at. The index that needs it unticks with it.', ms: 2800, run: async () => { api.setTick('col', false); } },
      { caption: 'Tick the index again, and the column it needs ticks with it. Then tick the drop of customers.fax and read the warning: the values in 12 rows go with it.', ms: 3600, run: async (c) => { api.setTick('idx', true); await c.wait(1100); api.setTick('fax', true); } },
      { caption: 'Switch the target to freight-prod, a Production Connection. The window turns to Production and Apply asks first.', ms: 2400, run: async () => { api.setTarget('prod'); } },
      { caption: 'Apply on PROD opens the confirm with every statement. The drop marks its line and turns the button red.', ms: 3200, run: async () => { api.apply(); } },
      { caption: 'Untick the drop from the confirm, then Apply on freight-prod. The five statements run in one transaction.', ms: 2600, run: async (c) => { if (!api.dialog) api.apply(); api.untickInDialog(); await c.wait(1400); api.confirm(true); await c.wait(900); } },
    ], { reset: async () => { api.setTarget('stg'); api.reset(); }, done: 'That is the whole run. Compare again resets the window.' });
  }

  /* ================================================================== */
  /*                3. DIAGRAMS: the gallery, loaded when near             */
  /* ================================================================== */
  function mountDiagrams() {
    const host = $('[data-md-diagrams]'); if (!host) return;
    const fig = host.closest('figure');
    let loading = null;
    function load() {
      if (loading) return loading;
      loading = new Promise((res, rej) => {
        const done = () => { try { const api = window.ConturaDiagrams.mount(host); host.classList.add('is-mounted'); res(api); } catch (e) { rej(e); } };
        if (window.ConturaDiagrams) return done();
        const s = doc.createElement('script');
        s.src = host.dataset.src || 'model-diagrams.js';
        s.onload = done;
        s.onerror = () => { loading = null; host.querySelector('.md-gal-wait').textContent = 'The diagram gallery did not load. Reload the page to try again.'; rej(new Error('model-diagrams.js')); };
        doc.head.appendChild(s);
      });
      return loading;
    }
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load().catch(() => {}); } }, { rootMargin: '100% 0px 100% 0px' });
      io.observe(host);
    } else load().catch(() => {});
    const broken = (t) => t.replace('Under 100? > Pay back : yes', 'Under 100? > Pay bak : yes');
    play(fig, [
      { caption: 'Flowchart: refund-approval.flow. The text on the left is the whole diagram; the first line picks the kind.', ms: 2600, run: async () => { const a = await load(); a.setPane('editor'); a.showKind('flow'); } },
      { caption: 'Switch to Entity relationship: tables, keys and how rows relate, from the same kind of file.', ms: 2600, run: async () => { (await load()).showKind('er'); } },
      { caption: 'Switch to Sequence: who calls whom, in order, laid out from the text.', ms: 2600, run: async () => { (await load()).showKind('sequence'); } },
      { caption: 'Back on the Flowchart, misspell a name in a link. The problem banner names the line, and the canvas keeps the last good drawing.', ms: 3400, run: async (c) => {
        const a = await load(); a.showKind('flow'); await c.wait(500);
        const t = a.text, at = t.indexOf('Pay back : yes');
        if (at < 0) { a.setText(broken(t)); return; }
        if (c.reduce) { a.setText(broken(t)); return; }
        // delete the "c" of "back" letter by letter, the way a slip happens
        const pos = at + 'Pay ba'.length;
        a.setText(t.slice(0, pos) + t.slice(pos + 1));
      } },
      { caption: 'Put the letter back and the drawing follows again.', ms: 2000, run: async () => { (await load()).reset(); } },
    ], { reset: async () => { const a = await load(); a.setPane('editor'); a.showKind('flow'); a.reset(); }, done: 'That is the whole run. Pick a kind and edit its text yourself.' });
  }

  function init() { mountDbml(); mountCompare(); mountDiagrams(); flush(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})();
