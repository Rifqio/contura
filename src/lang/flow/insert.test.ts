// Diagram step 10 (F28, board DiagramStartWell): Mermaid inserted into the open diagram of the same kind (draw.io's
// Arrange > Insert > Mermaid). Taken names come in free, as a paste's do; a sequence reuses its participants by name; a
// mind map's central idea comes in as a topic. One edit list; every other byte stays.
import { expect, test } from "vitest";
import { insertFlow, insertKindRefusal } from "./insert";
import { parseFlow } from "./parse";

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const apply = (text: string, flow: string) => {
  const r = insertFlow(text, parseFlow(text), flow);
  let out = text;
  for (const e of [...r.edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return { ...r, text: out };
};

const ORDERS = lines('diagram flow "Order handling"', "Order in [start]", "Ship order", "", "Order in > Ship order");

test("a flowchart goes after the text; a taken name comes in free, its lines follow it", () => {
  const r = apply(ORDERS, lines('diagram flow "Packing"', "", "Pack", "Print label", "Ship order", "", "Pack > Print label", "Print label > Ship order"));
  expect(r.text).toBe(ORDERS + lines("", "Pack", "Print label", "Ship order 2", "", "Pack > Print label", "Print label > Ship order 2"));
  expect(r.names).toEqual({ Pack: "Pack", "Print label": "Print label", "Ship order": "Ship order 2" });
  expect(parseFlow(r.text).problems.filter((p) => p.severity === "error")).toEqual([]);
});

test("a group with a taken name comes in free too", () => {
  const target = lines('diagram flow "x"', "Warehouse {", "  A", "}");
  const r = apply(target, lines('diagram flow "y"', "", "Warehouse {", "  B", "}"));
  expect(r.text).toBe(target + lines("", "Warehouse 2 {", "  B", "}"));
});

test("a sequence reuses the participants it already has, by name, and adds the others", () => {
  const target = lines('diagram sequence "Checkout"', "participant Shop", "participant Payments", "Shop -> Payments: charge");
  const r = apply(target, lines('diagram sequence "Pay"', "participant Shop", "participant Bank", "Shop -> Bank: pay"));
  expect(r.text).toBe(target + lines("", "participant Bank", "Shop -> Bank: pay"));
  expect(r.names).toEqual({ Bank: "Bank" });
  expect(r.note).toBe("1 participant already here is reused.");
});

test("a mind map's central idea comes in as a topic under the open map's, its topics a level deeper", () => {
  const target = lines('diagram mindmap "Q4"', "root Q4", "  Diagrams");
  const r = apply(target, lines('diagram mindmap "Ideas"', "root Ideas", "  Docs", "    Site"));
  expect(r.text).toBe(target + lines("  Ideas", "    Docs", "      Site"));
  expect(parseFlow(r.text).doc!.nodes.map((n) => [n.name, n.depth])).toEqual([
    ["Q4", 0],
    ["Diagrams", 1],
    ["Ideas", 1],
    ["Docs", 2],
    ["Site", 3],
  ]);
});

test("another kind is refused with the reason, and nothing is written", () => {
  const r = apply(ORDERS, lines('diagram sequence "Pay"', "A -> B: pay"));
  expect(r.edits).toEqual([]);
  expect(r.note).toBe("Insert takes a flowchart here; this is a sequence. Create makes it a new diagram.");
});

test("the refusal says an before ER", () => {
  expect(insertKindRefusal("er", "flow")).toBe("Insert takes an ER diagram here; this is a flowchart. Create makes it a new diagram.");
  expect(insertKindRefusal("flow", "er")).toBe("Insert takes a flowchart here; this is an ER diagram. Create makes it a new diagram.");
});

test("at a place: the lines go where you are typing", () => {
  const r = insertFlow(ORDERS, parseFlow(ORDERS), lines('diagram flow "P"', "Pack"), ORDERS.indexOf("Ship order"));
  let out = ORDERS;
  for (const e of r.edits) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  expect(out).toBe(lines('diagram flow "Order handling"', "Order in [start]", "Pack", "Ship order", "", "Order in > Ship order"));
});
