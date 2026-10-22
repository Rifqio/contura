// Drives the running Contura exe over the WebView2 remote debugging port and
// saves one PNG per screen, for the design parity comparison (Task 25).
//
// Start the release exe with a fresh data folder first:
//   $env:CONTURA_DATA_DIR = "<new empty folder>"
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//   target\release\contura.exe
//
// Then:
//   node scripts/capture-screens.mjs --port 9222 --data-dir <folder> --setup --pg <db> --mysql <db> --image <png|jpg> --out <dir>
//   node scripts/capture-screens.mjs --port 9222 --out <dir> --theme dark
//   node scripts/capture-screens.mjs --port 9222 --out <dir> --theme light
//   node scripts/capture-screens.mjs --port 9222 --data-dir <folder> --cleanup --out <dir>
//
// --setup captures the Home empty state in both themes, then creates the
// sample Groups (through the Group form, with the image), Connections (through
// the app's commands, so passwords go to Credential Manager), the Saved Query
// and three runs for History. --cleanup deletes every Connection (and its
// Credential Manager entry), Saved Query and Group through the app's commands
// and, with --out, captures the Home empty state again in both themes.
// --setup and --cleanup change data, so they need --data-dir <folder> (the
// CONTURA_DATA_DIR the exe was started with). They first ask the app for its
// data folder and refuse, changing nothing, unless it is that folder: the
// everyday app, left on a debug port, is never written to or emptied.
// --ai-setup / --ai-cleanup do the same for the AI scenes (see "AI scenes" below): SQLite files in
// a fresh "ai" folder beside the data folder, four Connections, and the provider set to the
// loopback fixture server (scripts/ai-fixture-server.mjs, --fixture-port). --ai runs the AI scenes.
// --only <name,name> captures a subset. Shots are <screen>-<theme>.png.
// The run fails on any CDP error and on any Content Security Policy report.

import { copyFileSync, mkdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 9222);
const OUT = args.out ? resolve(args.out) : null;
let THEME = args.theme ?? "dark";
const ONLY = args.only ? new Set(String(args.only).split(",")) : null;
const PASSWORD = "dbview_test";

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (!list[i].startsWith("--")) continue;
    const key = list[i].slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else out[key] = list[++i];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP

const problems = []; // CSP reports, exceptions, CDP errors
let cdp;

async function attach() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error(`no page target on port ${PORT}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiting = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, fail, method } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) {
        problems.push(`CDP ${method}: ${msg.error.message}`);
        fail(new Error(`${method}: ${msg.error.message}`));
      } else ok(msg.result);
      return;
    }
    onEvent(msg);
  });
  await new Promise((ok, fail) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", fail, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const n = ++id;
      waiting.set(n, { ok, fail, method });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  cdp = { send, close: () => ws.close() };
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("DOM.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
}

function onEvent(msg) {
  const text = (() => {
    if (msg.method === "Runtime.consoleAPICalled") return msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (msg.method === "Log.entryAdded") return msg.params.entry.text;
    if (msg.method === "Runtime.exceptionThrown") return `exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`;
    return null;
  })();
  if (!text) return;
  if (/Content Security Policy|Refused to (load|apply|execute|connect)/i.test(text)) problems.push(`CSP: ${text}`);
  else if (msg.method === "Runtime.exceptionThrown") problems.push(text);
}

async function ev(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression.slice(0, 200)}`);
  return r.result.value;
}

const invoke = (cmd, payload = {}) => ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(payload)})`);

async function waitFor(expression, what, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await ev(`(() => { try { return !!(${expression}); } catch { return false; } })()`)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what ?? expression}`);
}

// Finds a visible element. spec: { sel, text, label, within, exact, last }
const FIND = `(spec) => {
  const root = spec.within ? [...document.querySelectorAll(spec.within)].filter((e) => e.getClientRects().length).pop() : document;
  if (!root) return null;
  const pool = root.querySelectorAll(spec.sel ?? 'button,[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=treeitem],[role=option],[role=radio],[role=switch],[role=button],a,input,textarea');
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const hits = [...pool].filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    if (spec.label !== undefined) {
      const l = norm(el.getAttribute('aria-label'));
      if (spec.exact === false ? !l.startsWith(spec.label) : l !== spec.label) return false;
    }
    if (spec.text !== undefined) {
      const t = norm(el.innerText);
      if (spec.exact ? t !== spec.text : !t.startsWith(spec.text)) return false;
    }
    return true;
  });
  return (spec.last ? hits.pop() : hits[0]) ?? null;
}`;

async function box(spec, timeout = 10000) {
  const end = Date.now() + timeout;
  while (true) {
    const r = await ev(`(() => { const el = (${FIND})(${JSON.stringify(spec)}); if (!el) return null;
      let b = el.getBoundingClientRect();
      if (b.top < 0 || b.bottom > innerHeight || el.getAttribute('role') === 'treeitem') { el.scrollIntoView({ block: 'nearest' }); b = el.getBoundingClientRect(); }
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; })()`);
    if (r) return r;
    if (Date.now() > end) throw new Error(`not found: ${JSON.stringify(spec)}`);
    await sleep(100);
  }
}

const exists = (spec) => ev(`!!(${FIND})(${JSON.stringify(spec)})`);

async function click(spec, { count = 1, right = false, at } = {}) {
  const b = at ?? (await box(spec));
  const button = right ? "right" : "left";
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y, button: "none", buttons: 0 });
  for (let i = 1; i <= count; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button, buttons: right ? 2 : 1, clickCount: i });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button, buttons: 0, clickCount: i });
  }
  await sleep(150);
}

async function hover(spec) {
  const b = await box(spec);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y, button: "none", buttons: 0 });
  await sleep(150);
}

async function moveAway() {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1279, y: 799, button: "none", buttons: 0 });
}

const KEYS = {
  Enter: [13, "Enter", "\r"], Escape: [27, "Escape"], Tab: [9, "Tab"], Backspace: [8, "Backspace"],
  Delete: [46, "Delete"], ArrowDown: [40, "ArrowDown"], ArrowUp: [38, "ArrowUp"], ArrowLeft: [37, "ArrowLeft"],
  ArrowRight: [39, "ArrowRight"], Home: [36, "Home"], End: [35, "End"], F2: [113, "F2"], Space: [32, "Space", " "],
};

// press("Ctrl+Shift+Enter"), press("Escape"), press("Ctrl+a")
async function press(combo) {
  const parts = combo.split("+");
  const keyName = parts.pop();
  let modifiers = 0;
  for (const m of parts) modifiers |= { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 }[m];
  let code, key, vk, text;
  if (KEYS[keyName]) {
    [vk, code, text] = KEYS[keyName];
    key = keyName === "Space" ? " " : keyName;
  } else {
    const ch = keyName.length === 1 ? keyName : keyName;
    const upper = ch.toUpperCase();
    vk = /[0-9]/.test(ch) ? ch.charCodeAt(0) : upper.charCodeAt(0);
    code = /[0-9]/.test(ch) ? `Digit${ch}` : `Key${upper}`;
    key = modifiers & 8 ? upper : ch.toLowerCase();
    text = modifiers & ~8 ? undefined : key;
  }
  const base = { modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(120);
}

async function type(text) {
  await cdp.send("Input.insertText", { text });
  await sleep(80);
}

// Replaces the value of a text field by clicking it, selecting all and typing.
async function fill(spec, text) {
  await click(spec);
  await press("Ctrl+a");
  await press("Backspace");
  if (text) await type(text);
}

async function setFile(selector, path) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`no file input ${selector}`);
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [path] });
}

