import { expect, test } from "vitest";
import type { TextEdit } from "../protocol";
import { ICON_LOOKUP_BUDGET, parseFlow } from "./parse";
import { applyEdits, CLOSED_KEPT, createFlowService } from "./service";

const CLOUD = ['diagram cloud "Order API"', "Orders [icon: aws-dynamdb]", "Assets [icon: aws-s3]", ""].join("\n");

test("the_unknown_icon_problem_runs_once_the_icon_list_is_sent", () => {
  const flow = createFlowService();
  // Before the list arrives nothing is checked, so nothing is wrongly called unknown.
  expect(flow.parse("a", CLOUD).problems).toEqual([]);
  flow.setIcons(["aws-dynamodb", "aws-s3", "users"]);
  const r = flow.parse("a", CLOUD);
  expect(r.problems.map((p) => [p.line, p.severity, p.message])).toEqual([[2, "hint", "aws-dynamdb is not an icon. Did you mean aws-dynamodb?"]]);
  expect(r.problems[0].fixes.map((f) => f.title)).toEqual(["Use aws-dynamodb"]);
  // A hint keeps the drawing.
  expect(r.doc).not.toBeNull();
});

test("only_a_cloud_diagram_checks_its_icons", () => {
  const flow = createFlowService();
  flow.setIcons(["aws-s3"]);
  expect(flow.parse("a", 'diagram dfd "x"\nA [process, icon: nope]\n').problems.filter((p) => p.message.includes("not an icon"))).toEqual([]);
});

test("a_misspelt_icon_is_compared_with_the_list_once", () => {
  const flow = createFlowService();
  const names = Array.from({ length: 4000 }, (_, i) => `aws-icon-${i}`);
  flow.setIcons([...names, "aws-dynamodb"]);
  const many = ['diagram cloud "x"', ...Array.from({ length: 2000 }, (_, i) => `N${i} [icon: aws-dynamdb]`), ""].join("\n");
  const r = flow.parse("a", many);
  expect(r.problems.length).toBeGreaterThan(0);
  expect(r.problems[0].message).toBe("aws-dynamdb is not an icon. Did you mean aws-dynamodb?");
});

/** An icon set that counts how many names the parser reads from it. */
function countingIcons(names: string[]) {
  const set = new Set(names);
  const counter = { reads: 0 };
  const icons = {
    has: (n: string) => set.has(n),
    size: set.size,
    *[Symbol.iterator]() {
      for (const n of set) {
        counter.reads++;
        yield n;
      }
    },
  } as unknown as ReadonlySet<string>;
  return { icons, counter };
}

test("unknown_icon_lookups_have_a_per_parse_budget", () => {
  const names = Array.from({ length: 4000 }, (_, i) => `aws-icon-${i}`);
  const { icons, counter } = countingIcons(names);
  // A pasted diagram with 3,000 different foreign icon names.
  const text = ['diagram cloud "x"', ...Array.from({ length: 3000 }, (_, i) => `N${i} [icon: other-${i}]`), ""].join("\n");
  const iconNear = new Map<string, string | null>();
  const first = parseFlow(text, { icons, iconNear });
  // Every unknown name is still a hint; only the "Did you mean" search is limited.
  expect(first.problems.filter((p) => p.message.includes("is not an icon")).length).toBeGreaterThan(0);
  expect(counter.reads).toBeLessThanOrEqual(ICON_LOOKUP_BUDGET + names.length);
  // The next parse looks up the next names; the ones already known cost nothing.
  counter.reads = 0;
  parseFlow(text, { icons, iconNear });
  expect(counter.reads).toBeLessThanOrEqual(ICON_LOOKUP_BUDGET + names.length);
  expect(iconNear.size).toBeGreaterThan(0);
  // Past the budget the hint has no suggestion.
  expect(first.problems.some((p) => p.message === "other-150 is not an icon.")).toBe(true);
});

