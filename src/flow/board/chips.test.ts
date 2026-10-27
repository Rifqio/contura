// Task 13 (Decision 25): the code pane's chips are the language's own syntax, each tested against the parser in its
// kind's sample; the pane header reads the one kind-name source.
import { expect, test } from "vitest";
import { parseFlow } from "../../lang/flow/parse";
import { DIAGRAM_KINDS, type DiagramKind } from "../../lang/flow/model";
import { CARDS } from "../diagramKinds";
import flowTabSource from "../FlowTab.tsx?raw";
import { CHIP_SAMPLE, CHIPS, KIND_HEAD, KIND_ICON } from "./chips";
import frameNodeSource from "./FrameNode.tsx?raw";
import spaceResultsSource from "./shelf/spaceResults.ts?raw";

/**
 * The sample with chip `i` typed at its mark: `‸<i>` when the sample has one for it, else the plain `‸`. A line holding
 * another chip's mark is left out, so each chip is read in its own place.
 */
function chipInSample(kind: DiagramKind, i: number): string {
  const sample = CHIP_SAMPLE[kind];
  const own = sample.includes(`‸${i}`) ? `‸${i}` : "‸";
  const lines = sample.split("\n").filter((l) => !/‸\d/.test(l) || (own !== "‸" && l.includes(own)));
  const text = lines.join("\n");
  const at = text.indexOf(own);
  const lineText = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
  return text.slice(0, at) + CHIPS[kind][i].insert(lineText) + text.slice(at + own.length);
}

test("every_chip_parses_in_its_kind", () => {
  for (const kind of DIAGRAM_KINDS) {
    expect(CHIPS[kind].length, kind).toBeGreaterThanOrEqual(2);
    CHIPS[kind].forEach((chip, i) => {
      const text = chipInSample(kind, i);
      const errors = parseFlow(text).problems.filter((p) => p.severity === "error");
      expect(errors.map((p) => `${kind} ${chip.name}: ${p.message}\n${text}`)).toEqual([]);
    });
  }
});

test("the_mindmap_indent_chip_nests_one_level", () => {
  const indent = CHIPS.mindmap.find((c) => c.op === "indent")!;
  expect(indent.insert("root Plan")).toBe("\n  ");
  expect(indent.insert("  Topic")).toBe("\n    ");
  const text = `diagram mindmap\nroot Plan\n  Topic${indent.insert("  Topic")}Detail\n`;
  const doc = parseFlow(text).doc!;
  const branch = doc.links.find((l) => l.to === "Detail");
  expect(branch?.from).toBe("Topic");
  expect(doc.links.find((l) => l.to === "Topic")?.from).toBe("Plan");
});

test("the_sequence_chips_are_the_language", () => {
  expect(CHIPS.sequence.map((c) => [c.op, c.name])).toEqual([
    ["->", "message"],
    ["-->", "reply"],
    [":", "label"],
  ]);
  expect(CHIP_SAMPLE.sequence).toContain("‸");
});

test("kind_heads_read_the_one_kind_source", () => {
  for (const kind of DIAGRAM_KINDS) {
    expect(KIND_HEAD[kind]).toEqual({ name: CARDS[kind].title, line: CARDS[kind].text });
    expect(typeof KIND_ICON[kind]).toBe("string");
  }
});

test("kind_icons_and_titles_have_one_home", () => {
  // The pane's title is the kind's name from CARDS: FlowTab keeps no list of its own (D4).
  expect(flowTabSource).not.toMatch(/const KIND_TITLE\b/);
  for (const src of [frameNodeSource, spaceResultsSource]) {
    expect(src).toMatch(/import \{[^}]*\bKIND_ICON\b[^}]*\} from "(\.|\.\.)\/chips"/);
    expect(src).not.toMatch(/FRAME_KIND_ICON/);
  }
});