let shotCount = 0;
async function shot(name) {
  if (!OUT) return;
  await sleep(350);
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}-${THEME}.png`), Buffer.from(r.data, "base64"));
  shotCount++;
  console.log(`  ${name}-${THEME}.png`);
}

// Closes menus, dialogs and popovers.
async function escapeAll(times = 3) {
  for (let i = 0; i < times; i++) await press("Escape");
}

// Puts the editor's text in place through CodeMirror's own view.
async function setEditor(text, within = ".work-pane:not([hidden]) .query-tab, .work-pane:not([hidden])") {
  await ev(`(() => {
    const host = [...document.querySelectorAll('.cm-editor')].filter((e) => e.getClientRects().length && !e.closest('[role=dialog]'))[0];
    const content = host?.querySelector('.cm-content');
    const view = content?.cmTile?.view ?? content?.cmView?.view;
    if (!view) throw new Error('no editor view');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(text)} } });
    view.focus();
    return true;
  })()`);
  await sleep(150);
}

// Moves the text position to a line and column (1-based) in the visible editor.
async function editorGoTo(line, col = 1) {
  await ev(`(() => {
    const host = [...document.querySelectorAll('.cm-editor')].filter((e) => e.getClientRects().length && !e.closest('[role=dialog]'))[0];
    const content = host.querySelector('.cm-content');
    const view = content.cmTile?.view ?? content.cmView?.view;
    const l = view.state.doc.line(${line});
    view.dispatch({ selection: { anchor: Math.min(l.from + ${col} - 1, l.to) } });
    view.focus();
    return true;
  })()`);
  await sleep(150);
}

// ---------------------------------------------------------------- app steps

async function appReady() {
  await waitFor(`document.querySelector('.app-status, footer') && !document.querySelector('.launch[role=status]')`, "the app shell", 30000);
  await sleep(500);
}

async function reload() {
  await ev("location.reload(), true");
  await sleep(1500);
  await appReady();
}

// Picks the theme from the status bar's Theme menu with real mouse clicks.
// (The first parity check found the menu clipped by the status bar; the click
// now has to land on the item, or the theme check below fails.)
async function setTheme(theme) {
  await escapeAll(1);
  await click({ label: "Theme" });
  const label = theme === "dark" ? "Dracula" : "Alucard";
  await click({ sel: "[role=menuitem]", text: label, exact: true });
  await moveAway();
  await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, `theme ${theme} (Theme menu clicked)`, 3000);
  await sleep(300);
}

async function openSwitcher() {
  await click({ label: "Switch Group", exact: false });
}

async function goGroup(name) {
  await openSwitcher();
  await click({ sel: "[role=menuitem]", text: name });
  await sleep(600);
}

async function goHome() {
  await openSwitcher();
  await click({ sel: "[role=menuitem]", text: "Home" });
  await sleep(500);
}

async function newGroup(name, colour, image) {
  await openSwitcher();
  await click({ sel: "[role=menuitem]", text: "New Group" });
  await waitFor(`document.querySelector('[role=dialog]')`, "Group form");
  await fill({ sel: "[role=dialog] input.input" }, name);
  await click({ sel: `[role=dialog] [data-colour=${colour}]` });
  if (image) {
    await setFile('[role=dialog] input[type=file]', image);
    await waitFor(`document.querySelector('[role=dialog] .swatch-image-on img, [role=dialog] .swatch-image-on')`, "the image preview");
    await sleep(500);
  }
}

async function setup() {
  const pg = args.pg, mysql = args.mysql;
  if (!pg || !mysql) throw new Error("--setup needs --pg <database> and --mysql <database>");
  await appReady();
  if ((await invoke("list_connections")).length === 0) {
    for (const t of ["dark", "light"]) {
      THEME = t;
      await setTheme(t);
      await shot("home-empty");
    }
  }
  THEME = "dark";
  await setTheme("dark");

  // Each step is skipped when its result already exists, so a broken run can be resumed.
  const have = (await invoke("list_groups")).map((g) => g.name);
  for (const [name, colour, image] of [
    ["Orbit Freight", "indigo", args.image ? resolve(args.image) : null],
    ["Kestrel Foods", "teal", null],
  ]) {
    if (have.includes(name)) continue;
    await newGroup(name, colour, image);
    await click({ sel: "[role=dialog] button", text: "Create Group" });
    await waitFor(`!document.querySelector('[role=dialog]')`, "Group form to close");
  }

  const groups = await invoke("list_groups");
  const haveConn = (await invoke("list_connections")).map((c) => c.name);
  const orbit = groups.find((g) => g.name === "Orbit Freight");
  const kestrel = groups.find((g) => g.name === "Kestrel Foods");
  const conn = async (name, dialect, groupId, database, extra = {}) =>
    haveConn.includes(name) ? null : invoke("save_connection", {
      input: {
        id: null, name, dialect, host: "127.0.0.1", port: dialect === "mysql" ? 3306 : 5432, user: "dbview_test",
        database, ssl: { mode: "disable" }, file: null, password: { t: "set", value: PASSWORD }, groupId,
        queryTimeoutSecs: null, aiAccess: "schema", production: false, readOnly: false, ...extra,
      },
    });
  await conn("shop-staging", "postgres", orbit.id, pg);
  await conn("freight-prod", "postgres", orbit.id, pg, { production: true, aiAccess: "never" });
  await conn("freight-reporting", "postgres", orbit.id, pg, { readOnly: true });
  await conn("kestrel-pos", "mysql", kestrel.id, mysql);
  await reload();

  // Saved Query and three runs for History, on shop-staging.
  await goGroup("Orbit Freight");
  await openConnection("shop-staging");
  await newQuery();
  await setEditor(LATE_SQL);
  if (!(await invoke("list_saved_queries")).some((q) => q.name === "late shipments by carrier")) {
    await saveQueryAs("late shipments by carrier");
  }
  await runAll();
  await setEditor("SELECT * FROM shipment;");
  await runAll();
  await setEditor("SELECT status, count(*) AS orders FROM orders GROUP BY status ORDER BY 2 DESC;");
  await runAll();
  console.log("setup done");
}

async function saveQueryAs(name) {
  await press("Ctrl+s");
  await waitFor(`document.querySelector('[role=dialog]')`, "Save query dialog");
  await fill({ sel: "[role=dialog] input.input" }, name);
  await click({ sel: "[role=dialog] button", text: "Save" });
  await waitFor(`!document.querySelector('[role=dialog]')`, "Save query dialog to close");
}

const LATE_SQL = `-- Late parcels per carrier, last 7 days
SELECT carrier,
       count(*) AS parcels,
       count(*) FILTER (WHERE delivered_at > promised_at) AS late,
       round(100.0 * avg((delivered_at > promised_at)::int), 1) AS late_share