test("an_icon_list_past_the_budget_never_defers_its_lookup", () => {
  // No parse could ever look up a name in it, so the parse is not owed one and a board keeps reusing it.
  const { icons, counter } = countingIcons(Array.from({ length: ICON_LOOKUP_BUDGET + 1 }, (_, i) => `i${i}`));
  const r = parseFlow('diagram cloud "x"\nA [icon: nope]\n', { icons, iconNear: new Map() });
  expect(r.problems.map((p) => p.message)).toEqual(["nope is not an icon."]);
  expect(r.iconsDeferred).toBe(false);
  expect(counter.reads).toBe(0);
  // Under the budget a name past this parse's lookups is owed one.
  const some = countingIcons(Array.from({ length: 4000 }, (_, i) => `i${i}`));
  const owed = parseFlow(['diagram cloud "x"', ...Array.from({ length: 30 }, (_, i) => `N${i} [icon: x${i}]`), ""].join("\n"), { icons: some.icons, iconNear: new Map() });
  expect(owed.iconsDeferred).toBe(true);
});

test("the_misspelling_cache_drops_its_oldest_entry_not_everything", () => {
  const { icons, counter } = countingIcons(["aws-s3"]);
  const iconNear = new Map<string, string | null>();
  for (let i = 0; i < 2001; i++) iconNear.set(`old-${i}`, null);
  iconNear.delete("old-2000");
  parseFlow('diagram cloud "x"\nA [icon: nope]\n', { icons, iconNear });
  expect(iconNear.has("nope")).toBe(true);
  expect(iconNear.has("old-1")).toBe(true);
  expect(iconNear.size).toBeLessThanOrEqual(2000);
  expect(counter.reads).toBe(1);
});

test("the_closed_ids_are_capped_and_a_just_closed_one_still_drops_late_parses", () => {
  // The audit's probe: 1,000 diagrams opened, parsed and closed left 1,000 names in the set.
  const flow = createFlowService();
  for (let i = 0; i < 1000; i++) {
    flow.open(`d${i}`);
    flow.parse(`d${i}`, "diagram dfd\nprocess A");
    flow.close(`d${i}`);
  }
  const closed = Array.from({ length: 1000 }, (_, i) => flow.isClosed(`d${i}`)).filter(Boolean);
  expect(closed).toHaveLength(CLOSED_KEPT);
  expect(flow.isClosed("d999")).toBe(true);
  expect(flow.isClosed("d0")).toBe(false);
  // Open again clears it; closing again makes it the newest.
  flow.open("d999");
  expect(flow.isClosed("d999")).toBe(false);
  flow.close("d999");
  expect(flow.isClosed("d999")).toBe(true);
});

test("a paste is one worker op on the cached parse: one edit list and the names it used", () => {
  const flow = createFlowService();
  const text = 'diagram flow "F"\nA\nB\n\nA > B\n';
  const { version } = flow.parse("p", text);
  const r = flow.edit("p", version, { op: "paste", text: "A\nB\nA > B\n" });
  expect(r).toEqual({
    stale: false,
    edits: [
      { from: 21, to: 21, insert: "A 2\nB 2\n" },
      { from: 28, to: 28, insert: "A 2 > B 2\n" },
    ],
    names: { A: "A 2", B: "B 2" },
  });
  // Text that is not this kind's lines is refused: no edits.
  expect(flow.edit("p", version, { op: "paste", text: "A > Nowhere" })).toMatchObject({ stale: false, edits: [] });
  // Planned on an older text: stale, as every canvas action.
  flow.parse("p", `${text}C\n`);
  expect(flow.edit("p", version, { op: "paste", text: "A\n" })).toEqual({ stale: true });
});

// The brief's board wrote only `Pay > Done`, which a flow diagram reads as two names not defined (no doc, no spans),
// so each frame defines its shapes first: frame 1 starts on line 6 and defines Pay on line 7.
const BOARD = 'diagram flow "Checkout"\nPay\nDone\nPay > Done\n\ndiagram flow "Refund"\nPay\nDone\nPay > Done\n';
const REFUND = BOARD.indexOf('diagram flow "Refund"');

test("a_parse_posts_every_frame_and_frame_zero_on_top", () => {
  const s = createFlowService();
  const r = s.parse("d", BOARD);
  expect(r.frames.map((f) => [f.kind, f.title, f.line])).toEqual([
    ["flow", "Checkout", 1],
    ["flow", "Refund", 6],
  ]);
  expect(r.doc).toEqual(r.frames[0].doc);
  expect(r.frames.map((f) => [f.index, f.from, f.to])).toEqual([
    [0, 0, BOARD.indexOf("\n\n") + 1],
    [1, REFUND, BOARD.length],
  ]);
});

