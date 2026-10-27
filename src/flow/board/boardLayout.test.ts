import { expect, test } from "vitest";
import { frameHeaders, parseBoard } from "../../lang/flow/board";
import type { FlowDoc } from "../../lang/flow/model";
import { parseFlow } from "../../lang/flow/parse";
import { parseFlowLayout, serializeFlowLayout } from "../layout";
import {
  type BoardLayout,
  FRAME_MIN,
  FRAME_PAD,
  type FrameLayout,
  frameBounds,
  frameLayoutView,
  LAYOUT_SAVE_MAX,
  MAX_BOARD_SKETCH_TEXT,
  MAX_PEN_POINTS,
  MAX_SKETCH_POINTS,
  MAX_SKETCHES,
  parseBoardLayout,
  placeNewFrame,
  type Sketch,
  serializeBoardLayout,
  utf8Length,
} from "./boardLayout";

const ONE = [{ title: "Checkout", kind: "flow" as const }];
const live = (...t: string[]) => new Set(t);
/** No kinds: every live frame in these tests has an entry, or its default direction is TB. */
const NO_KINDS: ReadonlyMap<string, null> = new Map();

/** Every layout JSON in today's layout tests and fixtures, as written there (unsorted ones included). */
const TODAY: [string, string | null][] = [
  ["flow", JSON.stringify({ version: 1, nodes: { b: { x: 2, y: 3 }, a: { x: 0, y: 1 }, bad: { x: "no" } }, viewport: { x: 1, y: 2, zoom: 0.5 }, style: "classic", direction: "LR" })],
  ["dfd", '{"version":1,"nodes":{"__proto__":{"x":1,"y":2},"constructor":{"x":3,"y":4}}}'],
  ["dfd", JSON.stringify({ version: 1, nodes: {}, style: "modern", direction: "LR", sizes: { B: { w: 200.4, h: 80 }, A: { w: 100, h: 40 }, Bad: { w: -1, h: 3 } } })],
  ["flow", '{"version":1,"nodes":{},"style":"fancy","direction":"RL"}'],
  ["dfd", '{"version":1}\n'],
  ["flow", JSON.stringify({ version: 1, nodes: { A: { x: 0, y: 0 }, B: { x: 500, y: 300 } }, sizes: { B: { w: 300, h: 120 } }, axes: { '["A","B"]': "v" } })],
  ["flow", JSON.stringify({ version: 1, nodes: { "Order in": { x: 100, y: 100 }, "Check stock": { x: 100, y: 300 }, Done: { x: 100, y: 380 } }, axes: { foo: "v", "[1,2]": "h", '["Order in","Check stock"]': "h" } })],
  ["flow", JSON.stringify({ version: 1, nodes: { A: { x: 0, y: 0 }, B: { x: 300, y: 200 } } })],
  ["flow", JSON.stringify({ version: 1, nodes: { A: { x: 300, y: 0 } } })],
  ["flow", JSON.stringify({ version: 1, nodes: { "Request in": { x: 0, y: 0 }, Check: { x: 300, y: 37 }, Done: { x: 610, y: 81 } } })],
  ["flow", JSON.stringify({ version: 1, nodes: { "Request in": { x: 0, y: 0 }, Check: { x: 0, y: 200 }, Done: { x: 0, y: 400 } }, sizes: { Check: { w: 400, h: 300 } } })],
  ["flow", JSON.stringify({ version: 1, nodes: { "Charge card": { x: 40, y: 40 }, "Paid?": { x: 260, y: 40 }, Retry: { x: 260, y: 260 }, Ship: { x: 520, y: 60 } } })],
  ["dfd", JSON.stringify({ version: 1, nodes: { Customer: { x: 100, y: 100 }, "Take order": { x: 400, y: 100 } } })],
  ["dfd", JSON.stringify({ version: 1, nodes: { Customer: { x: 0, y: 0 }, Checkout: { x: 300, y: 0 } }, style: "classic" })],
  ["cloud", JSON.stringify({ version: 1, nodes: { Users: { x: 0, y: 0 }, "API Gateway": { x: 300, y: 0 } } })],
  ["dfd", JSON.stringify({ version: 1, nodes: { Checkout: { x: 5, y: 6 } }, style: "modern", direction: "LR", sizes: { Checkout: { w: 260, h: 90 } } })],
  ["er", JSON.stringify({ version: 1, nodes: { customers: { x: 100, y: 100 }, invoices: { x: 400, y: 100 } } })],
  ["dfd", `${JSON.stringify({ version: 1, direction: "LR", group: "g-kes", nodes: {} }, null, 2)}\n`],
  ["dfd", `${JSON.stringify({ version: 1, nodes: {}, style: "modern", direction: "LR" }, null, 2)}\n`],
  ["flow", `${JSON.stringify({ version: 1, nodes: { A: { x: 1.5, y: -2 } }, style: "modern", direction: "LR", viewport: { x: -4, y: 9, zoom: 1.25 } }, null, 2)}\n`],
  ["flow", null],
  ["flow", "{"],
];

