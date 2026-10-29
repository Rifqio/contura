// B4 Task 3: a frame's box and title tab and every sketch kind drawn as plain SVG, as the canvas draws them
// (Decisions 3, 11 and 15; R4, R5, R25, R26; A3 to A6).
import { render } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { createElement } from "react";
import { expect, test, vi } from "vitest";
import type { ExportPalette } from "../../../diagram/export/palette";
import { SVG_MAX_BYTES } from "../../../diagram/export/limits";
import { iconRefs, wrapSvg } from "../../../diagram/export/svg";
import { NODE_TOKENS } from "../../../diagram/types";
import { parseFlow } from "../../../lang/flow/parse";
import boardCss from "../../../styles/flow-board.css?raw";
import { defsOnlyHold, plainSvg } from "../../../test/plainSvg";
import { DIAGRAM_KIND_WORD } from "../../diagramKinds";
import { emptyPositions } from "../../layout";
import { createFlowService } from "../../../lang/flow/service";
import { type BoardLayout, type FrameLayout, frameBounds, type Sketch, type SketchKind, SKETCH_KINDS, utf8Length } from "../boardLayout";
import { FRAME_TAB_H, type FrameBox, TAB_GAP, TAB_PAD_X, TAB_PILL_H, TAB_TITLE_MAX } from "../boardScene";
import { addSketch } from "../sketches";
import { SketchNode } from "../SketchNode";
import { type BoardPublishInput, boardPublishInput, type PublishFrame } from "./boardPublish";
import { boardIconNames, boardSource, composeBoard, composeHooks, frameChromeSvg, sketchSvg } from "./boardSvg";
import boardSvgSource from "./boardSvg.ts?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The real flowScene, counted: a selection builds the live frame's scene once (Task 4).
const sceneCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../flowScene", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../flowScene")>();
  return {
    ...real,
    flowScene: (...a: Parameters<typeof real.flowScene>) => {
      sceneCalls.n++;
      return real.flowScene(...a);
    },
  };
});

const palette = (p: string): ExportPalette => ({
  surface: `#${p}0101`,
  canvas: `#${p}0202`,
  text: `#${p}0303`,
  subtle: `#${p}0404`,
  border: `#${p}0505`,
  type: `#${p}0606`,
  keyword: `#${p}0707`,
  nodes: Object.fromEntries(Object.keys(NODE_TOKENS).map((k, i) => [k, { fill: `#${p}1${i.toString(16)}00`, stroke: `#${p}2${i.toString(16)}00` }])) as ExportPalette["nodes"],
  iconTile: `#${p}1010`,
  group: `#${p}1111`,
  groupTint: `#${p}1212`,
  strongBorder: `#${p}1313`,
  panel: `#${p}1414`,
  muted: `#${p}1515`,
  faint: `#${p}1616`,
  keyMark: `#${p}1717`,
  colours: {
    accent: { fill: `#${p}a100`, stroke: `#${p}a200`, text: `#${p}0303` },
    info: { fill: `#${p}a300`, stroke: `#${p}a400`, text: `#${p}0303` },
    success: { fill: `#${p}a500`, stroke: `#${p}a600`, text: `#${p}0303` },
    warning: { fill: `#${p}a700`, stroke: `#${p}a800`, text: `#${p}0303` },
    danger: { fill: `#${p}a900`, stroke: `#${p}aa00`, text: `#${p}0303` },
    muted: { fill: `#${p}ab00`, stroke: `#${p}ac00`, text: `#${p}ad00` },
  },
});
const LIGHT = palette("e1");
const DARK = palette("d1");

const doc = parseFlow('diagram flow "Orders"\nCharge card').doc!;
const frame = (title: string, over: Partial<PublishFrame> = {}): PublishFrame => ({
  key: title,
  index: 2,
  title,
  kind: "flow",
  at: { x: 100, y: 200 },
  box: { x: 100, y: 200, w: 400, h: 300 },
  doc,
  layout: { nodes: emptyPositions(), style: "modern", direction: "TB" } as unknown as PublishFrame["layout"],
  textScale: 1,
  live: false,
  ...over,
});