test("edits_in_one_frame_never_touch_another", () => {
  const s = createFlowService();
  const { version } = s.parse("d", BOARD);
  const a = s.edit("d", version, { op: "renameNode", old: "Pay", next: "Charge" }, 1);
  expect(a.stale).toBe(false);
  expect(applyEdits(BOARD, (a as { edits: TextEdit[] }).edits)).toBe(BOARD.slice(0, REFUND) + BOARD.slice(REFUND).split("Pay").join("Charge"));
  const spans = s.spans("d", version, ["node:Pay"], ["Pay"], 1);
  expect(spans.stale === false && BOARD.slice(spans.spans["node:Pay"]!.from, spans.spans["node:Pay"]!.to)).toBe("Pay");
  expect(spans.stale === false && spans.lineOf.Pay).toBe(7);
});

test("a_crlf_board_edits_its_last_frame_with_crlf", () => {
  const t = '\ufeffdiagram flow "A"\r\nA\r\n\r\ndiagram flow "B"\r\nB\r\n\r\ndiagram flow "C"\r\nC\r\n';
  const s = createFlowService();
  const { version, problems } = s.parse("d", t);
  expect(problems).toEqual([]);
  const a = s.edit("d", version, { op: "addNode", name: "D", kind: null }, 2) as { edits: TextEdit[] };
  expect(applyEdits(t, a.edits)).toBe(`${t}D\r\n`);
});

test("completion_reads_the_frame_where_you_type", () => {
  const t = 'diagram flow "Checkout"\nPay\nDone\n\ndiagram flow "Refund"\nAsk\nRefund\nAsk > \n';
  const s = createFlowService();
  s.parse("d", t);
  const at = t.indexOf("Ask > \n") + 6;
  const names = s.complete("d", t, at);
  expect(names.from).toBe(at);
  expect(names.items.filter((i) => i.kind === "node").map((i) => i.label)).toEqual(["Ask", "Refund"]);
  // A newer text than the cached one reads the same frame.
  const newer = `${t.slice(0, at)}R${t.slice(at)}`;
  expect(s.complete("d", newer, at + 1).items.map((i) => i.label)).toEqual(["Refund"]);
  // A column-0 "diagram s" on line 9 is a frame being started: the kinds are offered.
  const k = `${t}diagram s`;
  s.parse("d", k);
  const kinds = s.complete("d", k, k.length);
  expect(kinds.from).toBe(k.length - 1);
  expect(kinds.items.map((i) => i.label)).toEqual(["sequence", "state"]);
});

test("a_paste_past_the_board_limit_is_refused", () => {
  const frame = (i: number, n: number) => `diagram flow "F${i}"\n${Array.from({ length: n }, (_, k) => `N${i}x${k}`).join("\n")}\n`;
  const t = [frame(0, 2000), frame(1, 2000), frame(2, 2000), frame(3, 2000), frame(4, 1000), frame(5, 999)].join("\n");
  const s = createFlowService();
  const { version } = s.parse("d", t);
  expect(s.edit("d", version, { op: "paste", text: "P\nQ\n" }, 5)).toEqual({ stale: false, edits: [], note: "This board would have more than 10,000 shapes, so nothing was added." });
  expect(s.edit("d", version, { op: "insert", text: 'diagram flow "M"\nP\nQ\n' }, 5)).toEqual({ stale: false, edits: [], note: "This board would have more than 10,000 shapes, so nothing was added." });
  // One shape still fits.
  const one = s.edit("d", version, { op: "paste", text: "P\n" }, 5);
  expect(one.stale === false && one.edits.length).toBeGreaterThan(0);
});

test("a_frame_index_with_no_frame_answers_nothing", () => {
  const s = createFlowService();
  const { version } = s.parse("d", BOARD);
  expect(s.edit("d", version, { op: "addNode", name: "X", kind: null }, 2)).toEqual({ stale: false, edits: [] });
  expect(s.spans("d", version, ["node:Pay"], ["Pay"], 2)).toEqual({ stale: false, spans: { "node:Pay": null }, lineOf: { Pay: null } });
  const o = s.outline("d", version, 5);
  expect(o.stale === false && o.outline.nodes).toEqual([]);
});

