import { expect, test } from "vitest";
import { type FlowDoc } from "./model";
import { writeBoard, writeFlow } from "../../flow/flowModel";
import { parseBoard } from "./board";
import { addFrame, deleteFrame, renameFrame } from "./boardEdits";
import { applyEdits, createFlowService } from "./service";

const A = 'diagram flow "A"\nA\n';

test("add_frame_appends_after_one_blank_line", () => {
  const out = addFrame(A, parseBoard(A), "sequence", "Login");
  expect(applyEdits(A, out.edits)).toBe('diagram flow "A"\nA\n\ndiagram sequence "Login"\n');
  expect(out.name).toBe("Login");
  const bare = 'diagram flow "A"\nA';
  const b = applyEdits(bare, addFrame(bare, parseBoard(bare), "state", "S").edits);
  expect(parseBoard(b).frames.map((f) => f.parse.title)).toEqual(["A", "S"]);
  const crlf = 'diagram flow "A"\r\nA\r\n';
  const c = applyEdits(crlf, addFrame(crlf, parseBoard(crlf), "state", "S").edits);
  expect(c).toBe('diagram flow "A"\r\nA\r\n\r\ndiagram state "S"\r\n');
  expect(parseBoard(c).frames.map((f) => f.parse.title)).toEqual(["A", "S"]);
  const trailing = `${A}\n\n\n`;
  expect(applyEdits(trailing, addFrame(trailing, parseBoard(trailing), "flow", "B").edits)).toBe(`${A}\ndiagram flow "B"\n`);
});

test("add_frame_refuses_an_empty_title", () => {
  for (const t of ["", "   "]) expect(addFrame(A, parseBoard(A), "flow", t)).toEqual({ edits: [], note: "A diagram needs a title." });
  // A title is written trimmed.
  expect(addFrame(A, parseBoard(A), "flow", "  B ").name).toBe("B");
});

test("add_frame_frees_a_taken_title", () => {
  const out = addFrame(A, parseBoard(A), "flow", "A");
  expect(out.name).toBe("A 2");
  const t = applyEdits(A, out.edits);
  const again = addFrame(t, parseBoard(t), "flow", "A");
  expect(again.name).toBe("A 3");
});

test("add_frame_refuses_past_the_cap", () => {
  let t = A;
  for (let i = 2; i <= 50; i++) t = applyEdits(t, addFrame(t, parseBoard(t), "flow", `F${i}`).edits);
  expect(parseBoard(t).frames).toHaveLength(50);
  const r = addFrame(t, parseBoard(t), "flow", "More");
  expect(r.edits).toEqual([]);
  expect(r.note).toBe("A board holds at most 50 diagrams.");
});

test("rename_frame_changes_only_the_title", () => {
  const t = `${A}\ndiagram state "B"\nIdle\n`;
  const b = parseBoard(t);
  const r = renameFrame(t, b, 1, "Bee");
  expect(r.edits).toHaveLength(1);
  expect(t.slice(r.edits[0].from, r.edits[0].to)).toBe('"B"');
  expect(applyEdits(t, r.edits)).toBe(`${A}\ndiagram state "Bee"\nIdle\n`);
  const bare = 'diagram flow "A"\nA\n\ndiagram state\nIdle\n';
  const r2 = renameFrame(bare, parseBoard(bare), 1, "New");
  expect(applyEdits(bare, r2.edits)).toBe('diagram flow "A"\nA\n\ndiagram state "New"\nIdle\n');
});

test("rename_frame_keeps_a_header_comment_and_says_why_it_cannot", () => {
  const t = `${A}\ndiagram state "B" // the states\nIdle\n`;
  expect(applyEdits(t, renameFrame(t, parseBoard(t), 1, "Bee").edits)).toBe(`${A}\ndiagram state "Bee" // the states\nIdle\n`);
  // A title whose quote is not closed is not given a second title.
  const open = `${A}\ndiagram state "B\nIdle\n`;
  expect(renameFrame(open, parseBoard(open), 1, "Bee")).toEqual({ edits: [], note: "Close the quotes of this diagram's title first." });
  // A file with no diagram line has no title to change.
  const headless = "A\nB\nA > B\n";
  expect(renameFrame(headless, parseBoard(headless), 0, "New")).toEqual({ edits: [], note: "This diagram has no diagram line to hold a title." });
});

test("rename_frame_refuses_a_taken_title", () => {
  const t = `${A}\ndiagram state "B"\nIdle\n`;
  const b = parseBoard(t);
  expect(renameFrame(t, b, 1, "A").edits).toEqual([]);
  expect(renameFrame(t, b, 1, "A").note).toBeTruthy();
  expect(renameFrame(t, b, 1, "  ").edits).toEqual([]);
  expect(renameFrame(t, b, 1, "  ").note).toBeTruthy();
});

test("delete_frame_takes_its_gap", () => {
  const t = `${A}\ndiagram state "B"\nIdle\n\ndiagram flow "C"\nC\n`;
  const b = parseBoard(t);
  expect(applyEdits(t, deleteFrame(t, b, 1).edits)).toBe(`${A}\ndiagram flow "C"\nC\n`);
  expect(applyEdits(t, deleteFrame(t, b, 0).edits)).toBe('diagram state "B"\nIdle\n\ndiagram flow "C"\nC\n');
  expect(applyEdits(t, deleteFrame(t, b, 2).edits)).toBe(`${A}\ndiagram state "B"\nIdle\n`);
});

