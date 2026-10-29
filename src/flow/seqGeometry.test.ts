// The one sequence drawing, in the sequence's own coordinates. Every font measures 7 px a letter here.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseFlow } from "../lang/flow/parse";
import { PAY } from "./fixtures/paySequence";
import { fixedLayout, messageLabelW, setLabelMeasure } from "./kindLayout";
import { GapTree, messagePath, numberWidth, SEG_MIN, type SeqDrawing, type SeqMessage } from "./seqGeometry";

beforeEach(() => setLabelMeasure((s) => s.length * 7));
afterEach(() => setLabelMeasure(null));

const layoutOf = (text: string, textScale = 1) => {
  const parsed = parseFlow(text.startsWith("diagram") ? text : `diagram sequence "x"\n${text}\n`);
  expect(parsed.problems ?? []).toEqual([]);
  return fixedLayout(parsed.doc!, () => ({ w: 120, h: 40 }), { textScale })!;
};
const drawingOf = (text: string, textScale = 1): SeqDrawing => layoutOf(text, textScale).seq!;
const laneOf = (d: SeqDrawing, name: string) => d.lanes.find((l) => l.name === name)!;
/** Two 120 px boxes 72 px apart: lanes at 60 and 252 unless a label widens the gap. */
let current: SeqDrawing;
const laneX = (name: string) => laneOf(current, name).x;
const draw = (text: string, textScale = 1) => (current = drawingOf(text, textScale));
const AB = "participant A\nparticipant B\n";
const last = (m: SeqMessage) => m.points[m.points.length - 1];