test("the_outline_of_a_frame_is_in_file_lines", () => {
  const s = createFlowService();
  const { version } = s.parse("d", BOARD);
  const o = s.outline("d", version, 1);
  if (o.stale) throw new Error("expected an outline");
  expect(o.outline.nodes.map((n) => [n.name, n.line])).toEqual([
    ["Pay", 7],
    ["Done", 8],
  ]);
  expect(o.outline.links.map((l) => l.line)).toEqual([9]);
});

test("the_last_good_doc_is_kept_per_frame", () => {
  const s = createFlowService();
  const good = s.parse("d", BOARD);
  const broken = s.parse("d", BOARD.replace("Pay > Done\n\n", "Pay > Done [\n\n"));
  expect(broken.frames[0].doc).toBeNull();
  expect(broken.frames[0].lastValid).toEqual(good.frames[0].doc);
  expect(broken.lastValid).toEqual(good.frames[0].doc);
  // Frame 1 parses, so its doc is sent and no last good one.
  expect(broken.frames[1].doc).not.toBeNull();
  expect(broken.frames[1].lastValid).toBeNull();
});

test("an_insert_at_a_file_position_lands_in_its_frame", () => {
  const s = createFlowService();
  const { version } = s.parse("d", BOARD);
  const r = s.edit("d", version, { op: "insert", text: 'diagram flow "M"\nNew\n', at: BOARD.length }, 1);
  if (r.stale) throw new Error("expected edits");
  expect(applyEdits(BOARD, r.edits)).toBe(`${BOARD}New\n`);
});

test("new_icons_parse_every_frame_again", () => {
  const s = createFlowService();
  const t = 'diagram cloud "A"\nOrders [icon: aws-dynamdb]\n\ndiagram cloud "B"\nX [icon: aws-s3]\n';
  expect(s.parse("d", t).problems).toEqual([]);
  s.setIcons(["aws-dynamodb", "aws-s3"]);
  expect(s.parse("d", t).problems.map((p) => p.line)).toEqual([2]);
});

test("a_retyped_title_beside_an_untitled_frame_keeps_its_own_drawing", () => {
  const s = createFlowService();
  const t = 'diagram flow\nA\n\ndiagram flow "Refund"\nR\n';
  const good = s.parse("d", t);
  // Deleting the closing quote leaves frame 1 broken with no title, as frame 0 has none.
  const broken = s.parse("d", t.replace('"Refund"', '"Refund'));
  expect(broken.frames[1].doc).toBeNull();
  expect(broken.frames[1].title).toBe("");
  expect(broken.frames[1].lastValid).toEqual(good.frames[1].doc);
});

test("a_never_parsed_frame_moved_up_does_not_take_the_drawing_below", () => {
  const s = createFlowService();
  const a = 'diagram flow "A"\nA\n';
  const n = 'diagram flow "N"\nX > Nowhere\n';
  s.parse("d", `${a}\n${n}`);
  const moved = s.parse("d", `${n}\n${a}`);
  expect(moved.frames[0].title).toBe("N");
  expect(moved.frames[0].lastValid).toBeNull();
  expect(moved.lastValid).toBeNull();
  // Nothing wrong sticks: one more parse still has none.
  expect(s.parse("d", `${n}\n${a}`).frames[0].lastValid).toBeNull();
});

test("a_broken_frame_of_another_kind_pasted_over_does_not_take_the_drawing", () => {
  const s = createFlowService();
  const keep = 'diagram flow "Checkout"\nPay\n';
  s.parse("d", `${keep}\ndiagram flow "Refund"\nR\n`);
  const pasted = s.parse("d", `${keep}\ndiagram state "Return"\nIdle > Gone\n`);
  expect(pasted.frames[1].kind).toBe("state");
  expect(pasted.frames[1].doc).toBeNull();
  expect(pasted.frames[1].lastValid).toBeNull();
});

test("a_one_diagram_file_keeps_its_drawing_while_its_title_is_typed", () => {
  const s = createFlowService();
  const good = s.parse("d", 'diagram flow "Checkout"\nPay\n');
  const typing = s.parse("d", 'diagram flow "Check\nPay\n');
  expect(typing.doc).toBeNull();
  expect(typing.lastValid).toEqual(good.doc);
  // An untitled one-diagram file keeps it too while its body is broken.
  const untitled = s.parse("d2", "diagram flow\nPay\n");
  expect(s.parse("d2", "diagram flow\nPay [\n").lastValid).toEqual(untitled.doc);
});

