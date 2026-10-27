import { expect, test } from "vitest";
import { createFlowService } from "./service";
import { docsById, fromWire, toWire, WireMiss } from "./wire";
import type { FlowDoc } from "./model";

test("a_one_frame_change_posts_one_doc", () => {
  const s = createFlowService();
  const sent = new Set<number>();
  const t = 'diagram flow "A"\nA\nB\nA > B\n\ndiagram flow "B"\nC\nD\nC > D\n';
  expect(toWire(s.parse("d", t), sent).frames.filter((f) => f.doc !== undefined)).toHaveLength(2);
  expect(toWire(s.parse("d", t.replace("C\nD\nC > D", "C\nD\nC > E")), sent).frames.map((f) => f.doc !== undefined)).toEqual([false, true]);
});

test("a_broken_frame_sends_its_last_good_doc_once", () => {
  const s = createFlowService();
  const sent = new Set<number>();
  const frame = (body: string) => `diagram flow "A"\nA\nB\nA > B\n\ndiagram flow "B"\nC\nD\nC > D\n${body}`;
  s.parse("d", frame(""));
  const first = toWire(s.parse("d", frame("C > X\n")), sent);
  expect(first.frames[1].doc).toBeNull();
  expect(first.frames[1].lastValid).toBeTruthy();
  const held = new Map<number, FlowDoc>();
  const m1 = fromWire(structuredClone(first), held);
  for (const [k, v] of docsById(m1)) held.set(k, v);
  const second = toWire(s.parse("d", frame("C > Y\n")), sent);
  const third = toWire(s.parse("d", frame("C > Z\n")), sent);
  expect(second.frames[1].lastValid).toBeUndefined();
  expect(third.frames[1].lastValid).toBeUndefined();
  const m3 = fromWire(third, held);
  expect(m3.frames[1].lastValid).toBe(m1.frames[1].lastValid);
});

test("the_merge_gives_back_the_same_objects", () => {
  const s = createFlowService();
  const sent = new Set<number>();
  const t = 'diagram flow "A"\nA\nB\nA > B\n\ndiagram flow "B"\nC\nD\nC > D\n';
  const r1 = s.parse("d", t);
  const m1 = fromWire(structuredClone(toWire(r1, sent)), new Map());
  const held = docsById(m1);
  const m2 = fromWire(structuredClone(toWire(s.parse("d", t.replace("C\nD\nC > D", "C\nD\nC > E")), sent)), held);
  expect(m2.frames[0].doc).toBe(m1.frames[0].doc);
  expect(m2.doc).toBe(m2.frames[0].doc);
  expect(m2.frames[1].doc).not.toBe(m1.frames[1].doc);
});

test("from_wire_carries_old_er_from_frame_zero", () => {
  const s = createFlowService();
  const t = 'diagram er "x"\na\nb\na 1--* b\n';
  const r = s.parse("d", t);
  expect(r.frames[0].oldEr).toBe(true);
  const m = fromWire(structuredClone(toWire(r, new Set())), new Map());
  expect(m.oldEr).toBe(true);
  expect(m.kind).toBe(r.frames[0].kind);
});

test("a_reordered_board_reuses_docs_by_id", () => {
  const s = createFlowService();
  const sent = new Set<number>();
  const a = 'diagram flow "A"\nA\nB\nA > B\n';
  const b = 'diagram flow "B"\nC\nD\nC > D\n';
  const m1 = fromWire(toWire(s.parse("d", `${a}\n${b}`), sent), new Map());
  const wire = toWire(s.parse("d", `${b}\n${a}`), sent);
  expect(wire.frames.map((f) => f.doc !== undefined)).toEqual([false, false]);
  const m2 = fromWire(wire, docsById(m1));
  expect(m2.frames[0].doc).toBe(m1.frames[1].doc);
  expect(m2.frames[1].doc).toBe(m1.frames[0].doc);
});

test("a_miss_throws_wire_miss", () => {
  const s = createFlowService();
  const sent = new Set<number>();
  const t = 'diagram flow "A"\nA\nB\nA > B\n';
  toWire(s.parse("d", t), sent);
  expect(() => fromWire(toWire(s.parse("d", t), sent), new Map())).toThrow(WireMiss);
});