test("delete_frame_keeps_the_file_top_and_line_breaks", () => {
  // The BOM and the comment above the first header describe the board, so deleting frame 0 keeps them.
  const top = '\uFEFF// Owned by billing\r\n\r\ndiagram flow "A"\r\nA\r\n\r\ndiagram state "B"\r\nIdle\r\n';
  expect(applyEdits(top, deleteFrame(top, parseBoard(top), 0).edits)).toBe('\uFEFF// Owned by billing\r\n\r\ndiagram state "B"\r\nIdle\r\n');
  const bom = '\uFEFFdiagram flow "A"\nA\n\ndiagram state "B"\nIdle\n';
  expect(applyEdits(bom, deleteFrame(bom, parseBoard(bom), 0).edits)).toBe('\uFEFFdiagram state "B"\nIdle\n');
  // CRLF and a last frame with no final line break.
  const crlf = 'diagram flow "A"\r\nA\r\n\r\ndiagram state "B"\r\nIdle';
  expect(applyEdits(crlf, deleteFrame(crlf, parseBoard(crlf), 1).edits)).toBe('diagram flow "A"\r\nA\r\n');
  // A comment between frames belongs to the frame above it.
  const noted = `${A}// about A\n\ndiagram state "B"\nIdle\n`;
  expect(applyEdits(noted, deleteFrame(noted, parseBoard(noted), 1).edits)).toBe(`${A}// about A\n`);
  expect(applyEdits(noted, deleteFrame(noted, parseBoard(noted), 0).edits)).toBe('diagram state "B"\nIdle\n');
});

test("delete_frame_keeps_the_last_one", () => {
  const r = deleteFrame(A, parseBoard(A), 0);
  expect(r.edits).toEqual([]);
  expect(r.note).toBe("A board keeps at least one diagram.");
});

test("write_board_reads_back", () => {
  const a = parseBoard('diagram flow "A"\nX\nY\nX > Y\n').frames[0].parse.doc as FlowDoc;
  const b = parseBoard('diagram state "B"\nIdle\nBusy\nIdle > Busy\n').frames[0].parse.doc as FlowDoc;
  expect(parseBoard(writeBoard([a, b])).frames.map((f) => f.parse.doc)).toEqual([a, b]);
  expect(writeBoard([a])).toBe(writeFlow(a));
});

test("board_ops_run_on_the_whole_text_through_the_service", () => {
  const s = createFlowService();
  const t = `${A}\ndiagram state "B"\nIdle\n`;
  const v = s.parse("d", t).version;
  const edits = (r: ReturnType<typeof s.edit>) => {
    expect(r.stale).toBe(false);
    return r.stale ? [] : r.edits;
  };
  expect(applyEdits(t, edits(s.edit("d", v, { op: "addFrame", kind: "flow", title: "C" }, 1)))).toBe(`${t}\ndiagram flow "C"\n`);
  expect(applyEdits(t, edits(s.edit("d", v, { op: "deleteFrame", frameIndex: 0 }, 1)))).toBe('diagram state "B"\nIdle\n');
  expect(applyEdits(t, edits(s.edit("d", v, { op: "renameFrame", frameIndex: 1, title: "Bee" })))).toContain('"Bee"');
});

test("last_good_drawings_follow_board_ops", () => {
  const s = createFlowService();
  const t = 'diagram flow "A"\nA\n\ndiagram flow "B"\nB\n';
  s.parse("d", t);
  // A rename carries the frame's own drawing to the new title, and it stays through a later broken parse.
  const renamed = s.parse("d", t.replace('"B"', '"Bee"'));
  expect(renamed.frames[1].doc?.title).toBe("Bee");
  const broken = s.parse("d", 'diagram flow "A"\nA\n\ndiagram flow "Bee"\nB > Nowhere\n');
  expect(broken.frames[1].doc).toBeNull();
  expect(broken.frames[1].lastValid).toEqual(renamed.frames[1].doc);
  // A broken frame renamed in one step keeps its drawing under the new title.
  const s2 = createFlowService();
  s2.parse("d", t);
  s2.parse("d", 'diagram flow "A"\nA\n\ndiagram flow "B"\nB > Nowhere\n');
  const r = s2.parse("d", 'diagram flow "A"\nA\n\ndiagram flow "Bee"\nB > Nowhere\n');
  expect(r.frames[1].lastValid?.nodes.map((n) => n.name)).toEqual(["B"]);
  // Deleting the first frame leaves each frame its own drawing, none another's.
  const text3 = 'diagram flow "A"\nA\n\ndiagram flow "B"\nB\n\ndiagram flow "C"\nC > Nowhere\n';
  const s3 = createFlowService();
  s3.parse("e", text3.replace(" > Nowhere", ""));
  s3.parse("e", text3);
  const after = s3.parse("e", 'diagram flow "B"\nB\n\ndiagram flow "C"\nC > Nowhere\n');
  expect(after.frames[0].doc?.nodes.map((n) => n.name)).toEqual(["B"]);
  expect(after.frames[1].lastValid?.nodes.map((n) => n.name)).toEqual(["C"]);
  // Adding a frame in front does not hand a broken frame the new one's place.
  const added = s3.parse("e", 'diagram flow "N"\nN > Nowhere\n\ndiagram flow "B"\nB\n\ndiagram flow "C"\nC > Nowhere\n');
  expect(added.frames[0].lastValid).toBeNull();
  expect(added.frames[2].lastValid?.nodes.map((n) => n.name)).toEqual(["C"]);
});