test("the_outline_of_a_broken_frame_uses_its_own_last_good_doc", () => {
  const s = createFlowService();
  // Frame 0 is untitled, and the broken frame 1 reads as untitled too: its kinds still come from its own doc.
  const t = 'diagram flow\nA\n\ndiagram flow "B"\nB\n';
  const good = s.parse("d", t);
  const { version } = s.parse("d", t.replace('"B"', '"B'));
  const o = s.outline("d", version, 1);
  if (o.stale) throw new Error("expected an outline");
  expect(o.outline.nodes.map((n) => [n.name, n.kind])).toEqual([["B", good.frames[1].doc!.nodes[0].kind]]);
  expect(good.frames[1].doc!.nodes[0].kind).not.toBeNull();
});

test("an_unchanged_frame_gets_its_deferred_icon_suggestions", () => {
  const s = createFlowService();
  s.setIcons(Array.from({ length: 4000 }, (_, i) => `aws-icon-${i}`));
  // 4,000 icons a lookup: one parse looks up 25 names, so the last 5 wait for the next parse.
  const cloud = `diagram cloud "C"\n${Array.from({ length: 30 }, (_, i) => `N${i} [icon: aws-icon-${i}x]`).join("\n")}\n`;
  const t = `${cloud}\ndiagram flow "F"\nA\n`;
  const first = s.parse("d", t);
  const last = (r: typeof first) => r.problems.find((p) => p.message.startsWith("aws-icon-29x"))!.message;
  expect(last(first)).toBe("aws-icon-29x is not an icon.");
  // Only frame 1 changes; frame 0 still gets the suggestions it was owed.
  const next = s.parse("d", t.replace("A\n", "B\n"));
  expect(last(next)).toBe("aws-icon-29x is not an icon. Did you mean aws-icon-29?");
});

test("completion_past_the_fifty_read_frames_offers_no_names_from_frame_49", () => {
  const s = createFlowService();
  const t = `${Array.from({ length: 52 }, (_, i) => `diagram flow "F${i}"\nA${i}\n`).join("\n")}A51 > `;
  s.parse("d", t);
  const r = s.complete("d", t, t.length);
  expect(r.items.filter((i) => i.label === "A49")).toEqual([]);
});

test("completion_offers_a_tables_columns_after_a_dot_in_an_er_frame", () => {
  const s = createFlowService();
  const t = 'diagram er "Shop"\ncustomers {\n  id int pk\n  email text\n}\norders > customers.';
  s.parse("d", t);
  expect(s.complete("d", t, t.length).items.map((i) => i.label)).toEqual(["id", "email"]);
});

test("a_row_span_names_its_column_line", () => {
  const s = createFlowService();
  const t = 'diagram flow "Checkout"\nPay\n\ndiagram er "Shop"\norders {\n  id int pk\n  customer_id int\n  total numeric\n}\n';
  const { version } = s.parse("d", t);
  const r = s.spans("d", version, ["row:orders:2", "row:orders:3", "row:nope:0"], [], 1);
  if (r.stale) throw new Error("stale");
  const sp = r.spans["row:orders:2"]!;
  // The row's own text, from its name on, shifted to the frame as every span is: a slice of the whole board's text.
  expect(t.slice(sp.from, sp.to)).toBe("total numeric");
  expect(r.spans["row:orders:3"]).toBeNull();
  expect(r.spans["row:nope:0"]).toBeNull();
});

/** An ER frame titled `title` with one table per name; `broken` leaves a line that does not read. */
const erFrame = (title: string, tables: string[], broken = false) =>
  `diagram er "${title}"\n${tables.map((t) => `${t} {\n  id int pk\n}\n`).join("")}${broken ? "oops [\n" : ""}`;
const names = (d: { nodes: { name: string }[] } | null) => d?.nodes.map((n) => n.name) ?? null;

test("a_frame_with_errors_never_takes_a_same_titled_frame_of_another_kind", () => {
  const s = createFlowService();
  const flow = 'diagram flow "Billing"\nPay [\n';
  const first = s.parse("d", `${erFrame("Billing", ["invoices"])}\n${flow}`);
  expect(first.frames[1].doc).toBeNull();
  expect(first.frames[1].lastValid).toBeNull();
  // The ER frame changes: the flow frame with errors still has nothing of its own.
  const edited = s.parse("d", `${erFrame("Billing", ["invoices", "payments"])}\n${flow}`);
  expect(edited.frames[0].doc).not.toBeNull();
  expect(edited.frames[1].doc).toBeNull();
  expect(edited.frames[1].lastValid).toBeNull();
  expect(edited.frames[1].lastValidId).toBeNull();
});

