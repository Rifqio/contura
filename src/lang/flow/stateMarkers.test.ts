// diag-910 fix round 1, I4: a composite state's own start and end. `[*]` written inside a composite's braces is that
// composite's marker, drawn inside it and named `[*] start in <Composite>`, apart from the diagram's own `[*]`. The
// writer puts those lines back inside the braces, so the text reads back the same.
import { describe, expect, test } from "vitest";
import { writeFlow } from "../../flow/flowModel";
import { isStateEnd, isStateMarker, isStateStart, STATE_END, STATE_START, stateMarkerName } from "./model";
import { applyFlowEdit, linkRefOf } from "./edits";
import { parseFlow } from "./parse";

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const TEXT = lines('diagram state "Keys"', "", "Idle", "", "Active {", "  NumLockOff", "  NumLockOn", "  [*] > NumLockOff", "  NumLockOn > [*]", "}", "", "[*] > Idle", "Idle > Active: key", "Active > [*]");

describe("the language", () => {
  test("[*] inside a composite is the composite's own marker, a member of it, apart from the diagram's", () => {
    const r = parseFlow(TEXT);
    expect(r.problems).toEqual([]);
    const doc = r.doc!;
    expect(doc.nodes.map((n) => [n.name, n.kind])).toEqual([
      [STATE_START, "start"],
      [STATE_END, "end"],
      ["Idle", "state"],
      ["NumLockOff", "state"],
      ["NumLockOn", "state"],
      ["[*] start in Active", "start"],
      ["[*] end in Active", "end"],
    ]);
    expect(doc.groups).toEqual([{ name: "Active", nodes: ["NumLockOff", "NumLockOn", "[*] start in Active", "[*] end in Active"], groups: [] }]);
    expect(doc.links).toEqual([
      { from: "[*] start in Active", to: "NumLockOff", arrow: ">" },
      { from: "NumLockOn", to: "[*] end in Active", arrow: ">" },
      { from: STATE_START, to: "Idle", arrow: ">" },
      { from: "Idle", to: "Active", arrow: ">", label: "key" },
      { from: "Active", to: STATE_END, arrow: ">" },
    ]);
    expect(r.parentOf("[*] start in Active")).toBe("Active");
    expect(r.parentOf(STATE_START)).toBeUndefined();
  });

  test("the helpers name and read the markers", () => {
    expect(stateMarkerName("start", null)).toBe(STATE_START);
    expect(stateMarkerName("end", "Active")).toBe("[*] end in Active");
    expect([isStateStart(STATE_START), isStateStart("[*] start in Active"), isStateStart("[*] end in Active"), isStateStart("Start")]).toEqual([true, true, false, false]);
    expect([isStateEnd(STATE_END), isStateEnd("[*] end in Active"), isStateEnd("[*] start in Active")]).toEqual([true, true, false]);
    expect([isStateMarker("[*] end in Active"), isStateMarker("Active")]).toEqual([true, false]);
  });

  test("the writer puts a composite's marker lines back inside its braces, so the text reads back the same", () => {
    const doc = parseFlow(TEXT).doc!;
    expect(writeFlow(doc)).toBe(TEXT);
    expect(parseFlow(writeFlow(doc)).doc).toEqual(doc);
  });

  test("old files parse as before: one top-level [*] used twice is still the one pair of markers", () => {
    const doc = parseFlow(lines('diagram state "x"', "A", "B", "[*] > A", "A > B", "B > [*]", "A > [*]")).doc!;
    expect(doc.nodes.map((n) => n.name)).toEqual([STATE_START, STATE_END, "A", "B"]);
  });
});

describe("fix round 2, N1: a line end dropped on the diagram's Start or End from inside a composite", () => {
  const apply = (text: string, i: number, end: "from" | "to", node: string) => {
    const p = parseFlow(text);
    const r = applyFlowEdit(text, p, { op: "setLinkEnd", link: linkRefOf(p.links, i)!, end, node });
    let out = text;
    for (const e of [...r.edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
    return { text: out, note: r.note };
  };

  test("the line moves out of the braces, so its [*] is the diagram's own", () => {
    const text = lines('diagram state "S"', "[*] > A", "G {", "  A", "  B", "  A > B", "}");
    const r = apply(text, 1, "to", STATE_END);
    expect(r.text).toBe(lines('diagram state "S"', "[*] > A", "A > [*]", "G {", "  A", "  B", "}"));
    const doc = parseFlow(r.text).doc!;
    expect(doc.links.find((l) => l.from === "A" && l.to !== "B")?.to).toBe(STATE_END);
  });

  test("a line to the composite's own end goes to the diagram's end the same way", () => {
    const text = lines('diagram state "S"', "G {", "  On", "  [*] > On", "  On > [*]", "}");
    const r = apply(text, 1, "to", STATE_END);
    expect(r.text).toBe(lines('diagram state "S"', "G {", "  On", "  [*] > On", "}", "On > [*]"));
  });

  test("a line from the composite's own start cannot end on the diagram's end: it says why", () => {
    const text = lines('diagram state "S"', "G {", "  On", "  [*] > On", "}");
    const r = apply(text, 0, "to", STATE_END);
    expect(r.text).toBe(text);
    expect(r.note).toBe("This line starts at G's own start, so it stays inside G. Draw a new line to end at the diagram's end.");
  });
});

test("fix round 2, N9: a copy leaves out the lines to a composite's own start or end, so a paste never makes them the diagram's", async () => {
  const { copyLines } = await import("./clip");
  const doc = parseFlow(TEXT).doc!;
  expect(copyLines(doc, ["NumLockOff", "NumLockOn", "[*] start in Active", "[*] end in Active"])).toBe(lines("NumLockOff", "NumLockOn"));
});
