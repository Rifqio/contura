import { expect, test } from "vitest";
import fixture from "../../../crates/contura-core/tests/fixtures/flow/frame_headers.json";
import orderHandover from "../../flow/fixtures/order-handover.flow?raw";
import { applyEdits, createFlowService } from "./service";
import { parseBoard, pasteFrame, splitFrames } from "./board";
import checkout from "./fixtures/checkout.flow?raw";
import cloud from "./fixtures/cloud.flow?raw";
import orderFlow from "./fixtures/order-flow.flow?raw";
import quoting from "./fixtures/quoting.flow?raw";
import { SAMPLES } from "./fixtures/samples";
import { parseFlow } from "./parse";
import { MESSAGES } from "./problems";

const ALL_SAMPLES = [orderHandover, checkout, cloud, orderFlow, quoting, ...SAMPLES];

const CASES: { name: string; text: string; starts: number[] }[] = fixture;

test("frame_starts_match_the_shared_fixture", () => {
  for (const c of CASES) expect(splitFrames(c.text).map((f) => f.line), c.name).toEqual(c.starts);
});

test("one_diagram_is_one_frame_over_the_whole_text", () => {
  const t = 'diagram flow "A"\nA > B\n\n\n';
  expect(splitFrames(t)).toEqual([{ index: 0, from: 0, to: t.length, line: 1 }]);
  expect(splitFrames("")).toEqual([{ index: 0, from: 0, to: 0, line: 1 }]);
});

test("the_gap_between_frames_belongs_to_no_frame", () => {
  const a = 'diagram flow "A"\nX > Y\n';
  const t = `${a}\n\ndiagram state "B"\nIdle > Busy\n`;
  const [f0, f1] = splitFrames(t);
  expect(f0).toEqual({ index: 0, from: 0, to: a.length, line: 1 });
  expect(f1).toEqual({ index: 1, from: t.indexOf("diagram state"), to: t.length, line: 5 });
});

test("a_last_frame_without_a_final_line_break_ends_at_the_text_end", () => {
  const t = 'diagram flow "A"\nX\n\ndiagram flow "B"\nY';
  const [, f1] = splitFrames(t);
  expect(t.slice(f1.from, f1.to)).toBe('diagram flow "B"\nY');
  expect(parseBoard(t).frames[1].parse.doc?.nodes.map((n) => n.name)).toEqual(["Y"]);
});

test("crlf_and_a_bom_split_on_line_starts", () => {
  const t = '\uFEFFdiagram flow "A"\r\nX\r\n\r\ndiagram flow "B"\r\nY\r\n';
  const [f0, f1] = splitFrames(t);
  expect(t.slice(f0.from, f0.to)).toBe('\uFEFFdiagram flow "A"\r\nX\r\n');
  expect(t.slice(f1.from, f1.to)).toBe('diagram flow "B"\r\nY\r\n');
});

test("a_one_frame_board_is_the_parse_it_always_was", () => {
  for (const t of ALL_SAMPLES) {
    const b = parseBoard(t);
    const p = parseFlow(t);
    expect(b.frames).toHaveLength(1);
    expect(b.problems).toEqual(p.problems);
    expect(b.frames[0].parse.doc).toEqual(p.doc);
  }
});

test("problems_and_fixes_carry_whole_file_positions", () => {
  const t = 'diagram flow "A"\nA > B\n\ndiagram flow "B"\nC > Missing\n';
  const b = parseBoard(t);
  const p = b.problems.find((x) => x.message === "Missing is not defined.")!;
  expect(t.slice(p.from, p.to)).toBe("Missing");
  expect(p.line).toBe(5);
  const add = p.fixes[0].edits[0];
  expect(add.from).toBe(t.length); // the end of frame 1, the end of the file
});

test("an_unclosed_group_stays_in_its_frame", () => {
  const a = 'diagram flow "A"\nBilling {\n  Pay\n';
  const t = `${a}\ndiagram flow "B"\nX\nY\nX > Y\n`; // B defines X and Y, so any problem in it came from A
  const b = parseBoard(t);
  expect(b.frames[1].parse.problems).toEqual([]);
  const fix = b.problems.find((x) => x.message === "Billing has no closing }.")!.fixes[0].edits[0];
  expect(fix.from).toBe(a.length); // before the gap, not the end of the file
});

