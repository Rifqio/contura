// Publish for every diagram kind: data flow in Modern and Classic, flowcharts, cloud with
// its icons drawn unchanged, and lineage, all through the one scene and sceneToSvg.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Lineage } from "../../api/types";
import { flowScene, loadSceneIcons, sceneIconNames } from "../../flow/flowScene";
import { buildFlowGraph, nodeSize } from "../../flow/flowNodes";
import { resetIcons, setIconTheme } from "../../flow/icons";
import { parseFlow } from "../../lang/flow/parse";
import type { FlowDoc } from "../../lang/flow/model";
import { lineageScene } from "../../lineage/scene";
import { exampleSvg } from "../../flow/previewScene";
import { erCardH, ER_CARD_CHROME, erMetrics, ER_ROW_MID, KIND_ROW } from "../../flow/kindLayout";
import flowSceneSource from "../../flow/flowScene.ts?raw";
import svgSource from "./svg.ts?raw";
import { callsTo, routeInvoke } from "../../test/invoke";
import { NODE_TOKENS } from "../types";
import type { ExportPalette } from "./palette";
import { sceneBounds, sceneEdges } from "./scene";
import { iconRefs, sceneBody, sceneToSvg, snapCrop, svgDefs } from "./svg";
import { PAY } from "../../flow/fixtures/paySequence";
import { emptyPositions } from "../../flow/layout";
import { drawnColour } from "../../flow/palette";
import { seqColours, STRONG_TINT, WASH } from "../../flow/seqColour";
import { messagePath, type SeqBlock } from "../../flow/seqGeometry";
import type { SeqEdgeData } from "../../flow/seqNodes";
import { mixHex } from "../../lang/flow/colours";
import { plainSvg } from "../../test/plainSvg";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const PALETTE: ExportPalette = {
  surface: "#010101",
  canvas: "#020202",
  text: "#030303",
  subtle: "#040404",
  border: "#050505",
  type: "#060606",
  keyword: "#070707",
  nodes: Object.fromEntries(Object.keys(NODE_TOKENS).map((k, i) => [k, { fill: `#1${i.toString(16)}0000`, stroke: `#2${i.toString(16)}0000` }])) as ExportPalette["nodes"],
  iconTile: "#101010",
  group: "#111111",
  groupTint: "#121212",
  strongBorder: "#131313",
  panel: "#141414",
  muted: "#151515",
  faint: "#161616",
  keyMark: "#171718",
};
const opts = { padding: 32, background: "theme" as const, mark: false };

const allowed = () =>
  new Set([
    ...Object.values(PALETTE).filter((v): v is string => typeof v === "string"),
    ...Object.values(PALETTE.nodes).flatMap((n) => [n.fill, n.stroke]),
  ]);
/** Every colour an image uses is a palette (token) value. */
function onlyTokenColours(svg: string) {
  const used = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]).filter((c) => c !== "none");
  expect(used.length).toBeGreaterThan(0);
  expect(used.filter((c) => !allowed().has(c))).toEqual([]);
}

function doc(text: string): FlowDoc {
  const r = parseFlow(text);
  expect(r.doc).not.toBeNull();
  return r.doc!;
}

const DFD = doc(
  [
    'diagram dfd "Checkout"',
    "Customer [entity]",
    "Checkout [process, id: 1.0]",
    "Orders [store, id: D1, table: shop.orders]",
    "Payments {",
    "  Charge card [process, id: 2.0]",
    "}",
    "Customer > Checkout: order details",
    "Checkout > Orders: new order",
    "Orders --> Checkout: stock level",
    "Checkout <> Charge card",
    "Charge card - Customer",
  ].join("\n"),
);
const DFD_AT = { Customer: { x: 0, y: 0 }, Checkout: { x: 300, y: 0 }, Orders: { x: 600, y: 0 }, "Charge card": { x: 300, y: 200 } };

test("dfd_modern_export_draws_every_node_line_and_group", () => {
  const scene = flowScene(DFD, DFD_AT, "modern", new Map());
  expect(scene.nodes.map((n) => [n.id, n.kind, n.look])).toEqual([
    ["Customer", "external", "modern"],
    ["Checkout", "process", "modern"],
    ["Orders", "store", "modern"],
    ["Charge card", "process", "modern"],
  ]);
  const orders = scene.nodes.find((n) => n.id === "Orders")!;
  expect(orders).toMatchObject({ x: 600, y: 0, ...nodeSize("store", "modern", "Orders", "D1"), sub: "shop.orders", tag: "D1", linked: true });
  expect(scene.nodes.find((n) => n.id === "Checkout")!.sub).toBe("Process");
  expect(scene.areas).toEqual([expect.objectContaining({ name: "Payments", depth: 0 })]);
  // Lines: one way, dashed, both ways and no arrow.
  expect(scene.edges.map((e) => [e.kind, e.line ?? "solid", e.heads, e.label])).toEqual([
    ["flow", "solid", "end", "order details"],
    ["flow", "solid", "end", "new order"],
    ["flow", "dashed", "end", "stock level"],
    ["flow", "solid", "both", undefined],
    ["flow", "solid", "none", undefined],
  ]);
  for (const e of scene.edges) expect(e.points.length).toBeGreaterThanOrEqual(2);

  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  for (const t of ["Customer", "Checkout", "Orders", "Charge card", "Payments", "order details", "stock level", "1.0", "D1", "shop.orders", "Process", "Outside party"]) {
    expect(svg).toContain(`>${t}<`);
  }
  // A store's dashed right edge, an outside party's double edge, a dashed line, and drawn arrowheads.
  expect(svg).toMatch(/data-part="open-edge"[^>]*stroke-dasharray/);
  expect(svg).toContain('data-part="double-edge"');
  expect(svg).toMatch(/data-edge="edge:2"><path [^>]*stroke-dasharray="5 4"/);
  expect(svg.match(/data-marker="head"/g)).toHaveLength(5);
  expect(svg).not.toContain("<marker");
  // The group area sits behind the nodes.
  expect(svg.indexOf('data-area="Payments"')).toBeLessThan(svg.indexOf('data-node="Customer"'));
});

test("dfd_classic_export_draws_the_gane_sarson_shapes", () => {
  const scene = flowScene(DFD, DFD_AT, "classic", new Map());
  expect(scene.nodes.every((n) => n.look === "classic")).toBe(true);
  const checkout = scene.nodes.find((n) => n.id === "Checkout")!;
  expect([checkout.w, checkout.h]).toEqual([156, 62]);
  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  // The process's id band, the store's id cell with no right edge, the entity's heavy top-left edge.
  expect(svg).toContain('data-part="band"');
  expect(svg).toContain('data-part="id-cell"');
  expect(svg).toMatch(/data-node="Orders">(?:(?!<\/g>).)*data-part="open-store"/);
  expect(svg).toMatch(/data-part="heavy-edge"[^>]*stroke-width="3"/);
  expect(svg).not.toContain('data-part="double-edge"');
});

const FLOWCHART = doc(
  [
    'diagram flow "Refund request"',
    "Request in [start]",
    "Within 30 days? [decision]",
    "Read order [io, table: shop.orders]",
    "Refund [step]",
    "Check card [subprocess]",
    "Done [end]",
    "Request in > Within 30 days?",
    "Within 30 days? > Read order: yes",
    "Read order > Refund",
    "Refund > Check card",
    "Check card > Done",
  ].join("\n"),
);

test("flowchart_export_draws_pills_steps_the_slant_and_the_diamond", () => {
  const at = Object.fromEntries(FLOWCHART.nodes.map((n, i) => [n.name, { x: 0, y: i * 160 }]));
  const scene = flowScene(FLOWCHART, at, "modern", new Map());
  expect(scene.nodes.map((n) => n.kind)).toEqual(["start", "decision", "io", "step", "subprocess", "end"]);
  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  expect(svg).toMatch(/data-node="Request in"><rect [^>]*rx="18"/);
  expect(svg).toMatch(/data-node="Within 30 days\?"><path data-part="diamond"/);
  expect(svg).toMatch(/data-node="Read order"><path data-part="slant"/);
  expect(svg).toMatch(/data-node="Check card">(?:(?!<\/g>).)*data-part="sub-bars"/);
  // The io step names its table with the link glyph; the label sits on a chip.
  expect(svg).toMatch(/data-node="Read order">(?:(?!<\/g>).)*data-part="link"/);
  expect(svg).toContain(">yes<");
  expect(svg).toContain('data-part="chip"');
});

