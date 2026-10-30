/* Contura site, index.html #data (loaded by launch.js when the section comes near). The Data Transfer tab (drawn after the app's TransferTab),
   the data job slices (ported from the single-page site: importer, exporter, backup, lineage, explain), and phone
   playback for each demo through ConturaPlay, driven by the same functions the controls call. The launch page uses
   only the Transfer tab and loads no ConturaPlay; the slices and playback stay idle without their hosts.
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

  /* ======================= 01 the Data Transfer tab ======================= */
  /* Drawn after the app's TransferTab (steps 3 to 5 of five: Type mapping, Review SQL, Run), with sample data.
     Source and target are set already, so the tab opens on Type mapping. The plan and the run are scripted. */
  const transfer = (function () {
    const box = $('#xfer');
    if (!box) return null;
    const STEPS = ['Source and target', 'Tables', 'Type mapping', 'Review SQL', 'Run'];
    const SRC = 'shop-local', TGT = 'freight-stg', ROWS = 1204, BATCH = 500, FAIL_ROW = 812;
    const TYPES = ['boolean', 'smallint', 'integer', 'bigint', 'numeric', 'text'];
    const COLS = [
      { c: 'id', s: 'int unsigned', t: 'bigint', note: { k: 'info', text: 'int unsigned can pass the range of integer. Copied as bigint.' } },
      { c: 'customer_id', s: 'int', t: 'integer' },
      { c: 'total', s: 'decimal(10,2)', t: 'numeric(10,2)' },
      { c: 'is_paid', s: 'tinyint(1)', t: null, note: { k: 'choice', text: 'tinyint(1) is often a flag. Pick boolean or smallint.' } },
      { c: 'status', s: 'varchar(16)', t: 'varchar(16)' },
      { c: 'created_at', s: 'datetime', t: 'timestamp' },
    ];
    const S = { step: 2, type: null, notesOnly: false, run: null };
    const stepsEl = $('#xf-steps'), body = $('#xf-body'), foot = $('#xf-foot'), failT = $('#xf-fail');
    const P2 = {
      chev: '<path d="m6 3.5 4.5 4.5L6 12.5"/>', table: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 6.2h12M6.5 6.2v7.3"/>',
      copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-3h-8v8h3"/>', query: '<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M6 8.5h4M6 11h3"/>',
      run: '<path d="M8 2.5a5.5 5.5 0 1 1-5.2 3.7"/><path d="M2.6 2.6v3.6h3.6"/>', undo: '<path d="M4 6h6a3.5 3.5 0 0 1 0 7H7"/><path d="M6.5 3.5 4 6l2.5 2.5"/>',
      wait: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2 1.3"/>', err: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.6M8 10.8v.2"/>',
    };
    const ic2 = (n) => '<svg class="xf-ic" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + (P2[n] || P[n]) + '</svg>';
    const kbd = (k) => '<kbd class="xf-kbd">' + k + '</kbd>';
    const isPaid = () => S.type || 'boolean';
    const blocked = () => !S.type;

    function paintSteps() {
      stepsEl.innerHTML = STEPS.map((s, i) => {
        const cls = i === S.step ? 'on' : i < S.step ? 'done' : '';
        return '<li class="' + cls + '"' + (i === S.step ? ' aria-current="step"' : '') + '>' + (i > 0 ? ic2('chev') : '') +
          '<span class="xf-n">' + (i < S.step ? ic2('check') : i + 1) + '</span>' + s + '</li>';
      }).join('');
    }

    /* step 3, Type mapping */
    function mapping() {
      const notes = COLS.filter((x) => x.note).length;
      const shown = S.notesOnly ? COLS.filter((x) => x.note) : COLS;
      let h = '<div class="xf-map"><nav class="xf-side" aria-label="Ticked tables"><span class="xf-flab">Tables</span>' +
        '<button type="button" class="xf-tb on" aria-current="true">' + ic2('table') + '<span class="m">orders</span><span class="xf-chip" aria-label="' + notes + ' notes">' + notes + '</span></button></nav>' +
        '<section class="xf-main" aria-label="Columns of orders"><header class="xf-pane"><span class="xf-sect m">orders</span><span class="xf-count">' + COLS.length + ' columns, ' + notes + ' notes' + (blocked() ? ', 1 needs a choice' : '') + '</span><span class="xf-sp"></span>' +
        '<div class="seg" role="group" aria-label="Show columns"><button type="button" data-notes="0" aria-pressed="' + !S.notesOnly + '">All ' + COLS.length + ' columns</button><button type="button" data-notes="1" aria-pressed="' + S.notesOnly + '">Notes only ' + notes + '</button></div></header>';
      if (blocked()) h += '<div class="xf-ban warn" role="status">' + ic2('alert') + '<span>1 column needs a choice before Review SQL. Every type here can be changed; the SQL in the next step uses what you set.</span></div>';
      h += '<div class="xf-grid"><div class="xf-box"><table class="xf-lt"><thead><tr><th>Column</th><th>MySQL type</th><th class="w0"><span class="sr">becomes</span></th><th>PostgreSQL type</th><th class="xf-ncol">Note</th></tr></thead><tbody>';
      shown.forEach((x) => {
        const pick = x.note && x.note.k === 'choice';
        const att = pick && !S.type;
        h += '<tr' + (att ? ' class="att"' : '') + '><td class="m">' + x.c + '</td><td class="m xf-src">' + esc(x.s) + '</td><td>' + ic2('arrow') + '</td><td>' +
          (pick ? '<input class="xf-type' + (att ? ' warn' : '') + '" list="xf-types" aria-label="Target type of orders.' + x.c + '" placeholder="Pick a type" value="' + (S.type || '') + '" autocomplete="off" spellcheck="false">'
                : '<span class="xf-type ro">' + esc(x.t) + '</span>') +
          '</td><td class="xf-ncol">' + (x.note ? '<span class="xf-note' + (x.note.k === 'choice' && !S.type ? ' warn' : '') + '">' + ic2(x.note.k === 'choice' ? 'alert' : 'info') + '<span>' + esc(x.note.text) + '</span></span>' : '') + '</td></tr>';
      });
      h += '</tbody></table></div></div></section></div><datalist id="xf-types">' + TYPES.map((t) => '<option value="' + t + '">').join('') + '</datalist>';
      body.innerHTML = h;
      foot.innerHTML = '<span class="xf-hint">' + notes + ' notes. Rows that do not fit their new type stop the run with the row number.</span><span class="xf-sp"></span>' +
        '<button type="button" class="xf-btn" disabled title="Source, target and tables are set in this sample">Back ' + kbd('Alt+Left') + '</button>' +
        '<button type="button" class="xf-btn pri" data-next' + (blocked() ? ' disabled title="Pick a type for orders.is_paid first"' : '') + '>Next: Review SQL ' + kbd('Ctrl+Enter') + '</button>';
      const inp = $('.xf-type[list]', body);
      if (inp) {
        const set = (commit) => {
          const v = inp.value.trim().toLowerCase();
          if (TYPES.includes(v)) { if (v !== S.type) { S.type = v; paint(); $('.xf-type[list]', body).focus(); } }
          else if (commit) inp.value = S.type || '';
        };
        inp.addEventListener('input', () => set(false));
        inp.addEventListener('change', () => set(true));
        inp.addEventListener('blur', () => set(true));
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); set(true); } else if (e.key === 'Escape') inp.value = S.type || ''; });
      }
    }

    /* step 4, Review SQL */
    const SQL = [
      ['c', '-- Tables'],
      ['', '<span class="k">CREATE TABLE</span> freight.orders ('],
      ['', '  id <span class="t">bigint</span> <span class="k">NOT NULL</span>,'],
      ['', '  customer_id <span class="t">integer</span> <span class="k">NOT NULL</span>,'],
      ['', '  total <span class="t">numeric</span>(<span class="n">10</span>,<span class="n">2</span>) <span class="k">NOT NULL</span>,'],
      ['', '  is_paid <span class="t">TYPE</span> <span class="k">NOT NULL</span>,'],
      ['', '  status <span class="t">varchar</span>(<span class="n">16</span>) <span class="k">NOT NULL</span>,'],
      ['', '  created_at <span class="t">timestamp</span> <span class="k">NOT NULL</span>,'],
      ['', '  <span class="k">PRIMARY KEY</span> (id)'],
      ['', ');'],
      ['', ''],
      ['c', '-- The rows are copied here'],
      ['', ''],
      ['c', '-- Indexes, after the rows'],
      ['', '<span class="k">CREATE INDEX</span> orders_customer_id_idx <span class="k">ON</span> freight.orders (customer_id);'],
    ];
    const sqlText = () => SQL.map((l) => l[1].replace('TYPE', isPaid()).replace(/<[^>]+>/g, '')).join('\n');
    function review() {
      let h = '<div class="xf-review"><section class="xf-box" aria-label="Structure SQL"><header class="xf-pane"><span class="xf-sect">Structure</span><span class="xf-count">The exact statements, in the order they run.</span><span class="xf-sp"></span>' +
        '<button type="button" class="xf-btn sm" data-copy>' + ic2('copy') + '<span>Copy</span></button><span class="xf-btn sm off" title="Opens a query tab on freight-stg in the app">' + ic2('query') + 'Open in editor</span></header>' +
        '<ol class="xf-code" tabindex="0" aria-label="Structure SQL, read-only">' + SQL.map((l) => '<li' + (l[0] ? ' class="' + l[0] + '"' : '') + '><span>' + (l[1].replace('TYPE', isPaid()) || ' ') + '</span></li>').join('') + '</ol></section>' +
        '<section class="xf-box" aria-label="Row copies"><header class="xf-pane"><span class="xf-sect">Rows</span><span class="xf-count">The rows are those in the source when the run starts.</span></header>' +
        '<ul class="xf-copies"><li><span class="m">orders: INSERT INTO freight.orders (id, customer_id, total, is_paid, status, created_at) VALUES ... ' + fmt(ROWS) + ' rows in batches of ' + fmt(BATCH) + '</span><span class="xf-btn sm off" title="Shows the first INSERT, from 4 rows, in the app">Show sample</span></li></ul></section>' +
        '<p class="xf-hint">PostgreSQL target: everything runs in one transaction. Cancel rolls it all back.</p></div>';
      body.innerHTML = h;
      foot.innerHTML = '<span class="xf-sp"></span><button type="button" class="xf-btn" data-back>Back ' + kbd('Alt+Left') + '</button><button type="button" class="xf-btn pri" data-run>Run ' + kbd('Ctrl+Enter') + '</button>';
    }

    /* step 5, Run */
    const time = (ms) => (Math.max(0, ms) / 1000).toFixed(1) + 's';
    function runView() {
      const r = S.run, ok = r.outcome === 'finished', failed = r.outcome === 'failed', cancelled = r.outcome === 'cancelled', running = !r.outcome;
      const stopped = failed || cancelled;
      const title = ok ? 'Copied 1 table, ' + fmt(ROWS) + ' rows in ' + time(r.ms) + '.' : failed ? 'Transfer stopped, nothing was written' : cancelled ? 'Transfer cancelled' : 'Copying 1 table to ' + TGT;
      const pct = ok ? 100 : Math.round((r.done / ROWS) * 100);
      const st = ok ? ['check', 'Done', 'ok'] : failed ? ['err', 'Failed', 'bad'] : cancelled ? ['undo', 'Rolled back', 'back'] : ['run', 'Copying', 'run'];
      let h = '<div class="xf-run"><section class="xf-box xf-run-head" aria-label="Run"><div class="xf-line"><span class="xf-sect">' + title + '</span><span class="xf-sp"></span>' +
        (running ? '<span class="xf-time">' + Math.floor(r.ms / 1000) + 's elapsed</span>' : stopped ? '<span class="xf-time">' + Math.floor(r.ms / 1000) + 's</span>' : '') +
        (ok ? '<span class="xf-btn pri off" title="Opens freight.orders in the tree in the app">Open in the target tree</span>' : '') + '</div>' +
        '<div class="xf-pb big' + (failed ? ' bad' : '') + '" role="progressbar" aria-label="Transfer progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><b style="width:' + pct + '%"></b></div>' +
        '<div class="xf-line xf-sub"><span>' + fmt(ok ? ROWS : r.done) + ' of ' + fmt(ROWS) + ' rows</span><span class="xf-sp"></span><span>Structure: 1 table, 1 index created' + (stopped ? ', then rolled back' : '') + '. Foreign Keys are added after the rows.</span></div></section>';
      if (failed) h += '<div class="xf-ban bad" role="alert">' + ic2('alert') + '<span><b>orders, row ' + fmt(FAIL_ROW) + ', id ' + FAIL_ROW + ':</b> the value 0000-00-00 00:00:00 is not valid for timestamp in created_at. The transaction rolled back, so ' + TGT + ' is as it was.</span><button type="button" class="xf-btn sm" data-copyerr>' + ic2('copy') + '<span>Copy error</span></button></div>';
      h += '<div class="xf-box"><table class="xf-lt"><thead><tr><th class="w0"><span class="sr">State icon</span></th><th>Table</th><th class="xf-pcol">Progress</th><th class="r">Rows</th><th class="r">Time</th><th>State</th></tr></thead><tbody>' +
        '<tr' + (failed ? ' class="err"' : '') + '><td class="xf-st ' + st[2] + '">' + ic2(st[0]) + '</td><td class="m">orders</td><td><div class="xf-pb' + (failed ? ' bad' : '') + '"><b style="width:' + pct + '%"></b></div></td>' +
        '<td class="r">' + fmt(ok ? ROWS : r.done) + ' of ' + fmt(ROWS) + '</td><td class="r">' + time(r.ms) + '</td><td class="xf-st ' + st[2] + '">' + st[1] + '</td></tr></tbody></table></div>';
      if (running) h += '<p class="xf-hint">PostgreSQL target: everything runs in one transaction. Cancel rolls it all back. Reading ' + SRC + ' takes no locks beyond one consistent snapshot.</p>';
      if (failed) h += '<p class="xf-hint">Fix the value in ' + SRC + ', or set created_at to text on Type mapping, then run again.</p>';
      h += '</div>';
      body.innerHTML = h;
      foot.innerHTML = (running ? '<span class="xf-hint">You can keep working in other tabs.</span><span class="xf-sp"></span><button type="button" class="xf-btn" data-cancel>Cancel and roll back</button>'
        : '<span class="xf-hint">Recorded in Query History for ' + TGT + '.</span><span class="xf-sp"></span>' +
          (stopped ? '<button type="button" class="xf-btn" data-tomap>Back to Type mapping</button><button type="button" class="xf-btn pri" data-run>' + ic2('run') + 'Run again ' + kbd('Ctrl+Enter') + '</button>' : '<button type="button" class="xf-btn" data-tomap>Start over</button>'));
    }

    function paint() {
      paintSteps();
      if (S.step === 2) mapping(); else if (S.step === 3) review(); else runView();
    }
    function go(step) { if (S.run && !S.run.outcome) return; S.step = step; if (step < 4) S.run = null; paint(); const f = $('.xf-btn.pri:not([disabled]), [data-run], .xf-type[list]', box); if (f && step !== 2) f.focus({ preventScroll: true }); }

    async function run() {
      if (S.run && !S.run.outcome) return;
      const fail = failT.checked;
      const r = (S.run = { done: 0, ms: 0, outcome: null, cancel: false });
      S.step = 4; paint();
      const t0 = performance.now();
      for (let done = 0; ;) {
        await sleep(260);
        if (S.run !== r) return;
        r.ms = performance.now() - t0;
        if (r.cancel) { r.outcome = 'cancelled'; break; }
        const next = Math.min(ROWS, done + BATCH);
        if (fail && next >= FAIL_ROW) { r.done = done; r.outcome = 'failed'; break; }
        done = r.done = next;
        if (done >= ROWS) { r.outcome = 'finished'; break; }
        runView();
      }
      r.ms = Math.max(r.ms, 1);
      runView();
      const f = $('.xf-btn.pri[data-run], [data-tomap]', box); if (f) f.focus({ preventScroll: true });
    }

    box.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.notes) { S.notesOnly = b.dataset.notes === '1'; paint(); }
      else if ('next' in b.dataset) go(3);
      else if ('back' in b.dataset) go(2);
      else if ('tomap' in b.dataset) go(2);
      else if ('run' in b.dataset) run();
      else if ('cancel' in b.dataset) { if (S.run) S.run.cancel = true; }
      else if ('copy' in b.dataset || 'copyerr' in b.dataset) {
        const text = 'copy' in b.dataset ? sqlText() : $('.xf-ban.bad > span', box).textContent;
        const lab = $('span', b);
        const done = () => { lab.textContent = 'Copied'; };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => undefined);
      }
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (S.step === 2 && !blocked()) go(3); else if (S.step === 3 || (S.step === 4 && S.run && S.run.outcome && S.run.outcome !== 'finished')) run();
      } else if (e.key === 'ArrowLeft' && e.altKey && S.step === 3) { e.preventDefault(); go(2); }
    });
    paint();
    return { pick: (v) => { S.type = v; paint(); }, go, run };
  })();

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
      ['-- Contura backup, format 1', '-- made-by: Contura 1.0.0', '-- dialect: PostgreSQL', '-- server-version: 16.4', '-- database: freight', '-- schemas: billing', '-- taken-at: 2026-10-16T22:00:00Z', '-- not-included: extension pgcrypto, large objects,', '--   grants, roles']
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