test("two_same_kind_frames_with_one_title_keep_their_own_last_good", () => {
  const s = createFlowService();
  const good = s.parse("d", `${erFrame("Billing", ["invoices"])}\n${erFrame("Billing", ["ledger"])}`);
  expect(names(good.frames[1].doc)).toEqual(["ledger"]);
  const broken = s.parse("d", `${erFrame("Billing", ["invoices"])}\n${erFrame("Billing", ["ledger"], true)}`);
  expect(broken.frames[1].doc).toBeNull();
  expect(names(broken.frames[1].lastValid)).toEqual(["ledger"]);
});

test("a_renamed_frame_with_errors_keeps_its_own_drawing", () => {
  const s = createFlowService();
  const pay = 'diagram flow "Pay"\nCard\n';
  s.parse("d", `${pay}\n${erFrame("Billing", ["invoices"])}`);
  // Renamed to a title the flow frame holds, and broken, in one edit.
  const r = s.parse("d", `${pay}\n${erFrame("Pay", ["invoices"], true)}`);
  expect(r.frames[1].doc).toBeNull();
  expect(names(r.frames[1].lastValid)).toEqual(["invoices"]);
});

test("a_moved_frame_keeps_its_own_drawing", () => {
  const s = createFlowService();
  const flow = (broken: boolean) => `diagram flow "Billing"\nCard\n${broken ? "Pay [\n" : ""}`;
  s.parse("d", `${flow(false)}\n${erFrame("Billing", ["invoices"])}`);
  // The ER frame moved above the flow frame, and both broken, in one edit.
  const r = s.parse("d", `${erFrame("Billing", ["invoices"], true)}\n${flow(true)}`);
  expect(r.frames.map((f) => [f.kind, f.doc])).toEqual([
    ["er", null],
    ["flow", null],
  ]);
  expect(names(r.frames[0].lastValid)).toEqual(["invoices"]);
  expect(names(r.frames[1].lastValid)).toEqual(["Card"]);
});

test("deleting_one_of_two_same_titled_frames_never_hands_its_drawing_to_the_other", () => {
  const s = createFlowService();
  s.parse("d", `${erFrame("Billing", ["invoices"])}\n${erFrame("Billing", ["ledger"])}`);
  const broken = s.parse("d", `${erFrame("Billing", ["invoices"])}\n${erFrame("Billing", ["ledger"], true)}`);
  expect(names(broken.frames[1].lastValid)).toEqual(["ledger"]);
  // The first goes: the survivor's pair was held by two frames before, so it draws its own empty box.
  const r = s.parse("d", erFrame("Billing", ["ledger"], true));
  expect(r.frames[0].lastValid).toBeNull();
});

test("retyping_the_kind_word_keeps_a_frames_own_drawing", () => {
  const pay = 'diagram flow "Pay"\nCard\n';
  for (const broken of [false, true]) {
    const body = erFrame("Billing", ["invoices"], broken);
    // The first frame: its kind word mid-edit reads as no kind, and it keeps its own drawing through it.
    const s = createFlowService();
    s.parse("d", `${erFrame("Billing", ["invoices"])}\n${pay}`);
    s.parse("d", `${body}\n${pay}`);
    const mid = s.parse("d", `${body.replace("diagram er", "diagram e")}\n${pay}`);
    expect(mid.frames[0].kind).toBeNull();
    expect(names(mid.frames[0].doc ?? mid.frames[0].lastValid)).toEqual(["invoices"]);
    const back = s.parse("d", `${body}\n${pay}`);
    expect(names(back.frames[0].doc ?? back.frames[0].lastValid)).toEqual(["invoices"]);
    // A later frame: mid-edit its header is no header (it joins the frame above), and it comes back with its own.
    const t = createFlowService();
    t.parse("d", `${pay}\n${erFrame("Billing", ["invoices"])}`);
    t.parse("d", `${pay}\n${body}`);
    const mid2 = t.parse("d", `${pay}\n${body.replace("diagram er", "diagram e")}`);
    expect(mid2.frames).toHaveLength(1);
    // The frame above keeps its own drawing while the header joins it.
    expect(names(mid2.frames[0].doc ?? mid2.frames[0].lastValid)).toEqual(["Card"]);
    expect(t.parse("d", `${pay}\n${body.replace("diagram er", "diagram ")}`).frames).toHaveLength(1);
    const again = t.parse("d", `${pay}\n${body}`);
    expect(names(again.frames[0].doc ?? again.frames[0].lastValid)).toEqual(["Card"]);
    expect(names(again.frames[1].doc ?? again.frames[1].lastValid)).toEqual(["invoices"]);
  }
  // A known other kind still drops it.
  const s = createFlowService();
  s.parse("d", erFrame("Billing", ["invoices"]));
  s.parse("d", erFrame("Billing", ["invoices"]).replace("diagram er", "diagram e"));
  expect(s.parse("d", 'diagram flow "Billing"\nPay [\n').frames[0].lastValid).toBeNull();
});

