// The ER canvas's commit rules on their own: typed text is never dropped silently (I6).
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ER_NOTES } from "../lang/flow/edits";
import { columnLine } from "../lang/flow/model";
import { parseFlow } from "../lang/flow/parse";
import { boardFrameId, clashInFrameId, duplicateFrameId, inFrameId } from "./board/boardScene";
import { EDIT_MESSAGES } from "./editWords";
import { createErStore, ER_MESSAGES, planColumnPaste, useErCanvas, useErLive } from "./erCanvas";
import type { RunResult } from "./useFlowDoc";
import staticIdsSource from "./board/staticIds.ts?raw";
import erCanvasSource from "./erCanvas.tsx?raw";
import kindEditSource from "./kindEdit.tsx?raw";
import kindNodesSource from "./kindNodes.tsx?raw";
import editWordsSource from "./editWords.ts?raw";
import erScrollSource from "./erScroll.ts?raw";
import erRelateSource from "./erRelate.ts?raw";
import useErRelateSource from "./useErRelate.ts?raw";

// The node a hook renders in: React Flow does not export its NodeIdContext, so its `useNodeId` reads this.
let nodeId: string | null = null;
vi.mock("@xyflow/react", async (orig) => ({ ...(await orig<typeof import("@xyflow/react")>()), useNodeId: () => nodeId }));

const DOC = parseFlow('diagram er "x"\ncustomers {\n  id int pk\n}\n').doc!;
let doc = DOC;
// A failed assertion never leaks a test's doc into the next.
afterEach(() => {
  doc = DOC;
});

type Run = (op: unknown, opts: { onRefused(note: string): void; frame: number }) => Promise<RunResult | null>;

function setup(over: { locked?: boolean; oldForm?: boolean; run?: Run; copy?: (text: string) => void } = {}) {
  const state = { locked: over.locked ?? false, oldForm: over.oldForm ?? false, stale: false };
  const run = vi.fn<Run>(over.run ?? (async () => ({ at: 0 })));
  const track = vi.fn();
  const notice = vi.fn();
  const hook = renderHook(() =>
    useErCanvas({
      doc: () => doc,
      run,
      frame: () => 7,
      track,
      oldForm: () => state.oldForm,
      locked: () => state.locked,
      stale: () => state.stale,
      readOnly: false,
      onRenamed: () => {},
      onPick: () => {},
      selection: () => [],
      notice,
      refocus: () => {},
      copy: over.copy,
    }),
  );
  return { hook, run, track, notice, state, api: () => hook.result.current.value.api, edit: () => hook.result.current.value.store.get().edit };
}

test("the Assistant taking the text mid-edit keeps the field and says why", async () => {
  const s = setup();
  act(() => s.api().addColumn("customers"));
  const draft = s.edit()!;
  s.state.locked = true;
  await act(async () => s.api().commit(draft, "email", "enter"));
  expect(s.edit()).toMatchObject({ kind: "draft", error: EDIT_MESSAGES.locked });
  expect(s.run).not.toHaveBeenCalled();
});

test("a write the text refuses keeps the field open with the reason", async () => {
  const s = setup({
    run: async (_op, o) => {
      o.onRefused(ER_NOTES.typeReads("int("));
      return null;
    },
  });
  act(() => s.api().addColumn("customers"));
  await act(async () => s.api().commit(s.edit()!, "email", "tab"));
  expect(s.edit()).toMatchObject({ kind: "draft", name: "email", field: "type" });
  await act(async () => s.api().commit(s.edit()!, "int(", "enter"));
  expect(s.edit()).toMatchObject({ kind: "draft", name: "email", type: "int(", error: ER_NOTES.typeReads("int(") });
  expect(s.run).toHaveBeenCalledWith({ op: "addColumn", table: "customers", at: 1, before: null, name: "email", type: "int(" }, expect.objectContaining({ frame: 7 }));
  // The write is tracked, and so is the whole commit, its refusal included, so a switch waiting for it sees the
  // field refused (Task 9, Review Focus 2): the run's promise among them.
  const ran = s.run.mock.results.map((r) => r.value);
  expect(s.track.mock.calls.some(([p]) => ran.includes(p))).toBe(true);
});

test("an_old_frame_takes_no_card_edits_and_says_why", async () => {
  const s = setup({ oldForm: true });
  expect(s.api().blocked("customers")).toBe(ER_NOTES.oldForm);
  act(() => s.api().editColumn("customers", 0, "name"));
  expect(s.edit()).toBeNull();
  act(() => s.api().addColumn("customers"));
  act(() => s.api().toggleFlag("customers", 0, "not null"));
  act(() => s.api().deleteColumn("customers", 0));
  expect(s.edit()).toBeNull();
  expect(s.notice).toHaveBeenCalledWith(ER_NOTES.oldForm);
  expect(s.run).not.toHaveBeenCalled();
  s.state.oldForm = false;
  expect(s.api().blocked("customers")).toBeNull();
});