FROM shipments
WHERE picked_up_at >= TIMESTAMP '2026-10-01'
GROUP BY carrier
ORDER BY late DESC;`;

async function openConnection(name) {
  const row = { sel: "[role=treeitem]", label: name, exact: false };
  if (await exists({ sel: "[role=treeitem]", label: `${name}, open`, exact: false })) return;
  await click(row, { count: 2 });
  await ev("getSelection().removeAllRanges(), true");
  await waitFor(`[...document.querySelectorAll('[role=treeitem]')].some((e) => (e.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(name + ", open")}))`, `${name} open`, 20000);
  await sleep(500);
}

async function newQuery() {
  await press("Ctrl+t");
  await waitFor(`[...document.querySelectorAll('.cm-editor')].some((e) => e.getClientRects().length)`, "a query editor");
  await sleep(300);
}

async function runAll() {
  await press("Ctrl+Shift+Enter");
  await waitFor(`!document.querySelector('.results [aria-busy=true], .result-running')`, "the run", 20000);
  await sleep(800);
}

// ---------------------------------------------------------------- screens

const PROD_SQL = `-- Overdue invoices for the October reminder run
SELECT count(*) FROM invoices WHERE status = 'open' AND amount >= 100;

SELECT i.id,
       c.name AS customer,
       i.issued_at,
       i.amount,
       i.status
FROM invoices i
JOIN orders o ON o.id = i.order_id
JOIN customers c ON c.id = o.customer_id
WHERE i.status IN ('open', 'void')
  AND i.amount <= 100
ORDER BY i.id
LIMIT 200;`;

const ERROR_SQL = `-- Carrier wait times this week
SELECT carrier, count(*) AS parcels
FROM shipments
WHERE picked_up_at >= TIMESTAMP '2026-10-01'
GROUP BY carrier;

SELECT s.carrier, avg(e.created_at - s.picked_up_at) AS avg_wait
FROM shipment s
JOIN shipment_events e ON e.shipment_id = s.id
GROUP BY s.carrier;

SELECT count(*) FROM shipments WHERE status <> 'delivered';`;

const CONFIRM_SQL = `UPDATE invoices SET status = 'paid' WHERE id = 1042;
SELECT count(*) FROM invoices WHERE status = 'open';
DELETE FROM payments WHERE invoice_id = 1042;`;

const EXPLAIN_SQL = `SELECT o.id, c.name, o.total
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.total > 50
ORDER BY o.total DESC;`;

const settle = async () => {
  await moveAway();
  await ev("getSelection().removeAllRanges(), true");
};

const visibleDialog = () => exists({ sel: "[role=dialog]" });

// Closes every tab in the current place, discarding unsaved text and edits.
async function closeAllTabs() {
  for (let i = 0; i < 80; i++) {
    if (await visibleDialog()) {
      if (await exists({ sel: "[role=dialog] button", text: "Discard" })) await click({ sel: "[role=dialog] button", text: "Discard" });
      else if (await exists({ sel: "[role=dialog] button", text: "Don't save" })) await click({ sel: "[role=dialog] button", text: "Don't save" });
      else await press("Escape");
      await sleep(300);
      continue;
    }
    // A full tab strip scrolls, so the close buttons are clicked through the DOM.
    const left = await ev(`(() => { const b = [...document.querySelectorAll('.work-tab-close')]; if (!b.length) return 0; b[b.length - 1].click(); return b.length; })()`);
    if (!left) return;
    await sleep(250);
  }
}

async function rowMenu(name) {
  const b = await box({ sel: "[role=treeitem]", label: name, exact: false });
  await click(null, { right: true, at: b });
  await waitFor(`document.querySelector('[role=menu]')`, "row menu");
}

async function menuPick(text) {
  await click({ sel: "[role=menuitem],[role=menuitemcheckbox]", text });
  await sleep(300);
}

async function closeConnection(name) {
  if (!(await exists({ sel: "[role=treeitem]", label: `${name}, open`, exact: false }))) return;
  await rowMenu(name);
  await menuPick("Close Connection");
  await sleep(600);
}

// Expands tree rows by label, in order (database, schema, Tables...).
async function expand(...labels) {
  for (const l of labels) {
    const spec = { sel: "[role=treeitem]", label: l, exact: false };
    const open = await ev(`(${FIND})(${JSON.stringify(spec)})?.getAttribute('aria-expanded') ?? null`);
    if (open === "false") {
      await click(spec);
      await sleep(500);
    }
  }
}

// Collapses every other Connection branch so labels below are unique.
async function onlyBranch(connection) {
  for (let i = 0; i < 6; i++) {
    const other = await ev(`(() => { const r = [...document.querySelectorAll('[role=treeitem][aria-level="1"][aria-expanded=true]')]
      .find((e) => !(e.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(connection + ",")}) && (e.getAttribute('aria-label') ?? '') !== 'Saved Queries');
      return r ? r.getAttribute('aria-label') : null; })()`);
    if (!other) break;
    await click({ sel: "[role=treeitem]", label: other });
    await sleep(300);
  }
  await expand(`${connection},`);
}

async function openTable(connection, table) {
  await openConnection(connection);
  await onlyBranch(connection);
  await expand(args.pg ?? "dbview_test_", "public", "Tables");
  await click({ sel: "[role=treeitem]", label: table, exact: false });
  await waitFor(`[...document.querySelectorAll('tr[data-row]')].some((e) => e.getClientRects().length)`, `${table} rows`, 20000);
  await sleep(600);
}

async function cell(row, col) {
  return box({ sel: `tr[data-row="${row}"] td:nth-child(${col + 1})` });
}

async function queryTabOn(connection, sql) {
  await openConnection(connection);
  await onlyBranch(connection);
  const before = await ev(`document.querySelectorAll('.work-tab').length`);
  await rowMenu(connection);
  await menuPick("New query");
  await waitFor(`document.querySelectorAll('.work-tab').length > ${before}`, `a new query tab on ${connection}`);
  await waitFor(`[...document.querySelectorAll('.cm-editor')].some((e) => e.getClientRects().length)`, "a query editor");
  await sleep(400);
  if (sql) await setEditor(sql);
}

const SCREENS = [
  ["home", async () => {
    await goHome();
    await settle();
    await shot("home");
  }],
  ["menu-switcher", async () => {
    await goGroup("Orbit Freight");
    await openSwitcher();
    await hover({ sel: "[role=menuitem]", text: "Orbit Freight" });
    await shot("menu-switcher");
    await escapeAll(1);
  }],
  ["empty-workspace", async () => {
    await goGroup("Orbit Freight");
    await closeAllTabs();
    await closeConnection("shop-staging");
    await closeConnection("freight-prod");
    await closeConnection("freight-reporting");
    await settle();
    await shot("empty-workspace-closed");
    await openConnection("shop-staging");
    await settle();
    await shot("empty-workspace");
  }],
  ["menu-row", async () => {
    await rowMenu("freight-prod");
    await hover({ sel: "[role=menuitem]", text: "Move to Group" });
    await sleep(300);
    await shot("menu-row");
    await escapeAll(2);
  }],
  ["query-prod", async () => {
    await queryTabOn("freight-prod", PROD_SQL);
    await press("Ctrl+Shift+Enter");
    await sleep(1500);
    await editorGoTo(13, 9);
    await settle();
    await shot("query-prod");
  }],
  ["run-confirm", async () => {
    await setEditor(CONFIRM_SQL);
    await press("Ctrl+Shift+Enter");
    await waitFor(`document.querySelector('[role=dialog]')`, "Run confirmation");
    await settle();
    await shot("run-confirm");
    await press("Escape");
    await sleep(300);
  }],
  ["query-error", async () => {
    await queryTabOn("shop-staging", ERROR_SQL);
    await press("Ctrl+Shift+Enter");
    await sleep(1500);
    await editorGoTo(8, 6);
    await settle();
    await shot("query-error");
  }],
  ["plan", async () => {
    await setEditor(EXPLAIN_SQL);
    await click({ sel: "button", text: "Explain" });
    await sleep(1500);
    await settle();
    await shot("plan");
  }],
  ["history", async () => {
    await click({ sel: "[role=tab]", label: "Query 1, Production", exact: false }).catch(() => {});
    await setEditor(`UPDATE orders
   SET status = 'shipped'
 WHERE id IN (SELECT order_id FROM shipments WHERE status = 'in_transit');`);
    await editorGoTo(2, 4);
    // A real click: the History button must be inside the window even with
    // "Run on PROD" and a long database name (E2).
    const hb = await box({ label: "Query History" });
    if (hb.x > 1280 || hb.x < 0) throw new Error(`History button is off-screen at x ${Math.round(hb.x)}`);
    await click(null, { at: hb });
    await sleep(800);
    await click({ sel: ".history-row", text: "UPDATE" }).catch(() => click({ sel: ".history-row" }));
    await sleep(500);
    await settle();
    await shot("history");
    await click({ label: "Close Query History" });
  }],
  ["ai-panel", async () => {
    // No provider is set up, so the answer comes from a stored thread (the panel's History).
    const orbit = (await invoke("list_groups")).find((g) => g.name === "Orbit Freight");
    const now = Date.now();
    await invoke("save_ai_thread", {
      thread: {
        id: "00000000-0000-4000-8000-0000000000a1", place: `group:${orbit.id}`, title: "Late parcels per carrier", updatedAt: now,
        messages: [
          { role: "user", text: "Which carriers delivered late this month, and how often?", context: [], at: now - 60000 },
          {
            role: "assistant", at: now - 55000, context: [],
            text: "No join is needed: shipments has both times. Count the rows where delivered_at is after promised_at, per carrier.\n\n```sql\nSELECT carrier,\n       count(*) AS parcels,\n       count(*) FILTER (WHERE delivered_at > promised_at) AS late\nFROM shipments\nGROUP BY carrier\nORDER BY late DESC;\n```",
          },
        ],
      },
    });
    await queryTabOn("shop-staging", LATE_SQL);
    await click({ sel: "button", text: "AI:" });
    await sleep(800);
    await click({ sel: ".ai-panel button", label: "History" });
    await menuPick("Late parcels per carrier");
    await sleep(500);
    await settle();
    await shot("ai-panel");
    await click({ sel: ".ai-panel button", label: "Close" });
  }],
  ["save-query", async () => {
    await setEditor("SELECT carrier, count(*) FROM shipments GROUP BY carrier;");
    await press("Ctrl+s");
    await waitFor(`document.querySelector('[role=dialog]')`, "Save query dialog");
    await fill({ sel: "[role=dialog] input.input" }, "parcels per carrier");
    await click({ sel: "[role=dialog] button", text: "shop-staging" });
    await sleep(300);
    await settle();
    await shot("save-query");
    await escapeAll(2);
  }],
  ["unsaved-changes", async () => {
    await escapeAll(2);
    await expand("Saved Queries");
    await click({ sel: "[role=treeitem]", label: "late shipments by carrier", exact: false });
    await sleep(800);
    await setEditor(`${LATE_SQL}