test("a_frame_deleted_and_added_elsewhere_never_takes_the_drawing", () => {
  const s = createFlowService();
  const pay = 'diagram flow "Pay"\nCard\n';
  const ship = 'diagram flow "Ship"\nBox\n';
  s.parse("d", `${erFrame("Billing", ["invoices"])}\n${pay}\n${ship}`);
  s.parse("d", `${pay}\n${ship}`);
  // A new broken ER frame with the gone title, at another place.
  expect(s.parse("d", `${pay}\n${ship}\n${erFrame("Billing", [], true)}`).frames[2].lastValid).toBeNull();
});

test("a_frame_written_long_after_a_delete_takes_nothing", () => {
  const s = createFlowService();
  const pay = (n: number) => `diagram flow "Pay"\nCard ${n}\n`;
  s.parse("d", `${pay(0)}\n${erFrame("Billing", ["invoices"])}`);
  s.parse("d", pay(0));
  for (let n = 1; n <= 500; n++) s.parse("d", pay(n));
  const r = s.parse("d", `${pay(500)}\n${erFrame("Billing", ["fresh"], true)}`);
  expect(r.frames[1].doc).toBeNull();
  expect(r.frames[1].lastValid).toBeNull();
  // Even a few parses on, a frame back at the place takes nothing once the store's three parses are over.
  const t = createFlowService();
  t.parse("d", `${pay(0)}\n${erFrame("Billing", ["invoices"])}`);
  for (let n = 0; n < 4; n++) t.parse("d", pay(n));
  expect(t.parse("d", `${pay(4)}\n${erFrame("Billing", [], true)}`).frames[1].lastValid).toBeNull();
});

test("shrinking_pastes_keep_one_generation_of_gone_frames", () => {
  /** How many gone frames the worker keeps after parsing `text`. */
  const goneAfter = (s: ReturnType<typeof createFlowService>, text: string) => s.current("d", s.parse("d", text).version)!.gone?.entries.length ?? 0;
  const board = (n: number, gen: number) => Array.from({ length: n }, (_, i) => erFrame(`T${gen}-${i}`, [`t${gen}_${i}`])).join("\n");
  const s = createFlowService();
  s.parse("d", board(6, 0));
  // Replace-all pastes with new titles: no frame merely left, so nothing is kept.
  for (let gen = 1; gen <= 5; gen++) expect(goneAfter(s, board(6 - gen, gen))).toBe(0);
  // Deletes in a row: only the latest one's frame is kept, and for three parses at most.
  const keep = (n: number, extra = "") => Array.from({ length: n }, (_, i) => erFrame(`T0-${i}`, [`t0_${i}`, ...(extra ? [extra] : [])])).join("\n");
  const t = createFlowService();
  t.parse("d", keep(4));
  expect(goneAfter(t, keep(3))).toBe(1);
  expect(goneAfter(t, keep(2))).toBe(1);
  expect(goneAfter(t, keep(2, "x1"))).toBe(1);
  expect(goneAfter(t, keep(2, "x2"))).toBe(1);
  expect(goneAfter(t, keep(2, "x3"))).toBe(0);
});