test("a_one_frame_layout_writes_version_1_byte_for_byte", () => {
  for (const [kind, json] of TODAY) {
    const frames = [{ title: "Checkout", kind: kind as never }];
    const want = serializeFlowLayout(parseFlowLayout(json, kind as never));
    const b = parseBoardLayout(json, frames);
    // A file that did not parse is written as the defaults, as today.
    const kinds = new Map([["Checkout", kind as never]]);
    expect(serializeBoardLayout(b, live("Checkout"), false, kinds), String(json)).toBe(want);
    // What it wrote reads and writes again unchanged.
    expect(serializeBoardLayout(parseBoardLayout(want, frames), live("Checkout"), false, kinds)).toBe(want);
  }
  // The viewport is the board's: written, as version 1 writes it.
  const b = parseBoardLayout(TODAY[0][1], ONE);
  expect(b.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });
});

test("moving_the_only_frame_stays_version_1", () => {
  const b = parseBoardLayout('{"version":1,"nodes":{"A":{"x":10,"y":20}},"style":"modern","direction":"TB"}', ONE);
  b.frames.get("Checkout")!.at = { x: 100, y: -5 };
  const out = JSON.parse(serializeBoardLayout(b, live("Checkout"), false, NO_KINDS));
  expect(out.version).toBe(1);
  expect(out.nodes).toEqual({ A: { x: 110, y: 15 } });
  expect(out.frames).toBeUndefined();
});