-- checked with the carriers`);
    await press("Ctrl+w");
    await waitFor(`document.querySelector('[role=dialog]')`, "Unsaved changes");
    await settle();
    await shot("unsaved-changes");
    await click({ sel: "[role=dialog] button", text: "Discard" });
  }],
  ["toast-success", async () => {
    await expand("Saved Queries");
    await click({ sel: "[role=treeitem]", label: "late shipments by carrier", exact: false });
    await sleep(800);
    await setEditor(LATE_SQL);
    await press("Ctrl+s");
    await sleep(700);
    await settle();
    await shot("toast-success");
  }],
  ["readonly-editor", async () => {
    await queryTabOn("freight-reporting", "UPDATE orders SET status = 'paid' WHERE id = 7;");
    await press("Ctrl+Enter");
    await sleep(600);
    await settle();
    await shot("readonly-editor");
  }],
  ["readonly-table", async () => {
    await openTable("freight-reporting", "orders");
    const c = await cell(1, 3);
    await click(null, { at: c, count: 2 });
    await sleep(500);
    await settle();
    await shot("readonly-table");
  }],
  ["table-edits", async () => {
    await openTable("shop-staging", "orders");
    let c = await cell(4, 3);
    await click(null, { at: c, count: 2 });
    await press("Ctrl+a");
    await type("cancelled");
    await press("Enter");
    await sleep(300);
    c = await cell(7, 1);
    await click(null, { at: c });
    await click({ label: "Delete row" });
    await click({ label: "Add row" });
    await sleep(500);
    c = await cell(4, 3);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y, button: "none", buttons: 0 });
    await sleep(1200);
    await ev("getSelection().removeAllRanges(), true");
    await shot("table-edits");
    // The new row sits at the bottom of the loaded rows.
    await ev(`(() => { const g = [...document.querySelectorAll('.grid-scroll')].find((e) => e.getClientRects().length); g.scrollTop = g.scrollHeight; return true; })()`);
    await sleep(600);
    await settle();
    await shot("table-new-row");
    await ev(`(() => { const g = [...document.querySelectorAll('.grid-scroll')].find((e) => e.getClientRects().length); g.scrollTop = 0; return true; })()`);
    await sleep(300);
  }],
  ["preview-sql", async () => {
    await click({ sel: "button", text: "Preview SQL" });
    await sleep(800);
    await settle();
    await shot("preview-sql");
    await click({ label: "Close SQL preview" });
  }],
  ["unsaved-table", async () => {
    await press("Ctrl+w");
    await waitFor(`document.querySelector('[role=dialog]')`, "Unsaved changes");
    await settle();
    await shot("unsaved-table");
    await click({ sel: "[role=dialog] button", text: "Discard" });
  }],
  ["table-prod", async () => {
    await openTable("freight-prod", "orders");
    const c = await cell(2, 3);
    await click(null, { at: c, count: 2 });
    await press("Ctrl+a");
    await type("shipped");
    await press("Enter");
    await settle();
    await shot("table-prod");
    await click({ label: "Save on Production" });
    await waitFor(`document.querySelector('[role=dialog]')`, "Save on PROD confirmation");
    await settle();
    await shot("table-save-prod");
    await press("Escape");
    await sleep(300);
    await click({ sel: "button", text: "Discard" });
  }],
  ["connection-form", async () => {
    await rowMenu("freight-prod");
    await menuPick("Edit Connection");
    await waitFor(`document.querySelector('[role=dialog]')`, "Connection form");
    await settle();
    await shot("connection-form");
    // The AI access list near the bottom: it must open over the dialog, not be cut by its body.
    await click({ sel: "[role=dialog] [role=combobox]", text: "Never send anything" });
    await sleep(300);
    await settle();
    await shot("connection-form-select");
    await press("Escape");
    await sleep(200);
    await press("Escape");
    await sleep(300);
  }],
  ["group-form", async () => {
    await click({ sel: "aside.side button", label: "Edit Orbit Freight" });
    await waitFor(`document.querySelector('[role=dialog]')`, "Group form");
    await settle();
    await shot("group-form");
    await click({ sel: "[role=dialog] button", text: "Delete Group" });
    await sleep(400);
    await settle();
    await shot("group-delete");
    await press("Escape");
    await sleep(300);
    await press("Escape");
    await sleep(300);
    await openSwitcher();
    await click({ sel: "[role=menuitem]", text: "New Group" });
    await waitFor(`document.querySelector('[role=dialog]')`, "Group form");
    await fill({ sel: "[role=dialog] input.input" }, "Pinecone Labs");
    await click({ sel: "[role=dialog] [data-colour=green]" });
    await settle();
    await shot("group-form-new");
    await press("Escape");
    await sleep(300);
  }],
  ["saved-queries", async () => {
    await expand("Saved Queries");
    await settle();
    await shot("saved-queries-tree");
    await hover({ sel: "[role=treeitem]", label: "Saved Queries", exact: false });
    await click({ label: "Open the Saved Queries list" });
    await sleep(800);
    await settle();
    await shot("saved-queries-list");
  }],
  ["new-schema-model", async () => {
    await openConnection("shop-staging");
    await rowMenu("shop-staging");
    await menuPick("New Schema Model");
    await waitFor(`document.querySelector('[role=dialog]')`, "New Schema Model");
    await sleep(800);
    await settle();
    await shot("new-schema-model");
  }],
  ["schema-builder", async () => {
    await click({ sel: "[role=dialog] button", text: "Read the database" });
    await waitFor(`document.querySelector('.react-flow__node')`, "the Schema Model canvas", 20000);
    await sleep(1500);
    await click({ sel: ".react-flow__node", text: "orders" });
    await sleep(500);
    await settle();
    await shot("schema-builder");
  }],
  ["settings", async () => {
    await openSwitcher();
    await menuPick("Settings");
    await sleep(800);
    await ev("document.querySelectorAll('.settings-scroll').forEach((e) => { e.scrollTop = 0; }), true");
    await sleep(200);
    await settle();
    await shot("settings");
    await click({ text: "About Contura" });
    await sleep(600);
    await settle();
    await shot("settings-about");
  }],
  ["closed-connection", async () => {
    await goGroup("Orbit Freight");
    await closeAllTabs();
    await openConnection("shop-staging");
    await expand("Saved Queries");
    await click({ sel: "[role=treeitem]", label: "late shipments by carrier", exact: false });
    await sleep(800);
    await closeConnection("shop-staging");
    await settle();
    await shot("closed-connection");
  }],
  ["open-failed", async () => {
    const groups = await invoke("list_groups");
    const orbit = groups.find((g) => g.name === "Orbit Freight");
    const made = await invoke("save_connection", {
      input: {
        id: null, name: "freight-archive", dialect: "postgres", host: "10.255.255.1", port: 5432, user: "dbview_test",
        database: null, ssl: { mode: "disable" }, file: null, password: { t: "clear" }, groupId: orbit.id,
        queryTimeoutSecs: null, aiAccess: "never", production: false, readOnly: false,
      },
    });
    try {
      await reload();
      await goGroup("Orbit Freight");
      await closeAllTabs();
      // A query tab on the closed Connection, then Open from its panel (frames 10b and 10c).
      await rowMenu("freight-archive");
      await menuPick("New query");
      await waitFor(`document.querySelector('[aria-label="Connection state"]')`, "the closed Connection panel");
      await setEditor("SELECT carrier, count(*) FROM shipments GROUP BY carrier;");
      await click({ sel: '[aria-label="Connection state"] button', text: "Open freight-archive" });
      await sleep(1500);
      await settle();
      await shot("connecting");
      await waitFor(`document.querySelector('[aria-label="Connection state"]')?.innerText.includes('Could not open')`, "the open to fail", 60000);
      await sleep(500);
      await settle();
      await shot("open-failed");
    } finally {
      await invoke("delete_connection", { id: made.id });
    }
  }],
  ["launch", async () => {
    // Start-up reads finish in well under 300 ms here, so for this one reload the
    // page's IPC fetch is slowed: list_groups answers 2.6 s late, which shows the line
    // and then the detail.
    const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { const f = window.fetch.bind(window);
        window.fetch = (input, init) => String(input?.url ?? input).includes('list_groups')
          ? new Promise((r) => setTimeout(r, 2600)).then(() => f(input, init)) : f(input, init); })();`,
    });
    await ev("location.reload(), true");
    let line = false, detail = false, started = false;
    for (let i = 0; i < 200 && !detail; i++) {
      await sleep(50);
      let state = null;
      try {
        state = await ev(`document.querySelector('.launch-detail') ? 'detail' : document.querySelector('.launch-box') ? 'line' : document.querySelector('.launch') ? 'blank' : 'gone'`);
      } catch {
        /* the page is reloading */
      }
      if (state === "line" && !line) {
        line = true;
        await shot("launch");
      } else if (state === "detail") {
        detail = true;
        await shot("launch-long");
      } else if (state === "blank") started = true;
      else if (state === "gone" && (started || line)) break;
    }
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    await appReady();
    if (!line) console.log("  launch line did not appear (loading under 300ms)");
    if (!detail) console.log("  launch detail did not appear (loading under 2s)");
  }],
];