test("a_half_typed_kind_on_frame_zero_takes_only_its_own_kinds_doc", () => {
  const s = createFlowService();
  const pay = 'diagram flow "Pay"\nCard\n';
  s.parse("d", `${erFrame("Billing", ["invoices"])}\n${pay}`);
  // In one paste frame 0 becomes another frame with no kind yet: it takes nothing.
  const r = s.parse("d", `diagram e "Ledger"\nrows {\n\n${pay}`);
  expect(r.frames[0].kind).toBeNull();
  expect(r.frames[0].lastValid).toBeNull();
  // Its own half-typed kind word keeps its own, through several keystrokes.
  const t = createFlowService();
  t.parse("d", `${erFrame("Billing", ["invoices"])}\n${pay}`);
  for (const w of ["diagram e", "diagram ", "diagram e"]) {
    const mid = t.parse("d", `${erFrame("Billing", ["invoices"], true).replace("diagram er", w)}\n${pay}`);
    expect(names(mid.frames[0].lastValid)).toEqual(["invoices"]);
  }
  // A known other kind then drops it.
  expect(t.parse("d", `${erFrame("Billing", ["invoices"], true).replace("diagram er", "diagram flow")}\n${pay}`).frames[0].lastValid).toBeNull();
});

test("board_outline_answers_every_frame_once_with_problems", () => {
  const s = createFlowService();
  const shop = ['diagram er "Shop"', "orders {", "  id int pk", "  customer_id int", "}", "customers {", "  id int pk", "}", "orders.customer_id > customers.id", ""].join("\n");
  const broken = ['diagram flow "Broken"', ...Array.from({ length: 12 }, (_, i) => `A${i} [color: ${"q".repeat(300)}]`), ""].join("\n");
  const text = `${BOARD}\n${shop}\n${broken}`;
  const { version, frames } = s.parse("d", text);
  const r = s.boardOutline("d", version);
  if (r.stale) throw new Error("expected the board's outline");
  // Every frame once, in text order, with its place in the text.
  expect(r.frames.map((f) => [f.index, f.title, f.kind, f.from, f.to, f.line])).toEqual(frames.map((f) => [f.index, f.title, f.kind, f.from, f.to, f.line]));
  // Each outline is the one `outline` gives for that frame (file lines), so ER tables carry their columns.
  r.frames.forEach((f, i) => expect(f.outline).toEqual((s.outline("d", version, i) as { outline: unknown }).outline));
  const er = r.frames[2].outline;
  expect(er.nodes.map((n) => [n.name, n.columns])).toEqual([
    ["orders", ["id", "customer_id"]],
    ["customers", ["id"]],
  ]);
  expect(er.links).toEqual([expect.objectContaining({ from: "orders", to: "customers", fromColumn: "customer_id", toColumn: "id", line: frames[2].line + 8 })]);
  // Problems in frame lines, at most 10, each message at most 200 characters.
  expect(r.frames[0].problems).toEqual([]);
  const p = r.frames[3].problems;
  expect(p).toHaveLength(10);
  expect(p[0].line).toBe(2);
  expect(p.every((x) => x.message.length <= 200)).toBe(true);
  expect(p[0].message.startsWith("q".repeat(100))).toBe(true);
  expect(Object.keys(p[0]).sort()).toEqual(["line", "message"]);
  // A newer text makes the answer stale.
  s.parse("d", `${text}\n`);
  expect(s.boardOutline("d", version)).toEqual({ stale: true });
});

test("a_long_problem_message_is_cut_by_characters_not_halves", () => {
  // 150 emoji are 300 UTF-16 units but 150 characters: the message is longer than 200 units, yet only the
  // characters count, and a cut never splits an emoji.
  const s = createFlowService();
  const emoji = "\u{1F600}".repeat(150);
  const { version } = s.parse("d", `diagram flow "E"\nA [color: ${emoji}]\nB [color: ${"\u{1F600}".repeat(300)}]\n`);
  const r = s.boardOutline("d", version);
  if (r.stale) throw new Error("expected the board's outline");
  const [short, long] = r.frames[0].problems.map((p) => p.message);
  expect(short.startsWith(emoji)).toBe(true);
  expect(Array.from(short).length).toBeLessThanOrEqual(200);
  expect(short.length).toBeGreaterThan(200);
  expect(Array.from(long)).toHaveLength(200);
  expect(long).toBe("\u{1F600}".repeat(200));
});