test("a_second_frame_writes_version_2", () => {
  const two = [...ONE, { title: "Shipping", kind: "dfd" as const }];
  const b = parseBoardLayout('{"version":1,"nodes":{"A":{"x":10,"y":20}}}', two);
  expect(frameLayoutView(b, "Shipping", "dfd").direction).toBe("LR");
  b.frames.set("Shipping", { at: { x: 600, y: 0 }, nodes: {}, style: "modern", direction: "LR" });
  const text = serializeBoardLayout(b, live("Checkout", "Shipping"), false, NO_KINDS);
  const out = JSON.parse(text);
  expect(out.version).toBe(2);
  expect(Object.keys(out.frames)).toEqual(["Checkout", "Shipping"]);
  expect(out.frames.Shipping.at).toEqual({ x: 600, y: 0 });
  expect(out.sketches).toEqual([]);
  expect(text.endsWith("\n")).toBe(true);
  // It reads back to the same board.
  const back = parseBoardLayout(text, two);
  expect(serializeBoardLayout(back, live("Checkout", "Shipping"), false, NO_KINDS)).toBe(text);
  // One frame with a sketch, or a frame setting, is version 2 too.
  const s = parseBoardLayout(null, ONE);
  s.sketches.push({ id: "s1", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  expect(JSON.parse(serializeBoardLayout(s, live("Checkout"), false, NO_KINDS)).version).toBe(2);
  const n = parseBoardLayout(null, ONE);
  n.frames.set("Checkout", { at: { x: 0, y: 0 }, nodes: {}, style: "modern", direction: "TB", textSize: "l" });
  expect(JSON.parse(serializeBoardLayout(n, live("Checkout"), false, NO_KINDS)).version).toBe(2);
});

test("version_1_reads_as_frame_zero", () => {
  const two = [{ title: "First", kind: "flow" as const }, { title: "Second", kind: "flow" as const }];
  const b = parseBoardLayout('{"version":1,"nodes":{"A":{"x":1,"y":2}},"style":"classic","direction":"LR","viewport":{"x":1,"y":2,"zoom":2}}', two);
  expect(b.frames.get("First")).toMatchObject({ at: { x: 0, y: 0 }, nodes: { A: { x: 1, y: 2 } }, style: "classic", direction: "LR" });
  expect(b.frames.has("Second")).toBe(false);
  expect(b.viewport).toEqual({ x: 1, y: 2, zoom: 2 });
  expect(b.sketches).toEqual([]);
  const v = frameLayoutView(b, "First", "flow");
  expect(v).toEqual({ version: 1, nodes: { A: { x: 1, y: 2 } }, style: "classic", direction: "LR", viewport: { x: 1, y: 2, zoom: 2 } });
  // A frame with no entry takes its kind's defaults.
  expect(frameLayoutView(b, "Nobody", "dfd")).toEqual({ version: 1, nodes: {}, style: "modern", direction: "LR", viewport: { x: 1, y: 2, zoom: 2 } });
});

test("a_frame_without_an_entry_has_none", () => {
  const three = [...ONE, { title: "B", kind: "flow" as const }, { title: "C", kind: "dfd" as const }];
  const v1 = parseBoardLayout('{"version":1,"nodes":{"A":{"x":1,"y":2}}}', three);
  expect([...v1.frames.keys()]).toEqual(["Checkout"]);
  const v2 = parseBoardLayout(JSON.stringify({ version: 2, frames: { B: { at: { x: 5, y: 5 }, nodes: {} } }, sketches: [] }), three);
  expect([...v2.frames.keys()]).toEqual(["B"]);
  expect(parseBoardLayout(null, three).frames.size).toBe(0);
  // The canvas still gets the kind's defaults, and a one-frame write takes its direction from the kind.
  expect(frameLayoutView(v2, "C", "dfd").direction).toBe("LR");
  const one = parseBoardLayout(null, [{ title: "D", kind: "dfd" }]);
  expect(JSON.parse(serializeBoardLayout(one, live("D"), false, new Map([["D", "dfd" as const]]))).direction).toBe("LR");
});

test("text_shaped_like_a_point_pair_round_trips_byte_for_byte", () => {
  const odd = ['[ 1,  2 ]', '{ "x": 1 }', '{ "x": 1, "y": 2 }', 'a\nb', 'say "hi"', '[\n  1,\n  2\n]', '\\u0001 \t'];
  const frames = odd.map((title) => ({ title, kind: "flow" as const }));
  const b: BoardLayout = { frames: new Map(), sketches: [] };
  odd.forEach((t, i) => {
    b.frames.set(t, { at: { x: i, y: -i }, nodes: { [t]: { x: 1, y: 2 } }, sizes: { [t]: { w: 5, h: 6 } }, style: "modern", direction: "TB" });
    b.sketches.push({ id: t.slice(0, 20) + i, kind: i % 2 ? "pen" : "note", x: 1, y: 2, w: 3, h: 4, text: t, color: t.slice(0, 8), ...(i % 2 ? { points: [[1, 2], [3, 4]] as [number, number][] } : {}) });
  });
  const text = serializeBoardLayout(b, new Set(odd), false, NO_KINDS);
  const back = parseBoardLayout(text, frames);
  expect([...back.frames.keys()].sort()).toEqual([...odd].sort());
  for (const t of odd) expect(back.frames.get(t)!.nodes[t]).toEqual({ x: 1, y: 2 });
  expect(back.sketches).toEqual(b.sketches);
  expect(serializeBoardLayout(back, new Set(odd), false, NO_KINDS)).toBe(text);
  // The leaves are on one line.
  expect(text).toContain('"points": [\n');
  expect(text).toContain("[1, 2]");
  expect(JSON.parse(text).frames["[ 1,  2 ]"].at).toEqual({ x: 0, y: 0 });
});

test("gone_titles_are_left_out_unless_kept", () => {
  const two = [...ONE, { title: "Shipping", kind: "flow" as const }];
  const b = parseBoardLayout(null, two);
  const entry = (): FrameLayout => ({ at: { x: 0, y: 0 }, nodes: {}, style: "modern", direction: "TB" });
  b.frames.set("Checkout", entry());
  b.frames.set("Shipping", { ...entry(), nodes: { X: { x: 7, y: 8 } } });
  const all = live("Checkout", "Shipping");
  expect(Object.keys(JSON.parse(serializeBoardLayout(b, all, false, NO_KINDS)).frames)).toEqual(["Checkout", "Shipping"]);
  // Shipping's frame is deleted: its entry stays in memory, but not in the file (one frame left: version 1).
  const alone = serializeBoardLayout(b, live("Checkout"), false, NO_KINDS);
  expect(JSON.parse(alone).version).toBe(1);
  expect(b.frames.has("Shipping")).toBe(true);
  // Three entries, two live: version 2 without the third.
  b.frames.set("Old", { ...b.frames.get("Checkout")!, nodes: { Z: { x: 1, y: 1 } } });
  expect(Object.keys(JSON.parse(serializeBoardLayout(b, all, false, NO_KINDS)).frames)).toEqual(["Checkout", "Shipping"]);
  // A header that fails to read keeps every entry.
  expect(Object.keys(JSON.parse(serializeBoardLayout(b, all, true, NO_KINDS)).frames)).toEqual(["Checkout", "Old", "Shipping"]);
  // Undo brings the frame back with its place.
  expect(b.frames.get("Shipping")!.nodes.X).toEqual({ x: 7, y: 8 });
});

test("bad_sketches_are_dropped_and_caps_hold", () => {
  const ok = { id: "ok", kind: "rect", x: 1.4, y: 2.6, w: 10, h: 20 };
  const pen = (id: string, n: number) => ({ id, kind: "pen", x: 0, y: 0, w: 5, h: 5, points: Array.from({ length: n }, (_, i) => [i, i]) });
  const bad = [
    ok,
    { id: "k", kind: "hexagon", x: 0, y: 0, w: 1, h: 1 },
    { id: "nan", kind: "rect", x: "0", y: 0, w: 1, h: 1 },
    { id: "inf", kind: "rect", x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 1 },
    { kind: "rect", x: 0, y: 0, w: 1, h: 1 },
    { id: "ok", kind: "rect", x: 0, y: 0, w: 1, h: 1 },
    { id: "pts", kind: "pen", x: 0, y: 0, w: 1, h: 1, points: [[1, 2], ["a", 3], [4, 5]] },
    null,
    5,
    pen("long", 1200),
  ];
  const json = JSON.stringify({ version: 2, frames: {}, sketches: bad });
  const b = parseBoardLayout(json, ONE);
  expect(b.sketches.map((s) => s.id)).toEqual(["ok", "pts", "long"]);
  expect(b.sketches[0]).toEqual({ id: "ok", kind: "rect", x: 1, y: 3, w: 10, h: 20 });
  expect(b.sketches[1].points).toEqual([[1, 2], [4, 5]]);
  expect(b.sketches[2].points).toHaveLength(MAX_PEN_POINTS);

  const many = Array.from({ length: 1005 }, (_, i) => ({ id: `s${i}`, kind: "rect", x: i, y: 0, w: 1, h: 1 }));
  const m = parseBoardLayout(JSON.stringify({ version: 2, frames: {}, sketches: many }), ONE);
  expect(m.sketches).toHaveLength(MAX_SKETCHES);
  expect(m.sketches[999].id).toBe("s999");

  // Points past the board's 50,000 are cut; text past the board's budget is dropped; one note past 2,000 characters is cut.
  const pens = Array.from({ length: 52 }, (_, i) => pen(`p${i}`, 1000));
  const p = parseBoardLayout(JSON.stringify({ version: 2, frames: {}, sketches: pens }), ONE);
  expect(p.sketches.reduce((n, s) => n + (s.points?.length ?? 0), 0)).toBe(MAX_SKETCH_POINTS);
  const notes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, kind: "note", x: 0, y: 0, w: 5, h: 5, text: "x".repeat(2000) }));
  const t = parseBoardLayout(JSON.stringify({ version: 2, frames: {}, sketches: notes }), ONE);
  expect(t.sketches).toHaveLength(60);
  expect(t.sketches.filter((s) => s.text !== undefined)).toHaveLength(MAX_BOARD_SKETCH_TEXT / 2000);
  expect(parseBoardLayout(JSON.stringify({ version: 2, frames: {}, sketches: [{ ...notes[0], text: "y".repeat(2500) }] }), ONE).sketches[0].text).toHaveLength(2000);
});

