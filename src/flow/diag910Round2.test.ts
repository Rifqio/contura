// diag-910 fix round 2, L1 (live check 16:20): a line to or from a group (a state composite, a flowchart group) is drawn
// to and from the group's box edge, as Mermaid and draw.io draw lines to containers, and the layout ranks it, so the
// diagram has an order. Publish draws it the same.
import { describe, expect, test } from "vitest";
import { parseFlow } from "../lang/flow/parse";
import { buildFlowGraph, layoutInput } from "./flowNodes";
import { flowScene } from "./flowScene";

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const STATE = lines('diagram state "Doc"', "Draft", "Published", "Review {", "  Checking", "  Approved", "  [*] > Checking", "  Checking > Approved", "}", "", "[*] > Draft", "Draft > Review: submit", "Review > Published");
const at = { Draft: { x: 0, y: 0 }, Published: { x: 600, y: 0 }, Checking: { x: 300, y: 0 }, Approved: { x: 300, y: 150 }, "[*] start in Review": { x: 300, y: -60 }, "[*] start": { x: -80, y: 0 } };

describe("L1 lines to and from a group", () => {
  test("the canvas draws a line to a composite and from it, ended on the composite's area", () => {
    const doc = parseFlow(STATE).doc!;
    const g = buildFlowGraph(doc, at, "modern");
    const area = "\u0000group:Review";
    expect(g.edges.find((e) => e.source === "Draft" && e.target === area)?.data).toMatchObject({ label: "submit" });
    expect(g.edges.find((e) => e.source === area && e.target === "Published")).toBeTruthy();
    // The area takes lines: it has an anchor on each side, as a node does.
    expect(g.nodes.find((n) => n.id === area)?.data).toMatchObject({ name: "Review" });
  });

  test("the layout ranks a line to a group by the shapes in it", () => {
    const doc = parseFlow(STATE).doc!;
    const input = layoutInput(doc, "modern");
    expect(input.edges).toEqual(
      expect.arrayContaining([
        { from: "Draft", to: "Checking" },
        { from: "Draft", to: "Approved" },
        { from: "Checking", to: "Published" },
        { from: "Approved", to: "Published" },
      ]),
    );
  });

  test("a flowchart line to a group's name is drawn and ranked the same", () => {
    const doc = parseFlow(lines('diagram flow "x"', "A", "Box {", "  B", "}", "", "A > Box")).doc!;
    const g = buildFlowGraph(doc, { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } }, "modern");
    expect(g.edges.find((e) => e.source === "A" && e.target === "\u0000group:Box")).toBeTruthy();
    expect(layoutInput(doc, "modern").edges).toEqual([{ from: "A", to: "B" }]);
  });

  test("Publish draws a line to a group to the group's box", () => {
    const doc = parseFlow(STATE).doc!;
    const scene = flowScene(doc, at, "modern", new Map());
    const box = scene.areas!.find((a) => a.name === "Review")!;
    const e = scene.edges.find((x) => x.label === "submit")!;
    const end = e.points[e.points.length - 1];
    expect(end.x === box.x || end.x === box.x + box.w || end.y === box.y || end.y === box.y + box.h).toBe(true);
  });
});

// ----- fix round 3, L8: a group is laid out as one block, nothing outside it overlaps it

import { layoutMissing } from "../diagram/layout";
import { routeOrthogonal } from "../diagram/route";
import { mermaidToFlow } from "./mermaid";

const REVIEW = [
  "stateDiagram-v2",
  "    [*] --> Draft",
  "    Draft --> Review : submit",
  "    state Review {",
  "        [*] --> Checking",
  "        Checking --> Approved : ok",
  "        Approved --> [*]",
  "    }",
  "    Review --> Published",
  "    Published --> [*]",
  "",
].join("\n");

type B = { x: number; y: number; w: number; h: number };
const meets = (a: B, b: B) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function laidOut(text: string, rankdir: "TB" | "LR" = "TB") {
  const doc = parseFlow(text).doc!;
  const input = layoutInput(doc, "modern");
  const at = await layoutMissing({ ...input, existing: {}, rankdir });
  const g = buildFlowGraph(doc, at, "modern");
  const box = (id: string): B => {
    const n = g.nodes.find((x) => x.id === id)!;
    return { x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 };
  };
  return { doc, g, box };
}

describe("L8 a group laid out as one block", () => {
  test("a Mermaid state import: start, Draft, the Review box, Published, end in one column; nothing outside meets the box", async () => {
    const r = mermaidToFlow(REVIEW, "Review flow");
    const { g, box } = await laidOut(r.flow);
    const area = box("\u0000group:Review");
    const inside = new Set(["Checking", "Approved", "[*] start in Review", "[*] end in Review"]);
    for (const n of g.nodes) {
      if (n.id.startsWith("\u0000") || inside.has(n.id)) continue;
      expect(meets(box(n.id), area), n.id).toBe(false);
    }
    // Top to bottom, as Mermaid draws it.
    const mid = (b: B) => b.y + b.h / 2;
    expect(mid(box("[*] start"))).toBeLessThan(mid(box("Draft")));
    expect(box("Draft").y + box("Draft").h).toBeLessThanOrEqual(area.y);
    expect(area.y + area.h).toBeLessThanOrEqual(box("Published").y);
    expect(mid(box("Published"))).toBeLessThan(mid(box("[*] end")));
    // A line to the group meets its border on the side facing its other end: Draft's line ends on the top edge.
    const route = routeOrthogonal(box("Draft"), area).points;
    const end = route[route.length - 1];
    expect(end.y).toBe(area.y);
    const from = routeOrthogonal(area, box("Published")).points[0];
    expect(from.y).toBe(area.y + area.h);
  });

  test("a flowchart group the same: nothing outside it meets its box", async () => {
    const { g, box } = await laidOut(['diagram flow "x"', "A", "D", "Box {", "  B", "  C", "}", "", "A > Box", "B > C", "Box > D", ""].join("\n"));
    const area = box("\u0000group:Box");
    for (const id of ["A", "D"]) expect(meets(box(id), area), id).toBe(false);
    expect(g.nodes.length).toBeGreaterThan(0);
  });
});

// ----- fix round 3, L9: a line's label is drawn above group areas

import tabCss from "../styles/flow-tab.css?raw";
import { exportPalette } from "../diagram/export/palette";
import { sceneToSvg } from "../diagram/export/svg";

describe("L9 labels above group areas", () => {
  test("on the canvas the labels' layer sits above every node, group areas included", () => {
    const css = tabCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const at = css.indexOf(".flow-canvas .react-flow__edgelabel-renderer {");
    expect(at).toBeGreaterThanOrEqual(0);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(Number(/z-index:\s*(\d+)/.exec(rule)?.[1] ?? 0)).toBeGreaterThan(0);
  });

  test("in Publish a label is written after the group areas, so it is drawn over them", () => {
    const doc = parseFlow(STATE).doc!;
    const svg = sceneToSvg(flowScene(doc, at, "modern", new Map()), exportPalette("light"), { padding: 8, background: "transparent", mark: false });
    expect(svg.indexOf(">Review<")).toBeGreaterThan(0);
    expect(svg.indexOf(">submit<")).toBeGreaterThan(svg.indexOf(">Review<"));
  });
});