describe("messages", () => {
  test("a_label_breaks_its_line_at_the_middle", () => {
    const m = draw(`${AB}A -> B: authorize`).messages[0];
    const mid = (laneX("A") + laneX("B")) / 2;
    expect(m.label).toMatchObject({ text: "authorize", x: mid, y: m.y, w: 63, bg: "canvas" });
    expect(m.label!.chip).toEqual({ x: mid - 35.5, y: m.y - 9, w: 71, h: 18 });
    expect(m.d).toBe(`M${laneX("A")} ${m.y} H${mid - 31.5 - 7} M${mid + 31.5 + 7} ${m.y} H${laneX("B")}`);
    expect(m.points).toEqual([
      { x: laneX("A"), y: m.y },
      { x: laneX("B"), y: m.y },
    ]);
    expect(m).toMatchObject({ index: 0, from: "A", to: "B", self: false, reply: false });
  });

  test("an_unlabelled_message_is_one_line", () => {
    const m = draw(`${AB}A -> B\nB --> A`).messages;
    expect(m[0].label).toBeUndefined();
    expect(m[0].d).toBe(`M60 ${m[0].y} H252`);
    expect(m[1].d).toBe(`M252 ${m[1].y} H60`);
    expect(m[1].reply).toBe(true);
    expect(m[0].number).toBeUndefined();
  });

  test("numbered_lines_start_past_the_circle", () => {
    const m = draw(`autonumber\n${AB}A -> B: go\nB -> A`).messages;
    expect(m[0].points[0].x).toBe(laneX("A") + 10);
    expect(m[0].number).toEqual({ n: 1, x: laneX("A"), y: m[0].y, w: 20, who: "participant" });
    expect(m[1].number).toMatchObject({ n: 2, x: laneX("B") });
    const hundred = draw(`autonumber 100\n${AB}A -> B`).messages[0];
    expect(hundred.number!.w).toBe(26.5);
    expect(hundred.points[0].x).toBe(laneX("A") + 13.25);
    expect(numberWidth(100, 1)).toBe(26.5);
    expect(numberWidth(7, 1)).toBe(20);
  });

  test("active_ends_stop_at_the_bar", () => {
    let m = draw(`${AB}activate B\nA -> B`).messages[0];
    expect(last(m).x).toBe(laneX("B") - 6);
    expect(m.points[0].x).toBe(laneX("A"));
    m = draw(`${AB}activate A\nA -> B`).messages[0];
    expect(m.points[0].x).toBe(laneX("A") + 6);
    m = draw(`${AB}activate A\nB -> A`).messages[0];
    expect(last(m).x).toBe(laneX("A") + 6);
    m = draw(`${AB}activate B\nB -> A`).messages[0];
    expect(m.points[0].x).toBe(laneX("B") - 6);
    m = draw(`autonumber\n${AB}activate B\nB -> A`).messages[0];
    expect(m.points[0].x).toBe(laneX("B") - 10);
    // A deactivated participant is no longer active.
    m = draw(`${AB}activate B\nA -> B\ndeactivate B\nA -> B`).messages[1];
    expect(last(m).x).toBe(laneX("B"));
  });

  test("rows_put_their_line_22_below_their_top", () => {
    const lay = layoutOf(`${AB}A -> B\nA -> A\nB -> A`);
    const rows = lay.rows!;
    // The first row's top is 16 px below the 40 px boxes.
    expect(rows[0] - 56).toBe(22);
    // A plain row is 44 tall, a self row 62.
    expect(rows[1] - rows[0]).toBe(44);
    expect(rows[2] - rows[1]).toBe(62);
    const rowTop1 = rows[0] - 22 + 44;
    expect(rows[1] - rowTop1).toBe(22);
    expect(lay.seq!.messages.map((m) => m.y)).toEqual(rows);
  });

  test("self_loop_is_square_and_breaks_at_its_label", () => {
    const m = draw(`${AB}A -> A: go`).messages[0];
    const x0 = laneX("A");
    const x2 = x0 + 74;
    const y = m.y;
    expect(m.self).toBe(true);
    expect(m.d).toBe(`M${x0} ${y} H${x2} V${y + 9} M${x2} ${y + 29} V${y + 38} H${x0}`);
    expect(m.points).toEqual([
      { x: x0, y },
      { x: x2, y },
      { x: x2, y: y + 38 },
      { x: x0, y: y + 38 },
    ]);
    expect(m.label).toMatchObject({ x: x2, y: y + 19, w: 14 });
    const long = draw(`${AB}A -> A: ${"x".repeat(40)}`).messages[0];
    expect(long.label!.x).toBe(x0 + 280 / 2 + 14);
    const bare = draw(`${AB}A -> A`).messages[0];
    expect(bare.d).toBe(`M${x0} ${bare.y} H${x2} V${bare.y + 38} H${x0}`);
  });

  test("message_path_moves_every_point", () => {
    const m = draw(`${AB}A -> A: go\nA -> B: authorize`).messages;
    expect(messagePath(m[0], 10, 100)).toBe(`M70 ${m[0].y + 100} H144 V${m[0].y + 109} M144 ${m[0].y + 129} V${m[0].y + 138} H70`);
    expect(messagePath(m[1], 0, 0)).toBe(m[1].d);
    expect(messagePath(m[1], -60, 0)).toBe(`M0 ${m[1].y} H57.5 M134.5 ${m[1].y} H192`);
  });
});

