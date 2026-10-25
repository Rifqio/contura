// diag-910 fix round 2, L7 (live check: "the text on the diagram is not perfectly centred"): a shape's label is centred
// both ways, as draw.io centres a shape's label. The inside of a step 12 shape fills its box, so the centring has to be
// on that inside, for every kind whose label is its name alone (a note's text stays to the left, as on the board).
import { expect, test } from "vitest";
import canvasCss from "../styles/flow-canvas.css?raw";

/** The declarations every rule naming `selector` gives, merged in order. */
function declarations(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const css = canvasCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /([^{}]+)\{([^}]*)\}/g;
  for (let m = rule.exec(css); m; m = rule.exec(css)) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const d of m[2].split(";")) {
      const at = d.indexOf(":");
      if (at > 0) out[d.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, "").trim()] = d.slice(at + 1).trim();
    }
  }
  return out;
}

test("L7 the label of a state, a choice, a document, a database and a timeline item is centred both ways", () => {
  for (const kind of ["state", "choice", "document", "database", "event", "period", "milestone"]) {
    const d = declarations(`.fnode-${kind} .fkind-inside`);
    expect([kind, d["align-items"], d["justify-content"], d["text-align"]]).toEqual([kind, "center", "center", "center"]);
  }
});

test("L7 a centred name that runs out of room keeps its ellipsis inside the shape", () => {
  const d = declarations(".fkind-inside > .fnode-name");
  expect(d["max-width"]).toBe("100%");
});