test("a_repeated_title_is_an_error_with_a_rename", () => {
  const t = 'diagram flow "Checkout"\nA\n\ndiagram state "Checkout"\nB\n';
  const p = parseBoard(t).problems.find((x) => x.severity === "error")!;
  expect(p.message).toBe("Two diagrams on this board are called Checkout.");
  expect(applyEdits(t, p.fixes[0].edits)).toContain('diagram state "Checkout 2"');
});

test("an_untitled_repeat_gets_a_title", () => {
  const t = 'diagram flow\nA\n\ndiagram state "Untitled 2"\nB\n\ndiagram state\nC\n';
  const p = parseBoard(t).problems.find((x) => x.severity === "error")!;
  expect(p.message).toBe("Two diagrams on this board are called Untitled.");
  expect(p.line).toBe(7);
  expect(applyEdits(t, p.fixes[0].edits)).toContain('diagram state "Untitled 3"\nC');
});

test("frames_past_fifty_are_not_read", () => {
  const t = Array.from({ length: 52 }, (_, i) => `diagram flow "F${i}"\nA${i}\n`).join("\n");
  const b = parseBoard(t);
  expect(b.frames).toHaveLength(50);
  const over = b.problems.filter((p) => p.message === MESSAGES.tooManyFrames);
  expect(over).toHaveLength(1);
  expect(over[0].line).toBe(151);
  expect(t.slice(over[0].from, over[0].to)).toBe('diagram flow "F50"');
});

test("unchanged_frames_keep_their_parse", () => {
  const t = 'diagram flow "A"\nA\n\ndiagram flow "B"\nB\n';
  const first = parseBoard(t);
  const next = parseBoard(t.replace("B\n", "B > C\nC\n"), {}, first);
  expect(next.frames[0].parse).toBe(first.frames[0].parse);
  expect(next.frames[1].parse).not.toBe(first.frames[1].parse);
});

test("a_board_past_ten_thousand_shapes_says_so_once", () => {
  const frame = (i: number) => `diagram flow "F${i}"\n${Array.from({ length: 1700 }, (_, n) => `N${n}`).join("\n")}\n`;
  const t = Array.from({ length: 6 }, (_, i) => frame(i)).join("\n");
  const b = parseBoard(t);
  expect(b.shapes).toBe(10_200);
  const over = b.problems.filter((p) => p.message === MESSAGES.tooManyShapes);
  expect(over).toHaveLength(1);
  expect(over[0].severity).toBe("error");
  expect(over[0].from).toBe(b.frames[5].from);
  expect(over[0].line).toBe(b.frames[5].line);
});

test("frame_at_counts_a_gap_as_the_frame_before_it", () => {
  const a = 'diagram flow "A"\nA\n';
  const t = `${a}\n\ndiagram flow "B"\nB\n`;
  const b = parseBoard(t);
  expect(b.frameAt(0)).toBe(0);
  expect(b.frameAt(a.length + 1)).toBe(0);
  expect(b.frameAt(t.indexOf('diagram flow "B"'))).toBe(1);
  expect(b.frameAt(t.length)).toBe(1);
});

test("one_frame_skips_the_board_shape_limit", () => {
  const t = `diagram flow "Big"\n${Array.from({ length: 10_001 }, (_, n) => `N${n}`).join("\n")}\n`;
  const b = parseBoard(t);
  expect(b.shapes).toBe(10_001);
  expect(b.problems.filter((p) => p.message === MESSAGES.tooManyShapes)).toEqual([]);
  expect(b.problems).toEqual(parseFlow(t).problems);
});

