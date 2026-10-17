// Renders the saved design artifact pages in Edge headless and saves every
// design frame as a PNG, in both themes, for the parity comparison.
//
//   node scripts/capture-frames.mjs --html <folder or .html> --out <dir>
//
// Frames: every `.desk` (1280 x 800 workspace frames), every `.sbx` (sidebar
// layouts) and the `.stage` of the New Schema Model page once per card tab.
// Output names: <page>-<frame>-<dark|light>.png.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const args = parseArgs(process.argv.slice(2));
if (!args.html || !args.out) {
  console.error("usage: node scripts/capture-frames.mjs --html <folder or .html> --out <dir>");
  process.exit(2);
}
const PORT = Number(args.port ?? 9223);
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) throw new Error("msedge.exe not found");

const htmlPath = resolve(args.html);
const pages = statSync(htmlPath).isDirectory()
  ? readdirSync(htmlPath).filter((f) => f.endsWith(".html")).map((f) => join(htmlPath, f))
  : [htmlPath];
const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });

// One Edge per page: a long run in one browser stalls on later pages.
if (pages.length > 1) {
  let failed = 0;
  for (const page of pages) {
    const r = spawnSync(process.execPath, [process.argv[1], "--html", page, "--out", outDir, "--port", String(PORT)], {
      stdio: "inherit",
      timeout: 180_000,
    });
    if (r.status !== 0) {
      failed++;
      console.error(`failed: ${page}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith("--")) {
      const key = list[i].slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else out[key] = list[++i];
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("Edge did not open its debugging port");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, fail } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) fail(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
      else ok(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const open = new Promise((ok, fail) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", fail, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const n = ++id;
      waiting.set(n, { ok, fail });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { open, send, events, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

// Pins one frame to the top left of the viewport and captures it there.
// Other frames (sidebar boxes, the New Schema Model stage) sit inside
// stacking contexts, so they are scrolled into view instead; clip takes
// page coordinates.
async function shot(cdp, selector, index, size, file) {
  const pick = `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => !el.classList.contains('bgclone'))[${index}]`;
  const pin = selector === ".desk";
  const at = await evaluate(cdp, `(() => { window.scrollTo(0, 0); const el = ${pick};
    if (${pin}) { el.classList.add('cap-now'); const r = el.getBoundingClientRect();
      if (Math.abs(r.left) < 1 && Math.abs(r.top) < 1) return { x: 0, y: 0 };
      el.classList.remove('cap-now'); }
    el.scrollIntoView({ block: 'start' });
    const q = el.getBoundingClientRect(); return { x: q.left + scrollX, y: q.top + scrollY }; })()`);
  await sleep(150);
  const r = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: at.x, y: at.y, width: size.w, height: size.h, scale: 1 },
  });
  await evaluate(cdp, `(() => { ${pick}.classList.remove('cap-now'); return true; })()`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
}

// Unscales the frame viewports so every frame renders at its real size, and
// adds the class that pins the frame being captured.
const UNSCALE = `(() => {
  const s = document.createElement('style');
  s.textContent = '.vp{max-width:none!important;overflow:visible!important;height:auto!important;width:auto!important}' +
    '.vp>.desk{position:relative!important;transform:none!important}' +
    'html body .cap-now, html body .vp>.desk.cap-now{position:fixed!important;left:0!important;top:0!important;' +
    'transform:none!important;margin:0!important;z-index:2147483647!important}';
  document.head.appendChild(s);
  document.querySelectorAll('.vp[hidden]').forEach((el) => el.removeAttribute('hidden'));
  return true;
})()`;

const RECTS = (selector) => `(() => [...document.querySelectorAll(${JSON.stringify(selector)})]
  .filter((el) => !el.classList.contains('bgclone'))
  .map((el, i) => { const r = el.getBoundingClientRect();
    return { index: i, id: el.id || String(i + 1), w: Math.round(r.width), h: Math.round(r.height) }; })
  .filter((r) => r.w > 0 && r.h > 0))()`;

const profile = join(tmpdir(), `contura-frames-${Date.now()}`);
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--window-size=1280,800",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let count = 0;
try {
  const target = await waitForTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.open;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  for (const page of pages) {
    const name = basename(page, ".html");
    for (const theme of ["dark", "light"]) {
      console.error(`${name} ${theme}`);
      await cdp.send("Page.navigate", { url: pathToFileURL(page).href });
      await sleep(2500);
      await evaluate(cdp, `document.fonts ? document.fonts.ready.then(() => true) : true`);
      await evaluate(
        cdp,
        `(() => { const b = document.querySelector('.ph .seg button[data-th="${theme}"]');
          if (b) b.click(); else document.documentElement.setAttribute('data-theme', '${theme}'); return true; })()`,
      );
      await evaluate(cdp, UNSCALE);
      await sleep(400);

      const tabs = await evaluate(cdp, `[...document.querySelectorAll('#st button')].length`);
      if (tabs > 0) {
        // New Schema Model: one stage, one state per card tab.
        for (let t = 0; t < tabs; t++) {
          await evaluate(cdp, `document.querySelectorAll('#st button')[${t}].click()`);
          await sleep(300);
          const rects = await evaluate(cdp, RECTS(".stage"));
          for (const r of rects) {
            await shot(cdp, ".stage", r.index, r, join(outDir, `${name}-card${t + 1}-${theme}.png`));
            count++;
          }
        }
        continue;
      }
      for (const selector of [".desk", ".sbx"]) {
        const rects = await evaluate(cdp, RECTS(selector));
        for (const r of rects) {
          await shot(cdp, selector, r.index, r, join(outDir, `${name}-${r.id}-${theme}.png`));
          count++;
        }
      }
    }
  }
  cdp.close();
  console.log(`saved ${count} frames to ${outDir}`);
} finally {
  edge.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Edge may still hold a file for a moment */
  }
}