// Screens that carry on from the one before (a dialog or tab it left open).
const CONTINUES = new Set(["menu-row", "run-confirm", "plan", "history", "save-query", "preview-sql", "unsaved-table", "schema-builder"]);
// Screens that start in Orbit Freight; FRESH ones also close every tab first.
const IN_GROUP = new Set(["query-prod", "query-error", "ai-panel", "unsaved-changes", "toast-success", "readonly-editor", "readonly-table",
  "table-edits", "table-prod", "connection-form", "group-form", "saved-queries", "new-schema-model"]);
// AI scenes open their own place; the ones that read the screen before them carry on.
const AI_CONTINUES = new Set(["ai-steps", "ai-diagram", "ai-settings-privacy", "ai-settings-access", "ai-settings-tools", "diagram-ai-panel", "diagram-ai-review", "diagram-ai-autoapply"]);
const FRESH = new Set(["query-prod", "readonly-editor", "table-edits", "saved-queries"]);

// Closes the Query History and Ask panels and any open menu or dialog.
async function closePanels() {
  await escapeAll(2);
  if (await exists({ label: "Close Query History" })) await click({ label: "Close Query History" });
  if (await exists({ sel: ".ai-panel button", label: "Close" })) await click({ sel: ".ai-panel button", label: "Close" });
  await ev("document.querySelectorAll('main.work').forEach((m) => { m.scrollLeft = 0; }), true");
}

async function captureAll() {
  await appReady();
  await setTheme(THEME);
  const list = args.ai ? SCENES : ONLY ? [...SCREENS, ...SCENES] : SCREENS;
  for (const [name, run] of list) {
    if (ONLY && !ONLY.has(name)) continue;
    try {
      if (!CONTINUES.has(name) && !AI_CONTINUES.has(name)) await closePanels();
      if (IN_GROUP.has(name)) await goGroup("Orbit Freight");
      if (FRESH.has(name)) await closeAllTabs();
      await run();
    } catch (e) {
      problems.push(`screen ${name}: ${e.message.split("\n")[0]}`);
      console.log(`  FAILED ${name}: ${e.message.split("\n")[0]}`);
      await escapeAll(3).catch(() => {});
    }
  }
}

