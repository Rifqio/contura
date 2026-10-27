// Diagram step 10 (board DiagramStartWell, F27), after Task 12: the New diagram sheet is the catalog now, and what a new
// file starts from is the Shelf's single templates (decision 12) or a kind's blank first line.
import { expect, test } from "vitest";
import { DIAGRAM_KINDS } from "../lang/flow/model";
import { parseFlow } from "../lang/flow/parse";
import { SINGLE_TEMPLATES } from "./board/catalog/templates";
import { blankText } from "./diagramKinds";


test("every single template parses with no problem and keeps its kind and name", () => {
  expect(SINGLE_TEMPLATES.length).toBeGreaterThan(0);
  for (const t of SINGLE_TEMPLATES) {
    const ex = parseFlow(t.text);
    expect(ex.problems.filter((p) => p.severity === "error"), t.name).toEqual([]);
    expect(ex.doc!.kind, t.name).toBe(t.kind);
    expect(ex.doc!.title, t.name).toBe(t.name);
    expect(ex.doc!.nodes.length, t.name).toBeGreaterThan(0);
  }
});

test("every kind's blank start parses with no problem, under the diagram's name", () => {
  for (const k of DIAGRAM_KINDS) expect(parseFlow(blankText(k, "My plan")).problems.filter((p) => p.severity === "error"), k).toEqual([]);
  // A blank mind map keeps its central idea: the diagram's name.
  expect(blankText("mindmap", "Q4 plan")).toBe('diagram mindmap "Q4 plan"\nroot Q4 plan\n');
  expect(blankText("flow", "Orders")).toBe('diagram flow "Orders"\n');
});

test("the ER templates are table blocks", () => {
  const er = SINGLE_TEMPLATES.filter((t) => t.kind === "er");
  expect(er.length).toBeGreaterThan(0);
  for (const t of er) expect(t.text).toMatch(/^\w+ \{$/m);
});