const attr = (el: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(el)?.[1];
const texts = (svg: string) => [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${body}</svg>`;

test("a_tab_shows_icon_kind_word_and_title", () => {
  const { box, tab } = frameChromeSvg(frame("Orders"), LIGHT);
  // The box: the canvas's hairline in the border colour, radius 8, no fill.
  expect(box).toMatch(/^<rect\b/);
  expect(attr(box, "stroke")).toBe(LIGHT.border);
  expect(attr(box, "fill")).toBe("none");
  expect(attr(box, "rx")).toBe("8");
  // The pill: surface fill, strong hairline, radius 6.
  const pill = /<rect\b[^>]*>/.exec(tab)![0];
  expect(attr(pill, "fill")).toBe(LIGHT.surface);
  expect(attr(pill, "stroke")).toBe(LIGHT.strongBorder);
  expect(attr(pill, "rx")).toBe("6");
  // The kind icon, then the kind word in the subtle colour, then the title in the muted colour and the strong weight.
  expect(tab).toMatch(/<path\b[^>]*data-part="kind-icon"/);
  const [word, title] = texts(tab);
  expect(word.body).toBe(DIAGRAM_KIND_WORD.flow);
  expect(attr(word.attrs, "fill")).toBe(LIGHT.subtle);
  expect(title.body).toBe("Orders");
  expect(attr(title.attrs, "fill")).toBe(LIGHT.muted);
  expect(attr(title.attrs, "font-weight")).toBe("600");
  expect(Number(attr(title.attrs, "x"))).toBeGreaterThan(Number(attr(word.attrs, "x")));
  // Nothing the canvas shows only while you work: no selection ring, problem count or pane buttons.
  expect(texts(tab)).toHaveLength(2);
  expect(tab).not.toContain("AI Chat");
  expect(tab).not.toContain("Code Editor");
  expect(`${box}${tab}`).not.toContain(LIGHT.colours!.accent.stroke);
  expect(`${box}${tab}`).not.toContain(LIGHT.colours!.danger.stroke);
  plainSvg(wrap(box + tab));
  // The other theme draws from its own palette.
  const dark = frameChromeSvg(frame("Orders"), DARK);
  expect(attr(/<rect\b[^>]*>/.exec(dark.tab)![0], "stroke")).toBe(DARK.strongBorder);
  expect(attr(texts(dark.tab)[1].attrs, "fill")).toBe(DARK.muted);
});

test("an_empty_title_reads_untitled", () => {
  const { tab } = frameChromeSvg(frame(""), LIGHT);
  expect(texts(tab).map((t) => t.body)).toEqual([DIAGRAM_KIND_WORD.flow, "Untitled"]);
});

test("the_tab_sits_above_the_box", () => {
  const f = frame("Orders");
  const { box, tab } = frameChromeSvg(f, LIGHT);
  const pill = /<rect\b[^>]*>/.exec(tab)![0];
  // Hairlines sit half a pixel in, as a CSS border draws inside its box.
  expect(Number(attr(pill, "x")) - 0.5).toBe(f.box.x);
  expect(Number(attr(pill, "y")) - 0.5).toBe(f.box.y - FRAME_TAB_H);
  expect(Number(attr(pill, "height")) + 1).toBe(TAB_PILL_H);
  expect(Number(attr(pill, "y")) + Number(attr(pill, "height"))).toBeLessThan(f.box.y);
  expect(Number(attr(box, "x")) - 0.5).toBe(f.box.x);
  expect(Number(attr(box, "y")) - 0.5).toBe(f.box.y);
  expect(Number(attr(box, "width")) + 1).toBe(f.box.w);
  expect(Number(attr(box, "height")) + 1).toBe(f.box.h);
  for (const t of texts(tab)) {
    const y = Number(attr(t.attrs, "y"));
    expect(y).toBeGreaterThan(f.box.y - FRAME_TAB_H);
    expect(y).toBeLessThan(f.box.y);
  }
});

test("a_long_title_is_cut_with_dots", () => {
  const long = "A very long frame title that runs far past the two hundred and forty pixel cap";
  const { tab } = frameChromeSvg(frame(long), LIGHT);
  const title = texts(tab)[1].body;
  expect(title.endsWith("...")).toBe(true);
  expect(long.startsWith(title.slice(0, -3))).toBe(true);
  expect(title.length * 7).toBeLessThanOrEqual(TAB_TITLE_MAX);
  // A short one is drawn whole.
  expect(texts(frameChromeSvg(frame("Orders"), LIGHT).tab)[1].body).toBe("Orders");
});

const sample = (kind: SketchKind): Sketch => {
  const base: Sketch = { id: `k-${kind}`, kind, x: 10, y: 20, w: 120, h: 80 };
  if (kind === "line" || kind === "arrow" || kind === "pen")
    return {
      ...base,
      points: [
        [0, 0],
        [60, 40],
        [120, 80],
      ],
    };
  if (kind === "icon") return { ...base, w: 64, h: 64, icon: "brand-postgresql" };
  if (kind === "text" || kind === "note" || kind === "section") return { ...base, text: "Hello there" };
  return base;
};

test("each_sketch_kind_draws", () => {
  const kinds = [...SKETCH_KINDS] as SketchKind[];
  expect(kinds).toContain("icon");
  expect(kinds).toHaveLength(10);
  for (const kind of kinds) {
    const svg = sketchSvg(sample(kind), LIGHT);
    expect(svg, kind).toMatch(new RegExp(`^<g data-sketch="k-${kind}" transform="translate\\(10 20\\)">`));
    expect(svg.match(/data-sketch=/g), kind).toHaveLength(1);
    expect(svg.endsWith("</g>"), kind).toBe(true);
    plainSvg(wrap(svg));
    expect(svg, kind).not.toContain("var(");
  }
  // Ellipse and diamond are one path each (A4).
  for (const kind of ["ellipse", "diamond"] as const) {
    const svg = sketchSvg(sample(kind), LIGHT);
    expect(svg.match(/<path\b/g), kind).toHaveLength(1);
    expect(svg, kind).not.toMatch(/<(ellipse|polygon)\b/);
  }
  // An arrow carries its head; a line does not.
  expect(sketchSvg(sample("arrow"), LIGHT)).toContain('data-part="head"');
  expect(sketchSvg(sample("line"), LIGHT)).not.toContain('data-part="head"');
  // A Section is dashed with its title above it; "Section" when it has none.
  const section = sketchSvg(sample("section"), LIGHT);
  expect(section).toContain('stroke-dasharray="6 4"');
  expect(section).toContain('rx="8"');
  const st = texts(section)[0];
  expect(st.body).toBe("Hello there");
  expect(attr(st.attrs, "fill")).toBe(LIGHT.muted);
  expect(Number(attr(st.attrs, "y"))).toBeLessThan(0);
  expect(texts(sketchSvg({ ...sample("section"), text: undefined }, LIGHT))[0].body).toBe("Section");
});

test("a_pen_path_matches_the_canvas", () => {
  const made = addSketch([], {
    kind: "pen",
    x: 140,
    y: 75,
    w: 50,
    h: 40,
    points: [
      [0, 0],
      [12, 7],
      [30, 22],
      [50, 40],
    ],
  });
  expect("change" in made).toBe(true);
  const s = (made as { change: { after: Sketch } }).change.after;
  const svg = sketchSvg(s, LIGHT);
  expect(svg).toMatch(new RegExp(`^<g data-sketch="${s.id}" transform="translate\\(${s.x} ${s.y}\\)">`));
  const d = attr(/<path\b[^>]*data-part="stroke"[^>]*>/.exec(svg)![0], "d");
  const { container } = render(createElement(SketchNode, { id: s.id, type: "sketch", data: { sketch: s }, selected: false, dragging: false } as unknown as NodeProps));
  const canvas = container.querySelector("path.board-sketch-shape.is-stroke")!.getAttribute("d");
  expect(canvas).toBeTruthy();
  expect(d).toBe(canvas);
});

test("a_palette_colour_sketch_takes_the_theme_stroke", () => {
  const s: Sketch = { ...sample("rect"), color: "accent" };
  const light = attr(/<rect\b[^>]*>/.exec(sketchSvg(s, LIGHT))![0], "stroke");
  const dark = attr(/<rect\b[^>]*>/.exec(sketchSvg(s, DARK))![0], "stroke");
  expect(light).toBe(LIGHT.colours!.accent.stroke);
  expect(dark).toBe(DARK.colours!.accent.stroke);
  expect(light).not.toBe(dark);
  // No colour draws in the theme's text colour; a text sketch's words take its stroke.
  expect(attr(/<rect\b[^>]*>/.exec(sketchSvg(sample("rect"), DARK))![0], "stroke")).toBe(DARK.text);
  expect(attr(texts(sketchSvg({ ...sample("text"), color: "danger" }, LIGHT))[0].attrs, "fill")).toBe(LIGHT.colours!.danger.stroke);
});

test("a_note_draws_as_the_canvas_note", () => {
  const svg = sketchSvg(sample("note"), LIGHT);
  const paper = /<rect\b[^>]*>/.exec(svg)![0];
  expect(attr(paper, "fill")).toBe(LIGHT.colours!.warning.fill);
  expect(attr(paper, "stroke")).toBe(LIGHT.subtle);
  expect(attr(paper, "stroke-width")).toBe("1");
  expect(attr(paper, "rx")).toBe("2");
  expect(attr(texts(svg)[0].attrs, "fill")).toBe(LIGHT.text);
  // A palette with no colours fills the note with the surface.
  const bare = { ...LIGHT, colours: undefined };
  expect(attr(/<rect\b[^>]*>/.exec(sketchSvg(sample("note"), bare))![0], "fill")).toBe(LIGHT.surface);
});

test("note_words_wrap_inside_the_box", () => {
  const words = Array.from({ length: 400 }, (_, i) => ["alpha", "beta", "gamma", "delta"][i % 4]).join(" ").slice(0, 2_000);
  expect(words.length).toBe(2_000);
  const s: Sketch = { id: "n", kind: "note", x: 0, y: 0, w: 220, h: 140, text: words };
  const lines = texts(sketchSvg(s, LIGHT));
  expect(lines.length).toBeGreaterThan(1);
  for (const l of lines) {
    const x = Number(attr(l.attrs, "x"));
    const y = Number(attr(l.attrs, "y"));
    expect(x).toBeGreaterThanOrEqual(10);
    expect(x + l.body.length * 7).toBeLessThanOrEqual(s.w - 10);
    expect(y - 13).toBeGreaterThanOrEqual(8);
    expect(y + 5).toBeLessThanOrEqual(s.h - 8);
  }
  expect(lines[lines.length - 1].body.endsWith("...")).toBe(true);
  // Words that fit are drawn whole.
  expect(texts(sketchSvg({ ...s, text: "Ship it" }, LIGHT)).map((l) => l.body)).toEqual(["Ship it"]);
});

const LOGO = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;

test("an_icon_sketch_draws_its_image_and_title", () => {
  const s = sample("icon");
  const refs = iconRefs();
  const titles = new Map([["brand-postgresql", "PostgreSQL"]]);
  const svg = sketchSvg(s, LIGHT, { icons: new Map([["brand-postgresql", { url: LOGO }]]), refs, titles });
  const use = /<use\b[^>]*>/.exec(svg)![0];
  expect(attr(use, "href")).toBe(`#${refs.ref(LOGO, 40)}`);
  expect(refs.entries().get(refs.ref(LOGO, 40))).toEqual({ url: LOGO, size: 40 });
  // 40 px, centred in the 64 px box, 2 px from the top.
  expect(attr(use, "x")).toBe("12");
  expect(attr(use, "y")).toBe("2");
  const [title] = texts(svg);
  expect(title.body).toBe("PostgreSQL");
  expect(attr(title.attrs, "fill")).toBe(LIGHT.muted);
  expect(attr(title.attrs, "font-size")).toBe("11");
  expect(Number(attr(title.attrs, "y"))).toBeGreaterThan(42);
  expect(svg).not.toContain("stroke-dasharray");
  plainSvg(wrap(svg));

  // An outlined logo names the hairline filter it is given.
  const outlined = sketchSvg(s, LIGHT, { icons: new Map([["brand-postgresql", { url: LOGO, outline: true }]]), refs, titles, hairline: "icon-hairline-light" });
  expect(outlined).toContain('filter="url(#icon-hairline-light)"');

  // An icon not loaded, or one whose URL is not a data: image, draws the dashed square and its title.
  for (const icons of [new Map(), new Map([["brand-postgresql", { url: "javascript:alert(1)" }]])]) {
    const missing = sketchSvg(s, LIGHT, { icons, refs: iconRefs(), titles });
    expect(missing).not.toContain("<use");
    expect(missing).not.toContain("javascript");
    const square = /<rect\b[^>]*>/.exec(missing)![0];
    expect(attr(square, "stroke-dasharray")).toBeTruthy();
    expect(attr(square, "stroke")).toBe(LIGHT.subtle);
    expect(texts(missing)[0].body).toBe("PostgreSQL");
  }
  // With no icons at all, the dashed square and the icon's name, cut by estimate to the box.
  const bare = sketchSvg(s, LIGHT);
  expect(bare).not.toContain("<use");
  expect(bare).toContain("stroke-dasharray");
  const name = texts(bare)[0].body;
  expect(name.endsWith("...")).toBe(true);
  expect("brand-postgresql".startsWith(name.slice(0, -3))).toBe(true);
});