const PIXEL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#ff9900"/><title>Gateway é</title></svg>';
const LUCIDE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 3h18v18H3z" stroke="currentColor"/></svg>';

const CLOUD = doc(
  [
    'diagram cloud "Order API"',
    "AWS [icon: aws-cloud] {",
    "  API Gateway [icon: aws-api-gateway]",
    "  Queue [icon: aws-sqs]",
    "}",
    "Users [icon: users]",
    "Ghost [icon: aws-nothing]",
    "Users > API Gateway: HTTPS",
    "API Gateway ..> Queue: assumes",
  ].join("\n"),
);
const CLOUD_AT = { "API Gateway": { x: 300, y: 0 }, Queue: { x: 600, y: 0 }, Users: { x: 0, y: 0 }, Ghost: { x: 0, y: 200 } };

beforeEach(() => resetIcons());
afterEach(() => resetIcons());

test("cloud_export_loads_only_the_icons_it_uses_and_draws_them_unchanged", async () => {
  routeInvoke({
    icon: ({ name }) => {
      if (name === "aws-api-gateway" || name === "aws-cloud") return PIXEL;
      if (name === "users") return LUCIDE;
      if (name === "aws-sqs") throw { kind: "file", message: "the icon pack is damaged" };
      throw { kind: "notFound", message: String(name) };
    },
  });
  expect(sceneIconNames(CLOUD).sort()).toEqual(["aws-api-gateway", "aws-cloud", "aws-nothing", "aws-sqs", "users"]);
  const icons = await loadSceneIcons(sceneIconNames(CLOUD), "light");
  expect(callsTo("icon").map((c) => c.name).sort()).toEqual(["aws-api-gateway", "aws-cloud", "aws-nothing", "aws-sqs", "users"]);
  expect([...icons.keys()].sort()).toEqual(["aws-api-gateway", "aws-cloud", "users"]);

  const scene = flowScene(CLOUD, CLOUD_AT, "modern", icons);
  const gateway = scene.nodes.find((n) => n.id === "API Gateway")!;
  expect(gateway).toMatchObject({ kind: "service", iconName: "aws-api-gateway", w: 104, h: 72 });
  expect(scene.nodes.find((n) => n.id === "Users")).not.toHaveProperty("plate");
  expect(scene.nodes.find((n) => n.id === "Ghost")!.icon).toBeUndefined();
  expect(scene.areas?.[0]).toMatchObject({ name: "AWS" });
  expect(scene.areas?.[0].icon).toMatch(/^data:image\/svg\+xml;base64,/);
  // The dotted "assumes" line has no arrowhead, and lines meet the 48 px tile, not the 104 px node.
  const assumes = scene.edges.find((e) => e.label === "assumes")!;
  expect([assumes.line, assumes.heads]).toEqual(["dotted", "none"]);
  expect(assumes.points[0].x).toBe(300 + (104 - 48) / 2 + 48);

  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  // Each icon is an image whose data decodes to the pack's own bytes: never inline markup.
  const images = [...svg.matchAll(/<image\b[^>]*\bhref="data:image\/svg\+xml;base64,([^"]+)"/g)].map((m) =>
    new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))),
  );
  expect(images.sort()).toEqual([LUCIDE, PIXEL, PIXEL].sort());
  expect(svg).not.toContain("<title>Gateway");
  expect(svg).not.toContain("currentColor");
  // An icon that could not be read draws the dashed cube tile; no icon has a plate behind it.
  expect(svg).toMatch(/data-node="Ghost"><rect [^>]*stroke-dasharray/);
  expect(svg).toMatch(/data-node="Queue"><rect [^>]*stroke-dasharray/);
  expect(svg).not.toContain(`fill="${PALETTE.iconTile}"`);
  expect(svg).toMatch(new RegExp(`data-area="AWS"><rect [^>]*fill="${PALETTE.groupTint}"[^>]*stroke="${PALETTE.group}"[^>]*stroke-dasharray`));
  expect(svg).toMatch(/data-edge="edge:1"><path [^>]*stroke-dasharray="1 4"/);
  expect(svg.match(/data-marker="head"/g)).toHaveLength(1);
});

test("publish_inks_icons_for_the_publish_theme", async () => {
  routeInvoke({ icon: () => PIXEL });
  setIconTheme("light");
  const icons = await loadSceneIcons(["database"], "dark");
  expect(callsTo("icon")).toEqual([{ name: "database", ink: "#f8f8f2" }]);
  const doc: FlowDoc = { ...CLOUD, nodes: CLOUD.nodes.filter((n) => n.name === "Users") };
  const svg = sceneToSvg(flowScene(doc, CLOUD_AT, "modern", new Map([["users", icons.get("database")!]])), PALETTE, opts);
  expect(svg).toContain("<image");
  expect(svg).not.toContain(`fill="${PALETTE.iconTile}"`);
});