describe("labels across lanes (Review Focus 3)", () => {
  test("labels_never_cross_a_lifeline", () => {
    // Review Focus 3 in one fixture: a 60-character label between neighbours, a label across four participants, and
    // a long self-message on the last participant inside an opt, with a note right of it all.
    const long = "x".repeat(60);
    const across = "y".repeat(40);
    const lay = layoutOf(`participant A\nparticipant B\nparticipant C\nparticipant D\nparticipant E\nA -> B: ${long}\nB -> E: ${across}\nopt card {\n  E -> E: ${long}\n}\nnote: later`);
    const d = (current = lay.seq!);
    // A to B needs 420 + 2 * 7 + 2 * 16 = 466 between centres: B's gap grows by 274.
    expect(d.lanes.map((l) => l.x)).toEqual([60, 526, 718, 910, 1102]);
    const [neighbours, wide, self] = d.messages;
    // The neighbour chip clears A's lane by SEG_MIN + LABEL_PAD - 4 = 19, and B's by the same.
    expect(neighbours.label!.chip).toEqual({ x: 79, y: 69, w: 428, h: 18 });
    expect(laneX("B") - (79 + 428)).toBe(19);
    expect(neighbours.label!.chip.x - laneX("A")).toBeGreaterThanOrEqual(SEG_MIN);
    // The wide chip is centred between B and E; C (718) and D (910) pass under it, A and B and E do not.
    expect(wide.label!.chip).toEqual({ x: 670, y: 113, w: 288, h: 18 });
    expect(d.lanes.map((l) => l.x).filter((x) => x > 670 && x < 958)).toEqual([718, 910]);
    for (const m of [neighbours, wide]) expect(m.label!.bg).toBe("canvas");
    // The self-message: row 2's top is 144 + 28 (the opt's tab room), its line 194; the loop runs 224 right of E.
    expect(self.d).toBe("M1102 194 H1326 V203 M1326 223 V232 H1102");
    expect(self.label).toMatchObject({ x: 1326, y: 213, w: 420, bg: 0 });
    expect(self.label!.chip).toEqual({ x: 1112, y: 204, w: 428, h: 18 });
    // The opt holds the chip, 12 px past it; the drawing ends there and the note goes 72 px further right.
    expect(d.blocks[0].box).toEqual({ x: 1048, y: 146, w: 504, h: 90 });
    expect(d.bounds).toEqual({ x: 0, y: 0, w: 1552, h: 244 + 10 + 40 });
    const note = Object.keys(lay.positions).find((k) => !d.lanes.some((l) => l.name === k))!;
    expect(lay.positions[note]).toEqual({ x: 1552 + 72, y: 56 });
    // A self-message with a box right of it pushes that box 12 px past its chip.
    const mid = draw(`${AB}A -> A: ${long}`);
    const mc = mid.messages[0].label!.chip;
    expect(laneX("B") - 60).toBeCloseTo(mc.x + mc.w + 12, 9);
  });

  test("a_label_in_a_block_takes_the_block_wash", () => {
    const lay = layoutOf(`${AB}A -> B: out\nopt card {\n  loop retry {\n    A -> B: in\n  }\n}`);
    const d = lay.seq!;
    const loop = d.blocks.findIndex((b) => b.kind === "loop");
    expect(d.messages[0].label!.bg).toBe("canvas");
    expect(d.messages[1].label!.bg).toBe(loop);
    expect(d.blocks[loop].index).toBe(loop);
  });

  test("a_block_holds_its_self_loop_label", () => {
    const long = "x".repeat(60);
    const inBlock = draw(`${AB}opt card {\n  B -> B: ${long}\n}`);
    const chip = inBlock.messages[0].label!.chip;
    const box = inBlock.blocks[0].box;
    expect(box.x + box.w).toBe(chip.x + chip.w + 12);
    expect(box.x).toBeLessThan(chip.x);
    const bare = draw(`${AB}B -> B: ${long}`);
    const c = bare.messages[0].label!.chip;
    expect(bare.bounds.x + bare.bounds.w).toBe(c.x + c.w);
    // A note goes right of everything drawn.
    const lay = layoutOf(`${AB}B -> B: ${long}\nnote: later`);
    const note = Object.keys(lay.positions).find((k) => k !== "A" && k !== "B")!;
    expect(lay.positions[note].x).toBeGreaterThan(c.x + c.w);
  });
});

