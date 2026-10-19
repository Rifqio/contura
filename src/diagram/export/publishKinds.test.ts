// Publish for every diagram kind (spec 6+ section 8): data flow in Modern and Classic, flowcharts, cloud with
// its icons drawn unchanged, and lineage, all through the one scene and sceneToSvg.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Lineage } from "../../api/types";
import { flowScene, loadSceneIcons, sceneIconNames } from "../../flow/flowScene";
import { nodeSize } from "../../flow/flowNodes";
import { resetIcons } from "../../flow/icons";
import { parseFlow } from "../../lang/flow/parse";
import type { FlowDoc } from "../../lang/flow/model";
import { lineageScene } from "../../lineage/scene";
import { callsTo, routeInvoke } from "../../test/invoke";
import { NODE_TOKENS } from "../types";
import type { ExportPalette } from "./palette";
import { snapCrop } from "./PublishDialog";
import { sceneBounds } from "./scene";
import { sceneToSvg } from "./svg";

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
/** Only plain shapes, text and images: no foreignObject, script or style, and images only from data:image/. */
function plainSvg(svg: string) {
  expect(svg).not.toMatch(/<(?!\/?(svg|g|rect|text|tspan|path|image)\b)[a-z]/i);
  for (const m of svg.matchAll(/<image\b[^>]*\bhref="([^"]*)"/g)) expect(m[1]).toMatch(/^data:image\//);
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
  const icons = await loadSceneIcons(sceneIconNames(CLOUD));
  expect(callsTo("icon").map((c) => c.name).sort()).toEqual(["aws-api-gateway", "aws-cloud", "aws-nothing", "aws-sqs", "users"]);
  expect([...icons.keys()].sort()).toEqual(["aws-api-gateway", "aws-cloud", "users"]);

  const scene = flowScene(CLOUD, CLOUD_AT, "modern", icons);
  const gateway = scene.nodes.find((n) => n.id === "API Gateway")!;
  expect(gateway).toMatchObject({ kind: "service", iconName: "aws-api-gateway", plate: false, w: 104, h: 72 });
  expect(scene.nodes.find((n) => n.id === "Users")!.plate).toBe(true);
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
  // Each icon is an image whose data decodes to the pack's own bytes: never inline markup (ruling P9).
  const images = [...svg.matchAll(/<image\b[^>]*\bhref="data:image\/svg\+xml;base64,([^"]+)"/g)].map((m) =>
    new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))),
  );
  expect(images.sort()).toEqual([LUCIDE, PIXEL, PIXEL].sort());
  expect(svg).not.toContain("<title>Gateway");
  expect(svg).not.toContain("currentColor");
  // An icon that could not be read draws the dashed cube tile; the plate sits behind the general icon.
  expect(svg).toMatch(/data-node="Ghost"><rect [^>]*stroke-dasharray/);
  expect(svg).toMatch(/data-node="Queue"><rect [^>]*stroke-dasharray/);
  expect(svg).toMatch(new RegExp(`data-node="Users"><rect [^>]*fill="${PALETTE.iconTile}"`));
  expect(svg).toMatch(new RegExp(`data-area="AWS"><rect [^>]*fill="${PALETTE.groupTint}"[^>]*stroke="${PALETTE.group}"[^>]*stroke-dasharray`));
  expect(svg).toMatch(/data-edge="edge:1"><path [^>]*stroke-dasharray="1 4"/);
  expect(svg.match(/data-marker="head"/g)).toHaveLength(1);
});

test("an_icon_url_that_is_not_a_data_image_is_never_drawn", () => {
  const scene = flowScene(CLOUD, CLOUD_AT, "modern", new Map([["users", "javascript:alert(1)"], ["aws-api-gateway", "https://example.com/x.svg"]]));
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
  const refs = [{ kind: "flow" as const, title: "Checkout writes orders", file: "checkout.flow", access: "writes" as const }];
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
  for (const t of ["orders", "customers", "order_items", "customer_id", "int ?", "4 more columns", "Checkout writes orders", "checkout.flow"]) {
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
  expect(snapCrop(dragged, "e", scene, 8)).toEqual({ ...crop, w: right - crop.x });
  // The bottom edge lands on the group's bottom.
  const low = { ...crop, h: area.y + area.h + 5 - crop.y };
  expect(snapCrop(low, "s", scene, 8).h).toBe(area.y + area.h - crop.y);
  // Out of reach, nothing moves; a moved box keeps its size.
  const far = { ...crop, w: right + 40 - crop.x };
  expect(snapCrop(far, "e", scene, 8)).toEqual(far);
  const moved = snapCrop({ ...crop, x: crop.x + 2 }, "move", scene, 8);
  expect(moved).toEqual(crop);
});