test("a_quoted_table_edits_its_columns", async () => {
  doc = parseFlow('diagram er "x"\n"order lines" {\n  id int\n}\n').doc!;
  const s = setup();
  expect(s.api().blocked("order lines")).toBeNull();
  act(() => s.api().editColumn("order lines", 0, "name"));
  await act(async () => s.api().commit(s.edit()!, "line_id", "enter"));
  expect(s.run).toHaveBeenCalledWith({ op: "setColumn", table: "order lines", index: 0, column: "id", name: "line_id" }, expect.objectContaining({ frame: 7 }));
  expect(s.edit()).toBeNull();
  doc = DOC;
});

test("a table or column gone from the text meanwhile keeps the field open and says so (fix round 2)", async () => {
  const s = setup();
  act(() => s.api().editColumn("customers", 0, "name"));
  const col = s.edit()!;
  doc = parseFlow('diagram er "x"\ncustomers\n').doc!;
  await act(async () => s.api().commit(col, "key", "enter"));
  expect(s.edit()).toMatchObject({ kind: "col", error: ER_MESSAGES.columnGone("customers") });
  doc = parseFlow('diagram er "x"\nclients\n').doc!;
  await act(async () => s.api().commit(s.edit()!, "key", "blur"));
  expect(s.edit()).toMatchObject({ kind: "col", error: ER_MESSAGES.tableGone("customers") });
  expect(s.run).not.toHaveBeenCalled();
  doc = DOC;
});

test("a_card_view_keeps_its_identity_while_another_card_changes", () => {
  const s = createErStore();
  const before = s.view("orders");
  s.set({ edit: { kind: "col", table: "customers", index: 0, field: "name" } });
  expect(s.view("orders")).toBe(before);
  expect(s.view("customers")).toMatchObject({ edit: { index: 0 } });
});

test("column_clip_text_quotes_a_spaced_type", () => {
  const t = parseFlow('diagram er "s"\norders {\n  placed_at "timestamp with time zone" not null // when\n}\n').doc!.nodes[0];
  expect(columnLine(t, 0, { comment: false })).toBe('placed_at "timestamp with time zone" not null');
});

test("a_set_wakes_only_the_tables_it_touches", () => {
  const s = createErStore();
  const orders = vi.fn();
  const customers = vi.fn();
  const offOrders = s.subscribe("orders", orders);
  const offCustomers = s.subscribe("customers", customers);
  expect(s.listeners()).toBe(2);
  s.set({ edit: { kind: "col", table: "customers", index: 0, field: "name" } });
  expect(customers).toHaveBeenCalledTimes(1);
  expect(orders).not.toHaveBeenCalled();
  const view = s.view("customers");
  // The selection landing on orders wakes orders; customers' slice is unchanged and stays asleep.
  s.set({ selected: { table: "orders", index: 1 } });
  expect(orders).toHaveBeenCalledTimes(1);
  expect(customers).toHaveBeenCalledTimes(1);
  expect(s.view("customers")).toBe(view);
  // The edit moving from customers to orders wakes both.
  s.set({ edit: { kind: "table", table: "orders" } });
  expect(customers).toHaveBeenCalledTimes(2);
  expect(orders).toHaveBeenCalledTimes(2);
  expect(s.view("customers")).toBeNull();
  expect(s.view("orders")).toMatchObject({ edit: { kind: "table" }, selected: 1, aim: null });
  s.set({ aim: { table: "orders", index: -1 } });
  expect(s.view("orders")).toMatchObject({ aim: -1 });
  offOrders();
  offCustomers();
  expect(s.listeners()).toBe(0);
  s.set({ edit: null, selected: null, aim: null });
  expect(s.size()).toBe(0);
});

test("static_ids_of_every_form_are_not_live", () => {
  const liveAt = (id: string | null) => {
    nodeId = id;
    return renderHook(() => useErLive()).result.current;
  };
  for (const id of [inFrameId("Shop", "orders"), inFrameId("a\u0000b", "orders"), clashInFrameId(2, "orders"), boardFrameId("Shop"), duplicateFrameId(2)]) expect(liveAt(id)).toBe(false);
  expect(liveAt("orders")).toBe(true);
  expect(liveAt(null)).toBe(true);
  nodeId = null;
});

test("a_cut_the_worker_refuses_without_a_note_says_the_text_changed", async () => {
  const s = setup({ run: async () => null });
  act(() => s.hook.result.current.value.store.set({ selected: { table: "customers", index: 0 } }));
  const key = { key: "x", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault: () => {} };
  await act(async () => {
    s.hook.result.current.onKey(key, ["customers"]);
  });
  expect(s.run).toHaveBeenCalledWith({ op: "deleteColumn", table: "customers", index: 0, column: "id" }, expect.objectContaining({ frame: 7 }));
  expect(s.notice).toHaveBeenCalledWith(EDIT_MESSAGES.changed);
});