describe("blocks", () => {
  test("nested_tabs_step_aside", () => {
    const d = draw(`${AB}alt a {\n  opt b {\n    loop c {\n      A -> B\n    }\n  }\n}`);
    const by = (k: string) => d.blocks.find((b) => b.kind === k)!;
    const [alt, opt, loop] = [by("alt"), by("opt"), by("loop")];
    expect(opt.tab.x - alt.tab.x).toBe(30);
    expect(loop.tab.x - opt.tab.x).toBe(30);
    expect(loop.tab.x).toBe(laneX("A") - 54);
    expect(loop.box.x + loop.box.w).toBe(laneX("B") + 60);
    for (const [outer, inner] of [
      [alt, opt],
      [opt, loop],
    ]) {
      expect(inner.box.x).toBeGreaterThan(outer.box.x);
      expect(inner.box.y).toBeGreaterThan(outer.box.y);
      expect(inner.box.x + inner.box.w).toBeLessThan(outer.box.x + outer.box.w);
      expect(inner.box.y + inner.box.h).toBeLessThan(outer.box.y + outer.box.h);
    }
    expect(alt.tab).toEqual({ x: alt.box.x, y: alt.box.y, w: 24, h: alt.box.h });
    expect([alt.depth, opt.depth, loop.depth]).toEqual([0, 1, 2]);
  });

  test("a_short_block_drops_its_word", () => {
    const one = draw(`${AB}critical x {\n  A -> B\n}`).blocks[0];
    expect(one.word).toBe(false);
    expect(one.wordW).toBe(messageLabelW("critical", "word"));
    const three = draw(`${AB}loop x {\n  A -> B\n  B -> A\n  A -> B\n}`).blocks[0];
    expect(three.word).toBe(true);
    expect(three.wordW).toBe(messageLabelW("loop", "word"));
  });

  test("an_empty_block_takes_its_own_band", () => {
    // Between two messages: a header-height box in 28 px of its own, clear of both labels.
    const lay = layoutOf(`${AB}A -> B: one\nopt x {\n}\nB -> A: two`);
    expect(lay.rows).toEqual([78, 78 + 22 + 28 + 22]);
    const box = lay.seq!.blocks[0].box;
    expect(box).toEqual({ x: 6, y: 102, w: 54 + 60, h: 24 });
    expect(lay.seq!.messages[0].label!.chip.y + 18).toBeLessThan(box.y);
    expect(box.y + box.h).toBeLessThan(lay.seq!.messages[1].label!.chip.y);
    // After the last message: the band comes before the foot boxes.
    const tail = layoutOf(`${AB}A -> B\nopt x {\n}`);
    expect(tail.seq!.blocks[0].box).toMatchObject({ y: 102, h: 24 });
    expect(tail.lifeline).toBe(100 + 28 + 10);
    // Two empty blocks in a row take a band each.
    const two = layoutOf(`${AB}A -> B\nopt x {\n}\nloop y {\n}\nB -> A`);
    expect(two.seq!.blocks.map((b) => b.box.y)).toEqual([102, 130]);
    expect(two.rows![1]).toBe(100 + 56 + 22);
  });

  test("an_empty_block_first_inside_a_block_sits_inside_it", () => {
    // Task 4's carry: the loop opens on the same row as the empty opt inside it, so the loop's tab comes first and
    // the opt's band under it; both above the first row. Blocks are in close order: the opt is 0, the loop 1.
    const lay = layoutOf(`${AB}loop y {\n  opt x {\n  }\n  A -> B\n}`);
    const [opt, loop] = lay.seq!.blocks.map((b) => b.box);
    expect(lay.rows).toEqual([56 + 56 + 22]);
    expect(loop.y).toBe(58);
    expect(opt.y).toBe(86);
    expect(opt.y + opt.h).toBeLessThanOrEqual(loop.y + loop.h);
    expect(opt.x).toBeGreaterThan(loop.x);
    // Written the other way round, the empty opt before a loop that opens on the same row stays above it.
    const before = layoutOf(`${AB}opt x {\n}\nloop y {\n  A -> B\n}`);
    expect(before.seq!.blocks.map((b) => b.box.y)).toEqual([58, 86]);
  });

  test("a_block_without_text_has_no_caption", () => {
    const bare = draw(`${AB}loop {\n  A -> B\n}`).blocks[0];
    expect(bare.caption).toBe("");
    expect(bare.captionBox).toBeNull();
    const named = draw(`${AB}opt card saved [color: warning] {\n  A -> B\n}`).blocks[0];
    expect(named).toMatchObject({ kind: "opt", caption: "card saved", colour: "warning" });
    expect(named.captionBox).toEqual({ x: named.box.x + 28, y: named.box.y + 3, w: 70 + 12, h: 18 });
  });
});

