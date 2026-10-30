/* Contura site, index.html #ai (loaded by launch.js when the section comes near): what the AI sees at each access
   level (ported from the "Contura" page's lanes demo onto ConturaKit's payloadFor, mask and utf8, so masking and bytes
   agree with the Ask panel). The Ask-with-answer-log, frame and playback parts below only run on a page that has
   their hosts, window.ConturaFrames or window.ConturaPlay; the launch page has none of them. */
(function () {
  'use strict';
  const doc = document;
  const K = window.ConturaKit, F = window.ConturaFrames, P = window.ConturaPlay;
  const $ = (s, r) => (r || doc).querySelector(s), $$ = (s, r) => [...(r || doc).querySelectorAll(s)];
  if (!K) return;
  const esc = K.esc, fmt = K.fmt, utf8 = K.utf8;
  const reduce = () => K.reduced();

  /* ---------------- 01: what the AI sees ---------------- */
  function createSees(root) {
    const Q = 'Which invoices are still unpaid?';
    const TABLES = ['invoices', 'customers', 'payments'];
    /* the same Visual Query model the kit's "unpaid" answer builds, so the statement is one the Ask panel would write */
    const M = {
      cards: TABLES.map((t) => ({ t })),
      ticks: [{ k: 'invoices.number' }, { k: 'customers.name' }, { k: 'invoices.total' }, { k: 'invoices.issued_at' }],
      where: [{ col: 'payments.id', op: 'is null' }, { col: 'invoices.status', op: '<>', lit: "'void'" }, { col: 'invoices.total', op: '>', lit: '500' }, { col: 'invoices.issued_at', op: '<', lit: "'2026-09-19'" }],
      order: { by: 'invoices.issued_at', dir: 'asc' }, limit: null, jt: {}, uj: [], cut: [],
    };
    const sqlText = K.sqlOf(M).map((l) => l.map((p) => p[1]).join('')).join('\n');
    /* an obviously fake secret in a comment, to show redaction; it is not a real password */
    const COMMENT = '-- reporting login: password=EXAMPLE-NOT-A-SECRET';
    const editorText = COMMENT + '\n' + sqlText;
    const redact = (line) => line.replace(/(password\s*=\s*)\S+/gi, '$1[secret]');
    const mk = K.mask(editorText);
    const stmt = mk.lines.map(redact);
    const pay = K.payloadFor(Q, TABLES, M, '7c1e');
    /* pay.lines: frame open, connection, schema..., 'Current statement:', statement..., frame close, 'Question:', question */
    const L = pay.lines;
    const iStmt = L.findIndex((l) => l[1] === 'Current statement:');
    const iClose = L.findIndex((l, i) => i > iStmt && /^<<\/contura:context/.test(l[1]));
    const head = L.slice(0, iStmt), tail = L.slice(iClose);
    const stmtLines = [['dim', 'Current statement:']].concat(stmt.map((s) => [/\[(date|text|number|secret)\]/.test(s) ? 'mask' : '', s]));
    const schemaLines = head.filter((l) => /^table /.test(l[1]));
    const qLines = [['', Q]];
    /* Plus sample rows: a few rows of the tables the question touches (sample data in this page) */
    const rowLines = [['dim', 'Sample rows, invoices (3 of 5,000):'], ['', 'INV-1042 | Aria Logistics | 812.50 | 2026-09-02'], ['', 'INV-1057 | Northwind Cargo | 640.00 | 2026-09-11'], ['', 'INV-1063 | Bluewater Freight | 1,220.00 | 2026-09-15']];
    function linesFor(lv) {
      if (lv === 0) return qLines;
      if (lv === 1) return head.concat(tail);
      if (lv === 2) return head.concat(stmtLines, tail);
      return head.concat(stmtLines, rowLines, tail);
    }
    const B = (lines) => (lines.length ? utf8(lines.map((l) => l[1]).join('\n')) : 0);
    const bytesFor = (lv) => B(linesFor(lv));
    const ITEMS = [
      { id: 'q', t: 'Your question', b: () => utf8(Q), go: () => true, why: () => 'Your own words go at every level, when you press Send.' },
      { id: 'frame', t: 'Framing: the Connection line and the data fence', b: (lv) => bytesFor(lv) - utf8(Q) - (lv >= 1 ? schemaLines.reduce((a, l) => a + utf8(l[1]) + 1, 0) : 0) - (lv >= 2 ? stmtLines.slice(1).reduce((a, l) => a + utf8(l[1]) + 1, 0) : 0) - (lv >= 3 ? rowLines.reduce((a, l) => a + utf8(l[1]) + 1, 0) : 0), go: (lv) => lv >= 1, why: (lv) => (lv >= 1 ? 'Marks the database text as data to read, never instructions to follow.' : 'Not needed: nothing from the database goes.') },
      { id: 'schema', t: 'Schema of 3 tables: invoices, customers, payments', b: () => schemaLines.reduce((a, l) => a + utf8(l[1]) + 1, 0), go: (lv) => lv >= 1, why: (lv) => (lv >= 1 ? 'Names, types and keys only. No data.' : 'Held: the level is Never send anything.') },
      { id: 'stmt', t: 'Current statement, values masked', b: () => stmtLines.slice(1).reduce((a, l) => a + utf8(l[1]) + 1, 0), go: (lv) => lv >= 2, why: (lv) => (lv >= 2 ? 'Masked on this PC: ' + mk.n + ' values become [text], [date] and [number], and the password becomes [secret].' : 'Held: needs Schema and query text.') },
      { id: 'rows', t: 'Sample rows, 3 of invoices', b: () => rowLines.reduce((a, l) => a + utf8(l[1]) + 1, 0), go: (lv) => lv >= 3, why: (lv) => (lv >= 3 ? 'A few rows of the tables the question touches, cut to fit.' : 'Held: needs Plus sample rows.') },
      { id: 'data', t: 'Every row in billing', b: () => 0, go: () => false, why: () => 'Never sent. Questions carry the schema, not your data.' },
      { id: 'secret', t: 'Passwords and your AI key', b: () => 0, go: () => false, why: () => 'Never sent. They stay in the system keyring.' },
    ];
    const hold = $('[data-lane="hold"]', root), send = $('[data-lane="send"]', root);
    const totalEl = $('[data-total]', root), heldN = $('[data-held-n]', root), sentN = $('[data-sent-n]', root);
    const xt = $('[data-xt]', root), xn = $('[data-exact-n]', root), det = $('[data-exact]', root);
    $('[data-q]', root).textContent = Q;
    const LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
    const els = {};
    ITEMS.forEach((it) => {
      const li = doc.createElement('li'); li.className = 'item' + (it.lock ? ' lock' : '') + (it.b(2) ? '' : ' never'); li.dataset.item = it.id;
      li.innerHTML = '<div class="it-h"><span class="t">' + (it.lock ? LOCK : '') + esc(it.t) + '</span><span class="b" data-b></span></div><p class="why" data-why></p>';
      els[it.id] = li;
    });
    let level = 2;
    function paintExact(lv) {
      const lines = linesFor(lv);
      xn.textContent = fmt(B(lines)) + ' bytes, ' + lines.length + ' lines, exactly as they would leave this PC at this level.';
      xt.innerHTML = lines.map((l) => '<li class="x-' + (l[0] || 'line') + '">' + esc(l[1]).replace(/\[(date|text|number|secret)\]/g, '<span class="mk">[$1]</span>') + '</li>').join('');
    }
    function update(animate) {
      const lv = level;
      $$('input[name="ai-lv"]', root).forEach((i) => { i.checked = +i.value === lv; });
      root.dataset.level = lv;
      const first = new Map();
      const anim = animate && !reduce();
      if (anim) ITEMS.forEach((it) => first.set(it.id, els[it.id].getBoundingClientRect()));
      let ns = 0, nh = 0;
      ITEMS.forEach((it) => {
        const go = it.go(lv), li = els[it.id];
        (go ? send : hold).appendChild(li);
        li.querySelector('[data-b]').textContent = go ? fmt(it.b(lv)) + ' B' : it.b(3) ? 'held' : 'never sent';
        li.querySelector('[data-why]').textContent = it.why(lv);
        if (go) ns++; else nh++;
      });
      totalEl.textContent = fmt(bytesFor(lv)) + ' bytes';
      sentN.textContent = ns + (ns === 1 ? ' item' : ' items');
      heldN.textContent = nh + (nh === 1 ? ' item' : ' items');
      paintExact(lv);
      if (anim) ITEMS.forEach((it) => {
        const a = first.get(it.id), b = els[it.id].getBoundingClientRect();
        if (!a || (Math.abs(a.left - b.left) < 2 && Math.abs(a.top - b.top) < 2)) return;
        els[it.id].animate([{ transform: 'translate(' + (a.left - b.left) + 'px,' + (a.top - b.top) + 'px)' }, { transform: 'none' }], { duration: 600, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
      });
    }
    $$('input[name="ai-lv"]', root).forEach((i) => i.addEventListener('change', () => { level = +i.value; update(true); }));
    update(false);
    return {
      setLevel(lv) { level = lv; update(true); },
      exact(open) { det.open = !!open; if (open) det.scrollIntoView({ block: 'nearest', behavior: reduce() ? 'auto' : 'smooth' }); },
      get level() { return level; }, bytesFor, linesFor, pay,
    };
  }

  /* ---------------- 02: Ask, then read the record ---------------- */
  function createAsk(pgHost, logHost, stage) {
    const LOG = K.createLog(logHost);
    const pg = K.createPlayground(pgHost, LOG);
    const status = $('[data-log-status]', stage);
    const views = $$('[data-log-view]', stage);
    const NAMES = { raw: 'Log', steps: 'Steps', diag: 'Diagram' };
    function pressed(v) { views.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.logView === v))); }
    function say(r) {
      if (!r) { status.textContent = 'No answer yet.'; return; }
      status.textContent = (r.seeded ? 'A sample record. Ask in the window above to make a new one. ' : 'The latest answer: ') + '"' + r.question + '", ' + fmt(r.pay.bytes.total) + ' B sent at ' + r.at + '.';
    }
    LOG.on((type, v) => { if (type === 'tab') pressed(v); if (type === 'record') say(v); });
    views.forEach((b) => b.addEventListener('click', () => { LOG.tab(b.dataset.logView); pressed(b.dataset.logView); }));
    /* a first record so the log is never empty: the same record a click on "Which invoices are still unpaid?" makes */
    const seed = K.makeRecord('Which invoices are still unpaid?', 'unpaid', pg.model);
    seed.seeded = true; seed.shown = 99; LOG.set(seed);
    return { LOG, pg, tab(v) { LOG.tab(v); pressed(v); }, NAMES };
  }

  /* ---------------- 03: every answer keeps its trace ---------------- */
  /* The answer log of one sample record (kit.js createLog, the app's AnswerLog: Log, Steps and Diagram over one record).
     Once in view its lines arrive in order, as they do while an answer streams; Steps and Diagram fill with them.
     Reduced motion (or html.hx-rm) shows the whole record at once. */
  function createTrace(host, replay) {
    const LOG = K.createLog(host);
    const M = {
      cards: ['invoices', 'customers', 'payments'].map((t) => ({ t })),
      ticks: [{ k: 'invoices.number' }, { k: 'customers.name' }, { k: 'invoices.total' }, { k: 'invoices.issued_at' }],
      where: [{ col: 'payments.id', op: 'is null' }, { col: 'invoices.status', op: '<>', lit: "'void'" }, { col: 'invoices.total', op: '>', lit: '500' }, { col: 'invoices.issued_at', op: '<', lit: "'2026-09-19'" }],
      order: { by: 'invoices.issued_at', dir: 'asc' }, limit: null, jt: {}, uj: [], cut: [],
    };
    const rec = K.makeRecord('Which invoices are still unpaid?', 'unpaid', M, true);
    const E = K.eventsOf(rec);
    const still = () => reduce() || doc.documentElement.classList.contains('hx-rm');
    let timers = [];
    function play() {
      timers.forEach(clearTimeout); timers = [];
      if (still()) { rec.shown = E.length; LOG.set(rec); return; }
      rec.shown = 0; LOG.set(rec);
      E.forEach((e, i) => timers.push(setTimeout(() => LOG.reveal(i + 1, true), 350 + i * 280 + Math.min(e.ms, 2000) * 0.5)));
    }
    if (replay) replay.addEventListener('click', play);
    if (still() || !('IntersectionObserver' in window)) play();
    else {
      rec.shown = 0; LOG.set(rec);
      const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); play(); } }, { threshold: 0.3 });
      io.observe(host);
    }
    return { LOG, rec, play };
  }

  /* ---------------- mount ---------------- */
  const seesRoot = $('[data-sees]');
  const sees = seesRoot ? createSees(seesRoot) : null;
  const pgHost = $('[data-ask-pg]'), logHost = $('[data-answer-log]'), stage = $('#answer-log');
  const ask = pgHost && logHost && K.createLog && K.createPlayground ? createAsk(pgHost, logHost, stage) : null;
  const traceHost = $('[data-trace-log]');
  const trace = traceHost && K.createLog && K.makeRecord ? createTrace(traceHost, $('[data-trace-replay]')) : null;
  window.ConturaTrace = trace;
  /* arriving from "Show log" on another page: land on the log, with focus on its heading */
  function land() { if (location.hash === '#answer-log' && stage) { stage.scrollIntoView({ block: 'start' }); const h = $('h3', stage); h && h.focus({ preventScroll: true }); } }
  if (location.hash === '#answer-log' && stage) {
    /* the windows above grow as they mount and fonts load, so hold the log in place until the page settles,
       unless the reader scrolls first */
    let user = false, ro = null;
    const quit = () => { user = true; if (ro) ro.disconnect(); };
    ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach((e) => addEventListener(e, quit, { once: true, passive: true }));
    land();
    if ('ResizeObserver' in window) { ro = new ResizeObserver(() => { if (!user) land(); }); ro.observe(doc.body); }
    [300, 900, 1800].forEach((ms) => setTimeout(() => { if (!user) land(); }, ms));
    setTimeout(() => { if (ro) ro.disconnect(); }, 3000);
  }

  /* ---------------- playback ---------------- */
  if (!P) return;
  const fig = (el) => el && el.closest('figure');
  if (sees) P.attach(fig(seesRoot), [
    { caption: 'Never send anything: nothing from freight-stg goes, only your question.', run: async () => { sees.exact(false); sees.setLevel(0); } },
    { caption: 'Schema only: table names, columns, types and keys cross, inside the data fence.', run: async () => { sees.setLevel(1); } },
    { caption: 'Schema and query text: the current statement crosses too, its values masked and the password redacted.', run: async () => { sees.setLevel(2); } },
    { caption: 'Plus sample rows: a few rows of the tables the question touches go too, and Sends shows them first.', run: async () => { sees.setLevel(3); } },
    { caption: 'Show the exact text: every byte that would leave this PC, masked values marked.', run: async () => { sees.exact(true); }, ms: 2600 },
  ], { reset: async () => { sees.exact(false); sees.setLevel(2); } });

  /* the Ask figure is tall on a phone (window, then the log): each step brings its part into view */
  /* not while a reader who arrived on #answer-log is still reading it */
  let fromLog = location.hash === '#answer-log';
  ['wheel', 'touchstart', 'keydown'].forEach((e) => addEventListener(e, () => { fromLog = false; }, { once: true, passive: true }));
  const bring = (el) => { if (!el || fromLog) return; const r = el.getBoundingClientRect(); if (r.top >= 60 && r.bottom <= innerHeight - 40) return; el.scrollIntoView({ block: r.height > innerHeight * 0.8 ? 'start' : 'center', behavior: reduce() ? 'auto' : 'smooth' }); };
  const attachAsk = () => P.attach(fig(pgHost), [
    { caption: 'Ask a question from the list in the Ask panel.', run: async () => { ask.pg.newChat(); ask.tab('raw'); bring(ask.pg.root.querySelector('.ask')); await ask.pg.ask('unpaid'); }, ms: 1200 },
    { caption: 'The steps ticked one by one: access, schema, tables, bytes sent with no tools, then the model.', run: async () => {}, ms: 2200 },
    { caption: 'Sends shows what the next question would carry, with its size, before you press Send.', run: async () => { ask.pg.sends(true); }, ms: 2600 },
    { caption: 'The answer log, as Steps: each step with its rule and evidence.', run: async () => { ask.pg.sends(false); bring(stage); ask.tab('steps'); } },
    { caption: 'As a Diagram: what stayed on this PC, the bytes that left, and no path to the database.', run: async () => { ask.tab('diag'); } },
    { caption: 'And as the plain Log, line by line.', run: async () => { ask.tab('raw'); } },
  ], { reset: async () => { ask.pg.sends(false); ask.pg.newChat(); ask.tab('raw'); } });
  /* arriving on #answer-log, the record you came to read is not replaced by the phone playback until you move */
  if (ask) { if (fromLog) { let done = false; ['wheel', 'touchstart', 'keydown'].forEach((e) => addEventListener(e, () => { if (!done) { done = true; attachAsk(); } }, { once: true, passive: true })); } else attachAsk(); }

  const order = { settings: ['anthropic', 'local', 'host', 'http', 'access'], errors: ['none', 'key', 'rate', 'offline'] };
  const LBL = {
    anthropic: 'Anthropic with a tested key, saved for api.anthropic.com.', local: 'A local model on this PC through a Custom endpoint over plain http.',
    host: 'The base URL changed host, so the saved key waits for your say-so.', http: 'Plain http to another host is refused.',
    access: 'AI access per Connection, and what each level sends.',
    none: 'No provider yet: Contura sends nothing until you set one up.', key: 'Key rejected: the host and status 401, never the key.',
    rate: 'Rate limited: status 429, and your question is kept.', offline: 'Offline: nothing left this PC. Retry when the network is back.',
  };
  if (F) Object.keys(order).forEach((id) => {
    const host = $('[data-frame="' + id + '"]');
    if (!host) return;
    P.attach(fig(host), order[id].map((v) => ({ caption: LBL[v], run: async () => { await F.ready(host); F.show(host, v); }, ms: 2200 })),
      { reset: async () => { try { await F.ready(host); F.show(host, order[id][0]); } catch (e) {} } });
  });
})();