test("a_pale_logo_is_outlined_in_publish_with_one_filter", () => {
  const doc: FlowDoc = { ...CLOUD, nodes: CLOUD.nodes.filter((n) => n.name === "Users" || n.name === "API Gateway") };
  const data = `data:image/svg+xml;base64,${btoa(PIXEL)}`;
  const scene = flowScene(doc, CLOUD_AT, "modern", new Map([["users", { url: data, outline: true }], ["aws-api-gateway", { url: data, outline: false }], ["aws-cloud", { url: data, outline: true }]]));
  expect(scene.nodes.find((n) => n.id === "Users")!.iconOutline).toBe(true);
  expect(scene.nodes.find((n) => n.id === "API Gateway")).not.toHaveProperty("iconOutline");
  expect(scene.areas?.[0].iconOutline).toBe(true);
  const svg = sceneToSvg(scene, PALETTE, opts);
  // The filter is the only thing besides plain shapes, and it is made of filter primitives only.
  const defs = /<defs>(.*?)<\/defs>/.exec(svg)![1];
  expect(defs).not.toMatch(/<(?!\/?(filter|feMorphology|feFlood|feComposite|feMerge|feMergeNode)\b)[a-z]/i);
  expect(defs).not.toMatch(/href|url\(/i);
  plainSvg(svg.replace(/<defs>.*?<\/defs>/, ""));
  onlyTokenColours(svg);
  // One filter, in the text colour, used by the outlined images only.
  expect(svg.match(/<filter\b/g)).toHaveLength(1);
  expect(svg).toContain(`<filter id="icon-hairline"`);
  expect(svg).toContain(`flood-color="${PALETTE.text}"`);
  const images = [...svg.matchAll(/<image\b[^>]*>/g)].map((m) => m[0]);
  expect(images).toHaveLength(3);
  expect(images.filter((i) => i.includes('filter="url(#icon-hairline)"'))).toHaveLength(2);
  expect(svg).toMatch(/data-node="API Gateway">(?:(?!<\/g>).)*<image (?![^>]*filter=)/);
  // A drawing with no outlined logo has no filter.
  const plain = sceneToSvg(flowScene(doc, CLOUD_AT, "modern", new Map([["users", { url: data }]])), PALETTE, opts);
  expect(plain).not.toContain("<filter");
  expect(plain).not.toContain("filter=");
});

test("an_icon_url_that_is_not_a_data_image_is_never_drawn", () => {
  const scene = flowScene(CLOUD, CLOUD_AT, "modern", new Map([["users", { url: "javascript:alert(1)" }], ["aws-api-gateway", { url: "https://example.com/x.svg" }]]));
  const svg = sceneToSvg(scene, PALETTE, opts);
  expect(svg).not.toContain("<image");
  expect(svg).not.toContain("javascript:");
  expect(svg).not.toContain("example.com");
});

test("names_with_markup_are_text_in_the_export", () => {
  const scene = flowScene(doc('diagram dfd "x"\n"<b>&</b>" [process]\n'), { "<b>&</b>": { x: 0, y: 0 } }, "modern", new Map());
  const svg = sceneToSvg(scene, PALETTE, opts);
  expect(svg).toContain(">&lt;b&gt;&amp;&lt;/b&gt;<");
  expect(svg).not.toContain("<b>");
});

test("unplaced_nodes_are_left_out_as_on_the_canvas", () => {
  const scene = flowScene(DFD, { Customer: { x: 0, y: 0 }, Checkout: { x: 300, y: 0 } }, "modern", new Map());
  expect(scene.nodes.map((n) => n.id)).toEqual(["Customer", "Checkout"]);
  expect(scene.edges).toHaveLength(1);
});

const P = (name: string) => ({ database: "kestrel", schema: "shop", name });
const LINEAGE: Lineage = {
  center: P("orders"),
  tables: [
    {
      path: P("orders"),
      columns: [
        { name: "id", ty: "int", pk: true, fk: false, nullable: false },
        { name: "customer_id", ty: "int", pk: false, fk: true, nullable: true },
      ],
      columnCount: 6,
      distance: 0,
      unreadable: null,
    },
    { path: P("customers"), columns: [{ name: "id", ty: "int", pk: true, fk: false, nullable: false }], columnCount: 3, distance: -1, unreadable: null },
    { path: P("order_items"), columns: [], columnCount: 0, distance: 1, unreadable: "permission denied" },
  ],
  links: [
    { from: P("orders"), fromColumns: ["customer_id"], to: P("customers"), toColumns: ["id"], onDelete: "RESTRICT", onUpdate: null, nullable: true },
    { from: P("order_items"), fromColumns: ["order_id"], to: P("orders"), toColumns: ["id"], onDelete: "CASCADE", onUpdate: null, nullable: false },
  ],
  truncated: false,
};

test("lineage_export_draws_the_cards_keys_and_diagram_cards", () => {
  const refs = [{ kind: "flow" as const, title: "Checkout writes orders", file: "checkout", access: "writes" as const }];
  const ids = ['t:["kestrel","shop","orders"]', 't:["kestrel","shop","customers"]', 't:["kestrel","shop","order_items"]', "ref:0"];
  const at = { [ids[0]]: { x: 0, y: 0 }, [ids[1]]: { x: -304, y: 0 }, [ids[2]]: { x: 304, y: 0 }, [ids[3]]: { x: 0, y: 200 } };
  const scene = lineageScene(LINEAGE, refs, at);
  expect(scene.nodes.map((n) => [n.id, n.kind, n.w, n.dashed ?? false])).toEqual([
    [ids[0], "table", 214, false],
    [ids[1], "table", 214, false],
    [ids[2], "table", 214, true],
    [ids[3], "view", 214, true],
  ]);
  const orders = scene.nodes[0];
  expect(orders.rows).toEqual([
    { left: "id", right: "int", mark: "pk" },
    { left: "customer_id", right: "int ?", mark: "fk" },
    { left: "4 more columns" },
  ]);
  expect(orders.subtitle).toBe("shop");
  expect(scene.nodes[2].rows).toEqual([{ left: "permission denied" }]);
  // Key lines point at the key's table; the diagram line is dashed and points into the table it writes.
  expect(scene.edges.map((e) => [e.id, e.line ?? "solid", e.heads])).toEqual([
    ["link:0", "solid", "start"],
    ["link:1", "solid", "start"],
    ["ref:0", "dashed", "end"],
  ]);
  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  for (const t of ["orders", "customers", "order_items", "customer_id", "int ?", "4 more columns", "Checkout writes orders", "checkout"]) {
    expect(svg).toContain(`>${t}<`);
  }
  expect(svg).toMatch(/data-node="ref:0"><rect [^>]*stroke-dasharray/);
});

test("crop_snaps_to_node_and_group_edges", () => {
  const scene = flowScene(DFD, DFD_AT, "modern", new Map());
  const area = scene.areas![0];
  const bounds = sceneBounds(scene);
  const crop = { x: bounds.x, y: bounds.y, w: 500, h: 300 };
  // The right edge dragged to 3 units short of the Checkout card's right edge lands on it.
  const checkout = scene.nodes.find((n) => n.id === "Checkout")!;
  const right = checkout.x + checkout.w;
  const dragged = { ...crop, w: right - 3 - crop.x };
  expect(snapCrop(dragged, "e", sceneEdges(scene), 8)).toEqual({ ...crop, w: right - crop.x });
  // The bottom edge lands on the group's bottom.
  const low = { ...crop, h: area.y + area.h + 5 - crop.y };
  expect(snapCrop(low, "s", sceneEdges(scene), 8).h).toBe(area.y + area.h - crop.y);
  // Out of reach, nothing moves; a moved box keeps its size.
  const far = { ...crop, w: right + 40 - crop.x };
  expect(snapCrop(far, "e", sceneEdges(scene), 8)).toEqual(far);
  const moved = snapCrop({ ...crop, x: crop.x + 2 }, "move", sceneEdges(scene), 8);
  expect(moved).toEqual(crop);
});

// ----- diag-910 a state diagram in Publish (and so in the New diagram cards and the Mermaid preview,
// which share sceneToSvg) is drawn as the canvas draws it.

const STATES = doc(
  [
    'diagram state "Invoice"',
    "Draft",
    "Check [choice]",
    "Split [fork]",
    "Review {",
    "  Checking",
    "  [*] > Checking",
    "  Checking > [*]",
    "}",
    "[*] > Draft",
    "Draft > Check",
    "Check > Split",
    "Split > Review",
    "Review > [*]",
  ].join("\n"),
);

test("state_export_draws_the_start_dot_the_end_ring_pills_the_choice_diamond_and_the_fork_bar", () => {
  const at = Object.fromEntries(STATES.nodes.map((n, i) => [n.name, { x: (i % 3) * 200, y: Math.floor(i / 3) * 160 }]));
  const scene = flowScene(STATES, at, "modern", new Map());
  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  // The markers are drawn, never named: no "[*] start" text anywhere.
  expect(svg).not.toMatch(/>\[\*\][^<]*</);
  for (const name of ["[*] start", "[*] start in Review"]) expect(svg).toMatch(new RegExp(`data-node="${name.replace(/[[\]*]/g, "\\$&")}"><rect data-part="dot"`));
  for (const name of ["[*] end", "[*] end in Review"]) {
    const g = new RegExp(`data-node="${name.replace(/[[\]*]/g, "\\$&")}">((?:(?!</g>).)*)</g>`).exec(svg)![1];
    expect(g).toContain('data-part="ring"');
    expect(g).toContain('data-part="dot"');
  }
  // A state is a pill: its corners are half its height.
  const draft = scene.nodes.find((n) => n.id === "Draft")!;
  expect(svg).toMatch(new RegExp(`data-node="Draft"><rect data-part="pill" [^>]*rx="${draft.h / 2}"`));
  expect(svg).toMatch(/data-node="Check"><path data-part="diamond"/);
  expect(svg).toMatch(/data-node="Split"><rect data-part="bar"/);
  expect(svg).toContain(">Check<");
  expect(svg).not.toContain(">Split<");
});

// ----- publish-parity: sequence, class, mind map, timeline and notes in Publish (and so in the New diagram cards, which
// share flowScene and sceneToSvg) are drawn as the canvas draws them, not as plain boxes with labels.

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The inside of the `<g>` with `attr="name"` (these groups never nest). */
function part(svg: string, attr: string, name: string): string {
  const m = new RegExp(`<g ${attr}="${escRe(name)}">((?:(?!</g>).)*)</g>`).exec(svg);
  expect(m, `${attr}="${name}"`).not.toBeNull();
  return m![1];
}
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const SEQUENCE_TEXT = [
  'diagram sequence "Pay"',
  "actor Customer",
  "participant Shop",
  "participant Payments",
  "Customer -> Shop: place order",
  "activate Shop",
  "loop retry 3 times {",
  "  Shop -> Payments: charge card",
  "  Payments --> Shop: approved",
  "}",
  "deactivate Shop",
  "Shop -> Shop: log",
  "Shop --> Customer: receipt",
  "note: Cards are charged once",
].join("\n");

// The sequence restyle in Publish, from the one drawing the canvas reads. A palette with the
// presets; the colours a sequence draws besides its raw values are exactly those `seqColours` derives from it.
const SEQ_PALETTE: ExportPalette = {
  ...PALETTE,
  nodes: { ...PALETTE.nodes, participant: { fill: "#1a1a10", stroke: "#2a2a20" }, actor: { fill: "#1b1b10", stroke: "#2b2b20" } },
  colours: {
    accent: { fill: "#a10000", stroke: "#a20000", text: "#030303" },
    info: { fill: "#a30000", stroke: "#a40000", text: "#030303" },
    success: { fill: "#a50000", stroke: "#a60000", text: "#030303" },
    warning: { fill: "#a70000", stroke: "#a80000", text: "#030303" },
    danger: { fill: "#a90000", stroke: "#aa0000", text: "#030303" },
    muted: { fill: "#ab0000", stroke: "#ac0000", text: "#ad0000" },
  },
};

/** Every colour `svg` uses is a raw value of `p` or one `seqColours` derives from it for a colour `doc` names. */
function onlySeqColours(svg: string, p: ExportPalette, d: FlowDoc) {
  const raw = new Set([
    ...Object.values(p).filter((v): v is string => typeof v === "string"),
    ...Object.values(p.nodes).flatMap((n) => [n.fill, n.stroke]),
    ...Object.values(p.colours ?? {}).flatMap((c) => [c.fill, c.stroke, c.text]),
  ]);
  const derived = new Set<string>();
  const named = [undefined, ...d.nodes.map((n) => drawnColour(n.attrs.color)), ...(d.frames ?? []).map((f) => drawnColour(f.color))];
  for (const c of named)
    for (const who of ["participant", "actor", "block"] as const) {
      const s = seqColours(p, c, who);
      // Derived from the palette's line colour, never a literal: the tint over the surface and the wash over the canvas.
      expect(s.fill).toBe(c && c[0] === "#" ? s.fill : mixHex(s.line, p.surface, STRONG_TINT));
      expect(s.wash).toBe(mixHex(s.line, p.canvas, WASH));
      for (const v of Object.values(s)) derived.add(v);
    }
  const used = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]).filter((c) => c !== "none");
  expect(used.length).toBeGreaterThan(0);
  expect(used.filter((c) => !raw.has(c) && !derived.has(c))).toEqual([]);
}