test("place_new_frame_goes_right_of_the_rightmost", () => {
  const boxes = [{ x: 0, y: 30, w: 400, h: 200 }, { x: 500, y: 10, w: 400, h: 250 }];
  expect(placeNewFrame(boxes)).toEqual({ x: 980, y: 10 });
  expect(placeNewFrame([])).toEqual({ x: 0, y: 0 });
});

const docOf = (text: string): FlowDoc => parseFlow(text).doc!;

test("frame_bounds_fit_shapes_with_pad_and_min", () => {
  const doc = docOf('diagram flow "T"\nA\nB\n');
  const entry: FrameLayout = { at: { x: 1000, y: 500 }, nodes: { A: { x: 0, y: 0 }, B: { x: 400, y: 300 } }, sizes: { A: { w: 100, h: 50 }, B: { w: 200, h: 80 } }, style: "modern", direction: "TB" };
  expect(frameBounds(entry, doc, "modern")).toEqual({ x: 1000 - FRAME_PAD, y: 500 - FRAME_PAD, w: 600 + 2 * FRAME_PAD, h: 380 + 2 * FRAME_PAD });
  const empty: FrameLayout = { at: { x: 7, y: 9 }, nodes: {}, style: "modern", direction: "TB" };
  expect(frameBounds(empty, null, "modern")).toEqual({ x: 7, y: 9, ...FRAME_MIN });
  expect(frameBounds(empty, docOf('diagram flow "T"\n'), "modern")).toEqual({ x: 7, y: 9, ...FRAME_MIN });
  // A small shape still gets the minimum.
  const one: FrameLayout = { at: { x: 0, y: 0 }, nodes: { A: { x: 0, y: 0 } }, sizes: { A: { w: 100, h: 50 } }, style: "modern", direction: "TB" };
  expect(frameBounds(one, doc, "modern")).toEqual({ x: -FRAME_PAD, y: -FRAME_PAD, ...FRAME_MIN });
});

