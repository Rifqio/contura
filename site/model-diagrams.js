/* Contura site, Model page: the eight-kind .flow diagram gallery, loaded when its section comes near.
   Ported from the single-page site ([data-arch], its parser and drawing word for word) into a shadow root so its class
   names (.note, .ghost, .on, .mk ...) cannot meet site.css. The page tokens (--ground, --ink, --accent ...) inherit in;
   the app token pairs of the canvas switch with the page theme on .ar.dk. The Assistant's answers are pre-written.
   API: window.ConturaDiagrams.mount(outer) -> { kinds, showKind(kind|i), kind, text, setText(v), reset(), problem, bad, setPane(p), redraw() } */
(function () {
  'use strict';
  if (window.ConturaDiagrams) return;
  const CSS = ":host{display:block}*,*::before,*::after{box-sizing:border-box}.md-fr{position:relative;container-type:inline-size;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:var(--panel);box-shadow:0 1px 0 var(--line),0 24px 60px -32px var(--shade);font-family:var(--f-text);color:var(--ink);line-height:1.55}button,textarea{font:inherit;color:inherit}:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}[hidden]{display:none!important}.ar-pre{margin:0;padding:8px 12px;border-bottom:1px solid var(--line);font:400 0.75rem/1.45 var(--f-mono);color:var(--muted);background:color-mix(in srgb,var(--pend) 8%,var(--ground))}.ar-pre b{color:var(--pend);font-weight:600}\n.ar {\n  --a-canvas: #f8f4e3; --a-surface: #fffbeb; --a-tile: #fffbeb; --a-border: #cecbc0; --a-border-subtle: #e2deca; --a-border-strong: #8f8a73;\n  --a-text: #1f1f1f; --a-muted: #48432f; --a-subtle: #6c664b; --a-teal: #036a96; --a-tint: #dbe8ec; --a-accent: #644ac9; --a-panel: #efeddc;\n  --a-gold: #846e15; --a-type: #036a96; --a-ok: #14710a; --a-del: #cb3a2a;\n  --n-table-s: #478cc4; --n-table-f: #eaf5ff; --n-view-s: #8a7abc; --n-view-f: #f4f1ff; --n-enum-s: #b07a20; --n-enum-f: #fff1df;\n  --n-note-s: #95864c; --n-note-f: #faf4dd; --n-service-s: #489a68; --n-service-f: #e5faeb; --n-store-s: #2695ac; --n-store-f: #e0f9ff;\n  --n-ext-s: #868686; --n-ext-f: #f1f4f6;\n  --a-ui: \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, -apple-system, \"Helvetica Neue\", Arial, sans-serif;\n  --a-display: \"Segoe UI Variable Display\", \"Segoe UI\", system-ui, sans-serif;\n  display: flex; flex-direction: column; background: var(--ground); color: var(--ink);\n}\n\n.ar.dk {\n  --a-canvas: #21222c; --a-surface: #282a36; --a-tile: #f8f8f2; --a-border: #3b3d4f; --a-border-subtle: #191a21; --a-border-strong: #6272a4;\n  --a-text: #f8f8f2; --a-muted: #c7c8d3; --a-subtle: #a0a3ba; --a-teal: #8be9fd; --a-tint: #24384a; --a-accent: #bd93f9; --a-panel: #21222c;\n  --a-gold: #e9d98b; --a-type: #8be9fd; --a-ok: #50fa7b; --a-del: #ff6e6e;\n  --n-table-s: #599fd8; --n-table-f: #152839; --n-view-s: #9d8cd0; --n-view-f: #282238; --n-enum-s: #c38c37; --n-enum-f: #32230e;\n  --n-note-s: #a8985e; --n-note-f: #2d260e; --n-service-s: #5bac7a; --n-service-f: #152c1e; --n-store-s: #3fa8bf; --n-store-f: #0a2b33;\n  --n-ext-s: #989898; --n-ext-f: #252728;\n}\n\n/* the kind tabs: a tablist that scrolls inside its own bar, one indicator that travels between kinds */\n.ar-kinds { position: relative; display: flex; gap: 0; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; border-bottom: 1px solid var(--line); background: var(--panel); }\n.ar-kinds::-webkit-scrollbar { display: none; }\n.ar-kind { position: relative; flex: none; font: 500 0.8125rem/1 var(--f-mono); color: var(--muted); background: none; border: 0; border-right: 1px solid var(--line); padding: 0 16px; min-height: 40px; cursor: pointer; transition: color 0.3s var(--ease), background-color 0.3s var(--ease); }\n.ar-kind[aria-selected=\"true\"] { color: var(--ink); background: var(--ground); }\n.ar-ink { position: absolute; left: 0; bottom: 0; width: 100px; height: 2px; background: var(--accent); transform-origin: 0 50%; pointer-events: none; transition: transform 0.55s var(--ease); }\n.ar-kind:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }\n@media (hover: hover) { .ar-kind:hover { color: var(--ink); } }\n.ar-kind:active { background: var(--ground); }\n\n.ar-panel { display: grid; grid-template-columns: minmax(0, 1fr); }\n@container (min-width: 720px) { .ar-panel { grid-template-columns: minmax(280px, 31%) minmax(0, 1fr); grid-template-rows: auto clamp(420px, 40vw, 540px) auto; } }\n\n.ar-head { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; padding: 6px 14px; min-height: 40px; box-sizing: border-box; border-bottom: 1px solid var(--line); font-family: var(--f-mono); font-size: 0.75rem; color: var(--muted); }\n.ar-head b { color: var(--ink); font-weight: 500; }\n.ar-about { font-family: var(--f-text); font-size: 0.8125rem; }\n.ar-tabs { display: flex; gap: 2px; margin-left: auto; }\n.ar-tabs[hidden] + .ar-reset { margin-left: auto; }\n.ar-tab, .ar-reset { font: inherit; color: var(--muted); background: none; border: 1px solid transparent; border-radius: 4px; padding: 3px 9px; min-height: 28px; cursor: pointer; transition: color 0.3s var(--ease), border-color 0.3s var(--ease); }\n.ar-tab[aria-pressed=\"true\"] { color: var(--ink); border-color: var(--line); background: var(--panel); }\n.ar-reset { color: var(--accent); border-color: var(--line); }\n.ar-tab:focus-visible, .ar-reset:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n@media (hover: hover) { .ar-tab:hover { color: var(--ink); } .ar-reset:hover { border-color: var(--accent); } }\n\n.ar-ed { position: relative; overflow: auto; min-width: 0; height: 280px; font-family: var(--f-mono); font-size: 12.5px; font-variant-ligatures: none; overscroll-behavior: contain; }\n@container (min-width: 720px) { .ar-ed { flex: 1; height: auto; } }\n.ar-in { display: grid; grid-template-columns: 3em max-content; min-width: 100%; width: max-content; padding-block: 10px; }\n.ar-gut { color: var(--muted); text-align: right; padding-right: 1em; user-select: none; }\n.ar-gut span, .ar-hl .l { display: block; height: 20px; line-height: 20px; }\n.ar-gut span.bad { color: var(--pend); font-weight: 700; }\n.ar-gut span.hl, .ar-hl .l.hl { background: var(--sel); }\n.ar-box { position: relative; min-width: 24ch; padding-right: 16px; }\n.ar-hl, .ar-ta { margin: 0; font: inherit; line-height: 20px; white-space: pre; tab-size: 2; letter-spacing: 0; }\n.ar-hl { pointer-events: none; color: var(--ink); }\n.ar-ta { position: absolute; left: 0; top: 0; width: 100%; height: 100%; padding: 0; border: 0; outline: 0; resize: none; overflow: hidden; background: transparent; color: transparent; caret-color: var(--ink); }\n.ar-ta::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); color: transparent; }\n.ar-ed:focus-within { outline: 2px solid var(--accent); outline-offset: -2px; }\n@media (pointer: coarse) { .ar-ed { font-size: 16px; } .ar-gut span, .ar-hl .l { height: 24px; line-height: 24px; } .ar-hl, .ar-ta { line-height: 24px; } }\n.ar-k { color: var(--kw); } .ar-t { color: var(--type); font-style: italic; } .ar-s { color: var(--str); } .ar-p { color: var(--muted); }\n.ar-a { color: var(--num); } .ar-f { color: var(--fn); } .ar-c { color: var(--muted); font-style: italic; }\n.ar-hl .l.bad { text-decoration: underline wavy var(--pend); text-underline-offset: 4px; text-decoration-skip-ink: none; }\n\n.ar-cv { position: relative; min-width: 0; overflow: auto; background-color: var(--a-canvas); background-image: radial-gradient(color-mix(in srgb, var(--a-subtle) 30%, transparent) 1px, transparent 1.3px); background-size: 18px 18px; overscroll-behavior-x: contain; }\n.ar-world { position: relative; overflow: hidden; }\n.ar-inner { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; font-family: var(--a-ui); color: var(--a-text); }\n/* a kind switch: the drawing settles in from a little lower, on the page's one easing */\n.ar-world.swap .ar-inner > * { animation: ar-swap 0.5s var(--ease) both; }\n@keyframes ar-swap { from { opacity: 0; translate: 0 10px; } }\n.ar-cv.is-stale .ar-inner { opacity: 0.45; filter: grayscale(0.6); }\n.ar-stale { position: absolute; left: 8px; top: 8px; z-index: 2; max-width: calc(100% - 16px); box-sizing: border-box; margin: 0; padding: 5px 10px; font-family: var(--a-ui); font-size: 12px; color: var(--a-text); background: var(--a-surface); border: 1px solid var(--a-border); border-radius: 6px; }\n.ar-foot { grid-column: 1 / -1; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; padding: 6px 14px; border-top: 1px solid var(--line); font-family: var(--f-mono); font-size: 0.75rem; color: var(--muted); }\n.ar-prob.err { color: var(--pend); }\n\n/* lines and their ends (edges.tsx, app.css .edge-marker) */\n.ar-svg { position: absolute; overflow: visible; }\n.gl { fill: none; stroke: var(--a-subtle); stroke-width: 1.5; }\n.gl.dashed { stroke-dasharray: 5 4; }\n.gl.dotted { stroke-dasharray: 1 4; stroke-linecap: round; }\n.mf { fill: var(--a-subtle); }\n.ms { fill: none; stroke: var(--a-subtle); stroke-width: 1.5; }\n.ms.mh { fill: var(--a-canvas); }\n.gi { flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }\n/* group areas, sequence frames, timeline sections and line */\n.ga, .gf, .gs, .gx { position: absolute; box-sizing: border-box; }\n.ga { border: 1px dashed var(--a-teal); border-radius: 10px; background: color-mix(in srgb, var(--a-tint) 70%, transparent); }\n.ga.inner { border-style: solid; }\n.gname { position: absolute; top: 8px; left: 12px; display: flex; align-items: center; gap: 6px; color: var(--a-muted); font: 600 12px/16px var(--a-ui); white-space: nowrap; }\n.gname img { width: 16px; height: 16px; }\n.gname .sw { display: block; width: 16px; height: 16px; border-radius: 3px; background: var(--a-teal); }\n.gf { border: 1px solid var(--a-border-strong); border-radius: 6px; background: color-mix(in srgb, var(--a-panel) 40%, transparent); }\n.gft { position: absolute; z-index: 1; white-space: nowrap; display: inline-block; border-top: 1px solid var(--a-border-strong); border-left: 1px solid var(--a-border-strong); padding: 2px 8px; border-right: 1px solid var(--a-border-strong); border-bottom: 1px solid var(--a-border-strong); border-radius: 6px 0 6px 0; background: var(--a-surface); color: var(--a-muted); font: 600 12px/16px var(--a-ui); }\n.gs { border: 1px dashed var(--a-border); border-radius: 10px; background: color-mix(in srgb, var(--a-panel) 50%, transparent); }\n.gsn { display: block; padding: 8px 12px; color: var(--a-muted); font: 600 12px/16px var(--a-ui); }\n.gx::before { content: \"\"; position: absolute; top: 6px; left: 0; right: 0; height: 2px; border-radius: 1px; background: var(--a-border-strong); }\n.gx .tick { position: absolute; top: 1px; width: 12px; height: 12px; margin-left: -6px; box-sizing: border-box; border: 2px solid var(--n-table-s); border-radius: 999px; background: var(--a-canvas); }\n.gx .tick.ms { border-color: var(--n-enum-s); border-radius: 2px; transform: rotate(45deg); }\n/* label chips, ER relationship diamonds, sequence messages */\n.gc { position: absolute; z-index: 1; transform: translate(-50%, -50%); padding: 1px 6px; border: 1px solid var(--a-border-subtle); border-radius: 6px; background: var(--a-surface); color: var(--a-muted); font: 400 12px/16px var(--a-ui); white-space: nowrap; }\n\n.gc.msg { transform: translate(-50%, -100%); padding: 0 4px; border: 0; background: none; }\n\n/* shapes (flow-canvas.css); each sets its token pair */\n.gn { position: absolute; box-sizing: border-box; color: var(--a-text); font: 400 13px/18px var(--a-ui); white-space: nowrap; }\n.gn .nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; min-width: 0; }\n.gn .id { color: var(--a-muted); font: 400 11px/14px var(--f-mono); }\n.p-table { --f: var(--n-table-f); --s: var(--n-table-s); } .p-view { --f: var(--n-view-f); --s: var(--n-view-s); } .p-enum { --f: var(--n-enum-f); --s: var(--n-enum-s); }\n.p-note { --f: var(--n-note-f); --s: var(--n-note-s); } .p-service { --f: var(--n-service-f); --s: var(--n-service-s); } .p-store { --f: var(--n-store-f); --s: var(--n-store-s); }\n.p-ext { --f: var(--n-ext-f); --s: var(--n-ext-s); } .p-mark { --f: var(--n-ext-s); --s: var(--n-ext-s); }\n.gn.hl { outline: 2px solid var(--a-accent); outline-offset: 3px; }\n/* flowchart: pills, the step family, a slanted io, the one amber diamond, a document and a cylinder */\n.f-fc { display: grid; place-items: center; border: 1px solid var(--s); background: var(--f); text-align: center; }\n.f-fc .tx { position: relative; display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }\n.f-fc .nm { font-weight: 400; }\n.f-fc .lk { color: var(--s); }\n.gn-start, .gn-end { border-radius: 999px; padding: 0 18px; }\n.gn-step, .gn-subprocess { border-radius: 6px; padding: 0 8px; }\n.gn-subprocess { padding: 0 14px; box-shadow: inset 7px 0 0 -6px var(--s), inset -7px 0 0 -6px var(--s); }\n.gn-io, .gn-decision { border: 0; background: none; }\n.gn-io::before, .gn-decision::before { content: \"\"; position: absolute; box-sizing: border-box; border: 1px solid var(--s); background: var(--f); }\n.gn-io::before { inset: 0; border-radius: 3px; transform: skewX(-14deg); }\n.gn-decision::before { top: 18px; left: 18px; width: 80px; height: 80px; border-radius: 6px; transform: rotate(45deg); }\n.gn-decision .tx { max-width: 84px; white-space: normal; }\n.gn-decision .nm { font-size: 12px; line-height: 16px; }\n.gn-document { border-radius: 6px 6px 40% 10% / 6px 6px 12px 6px; padding: 0 10px; }\n.gn-database { border-radius: 50% / 10px; padding: 0 10px; }\n.gn-document .gi, .gn-database .gi { color: var(--s); }\n/* data flow, Modern: a pastel card with an icon tile, a dashed store edge and a double edge for an outside party */\n.f-dfd { display: flex; align-items: center; gap: 10px; padding: 0 12px 0 8px; border: 1px solid color-mix(in srgb, var(--s) 55%, transparent); border-radius: 8px; background: var(--f); }\n.f-dfd .tile { display: grid; flex: none; place-items: center; width: 32px; height: 32px; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--s) 40%, transparent); border-radius: 6px; background: var(--a-surface); color: var(--s); }\n.f-dfd .tx { display: flex; flex-direction: column; min-width: 0; }\n.f-dfd .sub { display: inline-flex; align-items: center; gap: 4px; color: var(--a-subtle); font-size: 12px; line-height: 16px; }\n.f-dfd .id { margin-left: auto; padding-left: 12px; }\n.gn-store { border-right-style: dashed; border-radius: 8px 2px 2px 8px; }\n.gn-external { outline: 1px solid color-mix(in srgb, var(--s) 55%, transparent); outline-offset: 2px; }\n/* cloud: a 48 px icon tile with the name under it */\n.f-service { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; text-align: center; }\n.f-service .tile { display: grid; place-items: center; width: 48px; height: 48px; flex: none; box-sizing: border-box; border: 1px solid var(--a-border); border-radius: 6px; background: var(--a-tile); }\n.f-service .tile img { width: 40px; height: 40px; }\n.f-service .tile.bare { border-color: transparent; background: transparent; }\n.f-service .tile.bare img { width: 48px; height: 48px; }\n.f-service .tile.unknown { border: 1px dashed var(--a-border-strong); background: var(--a-surface); color: var(--a-subtle); }\n.f-service .nm { max-width: 100%; font-weight: 400; }\n.f-service.hl { outline: 0; }\n.f-service.hl .tile { outline: 2px solid var(--a-accent); outline-offset: 1px; }\n/* the newer kinds: cards with rows, pills, markers, lifelines, topics, timeline cards and notes */\n.f-k { display: flex; flex-direction: column; border: 1px solid var(--s); border-radius: 6px; background: var(--f); }\n.kh { display: flex; align-items: center; gap: 6px; height: 32px; flex: none; padding: 0 10px; box-sizing: border-box; border-bottom: 1px solid var(--s); }\n.kh .gi { color: var(--s); }\n.kh-class { flex-direction: column; justify-content: center; gap: 0; height: auto; min-height: 32px; padding: 4px 10px; }\n.kh .st { color: var(--a-subtle); font-size: 12px; line-height: 16px; }\n.kr { margin: 0; padding: 3px 0; list-style: none; background: var(--a-surface); }\n.kr:last-child { flex: 1; border-radius: 0 0 5px 5px; }\n.kr + .kr { border-top: 1px solid var(--s); }\n.kr li { display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 10px; font: 400 12px/16px var(--f-mono); }\n.gn-erWeak { box-shadow: 0 0 0 3px var(--a-canvas), 0 0 0 4px var(--s); }\n.gn-interface { border-style: dashed; }\n.gn-state { display: grid; place-items: center; padding: 0 16px; border-radius: 999px; }\n.gn-choice { display: grid; place-items: center; border: 0; background: none; }\n.gn-choice::before { content: \"\"; position: absolute; inset: 9px; box-sizing: border-box; border: 1px solid var(--s); border-radius: 4px; background: var(--f); transform: rotate(45deg); }\n.gn-choice .cn { position: relative; max-width: 120px; font-size: 12px; font-weight: 400; transform: translateY(42px); }\n.gn-fork, .gn-stateStart { border: 0; background: var(--s); }\n.gn-fork { border-radius: 3px; }\n.gn-stateStart, .gn-stateEnd { border-radius: 999px; }\n.gn-stateEnd { border: 2px solid var(--s); background: var(--a-canvas); }\n.gn-stateEnd::before { content: \"\"; position: absolute; inset: 4px; border-radius: 999px; background: var(--s); }\n.gn-participant, .gn-actor { border: 0; background: none; }\n.gn-participant.hl, .gn-actor.hl { outline: 0; }\n.gn-participant.hl .life, .gn-actor.hl .life { outline: 2px solid var(--a-accent); outline-offset: 2px; }\n.life { justify-content: center; border: 1px solid var(--s); border-radius: 6px; background: var(--f); height: 40px; }\n.lifeline { position: absolute; top: 40px; bottom: 0; left: 50%; border-left: 1px dashed var(--a-border-strong); }\n.act { position: absolute; left: calc(50% - 5px); width: 10px; box-sizing: border-box; border: 1px solid var(--s); border-radius: 2px; background: var(--f); }\n.gn-root { display: grid; place-items: center; border-width: 2px; border-radius: 999px; }\n.gn-root .nm { font: 600 15px/20px var(--a-display); }\n.gn-topic { display: grid; place-items: center; padding: 0 14px; border-radius: 999px; }\n.gn-topic.d2, .gn-topic.d3 { border-width: 0 0 1px; border-radius: 0; background: none; padding: 0 4px; }\n.gn-topic.d2 .nm, .gn-topic.d3 .nm { font-weight: 400; }\n.gn-event, .gn-period, .gn-milestone { padding: 6px 10px; }\n.gn-period { border-radius: 999px; padding-inline: 16px; }\n.gn-milestone { border-width: 2px; }\n.time { display: flex; flex-direction: column; gap: 2px; min-width: 0; }\n.date { color: var(--a-subtle); font: 400 11px/14px var(--f-mono); font-variant-numeric: tabular-nums; }\n.gn-note { padding: 8px 10px; border-radius: 2px; white-space: normal; }\n.note { font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }\n\n.ar-new { animation: ar-in 0.16s var(--ease) both; }\n@keyframes ar-in { from { opacity: 0; scale: 0.96; } }\n@media (prefers-reduced-motion: reduce) {\n  .ar-new, .ar-world.swap .ar-inner > * { animation: none; }\n  .ar-kind, .ar-ink, .ar-tab, .ar-reset { transition: none; }\n}\n/* the left pane: Editor and Assistant on one sliding switch (board 11.5 .pswitch), in the page's own rails and easing */\n.ar-side { display: flex; flex-direction: column; min-width: 0; border-bottom: 1px solid var(--line); }\n@container (min-width: 720px) { .ar-side { min-height: 0; border-bottom: 0; border-right: 1px solid var(--line); } }\n.ar-sw { position: relative; flex: none; display: grid; grid-template-columns: 1fr 1fr; height: 44px; padding: 6px; box-sizing: border-box; background: var(--panel); border-bottom: 1px solid var(--line); }\n.ar-thumb { position: absolute; top: 6px; bottom: 6px; left: 6px; width: calc(50% - 6px); border-radius: 6px; background: var(--ground); box-shadow: 0 0 0 1px var(--line); transition: transform 0.45s var(--ease); }\n.ar-sw.right .ar-thumb { transform: translateX(100%); }\n.ar-pt { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 7px; min-width: 0; padding: 0 10px; border: 0; border-radius: 6px; background: none; color: var(--muted); font: 500 0.8125rem/1 var(--f-mono); cursor: pointer; transition: color 0.3s var(--ease); }\n.ar-pt.on { color: var(--ink); }\n.ar-pt.on .ai-ic:not(.ar-lk) { color: var(--accent); }\n.ar-pt:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }\n@media (hover: hover) { .ar-pt:hover { color: var(--ink); } }\n.ai-ic { flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }\n.ai-ic.ask .h { fill: currentColor; stroke: none; opacity: 0.35; }\n.ar-lk { color: var(--muted); }\n.ar-pc { min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 4px; background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--ink); font-size: 0.6875rem; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }\n.ar-pc[hidden], .ar-pdot[hidden] { display: none; }\n.ar-pt .ai-mark { padding: 2px 4px; }\n.ar-pdot { width: 6px; height: 6px; border-radius: 3px; background: var(--accent); animation: ai-live 1.2s cubic-bezier(.4, 0, .6, 1) infinite alternate; }\n@keyframes ai-live { to { opacity: 0.35; } }\n.ar-ebar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px 6px 12px; background: var(--panel); border-bottom: 1px solid var(--line); font-size: 0.8125rem; line-height: 1.35; color: var(--muted); }\n.ar-ebar .ai-ic { color: var(--muted); }\n.ai-fill { flex: 1 1 12ch; min-width: 0; }\n.ar-ed.locked .ar-in { opacity: 0.55; }\n.ar-ed[hidden], .ar-as[hidden], .ar-ebar[hidden], .ar-cwork[hidden], .ar-cform[hidden] { display: none; }\n.ar-pane-in { animation: ai-pane 0.45s var(--ease); }\n@keyframes ai-pane { from { opacity: 0; translate: 0 4px; } }\n\n/* the Assistant: a conversation over one file, then the composer */\n.ar-as { display: flex; flex-direction: column; min-width: 0; }\n@container (min-width: 720px) { .ar-as { flex: 1; min-height: 0; } }\n.ar-chat { flex: 1; min-height: 160px; max-height: 520px; overflow-y: auto; overscroll-behavior: contain; padding: 14px 14px 10px; display: flex; flex-direction: column; gap: 12px; font-size: 0.875rem; line-height: 1.45; color: var(--ink); scrollbar-width: thin; scrollbar-color: var(--line) transparent; container: aichat / inline-size; }\n@container aichat (max-width: 420px) { .ai-lands { flex-basis: 100%; padding-bottom: 2px; } }\n@container (min-width: 720px) { .ar-chat { min-height: 0; max-height: none; } }\n.ai-empty { display: flex; flex-direction: column; gap: 6px; color: var(--muted); }\n.ai-empty b { color: var(--ink); font-weight: 600; }\n.ai-sugs { display: flex; flex-direction: column; gap: 4px; }\n.ai-sug { width: 100%; box-sizing: border-box; text-align: left; padding: 7px 10px; min-height: 34px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--muted); font: inherit; cursor: pointer; transition: color 0.3s var(--ease), border-color 0.3s var(--ease); }\n@media (hover: hover) { .ai-sug:hover { color: var(--ink); border-color: var(--accent); } }\n.ai-sug:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n.ai-u { align-self: flex-end; max-width: 86%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow-wrap: anywhere; }\n.ai-a { display: flex; flex-direction: column; gap: 8px; min-width: 0; }\n.ai-a p { margin: 0; }\n.ai-text { overflow-wrap: anywhere; }\n.ai-after { display: flex; gap: 6px; align-items: flex-start; }\n.ai-after .ok { margin-top: 3px; color: var(--a-ok); }\n.ai-steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; font-family: var(--f-mono); font-size: 0.75rem; color: var(--muted); }\n.ai-steps li { display: flex; align-items: center; gap: 8px; }\n.ai-steps i { flex: none; width: 6px; height: 6px; border-radius: 3px; background: var(--line); }\n.ai-steps .done i { background: var(--a-ok); }\n.ai-steps .now { color: var(--ink); }\n.ai-steps .now i { background: var(--accent); animation: ai-live 1.2s cubic-bezier(.4, 0, .6, 1) infinite alternate; }\n.ai-steps .stopped i { background: var(--pend); }\n.ai-meta { font-family: var(--f-mono); font-size: 0.6875rem; color: var(--muted); font-variant-numeric: tabular-nums; }\n.ai-acts { display: flex; flex-wrap: wrap; gap: 6px; }\n.ai-card { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); overflow: hidden; animation: ai-pane 0.45s var(--ease); }\n.ai-ch { display: flex; align-items: center; gap: 8px; padding: 8px 8px 6px 12px; font-weight: 600; }\n.ai-row { font-variant-ligatures: none; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 6px; min-height: 30px; padding: 1px 6px 1px 12px; font: 400 0.75rem/16px var(--f-mono); }\n.ai-row .mk { font-weight: 600; text-align: center; }\n.ai-row.add .mk { color: var(--a-ok); } .ai-row.del .mk { color: var(--a-del); } .ai-row.ren .mk { color: var(--accent); } .ai-row.drop .mk { color: var(--pend); }\n.ai-row .tx { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.ai-row.off .tx, .ai-row.drop .tx { opacity: 0.5; text-decoration: line-through; }\n.ai-dtag { padding-right: 6px; color: var(--pend); font-size: 0.6875rem; }\n.ai-ib { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 1px solid transparent; border-radius: 4px; background: none; color: var(--muted); cursor: pointer; transition: color 0.3s var(--ease), border-color 0.3s var(--ease); }\n@media (hover: hover) { .ai-ib:hover { color: var(--ink); border-color: var(--line); } }\n.ai-ib:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }\n.ai-note { padding: 4px 12px 8px; font-size: 0.8125rem; line-height: 1.4; color: var(--muted); }\n.ai-foot { justify-content: flex-end; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border-top: 1px solid var(--line); }\n.ai-sp { flex: 1 1 0; }\n.ai-lands { padding-left: 4px; font-size: 0.75rem; color: var(--muted); }\n.ai-b { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 8px; box-sizing: border-box; border: 1px solid var(--line); border-radius: 4px; background: var(--ground); color: var(--ink); font: 500 0.75rem/1 var(--f-mono); white-space: nowrap; cursor: pointer; transition: border-color 0.3s var(--ease), background-color 0.3s var(--ease); }\n.ai-b.pri { background: var(--accent); border-color: var(--accent); color: var(--on-ink); }\n.ai-b:disabled { cursor: default; opacity: 0.5; }\n@media (hover: hover) { .ai-b:not(.pri):not(:disabled):hover { border-color: var(--accent); } .ai-b.pri:not(:disabled):hover { background: color-mix(in srgb, var(--accent) 88%, var(--ink)); } }\n.ai-b:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n.ai-b:active:not(:disabled) { translate: 0 1px; }\n.ar-kh { padding: 1px 4px; border: 1px solid color-mix(in srgb, currentColor 45%, transparent); border-radius: 3px; font-size: 0.6875rem; font-weight: 400; line-height: 14px; }\n@media (pointer: coarse) { .ar-kh { display: none; } }\n.ar-comp { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid var(--line); }\n.ar-cwork { display: flex; align-items: center; gap: 8px; min-height: 30px; font-size: 0.8125rem; color: var(--muted); }\n.ar-cwork span { flex: 1; min-width: 0; }\n.ar-cform { display: flex; flex-direction: column; gap: 6px; }\n.ar-seg { align-self: flex-start; display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }\n.ar-seg button { min-height: 24px; padding: 0 9px; border: 0; border-radius: 4px; background: none; color: var(--muted); font: 500 0.75rem/1 var(--f-mono); cursor: pointer; transition: color 0.3s var(--ease); }\n.ar-seg button[aria-checked=\"true\"] { background: var(--ground); color: var(--ink); box-shadow: inset 0 0 0 1px var(--accent); }\n.ar-seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n.ar-cbox { display: flex; align-items: flex-end; gap: 6px; padding: 4px 6px 6px 0; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); transition: border-color 0.3s var(--ease); }\n.ar-cbox:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }\n.ar-cin { flex: 1; min-width: 0; height: 52px; box-sizing: border-box; margin: 0; padding: 6px 4px 2px 10px; border: 0; outline: 0; resize: none; background: none; color: var(--ink); font: 400 0.875rem/1.35 var(--f-text); }\n.ar-cin::placeholder { color: var(--muted); opacity: 0.8; }\n@media (pointer: coarse) { .ar-cin { font-size: 16px; } }\n.ar-send { flex: none; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 6px; background: var(--accent); color: var(--on-ink); cursor: pointer; }\n.ar-send:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }\n.ar-send:active { translate: 0 1px; }\n.ai-vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }\n\n/* the canvas while changes wait (ghosts in green, .ghost and .gtag) and once they land (a ring that fades, .airing) */\n.gn.ai-ghost { --s: var(--a-ok); --f: color-mix(in srgb, var(--a-ok) 10%, var(--a-canvas)); border-style: dashed; }\n.gn.ai-ghost::before, .gn.ai-ghost .life { border-style: dashed; }\n.ai-tag { position: absolute; top: -10px; right: 8px; z-index: 2; height: 18px; padding: 0 6px; border-radius: 4px; background: var(--a-ok); color: var(--a-canvas); font: 600 11px/18px var(--a-ui); }\n.gl.ai-add { stroke: var(--a-ok); stroke-dasharray: 5 4; }\n.gn.ai-ring { outline: 2px solid var(--a-accent); outline-offset: 4px; animation: ai-fade 1.8s cubic-bezier(.4, 0, 1, 1) 0.6s both; }\n@keyframes ai-fade { to { outline-color: transparent; } }\n.gn-decision.ai-ring, .gn-choice.ai-ring { outline: 0; animation: none; }\n.gn-decision.ai-ring::before, .gn-choice.ai-ring::before { outline: 2px solid var(--a-accent); outline-offset: 4px; animation: ai-fade 1.8s cubic-bezier(.4, 0, 1, 1) 0.6s both; }\n.ar-gut span.ai { color: var(--a-ok); }\n.ar-hl .l.ai { background: color-mix(in srgb, var(--a-ok) 14%, transparent); }\n@media (prefers-reduced-motion: reduce) {\n  .ar-thumb, .ar-pt, .ai-sug, .ai-b, .ai-ib, .ar-seg button { transition: none; }\n  .ar-pane-in, .ai-card, .ar-pdot, .ai-steps .now i { animation: none; }\n  .gn.ai-ring, .gn-decision.ai-ring::before, .gn-choice.ai-ring::before { animation-duration: 0.01s; animation-delay: 2.4s; }\n}";
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const dark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : mq.matches);
  function mount(outer) {
    if (outer._cdApi) return outer._cdApi;
    const sr = outer.shadowRoot || outer.attachShadow({ mode: 'open' });
    sr.innerHTML = '<style>' + CSS + '</style><div class="md-fr"><div class="ar" data-arch></div></div>';
    const host = sr.querySelector('.ar');
    const AE = () => sr.activeElement || document.activeElement;
    const theme = () => host.classList.toggle('dk', dark());
    theme();
    document.addEventListener('contura:theme', theme);
    mq.addEventListener && mq.addEventListener('change', theme);
    outer._cdApi = (function () {

  const ICONS = {"users":"data:image/svg+xml,%3C!-- %40license lucide-static v1.59.0 - ISC --%3E%3Csvg class='lucide lucide-users' xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%0A%3E%3Cpath d='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' /%3E%3Cpath d='M16 3.128a4 4 0 0 1 0 7.744' /%3E%3Cpath d='M22 21v-2a4 4 0 0 0-3-3.87' /%3E%3Ccircle cx='9' cy='7' r='4' /%3E%3C/svg%3E","aws-group-cloud":"data:image/svg+xml,%3Csvg width='40px' height='40px' viewBox='0 0 40 40' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Cg id='Icon-Architecture-Group/32/AWS-Cloud_32' stroke='none' stroke-width='1' fill='none' fill-rule='evenodd'%3E%3Crect id='Rectangle' fill='%23242F3E' x='0' y='0' width='40' height='40'%3E%3C/rect%3E%3Cpath d='M28.993,27.9952689 L11.487,27.9762689 C9.121,27.9742689 7.154,26.1292689 7.012,23.7752689 C7.004,23.6522689 7,23.5262689 7,23.3972689 C7,20.2992689 9.091,19.2872689 10.337,18.9592689 C10.577,18.8962689 10.735,18.6662689 10.707,18.4192689 C10.676,18.1492689 10.659,17.8752689 10.659,17.5962689 C10.659,15.1322689 12.308,12.4822689 14.415,11.5632689 C15.359,11.1502689 16.232,10.9862689 17.023,10.9862689 C19.276,10.9862689 20.867,12.3152689 21.561,13.0332689 C22.329,13.8262689 22.927,14.8382689 23.34,16.0422689 C23.4,16.2192689 23.555,16.3472689 23.74,16.3742689 C23.918,16.4012689 24.109,16.3232689 24.219,16.1712689 C24.807,15.3502689 25.766,14.9822689 26.659,15.2392689 C27.782,15.5602689 28.516,16.7272689 28.62,18.3072689 C28.578,18.5762689 28.759,18.8292689 29.027,18.8772689 C30.222,19.0892689 33,19.9572689 33,23.4402689 C33,27.5892689 29.114,27.9822689 28.993,27.9952689 M29.594,17.9742689 C29.379,16.0672689 28.4,14.6962689 26.934,14.2782689 C25.899,13.9822689 24.811,14.2452689 23.989,14.9502689 C23.553,13.9362689 22.979,13.0602689 22.28,12.3382689 C20.023,10.0052689 16.933,9.37226889 14.014,10.6462689 C11.531,11.7302689 9.659,14.7182689 9.659,17.5962689 C9.659,17.7702689 9.665,17.9432689 9.676,18.1142689 C8.319,18.5732689 6,19.8752689 6,23.3972689 C6,23.5492689 6.004,23.6962689 6.014,23.8382689 C6.188,26.7162689 8.593,28.9732689 11.486,28.9762689 L29.034,28.9932689 C29.084,28.9892689 34,28.5192689 34,23.4402689 C34,19.5022689 31.003,18.3142689 29.594,17.9742689' id='Fill-1' fill='%23FFFFFF'%3E%3C/path%3E%3C/g%3E%3C/svg%3E","aws-group-region":"data:image/svg+xml,%3Csvg width='40px' height='40px' viewBox='0 0 40 40' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Cg id='Icon-Architecture-Group/32/Region_32' stroke='none' stroke-width='1' fill='none' fill-rule='evenodd'%3E%3Crect id='Rectangle' fill='%2300A4A6' x='0' y='0' width='40' height='40'%3E%3C/rect%3E%3Cpath d='M14,20.026 L14,11.026 L29.293,11.026 L25.146,15.172 C24.951,15.368 24.951,15.684 25.146,15.88 L29.293,20.026 L14,20.026 Z M26.207,15.526 L30.854,10.88 C30.996,10.736 31.039,10.522 30.962,10.335 C30.885,10.148 30.702,10.026 30.5,10.026 L14,10.026 L14,8.97 C14.596,8.76 15.026,8.198 15.026,7.531 C15.026,6.687 14.34,6 13.495,6 C12.65,6 11.963,6.687 11.963,7.531 C11.963,8.201 12.398,8.766 13,8.973 L13,33.026 L10,33.026 L10,34.026 L17,34.026 L17,33.026 L14,33.026 L14,21.026 L30.5,21.026 C30.702,21.026 30.885,20.904 30.962,20.717 C31.039,20.53 30.996,20.316 30.854,20.172 L26.207,15.526 Z' id='Fill-1' fill='%23FFFFFF'%3E%3C/path%3E%3C/g%3E%3C/svg%3E","aws-group-virtual-private-cloud-vpc":"data:image/svg+xml,%3Csvg width='40px' height='40px' viewBox='0 0 40 40' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Cg id='Icon-Architecture-Group/32/Virtual-private-cloud-VPC_32' stroke='none' stroke-width='1' fill='none' fill-rule='evenodd'%3E%3Crect id='Rectangle' fill='%238C4FFF' x='0' y='0' width='40' height='40'%3E%3C/rect%3E%3Cpath d='M30.9707,21.0293596 L28.0267,19.7663596 L28.0267,30.2553596 C30.5717,29.9033596 30.9587,27.2873596 30.9747,27.1683596 L30.9707,21.0293596 Z M27.0267,30.2693596 L27.0267,19.7593596 L23.9917,21.0323596 L23.9917,27.2333596 C24.0047,27.2873596 24.4367,30.0003596 27.0267,30.2693596 L27.0267,30.2693596 Z M27.3327,18.5473596 C27.4567,18.4943596 27.5987,18.4953596 27.7237,18.5483596 L31.6677,20.2403596 C31.8517,20.3193596 31.9707,20.4993596 31.9707,20.6993596 L31.9707,27.2333596 C31.7877,28.6803596 30.6137,31.2963596 27.4437,31.2963596 C24.3687,31.2963596 23.1897,28.6843596 22.9957,27.3023596 L22.9917,20.6993596 C22.9917,20.4983596 23.1127,20.3163596 23.2977,20.2383596 L27.3327,18.5473596 Z M32.9827022,19.1843596 L27.5217,16.7783596 L21.9917,19.1053596 L21.9917,26.2333596 C21.9907,26.2753596 21.9377,29.1013596 23.6487,30.8563596 C24.5657,31.7973596 25.8427,32.2753596 27.4437,32.2753596 C29.0457,32.2753596 30.3307,31.7963596 31.2627,30.8533596 C32.9977,29.0953596 32.9827022,26.2683596 32.9827022,26.2403596 L32.9827022,19.1843596 Z M31.9797,31.5503596 C30.8527,32.6943596 29.3257,33.2753596 27.4437,33.2753596 C25.5597,33.2753596 24.0397,32.6943596 22.9267,31.5483596 C20.9217,29.4853596 20.9877,26.3513596 20.9917,26.2193596 L20.9917,18.7733596 C20.9917,18.5723596 21.1117,18.3903596 21.2967,18.3123596 L27.3317,15.7723596 C27.4587,15.7203596 27.6027,15.7193596 27.7277,15.7763596 L33.6837,18.4013596 C33.8657,18.4813596 33.9827,18.6603596 33.9827,18.8583596 L33.9827,26.2333596 C33.9847,26.3583596 34.0097,29.4883596 31.9797,31.5503596 L31.9797,31.5503596 Z M10.9917,24.2363596 L18.9917,24.2363596 L18.9917,25.2363596 L10.9917,25.2363596 C8.1807,25.2363596 6.1807,23.2203596 6.0127,20.2203596 C6.0007,20.1093596 5.9997,19.9753596 5.9997,19.8413596 C5.9997,17.3323596 7.3177,15.6183596 9.8167,14.8623596 C9.7977,14.6353596 9.7847,14.3963596 9.7847,14.2153596 C9.7847,11.2993596 11.3617,8.77035958 13.8017,7.77035958 C17.0997,6.42235958 20.8437,6.87635958 22.9077,8.87435958 C23.6527,9.59835958 24.2317,10.4163596 24.6677,11.3593596 C25.2767,10.9093596 26.0677,10.6983596 27.0167,10.7453596 C28.7967,10.8353596 30.1657,12.4583596 30.4497,14.7523596 C31.9477,14.8763596 32.9347,15.6353596 33.4597,17.0603596 L32.5227,17.4063596 C32.0947,16.2493596 31.3147,15.7333596 29.9917,15.7333596 C29.7267,15.7333596 29.5077,15.5273596 29.4917,15.2633596 C29.3537,12.9253596 28.0857,11.8003596 26.9657,11.7443596 C26.0207,11.6913596 25.3207,11.9633596 24.8867,12.5353596 C24.7757,12.6803596 24.6017,12.7523596 24.4137,12.7283596 C24.2337,12.7003596 24.0817,12.5773596 24.0187,12.4053596 C23.6147,11.3023596 23.0237,10.3823596 22.2117,9.59135958 C20.4237,7.86135958 17.1217,7.49235958 14.1807,8.69635958 C12.1177,9.54135958 10.7847,11.7073596 10.7847,14.2153596 C10.7847,14.4883596 10.8197,14.9113596 10.8507,15.1743596 C10.8807,15.4253596 10.7197,15.6583596 10.4747,15.7183596 C8.1687,16.2903596 6.9997,17.6773596 6.9997,19.8413596 C6.9997,19.9423596 6.9987,20.0423596 7.0087,20.1433596 C7.1497,22.6383596 8.7117,24.2363596 10.9917,24.2363596 L10.9917,24.2363596 Z' id='Fill-1' fill='%23FFFFFF'%3E%3C/path%3E%3C/g%3E%3C/svg%3E","aws-cloudfront":"data:image/svg+xml,%3Csvg width='80px' height='80px' viewBox='0 0 80 80' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Cg id='Icon-Architecture/64/Arch_Amazon-CloudFront_64' stroke='none' stroke-width='1' fill='none' fill-rule='evenodd'%3E%3Cg id='Icon-Architecture-BG/64/Networking-Content-Delivery' fill='%238C4FFF'%3E%3Crect id='Rectangle' x='0' y='0' width='80' height='80'%3E%3C/rect%3E%3C/g%3E%3Cpath d='M55.122,52.123 C55.122,50.469 53.776,49.123 52.122,49.123 C50.468,49.123 49.122,50.469 49.122,52.123 C49.122,53.777 50.468,55.123 52.122,55.123 C53.776,55.123 55.122,53.777 55.122,52.123 L55.122,52.123 Z M57.122,52.123 C57.122,54.88 54.879,57.123 52.122,57.123 C49.365,57.123 47.122,54.88 47.122,52.123 C47.122,49.366 49.365,47.123 52.122,47.123 C54.879,47.123 57.122,49.366 57.122,52.123 L57.122,52.123 Z M30.392,37.692 C30.392,36.038 29.046,34.692 27.392,34.692 C25.737,34.692 24.392,36.038 24.392,37.692 C24.392,39.346 25.737,40.692 27.392,40.692 C29.046,40.692 30.392,39.346 30.392,37.692 L30.392,37.692 Z M32.392,37.692 C32.392,40.449 30.148,42.692 27.392,42.692 C24.635,42.692 22.392,40.449 22.392,37.692 C22.392,34.935 24.635,32.692 27.392,32.692 C30.148,32.692 32.392,34.935 32.392,37.692 L32.392,37.692 Z M39.73,22.007 C39.73,23.661 41.076,25.007 42.73,25.007 C44.385,25.007 45.73,23.661 45.73,22.007 C45.73,20.352 44.385,19.007 42.73,19.007 C41.076,19.007 39.73,20.352 39.73,22.007 L39.73,22.007 Z M37.73,22.007 C37.73,19.25 39.974,17.007 42.73,17.007 C45.487,17.007 47.73,19.25 47.73,22.007 C47.73,24.764 45.487,27.007 42.73,27.007 C39.974,27.007 37.73,24.764 37.73,22.007 L37.73,22.007 Z M66,40 C66,30.727 61.028,22.148 53.012,17.509 C51.575,17.799 50.185,18.196 48.451,18.823 L47.771,16.942 C48.676,16.616 49.486,16.352 50.266,16.126 C47.046,14.737 43.548,14 40,14 C38.311,14 36.649,14.175 35.025,14.492 C36.201,15.18 37.244,15.866 38.257,16.634 L37.048,18.227 C35.62,17.145 34.14,16.228 32.197,15.21 C22.378,18.298 15.306,26.958 14.183,37.128 C16.242,36.711 18.219,36.484 20.414,36.43 L20.463,38.429 C18.163,38.486 16.187,38.73 14.027,39.205 C14.018,39.47 14,39.738 14,40 C14,48.658 18.283,56.636 25.327,61.447 C24.074,57.716 23.45,54.19 23.45,50.746 C23.45,48.782 23.788,47.169 24.145,45.462 C24.228,45.067 24.312,44.665 24.394,44.248 L26.357,44.635 C26.273,45.059 26.187,45.47 26.103,45.873 C25.753,47.545 25.45,48.989 25.45,50.746 C25.45,54.654 26.308,58.695 28.054,63.083 C31.773,65.014 35.789,66 40,66 C42.756,66 45.446,65.56 48.012,64.714 C49.019,62.727 49.766,60.852 50.39,58.699 L52.311,59.256 C51.855,60.826 51.332,62.253 50.709,63.677 C52.323,62.951 53.85,62.053 55.283,61.005 C54.938,60.159 54.568,59.318 54.159,58.499 L55.948,57.604 C56.296,58.3 56.615,59.012 56.92,59.728 C62.705,54.775 66,47.66 66,40 L66,40 Z M68,40 C68,48.727 64.034,56.799 57.121,62.149 C55.409,63.479 53.552,64.583 51.589,65.472 C50.756,65.85 49.908,66.2 49.036,66.494 C46.156,67.493 43.113,68 40,68 C35.4,68 30.832,66.854 26.788,64.686 C17.667,59.806 12,50.347 12,40 C12,39.314 12.018,38.792 12.059,38.309 C12.74,26.625 20.756,16.512 32.001,13.166 C34.562,12.393 37.255,12 40,12 C44.808,12 49.539,13.238 53.684,15.579 C62.513,20.525 68,29.884 68,40 L68,40 Z M37.314,25.463 L36,23.956 C33.758,25.912 32.014,27.989 29.977,31.126 L31.655,32.215 C33.583,29.244 35.223,27.288 37.314,25.463 L37.314,25.463 Z M34.275,38.427 L33.625,40.318 C38.218,41.895 42.225,44.411 46.234,48.236 L47.615,46.789 C43.389,42.758 39.15,40.101 34.275,38.427 L34.275,38.427 Z M47.646,26.668 C51.398,32.39 53.511,38.671 53.925,45.338 L51.929,45.462 C51.536,39.146 49.533,33.192 45.975,27.765 L47.646,26.668 Z' id='Amazon-CloudFront_Icon_64_Squid' fill='%23FFFFFF'%3E%3C/path%3E%3C/g%3E%3C/svg%3E","aws-api-gateway":"data:image/svg+xml,%3Csvg width='80' height='80' viewBox='0 0 80 80' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cg id='Icon-Architecture/64/Arch_Amazon-API-Gateway_64'%3E%3Cg id='Icon-Architecture-BG/64/Networking-Content-Delivery'%3E%3Crect id='Rectangle' width='80' height='80' fill='%238C4FFF'/%3E%3C/g%3E%3Cg id='Icon-Service/64/Amazon-API-Gateway_64'%3E%3Cpath id='Amazon-API-Gateway_Icon_64_Squid' fill-rule='evenodd' clip-rule='evenodd' d='M34.065 55.6324H37V53.6153H34.065V55.6324ZM39 55.6324H42V53.6153H39V55.6324ZM27 14.6295L14 21.0821V61.1934L27 65.5896V14.6295ZM29 27.3934V53.6153H32V55.6324H29V66.9915C29 67.3162 28.845 67.6208 28.584 67.8104C28.412 67.9355 28.207 68 28 68C27.894 68 27.786 67.9829 27.682 67.9476L12.682 62.8756C12.274 62.7375 12 62.3522 12 61.9196V20.4537C12 20.0705 12.217 19.7185 12.559 19.5491L27.559 12.1041C27.868 11.9498 28.235 11.9679 28.528 12.1525C28.821 12.3361 29 12.6598 29 13.0087V25.3764H32V27.3934H29ZM44 55.6324H47V53.6153H44V55.6324ZM44.065 27.3934H47V25.3764H44.065V27.3934ZM39.065 27.3934H42V25.3764H39.065V27.3934ZM34.065 27.3934H37V25.3764H34.065V27.3934ZM66 21.0821L53 14.6295V65.5896L66 61.1934V21.0821ZM68 61.9196C68 62.3522 67.726 62.7375 67.318 62.8756L52.318 67.9476C52.214 67.9829 52.106 68 52 68C51.793 68 51.588 67.9355 51.416 67.8104C51.155 67.6208 51 67.3162 51 66.9915V55.6324H49.065V53.6153H51V27.3934H49.065V25.3764H51V13.0087C51 12.6598 51.179 12.3361 51.472 12.1525C51.765 11.9679 52.131 11.9498 52.441 12.1041L67.441 19.5491C67.783 19.7185 68 20.0705 68 20.4537V61.9196ZM42.934 33.8067L41.066 33.0826L36.066 46.1935L37.934 46.9176L42.934 33.8067ZM49.707 40.2089C50.098 39.8145 50.098 39.1761 49.707 38.7828L45.707 34.7487L44.293 36.1747L47.586 39.4958L44.293 42.8169L45.707 44.243L49.707 40.2089ZM34.293 44.243L30.293 40.2089C29.902 39.8145 29.902 39.1761 30.293 38.7828L34.293 34.7487L35.707 36.1747L32.414 39.4958L35.707 42.8169L34.293 44.243Z' fill='white'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E","aws-cognito":"data:image/svg+xml,%3Csvg width='80px' height='80px' viewBox='0 0 80 80' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Cg id='Icon-Architecture/64/Arch_Amazon-Cognito_64' stroke='none' stroke-width='1' fill='none' fill-rule='evenodd'%3E%3Cg id='Icon-Architecture-BG/64/Security-Identity-Compliance' fill='%23DD344C'%3E%3Crect id='Rectangle' x='0' y='0' width='80' height='80'%3E%3C/rect%3E%3C/g%3E%3Cpath d='M16.9635609,35.8079225 L29.8688192,35.8079225 L29.8688192,33.8253841 L16.9635609,33.8253841 L16.9635609,35.8079225 Z M61.3755183,50.2308895 L62.7792133,51.6325441 L55.4073327,58.9937093 C55.2127611,59.1870067 54.9586268,59.2841511 54.7054852,59.2841511 C54.4513509,59.2841511 54.1972166,59.1870067 54.0036377,58.9937093 L50.294865,55.2913188 L51.69856,53.8896641 L54.7054852,56.8912273 L61.3755183,50.2308895 Z M65.9439798,55.6937741 C65.7176414,57.5573602 64.9592093,59.29109 63.7471077,60.708605 C62.8864262,61.7157345 61.7994064,62.5484006 60.604181,63.1154066 C59.0009508,63.8757101 57.2200251,64.1641694 55.4460485,63.9480727 C53.7207147,63.7379237 52.0946522,63.057913 50.7396,61.9823859 C48.1367087,59.9155896 46.8223578,56.7108163 47.2224208,53.4088985 C47.6006441,50.2883831 49.4917608,47.5663578 52.2802893,46.127035 C53.6164799,45.4381029 55.0797377,45.0842198 56.5697987,45.0842198 C56.9519928,45.0842198 57.3371652,45.1080102 57.7213448,45.1545999 C60.8344902,45.534256 63.549558,47.4365016 64.9810489,50.2427847 C65.839745,51.9259598 66.1723036,53.8113538 65.9439798,55.6937741 L65.9439798,55.6937741 Z M66.750062,49.3437035 C65.0177793,45.9476152 61.731902,43.6458881 57.9615811,43.1869305 C55.6813213,42.9083838 53.4030468,43.3167868 51.3689796,44.3655496 C47.9957436,46.1062183 45.7085347,49.3982233 45.2508944,53.1709939 C44.7684363,57.1608525 46.3577685,61.0357238 49.5046661,63.5347135 C51.1456193,64.8372412 53.1171457,65.6609859 55.2048194,65.9157421 C55.6674233,65.9722445 56.1300272,66 56.5916383,66 C58.2713073,66 59.9301294,65.6292653 61.455928,64.9056388 C62.9023096,64.2196805 64.2176533,63.212551 65.2570229,61.9952724 C66.7232588,60.2803767 67.6425103,58.1838423 67.9155061,55.9316787 C68.1914801,53.6567158 67.788439,51.3787792 66.750062,49.3437035 L66.750062,49.3437035 Z M26.8906827,41.7555378 L30.8615314,41.7555378 L30.8615314,39.7729994 L26.8906827,39.7729994 L26.8906827,41.7555378 Z M16.9635609,41.7555378 L24.9052583,41.7555378 L24.9052583,39.7729994 L16.9635609,39.7729994 L16.9635609,41.7555378 Z M16.1058576,15.9825384 L60.5078879,15.9825384 C61.6773028,15.9825384 62.6283211,17.1393496 62.6283211,18.5608296 L62.6283211,25.8952305 L59.6501845,25.8952305 L59.6501845,20.9388844 C59.6501845,20.3917038 59.2064422,19.9476152 58.6574724,19.9476152 L35.8250923,19.9476152 C35.2761224,19.9476152 34.8323801,20.3917038 34.8323801,20.9388844 L34.8323801,25.8952305 L13.9854244,25.8952305 L13.9854244,18.5608296 C13.9854244,17.16314 14.9572896,15.9825384 16.1058576,15.9825384 L16.1058576,15.9825384 Z M47.256173,25.6077624 C49.5612507,25.6077624 51.436484,27.4614358 51.436484,29.7393725 C51.436484,31.2411453 50.6075693,32.6229746 49.2733642,33.3466011 C48.0066634,34.0335507 46.4798721,34.0246292 45.2300474,33.3475924 C43.9008058,32.6219833 43.075862,31.240154 43.075862,29.7393725 C43.075862,27.4614358 44.9501026,25.6077624 47.256173,25.6077624 L47.256173,25.6077624 Z M13.9854244,47.1083915 L13.9854244,27.8777689 L34.8323801,27.8777689 L34.8323801,44.7293454 C34.8323801,45.2775173 35.2761224,45.7206146 35.8250923,45.7206146 L46.2029054,45.7206146 L46.2029054,43.7380762 L37.9117733,43.7380762 C37.9981392,39.7710168 40.6357755,36.3441992 44.4338923,35.249838 C46.1890074,36.0696176 48.2846228,36.0775478 50.0665412,35.2488467 C52.2286683,35.8733463 54.1207777,37.3176255 55.2931708,39.2535743 L56.9917013,38.2266194 C55.7885342,36.2430897 53.9629365,34.6947272 51.8454814,33.7946548 C52.8381936,32.694346 53.4219083,31.2629532 53.4219083,29.7393725 C53.4219083,26.3680659 50.6552195,23.625224 47.256173,23.625224 C43.8561338,23.625224 41.0904377,26.3680659 41.0904377,29.7393725 C41.0904377,31.2570056 41.6681962,32.683442 42.6539593,33.7837508 C40.0004397,34.8999199 37.9276567,36.9924892 36.8178045,39.572763 L36.8178045,21.9301536 L57.6647602,21.9301536 L57.6647602,37.7904609 L59.6501845,37.7904609 L59.6501845,27.8777689 L62.6283211,27.8777689 L62.6293138,42.746807 L64.6147382,42.746807 L64.6137454,18.5608296 C64.6137454,16.0459796 62.7722643,14 60.5078879,14 L16.1058576,14 C13.8414811,14 12,16.0459796 12,18.5608296 L12,47.1083915 C12,49.6232415 13.8414811,51.6682298 16.1058576,51.6682298 L42.7740775,51.6682298 L42.7740775,49.6856914 L16.1058576,49.6856914 C14.9572896,49.6856914 13.9854244,48.5060811 13.9854244,47.1083915 L13.9854244,47.1083915 Z' id='Amazon-Cognito_Icon_64_Squid' fill='%23FFFFFF'%3E%3C/path%3E%3C/g%3E%3C/svg%3E","aws-lambda":"data:image/svg+xml,%3Csvg width='80px' height='80px' viewBox='0 0 80 80' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Cg id='Icon-Architecture/64/Arch_AWS-Lambda_64' stroke='none' stroke-width='1' fill='none' fill-rule='evenodd'%3E%3Cg id='Icon-Architecture-BG/64/Compute' fill='%23ED7100'%3E%3Crect id='Rectangle' x='0' y='0' width='80' height='80'%3E%3C/rect%3E%3C/g%3E%3Cpath d='M28.0075352,66 L15.5907274,66 L29.3235885,37.296 L35.5460249,50.106 L28.0075352,66 Z M30.2196674,34.553 C30.0512768,34.208 29.7004629,33.989 29.3175745,33.989 L29.3145676,33.989 C28.9286723,33.99 28.5778583,34.211 28.4124746,34.558 L13.097944,66.569 C12.9495999,66.879 12.9706487,67.243 13.1550766,67.534 C13.3374998,67.824 13.6582439,68 14.0020416,68 L28.6420072,68 C29.0299071,68 29.3817234,67.777 29.5481094,67.428 L37.563706,50.528 C37.693006,50.254 37.6920037,49.937 37.5586944,49.665 L30.2196674,34.553 Z M64.9953491,66 L52.6587274,66 L32.866809,24.57 C32.7014253,24.222 32.3486067,24 31.9617091,24 L23.8899822,24 L23.8990031,14 L39.7197081,14 L59.4204149,55.429 C59.5857986,55.777 59.9386172,56 60.3255148,56 L64.9953491,56 L64.9953491,66 Z M65.9976745,54 L60.9599868,54 L41.25928,12.571 C41.0938963,12.223 40.7410777,12 40.3531778,12 L22.89768,12 C22.3453987,12 21.8963569,12.447 21.8953545,12.999 L21.884329,24.999 C21.884329,25.265 21.9885708,25.519 22.1780103,25.707 C22.3654452,25.895 22.6200358,26 22.8866544,26 L31.3292417,26 L51.1221625,67.43 C51.2885485,67.778 51.6393624,68 52.02626,68 L65.9976745,68 C66.5519605,68 67,67.552 67,67 L67,55 C67,54.448 66.5519605,54 65.9976745,54 L65.9976745,54 Z' id='AWS-Lambda_Icon_64_Squid' fill='%23FFFFFF'%3E%3C/path%3E%3C/g%3E%3C/svg%3E","aws-sqs":"data:image/svg+xml,%3Csvg width='80px' height='80px' viewBox='0 0 80 80' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Cg id='Icon-Architecture/64/Arch_Amazon-Simple-Queue-Service_64' stroke='none' stroke-width='1' fill='none' fill-rule='evenodd'%3E%3Cg id='Icon-Architecture-BG/64/Application-Integration' fill='%23E7157B'%3E%3Crect id='Rectangle' x='0' y='0' width='80' height='80'%3E%3C/rect%3E%3C/g%3E%3Cpath d='M28.7169966,43.6876756 L31.7189265,40.721826 C31.9070474,40.5359011 32.0131156,40.2833614 32.0141233,40.019885 C32.0151169,39.7564086 31.9100493,39.5028747 31.722929,39.3159556 L28.7209992,36.3163014 L27.3020871,37.7181948 L28.5899149,39.0057494 L24.0089701,39.0057494 L24.0089701,40.9942506 L28.6059252,40.9942506 L27.3060896,42.2778282 L28.7169966,43.6876756 Z M51.627725,43.7781524 L55.630298,40.793412 C55.8804589,40.6054986 56.0295547,40.3112004 56.0295547,39.9990057 C56.0295547,39.6858168 55.8804589,39.3905244 55.6292974,39.202611 L51.6267243,36.2218476 L50.4259524,37.8126486 L52.0269816,39.0057494 L48.0244085,39.0057494 L48.0244085,40.9942506 L52.025981,40.9942506 L50.4249518,42.1873514 L51.627725,43.7781524 Z M35.2081695,40 C35.2081695,42.1107941 34.8429347,44.1012839 34.160496,45.8332685 C35.9606533,45.14127 37.9909585,44.7952708 40.0192624,44.7952708 C42.0475663,44.7952708 44.0778715,45.14127 45.8770281,45.8332685 C45.19559,44.1012839 44.8303552,42.1107941 44.8303552,40 C44.8303552,37.8892059 45.19559,35.8997104 45.8770281,34.1667315 C42.2777142,35.5497341 37.7608105,35.5497341 34.160496,34.1667315 C34.8429347,35.8997104 35.2081695,37.8892059 35.2081695,40 L35.2081695,40 Z M30.3060182,49.6511909 C30.1108927,49.4573121 30.0128297,49.2027839 30.0128297,48.9482557 C30.0128297,48.6937276 30.1108927,48.4391994 30.3060182,48.2453205 C32.1221857,46.4407556 33.206883,43.3575844 33.206883,40 C33.206883,36.6424156 32.1221857,33.5592444 30.3060182,31.7546795 C30.1108927,31.5608006 30.0128297,31.3062724 30.0128297,31.0517443 C30.0128297,30.7972161 30.1108927,30.5426879 30.3060182,30.3488091 C30.6972697,29.9600571 31.3296762,29.9600571 31.7209277,30.3488091 C35.5984204,34.2015303 44.4401044,34.2015303 48.317597,30.3488091 C48.7088485,29.9600571 49.3412551,29.9600571 49.7325066,30.3488091 C49.927632,30.5426879 50.0256951,30.7972161 50.0256951,31.0517443 C50.0256951,31.3062724 49.927632,31.5608006 49.7325066,31.7546795 C47.9163391,33.5592444 46.8316418,36.6424156 46.8316418,40 C46.8316418,43.3575844 47.9163391,46.4407556 49.7325066,48.2453205 C49.927632,48.4391994 50.0256951,48.6937276 50.0256951,48.9482557 C50.0256951,49.2027839 49.927632,49.4573121 49.7325066,49.6511909 C49.5373812,49.8450698 49.2812165,49.9425064 49.0250518,49.9425064 C48.7688871,49.9425064 48.5127225,49.8450698 48.317597,49.6511909 C44.4401044,45.7984697 35.5984204,45.7984697 31.7209277,49.6511909 C31.3296762,50.0399429 30.6972697,50.0399429 30.3060182,49.6511909 L30.3060182,49.6511909 Z M66.0009649,40.0049713 C66.0009649,39.0783297 65.6377314,38.2073661 64.9783075,37.5521549 C64.2978701,36.8750702 63.403295,36.5380193 62.5097205,36.5380193 C61.6161461,36.5380193 60.721571,36.8750702 60.0411336,37.5521549 C58.6792581,38.9043358 58.6792581,41.1046125 60.0411336,42.4577876 C61.4020084,43.8099684 63.6154313,43.8109627 64.9783075,42.4577876 C65.6377314,41.8025764 66.0009649,40.9316128 66.0009649,40.0049713 L66.0009649,40.0049713 Z M66.3932171,43.863658 C65.3225288,44.9275062 63.916625,45.4594303 62.5097205,45.4594303 C61.1028161,45.4594303 59.6969123,44.9275062 58.626224,43.863658 C56.4838468,41.7359616 56.4838468,38.2739809 58.626224,36.1462845 C60.7686012,34.0165997 64.2528411,34.0185882 66.3932171,36.1462845 C68.5355943,38.2739809 68.5355943,41.7359616 66.3932171,43.863658 L66.3932171,43.863658 Z M20.9800229,40.027839 C20.9800229,39.1011974 20.6167894,38.2302339 19.9573654,37.5750227 C19.2979415,36.9198115 18.421378,36.5588985 17.4887785,36.5588985 C16.5571796,36.5588985 15.6806161,36.9198115 15.0201916,37.5750227 C14.3607676,38.2302339 13.9985348,39.1011974 13.9985348,40.027839 C13.9985348,40.9534864 14.3607676,41.8244499 15.0201916,42.4806553 C16.34004,43.7900834 18.6385176,43.7900834 19.9573654,42.4806553 C20.6167894,41.8244499 20.9800229,40.9534864 20.9800229,40.027839 L20.9800229,40.027839 Z M21.372275,43.8865257 C20.3015867,44.9503739 18.8956829,45.482298 17.4887785,45.482298 C16.0828747,45.482298 14.6769709,44.9503739 13.605282,43.8865257 C11.464906,41.7588294 11.464906,38.2968487 13.605282,36.1691523 C15.7476592,34.0414559 19.2308984,34.0414559 21.372275,36.1691523 C23.5136516,38.2968487 23.5136516,41.7588294 21.372275,43.8865257 L21.372275,43.8865257 Z M54.8958259,54.856093 C50.901258,58.8261358 45.5888428,61.0114987 39.9392109,61.0114987 C34.2875777,61.0114987 28.9761632,58.8261358 24.9815953,54.856093 C22.241834,52.134829 20.7338646,48.8826352 19.9513616,46.6346345 L18.0601458,47.2848744 C18.9116932,49.730731 20.5577514,53.273246 23.5666857,56.2619634 C27.9394968,60.607833 33.7532342,63 39.9392109,63 C46.124187,63 51.9379244,60.607833 56.3107355,56.2619634 C58.8373597,53.7534691 60.8496533,50.563913 61.9793796,47.2818917 L60.0861625,46.6376173 C59.0534987,49.6382657 57.2103138,52.5573856 54.8958259,54.856093 L54.8958259,54.856093 Z M19.9503609,33.3663597 L18.0611465,32.7141313 C19.2719248,29.2501621 21.229183,26.0606061 23.5726896,23.7330653 C27.9434994,19.3911728 33.7552355,17 39.9392109,17 C46.1231863,17 51.9349225,19.3911728 56.3047316,23.7330653 C58.7713173,26.1838931 60.8396469,29.4569662 61.9773783,32.7141313 L60.0881638,33.3663597 C59.0444929,30.3836078 57.1502752,27.3849479 54.889822,25.1389357 C50.898256,21.1718757 45.5878422,18.9885013 39.9392109,18.9885013 C34.289579,18.9885013 28.9801658,21.1718757 24.9875992,25.1389357 C22.8542277,27.2596723 21.0650775,30.181775 19.9503609,33.3663597 L19.9503609,33.3663597 Z' id='AWS-Simple-Queue-Service_Icon_64_Squid' fill='%23FFFFFF'%3E%3C/path%3E%3C/g%3E%3C/svg%3E","aws-s3":"data:image/svg+xml,%3Csvg width='80px' height='80px' viewBox='0 0 80 80' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Cg id='Icon-Architecture/64/Arch_Amazon-Simple-Storage-Service_64' stroke='none' stroke-width='1' fill='none' fill-rule='evenodd'%3E%3Cg id='Icon-Architecture-BG/64/Storage' fill='%237AA116'%3E%3Crect id='Rectangle' x='0' y='0' width='80' height='80'%3E%3C/rect%3E%3C/g%3E%3Cg id='Icon-Service/64/Amazon-Simple-Storage-Service_64' transform='translate(12.999900, 11.999600)' fill='%23FFFFFF'%3E%3Cpath d='M47.836,30.893 L48.22,28.189 C51.761,30.31 51.807,31.186 51.8060132,31.21 C51.8,31.215 51.196,31.719 47.836,30.893 L47.836,30.893 Z M45.893,30.353 C39.773,28.501 31.25,24.591 27.801,22.961 C27.801,22.947 27.805,22.934 27.805,22.92 C27.805,21.595 26.727,20.517 25.401,20.517 C24.077,20.517 22.999,21.595 22.999,22.92 C22.999,24.245 24.077,25.323 25.401,25.323 C25.983,25.323 26.511,25.106 26.928,24.761 C30.986,26.682 39.443,30.535 45.608,32.355 L43.17,49.561 C43.163,49.608 43.16,49.655 43.16,49.702 C43.16,51.217 36.453,54 25.494,54 C14.419,54 7.641,51.217 7.641,49.702 C7.641,49.656 7.638,49.611 7.632,49.566 L2.538,12.359 C6.947,15.394 16.43,17 25.5,17 C34.556,17 44.023,15.4 48.441,12.374 L45.893,30.353 Z M2,8.478 C2.072,7.162 9.634,2 25.5,2 C41.364,2 48.927,7.161 49,8.478 L49,8.927 C48.13,11.878 38.33,15 25.5,15 C12.648,15 2.843,11.868 2,8.913 L2,8.478 Z M51,8.5 C51,5.035 41.066,0 25.5,0 C9.934,0 0,5.035 0,8.5 L0.094,9.254 L5.642,49.778 C5.775,54.31 17.861,56 25.494,56 C34.966,56 45.029,53.822 45.159,49.781 L47.555,32.884 C48.888,33.203 49.985,33.366 50.866,33.366 C52.049,33.366 52.849,33.077 53.334,32.499 C53.732,32.025 53.884,31.451 53.77,30.84 C53.511,29.456 51.868,27.964 48.522,26.055 L50.898,9.293 L51,8.5 Z' id='Amazon-Simple-Storage-Service-Icon_64_Squid'%3E%3C/path%3E%3C/g%3E%3C/g%3E%3C/svg%3E","aws-rds":"data:image/svg+xml,%3Csvg width='80px' height='80px' viewBox='0 0 80 80' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Cg id='Icon-Architecture/64/Arch_Amazon-RDS_64' stroke='none' stroke-width='1' fill='none' fill-rule='evenodd'%3E%3Cg id='Icon-Architecture-BG/64/Database' fill='%23C925D1'%3E%3Crect id='Rectangle' x='0' y='0' width='80' height='80'%3E%3C/rect%3E%3C/g%3E%3Cpath d='M15.414,14 L24.707,23.293 L23.293,24.707 L14,15.414 L14,23 L12,23 L12,13 C12,12.448 12.447,12 13,12 L23,12 L23,14 L15.414,14 Z M68,13 L68,23 L66,23 L66,15.414 L56.707,24.707 L55.293,23.293 L64.586,14 L57,14 L57,12 L67,12 C67.553,12 68,12.448 68,13 L68,13 Z M66,57 L68,57 L68,67 C68,67.552 67.553,68 67,68 L57,68 L57,66 L64.586,66 L55.293,56.707 L56.707,55.293 L66,64.586 L66,57 Z M65.5,39.213 C65.5,35.894 61.668,32.615 55.25,30.442 L55.891,28.548 C63.268,31.045 67.5,34.932 67.5,39.213 C67.5,43.495 63.268,47.383 55.89,49.879 L55.249,47.984 C61.668,45.812 65.5,42.534 65.5,39.213 L65.5,39.213 Z M14.556,39.213 C14.556,42.393 18.143,45.585 24.152,47.753 L23.473,49.634 C16.535,47.131 12.556,43.333 12.556,39.213 C12.556,35.094 16.535,31.296 23.473,28.792 L24.152,30.673 C18.143,32.842 14.556,36.034 14.556,39.213 L14.556,39.213 Z M24.707,56.707 L15.414,66 L23,66 L23,68 L13,68 C12.447,68 12,67.552 12,67 L12,57 L14,57 L14,64.586 L23.293,55.293 L24.707,56.707 Z M40,31.286 C32.854,31.286 29,29.44 29,28.686 C29,27.931 32.854,26.086 40,26.086 C47.145,26.086 51,27.931 51,28.686 C51,29.44 47.145,31.286 40,31.286 L40,31.286 Z M40.029,39.031 C33.187,39.031 29,37.162 29,36.145 L29,31.284 C31.463,32.643 35.832,33.286 40,33.286 C44.168,33.286 48.537,32.643 51,31.284 L51,36.145 C51,37.163 46.835,39.031 40.029,39.031 L40.029,39.031 Z M40.029,46.667 C33.187,46.667 29,44.798 29,43.781 L29,38.862 C31.431,40.291 35.742,41.031 40.029,41.031 C44.292,41.031 48.578,40.292 51,38.867 L51,43.781 C51,44.799 46.835,46.667 40.029,46.667 L40.029,46.667 Z M40,53.518 C32.883,53.518 29,51.605 29,50.622 L29,46.498 C31.431,47.927 35.742,48.667 40.029,48.667 C44.292,48.667 48.578,47.929 51,46.503 L51,50.622 C51,51.605 47.117,53.518 40,53.518 L40,53.518 Z M40,24.086 C33.739,24.086 27,25.525 27,28.686 L27,50.622 C27,53.836 33.54,55.518 40,55.518 C46.46,55.518 53,53.836 53,50.622 L53,28.686 C53,25.525 46.261,24.086 40,24.086 L40,24.086 Z' id='Amazon-RDS_Icon_64_Squid' fill='%23FFFFFF'%3E%3C/path%3E%3C/g%3E%3C/svg%3E","gcp-project":"data:image/svg+xml,%3Csvg version='1.1' baseProfile='tiny' id='Layer_1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' x='0px' y='0px' width='24px' height='24px' viewBox='0 0 24 24' overflow='visible' xml:space='preserve'%3E%3Cg %3E%3Crect y='0' fill='none' width='24' height='24'/%3E%3Cpolygon fill-rule='evenodd' fill='%2385A4E6' points='0.8,5.9 3.7,0.8 9.5,0.8 12.4,5.9 9.5,10.9 3.7,10.9 '/%3E%3Cpolygon fill-rule='evenodd' fill='%235C85DE' points='11.4,7.7 8.5,2.6 9.5,0.7 12.4,5.9 '/%3E%3Cpolygon id='Shape-Copy_00000019646383529055310330000009913415011964925323_' fill-rule='evenodd' fill='%233367D6' points=' 2.7,9.3 8.5,9.3 10.5,5.9 11.4,7.7 9.5,10.9 3.7,11 '/%3E%3Cpolygon fill-rule='evenodd' fill='%2385A4E6' points='11.2,11.9 14.2,6.8 20,6.8 22.9,11.9 20,16.9 14.2,16.9 '/%3E%3Cpolygon id='Shape-Copy_00000133527958483064390410000012377415375428947900_' fill-rule='evenodd' fill='%235C85DE' points=' 21.9,13.7 19,8.6 20,6.7 22.9,11.9 '/%3E%3Cpolygon id='Shape-Copy_00000176019471624316745960000001248137580190207128_' fill-rule='evenodd' fill='%233367D6' points=' 13.2,15.3 19,15.3 21,11.9 21.9,13.7 20,16.9 14.2,17 '/%3E%3Cpolygon fill-rule='evenodd' fill='%2385A4E6' points='0.8,17.9 3.7,12.8 9.5,12.8 12.4,17.9 9.5,22.9 3.7,22.9 '/%3E%3Cpolygon id='Shape-Copy_00000096041779745201399360000017167964797373102485_' fill-rule='evenodd' fill='%235C85DE' points=' 11.4,19.7 8.5,14.6 9.5,12.7 12.4,17.9 '/%3E%3Cpolygon id='Shape-Copy_00000049204188488742950820000010444321201512143025_' fill-rule='evenodd' fill='%233367D6' points=' 2.7,21.3 8.5,21.3 10.5,17.9 11.4,19.7 9.5,22.9 3.7,23 '/%3E%3C/g%3E%3C/svg%3E","gcp-virtual-private-cloud":"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24px' height='24px' viewBox='0 0 24 24'%3E%3Cdefs%3E%3Cstyle%3E.cls-1%7Bfill:%23aecbfa;%7D.cls-2%7Bfill:%23669df6;%7D.cls-3%7Bfill:%234285f4;%7D%3C/style%3E%3C/defs%3E%3Cg data-name='Product Icons'%3E%3Crect class='cls-1' x='16' y='2' width='6' height='6'/%3E%3Crect class='cls-2' x='19' y='2' width='3' height='6'/%3E%3Crect class='cls-1' x='16' y='16' width='6' height='6'/%3E%3Crect class='cls-2' x='19' y='16' width='3' height='6'/%3E%3Crect class='cls-1' x='2' y='2' width='6' height='6'/%3E%3Crect class='cls-2' x='5' y='2' width='3' height='6'/%3E%3Crect class='cls-1' x='2' y='16' width='6' height='6'/%3E%3Crect class='cls-2' x='5' y='16' width='3' height='6'/%3E%3Crect class='cls-2' x='8' y='4' width='8' height='2'/%3E%3Crect class='cls-2' x='8' y='18' width='8' height='2'/%3E%3Crect class='cls-2' x='18' y='8' width='2' height='8'/%3E%3Crect class='cls-2' x='4' y='8' width='2' height='8'/%3E%3Crect class='cls-3' x='4' y='8' width='2' height='2'/%3E%3Crect class='cls-3' x='18' y='8' width='2' height='2'/%3E%3Crect class='cls-3' x='8' y='4' width='2' height='2'/%3E%3Crect class='cls-3' x='8' y='18' width='2' height='2'/%3E%3C/g%3E%3C/svg%3E","gcp-cloud-load-balancing":"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24px' height='24px' viewBox='0 0 24 24'%3E%3Cdefs%3E%3Cstyle%3E.cls-1%7Bfill:none;%7D.cls-2%7Bfill:%23669df6;%7D.cls-3%7Bfill:%234285f4;%7D.cls-4%7Bfill:%23aecbfa;%7D%3C/style%3E%3C/defs%3E%3Cg data-name='Product Icons'%3E%3Cg data-name='colored-32/load-balancing'%3E%3Crect class='cls-1' width='24' height='24'/%3E%3Cg %3E%3Crect class='cls-2' x='18' y='12' width='2' height='4'/%3E%3Crect class='cls-2' x='11' y='12' width='2' height='4'/%3E%3Crect class='cls-2' x='4' y='12' width='2' height='4'/%3E%3Cpolygon id='Fill-2' class='cls-3' points='13 11 11 11 11 7 13 7 13 11'/%3E%3Crect class='cls-2' x='4' y='11' width='16' height='2'/%3E%3Crect class='cls-4' x='6' y='2' width='12' height='5'/%3E%3Crect class='cls-2' x='12' y='2' width='6' height='5'/%3E%3Crect class='cls-4' x='16' y='16' width='6' height='6'/%3E%3Crect class='cls-4' x='2' y='16' width='6' height='6'/%3E%3Crect class='cls-2' x='5' y='16' width='3' height='6'/%3E%3Crect class='cls-4' x='9' y='16' width='6' height='6'/%3E%3Crect class='cls-2' x='12' y='16' width='3' height='6'/%3E%3Crect class='cls-2' x='19' y='16' width='3' height='6'/%3E%3C/g%3E%3C/g%3E%3C/g%3E%3C/svg%3E","gcp-cloud-api-gateway":"data:image/svg+xml,%3Csvg width='24px' height='24px' viewBox='0 0 24 24' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Cg stroke='none' stroke-width='1' fill='none' fill-rule='evenodd'%3E%3Cg transform='translate(2.000000, 2.000000)' fill='%234285F4'%3E%3Cpath d='M10.346494,3.74811293e-13 C11.0558919,3.74811293e-13 11.6561001,0.393257293 12.1463703,1.05722297 C12.545754,1.59810241 12.8906844,2.34424015 13.1766575,3.25989455 C13.7389373,5.0602526 14.0566038,7.46502511 14.0566038,10.0235849 C14.0566038,12.5821447 13.7389373,14.9869172 13.1766575,16.7872753 C12.8906844,17.7029297 12.545754,18.4490674 12.1463703,18.9899468 C11.6561001,19.6539125 11.0558919,20.0471698 10.346494,20.0471698 C8.72332981,20.0471698 7.71939051,18.6289665 7.18391951,16.2085035 C7.16763434,16.1348905 7.16352632,16.061587 7.1703186,15.9903838 L8.80030207,15.9906287 C9.02021233,16.9694558 9.29621728,17.9312563 9.60329039,18.2496177 C9.80793547,18.4617857 10.0156954,18.5377358 10.346494,18.5377358 C10.3525053,18.5377358 10.3600292,18.5365147 10.3722666,18.5325354 C10.3950863,18.5251152 10.4240204,18.5109595 10.4588816,18.4881184 C10.5594824,18.4222046 10.6765815,18.3055866 10.8002002,18.1381716 C11.0884945,17.7477389 11.3684471,17.1421582 11.6102121,16.3680533 C12.12669,14.7143481 12.4260072,12.4484812 12.4260072,10.0235849 C12.4260072,7.5986886 12.12669,5.33282174 11.6102121,3.67911654 C11.3684471,2.90501164 11.0884945,2.29943089 10.8002002,1.90899817 C10.6765815,1.74158318 10.5594824,1.62496519 10.4588816,1.55905144 C10.4240204,1.53621032 10.3950863,1.52205463 10.3722666,1.51463437 C10.3600292,1.51065511 10.3525053,1.50943396 10.346494,1.50943396 C10.0809615,1.50943396 9.84647729,1.634002 9.59030056,1.97294969 C9.26394433,2.40475194 8.97946101,3.11005339 8.75982164,4.10291376 L7.09890062,4.10249714 C7.36411395,2.76995886 7.74433512,1.78229785 8.25423786,1.10764503 C8.80249145,0.382250163 9.52203091,3.74811293e-13 10.346494,3.74811293e-13 Z M10.5660377,12.5 L10.5660377,14.009434 L2.64150943,14.009434 C2.22469075,14.009434 1.88679245,13.6715357 1.88679245,13.254717 C1.88679245,12.8378983 2.22469075,12.5 2.64150943,12.5 L10.5660377,12.5 Z M19.245283,10.8962669 C19.6621017,10.8962669 20,11.2341652 20,11.6509839 C20,12.0678025 19.6621017,12.4057008 19.245283,12.4057008 L15.5018248,12.4066389 C15.5638331,11.915011 15.6081639,11.4104043 15.6339123,10.8966965 L19.245283,10.8962669 Z M10.5660377,9.29245283 L10.5660377,10.8018868 L0.754716981,10.8018868 C0.337898302,10.8018868 -1.89337682e-14,10.4639885 -1.86517468e-14,10.0471698 C-1.87027924e-14,9.63035113 0.337898302,9.29245283 0.754716981,9.29245283 L10.5660377,9.29245283 Z M15.5506141,7.68763695 L19.245283,7.68871971 C19.6621017,7.68871971 20,8.02661801 20,8.44343669 C20,8.82552048 19.7160716,9.14128923 19.3476936,9.19126399 L19.245283,9.19815367 L15.6508837,9.19777015 C15.6355715,8.68528869 15.601857,8.18066214 15.5506141,7.68763695 Z M10.5660377,6.08490566 L10.5660377,7.59433962 L2.64150943,7.59433962 C2.22469075,7.59433962 1.88679245,7.25644132 1.88679245,6.83962264 C1.88679245,6.45753885 2.17072089,6.1417701 2.53909881,6.09179534 L2.64150943,6.08490566 L10.5660377,6.08490566 Z' %3E%3C/path%3E%3C/g%3E%3C/g%3E%3C/svg%3E","gcp-identity-platform":"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24px' height='24px' viewBox='0 0 24 24'%3E%3Cdefs%3E%3Cstyle%3E.cls-1%7Bfill:%23669df6;%7D.cls-1,.cls-2%7Bfill-rule:evenodd;%7D.cls-2%7Bfill:%234285f4;%7D%3C/style%3E%3C/defs%3E%3Cg data-name='Product Icons'%3E%3Cg %3E%3Cpath class='cls-1' d='M3.33,7,12,2l8.66,5v9.72L17.33,14H6.67L3.33,16.67ZM16,8.67a4,4,0,1,0-4,4A4,4,0,0,0,16,8.67Zm-1.33,0A2.67,2.67,0,1,1,12,6,2.67,2.67,0,0,1,14.67,8.67Z'/%3E%3Cpath class='cls-2' d='M12,12.67a4,4,0,0,0,0-8V2l8.66,5v9.72L17.33,14H12Zm2.67-4A2.67,2.67,0,0,1,12,11.31V6A2.67,2.67,0,0,1,14.67,8.66Z'/%3E%3Cpolygon class='cls-1' points='4 18 12 22 20 18 16.67 15.33 7.33 15.33 4 18'/%3E%3Cpolygon class='cls-2' points='12 22 20 18 16.67 15.33 12 15.33 12 22'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E","gcp-cloud-run":"data:image/svg+xml,%3Csvg id='standard_product_icon' xmlns='http://www.w3.org/2000/svg' version='1.1' viewBox='0 0 512 512'%3E%3Cdefs%3E%3Cstyle%3E .st0 %7B fill: none; %7D .st1 %7B fill: %234285f4; %7D .st2 %7B fill: %2334a853; %7D .st3 %7B fill: %23fbbc04; %7D .st4 %7B fill: %23ea4335; %7D %3C/style%3E%3C/defs%3E%3Cg id='bounding_box'%3E%3Crect class='st0' width='512' height='512'/%3E%3C/g%3E%3Cg id='art'%3E%3Cpath class='st3' d='M144.4,272c-6.4,0-12.4-3.8-14.9-10.1L55.4,75.9c-3.3-8.2.7-17.5,8.9-20.8,8.2-3.3,17.5.7,20.8,8.9l74.2,186c3.3,8.2-.7,17.5-8.9,20.8-1.9.8-3.9,1.1-5.9,1.1h-.1Z'/%3E%3Cg id='b'%3E%3Cpath class='st4' d='M256,272c-6.4,0-12.4-3.8-14.9-10.1l-74.1-186c-2.6-6.6-.6-14.1,5-18.5s13.4-4.5,19.2-.4l260.1,186c7.2,5.1,8.9,15.1,3.7,22.3s-15.1,8.9-22.3,3.7L216.9,114.7l54,135.3c3.3,8.2-.7,17.5-8.9,20.8-1.9.8-4,1.1-5.9,1.1h-.1Z'/%3E%3C/g%3E%3Cpath class='st2' d='M127.2,256l-72,180c-3.3,8.2.7,17.5,8.9,20.8,3.1,1.2,4,1.1,5.9,1.1,6.3,0,12.4-3.8,14.9-10.1l74.4-186c.8-2,1.1-4,1.1-5.9h-33.2Z'/%3E%3Cpath class='st1' d='M414.5,256l-197.7,141.2,54.1-135.3c.8-2,1.1-4,1.1-5.9h-33.2l-72,180c-2.6,6.6-.6,14.1,5,18.5,2.9,2.3,6.4,3.4,9.9,3.4s6.5-1,9.3-3l260.4-186c4.4-3.1,6.7-8,6.7-13h-43.6Z'/%3E%3C/g%3E%3C/svg%3E","gcp-pubsub":"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' width='24px' height='24px' viewBox='0 0 24 24'%3E%3Cdefs%3E%3Cstyle%3E.cls-1%7Bfilter:url(%23luminosity-noclip);%7D.cls-2%7Bfill:%23669df6;%7D.cls-3%7Bmask:url(%23mask);%7D.cls-4%7Bfill:%234285f4;%7D.cls-5%7Bfill:%23aecbfa;%7D%3C/style%3E%3Cfilter id='luminosity-noclip' x='4.64' y='4.19' width='14.73' height='12.76' filterUnits='userSpaceOnUse' color-interpolation-filters='sRGB'%3E%3CfeFlood flood-color='%23fff' result='bg'/%3E%3CfeBlend in='SourceGraphic' in2='bg'/%3E%3C/filter%3E%3Cmask id='mask' x='4.64' y='4.19' width='14.73' height='12.76' maskUnits='userSpaceOnUse'%3E%3Ccircle class='cls-1' cx='12' cy='12.23' r='3.58'/%3E%3C/mask%3E%3C/defs%3E%3Cg data-name='Product Icons'%3E%3Ccircle class='cls-2' cx='18.97' cy='8.21' r='1.72'/%3E%3Ccircle class='cls-2' cx='5.03' cy='8.21' r='1.72'/%3E%3Ccircle class='cls-2' cx='12' cy='20.28' r='1.72'/%3E%3Cg class='cls-3'%3E%3Crect class='cls-4' x='14.69' y='10.22' width='1.59' height='8.04' transform='matrix(0.5, -0.87, 0.87, 0.5, -4.59, 20.53)'/%3E%3Crect class='cls-4' x='4.49' y='13.45' width='8.04' height='1.59' transform='translate(-5.98 6.17) rotate(-30)'/%3E%3Crect class='cls-4' x='11.2' y='4.19' width='1.59' height='8.04'/%3E%3C/g%3E%3Ccircle class='cls-5' cx='12' cy='12.23' r='2.78'/%3E%3Ccircle class='cls-5' cx='5.03' cy='16.25' r='2.19'/%3E%3Ccircle class='cls-5' cx='18.97' cy='16.25' r='2.19'/%3E%3Ccircle class='cls-5' cx='12' cy='4.19' r='2.19'/%3E%3C/g%3E%3C/svg%3E","gcp-cloud-storage":"data:image/svg+xml,%3Csvg id='standard_product_icon' xmlns='http://www.w3.org/2000/svg' version='1.1' viewBox='0 0 512 512'%3E%3Cdefs%3E%3Cstyle%3E .st0 %7B fill: none; %7D .st1 %7B fill: %234285f4; %7D .st2 %7B fill: %2334a853; %7D .st3 %7B fill: %23fbbc04; %7D .st4 %7B fill: %23ea4335; %7D %3C/style%3E%3C/defs%3E%3Cg id='bounding_box'%3E%3Crect class='st0' width='512' height='512'/%3E%3C/g%3E%3Cg id='art'%3E%3Cpath class='st2' d='M442,277.9H70c-8.8,0-16,7.2-16,16v148.1c0,8.8,7.2,16,16,16h107.2c1.5.5,3.1.7,4.8.7s3.3-.3,4.8-.7h255.2c8.8,0,16-7.2,16-16v-148.1c0-8.8-7.2-16-16-16ZM86,309.9h80v116.1h-80v-116.1ZM426,425.9h-228v-116.1h228v116.1Z'/%3E%3Cpath class='st3' d='M442,54H70c-8.8,0-16,7.2-16,16v148.8c0,8.8,7.2,16,16,16h372c8.8,0,16-7.2,16-16V70c0-8.8-7.2-16-16-16ZM86,86h80v116.8h-80v-116.8ZM426,202.8h-228v-116.8h228v116.8Z'/%3E%3Cpath class='st4' d='M442,234.8h-16V86H54v-16c0-8.8,7.2-16,16-16h372c8.8,0,16,7.2,16,16v148.8c0,8.8-7.2,16-16,16Z'/%3E%3Cpath class='st1' d='M442,457.9h-16v-148.1H54v-16c0-8.8,7.2-16,16-16h372c8.8,0,16,7.2,16,16v148.1c0,8.8-7.2,16-16,16Z'/%3E%3Ccircle class='st4' cx='349' cy='144.4' r='37'/%3E%3Ccircle class='st1' cx='349' cy='367.9' r='37'/%3E%3C/g%3E%3C/svg%3E","gcp-cloud-sql":"data:image/svg+xml,%3Csvg id='standard_product_icon' xmlns='http://www.w3.org/2000/svg' version='1.1' viewBox='0 0 512 512'%3E%3Cdefs%3E%3Cstyle%3E .st0 %7B fill: none; %7D .st1 %7B fill: %234285f4; %7D .st2 %7B fill: %2334a853; %7D .st3 %7B fill: %23fbbc04; %7D .st4 %7B fill: %23ea4335; %7D %3C/style%3E%3C/defs%3E%3Cg id='bounding_box'%3E%3Crect class='st0' width='512' height='512'/%3E%3C/g%3E%3Cg id='art'%3E%3Cpath class='st3' d='M447.5,123.7l-186-68.7c-3.6-1.3-7.5-1.3-11.1,0l-40.7,15-145.2,53.5c-6.3,2.3-10.5,8.3-10.5,15s4.2,12.7,10.5,15l145.1,53.4s0,0,0,0l40.8,15c1.8.6,3.7,1,5.5,1s3.7-.3,5.5-1l185.9-68.2c6.3-2.3,10.5-8.3,10.5-15,0-6.7-4.2-12.7-10.5-15h0ZM256,189.9l-139.6-51.4,139.6-51.4,139.7,51.6-139.6,51.2Z'/%3E%3Cpath class='st2' d='M447.5,388.8l-185.9,68.2c-1.8.6-3.6,1-5.5,1s-3.7-.3-5.5-1l-40.8-15h0l-145.1-53.4c-8.3-3-12.5-12.2-9.5-20.5,3-8.3,12.2-12.5,20.5-9.5l180.4,66.4,180.4-66.2c8.3-3,17.5,1.2,20.5,9.5,3,8.3-1.2,17.5-9.5,20.5h0Z'/%3E%3Cpath class='st2' d='M447.5,310.4l-185.9,68.2c-1.8.6-3.6,1-5.5,1s-3.7-.3-5.5-1l-40.8-15h0l-145.1-53.4c-8.3-3-12.5-12.2-9.5-20.5,3-8.3,12.2-12.5,20.5-9.5l180.4,66.4,180.4-66.2c8.3-3,17.5,1.2,20.5,9.5,3,8.3-1.2,17.5-9.5,20.5h0Z'/%3E%3Cpath class='st2' d='M447.5,232.1l-185.9,68.2c-1.8.7-3.6,1-5.5,1s-3.7-.3-5.5-1l-40.8-15h0l-145.1-53.4c-8.3-3.1-12.5-12.2-9.5-20.5,3-8.3,12.2-12.5,20.5-9.5l180.4,66.4,180.4-66.2c8.3-3,17.5,1.2,20.5,9.5,3,8.3-1.2,17.5-9.5,20.5h0Z'/%3E%3Cpath class='st4' d='M458,138.7c0,6.7-4.2,12.7-10.5,15l-186,68.2c-1.8.7-3.6,1-5.5,1s-3.7-.3-5.5-1l-40.8-15h0s46.4-17,46.4-17l139.6-51.2-139.7-51.6-46.2-17.1,40.7-15c3.6-1.3,7.5-1.3,11.1,0l186,68.7c6.3,2.3,10.5,8.3,10.5,15h0Z'/%3E%3Cpath class='st1' d='M447.5,388.8l-185.9,68.2c-1.8.6-3.6,1-5.5,1s-3.7-.3-5.5-1l-40.8-15,46.4-17,180.4-66.2c8.3-3,17.5,1.2,20.5,9.5,3,8.3-1.2,17.5-9.5,20.5h0Z'/%3E%3Cpath class='st1' d='M447.5,310.4l-185.9,68.2c-1.8.6-3.6,1-5.5,1s-3.7-.3-5.5-1l-40.8-15h0l46.4-17,180.4-66.2c8.3-3,17.5,1.2,20.5,9.5,3,8.3-1.2,17.5-9.5,20.5Z'/%3E%3Cpath class='st1' d='M447.5,232.1l-185.9,68.2c-1.8.7-3.6,1-5.5,1s-3.7-.3-5.5-1l-40.8-15h0l46.4-17,180.4-66.2c8.3-3,17.5,1.2,20.5,9.5,3,8.3-1.2,17.5-9.5,20.5h0Z'/%3E%3Cpath class='st3' d='M302.4,206.9l-186-68.5-51.8-15c-6.3,2.3-10.5,8.3-10.5,15s4.2,12.7,10.5,15l145.1,53.4s0,0,0,0l40.8,15c1.8.6,3.7,1,5.5,1s3.7-.3,5.5-1l40.9-15h0Z'/%3E%3C/g%3E%3C/svg%3E"};
  const PROVIDERS = ['aws', 'azure', 'gcp', 'k8s'];
  const R = 8, SIDE_GAP = 24, AREA_PAD = 24, AREA_TOP = 36, TILE = 48;
  const KIND_ROW = 22, SEQ_ROW = 44, SEQ_HEAD = 40, SEQ_GAP = 72, TIME_STEP = 176, MIND_STEP = 64;
  const STATE_START = '[*] start', STATE_END = '[*] end';

  /* ---- the examples: text and the layout file's places (top-left corners) ---- */
  const L = (s) => s.join('\n');
  const EX = [
    {
      id: 'flow', file: 'refund-approval.flow', dir: 'TB',
      text: L([
        'diagram flow "Refund approval"',
        '',
        'Start [start]',
        'Read request [io, table: billing.refunds]',
        'Under 100? [decision]',
        'Finance review [subprocess]',
        'Pay back',
        'Done [end]',
        '',
        'Start > Read request > Under 100?',
        'Under 100? > Pay back : yes',
        'Under 100? > Finance review : no',
        'Finance review > Pay back : approved',
        'Pay back > Done',
      ]),
      at: { Start: [39, 0], 'Read request': [0, 76], 'Under 100?': [17, 160], 'Finance review': [240, 196], 'Pay back': [100, 336], Done: [139, 430] },
    },
    {
      id: 'dfd', file: 'checkout.flow', dir: 'LR',
      text: L([
        'diagram dfd "Checkout"',
        '',
        'Shopper [entity, id: E1]',
        'Payment provider [entity, id: E2]',
        'Shop {',
        '  Take order [process, id: 1.0]',
        '  Charge card [process, id: 2.0]',
        '  Orders [store, id: D1, table: shop.orders]',
        '}',
        '',
        'Shopper > Take order : cart',
        'Take order > Orders : new order',
        'Take order > Charge card : total',
        'Charge card <> Payment provider : charge',
        'Charge card > Orders : paid',
      ]),
      at: { Shopper: [0, 0], 'Take order': [250, 0], Orders: [540, 0], 'Charge card': [246, 150], 'Payment provider': [232, 300] },
    },
    {
      id: 'sequence', file: 'checkout-calls.flow',
      text: L([
        'diagram sequence "Checkout"',
        '',
        'actor Shopper',
        'participant App',
        'participant API',
        'participant Database',
        '',
        'Shopper -> App : Place order',
        'App -> API : POST /orders',
        'activate API',
        'API -> Database : INSERT order',
        'loop each cart line {',
        '  API -> Database : UPDATE stock',
        '}',
        'Database --> API : COMMIT',
        'API --> App : 201 Created',
        'deactivate API',
        'App --> Shopper : Order number',
      ]),
      at: {},
    },
    {
      id: 'state', file: 'invoice-status.flow', dir: 'LR',
      text: L([
        'diagram state "Invoice"',
        '',
        'Draft',
        'Sent',
        'Paid',
        'Void',
        '',
        '[*] > Draft',
        'Draft > Sent : send',
        'Sent > Paid : payment',
        'Draft > Void : cancel',
        'Sent > Void : cancel',
        'Paid > [*]',
        'Void > [*]',
      ]),
      at: { '[*] start': [0, 9], Draft: [60, 0], Sent: [246, 0], Paid: [432, 0], Void: [153, 130], '[*] end': [467, 137] },
    },
    {
      id: 'class', file: 'billing-model.flow', dir: 'LR',
      text: L([
        'diagram class "Billing model"',
        '',
        'interface Payable',
        'Payable : pay(amount)',
        'class Invoice',
        'Invoice : + id: bigint',
        'Invoice : + total: numeric',
        'Invoice : - status: InvoiceStatus',
        'Invoice : + send()',
        'enum InvoiceStatus',
        'InvoiceStatus : DRAFT',
        'InvoiceStatus : SENT',
        'InvoiceStatus : PAID',
        'InvoiceStatus : VOID',
        'class LineItem',
        'LineItem : + qty: int',
        'LineItem : + price: numeric',
        '',
        'Payable <|-- Invoice',
        'Invoice *-- LineItem : lines',
        'Invoice ..> InvoiceStatus : uses',
      ]),
      at: { Payable: [17, 0], Invoice: [0, 160], LineItem: [300, 176], InvoiceStatus: [-250, 157] },
    },
    {
      id: 'mindmap', file: 'release-plan.flow',
      text: L([
        'diagram mindmap "Release 2.4"',
        '',
        'root Release 2.4',
        '  Schema change',
        '    Add paid_at column',
        '    Backfill old invoices',
        '  Testing',
        '    Restore last backup',
        '    Time the slow queries',
        '  Rollout',
        '    Staging first',
        '    Production on Sunday',
        '  Comms',
        '    Release notes',
      ]),
      at: {},
    },
    {
      id: 'timeline', file: 'migration-plan.flow',
      text: L([
        'diagram timeline "Move billing to PostgreSQL"',
        '',
        'section Prepare',
        '2026-09 to 2026-10 : Map types',
        '2026-10-20 : Test a restore',
        'section Move',
        '2026-11 : Copy nightly',
        'milestone Switch writes',
        'section Clean up',
        '2026-12-15 : Turn off MySQL',
      ]),
      at: {},
    },
    {
      id: 'aws', sub: 'AWS', file: 'checkout-aws.flow', dir: 'LR',
      text: L([
        'diagram cloud "Order checkout on AWS"',
        '',
        '// Orders DB is Amazon RDS for PostgreSQL',
        'Shoppers [icon: users]',
        '',
        'AWS [icon: aws-group-cloud] {',
        '  CloudFront [icon: aws-cloudfront]',
        '  eu-west-1 [icon: aws-group-region] {',
        '    API Gateway [icon: aws-api-gateway]',
        '    Sign in [icon: aws-cognito]',
        '    Checkout [icon: aws-lambda]',
        '    Order queue [icon: aws-sqs]',
        '    Fulfilment [icon: aws-lambda]',
        '    Invoices [icon: aws-s3]',
        '    VPC [icon: aws-group-virtual-private-cloud-vpc] {',
        '      Orders DB [icon: aws-rds]',
        '    }',
        '  }',
        '}',
        '',
        'Shoppers > CloudFront: HTTPS',
        'CloudFront > API Gateway',
        'API Gateway ..> Sign in: checks token',
        'API Gateway > Checkout',
        'Checkout > Orders DB: INSERT order',
        'Checkout > Order queue',
        'Order queue > Fulfilment',
        'Fulfilment > Invoices: PUT PDF',
      ]),
      at: { Shoppers: [-80, 0], CloudFront: [150, 0], 'API Gateway': [300, 0], Checkout: [450, 0], 'Order queue': [600, 0], Invoices: [750, 0], 'Sign in': [375, 170], 'Orders DB': [525, 170], Fulfilment: [675, 170] },
    },
    {
      id: 'gcp', sub: 'Google Cloud', file: 'checkout-gcp.flow', dir: 'LR',
      text: L([
        'diagram cloud "Order checkout on Google Cloud"',
        '',
        '// Orders DB is Cloud SQL for PostgreSQL',
        'Shoppers [icon: users]',
        '',
        'shop-prod [icon: gcp-project] {',
        '  Load balancer [icon: gcp-cloud-load-balancing]',
        '  europe-west1 {',
        '    API Gateway [icon: gcp-cloud-api-gateway]',
        '    Sign in [icon: gcp-identity-platform]',
        '    Checkout [icon: gcp-cloud-run]',
        '    Order topic [icon: gcp-pubsub]',
        '    Fulfilment [icon: gcp-cloud-run]',
        '    Invoices [icon: gcp-cloud-storage]',
        '    VPC [icon: gcp-virtual-private-cloud] {',
        '      Orders DB [icon: gcp-cloud-sql]',
        '    }',
        '  }',
        '}',
        '',
        'Shoppers > Load balancer: HTTPS',
        'Load balancer > API Gateway',
        'API Gateway ..> Sign in: checks token',
        'API Gateway > Checkout',
        'Checkout > Orders DB: INSERT order',
        'Checkout > Order topic',
        'Order topic > Fulfilment',
        'Fulfilment > Invoices: PUT PDF',
      ]),
      at: { Shoppers: [-80, 0], 'Load balancer': [150, 0], 'API Gateway': [300, 0], Checkout: [450, 0], 'Order topic': [600, 0], Invoices: [750, 0], 'Sign in': [375, 170], 'Orders DB': [525, 170], Fulfilment: [675, 170] },
    },
  ];
  EX.forEach((x) => {
    x.src = x.text;
    x.base = Object.create(null);
    Object.keys(x.at).forEach((n) => { x.base[n] = { x: x.at[n][0], y: x.at[n][1] }; });
    x.pos = Object.assign(Object.create(null), x.base);
    x.good = null;
    x.lineOf = Object.create(null);
  });
  const exById = (id) => EX.find((x) => x.id === id);
  /* the kind tabs, in the page's order; Cloud architecture holds the AWS and Google Cloud files */
  const TABS = [
    { kind: 'flow', label: 'Flowchart' }, { kind: 'dfd', label: 'Data flow' }, { kind: 'sequence', label: 'Sequence' },
    { kind: 'state', label: 'State' }, { kind: 'class', label: 'Class' },
    { kind: 'mindmap', label: 'Mind map' }, { kind: 'timeline', label: 'Timeline' }, { kind: 'cloud', label: 'Cloud architecture' },
  ];
  /* what the New diagram sheet says each kind is for (NewDiagramSheet.tsx) */
  const ABOUT = {
    dfd: 'Processes, data stores and outside parties. Stores can link to tables.',
    flow: 'Steps, decisions, input and output, start and end.',
    cloud: 'Services as provider icons, grouped by network or layer.',
    sequence: 'Who calls whom, in order: requests, replies and waits.',
    state: 'States and the events that move between them.',
    class: 'Types with their fields and methods, and how they extend each other.',
    mindmap: 'One idea in the middle, branches out from it.',
    timeline: 'Dated events and periods along one line.',
  };

  /* ---- the language (model.ts and problems.ts, the app's messages word for word) ---- */
  const DIAGRAM_KINDS = ['dfd', 'flow', 'cloud', 'sequence', 'state', 'class', 'mindmap', 'timeline'];
  const KINDS = {
    dfd: ['entity', 'process', 'store'], flow: ['start', 'end', 'step', 'decision', 'io', 'subprocess', 'document', 'database'], cloud: ['service'],
    sequence: [], state: ['state', 'choice', 'fork'], class: [], mindmap: [], timeline: [],
  };
  const NOTE_KINDS = ['flow', 'sequence', 'state', 'class', 'mindmap'];
  const ARROWS = {
    dfd: ['>', '<>', '-->', '-'], flow: ['>', '<>', '-->', '-'], cloud: ['>', '<>', '-', '-->', '..>'],
    sequence: ['->', '-->'], state: ['>', '-->'], class: ['<|--', '*--', '..>', '-->', '--', '-'], mindmap: ['>', '-'], timeline: [],
  };
  const ATTR_KEYS = ['id', 'icon', 'color', 'table'];
  const KIND_WORDS = { dfd: 'data flow', flow: 'flowchart', cloud: 'cloud', sequence: 'sequence', state: 'state', class: 'class', mindmap: 'mind map', timeline: 'timeline' };
  const LEADING = { sequence: 'Start the line with participant or actor.', class: 'Start the line with class, interface or enum.', mindmap: 'Indent a topic under its parent instead.', timeline: 'Start the line with a date or milestone.' };
  const either = (w) => (w.length < 2 ? w.join('') : w.slice(0, -1).join(', ') + ' or ' + w[w.length - 1]);
  const M = {
    firstLine: 'The first line must say diagram and a kind, such as diagram dfd, diagram flow or diagram sequence.',
    arrowKind: (a, k, use) => 'A ' + KIND_WORDS[k] + ' diagram does not draw ' + a + '. Use ' + use + '.',
    noLines: 'A timeline has no lines between items: its order comes from the dates.',
    bracketKinds: (k) => ('A ' + KIND_WORDS[k] + ' diagram takes no kind in brackets. ' + (LEADING[k] || '')).trim(),
    badDate: 'Write the date as YYYY-MM-DD, YYYY-MM or YYYY, for example 2026-10-19.',
    timelineLine: 'A timeline line starts with a date, milestone or section, for example 2026-10-19: Release.',
    needsColon: 'Put a colon after the date, then the name, for example 2026-10-19: Release.',
    frameNeedsBrace: 'A frame ends its first line with {, for example loop retry 3 times {.',
    unclosedFrame: (l) => l + ' has no closing }.',
    noClass: (n) => n + ' is not a class. Add class ' + n + ' first.',
    noRoot: 'A mind map starts with its central idea, for example root Q4 plan.',
    dfdNeedsKind: 'A data flow node needs a kind: entity, process or store.',
    decisionLabels: 'A decision needs a label on each way out, for example yes and no.',
    cloudKind: 'A cloud node takes an icon, not a kind, for example [icon: aws-s3].',
    groupAttrs: 'A group takes only an icon, for example [icon: aws-vpc].',
    dotted: 'The dotted line ..> is for cloud diagrams only.',
    openList: 'This list has no closing ].',
    strayClose: 'This } closes no group.',
    needsName: 'Start the line with a name.',
    oneKind: 'Only one kind goes in the brackets.',
    nameQuote: 'This name has no closing quote.',
    titleQuote: 'This title has no closing quote.',
    textQuote: 'This text has no closing quote.',
    notDefined: (n) => n + ' is not defined.',
    definedTwice: (n, a, b) => n + ' is defined twice (lines ' + a + ' and ' + b + ').',
    unknownKind: (w, k, near) => (near ? 'Unknown kind "' + w + '". Did you mean ' + near + '?' : 'Unknown kind "' + w + '". Use ' + either(k ? KINDS[k] : KINDS.dfd.concat(KINDS.flow)) + '.'),
    unknownAttr: (k) => 'Unknown attribute "' + k + '". Use ' + either(ATTR_KEYS) + '.',
    noValue: (k) => k + ' needs a value.',
    noTarget: (a) => 'This link needs a name after ' + a + '.',
    unclosed: (g) => g + ' has no closing }.',
    extra: (t) => 'Can\'t read "' + (t.length > 24 ? t.slice(0, 24) + '...' : t) + '" here.',
  };
  const stale = (line) => 'Showing the last drawing that worked. Fix line ' + line + ' to update it.';

  /** Levenshtein distance; the one closest word, close enough to be a typo (problems.ts nearWord). */
  function dist(a, b) {
    const p = []; for (let j = 0; j <= b.length; j++) p[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let d = p[0]; p[0] = i;
      for (let j = 1; j <= b.length; j++) { const t = p[j]; p[j] = Math.min(p[j] + 1, p[j - 1] + 1, d + (a[i - 1] === b[j - 1] ? 0 : 1)); d = t; }
    }
    return p[b.length];
  }
  function nearWord(word, words) {
    const w = word.toLowerCase(), limit = Math.max(1, Math.floor(w.length / 4));
    let best = null, bd = limit + 1;
    for (const c of words) { const d = dist(w, c.toLowerCase()); if (d === 0) return c === word ? null : c; if (d < bd) { best = c; bd = d; } }
    return best;
  }

  /** Where a `//` comment starts outside quotes, or the line length. */
  function commentAt(s) {
    let q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && q) { i++; continue; }
      if (c === '"') q = !q;
      else if (!q && c === '/' && s[i + 1] === '/') return i;
    }
    return s.length;
  }
  const isWs = (c) => c === ' ' || c === '\t';
  /** Where an unquoted name stops: brackets, braces, : > < quotes, a backslash, --, ->, a lone - or ..> */
  function stops(s, j) {
    const c = s[j];
    if ('[]{}:><"\\'.indexOf(c) >= 0) return true;
    if (c === '-') {
      if (s[j + 1] === '-' || s[j + 1] === '>') return true;
      return (j === 0 || isWs(s[j - 1])) && (j + 1 >= s.length || isWs(s[j + 1]));
    }
    if (c === '.' && s[j + 1] === '.' && s[j + 2] === '>') return true;
    return false;
  }
  function ws(s, p) { while (p < s.length && isWs(s[p])) p++; return p; }
  function quoted(s, p) {
    let v = '';
    for (let j = p + 1; j < s.length; j++) {
      if (s[j] === '\\' && j + 1 < s.length) { j++; v += s[j] === 'n' ? '\n' : s[j]; } else if (s[j] === '"') return { value: v, end: j + 1 }; else v += s[j];
    }
    return null;
  }
  function readArrow(s, q) {
    if (q >= s.length) return null;
    const c = s[q], at = (i) => s[q + i], endsAt = (i) => q + i >= s.length || isWs(s[q + i]);
    if (c === '>') return '>';
    if (c === '<') return at(1) === '>' ? '<>' : (at(1) === '|' && at(2) === '-' && at(3) === '-' ? '<|--' : null);
    if (c === '-') {
      if (at(1) === '-' && at(2) === '>') return '-->';
      if (at(1) === '>') return '->';
      if (at(1) === '-') { if ((at(2) === '*' || at(2) === '1') && endsAt(3)) return null; return endsAt(2) ? '--' : null; }
      return endsAt(1) ? '-' : null;
    }
    if ((c === '1' || c === '*') && at(1) === '-' && at(2) === '-') {
      const far = at(3);
      if ((far === '*' || far === '1') && endsAt(4)) return c + '--' + far;
      if (c === '*' && endsAt(3)) return '*--';
      return null;
    }
    if (c === '.' && at(1) === '.' && at(2) === '>') return '..>';
    return null;
  }

  function parse(src) {
    const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));
    const problems = [];
    const defs = new Map(), byName = new Map();
    const nodes = [], roots = [], stack = [], links = [], tree = [], frames = [], frameStack = [], acts = [], openActs = new Map(), sections = [];
    let kind = null, title = '', header = false, notes = 0, section, mindPath = [], line = 0, s = '';
    const marks = { start: false, end: false };
    const err = (message, ln) => problems.push({ line: ln || line, message, severity: 'error' });
    const hint = (message, ln) => problems.push({ line: ln || line, message, severity: 'hint' });
    const BAD = {};
    function name(p) {
      if (kind === 'state' && s.startsWith('[*]', p)) return { value: '[*]', from: p, to: p + 3 };
      if (s[p] === '"') { const q = quoted(s, p); if (!q) { err(M.nameQuote); return BAD; } return { value: q.value, from: p, to: q.end }; }
      let j = p; while (j < s.length && !stops(s, j)) j++;
      let to = j; while (to > p && isWs(s[to - 1])) to--;
      return to === p ? null : { value: s.slice(p, to), from: p, to };
    }
    /** A class composition writes its * against the name before it: split the * back off. */
    function splitLead(t) {
      const q = ws(s, t.to);
      if (kind !== 'class' || s[q] !== '-' || s[q + 1] !== '-') return { token: t, q };
      if (t.to - t.from < 3 || s[t.to - 1] !== '*' || !isWs(s[t.to - 2])) return { token: t, q };
      let to = t.to - 1; while (to > t.from && isWs(s[to - 1])) to--;
      return { token: { value: s.slice(t.from, to), from: t.from, to }, q: t.to - 1 };
    }
    function end(q) { q = ws(s, q); if (q < s.length) { err(M.extra(s.slice(q).trim())); return false; } return true; }
    function restText(p) {
      const r = ws(s, p);
      if (s[r] === '"') { const q = quoted(s, r); if (!q) { err(M.textQuote); return BAD; } end(q.end); return { value: q.value }; }
      const v = s.slice(r).trim();
      return v ? { value: v } : null;
    }
    function define(t) {
      if (defs.has(t.value)) { err(M.definedTwice(t.value, defs.get(t.value), line)); return false; }
      defs.set(t.value, line); return true;
    }
    function pushNode(n) {
      const g = stack[stack.length - 1];
      if (g) g.nodes.push(n.name);
      n.line = line;
      nodes.push({ node: n, grouped: !!g });
      byName.set(n.name, n);
    }
    function declared(at, k) {
      const t = name(at);
      if (t === BAD) return true;
      if (!t) { err(M.needsName); return true; }
      if (!define(t)) return true;
      const n = { name: t.value, kind: k, attrs: {} };
      if (k === 'root') n.depth = 0;
      if (kind === 'timeline' && section !== undefined) n.section = section;
      pushNode(n);
      end(t.to);
      return true;
    }
    function dated(p) {
      const dateAt = (q) => { let j = q; while (j < s.length && /[0-9-]/.test(s[j])) j++; return j > q ? { value: s.slice(q, j), to: j } : null; };
      const good = (d) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d);
      const first = dateAt(p);
      if (!first) { err(M.timelineLine); return true; }
      if (!good(first.value)) { err(M.badDate); return true; }
      let q = ws(s, first.to), until;
      if (s.startsWith('to', q) && q + 2 < s.length && isWs(s[q + 2])) {
        const second = dateAt(ws(s, q + 2));
        if (!second || !good(second.value)) { err(M.badDate); return true; }
        until = second.value; q = ws(s, second.to);
      }
      if (s[q] !== ':') { err(M.needsColon); return true; }
      const t = name(ws(s, q + 1));
      if (t === BAD) return true;
      if (!t) { err(M.needsName); return true; }
      if (!define(t)) return true;
      const n = { name: t.value, kind: until ? 'period' : 'event', attrs: {}, date: first.value };
      if (until) n.until = until;
      if (section !== undefined) n.section = section;
      pushNode(n);
      end(t.to);
      return true;
    }
    /** The statements a kind starts with a word; false leaves the line to the name statement. */
    function kindStatement(p) {
      const k = kind;
      if (!k) return false;
      const m = /^[A-Za-z]+/.exec(s.slice(p));
      const w = m ? m[0] : null, wto = p + (w ? w.length : 0), after = ws(s, wto), spaced = !!w && wto < s.length && isWs(s[wto]);
      if (w === 'note' && NOTE_KINDS.indexOf(k) >= 0 && s[after] === ':') {
        const t = restText(after + 1);
        if (t === BAD) return true;
        const nm = 'Note ' + (++notes);
        defs.set(nm, line);
        pushNode({ name: nm, kind: 'note', attrs: {}, text: t ? t.value : '' });
        return true;
      }
      if (k === 'sequence' && spaced) {
        if (w === 'participant' || w === 'actor') return declared(after, w);
        if (w === 'activate' || w === 'deactivate') {
          const t = name(after);
          if (t === BAD) return true;
          if (!t) { err(M.needsName); return true; }
          if (w === 'activate') openActs.set(t.value, links.length);
          else if (openActs.has(t.value)) { acts.push({ name: t.value, from: openActs.get(t.value), to: links.length - 1 }); openActs.delete(t.value); }
          end(t.to);
          return true;
        }
        if (['loop', 'alt', 'opt', 'par', 'critical'].indexOf(w) >= 0) {
          const b = s.indexOf('{', after);
          if (b < 0) { err(M.frameNeedsBrace); return true; }
          const label = s.slice(after, b).trim();
          frameStack.push({ label: label ? w + ' ' + label : w, from: links.length, depth: frameStack.length, line });
          end(b + 1);
          return true;
        }
      }
      if (k === 'class' && spaced && (w === 'class' || w === 'interface' || w === 'enum')) return declared(after, w);
      if (k === 'mindmap' && spaced && w === 'root') {
        const before = defs.size;
        declared(after, 'root');
        if (defs.size > before) mindPath = [{ name: [...defs.keys()].pop(), depth: 0 }];
        return true;
      }
      if (k === 'timeline') {
        if (spaced && w === 'section') {
          const t = restText(after);
          if (t && t !== BAD) { section = t.value; sections.push(t.value); } else if (!t) err(M.needsName);
          return true;
        }
        if (spaced && w === 'milestone') return declared(after, 'milestone');
        return dated(p);
      }
      return false;
    }
    function nodeKind(word) {
      const dk = kind;
      if (!word) {
        if (dk === 'dfd') { err(M.dfdNeedsKind); return 'process'; }
        return { cloud: 'service', state: 'state', sequence: 'participant', class: 'class', mindmap: 'topic' }[dk] || 'step';
      }
      if (dk && KINDS[dk].length === 0) { err(M.bracketKinds(dk)); return dk === 'sequence' ? 'participant' : dk === 'class' ? 'class' : dk === 'mindmap' ? 'topic' : 'event'; }
      if (dk === 'cloud') { if (word !== 'service') err(M.cloudKind); return 'service'; }
      const allowed = dk ? KINDS[dk] : KINDS.dfd.concat(KINDS.flow, KINDS.cloud);
      if (allowed.indexOf(word) >= 0) return word;
      err(M.unknownKind(word, dk, nearWord(word, allowed)));
      return dk === 'dfd' ? 'process' : 'step';
    }
    function attrs(q) {
      const close = s.indexOf(']', q);
      if (close < 0) { err(M.openList); return null; }
      const out = { kind: null, attrs: {}, keys: [], to: close + 1 };
      s.slice(q + 1, close).split(',').forEach((part) => {
        const c = part.indexOf(':');
        if (c < 0) {
          const word = part.trim();
          if (!word) return;
          if (out.kind) err(M.oneKind); else out.kind = word;
          return;
        }
        const k = part.slice(0, c).trim(), v = part.slice(c + 1).trim().replace(/^"(.*)"$/, '$1');
        if (ATTR_KEYS.indexOf(k) < 0) { err(M.unknownAttr(k)); return; }
        if (!v) { err(M.noValue(k)); return; }
        out.attrs[k] = v; out.keys.push(k);
      });
      return out;
    }
    function node(t, a) {
      const k = nodeKind(a ? a.kind : null);
      if (!define(t)) return;
      const n = { name: t.value, kind: k, attrs: a ? a.attrs : {} };
      pushNode(n);
      if (kind === 'mindmap') {
        let indent = 0;
        for (let j = 0; j < t.from; j++) indent += s[j] === '\t' ? 2 : 1;
        const depth = Math.max(1, Math.floor(indent / 2));
        n.depth = depth;
        while (mindPath.length && mindPath[mindPath.length - 1].depth >= depth) mindPath.pop();
        const parent = mindPath[mindPath.length - 1];
        if (parent) tree.push({ from: parent.name, to: n.name, arrow: '-', tree: true, line });
        mindPath.push({ name: n.name, depth });
      }
    }
    function openGroup(t, a, brace) {
      if (a && (a.kind || a.keys.some((k) => k !== 'icon'))) err(M.groupAttrs);
      const fresh = define(t);
      const g = { name: t.value, icon: a ? a.attrs.icon : undefined, nodes: [], groups: [], line };
      if (fresh) (stack.length ? stack[stack.length - 1].groups : roots).push(g);
      stack.push(g);
      end(brace + 1);
    }
    function link(first, q, arrow) {
      const names = [first], arrows = [];
      while (arrow) {
        arrows.push(arrow);
        const read = name(ws(s, q + arrow.length));
        if (read === BAD) return;
        if (!read) { err(M.noTarget(arrow)); return; }
        const sp = splitLead(read);
        names.push(sp.token);
        q = sp.q;
        arrow = readArrow(s, q);
      }
      let label;
      if (s[q] === ':') {
        const r = ws(s, q + 1);
        if (s[r] === '"') { const ql = quoted(s, r); if (!ql) { err(M.textQuote); return; } label = ql.value; end(ql.end); }
        else { const v = s.slice(r).trim(); if (v) label = v; }
      } else end(q);
      if (kind === 'timeline') { err(M.noLines); return; }
      arrows.forEach((a, k) => {
        if (a === '..>' && (kind === 'dfd' || kind === 'flow')) err(M.dotted);
        else if (kind && ARROWS[kind].indexOf(a) < 0) err(M.arrowKind(a, kind, ARROWS[kind][0]));
        const from = names[k].value === '[*]' && kind === 'state' ? STATE_START : names[k].value;
        const to = names[k + 1].value === '[*]' && kind === 'state' ? STATE_END : names[k + 1].value;
        if (from === STATE_START) marks.start = true;
        if (to === STATE_END) marks.end = true;
        const l = { from, to, arrow: a, line };
        if (k === arrows.length - 1 && label !== undefined) l.label = label;
        links.push(l);
      });
    }
    function nameStatement(p) {
      const named = name(p);
      if (named === BAD) return;
      if (!named) { err(M.needsName); return; }
      const sp = splitLead(named), first = sp.token, q = sp.q;
      const arrow = readArrow(s, q);
      if (arrow) return link(first, q, arrow);
      const c = s[q];
      // a class member: `Invoice : + send()`
      if (kind === 'class' && c === ':') {
        const t = restText(q + 1);
        if (t === BAD) return;
        const owner = byName.get(first.value);
        if (!owner || ['class', 'interface', 'enum'].indexOf(owner.kind) < 0) { err(M.noClass(first.value)); return; }
        (owner.rows = owner.rows || []).push(t ? t.value : '');
        return;
      }
      if (kind === 'timeline') { err(M.timelineLine); return; }
      if (c === '[') {
        const a = attrs(q);
        if (!a) return;
        const r = ws(s, a.to);
        if (s[r] === '{') return openGroup(first, a, r);
        node(first, a);
        end(a.to);
        return;
      }
      if (c === '{') return openGroup(first, null, q);
      node(first, null);
      end(q);
    }
    for (let i = 0; i < lines.length; i++) {
      line = i + 1;
      s = lines[i].slice(0, commentAt(lines[i])).replace(/\s+$/, '');
      const p = ws(s, 0);
      if (p >= s.length) continue;
      if (!header) {
        header = true;
        const t0 = s.slice(p);
        if (!/^diagram(\s|$)/.test(t0)) { err(M.firstLine); continue; }
        const r = ws(t0, 7);
        let q = r; while (q < t0.length && !isWs(t0[q]) && t0[q] !== '"') q++;
        const word = t0.slice(r, q);
        if (DIAGRAM_KINDS.indexOf(word) >= 0) kind = word; else err(M.firstLine);
        const t = t0.slice(q).trim();
        if (t[0] === '"') { const qt = quoted(t, 0); if (!qt) err(M.titleQuote); else title = qt.value; } else title = t;
        continue;
      }
      if (s[p] === '}') {
        const fr = kind === 'sequence' ? frameStack.pop() : undefined;
        if (fr) frames.push({ label: fr.label, from: fr.from, to: links.length - 1, depth: fr.depth });
        else if (!stack.pop()) err(M.strayClose);
        end(p + 1);
        continue;
      }
      if (kindStatement(p)) continue;
      nameStatement(p);
    }
    if (!header) err(M.firstLine, 1);
    stack.forEach((g) => err(M.unclosed(g.name), g.line));
    frameStack.forEach((fr) => err(M.unclosedFrame(fr.label), fr.line));
    openActs.forEach((from, n) => acts.push({ name: n, from, to: links.length - 1 }));
    // a sequence names its participants by using them
    if (kind === 'sequence') {
      links.forEach((l) => [l.from, l.to].forEach((n) => {
        if (defs.has(n)) return;
        defs.set(n, l.line);
        const nd = { name: n, kind: 'participant', attrs: {}, line: l.line };
        nodes.push({ node: nd, grouped: false });
        byName.set(n, nd);
      }));
    }
    // the page carries only the icons its examples use; the app checks against its whole set
    if (kind === 'cloud') nodes.forEach(({ node: n }) => {
      if (n.attrs.icon && !ICONS[n.attrs.icon]) hint(n.attrs.icon + ' is not one of the ' + Object.keys(ICONS).length + ' icons this page carries; the app has over 4,000.', n.line);
    });
    if (kind === 'mindmap' && nodes.length && !nodes.some((n) => n.node.kind === 'root')) hint(M.noRoot, 1);
    links.forEach((l) => {
      [l.from, l.to].forEach((n) => { if (!defs.has(n) && n !== STATE_START && n !== STATE_END) err(M.notDefined(n), l.line); });
      if (kind === 'flow' && l.label === undefined && byName.has(l.from) && byName.get(l.from).kind === 'decision') hint(M.decisionLabels, l.line);
    });
    problems.sort((a, b) => a.line - b.line);
    const lineOf = Object.create(null);
    defs.forEach((ln, n) => { lineOf[n] = ln; });
    let doc = null;
    if (kind && !problems.some((p) => p.severity === 'error')) {
      const out = nodes.filter((n) => !n.grouped).map((n) => n.node);
      const groups = [];
      const walk = (g, into) => {
        g.nodes.forEach((n) => { if (byName.has(n)) out.push(byName.get(n)); });
        const fg = { name: g.name, icon: g.icon, nodes: g.nodes, groups: [] };
        into.push(fg);
        g.groups.forEach((c) => walk(c, fg.groups));
      };
      roots.forEach((g) => walk(g, groups));
      if (kind === 'state') {
        if (marks.end) out.unshift({ name: STATE_END, kind: 'end', attrs: {}, line: links.find((l) => l.to === STATE_END).line });
        if (marks.start) out.unshift({ name: STATE_START, kind: 'start', attrs: {}, line: links.find((l) => l.from === STATE_START).line });
      }
      doc = { kind, title, nodes: out, links: links.concat(tree), groups, frames, activations: acts, sections };
    }
    return { kind, doc, problems, lineOf, lines };
  }

  /* ---- highlighting, the editor's colours (cm.ts) ---- */
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sp = (cls, t) => (t ? '<span class="ar-' + cls + '">' + esc(t) + '</span>' : '');
  const LEAD = /^(participant|actor|activate|deactivate|loop|alt|opt|par|critical|class|interface|enum|root|section|milestone)(?=\s)|^note(?=\s*:)/;
  function paint(line, first) {
    const c = commentAt(line);
    const code = line.slice(0, c), com = line.slice(c);
    if (first) {
      const m = /^(\s*)(diagram)(\s+)(\S*)(.*)$/.exec(code);
      if (m) return m[1] + sp('k', m[2]) + m[3] + sp('t', m[4]) + sp('s', m[5]) + sp('c', com);
    }
    let out = '', i = 0, br = false, val = false;
    const lead = /^\s*/.exec(code)[0];
    out += lead; i = lead.length;
    const rest = code.slice(i);
    const lw = LEAD.exec(rest);
    if (lw) { out += sp('k', lw[0]); i += lw[0].length; }
    else {
      const d = /^\d{4}(-\d{2}){0,2}(?=[\s:])/.exec(rest);
      if (d) {
        out += sp('a', d[0]); i += d[0].length;
        const t = /^(\s+)(to)(\s+)(\d{4}(-\d{2}){0,2})/.exec(code.slice(i));
        if (t) { out += t[1] + sp('k', t[2]) + t[3] + sp('a', t[4]); i += t[0].length; }
      }
    }
    while (i < code.length) {
      const ch = code[i];
      if (br) {
        if (ch === ']' || ch === ',') { out += sp('p', ch); val = false; if (ch === ']') br = false; i++; continue; }
        if (ch === ':') { out += sp('p', ch); val = true; i++; continue; }
        let j = i; while (j < code.length && ',]'.indexOf(code[j]) < 0 && (val || code[j] !== ':')) j++;
        const t = code.slice(i, j);
        out += val ? sp('s', t) : (code[j] === ':' ? sp('f', t) : sp('t', t));
        i = j; continue;
      }
      if (code.startsWith('[*]', i)) { out += sp('a', '[*]'); i += 3; continue; }
      if (ch === '[') { br = true; val = false; out += sp('p', ch); i++; continue; }
      if (ch === '{' || ch === '}') { out += sp('p', ch); i++; continue; }
      if (ch === ':') { out += sp('p', ch) + sp('s', code.slice(i + 1)); i = code.length; continue; }
      const m = /^(<\|--|[1*]--[1*](?=\s|$)|\*--(?=\s|$)|-->|--(?=\s|$)|->|\.\.>|<>|>)/.exec(code.slice(i));
      if (m && (i === 0 || isWs(code[i - 1]) || '>-<.'.indexOf(ch) >= 0)) { out += sp('a', m[0]); i += m[0].length; continue; }
      if (ch === '-' && stops(code, i)) { out += sp('a', ch); i++; continue; }
      if (ch === '"') { let j = i + 1; while (j < code.length && code[j] !== '"') j++; out += esc(code.slice(i, j + 1)); i = j + 1; continue; }
      let j = i + 1; while (j < code.length && !stops(code, j) && !(isWs(code[j - 1]) && /^[1*]--/.test(code.slice(j)))) j++;
      out += esc(code.slice(i, j)); i = j;
    }
    return out + sp('c', com);
  }

  /* ---- sizes (flowNodes.tsx nodeSize, kindLayout.ts kindSize) ---- */
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const tw = (t) => t.length * 7, cw7 = (t) => t.length * 7.2;
  const isMethod = (r) => r.indexOf('(') >= 0;
  function drawn(n, dk) {
    if (dk === 'state' && n.name === STATE_START) return 'stateStart';
    if (dk === 'state' && n.name === STATE_END) return 'stateEnd';
    if (n.kind === 'entity') return 'external';
    return n.kind;
  }
  function size(k, n) {
    const rows = n.rows || [];
    switch (k) {
      case 'document': case 'database': return { w: 150, h: 52 };
      case 'class': case 'interface': case 'enum': {
        const st = k === 'class' ? 0 : 14;
        const fields = rows.filter((r) => k === 'enum' || !isMethod(r)).length, methods = k === 'enum' ? 0 : rows.filter(isMethod).length;
        const parts = k === 'enum' ? Math.max(fields, 1) * KIND_ROW + 8 : Math.max(fields, 0.5) * KIND_ROW + Math.max(methods, 0.5) * KIND_ROW + 16;
        return { w: clamp(Math.max(tw(n.name) + 40, ...rows.map((r) => cw7(r) + 28)), 160, 340), h: 32 + st + parts };
      }
      case 'state': return { w: clamp(tw(n.name) + 40, 96, 280), h: 40 };
      case 'choice': return { w: 64, h: 64 };
      case 'fork': return { w: 112, h: 10 };
      case 'stateStart': return { w: 22, h: 22 };
      case 'stateEnd': return { w: 26, h: 26 };
      case 'participant': case 'actor': return { w: clamp(tw(n.name) + 40, 120, 260), h: SEQ_HEAD };
      case 'root': return { w: clamp(tw(n.name) + 48, 120, 300), h: 44 };
      case 'topic': return (n.depth || 1) <= 1 ? { w: clamp(tw(n.name) + 32, 80, 260), h: 34 } : { w: clamp(tw(n.name) + 20, 60, 240), h: 28 };
      case 'event': case 'period': case 'milestone': return { w: 152, h: 52 };
      case 'note': return { w: 200, h: 20 + Math.max(1, Math.ceil((n.text || '').length / 26)) * 18 };
      case 'process': case 'store': case 'external': return { w: clamp(tw(n.name) + 70 + (n.attrs.id ? n.attrs.id.length * 7 + 16 : 0), 168, 320), h: 52 };
      case 'start': case 'end': return { w: clamp(tw(n.name) + 36, 72, 280), h: 36 };
      case 'decision': return { w: 116, h: 116 };
      case 'service': return { w: 104, h: 72 };
      default: return { w: 150, h: 44 };
    }
  }
  /* the token pair each shape is drawn in (diagram/types.ts NODE_TOKENS) */
  const PAIR = {
    process: 'service', store: 'store', external: 'ext', start: 'ext', end: 'ext', step: 'table', io: 'table', subprocess: 'table', decision: 'enum',
    service: 'service', document: 'table', database: 'store', participant: 'table', actor: 'ext', state: 'table',
    choice: 'enum', fork: 'mark', stateStart: 'mark', stateEnd: 'mark', class: 'table', interface: 'view', enum: 'enum', root: 'view', topic: 'table',
    event: 'table', period: 'store', milestone: 'enum', note: 'note',
  };
  const FAMILY = { start: 'fc', end: 'fc', step: 'fc', io: 'fc', subprocess: 'fc', decision: 'fc', document: 'fc', database: 'fc', process: 'dfd', store: 'dfd', external: 'dfd', service: 'service' };

  /* ---- fixed layouts (kindLayout.ts) ---- */
  function seqLayout(doc, sz) {
    const pos = Object.create(null), sizes = new Map(), centre = new Map();
    const lifeline = SEQ_HEAD + (doc.links.length + 1) * SEQ_ROW;
    let x = 0;
    doc.nodes.forEach((n) => {
      if (n.kind === 'note') return;
      const s = sz(n);
      pos[n.name] = { x, y: 0 }; sizes.set(n.name, { w: s.w, h: lifeline }); centre.set(n.name, x + s.w / 2);
      x += s.w + SEQ_GAP;
    });
    let ny = SEQ_HEAD;
    doc.nodes.forEach((n) => { if (n.kind !== 'note') return; const s = sz(n); pos[n.name] = { x, y: ny }; sizes.set(n.name, s); ny += s.h + 16; });
    const frames = doc.frames.map((fr) => {
      const msgs = fr.to >= fr.from ? doc.links.slice(fr.from, fr.to + 1) : [];
      const xs = [];
      msgs.forEach((l) => [l.from, l.to].forEach((n) => { if (centre.has(n)) xs.push(centre.get(n)); }));
      const lo = xs.length ? Math.min(...xs) - 60 : 0, hi = xs.length ? Math.max(...xs) + 60 : 120, inset = fr.depth * 8;
      const top = SEQ_HEAD + fr.from * SEQ_ROW + 4 + inset, rows = Math.max(1, fr.to - fr.from + 1);
      return { label: fr.label, box: { x: lo + inset, y: top, w: hi - lo - inset * 2, h: rows * SEQ_ROW + 20 - inset * 2 } };
    });
    return { pos, sizes, frames };
  }
  function mindLayout(doc, sz) {
    const pos = Object.create(null), sizes = new Map(), kids = new Map();
    doc.links.forEach((l) => { if (!l.tree) return; if (!kids.has(l.from)) kids.set(l.from, []); kids.get(l.from).push(l.to); });
    doc.nodes.forEach((n) => sizes.set(n.name, sz(n)));
    const height = (nm) => { const k = kids.get(nm) || [], own = (sizes.has(nm) ? sizes.get(nm).h : 30) + 14; return k.length ? Math.max(own, k.reduce((t, c) => t + height(c), 0)) : own; };
    const placeKid = (nm, x, top, side) => {
      const s = sizes.get(nm), h = height(nm);
      pos[nm] = { x: side === 1 ? x : x - s.w, y: top + h / 2 - s.h / 2 };
      let y = top;
      const next = side === 1 ? x + s.w + MIND_STEP : x - s.w - MIND_STEP;
      (kids.get(nm) || []).forEach((k) => { placeKid(k, next, y, side); y += height(k); });
    };
    let rootTop = 0;
    doc.nodes.filter((n) => n.kind === 'root').forEach((r) => {
      const s = sizes.get(r.name), k = kids.get(r.name) || [];
      const right = k.filter((_, i) => i % 2 === 0), left = k.filter((_, i) => i % 2 === 1);
      const hr = right.reduce((t, c) => t + height(c), 0), hl = left.reduce((t, c) => t + height(c), 0), total = Math.max(hr, hl, s.h);
      pos[r.name] = { x: -s.w / 2, y: rootTop + total / 2 - s.h / 2 };
      let y = rootTop + (total - hr) / 2;
      right.forEach((c) => { placeKid(c, s.w / 2 + MIND_STEP, y, 1); y += height(c); });
      y = rootTop + (total - hl) / 2;
      left.forEach((c) => { placeKid(c, -s.w / 2 - MIND_STEP, y, -1); y += height(c); });
      rootTop += total + 80;
    });
    let loose = rootTop;
    doc.nodes.forEach((n) => { if (pos[n.name]) return; pos[n.name] = { x: 0, y: loose }; loose += sizes.get(n.name).h + 16; });
    return { pos, sizes };
  }
  function timeLayout(doc, sz) {
    const pos = Object.create(null), sizes = new Map(), ticks = new Map(), AXIS_Y = 120;
    const items = doc.nodes.filter((n) => n.kind !== 'note');
    items.forEach((n, i) => {
      const s = sz(n), x = i * TIME_STEP, above = i % 2 === 0;
      pos[n.name] = { x, y: above ? AXIS_Y - 36 - s.h : AXIS_Y + 36 };
      sizes.set(n.name, s); ticks.set(n.name, { x: x + s.w / 2, milestone: n.kind === 'milestone' });
    });
    const width = Math.max(items.length - 1, 0) * TIME_STEP + 152;
    const axis = { x: -24, y: AXIS_Y - 1, w: width + 48, h: 2 };
    const sections = [];
    doc.sections.forEach((name) => {
      const xs = []; items.forEach((n, i) => { if (n.section === name) xs.push(i * TIME_STEP); });
      if (!xs.length) return;
      const lo = Math.min(...xs) - 12, hi = Math.max(...xs) + 152 + 12;
      sections.push({ name, box: { x: lo, y: AXIS_Y - 140, w: hi - lo, h: 280 } });
    });
    let ny = AXIS_Y + 140;
    doc.nodes.forEach((n) => { if (n.kind !== 'note') return; const s = sz(n); pos[n.name] = { x: 0, y: ny }; sizes.set(n.name, s); ny += s.h + 16; });
    return { pos, sizes, axis, sections, ticks };
  }
  const FIXED = { sequence: seqLayout, mindmap: mindLayout, timeline: timeLayout };

  /* ---- routing (diagram/route.ts) ---- */
  const f = (n) => String(Math.round(n * 100) / 100 + 0);
  function simplify(points) {
    const out = [];
    for (const q of points) {
      const last = out[out.length - 1];
      const p = last ? { x: Math.abs(q.x - last.x) <= 0.5 ? last.x : q.x, y: Math.abs(q.y - last.y) <= 0.5 ? last.y : q.y } : q;
      if (last && p.x === last.x && p.y === last.y) continue;
      const prev = out[out.length - 2];
      if (prev && last && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) out.pop();
      out.push(p);
    }
    return out;
  }
  function rounded(points, r) {
    const p = simplify(points);
    let d = 'M ' + f(p[0].x) + ' ' + f(p[0].y);
    for (let i = 1; i < p.length - 1; i++) {
      const a = p[i - 1], b = p[i], c = p[i + 1];
      const r1 = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
      const u = { x: Math.sign(a.x - b.x), y: Math.sign(a.y - b.y) }, v = { x: Math.sign(c.x - b.x), y: Math.sign(c.y - b.y) };
      d += ' L ' + f(b.x + u.x * r1) + ' ' + f(b.y + u.y * r1) + ' Q ' + f(b.x) + ' ' + f(b.y) + ' ' + f(b.x + v.x * r1) + ' ' + f(b.y + v.y * r1);
    }
    const z = p[p.length - 1];
    return p.length > 1 ? d + ' L ' + f(z.x) + ' ' + f(z.y) : d;
  }
  const hvh = (s, e) => { const mx = (s.x + e.x) / 2; return [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e]; };
  const vhv = (s, e) => { const my = (s.y + e.y) / 2; return [s, { x: s.x, y: my }, { x: e.x, y: my }, e]; };
  function route(a, b) {
    const acy = a.y + a.h / 2, acx = a.x + a.w / 2;
    let pts;
    if (b.x >= a.x + a.w + SIDE_GAP) pts = hvh({ x: a.x + a.w, y: acy }, { x: b.x, y: b.y + b.h / 2 });
    else if (b.x + b.w <= a.x - SIDE_GAP) pts = hvh({ x: a.x, y: acy }, { x: b.x + b.w, y: b.y + b.h / 2 });
    else if (b.y >= a.y) pts = vhv({ x: acx, y: a.y + a.h }, { x: b.x + b.w / 2, y: b.y });
    else pts = vhv({ x: acx, y: a.y }, { x: b.x + b.w / 2, y: b.y + b.h });
    return { d: rounded(pts, R), mid: { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 } };
  }
  /** Each group's area round its placed members and inner groups, outermost first. */
  function areas(groups, box) {
    const out = [];
    function walk(g, depth) {
      const inner = g.groups.map((c) => walk(c, depth + 1)).filter(Boolean);
      const boxes = g.nodes.map((n) => box[n]).filter(Boolean).concat(inner);
      if (!boxes.length) return null;
      const x0 = Math.min(...boxes.map((b) => b.x)) - AREA_PAD, y0 = Math.min(...boxes.map((b) => b.y)) - AREA_TOP;
      const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + AREA_PAD, y1 = Math.max(...boxes.map((b) => b.y + b.h)) + AREA_PAD;
      const b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      out.push({ g, box: b, depth });
      return b;
    }
    groups.forEach((g) => walk(g, 0));
    return out.sort((a, b) => a.depth - b.depth);
  }
  /** A node without a place goes after what links to it (right, or below in a top-down chart), else under the drawing. */
  function place(X, doc, sz) {
    const named = new Map(doc.nodes.map((n) => [n.name, n]));
    const boxOf = (n) => { const p = X.pos[n], s = sz(named.get(n)); return { x: p.x, y: p.y, w: s.w, h: s.h }; };
    const placed = () => Object.keys(X.pos).filter((n) => named.has(n)).map(boxOf);
    const free = (b) => placed().every((o) => b.x + b.w + 40 <= o.x || o.x + o.w + 40 <= b.x || b.y + b.h + 40 <= o.y || o.y + o.h + 40 <= b.y);
    const tb = X.dir === 'TB';
    doc.nodes.forEach((n) => {
      if (X.pos[n.name]) return;
      const s = sz(n);
      const l = doc.links.find((k) => k.to === n.name && X.pos[k.from] && named.has(k.from)) || doc.links.find((k) => k.from === n.name && X.pos[k.to] && named.has(k.to));
      let b;
      if (l) {
        const o = boxOf(l.to === n.name ? l.from : l.to), fwd = l.to === n.name;
        b = tb ? { x: o.x + (o.w - s.w) / 2, y: fwd ? o.y + o.h + 60 : o.y - s.h - 60, w: s.w, h: s.h } : { x: fwd ? o.x + o.w + 80 : o.x - s.w - 80, y: o.y + (o.h - s.h) / 2, w: s.w, h: s.h };
        for (let k = 0; k < 12 && !free(b); k++) { if (tb) b.x += s.w + 40; else b.y += Math.max(s.h, 60) + 40; }
      } else {
        const all = placed();
        b = { x: all.length ? Math.min(...all.map((o) => o.x)) : 0, y: all.length ? Math.max(...all.map((o) => o.y + o.h)) + 60 : 0, w: s.w, h: s.h };
        for (let k = 0; k < 20 && !free(b); k++) b.x += s.w + 40;
      }
      X.pos[n.name] = { x: b.x, y: b.y };
    });
  }

  /* ---- the canvas: HTML shapes with the app's classes, lines in one SVG ---- */
  const NS = 'http://www.w3.org/2000/svg';
  let ctx = null;
  function textW(t) {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '400 12px ' + getComputedStyle(host).getPropertyValue('--a-ui');
    return ctx.measureText(t).width;
  }
  /* Lucide (ISC) paths, as the app's Icon component draws them */
  const IC = {
    gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0z',
    database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0z',
    link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M11.5 17.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM13.3 16.3 15 18',
    cube: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16ZM3.3 7l8.7 5 8.7-5M12 22V12',
  };
  const icon = (n, s, cls) => '<svg class="gi' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true"><path d="' + IC[n] + '"/></svg>';
  const nm = (t) => '<span class="nm">' + esc(t) + '</span>';
  const WORDS = { process: 'Process', store: 'Data store', external: 'Outside party' };
  /** The inside of each shape (DfdNode, FlowchartNode, ServiceNode and kindNodes.tsx KindInside). */
  function inside(k, n, acts) {
    const rows = n.rows || [];
    const list = (l) => '<ul class="kr">' + l.map((r) => '<li><span class="kc">' + esc(r) + '</span></li>').join('') + '</ul>';
    const id = n.attrs.id ? '<span class="id">' + esc(n.attrs.id) + '</span>' : '';
    switch (k) {
      case 'process': case 'store': case 'external':
        return '<span class="tile">' + icon(k === 'process' ? 'gear' : k === 'store' ? 'database' : 'user', 16) + '</span><span class="tx">' + nm(n.name) +
          '<span class="sub">' + (n.attrs.table ? icon('link', 14) + esc(n.attrs.table) : WORDS[k]) + '</span></span>' + id;
      case 'service': {
        const url = n.attrs.icon && ICONS[n.attrs.icon], prov = n.attrs.icon && PROVIDERS.indexOf(n.attrs.icon.split('-')[0]) >= 0;
        const tile = n.attrs.icon && !url ? '<span class="tile unknown">' + icon('cube', 20) + '</span>' : '<span class="tile' + (url && prov ? ' bare' : '') + '">' + (url ? '<img alt="" src="' + url + '">' : '') + '</span>';
        return tile + nm(n.name);
      }
      case 'document': case 'database': return '<span class="tx">' + icon(k === 'database' ? 'database' : 'file', 14) + nm(n.name) + '</span>';
      case 'class': case 'interface': case 'enum':
        return '<span class="kh kh-class">' + (k !== 'class' ? '<span class="st">\u00ab' + k + '\u00bb</span>' : '') + nm(n.name) + '</span>' +
          (k === 'enum' ? list(rows) : list(rows.filter((r) => !isMethod(r))) + list(rows.filter(isMethod)));
      case 'participant': case 'actor':
        return '<span class="kh life">' + (k === 'actor' ? icon('user', 14) : '') + nm(n.name) + '</span><i class="lifeline"></i>' +
          (acts || []).map((a) => '<i class="act" style="top:' + (SEQ_HEAD + a.from * SEQ_ROW + 6) + 'px;height:' + (Math.max(1, a.to - a.from + 1) * SEQ_ROW - 12) + 'px"></i>').join('');
      case 'stateStart': case 'stateEnd': case 'fork': return '';
      case 'choice': return '<span class="nm cn">' + esc(n.name) + '</span>';
      case 'event': case 'period': case 'milestone':
        return '<span class="time"><span class="date">' + esc(k === 'milestone' ? 'Milestone' : n.until ? n.date + ' to ' + n.until : n.date) + '</span>' + nm(n.name) + '</span>';
      case 'note': return '<span class="note">' + esc(n.text || '') + '</span>';
      case 'root': case 'topic': case 'state': return nm(n.name);
      default: return '<span class="tx">' + (k === 'io' && n.attrs.table ? icon('link', 14, 'lk') : '') + nm(n.name) + id + '</span>';
    }
  }
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  /* the line ends (diagram/edges.tsx EdgeMarkers) */
  const MARKERS = [
    ['arrow', '0 0 6 6', 6, 3, 6, 6, 'M0 0L6 3L0 6Z', 'mf'],
    ['tri', '0 0 12 12', 12, 6, 12, 12, 'M1 1L12 6L1 11Z', 'ms mh'],
    ['dia', '0 0 14 10', 14, 5, 14, 10, 'M0 5L7 0L14 5L7 10Z', 'mf'],
    ['open', '0 0 10 10', 10, 5, 10, 10, 'M1 1L10 5L1 9', 'ms'],
  ];
  /** The marker at each end of a line, by its arrow (flowNodes.tsx markers). */
  function ends(a, dk) {
    switch (a) {
      case '-': case '..>': return dk === 'class' && a === '..>' ? { end: 'open' } : {};
      case '<>': return { start: 'arrow', end: 'arrow' };
      case '--': return {};
      case '<|--': return { start: 'tri' };
      case '*--': return { start: 'dia' };
      case '-->': return dk === 'sequence' ? { end: 'open' } : { end: 'arrow' };
      default: return { end: 'arrow' };
    }
  }

  function draw(X, doc, fresh) {
    const dk = doc.kind;
    const sz = (n) => size(drawn(n, dk), n);
    const fixed = FIXED[dk] ? FIXED[dk](doc, sz) : null;
    if (!fixed) place(X, doc, sz);
    const pos = fixed ? fixed.pos : X.pos;
    const box = Object.create(null), lbox = Object.create(null);
    doc.nodes.forEach((n) => {
      const p = pos[n.name]; if (!p) return;
      const s = fixed && fixed.sizes.has(n.name) ? fixed.sizes.get(n.name) : sz(n);
      box[n.name] = { x: p.x, y: p.y, w: s.w, h: s.h };
      lbox[n.name] = drawn(n, dk) === 'service' ? { x: p.x + (s.w - TILE) / 2, y: p.y, w: TILE, h: TILE } : box[n.name];
    });
    const ext = [];
    let back = '', front = '', chips = '';
    const at = (b) => 'left:' + f(b.x) + 'px;top:' + f(b.y) + 'px;width:' + f(b.w) + 'px;height:' + f(b.h) + 'px';
    // group areas, sequence frames, timeline sections and its line, behind everything
    if (!fixed) areas(doc.groups, box).forEach(({ g, box: b, depth }) => {
      const ic = g.icon && ICONS[g.icon] ? '<img alt="" src="' + ICONS[g.icon] + '">' : '<i class="sw"></i>';
      back += '<div class="ga' + (depth ? ' inner' : '') + '" style="' + at(b) + '"><span class="gname">' + ic + esc(g.name) + '</span></div>';
      ext.push(b);
    });
    if (fixed && fixed.frames) fixed.frames.forEach((fr) => {
      // the frame behind the lines; its label tab in front, so an activation bar never covers the words
      back += '<div class="gf" style="' + at(fr.box) + '"></div>';
      chips += '<span class="gft" style="left:' + f(fr.box.x) + 'px;top:' + f(fr.box.y) + 'px">' + esc(fr.label) + '</span>';
      ext.push(fr.box);
    });
    if (fixed && fixed.sections) fixed.sections.forEach((se) => { back += '<div class="gs" style="' + at(se.box) + '"><span class="gsn">' + esc(se.name) + '</span></div>'; ext.push(se.box); });
    if (fixed && fixed.axis) {
      const a = fixed.axis;
      back += '<div class="gx" style="' + at({ x: a.x, y: a.y - 6, w: a.w, h: 14 }) + '">' + doc.nodes.filter((n) => fixed.ticks.has(n.name)).map((n) => {
        const t = fixed.ticks.get(n.name);
        return '<i class="tick' + (t.milestone ? ' ms' : '') + '" style="left:' + f(t.x - a.x) + 'px"></i>';
      }).join('') + '</div>';
      ext.push(a);
    }
    // lines
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ar-svg');
    svg.setAttribute('aria-hidden', 'true');
    const defs = el('defs', {}, svg);
    MARKERS.forEach(([mid, vb, rx, ry, mw, mh, d, cls]) => {
      const mk = el('marker', { id: 'gm-' + mid, viewBox: vb, refX: rx, refY: ry, markerWidth: mw, markerHeight: mh, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, defs);
      el('path', { class: cls, d }, mk);
    });
    const ll = el('g', {}, svg);
    const lab = (x, y, t, line, cls) => {
      const w = textW(t) + (cls === 'msg' ? 8 : 14);
      chips += '<span class="gc' + (cls ? ' ' + cls : '') + '" data-line="' + line + '" style="left:' + f(x) + 'px;top:' + f(y) + 'px">' + esc(t) + '</span>';
      ext.push(cls === 'msg' ? { x: x - w / 2, y: y - 18, w, h: 18 } : { x: x - w / 2, y: y - 10, w, h: 20 });
    };
    doc.links.forEach((l, i) => {
      const a = lbox[l.from], b = lbox[l.to];
      if (!a || !b) return;
      const m = ends(l.arrow, dk);
      const attrs = { class: l.arrow === '-->' ? 'gl dashed' : l.arrow === '..>' ? 'gl dotted' : 'gl', 'data-line': l.line };
      if (m.start) attrs['marker-start'] = 'url(#gm-' + m.start + ')';
      if (m.end) attrs['marker-end'] = 'url(#gm-' + m.end + ')';
      if (dk === 'sequence') {
        // a message runs straight along its row; a message to itself loops out right
        const x1 = a.x + a.w / 2, x2 = b.x + b.w / 2, y = a.y + SEQ_HEAD + (i + 0.5) * SEQ_ROW, self = l.from === l.to;
        attrs.d = self ? 'M ' + f(x1) + ' ' + f(y - 8) + ' H ' + f(x1 + 40) + ' V ' + f(y + 8) + ' H ' + f(x1) : 'M ' + f(x1) + ' ' + f(y) + ' H ' + f(x2);
        el('path', attrs, ll);
        if (l.label) lab(self ? x1 + 52 + textW(l.label) / 2 : (x1 + x2) / 2, self ? y - 8 : y - 10, l.label, l.line, 'msg');
        return;
      }
      if (l.tree) {
        // a mind map branch: a curve from the side of the parent that faces the child, no arrow
        const right = b.x + b.w / 2 >= a.x + a.w / 2;
        const x1 = right ? a.x + a.w : a.x, x2 = right ? b.x : b.x + b.w, y1 = a.y + a.h / 2, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
        el('path', { class: 'gl', 'data-line': l.line, d: 'M ' + f(x1) + ' ' + f(y1) + ' C ' + f(mx) + ' ' + f(y1) + ', ' + f(mx) + ' ' + f(y2) + ', ' + f(x2) + ' ' + f(y2) }, ll);
        return;
      }
      const r = route(a, b);
      attrs.d = r.d;
      el('path', attrs, ll);
      if (l.label) lab(r.mid.x, r.mid.y, l.label, l.line, '');
    });
    // shapes
    doc.nodes.forEach((n) => {
      const b = box[n.name]; if (!b) return;
      const k = drawn(n, dk);
      const depth = k === 'topic' ? ' d' + Math.min(n.depth || 1, 3) : '';
      const acts = (k === 'participant' || k === 'actor') ? doc.activations.filter((a) => a.name === n.name) : null;
      front += '<div class="gn f-' + (FAMILY[k] || 'k') + ' gn-' + k + ' p-' + PAIR[k] + depth + (fresh.has(n.name) ? ' ar-new' : '') + '" data-n="' + esc(n.name) + '" data-line="' + n.line + '" style="' + at(b) + '">' + inside(k, n, acts) + '</div>';
      ext.push(k === 'choice' ? { x: b.x - 40, y: b.y, w: b.w + 80, h: b.h + 34 } : b);
    });
    ui.inner.innerHTML = back;
    ui.inner.appendChild(svg);
    ui.inner.insertAdjacentHTML('beforeend', front + chips);
    const pad = 20;
    const x0 = Math.min(...ext.map((e) => e.x)) - pad, y0 = Math.min(...ext.map((e) => e.y)) - pad;
    const x1 = Math.max(...ext.map((e) => e.x + e.w)) + pad, y1 = Math.max(...ext.map((e) => e.y + e.h)) + pad;
    X.view = ext.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 100, h: 100 };
    // the SVG spans the drawing in the drawing's own coordinates
    svg.setAttribute('viewBox', f(X.view.x) + ' ' + f(X.view.y) + ' ' + f(X.view.w) + ' ' + f(X.view.h));
    svg.setAttribute('width', f(X.view.w)); svg.setAttribute('height', f(X.view.h));
    svg.style.left = f(X.view.x) + 'px'; svg.style.top = f(X.view.y) + 'px';
    fit();
  }
  /** Fit the drawing to the canvas, never above 100 percent; on a narrow canvas keep it readable and let it scroll. */
  function fit() {
    const X = cur, v = X.view;
    if (!v) return;
    const cw = ui.cv.clientWidth, ch = ui.cv.clientHeight;
    let s, ox, oy;
    if (!wide()) {
      s = Math.max(Math.min((cw - 2) / v.w, 1), 0.55);
      ui.world.style.width = Math.round(v.w * s) + 'px';
      ui.world.style.height = Math.round(v.h * s) + 'px';
      ui.world.style.margin = v.w * s < cw ? '0 auto' : '0';
      ox = -v.x; oy = -v.y;
    } else {
      s = Math.min(cw / v.w, ch / v.h, 1);
      ui.world.style.width = cw + 'px'; ui.world.style.height = ch + 'px'; ui.world.style.margin = '0';
      ox = (cw / s - v.w) / 2 - v.x; oy = (ch / s - v.h) / 2 - v.y;
    }
    X.scale = s;
    ui.inner.style.transform = 'scale(' + s + ') translate(' + f(ox) + 'px, ' + f(oy) + 'px)';
  }
  const wide = () => host.clientWidth >= 720;

  /* ---- the window ---- */
  const tabId = (i) => 'ar-tab-' + TABS[i].kind;
  /* the left pane: Editor and Assistant on one sliding switch (board 11.5, .pswitch) */
  const SV = (d, s, cls) => '<svg class="ai-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" width="' + (s || 16) + '" height="' + (s || 16) + '" aria-hidden="true">' + d + '</svg>';
  const IA = {
    code: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
    ask: '<path d="M4.5 4.1h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9l-3.75 3v-3H4.5A1.5 1.5 0 0 1 3 14.6v-9a1.5 1.5 0 0 1 1.5-1.5z"/><path class="h" d="M9 7.9c0-.75 1.35-1.3 3-1.3s3 .55 3 1.3v4.9c0 .75-1.35 1.3-3 1.3s-3-.55-3-1.3z"/>',
    lock: '<path d="M7 11V8a5 5 0 0 1 10 0v3"/><path d="M5.5 11h13v9h-13z"/>',
    send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  const SIDE_HEAD =
    '<div class="ar-side">' +
    '<div class="ar-sw" role="tablist" aria-label="Left pane"><span class="ar-thumb" aria-hidden="true"></span>' +
    '<button type="button" role="tab" class="ar-pt on" id="ar-pt-ed" aria-controls="ar-pane-ed" aria-selected="true" data-ar-pane="editor">' + SV(IA.code) + '<span>Editor</span>' + SV(IA.lock, 13, 'ar-lk') + '</button>' +
    '<button type="button" role="tab" class="ar-pt" id="ar-pt-as" aria-controls="ar-pane-as" aria-selected="false" tabindex="-1" data-ar-pane="assistant">' + SV(IA.ask, 16, 'ask') + '<span>Assistant</span><span class="ai-mark">AI</span><span class="ar-pc" hidden></span><span class="ar-pdot" hidden></span></button></div>' +
    '<div class="ar-ebar" hidden></div>';
  const SIDE_ASSIST =
    '<div class="ar-as" id="ar-pane-as" role="tabpanel" aria-labelledby="ar-pt-as" hidden>' +
    '<p class="ar-pre"><b>Pre-written for this demo.</b> These answers are recorded, so they work without a provider. In the app your own provider writes them, and you still review each change.</p>' + '<div class="ar-chat" role="log" aria-label="Assistant conversation"></div>' +
    '<div class="ar-comp">' +
    '<div class="ar-cwork" hidden><span data-ai-working></span><button type="button" class="ai-b" data-ai-act="stop">Stop<span class="ar-kh">Esc</span></button></div>' +
    '<div class="ar-cform"><div class="ar-seg" role="radiogroup" aria-label="How changes land">' +
    '<button type="button" role="radio" aria-checked="true" data-ai-mode="review">Review first</button><button type="button" role="radio" aria-checked="false" tabindex="-1" data-ai-mode="auto">Auto-apply</button></div>' +
    '<div class="ar-cbox"><label class="ai-vh" for="ar-ask">Describe a change</label><textarea id="ar-ask" class="ar-cin" rows="2" spellcheck="false"></textarea>' +
    '<button type="button" class="ar-send" aria-label="Send" data-ai-act="send">' + SV(IA.send, 16) + '</button></div></div>' +
    '</div></div>';
  host.innerHTML =
    '<div class="ar-kinds" role="tablist" aria-label="Diagram kind">' + TABS.map((t, i) =>
      '<button type="button" role="tab" class="ar-kind" id="' + tabId(i) + '" aria-controls="ar-panel" data-ar-kind="' + t.kind + '" aria-selected="' + (i ? 'false' : 'true') + '" tabindex="' + (i ? -1 : 0) + '">' + t.label + '</button>').join('') + '<i class="ar-ink" aria-hidden="true"></i></div>' +
    '<div class="ar-panel" id="ar-panel" role="tabpanel" aria-labelledby="' + tabId(0) + '">' +
    '<div class="ar-head"><b data-ar-file></b><span class="ar-about" data-ar-about></span>' +
    '<div class="ar-tabs" role="group" aria-label="Cloud provider" hidden>' + ['aws', 'gcp'].map((id, i) => '<button type="button" class="ar-tab" data-ar-tab="' + i + '" data-ar-ex="' + id + '" aria-pressed="' + (i ? 'false' : 'true') + '">' + exById(id).sub + '</button>').join('') + '</div>' +
    '<button type="button" class="ar-reset" data-ar-reset hidden>Reset the text</button></div>' +
    SIDE_HEAD + '<div class="ar-ed" id="ar-pane-ed" role="tabpanel" aria-labelledby="ar-pt-ed"><div class="ar-in"><div class="ar-gut" aria-hidden="true"></div><div class="ar-box"><pre class="ar-hl" aria-hidden="true"></pre>' +
    '<textarea class="ar-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label=".flow text of the diagram, editable. The canvas redraws as you type."></textarea></div></div></div>' + SIDE_ASSIST + '</div>' +
    '<div class="ar-cv" role="img"><p class="ar-stale" hidden></p><div class="ar-world"><div class="ar-inner"></div></div></div>' +
    '<div class="ar-foot"><span class="ar-prob" role="status" aria-live="polite"></span><span class="ar-count"></span></div></div>';
  const ui = {
    kinds: [...host.querySelectorAll('[data-ar-kind]')], ink: host.querySelector('.ar-ink'), panel: host.querySelector('.ar-panel'),
    file: host.querySelector('[data-ar-file]'), about: host.querySelector('[data-ar-about]'), sub: host.querySelector('.ar-tabs'), tabs: [...host.querySelectorAll('[data-ar-tab]')], reset: host.querySelector('[data-ar-reset]'),
    ed: host.querySelector('.ar-ed'), gut: host.querySelector('.ar-gut'), hl: host.querySelector('.ar-hl'), ta: host.querySelector('.ar-ta'),
    cv: host.querySelector('.ar-cv'), world: host.querySelector('.ar-world'), inner: host.querySelector('.ar-inner'), staleP: host.querySelector('.ar-stale'),
    prob: host.querySelector('.ar-prob'), count: host.querySelector('.ar-count'),
  };
  let cur = EX[0], kindAt = 0, cloudEx = 'aws';
  const NOUN = { flow: ['shape', 'shapes'], dfd: ['node', 'nodes'], cloud: ['service', 'services'], sequence: ['participant', 'participants'], state: ['state', 'states'], class: ['class', 'classes'], mindmap: ['topic', 'topics'], timeline: ['item', 'items'] };

  function update(animate) {
    const X = cur;
    const res = parse(X.src);
    const bad = new Set(res.problems.filter((p) => p.severity === 'error').map((p) => p.line));
    const band = X.band || new Set();
    ui.gut.innerHTML = res.lines.map((_, i) => '<span' + (bad.has(i + 1) ? ' class="bad"' : band.has(i + 1) ? ' class="ai"' : '') + '>' + (i + 1) + '</span>').join('');
    let firstSeen = false;
    ui.hl.innerHTML = res.lines.map((l, i) => {
      const first = !firstSeen && l.trim() && !/^\s*\/\//.test(l);
      if (first) firstSeen = true;
      return '<span class="l' + (bad.has(i + 1) ? ' bad' : band.has(i + 1) ? ' ai' : '') + '">' + (paint(l, first) || ' ') + '</span>';
    }).join('');
    if (res.doc) {
      // a renamed node keeps its place: same line, new name
      const prev = X.lineOf;
      res.doc.nodes.forEach((n) => {
        if (X.pos[n.name]) return;
        const old = Object.keys(prev).find((k) => prev[k] === n.line && res.lineOf[k] === undefined && X.pos[k]);
        if (old) X.pos[n.name] = X.pos[old];
      });
      const before = X.good ? new Set(X.good.nodes.map((n) => n.name)) : null;
      const fresh = new Set(animate && before ? res.doc.nodes.filter((n) => !before.has(n.name)).map((n) => n.name) : []);
      X.good = res.doc; X.lineOf = res.lineOf;
      draw(X, res.doc, fresh);
      ui.cv.classList.remove('is-stale'); ui.staleP.hidden = true;
    } else if (X.good) {
      const line = res.problems.find((p) => p.severity === 'error').line;
      ui.cv.classList.add('is-stale'); ui.staleP.hidden = false; ui.staleP.textContent = stale(line);
    }
    const errs = res.problems.filter((p) => p.severity === 'error');
    const shown = errs[0] || res.problems[0];
    ui.prob.textContent = shown ? 'Line ' + shown.line + ': ' + shown.message + (res.problems.length > 1 ? ' (' + res.problems.length + ' problems)' : '') : 'No problems';
    ui.prob.classList.toggle('err', !!errs.length);
    const g = X.good || { nodes: [], kind: 'flow' };
    const real = g.nodes.filter((n) => n.name !== STATE_START && n.name !== STATE_END && n.kind !== 'note');
    const noun = NOUN[g.kind] || NOUN.flow;
    ui.count.textContent = real.length + ' ' + noun[real.length === 1 ? 0 : 1] + (!wide() && X.view && X.view.w * X.scale > ui.cv.clientWidth + 1 ? ', scroll the canvas sideways' : '');
    ui.cv.setAttribute('aria-label', 'Canvas: ' + (X.good ? real.map((n) => n.name).join(', ') : 'empty'));
    ui.reset.hidden = X.src === X.text;
    ui.reset.disabled = !!(X.ai && (X.ai.busy || X.ai.pending));
    ui.about.textContent = ABOUT[res.kind && ABOUT[res.kind] ? res.kind : TABS[kindAt].kind];
  }
  function showEx(id) {
    if (cur.id !== id) aiLeave();
    cur = exById(id);
    ui.file.textContent = cur.file;
    ui.ta.value = cur.src;
    ui.ed.scrollTop = 0; ui.ed.scrollLeft = 0; ui.cv.scrollTop = 0; ui.cv.scrollLeft = 0;
    update(false);
    aiShow();
  }
  function showKind(i, focus) {
    kindAt = i;
    const t = TABS[i];
    ui.kinds.forEach((b, k) => { b.setAttribute('aria-selected', k === i ? 'true' : 'false'); b.tabIndex = k === i ? 0 : -1; });
    ui.panel.setAttribute('aria-labelledby', tabId(i));
    // keep the picked tab in view inside its own bar, never by scrolling the page
    const b = ui.kinds[i], bar = b.parentNode;
    if (b.offsetLeft < bar.scrollLeft) bar.scrollLeft = b.offsetLeft - 8;
    else if (b.offsetLeft + b.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = b.offsetLeft + b.offsetWidth - bar.clientWidth + 8;
    if (focus) b.focus({ preventScroll: true });
    ink();
    ui.sub.hidden = t.kind !== 'cloud';
    showEx(t.kind === 'cloud' ? cloudEx : t.kind);
    // one motion between kinds: the line under the tabs travels and the new drawing settles in
    if (swapped) { ui.world.classList.remove('swap'); void ui.world.offsetWidth; ui.world.classList.add('swap'); }
    swapped = true;
  }
  let swapped = false;
  /** The accent line under the picked kind, moved and stretched with transform only. */
  function ink() { const b = ui.kinds[kindAt]; ui.ink.style.transform = 'translateX(' + b.offsetLeft + 'px) scaleX(' + b.offsetWidth / 100 + ')'; }
  let raf = 0;
  ui.ta.addEventListener('input', () => {
    cur.src = ui.ta.value; cur.band = null;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(true); });
  });
  // the textarea never scrolls itself: the editor around it does, so the colours stay under the letters
  ui.ta.addEventListener('scroll', () => { ui.ta.scrollTop = 0; ui.ta.scrollLeft = 0; });
  ui.kinds.forEach((b, i) => {
    b.addEventListener('click', () => showKind(i));
    b.addEventListener('keydown', (e) => {
      const n = TABS.length;
      const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      showKind(to, true);
    });
  });
  ui.tabs.forEach((b) => b.addEventListener('click', () => {
    cloudEx = b.dataset.arEx;
    ui.tabs.forEach((o) => o.setAttribute('aria-pressed', o === b ? 'true' : 'false'));
    showEx(cloudEx);
  }));
  ui.reset.addEventListener('click', () => {
    const X = cur;
    X.src = X.text; X.band = null; X.pos = Object.assign(Object.create(null), X.base); X.good = null; X.lineOf = Object.create(null);
    showEx(X.id);
    ui.ta.focus();
  });
  // a shape on the canvas lights up its line, and a line lights up its shape
  function mark(line) {
    host.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl'));
    if (!line) return;
    const g = ui.gut.children[line - 1], l = ui.hl.children[line - 1];
    if (g) g.classList.add('hl');
    if (l) l.classList.add('hl');
    ui.inner.querySelectorAll('.gn[data-line="' + line + '"]').forEach((n) => n.classList.add('hl'));
  }
  ui.inner.addEventListener('pointerover', (e) => { const n = e.target.closest && e.target.closest('.gn'); mark(n ? +n.dataset.line : 0); });
  ui.inner.addEventListener('pointerleave', () => mark(0));
  const lineAtSel = () => ui.ta.value.slice(0, ui.ta.selectionStart).split('\n').length;
  ['keyup', 'click', 'focus'].forEach((ev) => ui.ta.addEventListener(ev, () => mark(lineAtSel())));
  ui.ta.addEventListener('blur', () => mark(0));
  if ('ResizeObserver' in window) { new ResizeObserver(() => fit()).observe(ui.cv); new ResizeObserver(() => ink()).observe(ui.kinds[0].parentNode); }
  else addEventListener('resize', fit);
  /* ---- the diagram assistant (step 11h, board 11.5), with a recorded model: no network, same answers every time ----
     An Ask sends the .flow text and offers one tool, propose_diagram_changes. Every proposed change is checked
     against this file before it is shown; the result lands by Review first or Auto-apply, as one undo step. */
  const AI = {
    flow: [
      {
        ask: 'Add a retry when the payment fails', keys: ['retry', 'fail', 'again'],
        did: ['Placed Paid? after Pay back', 'Routed a failed payment to Retry payment'],
        answer: 'I\'ll check each payment after Pay back. A failed one goes to Retry payment and back to Pay back; a paid one ends at Done.',
        at: { 'Paid?': [100, 410], 'Retry payment': [290, 438], Done: [139, 560] },
        changes: [
          { add: 'Paid? [decision]', after: ['Pay back'], shape: 'Paid?' },
          { add: 'Retry payment', after: ['Paid? [decision]', 'Pay back'], shape: 'Retry payment' },
          { del: 'Pay back > Done' },
          { add: 'Pay back > Paid?' },
          { add: 'Paid? > Done : yes' },
          { add: 'Paid? > Retry payment : no' },
          { add: 'Retry payment > Pay back : try again' },
          { add: 'Retry payment > Notify finance : after 3 tries' },
        ],
        fix: {
          did: ['Added Notify finance as a document'],
          answer: 'I\'ll add Notify finance as a document, so a payment that fails 3 times reaches finance.',
          at: { 'Notify finance': [480, 438] },
          extra: [
            { add: 'Notify finance [document]', after: ['Retry payment', 'Pay back'], shape: 'Notify finance' },
            { add: 'Retry payment > Notify finance : after 3 tries' },
          ],
        },
      },
      {
        ask: 'Rename Pay back to Refund card', keys: ['rename', 'refund card'],
        did: ['Found Pay back and the lines that point at it'],
        answer: 'I\'ll rename Pay back to Refund card, in its own line and in every line that points at it.',
        changes: [{ ren: ['Pay back', 'Refund card'] }],
      },
    ],
    dfd: [
      {
        ask: 'Add a fraud check before charging the card', keys: ['fraud', 'check'],
        did: ['Placed Fraud check between Take order and Charge card'],
        answer: 'I\'ll put Fraud check (1.5) between Take order and Charge card, so the total is checked before the card is charged.',
        at: { 'Fraud check': [246, 150], 'Charge card': [246, 300], 'Payment provider': [232, 450] },
        changes: [
          { add: '  Fraud check [process, id: 1.5]', after: ['Take order [process, id: 1.0]'], shape: 'Fraud check' },
          { del: 'Take order > Charge card : total' },
          { add: 'Take order > Fraud check : total' },
          { add: 'Fraud check > Charge card : cleared' },
        ],
      },
      {
        ask: 'Keep an audit log of every charge', keys: ['audit', 'log'],
        did: ['Added Audit log as a store in Shop'],
        answer: 'I\'ll add an Audit log store (D2) in Shop and write each charge to it.',
        at: { 'Audit log': [540, 150] },
        changes: [
          { add: '  Audit log [store, id: D2]', after: ['Orders [store, id: D1, table: shop.orders]'], shape: 'Audit log' },
          { add: 'Charge card > Audit log : charge record' },
        ],
      },
    ],
    sequence: [
      {
        ask: 'Add a call to the payment provider', keys: ['payment', 'provider', 'charge'],
        did: ['Added Payments as a participant', 'Placed the charge after the stock update'],
        answer: 'I\'ll add Payments and have the API charge the card after it updates the stock and before it commits.',
        changes: [
          { add: 'participant Payments', after: ['participant Database'], shape: 'Payments' },
          { add: 'API -> Payments : Charge card', after: ['}'] },
          { add: 'Payments --> API : Approved', after: ['API -> Payments : Charge card', '}'] },
        ],
      },
    ],
    state: [
      {
        ask: 'Add an Overdue state', keys: ['overdue', 'late'],
        did: ['Placed Overdue after Sent'],
        answer: 'I\'ll add Overdue: a sent invoice turns overdue when its due date passes, and can still be paid or written off.',
        at: { Overdue: [339, 130], Void: [153, 236], '[*] end': [632, 137] },
        changes: [
          { add: 'Overdue', after: ['Void'], shape: 'Overdue' },
          { add: 'Sent > Overdue : due date passes', after: ['Sent > Void : cancel'] },
          { add: 'Overdue > Paid : late payment', after: ['Sent > Overdue : due date passes', 'Sent > Void : cancel'] },
          { add: 'Overdue > Void : write off', after: ['Overdue > Paid : late payment', 'Sent > Void : cancel'] },
        ],
      },
      {
        ask: 'Let a paid invoice be refunded', keys: ['refund', 'refunded'],
        did: ['Placed Refunded after Paid'],
        answer: 'I\'ll add Refunded after Paid, and end the invoice there instead of at Paid.',
        at: { Refunded: [600, 0], '[*] end': [680, 137] },
        changes: [
          { add: 'Refunded', after: ['Void'], shape: 'Refunded' },
          { del: 'Paid > [*]' },
          { add: 'Paid > Refunded : refund', after: ['Sent > Paid : payment'] },
          { add: 'Refunded > [*]', after: ['Void > [*]'] },
        ],
      },
    ],
  };
  const TOOL_BYTES = 1186; // the propose_diagram_changes definition and the diagram instructions, as the Sent record counts them
  const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRe = (n) => new RegExp('(^|[^\\w])' + reEsc(n) + '(?![\\w])', 'g');
  const grouped = (n) => n.toLocaleString('en-US');
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const andList = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
  /** The part of a line before its label: a rename never touches the words after the colon. */
  function headOf(line) {
    let d = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '[') d++; else if (c === ']') d--; else if (c === ':' && d === 0) return i;
    }
    return line.length;
  }
  const mentions = (line, n) => tokenRe(n).test(line.slice(0, headOf(line)));
  /** The line a change writes or removes, as the review list shows it. */
  function changeText(c) { return c.ren ? c.ren[0] + ' to ' + c.ren[1] : (c.add || c.del).trim(); }
  const changeMark = (c) => (c.status === 'dropped' ? '!' : c.ren ? '~' : c.del ? '\u2212' : '+');
  const changeCls = (c) => (c.status === 'dropped' ? 'drop' : c.ren ? 'ren' : c.del ? 'del' : 'add');
  /** Apply one change to the lines; lines carry a flag for what the assistant wrote. Returns a reason when it cannot apply. */
  function applyOne(lines, c) {
    if (c.add) {
      if (c.shape && lines.some((l) => l.t.trim().split(/\s*\[/)[0] === c.shape)) return 'the name ' + c.shape + ' is taken';
      const at = (c.after || []).map((a) => lines.findIndex((l) => l.t.trim() === a.trim())).find((i) => i >= 0);
      let i = at === undefined ? lines.length : at + 1;
      if (at === undefined) while (i > 0 && !lines[i - 1].t.trim()) i--;
      lines.splice(i, 0, { t: c.add, ai: true });
      return '';
    }
    if (c.del) {
      const i = lines.findIndex((l) => l.t.trim() === c.del);
      if (i < 0) return 'there is no line ' + c.del + ' in this file';
      lines.splice(i, 1);
      return '';
    }
    const [from, to] = c.ren;
    let hit = false;
    if (lines.some((l) => l.t.trim().split(/\s*\[/)[0] === to)) return 'the name ' + to + ' is taken';
    lines.forEach((l) => {
      const h = headOf(l.t), head = l.t.slice(0, h);
      if (!tokenRe(from).test(head)) return;
      l.t = head.replace(tokenRe(from), (m, pre) => pre + to) + l.t.slice(h);
      l.ai = true; hit = true;
    });
    return hit ? '' : 'there is no shape called ' + from + ' in this diagram';
  }
  const errorsOf = (text) => parse(text).problems.filter((p) => p.severity === 'error');
  /** The parser's message, said the way the checker card says it. */
  const SHAPE_WORD = { sequence: 'participant', state: 'state', class: 'class', mindmap: 'topic' };
  function reasonOf(msg) {
    let m;
    if ((m = /^(.+) is not defined\.$/.exec(msg))) return 'there is no ' + (SHAPE_WORD[cur.id] || 'shape') + ' called ' + m[1] + ' in this diagram';
    if ((m = /^(.+) is defined twice/.exec(msg))) return 'the name ' + m[1] + ' is taken';
    return msg.charAt(0).toLowerCase() + msg.slice(1).replace(/\.$/, '');
  }
  /** Contura's check: each change in order against this file; one that leaves a new problem is dropped with the reason. */
  function check(text, specs) {
    const changes = specs.map((s) => Object.assign({}, s, { status: 'ok', reason: '', rej: false, needs: [] }));
    changes.forEach((c, i) => {
      c.needs = changes.map((o, k) => (k !== i && o.shape && mentions(c.add || c.del || '', o.shape) && !(c.add && c.add.trim().split(/\s*\[/)[0] === o.shape) ? k : -1)).filter((k) => k >= 0);
    });
    let lines = text.split('\n').map((t) => ({ t, ai: false }));
    let errs = errorsOf(text).length;
    changes.forEach((c) => {
      const next = lines.map((l) => Object.assign({}, l));
      const why = applyOne(next, c);
      if (why) { c.status = 'dropped'; c.reason = why; return; }
      const e = errorsOf(next.map((l) => l.t).join('\n'));
      if (e.length > errs) { c.status = 'dropped'; c.reason = reasonOf(e[e.length - 1].message); return; }
      lines = next; errs = e.length;
    });
    return changes;
  }
  /** The accepted changes in order, as one text: what lands as one undo step. */
  function land(text, changes) {
    const lines = text.split('\n').map((t) => ({ t, ai: false }));
    const shapes = [], renamed = [];
    changes.forEach((c) => {
      if (c.status !== 'ok' || c.rej || applyOne(lines, c)) return;
      if (c.shape) shapes.push(c.shape);
      if (c.ren) renamed.push(c.ren);
    });
    const band = new Set();
    lines.forEach((l, i) => { if (l.ai) band.add(i + 1); });
    return { text: lines.map((l) => l.t).join('\n'), band, shapes, renamed };
  }
  /** Rejecting a change takes the changes that need it; keeping one keeps what it needs. */
  function setRej(changes, i, rej) {
    const walk = (k) => {
      if (changes[k].rej === rej) return;
      changes[k].rej = rej;
      if (rej) changes.forEach((o, j) => { if (o.needs.includes(k)) walk(j); });
      else changes[k].needs.forEach(walk);
    };
    changes[i].rej = !rej; walk(i);
  }
  const live = (p) => p.changes.filter((c) => c.status === 'ok' && !c.rej);
  function summary(changes, file) {
    const on = changes.filter((c) => c.status === 'ok' && !c.rej);
    const shapes = on.filter((c) => c.add && c.shape).map((c) => c.shape);
    const cols = on.filter((c) => c.add && c.what === 'column').length;
    const lines = on.filter((c) => c.add && !c.shape && c.what !== 'column').length;
    const gone = on.filter((c) => c.del).length;
    const ren = on.filter((c) => c.ren);
    const added = shapes.slice(0, 3).concat(shapes.length > 3 ? [plural(shapes.length - 3, 'more shape', 'more shapes')] : []);
    if (cols) added.push(plural(cols, 'column', 'columns'));
    if (lines) added.push(plural(lines, 'line', 'lines'));
    const parts = [];
    if (added.length) parts.push('added ' + andList(added));
    if (ren.length) parts.push(ren.length === 1 ? 'renamed ' + ren[0].ren[0] + ' to ' + ren[0].ren[1] : 'renamed ' + plural(ren.length, 'shape', 'shapes'));
    if (gone) parts.push('removed ' + plural(gone, 'line', 'lines'));
    return 'Done. I ' + andList(parts) + ' in ' + file + ', as one undo step.' + (shapes.length || ren.length ? ' The new parts are ringed on the canvas for a moment.' : '');
  }
  function droppedNote(p) {
    const d = p.changes.filter((c) => c.status === 'dropped');
    if (!d.length) return '';
    const rest = p.changes.length - d.length;
    return 'Contura dropped ' + (d.length === 1 ? 'one change' : d.length + ' changes') + ': ' + d.map((c) => c.reason).join('; ') + '. ' + (rest ? 'The other ' + rest + ' still fit together.' : 'Nothing else was proposed.');
  }

  /* the pane's elements */
  Object.assign(ui, {
    side: host.querySelector('.ar-side'), sw: host.querySelector('.ar-sw'), pts: [...host.querySelectorAll('[data-ar-pane]')],
    pc: host.querySelector('.ar-pc'), pdot: host.querySelector('.ar-pdot'), lk: host.querySelector('.ar-lk'), ebar: host.querySelector('.ar-ebar'),
    as: host.querySelector('.ar-as'), chat: host.querySelector('.ar-chat'), cwork: host.querySelector('.ar-cwork'), cform: host.querySelector('.ar-cform'),
    ask: host.querySelector('.ar-cin'), modes: [...host.querySelectorAll('[data-ai-mode]')], working: host.querySelector('[data-ai-working]'),
  });
  let pane = 'editor', mode = 'review';
  const stateOf = (X) => X.ai || (X.ai = { log: [], busy: null, pending: null, undo: null, used: new Set() });
  function setPane(p, focus) {
    pane = p;
    const ed = p === 'editor';
    ui.sw.classList.toggle('right', !ed);
    ui.pts.forEach((b) => { const on = b.dataset.arPane === p; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    ui.ed.hidden = !ed; ui.as.hidden = ed;
    const shown = ed ? ui.ed : ui.as;
    shown.classList.remove('ar-pane-in'); void shown.offsetWidth; shown.classList.add('ar-pane-in');
    if (focus) ui.pts.find((b) => b.dataset.arPane === p).focus({ preventScroll: true });
    if (!ed) ui.chat.scrollTop = ui.chat.scrollHeight;
    chrome();
  }
  ui.pts.forEach((b) => {
    b.addEventListener('click', () => setPane(b.dataset.arPane));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      setPane(pane === 'editor' ? 'assistant' : 'editor', true);
    });
  });
  ui.modes.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.aiMode)));
  ui.modes[0].parentNode.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); setMode(mode === 'review' ? 'auto' : 'review');
    ui.modes.find((b) => b.dataset.aiMode === mode).focus();
  });
  function setMode(m) {
    mode = m;
    ui.modes.forEach((b) => { const on = b.dataset.aiMode === m; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
  }

  /* the conversation, drawn from the state of the open file */
  const btn = (act, label, cls, extra) => '<button type="button" class="ai-b' + (cls ? ' ' + cls : '') + '" data-ai-act="' + act + '"' + (extra || '') + '>' + label + '</button>';
  function cardHtml(p, at) {
    const n = p.changes.length, k = live(p).length;
    const open = p.state === 'review';
    const title = p.state === 'landed' ? plural(k, 'change', 'changes') + ' landed' : k === n ? plural(n, 'change', 'changes') : k + ' of ' + plural(n, 'change', 'changes');
    const rows = p.changes.map((c, i) => {
      const drop = c.status === 'dropped';
      const tog = open && !drop ? '<button type="button" class="ai-ib" data-ai-act="toggle" data-ai-i="' + i + '" aria-label="' + (c.rej ? 'Keep this change' : 'Reject this change') + '">' + SV(c.rej ? IA.undo : IA.x, 14) + '</button>' : drop ? '<span class="ai-dtag">dropped</span>' : '<span></span>';
      return '<div class="ai-row ' + changeCls(c) + (c.rej ? ' off' : '') + '"><span class="mk" aria-hidden="true">' + changeMark(c) + '</span><span class="tx">' + esc(changeText(c)) + '</span>' + tog + '</div>';
    }).join('');
    const note = droppedNote(p);
    let foot = '';
    if (open) {
      const any = p.changes.some((c) => c.rej || c.status === 'dropped');
      foot = '<div class="ai-foot">' + (note ? '' : '<span class="ai-lands">Lands as one undo step</span>') + '<span class="ai-sp"></span>' + btn('rejectall', 'Reject all') +
        (note ? btn('fix', 'Ask to fix it') : '') +
        btn('accept', (any ? 'Accept ' + k : 'Accept all') + (note ? '' : '<span class="ar-kh">Ctrl+Enter</span>'), 'pri', k ? '' : ' disabled') + '</div>';
    }
    return '<div class="ai-card" role="group" aria-label="Changes to review" data-ai-card="' + at + '"><div class="ai-ch"><span>' + title + '</span></div>' + rows +
      (note ? '<p class="ai-note">' + esc(note) + '</p>' : '') + foot + '</div>';
  }
  function entryHtml(e, at, X) {
    if (e.t === 'u') return '<div class="ai-u">' + esc(e.text) + '</div>';
    let h = '<div class="ai-a">';
    if (e.steps && !(e.full && e.shown === e.full.length && !e.steps.some((s) => s.st === 'stopped'))) h += '<ol class="ai-steps">' + e.steps.map((s) => '<li class="' + s.st + '"><i aria-hidden="true"></i>' + esc(s.text) + '</li>').join('') + '</ol>';
    if (e.shown !== undefined) h += '<p class="ai-text" data-ai-stream>' + esc(e.full.slice(0, e.shown)) + '</p>';
    if (e.card && e.shown === e.full.length) h += cardHtml(e.card, at);
    if (e.after) h += '<p class="ai-text ai-after">' + (e.ok ? SV(IA.check, 14, 'ok') : '') + esc(e.after) + '</p>';
    if (e.undo && X.ai.undo && X.ai.undo.entry === e && X.src === X.ai.undo.after) h += '<div class="ai-acts">' + btn('undo', 'Undo<span class="ar-kh">Ctrl+Z</span>') + btn('show', 'Show in the text') + '</div>';
    if (e.meta) h += '<p class="ai-meta">' + esc(e.meta) + '</p>';
    return h + '</div>';
  }
  function render() {
    const X = cur, S = stateOf(X), list = AI[X.id] || [];
    let h = '';
    if (!S.log.length) {
      h = '<div class="ai-empty"><b>Ask for a change to ' + esc(X.file) + '</b><span>The assistant edits the text and the drawing together. While it works, the text is read-only.</span></div>';
    } else h = S.log.map((e, i) => entryHtml(e, i, X)).join('');
    const left = list.filter((s) => !S.used.has(s.ask));
    if (!S.busy && !S.pending && left.length) h += '<div class="ai-sugs">' + left.map((s) => '<button type="button" class="ai-sug" data-ai-act="suggest" data-ai-q="' + esc(s.ask) + '">' + esc(s.ask) + '</button>').join('') + '</div>';
    const fa = AE(), had = ui.chat.contains(fa) && fa.dataset.aiAct ? '[data-ai-act="' + fa.dataset.aiAct + '"]' + (fa.dataset.aiI ? '[data-ai-i="' + fa.dataset.aiI + '"]' : '') : '';
    ui.chat.innerHTML = h;
    ui.chat.scrollTop = ui.chat.scrollHeight;
    if (had) { const b = [...ui.chat.querySelectorAll(had + ':not([disabled])')].pop(); (b || ui.ask).focus({ preventScroll: true }); }
    chrome();
  }
  /** Everything around the conversation: the tab's count, the read-only editor, the composer. */
  function chrome() {
    const X = cur, S = stateOf(X);
    const k = S.pending ? live(S.pending).length : 0;
    ui.pc.hidden = !S.pending; ui.pc.textContent = String(k);
    ui.pts[1].setAttribute('aria-label', S.pending ? 'Assistant, ' + plural(k, 'change', 'changes') + ' to review' : S.busy ? 'Assistant, working' : 'Assistant');
    ui.pdot.hidden = !S.busy;
    const locked = !!(S.busy || S.pending);
    ui.lk.style.display = locked ? '' : 'none';
    ui.ta.readOnly = locked; ui.ed.classList.toggle('locked', locked);
    ui.reset.disabled = locked;
    ui.ebar.hidden = !locked || pane !== 'editor';
    if (S.busy) ui.ebar.innerHTML = SV(IA.lock, 14) + '<span class="ai-fill">The assistant is editing. The text is read-only until it finishes.</span>' + btn('stop', 'Stop');
    else if (S.pending) {
      const any = S.pending.changes.some((c) => c.rej || c.status === 'dropped');
      ui.ebar.innerHTML = '<span class="ai-fill">' + plural(k, 'change', 'changes') + ' from the assistant ' + (k === 1 ? 'waits' : 'wait') + ' for review.</span>' + btn('rejectall', 'Reject all') + btn('accept', any ? 'Accept ' + k : 'Accept all', 'pri', k ? '' : ' disabled');
    }
    ui.cwork.hidden = !S.busy; ui.cform.hidden = !!S.busy;
    ui.working.textContent = 'Working on ' + X.file + '. Stop it to type.';
    const list = AI[X.id];
    ui.ask.placeholder = list ? 'Describe a change, for example ' + list[0].ask.charAt(0).toLowerCase() + list[0].ask.slice(1) : 'Describe a change';
  }
  function streamTo(e) {
    const p = ui.chat.querySelector('.ai-a:last-child [data-ai-stream]');
    if (p) p.textContent = e.full.slice(0, e.shown);
    ui.chat.scrollTop = ui.chat.scrollHeight;
  }

  /* the canvas while changes wait: the proposal drawn with new parts dashed in green */
  /** Where the recorded answer puts new shapes, and the few it moves to make room; the old places come back on reject or undo. */
  function placeAt(X, at) {
    const prev = {};
    Object.keys(at || {}).forEach((n) => { prev[n] = X.pos[n] ? Object.assign({}, X.pos[n]) : null; X.pos[n] = { x: at[n][0], y: at[n][1] }; });
    return prev;
  }
  function restore(X, prev) { Object.keys(prev || {}).forEach((n) => { if (prev[n]) X.pos[n] = prev[n]; else delete X.pos[n]; }); }
  function preview(fresh) {
    const X = cur, S = stateOf(X), p = S.pending;
    if (!p) return;
    const r = land(X.src, p.changes);
    r.renamed.forEach(([a, b]) => { if (X.pos[a] && !X.pos[b]) X.pos[b] = X.pos[a]; });
    const res = parse(r.text);
    if (!res.doc) return;
    draw(X, res.doc, new Set(fresh ? r.shapes : []));
    r.shapes.concat(r.renamed.map((x) => x[1])).forEach((n) => ui.inner.querySelectorAll('.gn[data-n="' + CSS.escape(n) + '"]').forEach((g) => { g.classList.add('ai-ghost'); g.insertAdjacentHTML('beforeend', '<span class="ai-tag">' + (r.shapes.includes(n) ? 'New' : 'Renamed') + '</span>'); }));
    r.band.forEach((ln) => ui.inner.querySelectorAll('.gl[data-line="' + ln + '"]').forEach((g) => g.classList.add('ai-add')));
    ui.cv.setAttribute('aria-label', 'Canvas, with the changes the assistant suggests: ' + res.doc.nodes.map((n) => n.name).join(', '));
  }
  function ring(names) {
    names.forEach((n) => ui.inner.querySelectorAll('.gn[data-n="' + CSS.escape(n) + '"]').forEach((g) => g.classList.add('ai-ring')));
  }

  /* an Ask: the recorded model streams, Contura checks, then Review first or Auto-apply */
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  function pick(q, X) {
    const t = q.toLowerCase().trim();
    const list = AI[X.id] || [];
    const exact = list.find((s) => s.ask.toLowerCase() === t);
    if (exact) return exact;
    let best = null, top = 0;
    list.forEach((s) => { const n = s.keys.filter((k) => t.includes(k)).length; if (n > top) { top = n; best = s; } });
    return top >= (list.length > 1 ? 2 : 1) || (best && top && list.filter((s) => s.keys.some((k) => t.includes(k))).length === 1) ? best : null;
  }
  function send(q, fixOf) {
    const X = cur, S = stateOf(X);
    q = q.trim();
    if (!q || S.busy) return;
    if (S.pending && !fixOf) { S.pending.state = 'replaced'; S.pendingEntry.after = 'Replaced by the answer below.'; restore(X, S.pending.prev); S.pending = null; update(false); }
    const script = fixOf ? null : pick(q, X);
    if (script) S.used.add(script.ask);
    const base = X.src, lines = base.split('\n').length;
    S.log.push({ t: 'u', text: q });
    const e = { t: 'a', steps: [{ text: 'Read ' + X.file + ', ' + plural(lines, 'line', 'lines'), st: 'now' }] };
    S.log.push(e);
    S.busy = { e, X };
    e.ask = script ? script.ask : null;
    ui.ask.value = '';
    render();
    const stop = ui.cwork.querySelector('[data-ai-act="stop"]');
    if (ui.as.contains(AE()) || (!sr.activeElement && AE() === document.body)) stop.focus({ preventScroll: true });
    const fix = fixOf ? Object.assign({}, fixOf.script.fix, { at: Object.assign({}, fixOf.script.at, fixOf.script.fix.at) }) : null;
    const did = fix ? fix.did : script ? script.did : ['Looked for a change to make in ' + X.file];
    let t = 0;
    did.forEach((d) => { t += 380; later(t, () => { e.steps[e.steps.length - 1].st = 'done'; e.steps.push({ text: d, st: 'now' }); render(); }); });
    const specs = fix ? fixOf.changes.filter((c) => c.status === 'ok').map(({ status, reason, rej, needs, ...s }) => s).concat(fix.extra) : script ? script.changes : [];
    t += 380;
    later(t, () => {
      e.steps[e.steps.length - 1].st = 'done';
      if (specs.length) e.steps.push({ text: 'Contura checked ' + plural(specs.length, 'change', 'changes') + ' against ' + X.file, st: 'done' });
      e.full = fix ? fix.answer : script ? script.answer : 'I can only change ' + X.file + ': add, rename or remove its shapes and lines, and each change comes to you before it lands. I never read or change a database. This page plays recorded answers, so pick one of the Asks below' + (AI[X.id] ? '.' : ' on the Flowchart, Data flow, Sequence or State tab.');
      e.shown = 0;
      const ms = 900 + specs.length * 90 + Math.round(base.length / 4);
      e.meta = 'Sent ' + grouped(base.length + q.length + TOOL_BYTES) + ' bytes, 1 tool \u00b7 ' + (ms / 1000).toFixed(1) + 's \u00b7 in Sends and the answer log';
      render();
      const words = e.full.split(' ');
      let w = 0;
      const tick = () => {
        w++;
        e.shown = w >= words.length ? e.full.length : words.slice(0, w).join(' ').length;
        streamTo(e);
        if (w < words.length) later(22, tick); else finish(X, e, base, specs, fix || script);
      };
      later(22, tick);
    });
  }
  function finish(X, e, base, specs, script) {
    const S = stateOf(X);
    S.busy = null;
    if (!specs.length) { e.after = 'No changes proposed.'; render(); ui.ask.focus({ preventScroll: true }); return; }
    const prev = placeAt(X, script.at);
    const changes = check(base, specs);
    e.card = { changes, state: 'review', base, script, prev };
    if (mode === 'auto') { landCard(X, e); return; }
    S.pending = e.card; S.pendingEntry = e;
    render(); preview(true);
    const a = ui.chat.querySelector('[data-ai-card]:last-of-type [data-ai-act="accept"]');
    if (a && ui.as.contains(AE())) a.focus({ preventScroll: true });
  }
  function landCard(X, e) {
    const S = stateOf(X), p = e.card;
    const before = X.src;
    const r = land(before, p.changes);
    r.renamed.forEach(([a, b]) => { if (X.pos[a]) X.pos[b] = X.pos[a]; });
    p.state = 'landed'; S.pending = null;
    X.src = r.text; X.band = r.band;
    ui.ta.value = X.src;
    update(true);
    ring(r.shapes.concat(r.renamed.map((x) => x[1])));
    e.after = summary(p.changes, X.file); e.ok = true;
    e.undo = true; S.undo = { before, after: X.src, entry: e };
    render();
  }
  function act(a, el) {
    const X = cur, S = stateOf(X);
    const p = S.pending, e = S.pendingEntry;
    if (a === 'send') send(ui.ask.value);
    else if (a === 'suggest') send(el.dataset.aiQ);
    else if (a === 'stop') stopAsk(true);
    else if (a === 'toggle' && p) { const i = +el.dataset.aiI; setRej(p.changes, i, !p.changes[i].rej); render(); preview(false); }
    else if (a === 'accept' && p) { if (live(p).length) landCard(X, e); }
    else if (a === 'rejectall' && p) { p.changes.forEach((c) => { c.rej = true; }); p.state = 'rejected'; S.pending = null; restore(X, p.prev); e.after = 'Rejected. ' + X.file + ' is as it was.'; update(false); render(); }
    else if (a === 'fix' && p && p.script.fix) { p.state = 'replaced'; S.pending = null; restore(X, p.prev); e.after = 'Replaced by the answer below.'; update(false); const msgs = p.changes.filter((c) => c.status === 'dropped').map((c) => c.reason).join('; '); send('Some changes could not be used: ' + msgs + '. Propose them again so they fit this diagram.', p); }
    else if (a === 'undo' && S.undo) undo(X);
    else if (a === 'show') { setPane('editor'); const first = X.band && Math.min(...X.band); if (first) ui.ed.scrollTop = Math.max(0, (first - 3) * (ui.hl.firstChild ? ui.hl.firstChild.offsetHeight : 20)); }
  }
  function undo(X) {
    const S = stateOf(X), u = S.undo;
    if (!u || X.src !== u.after) return;
    X.src = u.before; X.band = null; ui.ta.value = X.src;
    restore(X, u.entry.card.prev);
    S.undo = null;
    u.entry.after += ' Undone: ' + X.file + ' is back to the text before this Ask.';
    u.entry.ok = false;
    update(false); render();
  }
  function stopAsk(say) {
    timers.splice(0).forEach(clearTimeout);
    const S = stateOf(cur);
    if (!S.busy) return;
    const e = S.busy.e;
    e.steps.forEach((s) => { if (s.st === 'now') s.st = 'stopped'; });
    if (e.full) e.shown = e.full.length;
    e.after = say ? 'Stopped. Nothing was changed.' : 'Stopped when you opened another file. Nothing was changed.';
    e.card = null; S.busy = null;
    if (e.ask) S.used.delete(e.ask);
    render();
    if (say) ui.ask.focus({ preventScroll: true });
  }
  /** Leaving a file stops its Ask, as closing the tab does in the app. */
  function aiLeave() { if (stateOf(cur).busy) stopAsk(false); }
  function aiShow() { render(); if (stateOf(cur).pending) preview(false); }
  host.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-ai-act]');
    if (b && host.contains(b) && !b.disabled) act(b.dataset.aiAct, b);
  });
  ui.ask.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(ui.ask.value); }
  });
  ui.side.addEventListener('keydown', (ev) => {
    const S = stateOf(cur);
    if (ev.key === 'Escape' && S.busy) { ev.preventDefault(); stopAsk(true); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && S.pending) { ev.preventDefault(); act('accept'); }
    else if ((ev.key === 'z' || ev.key === 'Z') && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && S.undo && ev.target !== ui.ask) { ev.preventDefault(); undo(cur); }
  });
  ui.ta.addEventListener('input', () => { const S = stateOf(cur); if (S.undo) { S.undo = null; render(); } });
  /* the ask button beside the gallery: Flowchart, the Assistant pane, the window in view, then the recorded Ask */

  showKind(0);
  // a guard for a first look: draw the current kind again when the window first enters view
  if ('IntersectionObserver' in window) {
    const seen = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { seen.disconnect(); update(false); fit(); } });
    seen.observe(ui.cv);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { update(false); ink(); });
  return {
    kinds: TABS.map((t) => t.kind),
    showKind(k) { const i = typeof k === 'number' ? k : TABS.findIndex((t) => t.kind === k); if (i >= 0) showKind(i); },
    get kind() { return TABS[kindAt].kind; },
    get text() { return ui.ta.value; },
    setText(v) { ui.ta.value = v; cur.src = v; cur.band = null; update(true); },
    reset() { ui.ta.value = cur.text; cur.src = cur.text; cur.band = null; update(true); },
    get problem() { return ui.prob.textContent; },
    get bad() { return ui.prob.classList.contains('err'); },
    setPane: (p) => setPane(p),
    redraw() { update(false); ink(); },
    ta: ui.ta, root: host,
  };

    })();
    return outer._cdApi;
  }
  window.ConturaDiagrams = { mount };
  document.dispatchEvent(new CustomEvent('contura:diagrams-ready'));
})();