test("the_card_modules_import_no_scene_canvas_or_card", () => {
  // boardScene > boardLayout > flowNodes reaches kindEdit and kindNodes: those read the id forms from a module with no
  // imports, so no cycle runs flowNodes while kindNodes is half evaluated.
  expect(staticIdsSource).not.toMatch(/^\s*(import|export\s.*\sfrom\s)/m);
  for (const src of [erCanvasSource, kindEditSource, kindNodesSource]) {
    expect(src).not.toMatch(/from "\.\/board\/boardScene"/);
    // flowNodes imports the cards: an import back is a cycle.
    expect(src).not.toMatch(/from "\.\/flowNodes"/);
    expect(src).not.toMatch(/import\(/);
  }
  // B3 Task 2: the card reads erCanvas, so erCanvas's own runtime imports (and re-exports) reach no card, no canvas and
  // no scene: only the leaf ids, the words (type imports only) and the language modules that import nothing of src/flow.
  const runtime = [...erCanvasSource.matchAll(/^(?:import|export) (?!type )[^;]*? from "([^"]+)";/gms)].map((m) => m[1]).filter((f) => f.startsWith("."));
  // Task 4: planColumnPaste reads a copied line with parseFlow; edits already imports parse, so it reaches nothing new.
  // Final review: the one refusal chain and table predicate come from erRelate, which reaches only leaves itself.
  const allowed = ["./board/staticIds", "./editWords", "./erRelate", "../lang/flow/edits", "../lang/flow/model", "../lang/flow/parse"];
  expect(runtime.filter((f) => !allowed.includes(f))).toEqual([]);
  expect(editWordsSource).not.toMatch(/^import (?!type )/m);
  // B3 Task 5: the card and the line read the scroll store, so it imports nothing of src at all (React only).
  expect([...erScrollSource.matchAll(/^import [^;]*? from "([^"]+)";/gms)].map((m) => m[1])).toEqual(["react"]);
});

test("use_er_relate_reaches_no_card_canvas_or_scene", () => {
  // B3 Task 7: FlowTab's relationship hook and the planning it runs import no card, no canvas and no scene at run time,
  // so no cycle runs back through kindNodes, flowNodes or boardScene (kindNodes reads erRelate's port prefix).
  const runtime = (src: string) => [...src.matchAll(/^(?:import|export) (?!type )[^;]*? from "([^"]+)";/gms)].map((m) => m[1]).filter((f) => f.startsWith("."));
  // Task 9: the pure language model too (`needsQuotes`, `splitRow`), as erRelate reads it.
  const allowed = ["../diagram/route", "../lang/flow/edits", "../lang/flow/model", "./board/staticIds", "./editWords", "./erRelate", "./kindLayout"];
  expect(runtime(useErRelateSource).filter((f) => !allowed.includes(f))).toEqual([]);
  expect(runtime(erRelateSource).filter((f) => !["../lang/flow/edits", "../lang/flow/model", "./editWords", "./kindLayout"].includes(f))).toEqual([]);
  for (const src of [useErRelateSource, erRelateSource]) expect(src).not.toMatch(/import\(/);
});

// ---- B3 Task 4: the column clipboard (decision 11) and one flag write at a time

test("plan_column_paste_reads_the_old_line_and_frees_the_name", () => {
  const d = parseFlow('diagram er "x"\ncustomers {\n  id int pk\n  email text\n}\norders {\n  id int pk\n}\n').doc!;
  const customers = d.nodes.find((n) => n.name === "customers")!;
  // (b) the old line of a table of this frame, onto a table that has `id`: named id_copy, its flags kept.
  expect(planColumnPaste("orders.id int [pk]", d, customers, 1, null)).toEqual({ op: "addColumn", table: "customers", at: 1, before: "email", name: "id_copy", type: "int", flags: ["pk"] });
  // (a) the copied block line: a quoted type is read back unquoted, and a taken name freed again.
  const copied = 'id "timestamp with time zone" not null\n';
  expect(planColumnPaste(copied, d, customers, 2, copied)).toEqual({ op: "addColumn", table: "customers", at: 2, before: null, name: "id_copy", type: "timestamp with time zone", flags: ["not null"] });
  // id_copy taken too: id_copy2.
  const taken = parseFlow('diagram er "x"\ncustomers {\n  id int\n  id_copy int\n}\n').doc!;
  expect(planColumnPaste("customers.id int", taken, taken.nodes[0], 2, null)).toMatchObject({ name: "id_copy2", flags: [] });
  // A table the frame does not have, or text with only a dot, is not a column line.
  expect(planColumnPaste("shipments.id int", d, customers, 0, null)).toBeNull();
  expect(planColumnPaste("example.com", d, customers, 0, null)).toBeNull();
  // A quoted type in the old line is read unquoted, as the copied line's is (review Minor 5).
  expect(planColumnPaste('orders.placed_at "timestamp with time zone" [not null]', d, customers, 2, null)).toMatchObject({ name: "placed_at", type: "timestamp with time zone", flags: ["not null"] });
});

test("plan_column_paste_takes_only_its_two_inputs", () => {
  const d = parseFlow('diagram er "x"\ncustomers {\n  email text\n}\n').doc!;
  const customers = d.nodes[0];
  // A block line that is not the copied one is not a column paste.
  expect(planColumnPaste("id int pk", d, customers, 1, "email text\n")).toBeNull();
  expect(planColumnPaste("id int pk", d, customers, 1, null)).toBeNull();
  // Equal to the copied line it is; and a copied line that does not read as one column is not.
  expect(planColumnPaste("id int pk", d, customers, 1, "id int pk\n")).toMatchObject({ name: "id", type: "int", flags: ["pk"] });
  expect(planColumnPaste("id int pk {", d, customers, 1, "id int pk {")).toBeNull();
});

test("a_second_flag_press_while_the_first_is_written_writes_nothing", async () => {
  let land: (r: RunResult | null) => void = () => {};
  const s = setup({ run: () => new Promise((r) => (land = r)) });
  act(() => s.api().toggleFlag("customers", 0, "unique"));
  act(() => s.api().toggleFlag("customers", 0, "unique"));
  expect(s.run).toHaveBeenCalledTimes(1);
  await act(async () => land({ at: 0 }));
  // Written: the next press writes again.
  act(() => s.api().toggleFlag("customers", 0, "unique"));
  expect(s.run).toHaveBeenCalledTimes(2);
  // A refused write lets go too.
  await act(async () => land(null));
  act(() => s.api().toggleFlag("customers", 0, "unique"));
  expect(s.run).toHaveBeenCalledTimes(3);
});

test("a_refused_cut_leaves_the_clipboard_alone", async () => {
  // Review Minor 3: in an old-form frame Ctrl+X says why and copies nothing; Ctrl+C there still copies.
  const copy = vi.fn();
  const s = setup({ oldForm: true, copy });
  act(() => s.hook.result.current.value.store.set({ selected: { table: "customers", index: 0 } }));
  const key = (k: string) => ({ key: k, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault: () => {} });
  act(() => {
    s.hook.result.current.onKey(key("x"), ["customers"]);
  });
  expect(copy).not.toHaveBeenCalled();
  expect(s.run).not.toHaveBeenCalled();
  expect(s.notice).toHaveBeenCalledWith(ER_NOTES.oldForm);
  act(() => {
    s.hook.result.current.onKey(key("c"), ["customers"]);
  });
  expect(copy).toHaveBeenCalledWith("id int pk\n");
});

test("an_untouched_field_closes_under_a_text_error_and_a_changed_one_says_why", async () => {
  // Final review Minor 6: nothing typed is nothing to write, so the stale note never holds it (or a frame switch).
  const s = setup();
  act(() => s.api().editColumn("customers", 0, "type"));
  let e = s.edit()!;
  s.state.stale = true;
  await act(async () => s.api().commit(e, "int", "blur"));
  expect(s.edit()).toBeNull();
  expect(s.notice).not.toHaveBeenCalledWith(EDIT_MESSAGES.stale);
  s.state.stale = false;
  act(() => s.api().editTable("customers"));
  e = s.edit()!;
  s.state.stale = true;
  await act(async () => s.api().commit(e, "customers", "enter"));
  expect(s.edit()).toBeNull();
  // A changed value still says why and keeps what was typed.
  s.state.stale = false;
  act(() => s.api().editColumn("customers", 0, "type"));
  e = s.edit()!;
  s.state.stale = true;
  await act(async () => s.api().commit(e, "bigint", "blur"));
  expect(s.edit()).toMatchObject({ kind: "col", typed: "bigint", error: EDIT_MESSAGES.stale });
  expect(s.run).not.toHaveBeenCalled();
});

test("an_untouched_rename_of_a_table_with_a_dotted_name_closes", async () => {
  // Minor 6: the unchanged check comes first in commitTable too, so a name the field would refuse as typed is no
  // refusal when it is the table's own.
  doc = parseFlow('diagram er "x"\nsales.customers {\n  id int pk\n}\n').doc!;
  const s = setup();
  act(() => s.api().editTable("sales.customers"));
  const e = s.edit()!;
  await act(async () => s.api().commit(e, "sales.customers", "blur"));
  expect(s.edit()).toBeNull();
  expect(s.run).not.toHaveBeenCalled();
});
