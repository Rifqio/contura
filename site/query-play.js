/* Contura site, query.html: phone full playback for the SQL editor, the data grid and the Visual Query playground.
   Uses ConturaDemos.get, ConturaKit.getPlayground and ConturaPlay. playback.js is loaded here, so the page needs only
   this one script tag. */
(function () {
  'use strict';
  function start() {
    const K = window.ConturaKit, D = window.ConturaDemos, P = window.ConturaPlay;
    if (!P || !D) return;
    const $ = (s) => document.querySelector(s);
    const fig = (el) => el && el.closest('figure');
    const wait = (c, ms) => c.wait(ms);

    const edHost = $('[data-editor]');
    const ed = edHost && D.get(edHost);
    if (ed) P.attach(fig(edHost), [
      { caption: 'Put the line in the UPDATE that has no WHERE. It would change every invoice.', run: async () => { ed.select(2); } },
      { caption: 'Press Run. Contura stops and asks first, because an UPDATE without WHERE changes every row.', run: async () => { ed.run(); }, ms: 2400 },
      { caption: 'Add WHERE puts the clause back into the statement, ready for you to finish it.', run: async () => { const b = ed.$('[data-addwhere]'); if (b) b.click(); }, ms: 2200 },
    ], { reset: async () => { ed.reset(); } });

    const gridHost = $('[data-grid]');
    const grid = gridHost && D.get(gridHost);
    if (grid) P.attach(fig(gridHost), [
      { caption: 'Double-click a total to edit it.', run: async (c) => { grid.setConn(false); grid.startEdit(0, 3); await wait(c, 700); const v = grid.rows[0].v[3]; grid.typeEdit((Math.round((Number(v) + 100) * 100) / 100).toFixed(2)); } },
      { caption: 'The new value waits as a Pending Edit. Nothing is written yet.', run: async () => { grid.commitEdit(); } },
      { caption: 'Preview SQL shows the UPDATE that Save will run.', run: async () => { grid.setPreview(true); } },
      { caption: 'Switch the Connection to freight-prod, a Production Connection.', run: async () => { grid.setConn(true); } },
      { caption: 'Save on PROD asks before it writes, with the exact statement.', run: async () => { grid.save(); } },
      { caption: 'Your yes saves it in one transaction.', run: async () => { grid.confirm(true); } },
    ], { reset: async () => { grid.reset(); grid.setConn(false); } });

    const pgHost = $('#visual [data-playground]');
    const pg = pgHost && K && K.getPlayground && K.getPlayground(pgHost);
    if (pg) P.attach(fig(pgHost), [
      { caption: 'Drag payments from the tree onto the canvas.', run: async () => { pg.reset(); pg.addTable('payments'); }, ms: 1500 },
      { caption: 'Tick the amount and the method.', run: async (c) => { pg.tick('payments.amount'); await wait(c, 600); pg.tick('payments.method'); }, ms: 1500 },
      { caption: 'Press Run. Visual Query builds a SELECT, so it reads and never writes.', run: async () => { await pg.run(); }, ms: 1800 },
    ], { reset: async () => { pg.reset(); } });
  }
  if (window.ConturaPlay) return start();
  const s = document.createElement('script');
  s.src = 'playback.js' + (document.currentScript && /\?v=[^&]*/.test(document.currentScript.src) ? document.currentScript.src.match(/\?v=[^&]*/)[0] : '');
  s.onload = start; document.head.appendChild(s);
})();