test("board_problems_are_never_cut_by_the_problem_cap", () => {
  // A name written again is a problem each time: 150 and 100 problems, then a clean frame whose title repeats.
  const frame = (title: string, repeats: number) => `diagram flow "${title}"\n${"A\n".repeat(repeats + 1)}`;
  const t = `${frame("Same", 150)}\n${frame("Other", 100)}\n${frame("Same", 0)}`;
  const b = parseBoard(t);
  expect(b.frames.map((f) => f.parse.problems.length)).toEqual([150, 100, 0]);
  expect(b.problems).toHaveLength(200);
  expect(b.problems.filter((p) => p.message === MESSAGES.frameTwice("Same"))).toHaveLength(1);
});

test("the_worker_keeps_one_parse_per_frame", () => {
  // Frame 1 is retitled and frame 2 edited (broken every third time) on each parse; frames 0 and 3 never change.
  const flow = createFlowService();
  const text = (n: number) =>
    `diagram flow "A"\nA\nB\nA > B\n\ndiagram flow "B ${n}"\nC\n\ndiagram flow "C"\nD\nE\nD > E: run ${n}${n > 0 && n % 3 === 0 ? "\nD >" : ""}\n\ndiagram state "D"\nIdle\nBusy\nIdle > Busy\n`;
  const first = flow.current("board", flow.parse("board", text(0)).version)!;
  expect(first.board.problems).toEqual([]);
  const kept = [first.board.frames[0].parse, first.board.frames[3].parse];
  let version = 0;
  for (let n = 1; n <= 30; n++) version = flow.parse("board", text(n)).version;
  const c = flow.current("board", version)!;
  expect(c.board.frames.map((f) => f.text)).toEqual(splitFrames(text(30)).map((f) => text(30).slice(f.from, f.to)));
  expect(c.lasts).toHaveLength(4);
  expect(c.lastValid.size).toBeLessThanOrEqual(4);
  expect([...c.lastValid.keys()]).toEqual(["A", "B 30", "C", "D"]);
  expect(c.board.frames[2].parse.doc).toBeNull();
  expect(c.board.frames[0].parse).toBe(kept[0]);
  expect(c.board.frames[3].parse).toBe(kept[1]);
});

test("a_paste_goes_into_the_frame_that_holds_it", () => {
  const a = 'diagram flow "A"\nX\n';
  const b = 'diagram flow "B"\nY\n';
  const text = `${a}\n${b}`;
  const bAt = text.indexOf('diagram flow "B"');
  // No position: frame 0, to its last line.
  expect(pasteFrame(text, null)).toEqual({ from: 0, to: a.length });
  expect(pasteFrame(text, { from: text.length, to: text.length })).toEqual({ from: bAt, to: text.length });
  // A selection in the gap after a frame is that frame's.
  expect(pasteFrame(text, { from: a.length, to: a.length + 1 })).toEqual({ from: 0, to: a.length + 1 });
  // A selection that runs into the next frame has no frame.
  expect(pasteFrame(text, { from: 2, to: bAt + 3 })).toBeNull();
});

test("a_header_with_no_known_kind_is_one_problem_in_the_frame_before_it", () => {
  const t = 'diagram flow "A"\nA [step]\n\ndiagram flowchart "Checkout"\n';
  const b = parseBoard(t);
  expect(b.frames).toHaveLength(1);
  expect(b.problems.map((p) => [p.message, p.line, t.slice(p.from, p.to)])).toEqual([["flowchart is not a diagram kind. Use flow.", 4, "flowchart"]]);
  expect(b.problems[0].fixes[0].edits).toEqual([{ from: t.indexOf("flowchart"), to: t.indexOf("flowchart") + 9, insert: "flow" }]);
});

test("frame_twice_names_no_lines", () => {
  const b = parseBoard('diagram flow "Same"\nA\n\ndiagram flow "Same"\nB\n\ndiagram flow\nC\n\ndiagram flow\nD\n');
  const twice = b.problems.filter((p) => p.message.startsWith("Two diagrams"));
  expect(twice.map((p) => p.message)).toEqual(["Two diagrams on this board are called Same.", "Two diagrams on this board are called Untitled."]);
  expect(MESSAGES.frameTwice("")).toBe("Two diagrams on this board are called Untitled.");
});