const attrIn = (el: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(el)?.[1];
/** Each element of `svg` whose tag matches `tag` and that carries `data-part="p"`. */
const partsOf = (svg: string, tag: string, p: string) => [...svg.matchAll(new RegExp(`<${tag}\\b[^>]*data-part="${p}"[^>]*>`, "g"))].map((m) => m[0]);
const n2 = (v: number) => String(Math.round(v * 100) / 100);

test("sequence_export_draws_the_new_look", () => {
  const d = doc(PAY);
  const scene = flowScene(d, {}, "modern", new Map());
  const messages = buildFlowGraph(d, emptyPositions(), "modern").edges.map((e) => (e.data as SeqEdgeData).m);
  expect(messages).toHaveLength(10);
  const svg = sceneToSvg(scene, SEQ_PALETTE, opts);
  plainSvg(svg);
  onlySeqColours(svg, SEQ_PALETTE, d);
  for (const name of ["Customer", "Web app", "Billing API", "Card provider", "Database"]) {
    const g = part(svg, "data-node", name);
    // Its head and foot boxes, and one solid lifeline in its colour.
    expect(count(g, /data-part="lifehead"/g), name).toBe(2);
    expect(count(g, /data-part="lifeline"/g), name).toBe(1);
    expect(partsOf(g, "path", "lifeline")[0]).not.toContain("stroke-dasharray");
    expect(count(g, new RegExp(`>${escRe(name)}<`, "g")), name).toBe(2);
  }
  // Billing API's lifeline, outline and bars in accent; its fill the derived tint.
  const billing = part(svg, "data-node", "Billing API");
  const accent = seqColours(SEQ_PALETTE, "accent", "participant");
  expect(attrIn(partsOf(billing, "path", "lifeline")[0], "stroke")).toBe(accent.line);
  for (const head of partsOf(billing, "rect", "lifehead")) expect([attrIn(head, "fill"), attrIn(head, "stroke")]).toEqual([accent.fill, accent.line]);
  expect(count(billing, /data-part="activation"/g)).toBe(1);
  // Each message's path is the drawing's, its label sized as measured.
  for (const m of messages) {
    const e = part(svg, "data-edge", `edge:${m.index}`);
    expect(attrIn(partsOf(e, "path", "message")[0], "d")).toBe(messagePath(m, 0, 0));
    if (m.label) {
      const words = new RegExp(`<text\\b[^>]*>${escRe(m.label.text)}</text>`).exec(e)![0];
      expect(attrIn(words, "textLength")).toBe(n2(m.label.w));
      expect(attrIn(words, "lengthAdjust")).toBe("spacingAndGlyphs");
    }
  }
  // Ten numbers, 1 to 10, each on its sender's lifeline.
  expect([...svg.matchAll(/<text\b[^>]*data-part="number-text"[^>]*>(\d+)<\/text>/g)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // The opt block: its caption on a chip, its kind word turned a quarter.
  expect(count(svg, /data-frame-tab="/g)).toBe(1);
  expect(part(svg, "data-frame-tab", "0")).toContain(">card saved<");
  expect(part(svg, "data-frame", "0")).toMatch(/<text transform="rotate\(-90 [-\d.]+ [-\d.]+\)"[^>]*>opt<\/text>/);
  // Paint order: blocks, participants, messages, captions.
  expect(svg.indexOf('data-frame="0"')).toBeLessThan(svg.indexOf('data-node="Customer"'));
  expect(svg.indexOf('data-node="Database"')).toBeLessThan(svg.indexOf('data-edge="edge:0"'));
  expect(svg.indexOf('data-edge="edge:9"')).toBeLessThan(svg.indexOf('data-frame-tab="0"'));
});

// What the old sequence test held, written for the new look: replies, calls, the actor, the bars, the note, the order.
test("sequence_export_keeps_replies_calls_the_actor_activations_the_note_and_the_order", () => {
  const scene = flowScene(doc(SEQUENCE_TEXT), {}, "modern", new Map());
  const svg = sceneToSvg(scene, SEQ_PALETTE, opts);
  plainSvg(svg);
  const edge = (i: number) => part(svg, "data-edge", `edge:${i}`);
  const line = (i: number) => partsOf(edge(i), "path", "message")[0];
  // A reply (message 2, 4 is the receipt) is dashed and ends in an open head; a call is solid with a filled head.
  for (const i of [2, 4]) {
    expect(line(i), `reply ${i}`).toContain('stroke-dasharray="5 4"');
    expect(edge(i), `reply ${i}`).toContain('data-marker="open"');
    expect(edge(i), `reply ${i}`).not.toContain('data-marker="arrow"');
  }
  for (const i of [0, 1, 3]) {
    expect(line(i), `call ${i}`).not.toContain("stroke-dasharray");
    expect(edge(i), `call ${i}`).toContain('data-marker="arrow"');
    expect(edge(i), `call ${i}`).not.toContain('data-marker="open"');
  }
  // The actor is a person; a participant is not.
  expect(part(svg, "data-node", "Customer")).toContain('data-part="person"');
  expect(part(svg, "data-node", "Shop")).not.toContain('data-part="person"');
  expect(part(svg, "data-node", "Payments")).not.toContain('data-part="person"');
  // One activation bar on Shop, none on Payments.
  expect(count(part(svg, "data-node", "Shop"), /data-part="activation"/g)).toBe(1);
  expect(count(part(svg, "data-node", "Payments"), /data-part="activation"/g)).toBe(0);
  // The note is filled in the note pair.
  const note = partsOf(part(svg, "data-node", "Note 1"), "rect", "note")[0];
  expect([attrIn(note, "fill"), attrIn(note, "stroke")]).toEqual([SEQ_PALETTE.nodes.note.fill, SEQ_PALETTE.nodes.note.stroke]);
  // Messages run down the rows in the order written.
  const ys = scene.edges.map((e) => e.points[0].y);
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  expect(new Set(ys).size).toBe(5);
});

test("label_chips_cover_crossing_lifelines", () => {
  const long = "x".repeat(60);
  const d = doc(['diagram sequence "Wide"', "participant A", "participant B", "participant C", "participant D", `A -> D: ${long}`].join("\n"));
  const svg = sceneToSvg(flowScene(d, {}, "modern", new Map()), SEQ_PALETTE, opts);
  plainSvg(svg);
  const lane = (name: string) => {
    const el = partsOf(part(svg, "data-node", name), "path", "lifeline")[0];
    return { at: svg.indexOf(el), x: Number(/^M([-\d.]+)/.exec(attrIn(el, "d")!)![1]) };
  };
  const edge = part(svg, "data-edge", "edge:0");
  const chip = partsOf(edge, "rect", "chip")[0];
  const [x, w] = [Number(attrIn(chip, "x")), Number(attrIn(chip, "width"))];
  for (const name of ["B", "C"]) {
    const l = lane(name);
    // Drawn after the lifeline it crosses, and over it.
    expect(svg.indexOf(chip), name).toBeGreaterThan(l.at);
    expect(x, name).toBeLessThan(l.x);
    expect(x + w, name).toBeGreaterThan(l.x);
  }
  expect(attrIn(chip, "fill")).toBe(SEQ_PALETTE.canvas);
});

test("canvas_and_publish_share_one_drawing", () => {
  // Review Focus 3 too: a long self-message on the last participant, inside an opt.
  const selfLast = ['diagram sequence "Self"', "autonumber", "participant A", "participant B", "A -> B: go", "opt checks {", `  B -> B: ${"check every card on the account".repeat(2)}`, "}"].join("\n");
  // A caption much wider than its two-participant block: the block grows to hold it.
  const longCaption = ['diagram sequence "Caption"', "participant A", "participant B", "loop retry every card on the account until one of them works {", "  A -> B: go", "}"].join("\n");
  for (const text of [PAY, selfLast, longCaption])
    for (const k of [0.88, 1, 1.15]) {
      const d = doc(text);
      const g = buildFlowGraph(d, emptyPositions(), "modern", { textScale: k });
      const scene = flowScene(d, {}, "modern", new Map(), undefined, undefined, { textScale: k });
      const where = `${text === PAY ? "Pay" : text === selfLast ? "Self" : "Caption"} ${k}`;
      for (const e of g.edges) {
        const m = (e.data as SeqEdgeData).m;
        const s = scene.edges.find((x) => x.id === e.id)!;
        expect(s, `${where} ${e.id}`).toBeDefined();
        expect(s.points, `${where} ${e.id}`).toEqual(m.points);
        expect(s.path, `${where} ${e.id}`).toBe(m.d);
        expect(s.label, `${where} ${e.id}`).toBe(m.label?.text);
        expect(s.labelW, `${where} ${e.id}`).toBe(m.label?.w);
        expect(s.chip, `${where} ${e.id}`).toEqual(m.label?.chip);
        expect(s.chipBg, `${where} ${e.id}`).toBe(m.label?.bg);
        expect(s.number && { n: s.number.n, x: s.number.x, y: s.number.y, w: s.number.w }, `${where} ${e.id}`).toEqual(m.number && { n: m.number.n, x: m.number.x, y: m.number.y, w: m.number.w });
      }
      const box = (n: (typeof g.nodes)[number]) => ({ x: n.position.x, y: n.position.y, w: Number(n.style!.width), h: Number(n.style!.height) });
      for (const n of g.nodes.filter((x) => x.id.startsWith("\u0000frame:"))) {
        const b = n.data.block as SeqBlock;
        const f = scene.frames![b.index];
        expect({ x: f.x, y: f.y, w: f.w, h: f.h }, `${where} ${n.id}`).toEqual(box(n));
        expect(f.tab, `${where} ${n.id}`).toEqual(b.tab);
        expect(f.captionBox, `${where} ${n.id}`).toEqual(b.captionBox ?? undefined);
        expect([f.kind, f.caption, f.word, f.wordW], `${where} ${n.id}`).toEqual([b.kind, b.caption, b.word, b.wordW]);
      }
      // Each participant is its canvas node, the whole lane high, its foot where the lanes end.
      const lanes = g.nodes.find((x) => x.id === "\u0000lanes")!;
      for (const n of g.nodes.filter((x) => x.type === "kind")) {
        const s = scene.nodes.find((x) => x.id === n.id)!;
        expect({ x: s.x, y: s.y, w: s.w, h: s.h }, `${where} ${n.id}`).toEqual(box(n));
        expect(s.foot, `${where} ${n.id}`).toBe((lanes.data as { lanes: { bottom: number }[] }).lanes[0].bottom - n.position.y);
      }
      // Everything Publish draws lies inside the canvas's own boxes: chips and numbers inside the lanes node.
      const lb = box(lanes);
      const inside = (b: { x: number; y: number; w: number; h: number }, what: string) => {
        expect(b.x, what).toBeGreaterThanOrEqual(lb.x - 0.01);
        expect(b.y, what).toBeGreaterThanOrEqual(lb.y - 0.01);
        expect(b.x + b.w, what).toBeLessThanOrEqual(lb.x + lb.w + 0.01);
        expect(b.y + b.h, what).toBeLessThanOrEqual(lb.y + lb.h + 0.01);
      };
      for (const e of scene.edges) {
        if (e.chip) inside(e.chip, `${where} ${e.id} chip`);
        if (e.number) inside({ x: e.number.x - e.number.w / 2, y: e.number.y - 10 * k, w: e.number.w, h: 20 * k }, `${where} ${e.id} number`);
      }
      // Captions sit inside their block's outline, inside the lanes node and inside the Publish bounds.
      const all = sceneBounds(scene);
      for (const f of scene.frames ?? []) {
        if (!f.captionBox) continue;
        const c = f.captionBox;
        const what = `${where} caption ${f.caption}`;
        expect(c.x + c.w, what).toBeLessThanOrEqual(f.x + f.w + 0.01);
        inside(c, what);
        expect(c.x, what).toBeGreaterThanOrEqual(all.x - 0.01);
        expect(c.x + c.w, what).toBeLessThanOrEqual(all.x + all.w + 0.01);
      }
      inside(sceneBounds({ ...scene, nodes: scene.nodes.filter((n) => n.kind !== "note") }), `${where} bounds`);
    }
});

test("publish_keeps_a_long_block_caption_inside_the_image", () => {
  const caption = "retry every card on the account until one of them works";
  const d = doc(['diagram sequence "Caption"', "participant A", "participant B", `loop ${caption} {`, "  A -> B: go", "}"].join("\n"));
  const scene = flowScene(d, {}, "modern", new Map());
  const c = scene.frames![0].captionBox!;
  const b = sceneBounds(scene);
  // The crop holds the whole caption chip, not only the block's old outline.
  expect(c.x + c.w).toBeLessThanOrEqual(b.x + b.w);
  const svg = sceneToSvg(scene, SEQ_PALETTE, { ...opts, padding: 0 });
  expect(part(svg, "data-frame-tab", "0")).toContain(`>${caption}<`);
  const [vx, , vw] = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(svg)!.slice(1).map(Number);
  expect(c.x).toBeGreaterThanOrEqual(vx);
  expect(c.x + c.w).toBeLessThanOrEqual(vx + vw);
});

test("publish_shows_the_label_like_the_canvas", () => {
  const d = doc(['diagram sequence "Login"', 'participant App [label: "Mobile app"]', "participant Server", "App -> Server: hi"].join("\n"));
  const svg = sceneToSvg(flowScene(d, {}, "modern", new Map()), SEQ_PALETTE, opts);
  const app = part(svg, "data-node", "App");
  expect(count(app, /data-part="lifehead"/g)).toBe(2);
  expect(count(app, />Mobile app</g)).toBe(2);
  expect(svg).not.toContain(">App<");
  expect(count(part(svg, "data-node", "Server"), />Server</g)).toBe(2);
});

test("participant_icons_publish_once_each", () => {
  const d = doc(['diagram sequence "Fns"', "participant Fn [icon: aws-lambda]", "participant Fn2 [icon: aws-lambda]", "participant Gone [icon: aws-nope]", "Fn -> Fn2: call", "Fn2 -> Gone: on"].join("\n"));
  expect(sceneIconNames(d).sort()).toEqual(["aws-lambda", "aws-nope"]);
  const url = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;
  const scene = flowScene(d, {}, "modern", new Map([["aws-lambda", { url }]]));
  expect(scene.nodes.find((n) => n.id === "Fn")).toMatchObject({ icon: url, iconName: "aws-lambda" });
  const refs = iconRefs();
  const body = sceneBody(scene, SEQ_PALETTE, refs);
  const defs = svgDefs(SEQ_PALETTE, { hairline: null, icons: refs.entries() });
  expect(count(defs, /<image /g)).toBe(1);
  expect(count(body, /<use /g)).toBe(4);
  expect(body).not.toContain("<image ");
  for (const name of ["Fn", "Fn2"]) expect(count(part(body, "data-node", name), /<use /g), name).toBe(2);
  // The one the pack lacks: the dashed cube tile in both boxes.
  const gone = part(body, "data-node", "Gone");
  expect(partsOf(gone, "rect", "icon-tile")).toHaveLength(2);
  for (const tile of partsOf(gone, "rect", "icon-tile")) expect(tile).toContain("stroke-dasharray");
});

test("the_sequence_card_is_drawn_by_the_publish_path", () => {
  const svg = exampleSvg(SEQUENCE_TEXT, PALETTE);
  expect(svg).toContain('data-node="Customer"');
  expect(svg).toContain('data-part="lifeline"');
  // The new look: head and foot boxes, a solid lifeline, the caption on its chip.
  expect(count(part(svg, "data-node", "Customer"), /data-part="lifehead"/g)).toBe(2);
  expect(svg).not.toMatch(/data-part="lifeline"[^>]*stroke-dasharray/);
  expect(svg).toContain('data-frame-tab="0"');
  expect(part(svg, "data-frame-tab", "0")).toContain(">retry 3 times<");
  expect(svg).toContain('width="100%"');
});

const CLASSES = doc(
  [
    'diagram class "Billing"',
    "interface Payable",
    "Payable : pay(amount)",
    "class Invoice",
    "Invoice : + id: int",
    "Invoice : + total: numeric",
    "Invoice : + send()",
    "enum InvoiceStatus",
    "InvoiceStatus : DRAFT",
    "InvoiceStatus : PAID",
    "class LineItem",
    "LineItem : + qty: int",
    "class Mailer",
    "note: Totals include tax",
    "Payable <|-- Invoice",
    "Invoice *-- LineItem: lines",
    "Invoice --> InvoiceStatus",
    "Invoice ..> Mailer",
    "LineItem -- Mailer",
  ].join("\n"),
);

test("class_export_draws_name_bands_stereotypes_member_rows_and_the_line_ends", () => {
  const at = Object.fromEntries(CLASSES.nodes.map((n, i) => [n.name, { x: (i % 3) * 400, y: Math.floor(i / 3) * 300 }]));
  const scene = flowScene(CLASSES, at, "modern", new Map());
  expect(scene.nodes.map((n) => [n.id, n.kind])).toEqual([
    ["Payable", "interface"],
    ["Invoice", "class"],
    ["InvoiceStatus", "enum"],
    ["LineItem", "class"],
    ["Mailer", "class"],
    ["Note 1", "note"],
  ]);
  expect(scene.edges.map((e) => [e.marks ?? null, e.line ?? "solid"])).toEqual([
    [{ start: "triangle" }, "solid"],
    [{ start: "diamond" }, "solid"],
    [{ end: "arrow" }, "dashed"],
    [{ end: "open" }, "dotted"],
    [null, "solid"],
  ]);
  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  // A class: its name in the band, then fields, a rule, then methods, in the code font.
  const invoice = part(svg, "data-node", "Invoice");
  expect(invoice).toMatch(new RegExp(`data-part="band"[^>]*fill="${PALETTE.nodes.class.fill}"`));
  expect(invoice).toContain(">Invoice<");
  expect(invoice).toContain('data-part="divider"');
  expect(invoice).not.toContain("«");
  for (const r of ["+ id: int", "+ total: numeric", "+ send()"]) expect(invoice).toMatch(new RegExp(`<text [^>]*font-family="[^"]*monospace[^"]*"[^>]*>${escRe(r)}<`));
  expect(invoice.indexOf(">+ total: numeric<")).toBeLessThan(invoice.indexOf('data-part="divider"'));
  expect(invoice.indexOf('data-part="divider"')).toBeLessThan(invoice.indexOf(">+ send()<"));
  // An interface is dashed and says so; an enum lists its values with no methods part.
  const payable = part(svg, "data-node", "Payable");
  expect(payable).toContain(">«interface»<");
  expect(payable).toMatch(/data-part="outline"[^>]*stroke-dasharray/);
  const status = part(svg, "data-node", "InvoiceStatus");
  expect(status).toContain(">«enum»<");
  expect(status).not.toContain('data-part="divider"');
  expect(status).toContain(">PAID<");
  // The line ends: a hollow triangle at the parent, a filled diamond at the whole, a filled head, an open head.
  const inherit = scene.edges[0].points[0];
  expect(part(svg, "data-edge", "edge:0")).toMatch(new RegExp(`data-marker="triangle" d="M${inherit.x} ${inherit.y} [^"]*"[^>]*fill="${PALETTE.canvas}"[^>]*stroke="${PALETTE.subtle}"`));
  expect(part(svg, "data-edge", "edge:1")).toMatch(new RegExp(`data-marker="diamond"[^>]*fill="${PALETTE.subtle}"`));
  expect(part(svg, "data-edge", "edge:1")).toContain(">lines<");
  expect(part(svg, "data-edge", "edge:2")).toMatch(/stroke-dasharray="5 4"/);
  expect(part(svg, "data-edge", "edge:2")).toContain('data-marker="arrow"');
  expect(part(svg, "data-edge", "edge:3")).toMatch(/stroke-dasharray="1 4"/);
  expect(part(svg, "data-edge", "edge:3")).toMatch(/data-marker="open"[^>]*fill="none"/);
  expect(part(svg, "data-edge", "edge:4")).not.toContain("data-marker");
  expect(part(svg, "data-node", "Note 1")).toContain('data-part="note"');
});

const MIND = doc(['diagram mindmap "Plan"', "root Q4 plan", "  Diagrams", "    New kinds", "  Redis", "  Release", "note: Dates are rough"].join("\n"));

test("mind_map_export_draws_the_root_pill_branch_topics_plain_subtopics_and_curved_tree_lines", () => {
  const scene = flowScene(MIND, {}, "modern", new Map());
  const box = (id: string) => scene.nodes.find((n) => n.id === id)!;
  expect(scene.nodes.map((n) => [n.id, n.kind, n.depth ?? 0])).toEqual([
    ["Q4 plan", "root", 0],
    ["Diagrams", "topic", 1],
    ["New kinds", "topic", 2],
    ["Redis", "topic", 1],
    ["Release", "topic", 1],
    ["Note 1", "note", 0],
  ]);
  expect(scene.edges.map((e) => e.kind)).toEqual(["branch", "branch", "branch", "branch"]);
  // A branch leaves the side of its parent that faces the child: Release sits on the left.
  const root = box("Q4 plan");
  const release = scene.edges.find((e) => e.id === "edge:3")!;
  expect(release.points[0]).toEqual({ x: root.x, y: root.y + root.h / 2 });
  expect(release.points[release.points.length - 1].x).toBe(box("Release").x + box("Release").w);

  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  expect(part(svg, "data-node", "Q4 plan")).toMatch(new RegExp(`<rect data-part="pill" [^>]*rx="${root.h / 2}"[^>]*fill="${PALETTE.nodes.root.fill}"[^>]*stroke-width="2"`));
  expect(part(svg, "data-node", "Q4 plan")).toMatch(/font-size="15"[^>]*>Q4 plan</);
  expect(part(svg, "data-node", "Diagrams")).toMatch(new RegExp(`<rect data-part="pill" [^>]*fill="${PALETTE.nodes.topic.fill}"`));
  // A subtopic is plain words on a line.
  const sub = part(svg, "data-node", "New kinds");
  expect(sub).not.toContain("<rect");
  expect(sub).toContain('data-part="underline"');
  for (const id of ["edge:0", "edge:1", "edge:2", "edge:3"]) {
    const g = part(svg, "data-edge", id);
    expect(g).toMatch(/d="M[^"]* C /);
    expect(g).not.toContain("data-marker");
  }
  expect(part(svg, "data-node", "Note 1")).toContain('data-part="note"');
});

test("a_folded_topic_publishes_folded_as_the_canvas_shows_it", () => {
  const scene = flowScene(MIND, {}, "modern", new Map(), undefined, new Set(["Diagrams"]));
  expect(scene.nodes.map((n) => n.id)).not.toContain("New kinds");
  expect(scene.edges).toHaveLength(3);
});

const TIMELINE = doc(
  [
    'diagram timeline "Release"',
    "section Making",
    "2026-09-01 to 2026-10-15: Build",
    "2026-10-19: Beta",
    "section Shipping",
    "2026-11-09: Release candidate",
    "milestone Launch",
  ].join("\n"),
);

test("timeline_export_draws_the_axis_ticks_dated_events_period_bars_milestones_and_sections", () => {
  const scene = flowScene(TIMELINE, {}, "modern", new Map());
  expect(scene.nodes.map((n) => [n.id, n.kind])).toEqual([
    ["Build", "period"],
    ["Beta", "event"],
    ["Release candidate", "event"],
    ["Launch", "milestone"],
  ]);
  expect(scene.axis?.ticks.map((t) => t.milestone)).toEqual([false, false, false, true]);
  expect(scene.sections?.map((s) => s.name)).toEqual(["Making", "Shipping"]);
  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  const axis = part(svg, "data-axis", "time");
  expect(axis).toMatch(new RegExp(`data-part="axis"[^>]*fill="${PALETTE.strongBorder}"`));
  expect(count(axis, /data-part="tick"/g)).toBe(3);
  expect(count(axis, /data-part="tick-milestone"/g)).toBe(1);
  // The ticks sit where each item meets the axis.
  const beta = scene.nodes.find((n) => n.id === "Beta")!;
  expect(scene.axis!.ticks[1].x).toBe(beta.x + beta.w / 2);
  for (const name of ["Making", "Shipping"]) {
    const sec = part(svg, "data-section", name);
    expect(sec).toMatch(/<rect [^>]*stroke-dasharray/);
    expect(sec).toContain(`>${name}<`);
  }
  expect(svg.indexOf('data-section="Making"')).toBeLessThan(svg.indexOf('data-node="Build"'));
  // A period is a pill with its two dates; an event its date; a milestone a heavier edge.
  const build = scene.nodes.find((n) => n.id === "Build")!;
  expect(part(svg, "data-node", "Build")).toMatch(new RegExp(`<rect [^>]*rx="${build.h / 2}"[^>]*fill="${PALETTE.nodes.period.fill}"`));
  expect(part(svg, "data-node", "Build")).toContain(">2026-09-01 to 2026-10-15<");
  expect(part(svg, "data-node", "Beta")).toContain(">2026-10-19<");
  expect(part(svg, "data-node", "Launch")).toMatch(/<rect [^>]*stroke-width="2"/);
  expect(part(svg, "data-node", "Launch")).toContain(">Milestone<");
});

test("a_note_is_the_sticky_note_shape_in_every_kind_that_has_notes", () => {
  const long = "Stock is checked against the warehouse feed every hour";
  const texts: Record<string, string> = {
    flow: 'diagram flow "n"\nA\n',
    state: 'diagram state "n"\nA\n',
    class: 'diagram class "n"\nclass A\n',
    sequence: 'diagram sequence "n"\nparticipant A\n',
    mindmap: 'diagram mindmap "n"\nroot A\n',
  };
  for (const [kind, head] of Object.entries(texts)) {
    const d = doc(`${head}note: ${long}\n`);
    const at = Object.fromEntries(d.nodes.map((n, i) => [n.name, { x: 0, y: i * 200 }]));
    const scene = flowScene(d, at, "modern", new Map());
    const note = scene.nodes.find((n) => n.id === "Note 1")!;
    expect(note.kind, kind).toBe("note");
    const svg = sceneToSvg(scene, PALETTE, opts);
    plainSvg(svg);
    const g = part(svg, "data-node", "Note 1");
    expect(g, kind).toMatch(new RegExp(`<rect data-part="note" [^>]*rx="2"[^>]*fill="${PALETTE.nodes.note.fill}"[^>]*stroke="${PALETTE.nodes.note.stroke}"`));
    // Wrapped to the note's width, as many lines as its height holds, starting at the left.
    expect(count(g, /<text /g), kind).toBe((note.h - 20) / 18);
    expect(g.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toBe(long);
    expect(g).not.toContain('text-anchor="middle"');
  }
});

test("flowchart_document_and_database_have_their_curved_foot_and_cylinder", () => {
  const d = doc('diagram flow "n"\nReport [document]\nLedger [database]\n');
  const scene = flowScene(d, { Report: { x: 0, y: 0 }, Ledger: { x: 300, y: 0 } }, "modern", new Map());
  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  expect(part(svg, "data-node", "Report")).toMatch(/data-part="document"[^>]* d="[^"]*[QC]/);
  expect(part(svg, "data-node", "Ledger")).toMatch(/<rect data-part="cylinder" [^>]*ry="10"/);
});

test("publish_draws_a_dotted_line", () => {
  const doc = parseFlow(["diagram flow \"Dots\"", "A", "B", "C", "A --> B", "B -- C"].join("\n")).doc!;
  const scene = flowScene(doc, { A: { x: 0, y: 0 }, B: { x: 300, y: 0 }, C: { x: 600, y: 0 } }, "modern", new Map());
  expect(scene.edges.map((e) => [e.line, e.heads])).toEqual([
    ["dashed", "end"],
    ["dashed", "none"],
  ]);
  const svg = sceneToSvg(scene, PALETTE, opts);
  const dash = (id: string) => new RegExp(`data-edge="${id}"><path [^>]*stroke-dasharray="([^"]+)"`).exec(svg)?.[1];
  expect(dash("edge:1")).toBeDefined();
  expect(dash("edge:1")).toBe(dash("edge:0"));
  expect(svg.match(/data-marker="head"/g)).toHaveLength(1);
});

test("publish_keeps_a_class_dash_dash_solid", () => {
  const doc = parseFlow(["diagram class \"Types\"", "class A", "class B", "A -- B"].join("\n")).doc!;
  const scene = flowScene(doc, { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } }, "modern", new Map());
  expect(scene.edges.map((e) => [e.line ?? "solid", e.heads])).toEqual([["solid", "none"]]);
  expect(sceneToSvg(scene, PALETTE, opts)).not.toMatch(/data-edge="edge:0"><path [^>]*stroke-dasharray/);
});

test("publish_draws_er_cards_and_relationships", () => {
  const er = doc(
    [
      'diagram er "Billing"',
      "customers {",
      "  id int pk",
      "  email text not null",
      "  note text",
      "}",
      "orders [weak] {",
      "  id int pk",
      "  customer_id int",
      "}",
      "orders.customer_id > customers.id",
      "customers < orders",
      "customers - orders",
      "customers <> orders",
    ].join("\n"),
  );
  const at = { customers: { x: 0, y: 0 }, orders: { x: 500, y: 0 } };
  const scene = flowScene(er, at, "modern", new Map());
  // Each table is a card with its rows: the name, the type on the right, the key marked and not null said.
  expect(scene.nodes.map((n) => [n.id, n.kind, n.title])).toEqual([
    ["customers", "table", "customers"],
    ["orders", "table", "orders"],
  ]);
  expect(scene.nodes[0].rows).toEqual([
    { left: "id", right: "int", mark: "pk", notNull: true },
    { left: "email", right: "text", notNull: true },
    { left: "note", right: "text", notNull: false },
  ]);
  // A relationship between columns meets each card at its column's row; a table-to-table one at the header.
  const [cols, oneMany, oneOne, manyMany] = scene.edges;
  const orders = scene.nodes[1];
  const customers = scene.nodes[0];
  expect(cols.points[0]).toEqual({ x: orders.x, y: orders.y + ER_ROW_MID + KIND_ROW });
  expect(cols.points[cols.points.length - 1]).toEqual({ x: customers.x + customers.w, y: customers.y + ER_ROW_MID });
  // Crow's-foot ends: one end a bar, many a crow's foot, read from the first end to the second.
  expect(scene.edges.map((e) => e.marks)).toEqual([
    { start: "many", end: "one" },
    { start: "one", end: "many" },
    { start: "one", end: "one" },
    { start: "many", end: "many" },
  ]);
  expect(oneMany.heads).toBe("none");
  expect(oneOne.heads).toBe("none");
  expect(manyMany.heads).toBe("none");
  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  onlyTokenColours(svg);
  const card = part(svg, "data-node", "customers");
  expect(card).toContain(">email<");
  expect(card).toContain(">text<");
  expect(card).toContain(">PK<");
  // Not null is the filled diamond, nullable the outline.
  expect(card.match(/data-marker="not-null"/g)).toHaveLength(2);
  expect(card.match(/data-marker="nullable"/g)).toHaveLength(1);
  const edge0 = part(svg, "data-edge", "edge:0");
  expect(edge0).toContain('data-marker="crow"');
  expect(edge0).toContain('data-marker="bar"');
  expect(edge0).not.toContain('data-marker="head"');
  expect(part(svg, "data-edge", "edge:3").match(/data-marker="crow"/g)).toHaveLength(2);
  expect(part(svg, "data-edge", "edge:2").match(/data-marker="bar"/g)).toHaveLength(2);
});

test("publish_keeps_an_er_tables_colour_label_weak_dash_and_nullable_marks", () => {
  const er = doc(
    [
      'diagram er "Billing"',
      "customers [color: #cc2200, label: Customers] {",
      "  email text",
      "  note text",
      "}",
      "order_lines [weak] {",
      "  id int pk",
      "}",
      "order_lines.id > customers.email [color: #cc2200]",
    ].join("\n"),
  );
  const scene = flowScene(er, { customers: { x: 0, y: 0 }, order_lines: { x: 500, y: 0 } }, "modern", new Map());
  const [customers, lines] = scene.nodes;
  expect([customers.title, customers.color, customers.dashed ?? false]).toEqual(["Customers", "#cc2200", false]);
  expect([lines.title, lines.dashed]).toEqual(["order_lines", true]);
  // Every ER row says whether it is null, so a card of nullable columns still draws its outlines.
  expect(customers.rows.map((r) => r.notNull)).toEqual([false, false]);
  const svg = sceneToSvg(scene, PALETTE, opts);
  plainSvg(svg);
  const card = part(svg, "data-node", "customers");
  expect(card).toContain(">Customers<");
  expect(card).toMatch(/<rect [^>]*stroke="#cc2200"/);
  expect(card.match(/data-marker="nullable"/g)).toHaveLength(2);
  expect(card).not.toContain('data-marker="not-null"');
  expect(part(svg, "data-node", "order_lines")).toMatch(/<rect [^>]*stroke-dasharray="5 4"/);
  // A coloured relationship's crow's foot and bar take its colour.
  const edge = part(svg, "data-edge", "edge:0");
  expect(edge).toMatch(/data-marker="crow"[^>]*stroke="#cc2200"/);
  expect(edge).toMatch(/data-marker="bar"[^>]*stroke="#cc2200"/);
});

// ----- B4 A10: Publish reads the doc, never the canvas's ER state: a long table publishes every row, unscrolled.

/** The y of a path's last point. */
const endY = (d: string) => Number(/(-?[\d.]+)\s*$/.exec(d.trim())![1]);

test("a_long_table_publishes_every_row", () => {
  // At Small, Medium and Large: the card, its rows and its line ends scale together.
  for (const k of [0.88, 1, 1.15]) {
    for (const n of [30, 5]) {
      const target = Math.min(25, n - 1);
      const cols = Array.from({ length: n }, (_, i) => `  c${i} int${i === 0 ? " pk" : ""}`);
      const er = doc(['diagram er "Long"', "wide {", ...cols, "}", "other {", "  id int pk", "}", `other.id > wide.c${target}`].join("\n"));
      const scene = flowScene(er, { wide: { x: 400, y: 100 }, other: { x: 0, y: 0 } }, "modern", new Map(), undefined, undefined, k === 1 ? {} : { textScale: k });
      const at = `k ${k}, ${n} rows`;
      const m = erMetrics(k);
      const wide = scene.nodes.find((x) => x.id === "wide")!;
      expect(wide.h, at).toBe(erCardH(n, k));
      if (k === 1) expect(wide.h).toBe(ER_CARD_CHROME + n * KIND_ROW);
      const middle = (i: number) => wide.y + m.mid + i * m.row;
      // The last row's middle is inside the card.
      expect(middle(n - 1), at).toBeLessThan(wide.y + wide.h);
      // The line meets its column's row, not the card's bottom edge: in the scene and in the image.
      const line = scene.edges[0];
      expect(line.points[line.points.length - 1].y, at).toBeCloseTo(middle(target), 9);
      const svg = sceneToSvg(scene, PALETTE, opts);
      plainSvg(svg);
      expect(endY(/<path d="([^"]+)"/.exec(part(svg, "data-edge", "edge:0"))![1]), at).toBeCloseTo(middle(target), 2);
      const card = part(svg, "data-node", "wide");
      const rect = /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/.exec(card)!;
      const [top, h] = [Number(rect[2]), Number(rect[4])];
      expect(h).toBe(wide.h);
      for (let i = 0; i < n; i++) {
        const row = new RegExp(`<text x="[^"]+" y="([^"]+)">c${i}<`).exec(card);
        expect(row, `${at}, c${i}`).not.toBeNull();
        const y = Number(row![1]);
        expect(y, `${at}, c${i}`).toBeGreaterThan(top + m.head);
        expect(y, `${at}, c${i}`).toBeLessThan(top + h);
        // On the canvas row's middle (4 px at the text size above the words), where the line meets it.
        expect(y - 4 * k, `${at}, c${i}`).toBeCloseTo(middle(i), 2);
      }
    }
  }
});

test("publish_reads_no_live_er_state", () => {
  for (const [name, source] of [["flowScene.ts", flowSceneSource], ["svg.ts", svgSource]] as const) {
    expect(source, name).not.toMatch(/from\s+["'][^"']*\b(erScroll|erCanvas|kindNodes)\b[^"']*["']/);
  }
});
