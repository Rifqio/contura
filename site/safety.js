/* Contura site, safety.html: the held write in the hero, the folder that travels without its secrets, and the
   scripted playback for every demo on the page (playback.js). The windows themselves come from demos.js and frames.js. */
(function () {
  'use strict';
  const doc = document;
  const K = window.ConturaKit, D = window.ConturaDemos, F = window.ConturaFrames, P = window.ConturaPlay;
  const $ = (s, r) => (r || doc).querySelector(s), $$ = (s, r) => [...(r || doc).querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- hero: one held write (ported from the Route Map, restyled) ---------------- */
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
    return { go, yes, no, reset, setMode, get state() { return state; } };
  }

  /* ---------------- 04: the folder travels, the secrets stay ---------------- */
  function createMove(root) {
    const btn = $('[data-copy]', root), dest = $('[data-dest]', root), status = $('[data-move-status]', root);
    let copied = false;
    function paint() {
      root.classList.toggle('is-copied', copied);
      btn.textContent = copied ? 'Start over' : 'Copy the folder to another PC';
      btn.setAttribute('aria-pressed', String(copied));
      status.textContent = copied ? 'Copied. The setup came along; the passwords and AI keys stayed in this PC\'s keyring.' : '';
    }
    const copy = () => { copied = true; paint(); };
    const reset = () => { copied = false; root.classList.remove('hl-conn', 'hl-vault'); paint(); };
    btn.addEventListener('click', () => (copied ? reset() : copy()));
    paint();
    return { copy, reset, mark(k) { root.classList.toggle('hl-conn', k === 'conn'); root.classList.toggle('hl-vault', k === 'vault'); }, dest };
  }

  /* ---------------- mount ---------------- */
  const holdHost = $('[data-hold]'), holdSeg = holdHost && doc.getElementById(holdHost.dataset.hold);
  const hold = holdHost && holdSeg ? createHold(holdHost, holdSeg) : null;
  const moveRoot = $('[data-move]');
  const move = moveRoot ? createMove(moveRoot) : null;

  /* ---------------- playback: each step runs the demo's own code path ---------------- */
  if (!P) return;
  const fig = (el) => el && el.closest('figure');
  const wait = (c, ms) => c.wait(ms);

  if (hold) P.attach(fig(holdHost), [
    { caption: 'Press Run on freight-prod, a Production Connection.', run: async () => { hold.setMode('prod'); hold.go(); } },
    { caption: 'Production holds the write: Waiting for your review, with the exact SQL above it.', run: async () => {} },
    { caption: 'Your yes runs it, and only then.', run: async () => { await hold.yes(); } },
    { caption: 'Now mark freight-prod Read-only.', run: async () => { hold.setMode('ro'); } },
    { caption: 'Run the same UPDATE: Blocked, and the server session is read-only as a backstop.', run: async () => { hold.go(); } },
  ], { reset: async () => { hold.setMode('prod'); } });

  const gridHost = $('#grid [data-grid]');
  const grid = gridHost && D && D.get(gridHost);
  if (grid) P.attach(fig(gridHost), [
    { caption: 'Double-click a total on freight-prod to edit it.', run: async (c) => { grid.startEdit(0, 3); await wait(c, 700); const v = grid.rows[0].v[3]; grid.typeEdit((Math.round((Number(v) + 100) * 100) / 100).toFixed(2)); } },
    { caption: 'The new value waits as a Pending Edit. Nothing is written yet.', run: async () => { grid.commitEdit(); } },
    { caption: 'Preview SQL shows the UPDATE that Save will run.', run: async () => { grid.setPreview(true); } },
    { caption: 'Save on PROD asks before it writes, with the exact statement.', run: async () => { grid.save(); } },
    { caption: 'Your yes saves it in one transaction.', run: async () => { grid.confirm(true); } },
  ], { reset: async () => { grid.reset(); grid.setConn(true); } });

  const edHost = $('#prod-editor [data-editor]');
  const ed = edHost && D && D.get(edHost);
  if (ed) P.attach(fig(edHost), [
    { caption: 'Put the line in the UPDATE, a write on freight-prod.', run: async () => { ed.setConn('prod'); ed.select(1); } },
    { caption: 'Run asks first: one dialog with the exact SQL, marked writes.', run: async () => { ed.run(); } },
    { caption: 'Cancel, and nothing runs on freight-prod.', run: async () => { ed.confirm(false); } },
    { caption: 'Run all lists every statement: two of three write, and each is labelled.', run: async () => { ed.runAll(); } },
    { caption: 'The DELETE has no WHERE, so its warning comes first and Run turns red. Cancel again.', run: async (c) => { await wait(c, 1600); ed.confirm(false); }, ms: 1400 },
  ], { reset: async () => { ed.reset(); ed.setConn('prod'); } });

  const roHost = $('#readonly [data-editor]');
  const ro = roHost && D && D.get(roHost);
  if (ro) P.attach(fig(roHost), [
    { caption: 'Put the line in the UPDATE on a Read-only Connection.', run: async () => { ro.setConn('ro'); ro.select(1); } },
    { caption: 'Run is off for a write, and the note says why.', run: async () => { ro.run(); } },
    { caption: 'If a write ever got through, the server would refuse it.', run: async () => { ro.backstop(); } },
    { caption: 'Reads still run as usual.', run: async () => { ro.select(0); ro.run(); } },
  ], { reset: async () => { ro.reset(); ro.setConn('ro'); } });

  const frHost = $('[data-frame="sources"]');
  if (frHost && F) {
    const LBL = {
      import: 'An import into freight-prod waits for a confirm on Production.',
      restore: 'A restore on freight-prod names the file and asks first.',
      compare: 'Compare\'s Apply on PROD shows the Sync Script before it runs.',
      edits: 'Pending Edits: Save on PROD lists the exact statements.',
      assistant: 'SQL the assistant wrote goes through the same confirm, marked as written by the assistant.',
    };
    const order = ['import', 'restore', 'compare', 'edits', 'assistant'];
    P.attach(fig(frHost), order.map((v) => ({ caption: LBL[v], run: async () => { await F.ready(frHost); F.show(frHost, v); }, ms: 2200 })),
      { reset: async () => { try { await F.ready(frHost); F.show(frHost, order[0]); } catch (e) {} } });
  }

  if (move) P.attach(fig(moveRoot), [
    { caption: 'Copy the folder to another PC or a USB drive.', run: async () => { move.copy(); } },
    { caption: 'Settings, Groups, Connections, Query History and Saved Queries come along.', run: async () => { move.mark('conn'); } },
    { caption: 'The passwords and AI keys stay in this PC\'s system keyring.', run: async () => { move.mark('vault'); } },
  ], { reset: async () => { move.reset(); } });
})();
