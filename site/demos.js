/* Contura site: two more live app windows built on ConturaKit (the playground's app CSS, icons, sample data and the
   pinned sql.js loader). [data-editor]: the SQL editor that runs the current statement and asks before a write with no
   WHERE. [data-grid]: the data grid whose edits wait as Pending Edits, with Preview SQL and one-transaction Save.
   Nothing here talks to a network except the sql.js load on the first Run or Save.
   2026-10-21 (Safety page): the editor takes a Connection switch (data-editor="<seg id>", button[data-conn] stg, prod
   or ro), a preset text (data-preset) and Run all (data-runall). On a Production Connection Run asks first in one
   dialog that labels each statement writes or reads; on a Read-only one, writes are off with the reason. The grid
   starts on whichever button[data-conn] is pressed. Both windows return an API for scripted playback, and
   window.ConturaDemos exports shell, tab, the SQL helpers, createEditor, createGrid and get(host). */
(function () {
  'use strict';
  const K = window.ConturaKit;
  if (!K) return;
  const { APP_CSS, PG_CSS, DEFS, ic, MARK, T, DATA, FULLTYPE, FEAT, bus, getDB, fmt, esc, dur, reduced, coarse } = K;
  const doc = document;

  const DEFS2 = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
    '<symbol id="v-trash" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></symbol>' +
    '<symbol id="v-undo" viewBox="0 0 24 24"><path d="M9 7 5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-3"/></symbol>' +
    '<symbol id="v-code" viewBox="0 0 24 24"><path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5M10.5 12l-2 2 2 2M13.5 12l2 2-2 2"/></symbol>' +
    '<symbol id="v-reload" viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19 4.5v4h-4"/></symbol>' +
    '<symbol id="v-save" viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/></symbol>' +
    '<symbol id="v-warn" viewBox="0 0 24 24"><path d="M12 4 3 19.5h18z"/><path d="M12 10v4.5M12 17v.2"/></symbol>' +
    '<symbol id="v-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></symbol>' +
    '</defs></svg>';

  const ED_CSS = `
.ew .mn{grid-template-columns:236px minmax(0,1fr);height:620px}
.ew.M .mn{grid-template-columns:200px minmax(0,1fr);height:600px;grid-template-rows:none}
.ew.S .mn{grid-template-columns:minmax(0,1fr);height:auto}
.ew.S .side{display:none}
.pane{background:var(--surface);border:1px solid var(--bsub);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;min-width:0;min-height:0;position:relative}
.S .pane{min-height:560px}
.hbar{height:36px;flex-shrink:0;display:flex;align-items:center;gap:8px;padding:0 8px;border-bottom:1px solid var(--bsub);min-width:0;white-space:nowrap}
.hbar .sp{flex:1}
.S .hbar .hide-s{display:none}
div.ed{flex:1 1 52%;min-height:0;overflow:auto;display:grid;grid-template-columns:44px minmax(0,1fr);font-family:"JetBrains Mono","Cascadia Mono",Consolas,monospace;font-size:12.5px;line-height:20px;scrollbar-width:thin;scrollbar-color:var(--border) transparent;border-bottom:1px solid var(--bsub)}
.S div.ed{flex:none;height:260px}
.coarse div.ed{font-size:16px;line-height:24px}
.gut{padding:10px 10px 10px 0;text-align:right;color:var(--faint);user-select:none;font-variant-numeric:tabular-nums;position:sticky;left:0;background:var(--surface);z-index:1}
.gut div.cs{color:var(--text)}
.code{position:relative;min-width:max-content}
.code pre,.code textarea{margin:0;padding:10px 16px 10px 12px;font:inherit;white-space:pre;tab-size:2;letter-spacing:0}
.code pre .l{min-height:20px;margin:0 -16px 0 -12px;padding:0 16px 0 12px}
.coarse .code pre .l{min-height:24px}
.code pre .l.cs{background:color-mix(in srgb,var(--accent) 9%,transparent);box-shadow:inset 2px 0 0 var(--accent)}
.code textarea{position:absolute;inset:0;width:100%;height:100%;resize:none;border:0;outline:0;background:transparent;color:transparent;caret-color:var(--text);overflow:hidden;box-sizing:border-box}
.code textarea::selection{background:color-mix(in srgb,var(--accent) 30%,transparent);color:transparent}
div.ed:focus-within{box-shadow:inset 0 0 0 1px var(--accent)}
.x-c{color:var(--cmt);font-style:italic}
.qconf{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;background:var(--warn-sub);color:var(--text);border-bottom:1px solid var(--bsub);font-size:12px}
.qconf .ui{color:var(--warn-t)}
.qconf p{margin:0;flex:1 1 260px;min-width:0}
.qconf code{font-family:"JetBrains Mono",Consolas,monospace;font-size:11.5px}
.b-danger{height:24px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;background:var(--bad);color:var(--ink);font-weight:600;border-radius:4px;white-space:nowrap}
.btn.b-danger:hover{background:var(--bad);filter:brightness(1.08)}
.res{flex:1 1 48%;min-height:0;display:flex;flex-direction:column}
.S .res{flex:none;height:300px}
.rtabs{height:36px;flex-shrink:0;display:flex;align-items:center;gap:2px;padding:0 8px 0 4px;border-bottom:1px solid var(--bsub);min-width:0}
.rtabs .sum{margin-left:auto;font-size:12px;color:var(--subtle);white-space:nowrap;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;min-width:0}
.rbody{flex:1;min-height:0;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.rfoot{height:28px;flex-shrink:0;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:12px;color:var(--subtle);border-top:1px solid var(--bsub);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.rmsg{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;color:var(--subtle);padding:12px 16px;font-size:12px}
.rmsg b{font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;font-size:15px;line-height:20px;font-weight:600;color:var(--text)}
.rmsg.err b{color:var(--bad)}
.rmsg .mono{font-size:11.5px;color:var(--muted);max-width:60ch;white-space:normal}
.gr.in{animation:rin .5s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i,0) * 22ms)}
@keyframes rin{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
/* data grid */
.dg{flex:1;min-height:0;overflow:auto;outline:none;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.dg:focus-visible{box-shadow:inset 0 0 0 2px var(--accent)}
.dg .gr > span{position:relative}
.dg .gr.d > span:not(:first-child){cursor:cell}
.dg .gr.d > span.sel{box-shadow:inset 0 0 0 2px var(--accent)}
.dg .gr.d > span.ed{background:var(--warn-sub);box-shadow:inset 2px 0 0 var(--warn)}
.dg .gr.d > span.ed.sel{box-shadow:inset 2px 0 0 var(--warn),inset 0 0 0 2px var(--accent)}
.dg .gr.d.add > span{background:var(--ok-sub)}
.dg .gr.d.add > span:first-child{color:var(--ok);font-weight:600}
.dg .gr.d.del > span{background:var(--bad-sub)}
.dg .gr.d.del > span:not(:first-child){text-decoration:line-through;color:var(--faint)}
.dg .gr.d.del > span:first-child{color:var(--bad);font-weight:600}
.dg .def{color:var(--subtle);font-style:italic}
.dg .gr.d > span.editing{padding:0}
.dg input.ce{all:unset;box-sizing:border-box;width:100%;height:100%;padding:0 8px;background:var(--surface);color:var(--text);font:inherit;box-shadow:inset 0 0 0 2px var(--accent);border-radius:4px}
.ebar{min-height:40px;flex-shrink:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px 6px 10px;border-top:1px solid var(--bsub);background:var(--panel);animation:rin .45s cubic-bezier(.16,1,.3,1)}
.ebar .es{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 140px}
.b-prod{height:24px;padding:0 6px 0 10px;display:inline-flex;align-items:center;gap:6px;background:var(--prod);color:var(--ink);font-weight:600;border-radius:4px;white-space:nowrap}
.btn.b-prod:hover{background:var(--prod);filter:brightness(1.08)}
.b-prod .kbd{background:transparent;color:inherit;border-color:color-mix(in srgb,var(--ink) 45%,transparent)}
.b-sub.on{background:var(--active);color:var(--text)}
.pv{flex-shrink:0;max-height:200px;display:flex;flex-direction:column;border-top:1px solid var(--bsub);background:var(--surface)}
.pv .ph{min-height:30px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 10px;background:var(--panel);border-bottom:1px solid var(--bsub);font-size:12px;color:var(--subtle)}
.pv .ph b{color:var(--text);font-weight:600}
.pv .pb{overflow:auto;padding:6px 0;scrollbar-width:thin}
.sqll{display:grid;grid-template-columns:36px minmax(0,1fr);font-family:"JetBrains Mono",Consolas,monospace;font-size:11.5px;line-height:18px;white-space:pre}
.sqll .n{text-align:right;padding-right:10px;color:var(--faint);user-select:none}
.sqll.w{box-shadow:inset 2px 0 0 var(--warn)}
.sqll.wp{background:var(--prod-sub);box-shadow:inset 3px 0 0 var(--prod)}
.scrim{position:absolute;inset:0;z-index:30;background:var(--scrim);display:flex;align-items:center;justify-content:center;padding:16px;animation:fade .3s cubic-bezier(.16,1,.3,1)}
@keyframes fade{from{opacity:0}to{opacity:1}}
.dlg{width:min(560px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--raised);border:1px solid var(--border);border-radius:8px;box-shadow:var(--sh2);overflow:hidden;animation:rin .45s cubic-bezier(.16,1,.3,1)}
.dlg .dh{min-height:44px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid var(--bsub);font-size:14px}
.dlg .dbd{padding:10px 0;overflow:auto;background:var(--surface)}
.dlg .df{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--bsub)}
.sbar .ok{color:var(--ok)}
/* Production and Read-only marks in the editor (Next Screens 2, frames h and i) */
.chip.c-ro{background:var(--active);color:var(--muted);font-weight:600}
.chip.c-ro svg{flex-shrink:0}
.code pre .l.pw{background:color-mix(in srgb,var(--prod) 8%,transparent)}
.code pre .l.ro{background:color-mix(in srgb,var(--subtle) 11%,transparent)}
.code pre .l.cs.pw,.code pre .l.cs.ro{box-shadow:inset 2px 0 0 var(--accent)}
.gut div{position:relative}
.gut div.pw{box-shadow:inset -3px 0 0 var(--prod)}
.gut div.ro{box-shadow:inset -3px 0 0 var(--faint);color:var(--muted)}
.gut .lk{position:absolute;left:5px;top:4px;color:var(--muted)}
.coarse .gut .lk{top:6px}
.ronote{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;padding:8px 10px;background:var(--panel);color:var(--text);border-bottom:1px solid var(--bsub);box-shadow:inset 3px 0 0 var(--faint);font-size:12px}
.ronote > svg{margin-top:1px;color:var(--muted)}
.ronote p{margin:0;flex:1 1 260px;min-width:0;color:var(--muted)}
.ronote p b{color:var(--text);font-weight:600}
.btn.off:not(.pbtn){opacity:.6;cursor:default}
.btn.pbtn.off,.btn.pbtn.off:hover{background:var(--active);color:var(--faint);filter:none;cursor:default}
.btn.pbtn.off .kh{color:var(--faint);border-color:var(--border)}
.btn.b-sec.off:hover{background:var(--surface)}
.cfd{width:min(640px,100%)}
.cfd .cnt{margin-left:auto;font-size:12px;color:var(--subtle)}
.cfd .nw{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;padding:8px 14px;background:var(--bad-sub);border-bottom:1px solid var(--bsub);font-size:12px}
.cfd .nw > svg{color:var(--bad);margin-top:1px}
.cfd .nw p{margin:0;flex:1 1 160px;min-width:0}
.cfd .dbd:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--accent)}
.cfd .sqll{position:relative}
.cfd .rw{position:absolute;right:10px;top:1px;height:16px;line-height:16px;padding:0 6px;border-radius:4px;font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;font-size:11px;font-weight:600}
.cfd .rw.w{background:var(--prod-sub);color:var(--prod-t)}
.cfd .rw.r{background:var(--active);color:var(--muted)}
.S .cfd .rw{position:static;display:inline-block;margin-left:10px;vertical-align:top}
[data-hconn]{overflow:hidden;flex:0 1 auto}
.S .hbar .vdiv{display:none}
.cfd .df{flex-wrap:wrap;align-items:center}
.cfd .df .hint{margin-right:auto;flex:1 1 220px;min-width:0;font-size:12px;color:var(--subtle)}
@media (prefers-reduced-motion: reduce){.gr.in,.ebar,.scrim,.dlg{animation:none}}
`;
  const REG = new WeakMap();

  const featBar = () => '<div class="fbar" aria-hidden="true">' + FEAT.map((g) => '<div class="fg">' + g.map(([id, l, f]) => '<div class="fi f-' + f + '">' + ic('i-' + id, 28, 'ic') + '<span>' + l + '</span></div>').join('') + '</div>').join('') + '<div style="flex:1"></div><div class="fi f-query" style="min-width:56px">' + ic('i-ask', 28, 'ic') + '<span>Ask</span></div></div>';

  /* the object tree; with prod, freight-prod is the open Connection instead of freight-stg */
  function tree(open, prod) {
    const tables = ['customers', 'invoices', 'order_items', 'orders', 'payments', 'plans'];
    const kids = '<div style="position:relative"><div class="guide" style="left:35px;top:0;bottom:0"></div>' +
      '<div class="trow" style="padding-left:48px">' + ic('u-chev', 14, 'ui', 'color:var(--subtle)') + '<span>billing</span></div>' +
      '<div style="position:relative"><div class="guide" style="left:55px;top:0;bottom:0"></div>' +
      tables.map((t) => '<div class="trow" style="padding-left:68px;' + (t === open ? 'background:var(--active);' : '') + '">' + ic('i-table', 16, 'ic f-obj') + '<span class="mono" style="font-size:12px' + (t === open ? ';color:var(--text);font-weight:600' : '') + '">' + t + '</span><span class="tnum" style="margin-left:auto;font-size:12px;color:var(--subtle)">' + fmt(DATA[t].length) + '</span></div>').join('') +
      '</div><div class="trow" style="padding-left:48px">' + ic('u-chev', 14, 'ui', 'color:var(--subtle);transform:rotate(-90deg)') + '<span>Saved Queries</span><span class="tnum" style="margin-left:auto;font-size:12px;color:var(--subtle)">3</span></div></div>';
    const shut = 'color:var(--subtle);transform:rotate(-90deg)', on = 'color:var(--subtle)';
    return '<div class="trow" style="padding-left:8px;font-weight:600">' + ic('u-chev', 14, 'ui', 'color:var(--subtle)') + '<span class="gsq">F</span>Freight<span class="tnum" style="margin-left:auto;font-size:12px;font-weight:400;color:var(--subtle)">2</span></div>' +
      '<div style="position:relative"><div class="guide" style="left:15px;top:0;bottom:0"></div>' +
      '<div class="trow" style="padding-left:28px" data-tconn="prod">' + ic('u-chev', 14, 'ui', prod ? on : shut) + ic('u-db', 16, 'ui', prod ? 'color:var(--pg)' : 'color:var(--faint)') + '<span' + (prod ? '' : ' style="color:var(--muted)"') + '>freight-prod</span><span style="margin-left:auto;font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--prod-t)">PROD</span></div>' +
      (prod ? kids : '') +
      '<div class="trow" style="padding-left:28px">' + ic('u-chev', 14, 'ui', prod ? shut : on) + ic('u-db', 16, 'ui', prod ? 'color:var(--faint)' : 'color:var(--pg)') + '<span' + (prod ? ' style="color:var(--muted)"' : '') + '>freight-stg</span></div>' +
      (prod ? '' : kids) + '</div>';
  }

  /* one app window: title bar with tabs, feature bar, tree, one pane, status bar; follows the page theme */
  function shell(host, o) {
    const sr = host.attachShadow({ mode: 'open' });
    let theme = bus.theme;
    sr.innerHTML = '<style>' + APP_CSS + PG_CSS + ED_CSS + '</style>' +
      '<div class="win pgw ew t-' + theme + ' L' + (coarse.matches ? ' coarse' : ' fine') + '">' + DEFS + DEFS2 +
      '<header class="tbar"><div class="mk">' + MARK + '</div>' +
      '<div class="hm">' + ic('i-home', 18, 'ic f-none') + '<span>Home</span></div>' +
      '<div style="width:1px;height:18px;background:var(--border);margin:0 6px;flex-shrink:0"></div>' +
      '<div class="gs"><span class="gsq">F</span><span style="font-weight:600">Freight</span>' + ic('u-chev', 14, 'ui', 'color:var(--subtle)') + '</div>' +
      '<nav class="tabs" aria-label="Tabs">' + o.tabs + '</nav>' +
      '<span class="wbtn wb">' + ic('u-min', 14) + '</span><span class="wbtn wb">' + ic('u-max', 13) + '</span><span class="wbtn wb">' + ic('u-x', 14) + '</span></header>' +
      featBar() +
      '<div class="mn"><section class="side" aria-label="Object tree">' + tree(o.open, o.prod) + '</section>' +
      '<section class="pane" aria-label="' + o.label + '">' + o.pane + '</section></div>' +
      '<footer class="sbar"><span class="sp" style="display:inline-flex;align-items:center;gap:6px" data-sbconn></span><span class="sp" data-sbmid></span><span class="sp tnum" style="margin-left:auto" data-sbr></span>' +
      '<button class="btn thb" data-apptheme></button></footer>' +
      '<div class="vh" role="status" aria-live="polite" data-live></div></div>';
    const $ = (s) => sr.querySelector(s);
    const win = $('.win');
    let mode = 'L';
    function paint() {
      win.classList.toggle('t-dark', theme === 'dark'); win.classList.toggle('t-light', theme === 'light');
      const b = $('[data-apptheme]'), tip = theme === 'dark' ? 'Dark theme. Switch to Light' : 'Light theme. Switch to Dark';
      b.innerHTML = ic(theme === 'dark' ? 'u-moon' : 'u-sun', 15); b.setAttribute('aria-label', tip); b.title = tip;
    }
    bus.on('theme', (t) => { theme = t; paint(); });
    $('[data-apptheme]').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; paint(); });
    paint();
    function setMode() {
      const w = host.clientWidth, m = w >= 1100 ? 'L' : w >= 760 ? 'M' : 'S';
      if (m !== mode) { win.classList.remove(mode); mode = m; win.classList.add(m); }
    }
    if ('ResizeObserver' in window) new ResizeObserver(setMode).observe(host);
    setMode();
    coarse.addEventListener && coarse.addEventListener('change', () => { win.classList.toggle('coarse', coarse.matches); win.classList.toggle('fine', !coarse.matches); });
    const say = (t) => { const l = $('[data-live]'); l.textContent = ''; setTimeout(() => { l.textContent = t; }, 30); };
    return { sr, $, win, say };
  }
  const tab = (icon, hue, name, cur, extra) => cur
    ? '<div class="tab cur" aria-current="page">' + ic(icon, 16, 'ic f-' + hue) + '<span>' + name + '</span>' + (extra || '') + ic('u-x', 14, 'ui', 'color:var(--subtle)') + '</div>'
    : '<div class="tab other">' + ic(icon, 16, 'ic f-' + hue) + '<span>' + name + '</span></div>';

  /* ---------------- SQL text helpers ---------------- */
  const KW = new Set('SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER DESC ASC AS AND OR NOT NULL IS IN UPDATE SET DELETE INSERT INTO VALUES LIMIT HAVING DISTINCT CASE WHEN THEN ELSE END LIKE BETWEEN'.split(' '));
  const FN = new Set('COUNT SUM AVG MIN MAX ROUND COALESCE LOWER UPPER'.split(' '));
  function hlLine(s) {
    return s.replace(/(--.*$)|('(?:[^']|'')*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([&<>"])/g, (m, c, str, num, w, ch) => {
      if (c) return '<span class="x-c">' + esc(c) + '</span>';
      if (str) return '<span class="x-s">' + esc(str) + '</span>';
      if (num) return '<span class="x-n">' + num + '</span>';
      if (w) { const u = w.toUpperCase(); return KW.has(u) ? '<span class="x-k">' + w + '</span>' : FN.has(u) ? '<span class="x-f">' + w + '</span>' : w; }
      return esc(ch);
    });
  }
  /* statements: split on ; outside strings and comments; each has the span of its text without the leading comments */
  function statements(text) {
    const out = []; let st = 0, i = 0;
    const push = (end) => {
      const seg = text.slice(st, end);
      const body = seg.replace(/^(\s*--[^\n]*\n?)*\s*/, '');
      const from = end - seg.length + (seg.length - body.length);
      const trimmed = body.replace(/\s+$/, '');
      if (trimmed.replace(/--[^\n]*/g, '').trim()) out.push({ from, to: from + trimmed.length, text: trimmed, segFrom: st, segTo: end });
      st = end;
    };
    while (i < text.length) {
      const c = text[i];
      if (c === '-' && text[i + 1] === '-') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (c === "'") { i++; while (i < text.length && !(text[i] === "'" && text[i + 1] !== "'")) { if (text[i] === "'") i++; i++; } i++; continue; }
      if (c === ';') { push(i + 1); }
      i++;
    }
    push(text.length);
    return out;
  }
  const current = (list, pos) => list.find((s) => pos >= s.segFrom && pos <= s.segTo && pos <= s.to) || list.find((s) => pos <= s.to) || list[list.length - 1];
  function noWhere(sql) {
    const words = sql.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''").match(/[A-Za-z_][\w.]*|[()]/g) || [];
    const verb = (words[0] || '').toUpperCase();
    if (verb !== 'UPDATE' && verb !== 'DELETE') return null;
    let i = 1; while (i < words.length && /^(LOW_PRIORITY|IGNORE|QUICK|ONLY|FROM)$/i.test(words[i])) i++;
    const table = words[i] || '';
    let depth = 0;
    for (const w of words.slice(i + 1)) { if (w === '(') depth++; else if (w === ')') depth--; else if (depth === 0 && /^WHERE$/i.test(w)) return null; }
    return { verb, table };
  }
  const isNum = (v) => typeof v === 'number';
  const cellText = (v) => (v === null || v === undefined ? '<span class="def">NULL</span>' : esc(isNum(v) && !Number.isInteger(v) ? v.toFixed(2) : v));

  /* ================================================================== */
  /*                             SQL EDITOR                             */
  /* ================================================================== */
  const START = `-- freight-stg, schema billing
SELECT c.name, count(*) AS open_invoices, sum(i.total) AS owed
FROM billing.customers c
JOIN billing.invoices i ON i.customer_id = c.id
WHERE i.status = 'open'
GROUP BY c.name
ORDER BY owed DESC;

SELECT number, total, issued_at
FROM billing.invoices
WHERE status = 'void';

UPDATE billing.invoices SET status = 'void';
`;
  /* presets for other pages: data-preset="safety" (reads and writes on freight-prod) or "readonly" */
  const PRESETS = {
    safety: `-- schema billing: one read, then two writes
SELECT number, total, issued_at
FROM billing.invoices
WHERE status = 'open'
ORDER BY total DESC
LIMIT 5;

UPDATE billing.invoices SET status = 'void'
WHERE number = 'INV-2026-0042';

DELETE FROM billing.payments;
`,
    readonly: `-- Open invoices, biggest first
SELECT number, total, status
FROM billing.invoices
WHERE status = 'open'
ORDER BY total DESC
LIMIT 5;

UPDATE billing.invoices SET status = 'void'
WHERE status = 'open' AND issued_at < '2026-09-01';
`,
  };
  /* Connections the editor can sit on. Read-only wins over Production: a write is blocked, so nothing needs to ask. */
  const CONNS = {
    stg: { name: 'freight-stg', prod: false, ro: false },
    prod: { name: 'freight-prod', prod: true, ro: false },
    ro: { name: 'freight-prod', prod: true, ro: true },
  };
  const WRITE = /^(UPDATE|DELETE|INSERT|MERGE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|REINDEX|CLUSTER|COMMENT|LOCK|REFRESH)$/;
  const isWrite = (sql) => { const w = (sql.replace(/--[^\n]*/g, ' ').match(/[A-Za-z_]+/) || [''])[0].toUpperCase(); return WRITE.test(w) || (w === 'WITH' && /\b(UPDATE|DELETE|INSERT)\b/i.test(sql)); };

  /* host attributes: data-editor="<id of a .seg with button[data-conn]>" (optional), data-preset, data-runall */
  function createEditor(host) {
    const ctl = host.dataset.editor ? doc.getElementById(host.dataset.editor) : null;
    const START_TEXT = PRESETS[host.dataset.preset] || START;
    const runAllOn = host.hasAttribute('data-runall');
    const pressed = ctl && ctl.querySelector('button[data-conn][aria-pressed="true"]');
    let cm = (pressed && CONNS[pressed.dataset.conn]) ? pressed.dataset.conn : 'stg';
    const W = shell(host, {
      label: 'Query 1',
      open: null,
      tabs: tab('i-query', 'query', 'Query 1', true) + tab('i-table', 'obj', 'invoices', false),
      pane: '<div class="hbar"><span data-hconn style="display:inline-flex;align-items:center;gap:6px;min-width:0"></span><span class="mono hide-s" style="font-size:12px;color:var(--subtle)">billing</span><div class="vdiv"></div>' +
        '<button class="btn pbtn" data-run aria-keyshortcuts="Control+Enter">' + ic('u-play', 14) + 'Run<span class="kh">Ctrl+Enter</span></button>' +
        (runAllOn ? '<button class="btn b-sec" data-runall aria-keyshortcuts="Control+Shift+Enter">Run all<span class="kh hide-s">Ctrl+Shift+Enter</span></button>' : '') +
        '<span class="sp"></span><span class="hide-s" style="font-size:12px;color:var(--subtle)" data-stmtno></span></div>' +
        '<div data-ronote></div>' +
        '<div class="ed"><div class="gut" aria-hidden="true"></div><div class="code"><pre aria-hidden="true"></pre><textarea spellcheck="false" wrap="off" autocapitalize="off" autocomplete="off" aria-label="SQL editor, Query 1. Ctrl+Enter runs the current statement."></textarea></div></div>' +
        '<div data-confirm></div>' +
        '<div class="res"><div class="rtabs" role="tablist" aria-label="Results"><button class="itab on" role="tab" aria-selected="true" data-rtab>Result</button><span class="sum" data-sum></span></div><div class="rbody" data-rbody tabindex="0" aria-label="Result rows"></div><div class="rfoot" data-rfoot></div></div>',
    });
    const { $, say } = W;
    const ta = $('textarea'), pre = $('pre'), gut = $('.gut'), rbody = $('[data-rbody]'), sum = $('[data-sum]'), rfoot = $('[data-rfoot]'), conf = $('[data-confirm]'), runB = $('[data-run]'), runAllB = $('[data-runall]'), roNote = $('[data-ronote]'), pane = $('.pane');
    const C = () => CONNS[cm];
    function connPaint() {
      const c = C();
      const chips = (c.prod ? '<span class="chip sm c-prod">PROD</span>' : '') + (c.ro ? '<span class="chip sm c-ro">' + ic('v-lock', 12) + 'Read-only</span>' : '');
      $('[data-hconn]').innerHTML = ic('u-db', 16, 'ui', 'color:var(--pg)') + '<span style="font-weight:600">' + c.name + '</span>' + chips;
      $('[data-sbconn]').innerHTML = ic('u-db', 14, 'ui', 'color:var(--pg)') + '<span style="color:var(--text)">' + c.name + '</span>' + chips + '<span>PostgreSQL 17.0</span>';
      const side = $('.side'); if (side) side.innerHTML = tree(null, c.prod);
    }
    connPaint();
    $('[data-sbr]').textContent = 'UTF-8';
    ta.value = START_TEXT; ta.setSelectionRange(0, 0);
    let list = [], cur = null, busy = false;
    function paint() {
      const text = ta.value, lines = text.split('\n'), c = C();
      list = statements(text);
      cur = current(list, ta.selectionStart);
      const lineOf = (pos) => text.slice(0, pos).split('\n').length - 1;
      const a = cur ? lineOf(cur.from) : -1, b = cur ? lineOf(cur.to) : -1;
      /* write marks: Production band on writes, the neutral Read-only band and a lock when the Connection is Read-only */
      const mark = new Array(lines.length).fill(''), lock = new Set();
      if (c.prod) list.forEach((s) => { if (!isWrite(s.text)) return; const x = lineOf(s.from), y = lineOf(s.to); for (let i = x; i <= y; i++) mark[i] = c.ro ? 'ro' : 'pw'; if (c.ro) lock.add(x); });
      pre.innerHTML = lines.map((l, i) => '<div class="l' + (i >= a && i <= b ? ' cs' : '') + (mark[i] ? ' ' + mark[i] : '') + '">' + (hlLine(l) || ' ') + '</div>').join('');
      gut.innerHTML = lines.map((l, i) => '<div class="' + (i >= a && i <= b ? 'cs ' : '') + mark[i] + '">' + (lock.has(i) ? ic('v-lock', 12, 'ui lk') : '') + (i + 1) + '</div>').join('');
      const before = text.slice(0, ta.selectionStart).split('\n');
      $('[data-sbmid]').textContent = 'Ln ' + before.length + ', Col ' + (before[before.length - 1].length + 1);
      $('[data-stmtno]').textContent = cur ? 'Statement ' + (list.indexOf(cur) + 1) + ' of ' + list.length + (c.prod ? (isWrite(cur.text) ? ', writes' : ', reads') : '') : '';
      /* Read-only: Run is off for a statement that writes, with the reason beside it */
      const blocked = c.ro && cur && isWrite(cur.text);
      runB.classList.toggle('off', !!blocked);
      runB.setAttribute('aria-disabled', String(!!blocked));
      runB.title = blocked ? 'Read-only Connection: this statement writes' : '';
      if (runAllB) { const anyW = c.ro && list.some((s) => isWrite(s.text)); runAllB.classList.toggle('off', anyW); runAllB.setAttribute('aria-disabled', String(anyW)); runAllB.title = anyW ? 'Read-only Connection: statement ' + (list.findIndex((s) => isWrite(s.text)) + 1) + ' writes' : ''; }
      const had = !!roNote.firstChild;
      if (blocked) {
        if (!had || roNote.dataset.s !== String(cur.from)) {
          roNote.dataset.s = String(cur.from);
          roNote.innerHTML = '<div class="ronote" role="note" id="ro-why">' + ic('v-lock', 14) + '<p><b>Read-only Connection: this statement writes.</b> ' + c.name + ' is Read-only, and the current statement writes. Run is off. To make this change, use a Connection that allows writes.</p>' +
            '<button class="btn b-sub" data-backstop>What the server would say</button></div>';
          runB.setAttribute('aria-describedby', 'ro-why');
        }
      } else if (had) { roNote.innerHTML = ''; delete roNote.dataset.s; runB.removeAttribute('aria-describedby'); }
      follow(before.length - 1, before[before.length - 1].length);
    }
    /* keep the line being typed in view: the textarea grows with its text, so the scroll box is .ed, which never moves on its own */
    const ed = $('.ed');
    function follow(line, col) {
      if (W.sr.activeElement !== ta) return;
      const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight) || 20, cw = (parseFloat(cs.fontSize) || 12.5) * 0.6;
      const padT = parseFloat(cs.paddingTop) || 0, padL = parseFloat(cs.paddingLeft) || 0, gutW = ta.getBoundingClientRect().left - ed.getBoundingClientRect().left + ed.scrollLeft;
      const top = padT + line * lh, left = gutW + padL + col * cw;
      if (top < ed.scrollTop) ed.scrollTop = Math.max(0, top - padT);
      else if (top + lh > ed.scrollTop + ed.clientHeight) ed.scrollTop = top + lh + padT - ed.clientHeight;
      if (left < ed.scrollLeft + gutW + padL) ed.scrollLeft = Math.max(0, left - gutW - padL - 4 * cw);
      else if (left + cw > ed.scrollLeft + ed.clientWidth) ed.scrollLeft = left + 4 * cw - ed.clientWidth;
    }
    ['input', 'click', 'keyup', 'select', 'focus'].forEach((e) => ta.addEventListener(e, paint));
    doc.addEventListener('selectionchange', () => { if (W.sr.activeElement === ta) paint(); });
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (e.shiftKey && runAllOn) runAll(); else run(); }
      else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); paint(); }
    });
    runB.addEventListener('click', () => run());
    if (runAllB) runAllB.addEventListener('click', () => runAll());
    roNote.addEventListener('click', (e) => { if (e.target.closest('[data-backstop]')) backstop(); });

    function idle(msg, sub, err) { rbody.innerHTML = '<div class="rmsg' + (err ? ' err' : '') + '"><b>' + msg + '</b>' + (sub ? '<span class="mono">' + esc(sub) + '</span>' : '') + '</div>'; }
    const idleStart = () => { idle('Nothing run yet', 'Click into a statement and press Run, or Ctrl+Enter.'); sum.textContent = ''; rfoot.textContent = ''; };
    idleStart();

    function grid(cols, rows) {
      const plain = (v) => (v === null || v === undefined ? 'NULL' : isNum(v) && !Number.isInteger(v) ? v.toFixed(2) : String(v));
      const tpl = '44px ' + cols.map((c, i) => Math.min(320, Math.max(72, 18 + 7.6 * Math.max(String(c).length, ...rows.slice(0, 200).map((r) => plain(r[i]).length)))) + 'px').join(' ') + ' minmax(0,1fr)';
      const numCol = cols.map((c, i) => rows.length > 0 && rows.every((r) => r[i] === null || isNum(r[i])));
      const anim = !reduced();
      return '<div class="gr h" style="grid-template-columns:' + tpl + '"><span></span>' + cols.map((c, i) => '<span class="' + (numCol[i] ? 'num' : '') + '"><span class="hc"><span class="hn">' + esc(c) + '</span></span></span>').join('') + '<span></span></div>' +
        rows.slice(0, 200).map((r, k) => '<div class="gr d' + (anim && k < 24 ? ' in' : '') + '" style="grid-template-columns:' + tpl + ';--i:' + k + '"><span class="rn">' + (k + 1) + '</span>' + r.map((v, i) => '<span class="' + (numCol[i] ? 'num' : '') + '">' + cellText(v) + '</span>').join('') + '<span></span></div>').join('');
    }
    /* run one or more statements in order, stop at the first failure */
    async function execList(stmts) {
      busy = true;
      sum.textContent = 'Running...';
      let db;
      try { db = await getDB(); } catch (e) { busy = false; sum.textContent = ''; idle('The sample database did not load', 'sql.js could not be fetched from cdnjs. Check the connection and press Run again.', true); return; }
      const t0 = performance.now();
      let last = null, changed = 0, wrote = false, done = 0;
      for (const stmt of stmts) {
        const sql = stmt.text.replace(/\s*;\s*$/, '');
        try {
          const r = db.exec(sql);
          if (r.length) last = r[0];
          else if (!/^\s*select/i.test(sql)) { changed += db.getRowsModified(); wrote = true; }
          done++;
        } catch (e) {
          idle('Statement ' + (list.indexOf(stmt) + 1) + ' failed', String(e.message || e), true);
          sum.textContent = done ? done + ' ran, then one failed' : 'Failed'; rfoot.textContent = '';
          say('Statement failed: ' + (e.message || e));
          busy = false;
          if (wrote) doc.dispatchEvent(new CustomEvent('contura:data'));
          return;
        }
      }
      const ms = performance.now() - t0;
      const many = stmts.length > 1;
      if (last) {
        const rows = last.values;
        rbody.innerHTML = grid(last.columns, rows);
        sum.textContent = (many ? stmts.length + ' statements ran. ' : '') + fmt(rows.length) + ' row' + (rows.length === 1 ? '' : 's') + (wrote ? ', ' + fmt(changed) + ' changed' : '') + ' in ' + dur(ms);
        rfoot.textContent = rows.length ? '1 to ' + fmt(rows.length) + ' of ' + fmt(rows.length) : '';
      } else {
        idle(wrote ? fmt(changed) + ' row' + (changed === 1 ? '' : 's') + ' changed' : 'The query returned no rows.', wrote ? 'On the sample copy in this page. Open the invoices tab below to see it.' : '');
        sum.textContent = (many ? stmts.length + ' statements ran. ' : '') + (wrote ? fmt(changed) + ' rows changed, ' + dur(ms) : '0 rows in ' + dur(ms));
        rfoot.textContent = '';
      }
      say(sum.textContent);
      if (wrote) doc.dispatchEvent(new CustomEvent('contura:data'));
      busy = false;
    }
    const exec = (stmt) => execList([stmt]);
    function blockedSay(n) {
      const t = C().name + ' is Read-only. Statement ' + n + ' writes, so Run is off.';
      say(t); sum.textContent = 'Run is off: Read-only Connection';
    }
    function run() {
      if (busy) return;
      paint();
      if (!cur) return;
      const c = C();
      if (c.ro && isWrite(cur.text)) return blockedSay(list.indexOf(cur) + 1);
      if (c.prod && isWrite(cur.text)) return prodConfirm([cur]);
      const nw = noWhere(cur.text);
      if (nw) return ask(cur, nw);
      conf.innerHTML = '';
      exec(cur);
    }
    function runAll() {
      if (busy) return;
      paint();
      if (!list.length) return;
      const c = C(), w = list.findIndex((s) => isWrite(s.text));
      if (c.ro && w >= 0) return blockedSay(w + 1);
      if (c.prod && w >= 0) return prodConfirm(list.slice());
      const k = list.findIndex((s) => noWhere(s.text));
      if (k >= 0) return ask(list[k], noWhere(list[k].text), list.slice());
      conf.innerHTML = '';
      execList(list.slice());
    }
    function ask(stmt, nw, all) {
      conf.innerHTML = '<div class="qconf" role="alertdialog" aria-label="Confirm ' + nw.verb + ' without WHERE">' + ic('v-warn', 16) +
        '<p><strong>' + nw.verb + ' without WHERE changes every row in <code>' + esc(nw.table) + '</code>.</strong> Run it anyway?</p>' +
        '<button class="btn b-sec" data-addwhere>Add WHERE</button><button class="btn b-sub" data-cancel>Cancel</button><button class="btn b-danger" data-runit>Run ' + nw.verb + '</button></div>';
      say(nw.verb + ' without WHERE changes every row in ' + nw.table + '. Run it anyway?');
      conf.querySelector('[data-cancel]').focus();
      conf.querySelector('[data-cancel]').onclick = () => { conf.innerHTML = ''; ta.focus(); };
      conf.querySelector('[data-runit]').onclick = () => { conf.innerHTML = ''; all ? execList(all) : exec(stmt); };
      conf.querySelector('[data-addwhere]').onclick = () => { conf.innerHTML = ''; addWhere(stmt); };
    }
    function addWhere(stmt) {
      const at = stmt.text.endsWith(';') ? stmt.to - 1 : stmt.to;
      ta.focus({ preventScroll: true }); ta.setSelectionRange(at, at); ta.setRangeText(' WHERE ', at, at, 'end'); paint();
    }
    /* Production: one dialog with the exact SQL, each statement labelled writes or reads. Focus starts on the SQL, so
       Enter does nothing until the Run button has focus. A write without WHERE adds its warning and turns Run red. */
    let dlg = null;
    function prodConfirm(stmts) {
      closeDlg();
      const c = C(), writes = stmts.filter((s) => isWrite(s.text)).length;
      const nwI = stmts.findIndex((s) => noWhere(s.text)), nw = nwI >= 0 ? noWhere(stmts[nwI].text) : null;
      const tname = nw ? nw.table.replace(/^billing\./, '') : '';
      const rows = nw && DATA[tname] ? DATA[tname].length : null;
      const count = stmts.length === 1 ? '1 statement writes.' : writes + ' of ' + stmts.length + ' statements write.';
      let n = 1;
      const body = stmts.map((s, k) => {
        const w = isWrite(s.text);
        const ls = s.text.split('\n').map((l, j) => '<div class="sqll' + (w ? ' wp' : '') + '"><span class="n">' + (n++) + '</span><span>' + hlLine(l) + (j === 0 ? '<span class="rw ' + (w ? 'w' : 'r') + '">' + (w ? 'writes' : 'reads') + '</span>' : '') + '</span></div>').join('');
        return ls + (k < stmts.length - 1 ? '<div class="sqll"><span class="n">' + (n++) + '</span><span> </span></div>' : '');
      }).join('');
      const box = doc.createElement('div');
      box.className = 'scrim';
      box.innerHTML = '<div class="dlg cfd" role="dialog" aria-modal="true" aria-labelledby="cf-t"><div class="dh">' + ic('u-db', 16, 'ui', 'color:var(--pg)') + '<span id="cf-t">Run on <b>' + c.name + '</b> · billing</span><span class="chip sm c-prod">PROD</span>' +
        '<span class="tnum cnt">' + count + '</span></div>' +
        (nw ? '<div class="nw" role="alert">' + ic('v-warn', 16) + '<p><b>Statement ' + (nwI + 1) + ' has no WHERE.</b> It changes every row in ' + esc(nw.table) + (rows != null ? ', ' + fmt(rows) + (rows === 1 ? ' row' : ' rows') + ' in this sample' : '') + '.</p><button class="btn b-sec" data-addwhere>Add WHERE</button></div>' : '') +
        '<div class="dbd" tabindex="0" aria-label="SQL to run, read-only. ' + count + '">' + body + '</div>' +
        '<div class="df"><span class="hint">Enter runs only when Run on ' + c.name + ' has focus. Press Tab to reach it, or click it.</span><button class="btn b-sec" data-no>Cancel</button><button class="btn ' + (nw ? 'b-danger' : 'b-pri') + '" data-yes>Run on ' + c.name + '</button></div></div>';
      pane.appendChild(box);
      dlg = { box, stmts };
      const close = (msg) => { closeDlg(); ta.focus({ preventScroll: true }); if (msg) say(msg); };
      box.querySelector('[data-no]').onclick = () => { close('Cancelled. Nothing ran on ' + c.name + '.'); sum.textContent = 'Cancelled, nothing ran'; };
      box.querySelector('[data-yes]').onclick = () => { closeDlg(); conf.innerHTML = ''; execList(stmts); };
      const aw = box.querySelector('[data-addwhere]'); if (aw) aw.onclick = () => { closeDlg(); addWhere(stmts[nwI]); };
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close('Cancelled. Nothing ran.'); }
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) e.preventDefault();
        e.stopPropagation();
      });
      box.querySelector('.dbd').focus({ preventScroll: true });
      say('Run on ' + c.name + ' asks first. ' + count + ' Read the SQL, then Cancel or Run on ' + c.name + '.');
    }
    function closeDlg() { if (dlg) { dlg.box.remove(); dlg = null; } }
    /* the server backstop: a Read-only Connection opens its session read-only, so a write that got through would be refused */
    function backstop() {
      const s = cur && isWrite(cur.text) ? cur : list.find((x) => isWrite(x.text));
      const verb = s ? (s.text.match(/[A-Za-z]+/) || ['UPDATE'])[0].toUpperCase() : 'UPDATE';
      idle('The server refused it', 'ERROR: cannot execute ' + verb + ' in a read-only transaction. Contura never sends it: Run is off. If a write did get through, the session on ' + C().name + ' is opened read-only, and this is what the server answers.', true);
      sum.textContent = 'Refused by the server'; rfoot.textContent = '';
      say('The server refused it: cannot execute ' + verb + ' in a read-only transaction.');
    }
    function setConn(m) {
      if (!CONNS[m]) return;
      cm = m; closeDlg(); conf.innerHTML = '';
      if (ctl) ctl.querySelectorAll('button[data-conn]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.conn === m)));
      connPaint(); paint();
    }
    if (ctl) ctl.querySelectorAll('button[data-conn]').forEach((b) => b.addEventListener('click', () => setConn(b.dataset.conn)));
    /* place the selection inside statement i (0-based) without moving the page */
    function select(i) {
      const s = statements(ta.value)[i]; if (!s) return;
      ta.setSelectionRange(s.from, s.from); paint();
      const line = ta.value.slice(0, s.from).split('\n').length - 1;
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      ed.scrollTop = Math.max(0, line * lh - lh);
    }
    function reset() { closeDlg(); conf.innerHTML = ''; ta.value = START_TEXT; ta.setSelectionRange(0, 0); ed.scrollTop = 0; idleStart(); paint(); }
    function confirm(yes) { if (!dlg) return false; dlg.box.querySelector(yes ? '[data-yes]' : '[data-no]').click(); return true; }
    paint();
    const api = { host, setConn, select, run, runAll, confirm, backstop, reset, get dialog() { return dlg ? dlg.box : null; }, get conn() { return cm; }, get busy() { return busy; }, get statements() { return list; }, $ };
    REG.set(host, api);
    return api;
  }

  /* ================================================================== */
  /*                       DATA GRID, PENDING EDITS                     */
  /* ================================================================== */
  const COLS = T.invoices.map((c) => ({ n: c[0], t: FULLTYPE['invoices.' + c[0]] || c[1], num: /int|numeric/.test(c[1]) }));
  const PAGE = 14;
  function createGrid(host, ctl) {
    const pressedG = ctl && ctl.querySelector('button[data-conn][aria-pressed="true"]');
    let prod = !!pressedG && pressedG.dataset.conn === 'prod';
    const W = shell(host, {
      label: 'invoices',
      open: 'invoices',
      tabs: tab('i-table', 'obj', 'invoices', true, '<span data-dirty style="color:var(--prod-t);margin-left:-4px"></span>') + tab('i-query', 'query', 'Query 1', false),
      pane: '<div class="hbar" role="toolbar" aria-label="Table"><span data-conn style="display:inline-flex;align-items:center;gap:6px"></span><span class="mono" style="font-size:12px;color:var(--subtle)">billing.invoices</span><div class="vdiv"></div>' +
        '<button class="btn ibtn" data-reload aria-label="Reload" title="Reload rows">' + ic('v-reload', 16) + '</button>' +
        '<button class="btn sbtn" data-add aria-label="Add row" title="Add row">' + ic('u-plus', 16) + '<span class="hide-s">Add row</span></button>' +
        '<button class="btn sbtn" data-delrow aria-label="Delete row" title="Delete row (Delete)">' + ic('v-trash', 16) + '<span class="hide-s">Delete row</span></button>' +
        '<span class="sp"></span><span class="hide-s tnum" style="font-size:12px;color:var(--subtle)" data-pg></span></div>' +
        '<div class="dg" tabindex="0" role="grid" aria-label="Rows of billing.invoices. Arrow keys move, Enter edits a cell, Delete marks the row." data-dg></div>' +
        '<div data-pv></div><div data-ebar></div>' +
        '<div class="rfoot" data-gfoot></div>',
    });
    const { $, sr, say } = W;
    const dg = $('[data-dg]'), ebar = $('[data-ebar]'), pv = $('[data-pv]'), pane = $('.pane');
    let rows = [], orig = [], sel = { r: 0, c: 1 }, editing = null, previewOpen = false, nextNo = 0, lastSave = '';
    const total = () => DATA.invoices.length;
    function load(fromRows) {
      orig = fromRows.map((r) => r.slice());
      rows = orig.map((r, i) => ({ v: r.slice(), o: i, add: false, del: false, ed: new Set() }));
      nextNo = Math.max(...DATA.invoices.map((r) => r[0])) + 1;
      editing = null;
    }
    load(DATA.invoices.slice().sort((a, b) => a[0] - b[0]).slice(0, PAGE));

    function conn() {
      $('[data-conn]').innerHTML = ic('u-db', 16, 'ui', 'color:var(--pg)') + '<span style="font-weight:600">' + (prod ? 'freight-prod' : 'freight-stg') + '</span>' + (prod ? '<span class="chip sm c-prod">PROD</span>' : '');
      $('[data-sbconn]').innerHTML = ic('u-db', 14, 'ui', 'color:var(--pg)') + '<span style="color:var(--text)">' + (prod ? 'freight-prod' : 'freight-stg') + '</span><span>PostgreSQL 17.0</span>';
      $('.side').innerHTML = tree('invoices', prod);
    }
    const changes = () => rows.filter((r) => r.add || r.del || r.ed.size).length;
    const summary = () => {
      const cells = rows.reduce((n, r) => n + (r.add || r.del ? 0 : r.ed.size), 0), adds = rows.filter((r) => r.add && !r.del).length, dels = rows.filter((r) => r.del && !r.add).length;
      return [cells && cells + (cells === 1 ? ' edited cell' : ' edited cells'), adds && adds + (adds === 1 ? ' new row' : ' new rows'), dels && dels + (dels === 1 ? ' deleted row' : ' deleted rows')].filter(Boolean).join(', ');
    };
    const lit = (v, c) => (v === null || v === '' ? 'NULL' : c.num ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
    function plan() {
      const out = [];
      rows.forEach((r) => {
        if (r.add && r.del) return;
        if (r.del) { out.push('DELETE FROM billing.invoices WHERE id = ' + r.v[0]); return; }
        if (r.add) { const cs = COLS.slice(1); out.push('INSERT INTO billing.invoices (' + cs.map((c) => c.n).join(', ') + ')\nVALUES (' + cs.map((c, i) => lit(r.v[i + 1], c)).join(', ') + ')'); return; }
        if (r.ed.size) { const ks = [...r.ed].sort(); out.push('UPDATE billing.invoices SET ' + ks.map((k) => COLS[k].n + ' = ' + lit(r.v[k], COLS[k])).join(', ') + '\nWHERE id = ' + r.v[0]); }
      });
      return out;
    }
    const tpl = '44px 72px 108px 132px 112px 112px minmax(84px,1fr)';
    function render() {
      const head = '<div class="gr h" role="row" style="grid-template-columns:' + tpl + '"><span></span>' + COLS.map((c) => '<span class="' + (c.num ? 'num' : '') + '" role="columnheader"><span class="hc"><span class="hn">' + c.n + '</span><span class="ht">' + c.t + '</span></span></span>').join('') + '</div>';
      dg.innerHTML = head + rows.map((r, ri) => '<div class="gr d' + (r.add ? ' add' : '') + (r.del ? ' del' : '') + '" role="row" style="grid-template-columns:' + tpl + '" data-r="' + ri + '"><span class="rn">' + (r.add ? '+' : r.del ? '-' : ri + 1) + '</span>' +
        r.v.map((v, ci) => {
          const cls = [COLS[ci].num ? 'num' : '', r.ed.has(ci) ? 'ed' : '', sel.r === ri && sel.c === ci ? 'sel' : ''].join(' ');
          const shown = r.add && ci === 0 ? '<span class="def">auto</span>' : cellText(v === '' ? null : v);
          return '<span class="' + cls + '" role="gridcell" data-c="' + ci + '">' + shown + '</span>';
        }).join('') + '</div>').join('');
      const n = changes();
      $('[data-dirty]').textContent = n ? '●' : '';
      $('[data-pg]').textContent = 'Rows 1 to ' + Math.min(PAGE, total()) + ' of ' + fmt(total());
      $('[data-gfoot]').textContent = n ? '' : 'Page 1 of ' + Math.ceil(total() / PAGE) + (lastSave ? '  ·  ' + lastSave : '');
      $('[data-sbmid]').textContent = n ? n + (n === 1 ? ' change' : ' changes') + ' pending' : lastSave || 'billing.invoices';
      $('[data-sbr]').textContent = 'Row ' + (sel.r + 1) + ', ' + COLS[sel.c].n;
      if (!n) { ebar.innerHTML = ''; pv.innerHTML = ''; previewOpen = false; }
      else {
        const keepFocus = sr.activeElement && ebar.contains(sr.activeElement) ? sr.activeElement.dataset.k : null;
        ebar.innerHTML = '<div class="ebar" role="region" aria-label="Pending Edits"><span class="chip c-warn">' + n + (n === 1 ? ' change' : ' changes') + '</span><span class="es">' + summary() + '</span>' +
          '<button class="btn b-sub' + (previewOpen ? ' on' : '') + '" aria-pressed="' + previewOpen + '" data-k="pv">' + ic('v-code', 14) + 'Preview SQL</button>' +
          '<button class="btn b-sub" data-k="discard">' + ic('v-undo', 14) + 'Discard</button>' +
          (prod ? '<button class="btn b-prod" data-k="save" aria-label="Save on Production" aria-keyshortcuts="Control+S">Save on PROD<span class="kbd">Ctrl+S</span></button>'
            : '<button class="btn b-pri" data-k="save" aria-label="Save" aria-keyshortcuts="Control+S">' + ic('v-save', 14) + 'Save<span class="kbd">Ctrl+S</span></button>') + '</div>';
        if (keepFocus) { const b = ebar.querySelector('[data-k="' + keepFocus + '"]'); b && b.focus(); }
        pv.innerHTML = previewOpen ? preview() : '';
      }
      if (editing) {
        const cell = dg.querySelector('[data-r="' + editing.r + '"] [data-c="' + editing.c + '"]');
        cell.classList.add('editing');
        cell.innerHTML = '<input class="ce" aria-label="' + COLS[editing.c].n + '" value="' + esc(editing.val) + '">';
        const inp = cell.firstChild; inp.focus(); inp.select();
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit(inp.value); }
          else if (e.key === 'Escape') { e.preventDefault(); editing = null; render(); dg.focus(); }
          e.stopPropagation();
        });
        inp.addEventListener('blur', () => { if (editing) commit(inp.value, true); });
      }
    }
    function markSel() {
      dg.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
      const c = dg.querySelector('[data-r="' + sel.r + '"] [data-c="' + sel.c + '"]'); c && c.classList.add('sel');
      $('[data-sbr]').textContent = 'Row ' + (sel.r + 1) + ', ' + COLS[sel.c].n;
    }
    function sqlLines(stmts, band) {
      let n = 1; const out = [];
      stmts.forEach((s, k) => {
        (s + ';').split('\n').forEach((l) => out.push('<div class="sqll ' + band + '"><span class="n">' + (n++) + '</span><span>' + hlLine(l) + '</span></div>'));
        if (k < stmts.length - 1) out.push('<div class="sqll"><span class="n">' + (n++) + '</span><span> </span></div>');
      });
      return out.join('');
    }
    function preview() {
      const st = plan();
      return '<aside class="pv" role="region" aria-label="Preview SQL"><div class="ph">' + ic('v-code', 14) + '<b>Save will run</b><span>on ' + (prod ? 'freight-prod' : 'freight-stg') + ' · billing</span>' + (prod ? '<span class="chip sm c-prod">PROD</span>' : '') +
        '<span class="tnum">' + (st.length === 1 ? '1 statement, a write, in one transaction' : fmt(st.length) + ' statements, all write, in one transaction') + '</span></div><div class="pb">' + sqlLines(st, prod ? 'wp' : 'w') + '</div></aside>';
    }
    function commit(val, blur) {
      const { r, c } = editing; editing = null;
      const row = rows[r], col = COLS[c];
      let v = val.trim();
      if (col.num && v !== '' && !isNaN(Number(v))) v = Number(v);
      if (v === '' && !row.add) v = row.v[c];
      row.v[c] = v;
      if (!row.add) { const was = orig[row.o][c]; if (String(was) === String(v)) row.ed.delete(c); else row.ed.add(c); }
      render(); if (!blur) dg.focus();
      const n = changes(); if (n) say(n + (n === 1 ? ' change' : ' changes') + ' pending: ' + summary());
    }
    function edit() {
      const row = rows[sel.r];
      if (!row || row.del || sel.c === 0) return;
      editing = { r: sel.r, c: sel.c, val: row.v[sel.c] === null ? '' : String(row.v[sel.c]) };
      render();
    }
    function addRow() {
      const n = nextNo++;
      rows.push({ v: [null, 1, 'INV-2026-' + String(n).padStart(4, '0'), 0, '2026-10-20', 'open'], o: -1, add: true, del: false, ed: new Set() });
      sel = { r: rows.length - 1, c: 1 };
      render(); dg.scrollTop = dg.scrollHeight;
      say('New row added. It waits as a Pending Edit.');
    }
    function delRow() {
      const row = rows[sel.r]; if (!row) return;
      if (row.add) { rows.splice(sel.r, 1); sel.r = Math.max(0, sel.r - 1); }
      else row.del = !row.del;
      render(); dg.focus();
    }
    function discard() { load(orig); render(); dg.focus(); say('Pending Edits discarded.'); }
    async function save(confirmed) {
      const st = plan(); if (!st.length) return;
      if (prod && !confirmed) return confirmSave(st);
      const n = changes();
      let db;
      try { db = await getDB(); } catch (e) { say('The sample database did not load.'); $('[data-sbmid]').textContent = 'sql.js could not be fetched; nothing was saved'; return; }
      const t0 = performance.now();
      try {
        db.exec('BEGIN; ' + st.join(';\n') + '; COMMIT;');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (x) {}
        $('[data-sbmid]').textContent = 'Save failed, nothing was written: ' + (e.message || e);
        say('Save failed. Nothing was written.');
        return;
      }
      const ms = performance.now() - t0;
      const r = db.exec('SELECT id, customer_id, number, total, issued_at, status FROM billing.invoices ORDER BY id LIMIT ' + PAGE);
      const fresh = r.length ? r[0].values : [];
      DATA.invoices.length = 0; db.exec('SELECT id, customer_id, number, total, issued_at, status FROM billing.invoices')[0].values.forEach((x) => DATA.invoices.push(x));
      lastSave = 'Saved ' + n + (n === 1 ? ' change' : ' changes') + ' in one transaction, ' + dur(ms);
      load(fresh); render(); dg.focus();
      say(lastSave);
      doc.dispatchEvent(new CustomEvent('contura:data'));
    }
    function confirmSave(st) {
      const box = doc.createElement('div');
      box.className = 'scrim';
      box.innerHTML = '<div class="dlg" role="dialog" aria-modal="true" aria-label="Save on freight-prod"><div class="dh">' + ic('u-db', 16, 'ui', 'color:var(--pg)') + '<span>Save on <b>freight-prod</b> · billing</span><span class="chip sm c-prod">PROD</span>' +
        '<span class="tnum" style="margin-left:auto;font-size:12px;color:var(--subtle)">' + (st.length === 1 ? '1 statement writes.' : st.length + ' statements write.') + '</span></div>' +
        '<div class="dbd" tabindex="0" aria-label="SQL to run, read-only">' + sqlLines(st, 'wp') + '</div>' +
        '<div class="df"><button class="btn b-sec" data-no>Cancel</button><button class="btn b-pri" data-yes>Save on freight-prod</button></div></div>';
      pane.appendChild(box);
      const close = () => { box.remove(); dg.focus(); };
      box.querySelector('[data-no]').onclick = () => { close(); say('Cancelled. The edits are still pending.'); };
      box.querySelector('[data-yes]').onclick = () => { box.remove(); save(true); };
      box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) e.preventDefault(); });
      box.querySelector('[data-no]').focus();
      say('Save on freight-prod asks first. Read the SQL, then Cancel or Save on freight-prod.');
    }

    dg.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-c]'), rowEl = e.target.closest('[data-r]');
      if (!cell || !rowEl || editing) return;
      sel = { r: +rowEl.dataset.r, c: +cell.dataset.c }; markSel(); dg.focus({ preventScroll: true });
    });
    dg.addEventListener('dblclick', (e) => { if (e.target.closest('[data-c]')) edit(); });
    dg.addEventListener('keydown', (e) => {
      if (editing) return;
      const k = e.key;
      if (k === 'ArrowDown') { sel.r = Math.min(rows.length - 1, sel.r + 1); }
      else if (k === 'ArrowUp') { sel.r = Math.max(0, sel.r - 1); }
      else if (k === 'ArrowRight') { sel.c = Math.min(COLS.length - 1, sel.c + 1); }
      else if (k === 'ArrowLeft') { sel.c = Math.max(0, sel.c - 1); }
      else if (k === 'Enter' || k === 'F2') { e.preventDefault(); edit(); return; }
      else if (k === 'Delete') { e.preventDefault(); delRow(); return; }
      else return;
      e.preventDefault(); markSel();
      const c = dg.querySelector('.sel'); c && c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    $('.pane').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (editing) { const i = dg.querySelector('input.ce'); i && commit(i.value); } save(); } });
    $('[data-add]').addEventListener('click', addRow);
    $('[data-delrow]').addEventListener('click', delRow);
    $('[data-reload]').addEventListener('click', () => { if (changes()) { say('Save or Discard the Pending Edits before you reload.'); return; } load(DATA.invoices.slice().sort((a, b) => a[0] - b[0]).slice(0, PAGE)); render(); });
    ebar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      if (b.dataset.k === 'pv') { previewOpen = !previewOpen; render(); }
      else if (b.dataset.k === 'discard') discard();
      else if (b.dataset.k === 'save') save();
    });
    doc.addEventListener('contura:data', () => getDB().then((db) => {
      const r = db.exec('SELECT id, customer_id, number, total, issued_at, status FROM billing.invoices ORDER BY id');
      DATA.invoices.length = 0; (r.length ? r[0].values : []).forEach((x) => DATA.invoices.push(x));
      if (!changes()) { load(DATA.invoices.slice(0, PAGE)); render(); }
    }, () => {}));

    /* the page control: which Connection the tab is on */
    if (ctl) ctl.querySelectorAll('button[data-conn]').forEach((b) => b.addEventListener('click', () => {
      prod = b.dataset.conn === 'prod';
      ctl.querySelectorAll('button[data-conn]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      conn(); render();
    }));
    conn(); render();
    /* scripted playback: the same paths a click or key takes */
    const api = {
      host, addRow, edit, save,
      get rows() { return rows; }, get prod() { return prod; }, get dialog() { return pane.querySelector('.scrim'); },
      setConn(p) { const b = ctl && ctl.querySelector('button[data-conn="' + (p ? 'prod' : 'stg') + '"]'); if (b) b.click(); else { prod = !!p; conn(); render(); } },
      startEdit(r, c) { if (editing) return; sel = { r, c }; markSel(); edit(); },
      typeEdit(v) { const i = dg.querySelector('input.ce'); if (i) { i.value = String(v); } },
      commitEdit() { const i = dg.querySelector('input.ce'); if (editing && i) commit(i.value); },
      setPreview(on) { if (!changes()) return; previewOpen = !!on; render(); },
      confirm(yes) { const box = pane.querySelector('.scrim'); if (!box) return false; box.querySelector(yes ? '[data-yes]' : '[data-no]').click(); return true; },
      reset() { const box = pane.querySelector('.scrim'); if (box) box.remove(); editing = null; previewOpen = false; lastSave = ''; load(DATA.invoices.slice().sort((a, b) => a[0] - b[0]).slice(0, PAGE)); sel = { r: 0, c: 1 }; render(); },
      $,
    };
    REG.set(host, api);
    return api;
  }

  /* ---------------- exports and mount ---------------- */
  window.ConturaDemos = { shell, tab, tree, featBar, DEFS2, ED_CSS, hlLine, statements, current, noWhere, isWrite, CONNS, PRESETS, createEditor, createGrid, get: (h) => REG.get(h) };
  doc.querySelectorAll('[data-editor]').forEach((h) => createEditor(h));
  doc.querySelectorAll('[data-grid]').forEach((h) => createGrid(h, doc.getElementById(h.dataset.grid)));
  doc.dispatchEvent(new CustomEvent('contura:demos-ready'));
})();