describe("participants", () => {
  test("bars_wrap_their_rows", () => {
    const msgs: string[] = Array.from({ length: 10 }, (_, i) => (i % 2 ? "B -> A" : "A -> B"));
    msgs.splice(1, 0, "activate A");
    msgs.splice(10, 0, "deactivate A");
    const lay = layoutOf(`${AB}${msgs.join("\n")}`);
    const rows = lay.rows!;
    expect(lay.seq!.bars).toEqual([{ name: "A", who: "participant", x: 60 - 6, y: rows[1] - 6, h: rows[8] - rows[1] + 12 }]);
  });

  test("a_bar_with_no_message_ends_above_the_foot_box", () => {
    // activate after the last message: the bar ends 6 px below the last row's line, as a bar's tail does.
    const lay = layoutOf(`${AB}A -> B\nactivate A`);
    expect(lay.seq!.bars).toEqual([{ name: "A", who: "participant", x: 54, y: 78 + 6 - 32, h: 32 }]);
    expect(52 + 32).toBeLessThan(lay.seq!.lanes[0].bottom);
    // With no message at all it stays between the head and the foot box.
    const none = layoutOf(`${AB}activate A`);
    expect(none.seq!.bars[0]).toMatchObject({ y: 40, h: 26 });
    expect(none.seq!.lanes[0].bottom).toBe(66);
  });

  test("foot_boxes_sit_below_the_last_row", () => {
    const lay = layoutOf(`${AB}A -> B\nB -> A`);
    const rows = lay.rows!;
    const lastBottom = rows[1] - 22 + 44;
    for (const lane of lay.seq!.lanes) {
      expect(lane.bottom).toBe(lastBottom + 10);
      expect(lane.top).toBe(40);
    }
    expect(lay.lifeline).toBe(lastBottom + 10);
    expect(lay.sizes.get("A")).toEqual({ w: 120, h: lastBottom + 10 + 40 });
  });
});

describe("text size", () => {
  test("text_size_scales_labels_numbers_and_gaps", () => {
    const m = draw(`autonumber\n${AB}A -> B: authorize`, 1.15).messages[0];
    expect(m.label!.w).toBeCloseTo(72.45, 9);
    expect(m.number!.w).toBeCloseTo(20 * 1.15, 9);
    const twenty = `${AB}A -> B: ${"z".repeat(20)}`;
    draw(twenty, 1);
    expect(laneX("B") - laneX("A")).toBe(192);
    draw(twenty, 1.15);
    expect(laneX("B") - laneX("A")).toBeCloseTo(20 * 7 * 1.15 + 14 + 32, 9);
  });
});

test("gap_tree_sums_prefixes", () => {
  const t = new GapTree(5);
  t.add(1, 72);
  t.add(3, 10);
  t.add(1, 5);
  expect([0, 1, 2, 3, 4].map((i) => t.sum(i))).toEqual([0, 77, 77, 87, 87]);
});

test("pay_draws_as_the_mockup", () => {
  const d = drawingOf(PAY);
  expect(d.messages.map((m) => m.number?.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(d.messages.filter((m) => m.self).map((m) => m.index)).toEqual([2]);
  expect(d.messages.filter((m) => m.reply)).toHaveLength(4);
  expect(d.bars.map((b) => b.name)).toEqual(["Card provider", "Billing API"]);
  expect(d.blocks).toHaveLength(1);
  const [opt] = d.blocks;
  expect(opt).toMatchObject({ kind: "opt", colour: "warning", caption: "card saved" });
  const six = d.messages[5];
  expect(six.label!.bg).toBe(0);
  expect(six.y).toBeGreaterThan(opt.box.y);
  expect(six.y).toBeLessThan(opt.box.y + opt.box.h);
  for (const i of [4, 6]) expect(d.messages[i].label!.bg).toBe("canvas");
  expect(d.lanes.map((l) => l.colour)).toEqual(["muted", "info", "accent", "warning", "success"]);
});