test("a_sketch_id_and_frame_title_with_quotes_and_markup_are_escaped", () => {
  const bad = 'x" onload="alert(1)"><script>';
  const svg = sketchSvg({ ...sample("note"), id: bad, text: bad }, LIGHT);
  expect(svg).not.toContain("<script>");
  expect(svg).not.toContain('" onload=');
  expect(svg).toContain(`data-sketch="x&quot; onload=&quot;alert(1)&quot;&gt;&lt;script&gt;"`);
  const section = sketchSvg({ ...sample("section"), w: 900, text: bad }, LIGHT);
  expect(section).not.toContain("<script>");
  const { box, tab } = frameChromeSvg(frame(bad), LIGHT);
  expect(`${box}${tab}`).not.toContain("<script>");
  expect(tab).toContain("&lt;script&gt;");
  const titles = new Map([["brand-postgresql", bad]]);
  const icon = sketchSvg({ ...sample("icon"), w: 64 }, LIGHT, { icons: new Map(), refs: iconRefs(), titles });
  expect(icon).not.toContain("<script");
  expect(icon).not.toContain('" onload=');
});

test("an_unknown_sketch_colour_never_reaches_an_attribute", () => {
  for (const kind of [...SKETCH_KINDS] as SketchKind[]) {
    const svg = sketchSvg({ ...sample(kind), color: 'red" onload="x' }, LIGHT);
    expect(svg, kind).not.toContain("onload");
    plainSvg(wrap(svg));
  }
  const rect = sketchSvg({ ...sample("rect"), color: 'red" onload="x' }, LIGHT);
  expect(attr(/<rect\b[^>]*>/.exec(rect)![0], "stroke")).toBe(LIGHT.text);
  // A name the parse does not read draws in the text colour too.
  expect(attr(/<rect\b[^>]*>/.exec(sketchSvg({ ...sample("rect"), color: "nope" }, LIGHT))![0], "stroke")).toBe(LIGHT.text);
});