test("frame_bounds_are_kept_while_entry_and_doc_are_the_same", () => {
  // Placement measures every frame on each placement (useFlowDoc frameBoxes): no graph build while nothing changed.
  const doc = docOf('diagram flow "T"\nA\nB\n');
  const entry: FrameLayout = { at: { x: 10, y: 20 }, nodes: { A: { x: 0, y: 0 }, B: { x: 400, y: 300 } }, style: "modern", direction: "TB" };
  const first = frameBounds(entry, doc, "modern");
  expect(frameBounds(entry, doc, "modern")).toBe(first);
  // Another doc, entry, look or placeAll is measured anew.
  const doc2 = docOf('diagram flow "T"\nA\nB\n');
  expect(frameBounds(entry, doc2, "modern")).not.toBe(first);
  expect(frameBounds(entry, doc2, "modern")).toEqual(first);
  const moved: FrameLayout = { ...entry, nodes: { ...entry.nodes, B: { x: 500, y: 300 } } };
  expect(frameBounds(moved, doc2, "modern").w).toBe(first.w + 100);
  expect(frameBounds(entry, doc2, "classic")).not.toBe(frameBounds(entry, doc2, "modern"));
});

test("frame_headers_read_titles_without_a_parse", () => {
  const text = '// top\n\ndiagram flow "A \\"q\\""\nX\n\ndiagram er Orders // c\nY\n\ndiagram state Plain title\nZ\n\ndiagram dfd "open\nW\n';
  const h = frameHeaders(text);
  expect(h.map((f) => [f.kind, f.title])).toEqual([["flow", 'A "q"'], ["er", "Orders"], ["state", "Plain title"], ["dfd", ""]]);
  const b = parseBoard(text);
  expect(h.map((f) => f.from)).toEqual(b.frames.map((f) => f.from));
  expect(h.map((f) => f.title)).toEqual(b.frames.map((f) => f.parse.title));
  expect(h.map((f) => f.kind)).toEqual(b.frames.map((f) => f.parse.kind));
  // Not a header, or an alias for a kind: kind null.
  expect(frameHeaders("A > B\n")).toEqual([{ kind: null, title: "", from: 0 }]);
  expect(frameHeaders('diagram flowchart "Q"\n')[0]).toMatchObject({ kind: null, title: "Q" });
  expect(frameHeaders("")).toEqual([{ kind: null, title: "", from: 0 }]);
});