async function cleanup() {
  await appReady();
  for (const g of ["Orbit Freight", "Kestrel Foods"]) {
    await goGroup(g).catch(() => {});
    await closeAllTabs().catch(() => {});
  }
  // Deleting through the app's commands removes each Connection's Credential Manager entry.
  for (const c of await invoke("list_connections")) await invoke("delete_connection", { id: c.id });
  for (const q of await invoke("list_saved_queries")) await invoke("delete_saved_query", { id: q.id });
  for (const g of await invoke("list_groups")) await invoke("delete_group", { id: g.id });
  console.log(`left: ${(await invoke("list_connections")).length} Connections, ${(await invoke("list_groups")).length} Groups`);
  if (OUT) {
    // With nothing left, Home shows its empty state: captured here in both themes.
    await reload();
    await goHome().catch(() => {});
    for (const t of ["dark", "light"]) {
      THEME = t;
      await setTheme(t);
      await settle();
      await shot("home-empty");
    }
    await setTheme("dark");
  }
}

// ---------------------------------------------------------------- AI scenes

// The AI scenes run against the loopback fixture provider (scripts/ai-fixture-server.mjs): the
// model id picks the answer or error, so no key is needed. Start it first:
//   node scripts/ai-fixture-server.mjs --port 8765
//   node scripts/capture-screens.mjs --port 9222 --data-dir <folder> --ai-setup --fixture-port 8765
//   node scripts/capture-screens.mjs --port 9222 --out <dir> --theme dark --ai
//   node scripts/capture-screens.mjs --port 9222 --data-dir <folder> --ai-cleanup
// --ai runs every AI scene; --only <scene,scene> runs named ones (AI or not).

const AI_NAMES = ["ai-shop", "ai-wide", "ai-prod", "ai-readonly"];
const FIXTURE_URL = () => `http://127.0.0.1:${args["fixture-port"] ?? 8765}/v1`;
// The folder for the SQLite files: beside the data folder, never inside it (the app refuses
// a new database in its own data folder).
const aiFolder = () => join(dirname(resolve(String(args["data-dir"]))), "ai");

const SHOP_TABLES = {
  orders: "id INTEGER PRIMARY KEY, customer_id INTEGER, total REAL, status TEXT",
  customers: "id INTEGER PRIMARY KEY, name TEXT, city TEXT",
  shipments: "id INTEGER PRIMARY KEY, order_id INTEGER, carrier TEXT, status TEXT",
  carriers: "id INTEGER PRIMARY KEY, name TEXT, country TEXT",
};
const CARRIERS = ["DHL", "UPS", "FedEx", "GLS"];
const WORDS = ["invoice", "payment", "refund", "ticket", "warehouse", "pallet", "route", "driver", "vehicle", "depot", "contract", "quote", "supplier", "return", "label", "manifest", "customs", "tariff", "address", "session"];

function shopSql() {
  const out = [];
  for (const [t, cols] of Object.entries(SHOP_TABLES)) {
    out.push(`CREATE TABLE ${t} (${cols});`);
    for (let i = 1; i <= 20; i++) {
      const v = {
        orders: `${i}, ${1 + (i % 20)}, ${10 + i * 3.5}, '${i % 3 ? "paid" : "open"}'`,
        customers: `${i}, 'Customer ${i}', 'City ${i % 5}'`,
        shipments: `${i}, ${i}, '${CARRIERS[i % 4]}', '${i % 2 ? "delivered" : "in transit"}'`,
        carriers: `${i}, 'Carrier ${i}', 'Country ${i % 6}'`,
      }[t];
      out.push(`INSERT INTO ${t} VALUES (${v});`);
    }
  }
  return out;
}

