/* Contura site: the Data page. The Transfer planner (ported from the Route Map journey planner, restyled and reworded),
   the data job slices (ported from the single-page site: importer, exporter, backup, lineage, explain), and phone
   playback for each demo through ConturaPlay, driven by the same functions the controls call.
   Export lines are the shared sample invoices from ConturaKit.DATA. PostgreSQL types and plans are scripted. */
(function () {
  'use strict';
  const doc = document, SVGNS = 'http://www.w3.org/2000/svg';
  const K = window.ConturaKit || {};
  const RM = matchMedia('(prefers-reduced-motion: reduce)');
  const qs = new URLSearchParams(location.search);
  const reduced = () => RM.matches || qs.get('reduce') === '1';
  const fmt = K.fmt || ((n) => Number(n).toLocaleString('en-US'));
  const esc = K.esc || ((s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduced() ? 0 : ms));
  const $ = (s, r) => (r || doc).querySelector(s);
  const $$ = (s, r) => [...(r || doc).querySelectorAll(s)];

  /* icons, 16px line glyphs in currentColor */
  const P = {
    arrow: '<path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5"/>',
    left: '<path d="M13 8H3M6.5 4.5 3 8l3.5 3.5"/>',
    check: '<path d="m3.2 8.4 3 3 6.6-6.8"/>',
    alert: '<path d="M8 2.2 14.3 13H1.7z"/><path d="M8 6.4v3.1M8 11.3v.2"/>',
    ban: '<circle cx="8" cy="8" r="5.6"/><path d="m4.1 11.9 7.8-7.8"/>',
    trash: '<path d="M2.8 4.4h10.4M6.3 4.4V2.8h3.4v1.6M4.4 4.4l.6 8.8h6l.6-8.8"/>',
    info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.3v3.6M8 5.1v.2"/>',
    file: '<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>',
    grid: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 6.2h12M2 9.8h12M6.5 2.5v11"/>',
    lock: '<rect x="3.2" y="7" width="9.6" height="6.8" rx="1.2"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
    imp: '<path d="M8 2v8M4.8 6.8 8 10l3.2-3.2"/><path d="M2.5 11v2.5h11V11"/>',
    restore: '<path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.5v3h3"/>',
  };
  const ic = (n, cls) => '<svg class="dj-ji' + (cls ? ' ' + cls : '') + '" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + P[n] + '</svg>';
  const A = ' data-a';

  /* ConturaPlay is shared and may load after this file: attach now, or when it says it is ready, or not at all */
  const plays = [];
  function withPlay(fig, steps, opts) { plays.push([fig, steps, opts]); }
  function attachPlays() {
    const CP = window.ConturaPlay;
    if (!CP || typeof CP.attach !== 'function') return false;
    while (plays.length) {
      const [fig, steps, opts] = plays.shift();
      if (fig && !fig.dataset.pbAttached) { fig.dataset.pbAttached = '1'; try { CP.attach(fig, steps, opts); } catch (e) { console.error(e); } }
    }
    return true;
  }

  /* ======================= 01 the Transfer planner ======================= */
  const planner = (function () {
    const box = $('#planner');
    if (!box) return null;
    const PLAN = {
      mysql: {
        label: 'MySQL', from: 'MySQL · shop.orders', cols: 5, rows: 1204,
        review: { title: 'Review is_paid', sub: 'tinyint(1), your choice', items: 1, unit: 'choice' },
        ask: '<b>is_paid</b> is <code>tinyint(1)</code> in MySQL and has no single PostgreSQL match. Choose its type before Run.',
        picks: [['boolean', 'boolean'], ['smallint', 'smallint']],
        done: (v) => '<b>is_paid</b> becomes <code>' + v + '</code>. The other 4 columns map on their own.',
        fail: () => 'Row 812: created_at holds 0000-00-00 00:00:00, which does not fit timestamp.',
      },
      sqlite: {
        label: 'SQLite', from: 'SQLite · shop.db, orders', cols: 5, rows: 1204,
        review: { title: 'Review 5 notes', sub: 'is_paid, your choice', items: 5, unit: 'notes' },
        ask: 'SQLite INTEGER columns copy by their affinity as <code>bigint</code>. <b>is_paid</b> can become <code>boolean</code> instead.',
        picks: [['bigint', 'Keep bigint'], ['boolean', 'boolean']],
        done: (v) => '<b>is_paid</b> becomes <code>' + v + '</code>. All 5 notes reviewed.',
        fail: (v) => (v === 'boolean' ? 'Row 812: is_paid holds 2, which does not fit boolean.' : "Row 812: customer_id holds 'n/a', which does not fit bigint."),
      },
    };
    const S = { src: 'mysql', pick: null, state: 'review', busy: false, result: null };
    const routeEl = $('#plan-route'), decide = $('#plan-decide'), runBtn = $('#plan-run'), runSt = $('#plan-st'), failT = $('#plan-failt'), routeText = $('#plan-text'), fromEl = $('#plan-from');
    let geo = null;
    const gap = (n) => 1 + Math.log10(1 + n);
    function stopsOf() {
      const d = PLAN[S.src];
      return [
        { key: 'src', t: 'orders, ' + fmt(d.rows) + ' rows', s: d.label + ' source', w: 0 },
        { key: 'map', t: 'Map ' + d.cols + ' column types', s: d.cols + ' columns', w: gap(d.cols) },
        { key: 'rev', t: d.review.title, s: S.state === 'review' ? d.review.sub : 'reviewed: ' + S.pick, w: gap(d.review.items), rev: true },
        { key: 'chk', t: 'Check rows fit', s: fmt(d.rows) + ' rows', w: gap(d.rows) },
        { key: 'run', t: 'Run, one transaction', s: fmt(d.rows) + ' rows', w: gap(d.rows) },
      ];
    }
    function polyD(pts, r) {
      let d = 'M' + pts[0][0] + ' ' + pts[0][1];
      for (let i = 1; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
        const l1 = Math.hypot(x1 - x0, y1 - y0), l2 = Math.hypot(x2 - x1, y2 - y1), rr = Math.min(r, l1 / 2, l2 / 2);
        const ax = x1 - ((x1 - x0) / l1) * rr, ay = y1 - ((y1 - y0) / l1) * rr, bx = x1 + ((x2 - x1) / l2) * rr, by = y1 + ((y2 - y1) / l2) * rr;
        d += ' L' + ax + ' ' + ay + ' Q' + x1 + ' ' + y1 + ' ' + bx + ' ' + by;
      }
      const e = pts[pts.length - 1];
      return d + ' L' + e[0] + ' ' + e[1];
    }
    function drawRoute() {
      const W = routeEl.clientWidth || 700, vert = W < 560;
      const st = stopsOf();
      let vb, main, spur;
      const Y = 104;
      if (!vert) {
        vb = [760, 290];
        main = [[34, Y], [722, Y]];
        spur = [[722, Y], [722, Y + 46], [676, Y + 92], [566, Y + 92]];
      } else {
        vb = [340, 500];
        main = [[30, 22], [30, 388]];
        spur = [[30, 388], [30, 414], [60, 444], [60, 478]];
      }
      const svg = doc.createElementNS(SVGNS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + vb[0] + ' ' + vb[1]);
      routeEl.innerHTML = ''; routeEl.appendChild(svg);
      const mk = (tag, a, p) => { const e = doc.createElementNS(SVGNS, tag); Object.keys(a).forEach((k) => e.setAttribute(k, a[k])); (p || svg).appendChild(e); return e; };
      const spurP = mk('path', { d: polyD(spur, 26), class: 'rl rl-spur', 'stroke-width': 4 });
      const mainP = mk('path', { d: polyD(main, 40), class: 'rl rl-main', 'stroke-width': 6 });
      const L = mainP.getTotalLength();
      const total = st.reduce((a, s) => a + s.w, 0);
      let acc = 0;
      st.forEach((s) => { acc += s.w; s.at = (acc / total) * L; const p = mainP.getPointAtLength(s.at); s.x = p.x; s.y = p.y; });
      /* the ruler: each gap is drawn to its work, 1 + log10(1 + items), and says what that work is */
      const d = PLAN[S.src];
      const units = ['', d.cols + ' columns', d.review.items + ' ' + d.review.unit, fmt(d.rows) + ' rows', fmt(d.rows) + ' rows'];
      if (!vert) {
        const ry = 270;
        mk('line', { x1: st[0].x, y1: ry, x2: st[st.length - 1].x, y2: ry, class: 'ruler' });
        st.forEach((s, i) => {
          mk('line', { x1: s.x, y1: ry - 4, x2: s.x, y2: ry + 4, class: 'ruler' });
          if (i) { const tx = mk('text', { x: (s.x + st[i - 1].x) / 2, y: ry + 16, class: 'rtx', 'text-anchor': 'middle' }); tx.textContent = units[i]; }
        });
        const cap = mk('text', { x: st[0].x, y: ry - 10, class: 'rtx' }); cap.textContent = 'Spacing follows the work in each step';
      }
      st.forEach((s, i) => {
        const gg = mk('g', { class: s.rev && S.state === 'review' ? 'rev' : '' });
        const big = i === 0 || i === st.length - 1;
        s.disc = mk('circle', { cx: s.x, cy: s.y, r: s.rev ? 12 : big ? 11 : 9, class: 'disc' + (s.rev && S.state === 'review' ? ' rv' : ''), 'stroke-width': s.rev ? 3 : 2.5 }, gg);
        let lx, ly, anchor = 'start';
        if (vert) { lx = s.x + 26; ly = s.y + 1; }
        else {
          const up = i % 2 === 0;
          ly = up ? s.y - 44 : s.y + 36;
          lx = s.x; anchor = i === st.length - 1 ? 'end' : 'middle';
          if (i === 0 || i === 2) { lx = s.x - 12; anchor = 'start'; }
          if (i === st.length - 1) lx = s.x + 12;
        }
        const t1 = mk('text', { x: lx, y: ly, class: 'lbl1', 'text-anchor': anchor }, gg); t1.textContent = s.t;
        const t2 = mk('text', { x: lx, y: ly + 18, class: 'lbl2', 'text-anchor': anchor }, gg); t2.textContent = s.s;
      });
      const fp = spurP.getPointAtLength(spurP.getTotalLength());
      const fd = mk('circle', { cx: fp.x, cy: fp.y, r: 9, class: 'disc fd', 'stroke-width': 2.5 });
      const ft = vert ? [fp.x + 24, fp.y - 4, 'start'] : [fp.x - 20, fp.y + 5, 'end'];
      const f1 = mk('text', { x: ft[0], y: ft[1], class: 'lbl1', 'text-anchor': ft[2] }); f1.textContent = vert ? 'If a row fails,' : 'If a row fails, nothing is written';
      const f2 = mk('text', { x: ft[0], y: ft[1] + 18, class: 'lbl2', 'text-anchor': ft[2] }); f2.textContent = vert ? 'nothing is written' : 'the transaction rolls back';
      const mark = mk('g', { class: 'mark', opacity: 0 });
      mk('rect', { x: -13, y: -8, width: 26, height: 16, rx: 6 }, mark);
      mk('circle', { cx: -5, cy: 0, r: 2.6 }, mark); mk('circle', { cx: 5, cy: 0, r: 2.6 }, mark);
      geo = { svg, mainP, spurP, st, mark, fd, L };
      /* a redraw (resize, fonts) keeps the outcome of the last run */
      if (S.result === 'ok') st.forEach((s) => s.disc.classList.add('done'));
      if (S.result === 'fail') { st.slice(0, -1).forEach((s) => s.disc.classList.add('done')); spurP.classList.add('hit'); fd.classList.add('done'); }
      routeText.textContent = 'Plan: ' + st.map((s) => s.t + ' (' + s.s + ')').join(', then ') + '. If a row fails, nothing is written.';
    }
    function paintDecide() {
      const d = PLAN[S.src];
      if (S.state === 'review') {
        decide.className = 'plan-decide';
        decide.innerHTML = '<p>' + d.ask + '</p><div class="plan-picks" role="group" aria-label="Type for is_paid">' + d.picks.map(([v, l]) => '<button type="button" class="plan-chip" data-pick="' + v + '">' + l + '</button>').join('') + '</div>';
        runBtn.disabled = true;
        runSt.innerHTML = 'Waiting for your choice at the <b>review step</b>.';
      } else {
        decide.className = 'plan-decide ok';
        decide.innerHTML = '<p>' + d.done(S.pick) + '</p><button type="button" class="plan-chip" data-change>Change</button>';
        runBtn.disabled = S.busy;
      }
    }
    function setSrc(v) {
      if (S.busy || !PLAN[v]) return;
      if (v !== S.src || S.state !== 'review') { S.src = v; S.state = 'review'; S.pick = null; }
      S.result = null;
      $$('[data-src]', box).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.src === v)));
      fromEl.textContent = PLAN[v].from;
      drawRoute(); paintDecide();
    }
    function pick(v) {
      if (S.busy) return;
      S.pick = v; S.state = 'ready'; S.result = null; drawRoute(); paintDecide();
      runSt.innerHTML = 'Reviewed. Every step is planned, so <b>Run</b> is open.';
    }
    function change() { if (S.busy) return; S.result = null; S.state = 'review'; S.pick = null; drawRoute(); paintDecide(); }
    decide.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) { pick(b.dataset.pick); runBtn.focus({ preventScroll: true }); return; }
      if (e.target.closest('[data-change]')) change();
    });
    $$('[data-src]', box).forEach((b) => b.addEventListener('click', () => { if (b.dataset.src !== S.src) setSrc(b.dataset.src); }));
    function moveMark(path, a, b, dur) {
      return new Promise((res) => {
        const t0 = performance.now();
        geo.mark.setAttribute('opacity', 1);
        const step = (now) => {
          const k = reduced() ? 1 : Math.min(1, (now - t0) / dur);
          const e = 1 - Math.pow(1 - k, 3);
          const p = path.getPointAtLength(a + (b - a) * e);
          geo.mark.setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ')');
          if (k < 1) requestAnimationFrame(step); else res();
        };
        requestAnimationFrame(step);
      });
    }
    async function run() {
      if (S.busy || S.state === 'review') return;
      S.busy = true; runBtn.disabled = true; failT.disabled = true;
      $$('[data-src]', box).forEach((x) => { x.disabled = true; });
      $$('[data-change]', box).forEach((x) => { x.disabled = true; });
      S.result = null; drawRoute();
      const fail = failT.checked, d = PLAN[S.src], st = geo.st;
      runSt.innerHTML = '<span class="plan-spin" aria-hidden="true"></span>Mapping ' + d.cols + ' columns...';
      for (let i = 1; i < st.length; i++) {
        await moveMark(geo.mainP, st[i - 1].at, st[i].at, 260 + (st[i].at - st[i - 1].at) * 1.6);
        st[i - 1].disc.classList.add('done');
        if (st[i].key === 'chk') { runSt.innerHTML = '<span class="plan-spin" aria-hidden="true"></span>Checking ' + fmt(d.rows) + ' rows against their new types...'; await sleep(450); }
        if (st[i].key === 'run') runSt.innerHTML = '<span class="plan-spin" aria-hidden="true"></span>Copying rows in one transaction...';
      }
      await sleep(350);
      if (fail) {
        geo.spurP.classList.add('hit');
        await moveMark(geo.spurP, 0, geo.spurP.getTotalLength(), 700);
        geo.fd.classList.add('done'); S.result = 'fail';
        runSt.innerHTML = '<span class="plan-out bad">0 rows written</span><b>' + esc(d.fail(S.pick)) + '</b> The transaction rolled back, so freight.orders is as it was. Fix the row or its type, then run again.';
      } else {
        st[st.length - 1].disc.classList.add('done'); S.result = 'ok';
        runSt.innerHTML = '<span class="plan-out ok">' + fmt(d.rows) + ' rows written</span><b>Copied ' + fmt(d.rows) + ' rows into freight.orders</b> in one transaction. A sample run in this page.';
      }
      S.busy = false; runBtn.disabled = false; failT.disabled = false;
      $$('[data-src]', box).forEach((x) => { x.disabled = false; });
      $$('[data-change]', box).forEach((x) => { x.disabled = false; });
    }
    runBtn.addEventListener('click', run);
    async function reset() {
      while (S.busy) await new Promise((r) => setTimeout(r, 60));
      failT.checked = false; S.state = 'review'; S.pick = null; S.src = 'mysql';
      setSrc('mysql');
    }
    drawRoute(); paintDecide();
    let rw = routeEl.clientWidth;
    if ('ResizeObserver' in window) new ResizeObserver(() => { if (Math.abs(routeEl.clientWidth - rw) > 4 && !S.busy) { rw = routeEl.clientWidth; drawRoute(); } }).observe(routeEl);
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(() => { if (!S.busy) drawRoute(); });
    return { setSrc, pick, run, reset, setFail: (b) => { failT.checked = !!b; }, get busy() { return S.busy; } };
  })();

  if (planner) withPlay($('#fig-transfer'), [
    { caption: 'From MySQL, the plan stops at the review step: tinyint(1) has no single PostgreSQL match.', run: async () => { planner.setSrc('mysql'); }, ms: 2600 },
    { caption: 'From SQLite, INTEGER columns copy as bigint, and is_paid can become boolean instead.', run: async () => { planner.setSrc('sqlite'); }, ms: 2600 },
    { caption: 'Back on MySQL, choose boolean for is_paid. Run opens once every step is planned.', run: async (c) => { planner.setSrc('mysql'); await c.wait(900); planner.pick('boolean'); }, ms: 2000 },
    { caption: 'Run. Each row is checked against its new type, then copied in one transaction.', run: async () => { await planner.run(); }, ms: 2600 },
    { caption: 'Now a row that does not fit. Row 812 stops the run, the transaction rolls back, and 0 rows are written.', run: async (c) => { planner.setFail(true); await c.wait(700); await planner.run(); }, ms: 3400 },
  ], { reset: () => planner.reset(), done: 'That is the whole plan. Pick a source and try it yourself.' });

  /* ======================= the job slices ======================= */
  const DATA = K.DATA || null, T = K.T || null;

  /* Import: the Columns step (MappingTable), the check pass, then the run, by target Connection */
  const IMP = {
    file: 'payments-oct.csv', hint: '1,204 rows, 5 columns, 58 KB', rows: 1204,
    map: [['invoice', 'invoice_id', 'The names differ'], ['amount', 'amount', ''], ['paid_at', 'paid_at', ''], ['method', 'method', ''], ['reference', null, 'Not imported'], [null, 'id', 'Filled by the database']],
    conn: { stg: ['freight-stg', ''], prod: ['freight-prod', '<span class="pill prod">PROD</span>'], ro: ['freight-report', '<span class="pill ro">Read-only</span>'] },
  };
  function importer(v) {
    const c = IMP.conn[v];
    let h = '<div class="dj-head"><b>' + IMP.file + '</b><span class="dj-sp"></span><span>Into ' + c[0] + ' ' + c[1] + '</span></div><div class="dj-bd">';
    if (v === 'ro') h += '<p class="dj-ban lock"' + A + '>' + ic('lock') + '<span><b>freight-report is Read-only.</b> Import is not allowed here. Choose another Connection, or change its settings.</span></p>';
    h += '<div class="dj-tg" style="--cols:minmax(0,1fr) minmax(0,1.05fr) minmax(0,1.1fr)"><div class="dj-th"' + A + '><span>File column</span><span>Into column</span><span>Note</span></div>';
    IMP.map.forEach((m) => {
      const off = m[1] === null || m[0] === null;
      h += '<div' + A + (off ? ' class="dj-dim"' : '') + '><span class="dj-m">' + (m[0] ? esc(m[0]) : 'none') + '</span><span class="dj-m">' + (m[1] === null ? 'Not imported' : '<span class="dj-ty">' + m[1] + '</span>') + '</span><span class="dj-mu">' + m[2] + '</span></div>';
    });
    h += '</div><div class="dj-stack"' + A + '><p class="dj-ban plain fx on1 off2">Checking every row of the file...</p><p class="dj-ban ok fx on2">' + ic('check') + '<span>All ' + fmt(IMP.rows) + ' rows fit their columns</span></p></div>';
    if (v === 'stg') {
      h += '<div class="dj-bar"' + A + '><b></b></div>';
      h += '<div class="dj-stats"' + A + '><span>Rows <span class="dj-stack"><b class="fx off3">0 of 1,204</b><b class="fx on3 off4">1,000 of 1,204</b><b class="fx on4">1,204 of 1,204</b></span></span><span>Time <b>2s</b></span></div>';
      h += '<p class="dj-ban plain fx on4">' + ic('check', 'dj-ok-ic') + '<span>Imported 1,204 rows into billing.payments in one transaction.</span></p>';
    } else if (v === 'prod') {
      h += '<div class="dj-acts fx on2"><span class="dj-hint">Writes 1,204 rows into billing.payments on Production.</span><button type="button" class="dj-b prod" data-act="ask">' + ic('imp') + 'Import on PROD...</button></div>';
      h += '<div class="dj-confirm" data-confirm hidden role="dialog" aria-label="Import on freight-prod"><h3>' + ic('alert', 'dj-warn-ic') + 'Import into freight-prod <span class="pill prod">PROD</span></h3>' +
        '<p>Inserts 1,204 rows into billing.payments in 3 statements of up to 500 rows, in one transaction.</p>' +
        '<p class="dj-fp">payments-oct.csv · 58 KB · SHA-256 4be0 91c2 ... 7d1f</p>' +
        '<p>The pass is tied to this fingerprint. If the file changes before the run, Contura asks again.</p>' +
        '<div class="dj-acts"><span class="dj-sp"></span><button type="button" class="dj-b" data-act="cancel">Cancel</button><button type="button" class="dj-b pri" data-act="go">Import on freight-prod</button></div>' +
        '<p class="dj-done" data-done hidden>' + ic('check') + '<span></span></p></div>';
    } else {
      h += '<div class="dj-acts fx on2"><span class="dj-hint">Nothing can be written to a Read-only Connection.</span><button type="button" class="dj-b" disabled>' + ic('imp') + 'Import 1,204 rows</button></div>';
    }
    h += '</div>';
    return { html: h, steps: v === 'stg' ? [700, 1400, 2000, 2700] : [700, 1400] };
  }

  /* Export: the preview, first lines exactly as written, from the shared invoices */
  const money = (n) => Number(n).toFixed(2);
  const utf8 = (s) => new TextEncoder().encode(s).length;
  const kbOf = (b) => (b < 1024 ? '1 KB' : fmt(Math.round(b / 1024)) + ' KB');
  const EXP = (function () {
    const cols = T ? T.invoices.map((c) => c[0]) : ['id', 'customer_id', 'number', 'total', 'issued_at', 'status'];
    const rows = DATA ? DATA.invoices : [];
    const csvRow = (r) => [r[0], r[1], r[2], money(r[3]), r[4], r[5]].join(',');
    const jsonObj = (r, sp) => {
      const q = (s) => JSON.stringify(s);
      const kv = [['id', r[0]], ['customer_id', r[1]], ['number', q(r[2])], ['total', money(r[3])], ['issued_at', q(r[4])], ['status', q(r[5])]];
      return '{' + kv.map(([k, v]) => '"' + k + '":' + sp + v).join(',' + sp) + '}';
    };
    const sqlVal = (r) => '(' + r[0] + ', ' + r[1] + ", '" + r[2] + "', " + money(r[3]) + ", '" + r[4] + "', '" + r[5] + "')";
    const full = {}, size = {};
    full.csv = [cols.join(',')].concat(rows.map(csvRow)).join('\r\n') + '\r\n';
    full.json = '[\n' + rows.map((r) => '  ' + jsonObj(r, ' ')).join(',\n') + '\n]\n';
    full.jsonl = rows.map((r) => jsonObj(r, '')).join('\n') + '\n';
    const head = 'INSERT INTO "billing"."invoices" (' + cols.map((c) => '"' + c + '"').join(', ') + ') VALUES\n';
    let sql = '-- Contura export of "billing"."invoices" for PostgreSQL\n';
    for (let i = 0; i < rows.length; i += 500) sql += head + rows.slice(i, i + 500).map(sqlVal).join(',\n') + ';\n';
    full.sql = sql;
    Object.keys(full).forEach((k) => { size[k] = utf8(full[k]); });
    /* Excel stores shared strings and zips the sheet: estimate from the cell text, about half of it, plus the workbook parts */
    size.xlsx = Math.round(utf8(full.csv) * 0.5) + 6200;
    return { cols, rows, csvRow, jsonObj, sqlVal, size };
  })();
  function exporter(v, jv) {
    const key = v === 'json' ? (jv === 'lines' ? 'jsonl' : 'json') : v;
    const name = { csv: 'invoices.csv', json: 'invoices.json', jsonl: 'invoices.jsonl', xlsx: 'invoices.xlsx', sql: 'invoices.sql' }[key];
    const n = EXP.rows.length, first = EXP.rows.slice(0, 4);
    let h = '<div class="dj-head"><b>Preview</b><span>first lines, exactly as written</span></div><div class="dj-bd">';
    if (!n) return { html: h + '<p class="dj-ban plain">The sample rows did not load.</p></div>', steps: [] };
    if (key === 'xlsx') {
      h += '<p class="dj-size dj-mu"' + A + '>' + ic('grid') + '<b class="dj-m fn">' + name + '</b><span class="dj-sp"></span><span>Sheet invoices, header row frozen</span></p>';
      h += '<div class="dj-sheet-w"' + A + '><table class="dj-sheet"><tbody><tr><th class="rn"></th>' + EXP.cols.map((c, i) => '<th>' + String.fromCharCode(65 + i) + '</th>').join('') + '</tr>';
      h += '<tr><td class="rn">1</td>' + EXP.cols.map((c) => '<td><b>' + c + '</b></td>').join('') + '</tr>';
      first.forEach((r, i) => { h += '<tr><td class="rn">' + (i + 2) + '</td><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + money(r[3]) + '</td><td>' + r[4] + '</td><td>' + r[5] + '</td></tr>'; });
      h += '</tbody></table></div>';
    } else {
      const meta = key === 'csv' ? 'UTF-8, comma, header row' : key === 'sql' ? 'PostgreSQL, 500 rows per INSERT' : key === 'jsonl' ? 'UTF-8, one object per line' : 'UTF-8, one array';
      h += '<p class="dj-size dj-mu"' + A + '>' + ic('file') + '<b class="dj-m fn">' + name + '</b><span class="dj-sp"></span><span>' + meta + '</span></p><pre class="dj-lines" tabindex="0" aria-label="First lines of ' + name + '">';
      let ls;
      if (key === 'csv') ls = [EXP.cols.join(',')].concat(first.map(EXP.csvRow)).map(esc);
      else if (key === 'json') ls = ['['].concat(first.map((r) => '  ' + EXP.jsonObj(r, ' ') + ',')).map(esc);
      else if (key === 'jsonl') ls = first.map((r) => EXP.jsonObj(r, '')).map(esc);
      else {
        ls = ['<span class="c">-- Contura export of "billing"."invoices" for PostgreSQL</span>', '<span class="k">INSERT INTO</span> "billing"."invoices" (' + EXP.cols.map((c) => '"' + c + '"').join(', ') + ') <span class="k">VALUES</span>'];
        first.forEach((r) => ls.push('(<span class="n">' + r[0] + '</span>, <span class="n">' + r[1] + '</span>, <span class="s">\'' + r[2] + '\'</span>, <span class="n">' + money(r[3]) + '</span>, <span class="s">\'' + r[4] + '\'</span>, <span class="s">\'' + r[5] + '\'</span>),'));
      }
      ls.forEach((l) => { h += '<span' + A + '>' + l + '</span>'; });
      h += '<span class="more"' + A + '>' + esc('... ' + fmt(n - first.length) + ' more rows') + '</span></pre>';
    }
    h += '<p class="dj-size"' + A + '><span class="dj-mu">File</span><b>About ' + kbOf(EXP.size[key]) + ', ' + fmt(n) + ' rows</b></p></div>';
    return { html: h, steps: [] };
  }

  /* Backup and Restore: the head of a Contura backup and Restore's checks and confirm on Production */
  function backup(v) {
    let h;
    if (v === 'backup') {
      h = '<div class="dj-head"><b>freight-2026-10-16.sql</b><span class="dj-sp"></span><span>Contura SQL script, from freight-prod</span></div><div class="dj-bd"><div class="dj-cols"><pre class="dj-lines" tabindex="0" aria-label="Header of the backup file">';
      ['-- Contura backup, format 1', '-- made-by: Contura 0.7.0', '-- dialect: PostgreSQL', '-- server-version: 16.4', '-- database: freight', '-- schemas: billing', '-- taken-at: 2026-10-16T22:00:00Z', '-- not-included: extension pgcrypto, large objects,', '--   grants, roles']
        .forEach((l) => { h += '<span class="c"' + A + '>' + esc(l) + '</span>'; });
      h += '<span' + A + '><span class="k">CREATE SCHEMA</span> billing;</span></pre><div class="dj-bd" style="padding:0">';
      h += '<p class="dj-cap"' + A + '>Not included</p><ul class="dj-list"' + A + '><li>The pgcrypto extension</li><li>Large objects</li><li>Grants and roles</li></ul>';
      h += '<p class="dj-ban plain"' + A + '>The header lists them, so a restore can say what to add by hand.</p>';
      h += '<p class="dj-ban plain"' + A + '>One snapshot: the whole file shows freight at the moment the backup starts.</p>';
      h += '<p class="dj-ban warn"' + A + '>' + ic('alert') + '<span>Backup only reads freight-prod, so it asks nothing. The file holds Production rows: keep it somewhere safe.</span></p>';
      h += '</div></div></div>';
      return { html: h, steps: [] };
    }
    h = '<div class="dj-head"><span>Restore into</span><b>freight-prod</b><span class="pill prod">PROD</span><span class="dj-sp"></span><span>freight-2026-10-16.sql</span></div><div class="dj-bd"><div class="dj-cols"><div class="dj-bd" style="padding:0">';
    h += '<p class="dj-cap"' + A + '>Checks</p><ul class="dj-checks">';
    [['ok', 'Same Dialect as freight-prod: PostgreSQL'], ['ok', 'Server version 16.4 matches the backup'], ['ok', '1,503 statements read, none refused'], ['ok', 'The trailer is present, so the file is complete'], ['warn', 'Not in the file: pgcrypto, large objects, grants and roles']]
      .forEach((c) => { h += '<li' + A + '>' + (c[0] === 'ok' ? ic('check', 'dj-ok-ic') : ic('alert', 'dj-warn-ic')) + '<span>' + c[1] + '</span></li>'; });
    h += '</ul></div><div class="dj-bd" style="padding:0"><p class="dj-cap"' + A + '>Structure, exact SQL from the file</p><pre class="dj-lines" tabindex="0" aria-label="First statements of the restore">';
    ['<span class="k">CREATE DATABASE</span> freight_restore_1017;', '<span class="k">CREATE SCHEMA</span> billing;', '<span class="k">CREATE TABLE</span> billing.customers (', '  id bigint <span class="k">PRIMARY KEY</span>,', '  name text <span class="k">NOT NULL</span>,']
      .forEach((l) => { h += '<span' + A + '>' + l + '</span>'; });
    h += '</pre></div></div>';
    h += '<div class="dj-acts"' + A + '><span class="dj-hint">Into a new database, freight_restore_1017. Next you see what it writes.</span><button type="button" class="dj-b prod" data-act="ask">' + ic('restore') + 'Restore on PROD...</button></div>';
    h += '<div class="dj-confirm" data-confirm hidden role="dialog" aria-label="Restore on freight-prod"><h3>' + ic('alert', 'dj-warn-ic') + 'Restore on freight-prod <span class="pill prod">PROD</span></h3>' +
      '<p>Creates freight_restore_1017, then 6 tables, 14 indexes and 5 Foreign Keys, then runs 1,472 INSERT statements (742,818 rows). All of it writes.</p>' +
      '<p class="dj-fp">Checked file: freight-2026-10-16.sql · 48.2 MB · SHA-256 9f3c 1a7e 52d0 ... e21a</p>' +
      '<p>If the file changes before the run, Contura asks again.</p>' +
      '<div class="dj-acts"><span class="dj-sp"></span><button type="button" class="dj-b" data-act="cancel">Cancel</button><button type="button" class="dj-b pri" data-act="go">Restore on freight-prod</button></div>' +
      '<p class="dj-done" data-done hidden>' + ic('check') + '<span></span></p></div>';
    h += '</div>';
    return { html: h, steps: [] };
  }

  /* Lineage: what each key of billing.customers does, with counts from the sample rows */
  const LIN = (function () {
    const cid = 1;
    const name = DATA ? DATA.customers.find((c) => c[0] === cid)[1] : 'Kestrel Foods';
    const nInv = DATA ? DATA.invoices.filter((r) => r[1] === cid).length : 0;
    const ords = DATA ? DATA.orders.filter((r) => r[1] === cid).map((r) => r[0]) : [];
    const nItems = DATA ? DATA.order_items.filter((r) => ords.indexOf(r[1]) >= 0).length : 0;
    const plan = DATA ? DATA.plans.find((p) => p[0] === DATA.customers[0][4])[1] : 'Starter';
    return {
      name, nInv, nOrd: ords.length, nItems,
      keys: [
        { t: 'invoices', dir: 'left', code: 'invoices.customer_id, ON DELETE RESTRICT', tag: 'blocks', w: 0, s: 'A customer with invoices cannot be deleted. ' + name + ' has ' + fmt(nInv) + ', so the delete stops.' },
        { t: 'orders', dir: 'left', code: 'orders.customer_id, ON DELETE CASCADE', tag: 'cascade', w: 1, s: 'Orders go when their customer goes: deleting ' + name + ' also deletes its ' + fmt(ords.length) + ' orders.' },
        { t: 'plans', dir: 'arrow', code: 'customers.plan_id, to plans.id', tag: 'info', s: 'Each customer points to one plan. Deleting ' + name + ' leaves the ' + plan + ' plan in place.' },
      ],
    };
  })();
  const TAG = { blocks: ['ban', 'Blocks the delete'], cascade: ['trash', 'Also deletes'], info: ['info', 'Info'] };
  const sentence = (k) => { const tg = TAG[k.tag]; return '<p>' + esc(k.s) + '</p><div class="dj-meta2"><code class="dj-mu">' + esc(k.code) + '</code><span class="dj-ltag ' + k.tag + '">' + ic(tg[0]) + tg[1] + '</span></div>'; };
  function lineage(v) {
    const k = LIN.keys[+v];
    let h = '<div class="dj-head"><b>billing.customers</b><span class="dj-sp"></span><span>Lineage, freight-stg</span></div><div class="dj-bd"><div class="dj-keys" role="group" aria-label="Foreign Keys of customers">';
    LIN.keys.forEach((x, i) => {
      h += '<button type="button" class="dj-key"' + A + ' data-v="' + i + '" aria-pressed="' + (i === +v) + '" aria-label="' + (x.dir === 'arrow' ? 'customers points to ' : 'Points to customers: ') + x.t + '">' + ic(x.dir) + '<code>' + x.t + '</code></button>';
    });
    h += '</div><div class="dj-sent" aria-live="polite"' + A + '>' + sentence(k) + '</div>';
    h += '<div class="dj-warnbox"' + A + '><p class="dj-cap">' + ic('alert') + 'Before you delete ' + esc(LIN.name) + '</p><ul>';
    h += '<li' + (k.w === 0 ? ' class="hot"' : '') + '>' + ic('ban', 'dj-warn-ic') + '<span>' + fmt(LIN.nInv) + ' invoices stop the delete.</span></li>';
    h += '<li' + (k.w === 1 ? ' class="hot"' : '') + '>' + ic('trash', 'dj-bad-ic') + '<span>' + fmt(LIN.nOrd) + ' orders go with it.</span></li></ul></div></div>';
    return { html: h, steps: [] };
  }

  /* Explain: a PostgreSQL plan as the plan view draws it; flags for full scans and the step with most of the cost */
  const PLANS = {
    scan: { total: '3,412.18', nodes: [[0, 'HashAggregate', '', '960', '3,412.18'], [1, 'Hash Join', '', '38,200', '3,190.40'], [2, 'Seq Scan', 'invoices', '38,200', '3,061.42', ['Full scan of invoices, about 38,200 rows', 'This step is 90 percent of the cost']], [2, 'Hash', '', '960', '22.10'], [3, 'Seq Scan', 'customers', '960', '22.10']] },
    index: { total: '1,104.36', nodes: [[0, 'HashAggregate', '', '960', '1,104.36'], [1, 'Hash Join', '', '38,200', '882.57'], [2, 'Index Scan using invoices_issued_at_idx', 'invoices', '38,200', '753.30', ['This step is 68 percent of the cost']], [2, 'Hash', '', '960', '22.10'], [3, 'Seq Scan', 'customers', '960', '22.10']] },
  };
  function explain(v) {
    const p = PLANS[v];
    let h = '<div class="dj-head"><b>Explain</b><span class="dj-sp"></span><span>freight-prod, without ANALYZE</span></div><div class="dj-bd">';
    h += '<p class="dj-q"' + A + '><span class="k">SELECT</span> c.name, sum(i.total) <span class="k">FROM</span> billing.invoices i <span class="k">JOIN</span> billing.customers c <span class="k">ON</span> c.id = i.customer_id <span class="k">WHERE</span> i.issued_at &gt;= \'2026-10-01\' <span class="k">GROUP BY</span> c.name</p>';
    h += '<div class="dj-plan" role="tree" aria-label="Plan">';
    p.nodes.forEach((n) => {
      h += '<div class="dj-ps' + (n[5] ? ' flag' : '') + '" role="treeitem" aria-level="' + (n[0] + 1) + '" aria-selected="false" style="--d:' + n[0] + '"' + A + '><div class="dj-pl"><span class="op">' + n[1] + '</span>' + (n[2] ? '<span class="ob dj-m">' + n[2] + '</span>' : '') + '<span class="nus"><span class="nu dj-m">' + n[3] + ' rows</span><span class="nu dj-m">cost ' + n[4] + '</span></span></div>';
      (n[5] || []).forEach((f) => { h += '<div class="dj-pf fx on1">' + ic('alert') + '<span>' + f + '</span></div>'; });
      h += '</div>';
    });
    h += '</div><p class="dj-total"' + A + '><span class="dj-mu">Estimated total cost</span><b>' + p.total + '</b>' + (v === 'index' ? '<span class="dj-mu">down from 3,412.18 without the index</span>' : '') + '</p></div>';
    return { html: h, steps: [700] };
  }

  const DRAW = { import: importer, export: exporter, backup, lineage, explain };
  const jobs = {};
  $$('.dj-sl[data-job]').forEach((sl) => {
    const name = sl.dataset.job, fig = sl.closest('figure');
    const seg = $('#seg-' + name);
    const j = { name, sl, fig, seg, v: seg ? seg.querySelector('[aria-pressed="true"]').dataset.v : '0', jv: 'array', timers: [], played: false };
    jobs[name] = j;
  });
  function show(j, play) {
    j.timers.forEach(clearTimeout); j.timers = [];
    const out = DRAW[j.name](j.v, j.jv);
    const sl = j.sl;
    sl.className = 'dj-sl';
    sl.innerHTML = out.html;
    sl.querySelectorAll('[data-a]').forEach((e, i) => e.style.setProperty('--i', Math.min(i, 12)));
    j.steps = out.steps;
    if (!play || reduced()) { out.steps.forEach((t, i) => sl.classList.add('s' + (i + 1))); return; }
    sl.classList.add('dj-pre');
    void sl.offsetWidth;
    requestAnimationFrame(() => sl.classList.remove('dj-pre'));
    out.steps.forEach((t, i) => j.timers.push(setTimeout(() => sl.classList.add('s' + (i + 1)), t)));
  }
  const lastStep = (j) => (j.steps && j.steps.length ? j.steps[j.steps.length - 1] : 0);
  function setV(j, v, play) {
    if (!j) return;
    j.v = v; j.played = true;
    if (j.seg) j.seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === v)));
    if (j.name === 'export') { const sub = $('#jc-json'); if (sub) sub.hidden = v !== 'json'; }
    show(j, play !== false);
  }
  function setJson(jv, play) {
    const j = jobs.export; if (!j) return;
    j.jv = jv;
    $$('#seg-json button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === jv)));
    if (j.v === 'json') show(j, play !== false);
  }
  function pickKey(i) {
    const j = jobs.lineage; if (!j) return;
    j.v = String(i); j.played = true;
    j.sl.querySelectorAll('.dj-key').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === j.v)));
    const k = LIN.keys[+j.v];
    const sent = j.sl.querySelector('.dj-sent');
    sent.innerHTML = sentence(k);
    j.sl.querySelectorAll('.dj-warnbox li').forEach((li, n) => li.classList.toggle('hot', k.w === n));
    if (!reduced() && sent.animate) sent.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  }
  /* the confirm cards in Import on Production and in Restore */
  function act(j, a) {
    const card = j.sl.querySelector('[data-confirm]'); if (!card) return;
    const done = card.querySelector('[data-done]');
    if (a === 'ask') { card.hidden = false; done.hidden = true; card.querySelectorAll('[data-act]').forEach((b) => { b.disabled = false; }); const go = card.querySelector('[data-act="go"]'); if (go) go.focus({ preventScroll: true }); }
    else if (a === 'cancel') { card.hidden = true; const ask = j.sl.querySelector('[data-act="ask"]'); if (ask) ask.focus({ preventScroll: true }); }
    else if (a === 'go') {
      done.hidden = false;
      done.lastElementChild.textContent = j.name === 'import' ? 'Imported 1,204 rows into billing.payments on freight-prod, in one transaction. A sample run in this page.' : 'Restored into freight_restore_1017 in one transaction. A sample run in this page.';
      card.querySelectorAll('[data-act]').forEach((b) => { b.disabled = true; });
    }
  }
  Object.values(jobs).forEach((j) => {
    show(j, false);
    if (j.seg) j.seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.dataset.v === j.v) return; setV(j, b.dataset.v); });
    j.sl.addEventListener('click', (e) => {
      const k = e.target.closest('.dj-key'); if (k && j.name === 'lineage') { if (k.dataset.v !== j.v) pickKey(k.dataset.v); return; }
      const b = e.target.closest('[data-act]'); if (b && !b.disabled) act(j, b.dataset.act);
    });
  });
  const jseg = $('#seg-json');
  if (jseg) jseg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.dataset.v === jobs.export.jv) return; setJson(b.dataset.v); });

  /* each slice plays once as it enters view */
  if ('IntersectionObserver' in window && !reduced()) {
    const list = Object.values(jobs).filter((j) => j.sl.getBoundingClientRect().top > innerHeight);
    list.forEach((j) => { j.sl.classList.add('dj-pre'); j.sl.classList.remove('s1', 's2', 's3', 's4'); });
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) return;
      const j = list.find((x) => x.sl === e.target); io.unobserve(e.target);
      if (!j || j.played) { if (j) j.sl.classList.remove('dj-pre'); return; }
      j.played = true; show(j, true);
    }), { rootMargin: '0px 0px -12% 0px' });
    list.forEach((j) => io.observe(j.sl));
  }

  /* phone playback for each slice, through setV, setJson, pickKey and act */
  const wait = (c, j) => c.wait(lastStep(j) + 300);
  if (jobs.import) withPlay(jobs.import.fig, [
    { caption: 'Into freight-stg: file columns match by name, every row is checked, then 1,204 rows go in as one transaction.', run: async (c) => { setV(jobs.import, 'stg'); await wait(c, jobs.import); }, ms: 2200 },
    { caption: 'Into freight-prod: the same check passes, and the button becomes Import on PROD.', run: async (c) => { setV(jobs.import, 'prod'); await wait(c, jobs.import); }, ms: 1600 },
    { caption: 'Import on PROD asks first and names the file by its fingerprint. A changed file asks again.', run: async () => { act(jobs.import, 'ask'); }, ms: 3200 },
    { caption: 'Into freight-report, a Read-only Connection: the mapping still shows, but the import is refused.', run: async (c) => { setV(jobs.import, 'ro'); await wait(c, jobs.import); }, ms: 2600 },
  ], { reset: async () => { setV(jobs.import, 'stg', false); }, done: 'That is Import. Pick a Connection and look again.' });
  if (jobs.export) withPlay(jobs.export.fig, [
    { caption: 'CSV: a header row, then the sample invoices exactly as they will be written, and the file size.', run: async () => { setV(jobs.export, 'csv'); }, ms: 2400 },
    { caption: 'JSON writes one array by default, one object per invoice.', run: async () => { setJson('array', false); setV(jobs.export, 'json'); }, ms: 2400 },
    { caption: 'JSON Lines is its own choice: one object per line, a .jsonl file with no surrounding array.', run: async () => { setJson('lines'); }, ms: 2400 },
    { caption: 'Excel: a sheet named invoices with the header row frozen.', run: async () => { setV(jobs.export, 'xlsx'); }, ms: 2400 },
    { caption: 'SQL INSERT: statements for PostgreSQL, 500 rows each.', run: async () => { setV(jobs.export, 'sql'); }, ms: 2400 },
  ], { reset: async () => { setJson('array', false); setV(jobs.export, 'csv', false); }, done: 'That is Export. Pick a format and read the lines.' });
  if (jobs.backup) withPlay(jobs.backup.fig, [
    { caption: 'Back up writes Contura\'s own SQL script. Its header says what made it and what it leaves out.', run: async () => { setV(jobs.backup, 'backup'); }, ms: 3000 },
    { caption: 'Restore reads that header and checks it against freight-prod before anything runs.', run: async () => { setV(jobs.backup, 'restore'); }, ms: 3000 },
    { caption: 'On Production it asks once more, naming the file by size and SHA-256 fingerprint.', run: async () => { act(jobs.backup, 'ask'); }, ms: 3400 },
  ], { reset: async () => { setV(jobs.backup, 'backup', false); }, done: 'That is Backup and Restore. Switch between them yourself.' });
  if (jobs.lineage) withPlay(jobs.lineage.fig, LIN.keys.map((k, i) => ({
    caption: ['Invoices point to customers, and an invoice stops a customer\'s delete.', 'Orders point to customers too, and they go along with the delete.', 'Customers point to plans, so a delete leaves the plan alone.'][i],
    run: async () => { pickKey(i); }, ms: 2800,
  })), { reset: async () => { setV(jobs.lineage, '0', false); }, done: 'That is Lineage. Click a key to read it again.' });
  if (jobs.explain) withPlay(jobs.explain.fig, [
    { caption: 'With no index on issued_at, the plan scans all of invoices, and that one step is 90 percent of the cost.', run: async (c) => { setV(jobs.explain, 'scan'); await wait(c, jobs.explain); }, ms: 2800 },
    { caption: 'With an index on issued_at, the scan of invoices uses it, and the total cost falls by about two thirds.', run: async (c) => { setV(jobs.explain, 'index'); await wait(c, jobs.explain); }, ms: 3000 },
  ], { reset: async () => { setV(jobs.explain, 'scan', false); }, done: 'That is Explain. Switch the index on and off.' });

  if (!attachPlays()) {
    const onReady = () => { attachPlays(); };
    doc.addEventListener('contura:play-ready', onReady, { once: true });
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => { attachPlays(); }, { once: true });
  }
})();