test("a_layout_at_every_limit_stays_under_the_save_budget_in_bytes", () => {
  // 50 frames x 200 positions and sizes; 1,000 sketches at the caps: 50,000 pen points in all, 100,000 characters of
  // text, ids and colours at their caps in escaped control characters (6 bytes a unit), titles of four-byte characters.
  const emoji = "\u{1F600}";
  const titles = new Set<string>();
  const frames = new Map<string, FrameLayout>();
  for (let k = 0; k < 50; k++) {
    const title = `${emoji.repeat(40)}${String(k).padStart(2, "0")}${"t".repeat(58)}`;
    titles.add(title);
    const nodes: FrameLayout["nodes"] = {};
    const sizes: NonNullable<FrameLayout["sizes"]> = {};
    for (let i = 0; i < 200; i++) {
      const name = `${emoji}Step number ${i} of the long flow`;
      nodes[name] = { x: -12345.678 + i, y: 98765.4321 - i };
      sizes[name] = { w: 320, h: 200 };
    }
    frames.set(title, { at: { x: k * 100000, y: -k * 100000 }, nodes, sizes, style: "classic", direction: "LR", notation: "crow", textSize: "m" });
  }
  const sketches: Sketch[] = [];
  for (let i = 0; i < 1000; i++) {
    // Ids and colours at their caps, in escaped control characters: the dearest byte per unit (6 bytes each).
    const s: Sketch = { id: String(i).padStart(4, "0") + "\u0001".repeat(60), kind: i < 50 ? "pen" : "note", x: -99999, y: 99999, w: 99999, h: 99999, color: "\u0001".repeat(32) };
    if (i < 50) s.points = Array.from({ length: 1000 }, (_, j) => [-99999 + j, 99999 - j] as [number, number]);
    // 1,000 sketches x 100 characters: the board's 100,000 characters of text, in four-byte characters.
    s.text = "\u0001".repeat(100);
    sketches.push(s);
  }
  const full: BoardLayout = { viewport: { x: -99999.5, y: 99999.5, zoom: 0.123456789 }, frames, sketches };
  const text = serializeBoardLayout(full, titles, false, NO_KINDS);
  expect(utf8Length(text)).toBeLessThan(LAYOUT_SAVE_MAX);
  expect(utf8Length(text)).toBeGreaterThan(1_000_000);
  expect(parseBoardLayout(text, [...titles].map((title) => ({ title, kind: "flow" as const }))).sketches).toHaveLength(1000);
});

test("an_icon_sketch_round_trips_and_a_bad_name_is_dropped", () => {
  const icon: Sketch = { id: "i1", kind: "icon", x: 10, y: 20, w: 64, h: 64, icon: "brand-postgresql" };
  const titles = new Set(["Checkout"]);
  const layout: BoardLayout = { frames: new Map(), sketches: [icon] };
  const text = serializeBoardLayout(layout, titles, false, NO_KINDS);
  expect(parseBoardLayout(text, ONE).sketches).toEqual([icon]);
  const raw = (extra: Record<string, unknown>) => JSON.stringify({ version: 2, frames: {}, sketches: [{ id: "i1", kind: "icon", x: 0, y: 0, w: 64, h: 64, ...extra }] });
  for (const bad of [{}, { icon: "" }, { icon: 5 }, { icon: "Upper" }, { icon: "-lead" }, { icon: "has space" }, { icon: "a".repeat(101) }])
    expect(parseBoardLayout(raw(bad), ONE).sketches, JSON.stringify(bad)).toEqual([]);
  expect(parseBoardLayout(raw({ icon: "a".repeat(100) }), ONE).sketches).toHaveLength(1);
  // The name is read only on an icon sketch.
  const rect = JSON.stringify({ version: 2, frames: {}, sketches: [{ id: "r", kind: "rect", x: 0, y: 0, w: 5, h: 5, icon: "database" }] });
  expect(parseBoardLayout(rect, ONE).sketches[0].icon).toBeUndefined();
});

test("a_layout_of_1000_icon_sketches_with_long_names_stays_under_the_save_budget_in_bytes", () => {
  const sketches: Sketch[] = Array.from({ length: 1000 }, (_, i) => ({
    id: String(i).padStart(4, "0") + "x".repeat(60),
    kind: "icon" as const,
    x: -99999,
    y: 99999,
    w: 64,
    h: 64,
    icon: `${String(i).padStart(4, "0")}${"n".repeat(96)}`,
  }));
  const text = serializeBoardLayout({ frames: new Map(), sketches }, new Set(), false, NO_KINDS);
  expect(utf8Length(text)).toBeLessThan(LAYOUT_SAVE_MAX);
  expect(parseBoardLayout(text, []).sketches).toHaveLength(1000);
});