function wideSql() {
  const out = [];
  for (let i = 0; i < 2000; i++) {
    const name = `${WORDS[i % WORDS.length]}_${WORDS[(i * 7 + 3) % WORDS.length]}_${Math.floor(i / WORDS.length)}`;
    out.push(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, ref TEXT, created_at TEXT);`);
  }
  return out;
}

async function runScript(connectionId, statements) {
  const session = await invoke("open_query_session", { id: connectionId, database: null });
  try {
    for (let i = 0; i < statements.length; i += 100) {
      await invoke("execute_sql", { session, sql: statements.slice(i, i + 100).join("\n"), pass: null });
    }
  } finally {
    await invoke("close_query_session", { session }).catch(() => {});
  }
}

async function aiSetup() {
  const port = args["fixture-port"];
  if (!port) throw new Error("--ai-setup needs --fixture-port <n>");
  await appReady();
  const dir = aiFolder();
  mkdirSync(dir); // fresh: fails when a previous run's folder is still there
  const files = Object.fromEntries(AI_NAMES.filter((n) => n !== "ai-readonly").map((n) => [n, join(dir, `${n}.sqlite`)]));
  for (const n of ["ai-shop", "ai-wide"]) await invoke("create_sqlite_database", { path: files[n] });
  const conn = (name, file, extra = {}) =>
    invoke("save_connection", {
      input: {
        id: null, name, dialect: "sqlite", host: "", port: 0, user: "", database: "", ssl: { mode: "disable" }, file,
        password: { t: "none" }, groupId: null, queryTimeoutSecs: null, aiAccess: "schema", production: false, readOnly: false, ...extra,
      },
    });
  const shop = await conn("ai-shop", files["ai-shop"], { aiAccess: "schemaQuery" });
  await runScript(shop.id ?? shop, shopSql());
  const wide = await conn("ai-wide", files["ai-wide"]);
  await runScript(wide.id ?? wide, wideSql());
  copyFileSync(files["ai-shop"], files["ai-prod"]);
  await conn("ai-prod", files["ai-prod"], { production: true });
  await conn("ai-readonly", files["ai-shop"], { readOnly: true });
  const view = await invoke("ai_settings", { groupId: null });
  await invoke("save_ai_settings", {
    groupId: null, overrideGroup: false, key: { t: "keep" },
    settings: { ...view.settings, provider: "custom", preset: null, baseUrl: FIXTURE_URL(), model: "fx-answer", inlineAsk: true, errorAsk: true },
  });
  await reload();
  console.log("ai setup done");
}

async function aiCleanup() {
  await appReady();
  await closeAllTabs().catch(() => {});
  for (const c of await invoke("list_connections")) if (AI_NAMES.includes(c.name)) await invoke("delete_connection", { id: c.id });
  const view = await invoke("ai_settings", { groupId: null });
  await invoke("save_ai_settings", {
    groupId: null, overrideGroup: false, key: { t: "keep" },
    settings: { ...view.settings, provider: null, preset: null, baseUrl: "", model: "" },
  });
  // Only what setup made: the three files and their SQLite side files, then the folder if it is empty.
  for (const n of ["ai-shop", "ai-wide", "ai-prod"]) {
    for (const ext of ["sqlite", "sqlite-wal", "sqlite-shm", "sqlite-journal"]) rmSync(join(aiFolder(), `${n}.${ext}`), { force: true });
  }
  try {
    rmdirSync(aiFolder());
  } catch (e) {
    if (e.code === "ENOENT") {
      // Already gone.
    } else if (e.code === "ENOTEMPTY" || e.code === "EEXIST") console.log(`left ${aiFolder()}: it holds other files`);
    else throw e;
  }
  console.log("ai cleanup done");
}

// ---- scene helpers

async function useModel(id) {
  const view = await invoke("ai_settings", { groupId: null });
  await invoke("save_ai_settings", { groupId: null, overrideGroup: false, key: { t: "keep" }, settings: { ...view.settings, model: id } });
}

const panelOpen = () => exists({ sel: ".ai-panel", within: "body" });

async function openPanel(connection = "ai-shop", sql = "SELECT * FROM shipments;") {
  await goHome().catch(() => {});
  await queryTabOn(connection, sql);
  if (!(await panelOpen())) await press("Ctrl+Alt+i");
  await waitFor(`document.querySelector('.ai-panel')`, "the Ask panel");
  await sleep(500);
}

async function newChat() {
  if (await exists({ sel: ".ai-panel button", label: "New chat", exact: false })) await click({ sel: ".ai-panel button", label: "New chat", exact: false });
  await sleep(300);
}

async function askPanel(question) {
  await fill({ sel: ".ai-panel textarea", label: "Message" }, question);
  await click({ sel: ".ai-panel button", label: "Send" });
}

const answered = (timeout = 20000) =>
  waitFor(`!document.querySelector('.ai-panel [aria-label="Stop"]') && document.querySelector('.ai-panel')`, "the answer to finish", timeout);

// Ask on a model and shoot when the answer (or its error card) is in.
async function askOn(model, question, name, { wait = answered, connection } = {}) {
  await useModel(model);
  await openPanel(connection);
  await newChat();
  await askPanel(question);
  await wait();
  await settle();
  await shot(name);
}

const SCENE_QUESTION = "How many parcels does each carrier have?";

async function inlineAsk(model, text) {
  await useModel(model);
  await queryTabOn("ai-shop", "SELECT * FROM shipments\nWHERE status = 'delivered';");
  await press("Ctrl+a");
  await press("Ctrl+i");
  await waitFor(`document.querySelector('[role=dialog][aria-label="Ask AI"]')`, "the inline Ask");
  if (text) {
    await fill({ sel: "[role=dialog] textarea,[role=dialog] input", label: "Question" }, text);
    await press("Enter");
    await answered().catch(() => {});
    await waitFor(`!document.querySelector('[role=dialog][aria-label="Ask AI"] .button[aria-busy=true]')`, "inline answer", 20000).catch(() => {});
    await sleep(800);
  }
}

const diagramPanel = async (model) => {
  await useModel(model);
  await goHome().catch(() => {});
  await openConnection("ai-shop");
  await rowMenu("ai-shop");
  await menuPick("New Schema Model");
  await waitFor(`document.querySelector('[role=dialog]')`, "New Schema Model");
  await click({ sel: "[role=dialog] button", text: "Read the database" });
  await waitFor(`document.querySelector('.react-flow__node')`, "the diagram canvas", 20000);
  await sleep(800);
  await click({ sel: "button[role=tab]", text: "Assistant" });
  await sleep(500);
};

const askDiagram = async (question) => {
  await fill({ sel: "textarea", label: "Message" }, question);
  await click({ sel: "button", label: "Send" });
  await answered(30000).catch(() => {});
  await sleep(600);
};

// ---- scenes

const ERROR_SCENES = [
  ["ai-err-rate-limit", "fx-429"], ["ai-err-bad-key", "fx-401"], ["ai-err-model-retired", "fx-404"], ["ai-err-server", "fx-500"],
  ["ai-err-cut-off", "fx-cut"], ["ai-err-length", "fx-length"], ["ai-err-declined", "fx-refusal"],
];

const SCENES = [
  // 11.1
  ["ai-panel-empty", async () => {
    await useModel("fx-answer");
    await openPanel();
    await newChat();
    await settle();
    await shot("ai-panel-empty");
  }],
  ["ai-panel-answering", async () => {
    await askOn("fx-long", SCENE_QUESTION, "ai-panel-answering", { wait: () => sleep(4000) });
    await click({ sel: ".ai-panel button", label: "Stop" });
    await sleep(500);
  }],
  ["ai-panel-answer", () => askOn("fx-answer", SCENE_QUESTION, "ai-panel-answer")],
  ["ai-panel-sends", async () => {
    await useModel("fx-answer");
    await openPanel();
    await fill({ sel: ".ai-panel textarea", label: "Message" }, SCENE_QUESTION);
    await sleep(600);
    await settle();
    await shot("ai-panel-sends");
  }],
  ["ai-model-picker", async () => {
    await useModel("fx-answer");
    await openPanel();
    await click({ sel: ".ai-panel button", label: "Model:", exact: false });
    await waitFor(`document.querySelector('[role=dialog][aria-label="Model"]')`, "the model picker");
    await settle();
    await shot("ai-model-picker");
    await escapeAll(2);
  }],
  ["ai-panel-history", async () => {
    await askOn("fx-answer", SCENE_QUESTION, "ai-panel-answer-for-history");
    await click({ sel: ".ai-panel button", label: "Show history" });
    await waitFor(`document.querySelector('[role=dialog][aria-label="Chat history"]')`, "chat history");
    await settle();
    await shot("ai-panel-history");
    await escapeAll(2);
  }],
  ["ai-panel-topics", async () => {
    await useModel("fx-answer");
    await openPanel();
    await newChat();
    await askPanel("How many parcels does each carrier have in shipments?");
    await answered();
    await askPanel("What is the average total in orders, per status?");
    await answered();
    await settle();
    await shot("ai-panel-topics");
  }],
  // 11.2
  ["ai-inline-answer", async () => {
    await inlineAsk("fx-answer", "Group this by carrier");
    await settle();
    await shot("ai-inline-answer");
    await escapeAll(2);
  }],
  ["ai-inline-insert-diff", async () => {
    await inlineAsk("fx-answer", "Count by carrier instead");
    await click({ sel: "[role=dialog] button", text: "Insert", exact: false });
    await sleep(500);
    await settle();
    await shot("ai-inline-insert-diff");
    await escapeAll(2);
  }],
  ["ai-inline-fix-error", async () => {
    await useModel("fx-answer");
    await queryTabOn("ai-shop", "SELECT carrier, count(*) FROM shipment GROUP BY carrier;");
    await press("Ctrl+Shift+Enter");
    await sleep(1500);
    await click({ sel: "button", text: "Ask", exact: false });
    await waitFor(`document.querySelector('[role=dialog][aria-label="Ask AI"]')`, "the inline Ask");
    await click({ sel: "[role=dialog] button.act", text: "Fix", exact: false }).catch(() => {});
    await answered().catch(() => {});
    await sleep(800);
    await settle();
    await shot("ai-inline-fix-error");
    await escapeAll(2);
  }],
  // 11.3
  ["ai-log", async () => {
    await askOn("fx-answer", SCENE_QUESTION, "ai-log-answer");
    await click({ sel: ".ai-panel button", text: "Show log", exact: false });
    await sleep(600);
    await settle();
    await shot("ai-log");
  }],
  ["ai-steps", async () => {
    await click({ sel: "[role=tab]", text: "Steps" });
    await sleep(400);
    await settle();
    await shot("ai-steps");
  }],
  ["ai-diagram", async () => {
    await click({ sel: "[role=tab]", text: "Diagram" });
    await sleep(400);
    await settle();
    await shot("ai-diagram");
  }],
  // 11.4
  ["ai-settings", async () => {
    await openSwitcher();
    await menuPick("Settings");
    await sleep(800);
    await click({ sel: ".snav button", text: "AI" });
    await sleep(600);
    await settle();
    await shot("ai-settings");
  }],
  ["ai-settings-privacy", async () => {
    await ev("document.querySelector('.settings-page h3')?.scrollIntoView(), [...document.querySelectorAll('h3')].find((h) => h.textContent === 'Privacy')?.scrollIntoView(), true");
    await sleep(400);
    await settle();
    await shot("ai-settings-privacy");
  }],
  ["ai-settings-access", async () => {
    await ev("[...document.querySelectorAll('h3')].find((h) => /access/i.test(h.textContent))?.scrollIntoView(), true");
    await sleep(400);
    await settle();
    await shot("ai-settings-access");
  }],
  ["ai-settings-tools", async () => {
    await ev("[...document.querySelectorAll('h3')].find((h) => /tool/i.test(h.textContent))?.scrollIntoView(), true");
    await sleep(400);
    await settle();
    await shot("ai-settings-tools");
  }],
  // 11.5: the diagram assistant
  ["diagram-ai-switch", async () => {
    await useModel("fx-diagram");
    await diagramPanel("fx-diagram");
    await settle();
    await shot("diagram-ai-switch");
  }],
  ["diagram-ai-panel", async () => {
    await askDiagram("Add an address check and rename Ship");
    await settle();
    await shot("diagram-ai-panel");
  }],
  ["diagram-ai-review", async () => {
    await click({ sel: "button", text: "Review", exact: false });
    await sleep(600);
    await settle();
    await shot("diagram-ai-review");
  }],
  ["diagram-ai-autoapply", async () => {
    await click({ sel: "[role=switch]", label: "Apply", exact: false });
    await sleep(500);
    await settle();
    await shot("diagram-ai-autoapply");
  }],
  // 11h error states the fixtures can produce: the rate limit, a retired model and a server error
  ...[["diagram-ai-err-rate-limit", "fx-429"], ["diagram-ai-err-model-retired", "fx-404"], ["diagram-ai-err-server", "fx-500"]].map(([name, model]) => [name, async () => {
    await diagramPanel(model);
    await askDiagram("Add an address check");
    await settle();
    await shot(name);
  }]),
  // 11.6
  ...ERROR_SCENES.map(([name, model]) => [name, () => askOn(model, SCENE_QUESTION, name)]),
  ["ai-err-writes", async () => {
    await askOn("fx-write", "Set the carrier of shipment 7 to DHL", "ai-err-writes");
  }],
  ["ai-err-stopped", async () => {
    await useModel("fx-long");
    await openPanel();
    await newChat();
    await askPanel(SCENE_QUESTION);
    await sleep(3000);
    await click({ sel: ".ai-panel button", label: "Stop" });
    await sleep(800);
    await settle();
    await shot("ai-err-stopped");
  }],
  ["ai-err-stalled", () => askOn("fx-stall", SCENE_QUESTION, "ai-err-stalled", { wait: () => sleep(100_000) })],
  ["ai-compacted", async () => {
    await useModel("fx-compact");
    await openPanel();
    await newChat();
    await askPanel(SCENE_QUESTION);
    await answered();
    await askPanel("And per status?");
    await answered(40000);
    await sleep(1500);
    await settle();
    await shot("ai-compacted");
  }],
  ["ai-err-context-full", async () => {
    await useModel("fx-compact");
    await openPanel();
    for (let i = 0; i < 3; i++) {
      await askPanel(`Question ${i + 1}: ${"more detail ".repeat(40)}`);
      await answered(30000).catch(() => {});
    }
    await settle();
    await shot("ai-err-context-full");
  }],
  // safety
  ["ai-prod-confirm", async () => {
    await useModel("fx-write");
    await openPanel("ai-prod", "SELECT 1;");
    await newChat();
    await askPanel("Set the carrier of shipment 7 to DHL");
    await answered();
    await click({ sel: ".ai-panel button", label: "Insert", exact: false });
    await click({ sel: "button", label: "Run", exact: false });
    await waitFor(`/Written by the assistant/.test(document.querySelector('[role=dialog]')?.innerText ?? '')`, "the Run confirmation saying Written by the assistant");
    await settle();
    await shot("ai-prod-confirm");
    await press("Escape");
  }],
  ["ai-prod-risky", async () => {
    await useModel("fx-risky");
    await openPanel("ai-prod", "SELECT 1;");
    await newChat();
    await askPanel("Wait a second");
    await answered();
    await click({ sel: ".ai-panel button", label: "Insert", exact: false });
    await sleep(500);
    await settle();
    await shot("ai-prod-risky");
  }],
  ["ai-readonly-blocked", async () => {
    await useModel("fx-write");
    await openPanel("ai-readonly", "SELECT 1;");
    await newChat();
    await askPanel("Set the carrier of shipment 7 to DHL");
    await answered();
    await click({ sel: ".ai-panel button", label: "Insert", exact: false });
    await press("Ctrl+Shift+Enter");
    await sleep(800);
    await settle();
    await shot("ai-readonly-blocked");
  }],
];

// ---------------------------------------------------------------- data folder guard

// The same folder however it is written: resolved, links followed, case and trailing separators ignored.
function sameFolder(a, b) {
  const norm = (p) => {
    let full = resolve(p);
    try {
      full = realpathSync.native(full);
    } catch {
      // A folder that does not exist here is compared as written.
    }
    return full.replace(/[\\/]+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
}

// Setup and cleanup write to, or empty, whatever app answers on the port: check it is the expected one.
async function guardDataFolder() {
  const want = args["data-dir"];
  if (typeof want !== "string" || want === "") {
    throw new Error("--setup, --cleanup, --ai-setup and --ai-cleanup need --data-dir <folder>, the CONTURA_DATA_DIR the app was started with");
  }
  const info = await invoke("data_folder_info");
  const have = info?.path ?? null;
  if (typeof have !== "string" || !sameFolder(have, want)) {
    throw new Error(`refused: the app on port ${PORT} uses the data folder ${have ?? "(unknown)"}, not ${want}. Nothing was changed.`);
  }
}

// ---------------------------------------------------------------- main

await attach();
if (args.setup || args.cleanup || args["ai-setup"] || args["ai-cleanup"]) {
  try {
    await guardDataFolder();
  } catch (e) {
    cdp.close();
    console.error(e.message);
    process.exit(2);
  }
}
if (OUT) mkdirSync(OUT, { recursive: true });
try {
  if (args.setup) await setup();
  else if (args.cleanup) await cleanup();
  else if (args["ai-setup"]) await aiSetup();
  else if (args["ai-cleanup"]) await aiCleanup();
  else await captureAll();
} finally {
  cdp.close();
}
const csp = problems.filter((p) => p.startsWith("CSP"));
console.log(`shots ${shotCount}, problems ${problems.length} (CSP ${csp.length})`);
for (const p of problems) console.log(`  ${p}`);
process.exit(problems.length ? 1 : 0);