test("no_hex_literal_in_board_svg_source", () => {
  const code = boardSvgSource.replace(/\/\*[^]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});

test("board_svg_imports_no_react_component", () => {
  // Publish shares the sketch geometry and the frame's name through leaf modules, not the canvas's components (B4 R26).
  expect(boardSvgSource).not.toMatch(/from "\.\.\/(FrameNode|SketchNode)"/);
});

test("tab_geometry_matches_the_stylesheet", () => {
  const rule = (sel: RegExp) => {
    const m = new RegExp(`${sel.source}[^{]*\\{([^}]*)\\}`).exec(boardCss);
    expect(m, sel.source).not.toBeNull();
    return m![1];
  };
  const pill = rule(/\.board-frame-title,\s*\.board-frame-pane\s*/);
  expect(pill).toMatch(new RegExp(`height:\\s*${TAB_PILL_H}px;`));
  expect(pill).toMatch(new RegExp(`padding:\\s*0 ${TAB_PAD_X}px;`));
  expect(pill).toMatch(new RegExp(`gap:\\s*${TAB_GAP}px;`));
  expect(pill).toMatch(/border-radius:\s*var\(--rounded-md\);/);
  expect(pill).toMatch(/border:\s*var\(--border-hairline\) solid var\(--c-border-strong\);/);
  expect(rule(/\.board-frame-name\s*/)).toMatch(new RegExp(`max-width:\\s*${TAB_TITLE_MAX}px;`));
  expect(rule(/\.board-frame-tab\s*/)).toMatch(new RegExp(`height:\\s*${FRAME_TAB_H}px;`));
});

// ---- Task 4: the board composer, one frame at a time (Decisions 3, 7, 9, 10, 12; R1, R3, R13, R14, R25, R28). ----

/** A frame of `text` placed at `at`, its nodes at `nodes` (frame units). */
function placed(index: number, text: string, nodes: Record<string, { x: number; y: number }>, over: Partial<PublishFrame> = {}): PublishFrame {
  const d = parseFlow(text).doc!;
  const positions = emptyPositions();
  Object.assign(positions, nodes);
  const at = over.at ?? { x: index * 1000, y: 0 };
  return {
    key: d.title,
    index,
    title: d.title,
    kind: d.kind,
    at,
    box: { x: at.x, y: at.y, w: 600, h: 400 },
    doc: d,
    layout: { version: 1, nodes: positions, style: "modern", direction: "TB" },
    textScale: 1,
    notation: "crow",
    live: false,
    ...over,
  };
}

function boardInput(frames: PublishFrame[], sketches: Sketch[] = [], over: Partial<BoardPublishInput> = {}): BoardPublishInput {
  return {
    frames,
    nothingDrawn: 0,
    clashing: 0,
    sketches,
    iconTitles: new Map(),
    frameIndex: frames.find((f) => f.live)?.index ?? null,
    shapes: [],
    sketchIds: [],
    onScreen: { x: 0, y: 0, w: 0, h: 0 },
    ...over,
  };
}

const FLOW = (title: string) => `diagram flow "${title}"\nCart\nPay\nCart > Pay: go\n`;
const FLOW_AT = { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 200 } };
const CLOUD = (title: string) => `diagram cloud "${title}"\nA [icon: aws-s3]\nB [icon: aws-s3]\nA > B\n`;
const CLOUD_AT = { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } };
const ORDERS_ER = 'diagram er "Orders"\norders {\n  id int pk\n  customer_id int\n}\ncustomers {\n  id int pk\n}\norders.customer_id > customers.id\n';
const NO_ICONS = new Map<string, { url: string; outline?: boolean }>();
const OPTS = { padding: 32, background: "theme" as const, mark: false };

/** The opening tag of each frame group, in drawing order. */
const frameGroups = (body: string) => [...body.matchAll(/<g data-board-frame="(\d+)"[^>]*>/g)].map((m) => ({ index: Number(m[1]), tag: m[0], at: m.index! }));
/** The SVG of each frame group, its closing tag found by counting nested groups. */
function frameGroupBody(body: string, index: number): string {
  const start = body.indexOf(`<g data-board-frame="${index}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const re = /<g\b|<\/g>/g;
  re.lastIndex = start;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    depth += m[0] === "</g>" ? -1 : 1;
    if (depth === 0) return body.slice(start, m.index + 4);
  }
  throw new Error("unclosed group");
}

test("same_names_in_two_frames_keep_ids_unique", () => {
  const icons = new Map([["aws-s3", { url: LOGO, outline: true }]]);
  const frames = [placed(0, CLOUD("One"), CLOUD_AT), placed(1, CLOUD("Two"), CLOUD_AT)];
  const c = composeBoard(boardInput(frames), "board", LIGHT, "light", icons, true);
  const svg = wrapSvg(c.defs, c.body, c.bounds, LIGHT, OPTS);
  plainSvg(svg);
  defsOnlyHold(svg);
  const ids = [...svg.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  expect(svg.match(/<defs>/g)).toHaveLength(1);
  expect(svg.match(/<filter\b/g)).toHaveLength(1);
  expect(svg).toContain('<filter id="icon-hairline-light"');
  // The one logo is drawn once in <defs>, and each frame's two services use it with the board's hairline.
  expect(c.defs.match(/<image\b/g)).toHaveLength(1);
  for (const i of [0, 1]) {
    const g = frameGroupBody(c.body, i);
    expect(g.match(/<use\b[^>]*filter="url\(#icon-hairline-light\)"/g)).toHaveLength(2);
    // The shape names live only in data- attributes inside their frame's group.
    expect(g).toContain('data-node="A"');
  }
  expect(c.frames).toBe(2);
  expect(c.tooLarge).toBe(false);
});

test("an_outlined_icon_sketch_alone_brings_the_hairline_filter", () => {
  const frames = [placed(0, FLOW("Plain"), FLOW_AT)];
  const icon: Sketch = { id: "i1", kind: "icon", x: 2000, y: 0, w: 64, h: 64, icon: "aws-s3" };
  const outlined = composeBoard(boardInput(frames, [icon]), "board", DARK, "dark", new Map([["aws-s3", { url: LOGO, outline: true }]]), true);
  expect(outlined.defs.match(/<filter\b/g)).toHaveLength(1);
  expect(outlined.defs).toContain('<filter id="icon-hairline-dark"');
  expect(outlined.body).toContain('filter="url(#icon-hairline-dark)"');
  defsOnlyHold(wrapSvg(outlined.defs, outlined.body, outlined.bounds, DARK, OPTS));
  // An icon sketch that is not outlined, or nothing outlined at all: no filter.
  const plain = composeBoard(boardInput(frames, [icon]), "board", DARK, "dark", new Map([["aws-s3", { url: LOGO }]]), true);
  expect(plain.defs).not.toContain("<filter");
  expect(plain.defs.match(/<image\b/g)).toHaveLength(1);
  const none = composeBoard(boardInput(frames), "board", DARK, "dark", NO_ICONS, true);
  expect(none.defs).toBe("");
  expect(none.bytes).toBe(utf8Length(none.body));
});

test("each_frame_draws_at_its_place", () => {
  const frames = [placed(0, FLOW("One"), FLOW_AT, { at: { x: -40, y: 10 } }), placed(1, FLOW("Two"), FLOW_AT, { at: { x: 300, y: 400 } })];
  const c = composeBoard(boardInput(frames), "board", LIGHT, "light", NO_ICONS, true);
  const groups = frameGroups(c.body);
  expect(groups.map((g) => g.index)).toEqual([0, 1]);
  expect(attr(groups[0].tag, "transform")).toBe("translate(-40 10)");
  expect(attr(groups[1].tag, "transform")).toBe("translate(300 400)");
  for (const g of groups) expect(g.tag).not.toMatch(/\bdata-frame=/);
  // The box sits on the frame's place: at the group's origin, half a pixel in.
  const box = /<rect data-frame-box="1"[^>]*>/.exec(frameGroupBody(c.body, 1))![0];
  expect(attr(box, "x")).toBe("0.5");
  expect(attr(box, "y")).toBe("0.5");
  // Snap edges are in board units: frame 1's Cart card's left edge is at 300.
  expect(c.edges.xs).toContain(300);
  expect(c.edges.ys).toContain(400);
});

test("sketches_layer_as_on_the_canvas", () => {
  const frames = [placed(0, FLOW("One"), FLOW_AT), placed(1, FLOW("Two"), FLOW_AT)];
  const sketches: Sketch[] = [
    { id: "n1", kind: "note", x: 0, y: 500, w: 120, h: 80, text: "Hi" },
    { id: "sec", kind: "section", x: -20, y: -60, w: 2000, h: 600 },
    {
      id: "p1",
      kind: "pen",
      x: 10,
      y: 10,
      w: 20,
      h: 20,
      points: [
        [0, 0],
        [20, 20],
      ],
    },
    { id: "r1", kind: "rect", x: 10, y: 10, w: 40, h: 40 },
  ];
  const c = composeBoard(boardInput(frames, sketches), "board", LIGHT, "light", NO_ICONS, true);
  const pos = (id: string) => c.body.indexOf(`data-sketch="${id}"`);
  const groups = frameGroups(c.body);
  const firstFrame = groups[0].at;
  const lastFrameEnd = groups[1].at + frameGroupBody(c.body, 1).length;
  expect(pos("sec")).toBeGreaterThanOrEqual(0);
  expect(pos("sec")).toBeLessThan(pos("r1"));
  expect(pos("r1")).toBeLessThan(firstFrame);
  expect(pos("n1")).toBeGreaterThanOrEqual(lastFrameEnd);
  expect(pos("n1")).toBeLessThan(pos("p1"));
});

test("frames_keep_text_order_and_the_selected_is_not_lifted", () => {
  const frames = [placed(0, FLOW("A"), FLOW_AT), placed(1, FLOW("B"), FLOW_AT, { live: true }), placed(2, FLOW("C"), FLOW_AT)];
  const c = composeBoard(boardInput(frames, [], { shapes: ["Cart"] }), "board", LIGHT, "light", NO_ICONS, true);
  expect(frameGroups(c.body).map((g) => g.index)).toEqual([0, 1, 2]);
  expect(c.frames).toBe(3);
});

test("titles_off_draws_no_chrome", () => {
  const frames = [placed(0, FLOW("A"), FLOW_AT), placed(1, FLOW("B"), FLOW_AT)];
  const on = composeBoard(boardInput(frames), "board", LIGHT, "light", NO_ICONS, true);
  expect(on.body.match(/data-frame-box=/g)).toHaveLength(2);
  expect(on.body.match(/data-frame-tab=/g)).toHaveLength(2);
  const off = composeBoard(boardInput(frames), "board", LIGHT, "light", NO_ICONS, false);
  expect(off.body).not.toContain("data-frame-box");
  expect(off.body).not.toContain("data-frame-tab");
  expect(frameGroups(off.body)).toHaveLength(2);
  // The region leaves out the tab strip too.
  expect(off.bounds.y).toBeGreaterThan(on.bounds.y);
});

test("selected_frame_draws_its_tab_with_titles_on", () => {
  const frames = [placed(0, FLOW("A"), FLOW_AT), placed(1, FLOW("B"), FLOW_AT, { live: true })];
  const c = composeBoard(boardInput(frames), "frame", LIGHT, "light", NO_ICONS, true);
  expect(c.frames).toBe(1);
  expect(frameGroups(c.body).map((g) => g.index)).toEqual([1]);
  expect(c.body.match(/data-frame-tab="1"/g)).toHaveLength(1);
  expect(c.body.match(/data-frame-box="1"/g)).toHaveLength(1);
});

test("the_live_scene_is_built_once_for_a_selection", () => {
  // Frame 1 is live with Cart selected; frame 0, before it in text order, is wide enough to meet the selection, and
  // frame 2 is far from it.
  const frames = [
    placed(0, FLOW("Wide"), FLOW_AT, { box: { x: 0, y: 0, w: 1200, h: 400 } }),
    placed(1, FLOW("Live"), FLOW_AT, { live: true, at: { x: 1000, y: 0 } }),
    placed(2, FLOW("Far"), FLOW_AT, { at: { x: 0, y: 5000 } }),
  ];
  const seen: number[] = [];
  let composes = 0;
  composeHooks.onScene = (index) => seen.push(index);
  composeHooks.onCompose = () => composes++;
  try {
    sceneCalls.n = 0;
    const c = composeBoard(boardInput(frames, [], { shapes: ["Cart"] }), "selection", LIGHT, "light", NO_ICONS, true);
    // One scene per frame drawn: the live one built first for the region and used again at its turn.
    expect(sceneCalls.n).toBe(2);
    expect(seen).toEqual([0, 1]);
    expect(composes).toBe(1);
    expect(c.frames).toBe(2);
    expect(frameGroups(c.body).map((g) => g.index)).toEqual([0, 1]);
    // The region is the selected shape's box on the board.
    expect(c.bounds.x).toBe(1000);
    expect(c.bounds.y).toBe(0);
  } finally {
    composeHooks.onScene = undefined;
    composeHooks.onCompose = undefined;
  }
});

test("er_notation_shows_in_the_image", () => {
  const nodes = { orders: { x: 0, y: 0 }, customers: { x: 400, y: 0 } };
  // Arrows end the line with the flow line's head (`data-marker="head"`, svg.ts `head`), as the one-frame Publish does.
  const arrow = composeBoard(boardInput([placed(0, ORDERS_ER, nodes, { notation: "arrow" })]), "board", LIGHT, "light", NO_ICONS, true);
  expect(arrow.body).toContain('data-marker="head"');
  expect(arrow.body).not.toContain('data-marker="crow"');
  const crow = composeBoard(boardInput([placed(0, ORDERS_ER, nodes, { notation: "crow" })]), "board", LIGHT, "light", NO_ICONS, true);
  expect(crow.body).toContain('data-marker="crow"');
  expect(crow.body).not.toContain('data-marker="head"');
});

test("text_size_shows_in_the_image", () => {
  const sizes = (body: string) => [...frameGroupBody(body, 0).replace(/^<g [^>]*>/, "").matchAll(/ font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
  const m = composeBoard(boardInput([placed(0, FLOW("M"), FLOW_AT, { textScale: 1 })]), "board", LIGHT, "light", NO_ICONS, false);
  const l = composeBoard(boardInput([placed(0, FLOW("L"), FLOW_AT, { textScale: 1.15 })]), "board", LIGHT, "light", NO_ICONS, false);
  expect(attr(frameGroups(m.body)[0].tag, "font-size")).toBe("13");
  expect(attr(frameGroups(l.body)[0].tag, "font-size")).toBe("14.95");
  expect(sizes(m.body).length).toBeGreaterThan(0);
  expect(Math.max(...sizes(l.body))).toBeGreaterThan(Math.max(...sizes(m.body)));
});

test("past_the_svg_cap_it_stops_early", () => {
  const frames = [0, 1, 2, 3].map((k) => placed(k, FLOW(`F${k}`), FLOW_AT));
  const full = composeBoard(boardInput(frames), "board", LIGHT, "light", NO_ICONS, true);
  expect(full.tooLarge).toBe(false);
  expect(full.frames).toBe(4);
  composeHooks.maxBytes = Math.floor(full.bytes / 3);
  try {
    const c = composeBoard(boardInput(frames), "board", LIGHT, "light", NO_ICONS, true);
    expect(c.tooLarge).toBe(true);
    expect(c.frames).toBeGreaterThan(0);
    expect(c.frames).toBeLessThan(frames.length);
    expect(c.bytes).toBeGreaterThan(composeHooks.maxBytes);
    // A refusal holds nothing to draw: no body, no defs, no snap edges.
    expect(c.body).toBe("");
    expect(c.defs).toBe("");
    expect(c.edges).toEqual({ xs: [], ys: [] });
    // Composing stopped: the frames after the one that passed the cap were never built.
    let scenes = 0;
    composeHooks.onScene = () => scenes++;
    composeBoard(boardInput(frames), "board", LIGHT, "light", NO_ICONS, true);
    expect(scenes).toBe(c.frames);
  } finally {
    composeHooks.maxBytes = undefined;
    composeHooks.onScene = undefined;
  }
  expect(full.bytes).toBeLessThan(SVG_MAX_BYTES);
});

test("a_non_ascii_title_counts_utf8_bytes", () => {
  const icons = new Map([["aws-s3", { url: LOGO, outline: true }]]);
  const c = composeBoard(boardInput([placed(0, CLOUD("Zahlungsübersicht 支付 🚀"), CLOUD_AT)]), "board", LIGHT, "light", icons, true);
  expect(c.body).toContain("Zahlungsübersicht");
  expect(c.bytes).toBe(utf8Length(c.body) + utf8Length(c.defs));
  expect(c.bytes).toBeGreaterThan(c.body.length + c.defs.length);
});

test("icon_sketch_names_join_the_icon_union", () => {
  const frames = [placed(0, 'diagram cloud "C"\nStore [icon: aws-s3]\nWeb [icon: aws-lambda]\n', { Store: { x: 0, y: 0 }, Web: { x: 300, y: 0 } }), placed(1, CLOUD("D"), CLOUD_AT)];
  const sketches: Sketch[] = [
    { id: "i1", kind: "icon", x: 0, y: 900, w: 64, h: 64, icon: "brand-postgresql" },
    { id: "i2", kind: "icon", x: 100, y: 900, w: 64, h: 64, icon: "aws-s3" },
    { id: "r1", kind: "rect", x: 200, y: 900, w: 64, h: 64 },
  ];
  const names = boardIconNames(boardInput(frames, sketches));
  expect([...names].sort()).toEqual(["aws-lambda", "aws-s3", "brand-postgresql"]);
});

test("an_unsafe_icon_url_adds_nothing_to_the_size", () => {
  // A URL that is not a data: image is never drawn and never reaches <defs>, so the running size and the cap agree.
  const bad = new Map([["aws-s3", { url: "javascript:alert(1)", outline: true }]]);
  const icon: Sketch = { id: "i1", kind: "icon", x: 2000, y: 0, w: 64, h: 64, icon: "aws-s3" };
  const c = composeBoard(boardInput([placed(0, CLOUD("Bad"), CLOUD_AT)], [icon]), "board", LIGHT, "light", bad, true);
  expect(c.defs).toBe("");
  expect(c.body).not.toContain("javascript");
  expect(c.bytes).toBe(utf8Length(c.body));
  composeHooks.maxBytes = c.bytes;
  try {
    const at = composeBoard(boardInput([placed(0, CLOUD("Bad"), CLOUD_AT)], [icon]), "board", LIGHT, "light", bad, true);
    expect(at.tooLarge).toBe(false);
    expect(at.body).toBe(c.body);
  } finally {
    composeHooks.maxBytes = undefined;
  }
});

// ----- Final review I1: a long ER table on a board publishes every row inside its frame and its region.

test("a_long_er_table_on_a_board_stays_in_its_region", () => {
  const cols = Array.from({ length: 30 }, (_, i) => `  c${i} int${i === 0 ? " pk" : ""}`);
  const text = ['diagram flow "Top"', "Start", "", 'diagram er "Long"', "wide {", ...cols, "}", ""].join("\n");
  const frames = createFlowService().parse("board", text).frames;
  const keys = ["Top", "Long"];
  const ent = (at: { x: number; y: number }, nodes: Record<string, { x: number; y: number }>): FrameLayout => ({
    at,
    nodes: Object.assign(emptyPositions(), nodes),
    style: "modern",
    direction: "TB",
  });
  // The ER frame is the lowest on the board, so nothing below it widens the region.
  const b: BoardLayout = { frames: new Map([["Top", ent({ x: 0, y: 0 }, { Start: { x: 0, y: 0 } })], ["Long", ent({ x: 0, y: 400 }, { wide: { x: 0, y: 0 } })]]), sketches: [] };
  // The canvas boxes, as the board scene measures them (the canvas caps an ER card at 20 rows).
  const boxes: FrameBox[] = frames.map((f, i) => {
    const r = frameBounds(b.frames.get(keys[i])!, f.doc, "modern");
    return { key: keys[i], index: i, title: f.title, kind: f.kind, ...r, problems: 0, clash: false };
  });
  const live = { layout: { version: 1, nodes: b.frames.get("Long")!.nodes, style: "modern", direction: "TB" } as PublishFrame["layout"], folded: new Set<string>(), textScale: 1, notation: "crow" as const };
  const input = boardPublishInput({ frames, board: b, keys, boxes, frameIndex: 1, live, shapes: [], sketchIds: [], onScreen: { x: 0, y: 0, w: 10, h: 10 } });
  for (const part of ["board", "frame"] as const) {
    const c = composeBoard(input, part, LIGHT, "light", new Map(), true);
    const g = /<g data-board-frame="1" transform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(c.body);
    expect(g, part).not.toBeNull();
    const [ax, ay] = [Number(g![1]), Number(g![2])];
    const frameSvg = c.body.slice(c.body.indexOf('<g data-board-frame="1"'));
    const card = /<g data-node="wide">.*?<\/g>/.exec(frameSvg)![0];
    const rect = /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/.exec(card)!;
    const cardBottom = Number(rect[2]) + Number(rect[4]);
    const fb = /<rect data-frame-box="1" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/.exec(frameSvg)!;
    const boxTop = Number(fb[2]);
    const boxBottom = boxTop + Number(fb[4]);
    // The frame's outline wraps the whole card.
    expect(cardBottom, part).toBeLessThanOrEqual(boxBottom);
    for (let i = 0; i < 30; i++) {
      const row = new RegExp(`<text x="[^"]+" y="([^"]+)">c${i}<`).exec(card);
      expect(row, `${part}, c${i}`).not.toBeNull();
      const y = Number(row![1]);
      // Inside the frame's outline, and inside the image's region (padding 0).
      expect(y, `${part}, c${i}`).toBeLessThan(boxBottom);
      expect(y + ay, `${part}, c${i}`).toBeLessThan(c.bounds.y + c.bounds.h);
      expect(ax + Number(rect[1]), part).toBeGreaterThanOrEqual(c.bounds.x);
    }
    expect(cardBottom + ay, part).toBeLessThanOrEqual(c.bounds.y + c.bounds.h);
    plainSvg(wrapSvg(c.defs, c.body, c.bounds, LIGHT, { padding: 0, background: "theme", mark: false }));
  }
});

// ----- Final review minor 1: a Section's title, drawn above its box, stays inside the image at padding 0.

test("a_section_title_stays_inside_the_region", () => {
  const section: Sketch = { id: "s1", kind: "section", x: 100, y: 300, w: 300, h: 200, text: "Payments" };
  const frames = [placed(0, FLOW("One"), FLOW_AT, { at: { x: 0, y: 400 } })];
  for (const [part, over] of [
    ["board", {}],
    ["selection", { sketchIds: ["s1"] }],
  ] as const) {
    const c = composeBoard(boardInput(frames, [section], over), part, LIGHT, "light", NO_ICONS, true);
    const g = /<g data-sketch="s1" transform="translate\(([-\d.]+) ([-\d.]+)\)">(.*?)<\/g>/.exec(c.body)!;
    const title = texts(g[3]).find((t) => t.body === "Payments")!;
    const baseline = Number(g[2]) + Number(attr(title.attrs, "y"));
    // The title's line box (18 px, words 13 px below its top) is inside the region, with padding 0.
    expect(baseline - 13, part).toBeGreaterThanOrEqual(c.bounds.y);
  }
});

// ----- Final review minor 4: a <use> carries xlink:href too, for SVG 1.1 readers (Inkscape 0.92, older librsvg).

test("a_use_carries_xlink_href_with_the_namespace_once", () => {
  const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
  const opts = { padding: 16, background: "theme" as const, mark: false };
  const frames = [placed(0, CLOUD("One"), CLOUD_AT), placed(1, CLOUD("Two"), CLOUD_AT)];
  const icons = new Map([["aws-s3", { url: LOGO }]]);
  const d = boardSource(boardInput(frames), icons, "light").draw("board", LIGHT, true);
  const svg = d.svg(opts);
  const uses = [...svg.matchAll(/<use\b[^>]*>/g)].map((m) => m[0]);
  expect(uses.length).toBeGreaterThan(1);
  for (const u of uses) {
    const href = /\shref="([^"]*)"/.exec(u)![1];
    expect(href).toMatch(/^#[\w-]+$/);
    expect(/\sxlink:href="([^"]*)"/.exec(u)?.[1]).toBe(href);
  }
  // Declared once, on the root, and counted in the size said before writing.
  expect(svg.split(XLINK)).toHaveLength(2);
  expect(/^<svg\b[^>]*>/.exec(svg)![0]).toContain(XLINK);
  expect(d.bytes(opts)).toBe(utf8Length(svg));
  plainSvg(svg);
  defsOnlyHold(svg);
  // An image with no <use> declares nothing.
  const none = boardSource(boardInput([placed(0, FLOW("One"), FLOW_AT)]), NO_ICONS, "light").draw("board", LIGHT, true);
  expect(none.svg(opts)).not.toContain("xlink");
  expect(none.bytes(opts)).toBe(utf8Length(none.svg(opts)));
});

// ----- Final review minor 5: a cut never splits a surrogate pair, so an emoji is never written as U+FFFD.

test("cuts_never_split_an_emoji", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const emoji = "\u{1F680}";
  // Every cut point: a tab title, a Section title, an icon title, a note's last line and a long word in a note.
  for (let n = 1; n <= 60; n++) {
    const words = `${"a".repeat(n % 7)}${emoji.repeat(n)}`;
    const tab = frameChromeSvg(frame(words), LIGHT).tab;
    const section = sketchSvg({ id: "s", kind: "section", x: 0, y: 0, w: 40 + n * 3, h: 100, text: words }, LIGHT);
    const icon = sketchSvg({ id: "i", kind: "icon", x: 0, y: 0, w: 64, h: 64, icon: words }, LIGHT);
    const note = sketchSvg({ id: "n", kind: "note", x: 0, y: 0, w: 60 + n, h: 40, text: `${words} ${words} ${words}` }, LIGHT);
    for (const [what, svg] of [["tab", tab], ["section", section], ["icon", icon], ["note", note]] as const) {
      expect(lone.test(svg), `${what} at ${n}`).toBe(false);
      expect(new TextDecoder().decode(new TextEncoder().encode(svg)), `${what} at ${n}`).not.toContain("�");
    }
  }
});
