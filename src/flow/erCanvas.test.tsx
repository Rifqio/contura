// The ER canvas's commit rules on their own: typed text is never dropped silently (I6).
import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { parseFlow } from "../lang/flow/parse";
import { ER_MESSAGES, useErCanvas } from "./erCanvas";

const DOC = parseFlow('diagram er "x"\ncustomers\ncustomers.id int [pk]\nsales.orders [entity]\n').doc!;
let doc = DOC;

function setup(over: { locked?: boolean; run?: () => Promise<unknown> } = {}) {
  const state = { locked: over.locked ?? false };
  const run = vi.fn(over.run ?? (async () => ({ at: 0 })));
  const notice = vi.fn();
  const hook = renderHook(() =>
    useErCanvas({
      doc: () => doc,
      run,
      locked: () => state.locked,
      stale: () => false,
      readOnly: false,
      onRenamed: () => {},
      onPick: () => {},
      selection: () => [],
      notice,
      refocus: () => {},
    }),
  );
  return { hook, run, notice, state, api: () => hook.result.current.value };
}

test("the Assistant taking the text mid-edit keeps the field and says why", async () => {
  const s = setup();
  act(() => s.api().addColumn("customers"));
  const draft = s.api().edit!;
  s.state.locked = true;
  await act(async () => s.api().commit(draft, "email", "enter"));
  expect(s.api().edit).toMatchObject({ kind: "draft", error: ER_MESSAGES.locked });
  expect(s.run).not.toHaveBeenCalled();
});

test("a write the text refuses keeps the field open with the reason", async () => {
  const s = setup({ run: async () => null });
  act(() => s.api().addColumn("customers"));
  const draft = s.api().edit!;
  await act(async () => s.api().commit(draft, "email", "enter"));
  expect(s.api().edit).toMatchObject({ kind: "draft", name: "email", error: ER_MESSAGES.changed });
});

test("a table whose name the column lines cannot write takes no column edits, and says why", () => {
  const s = setup();
  expect(s.api().blocked("sales.orders")).toBe(ER_MESSAGES.notWritable);
  expect(s.api().blocked("customers")).toBeNull();
  act(() => s.api().addColumn("sales.orders"));
  expect(s.api().edit).toBeNull();
});

test("a table or column gone from the text meanwhile keeps the field open and says so (fix round 2)", async () => {
  const s = setup();
  act(() => s.api().editColumn("customers", 0, "name"));
  const col = s.api().edit!;
  doc = parseFlow('diagram er "x"\ncustomers\n').doc!;
  await act(async () => s.api().commit(col, "key", "enter"));
  expect(s.api().edit).toMatchObject({ kind: "col", error: ER_MESSAGES.columnGone("customers") });
  doc = parseFlow('diagram er "x"\nclients\n').doc!;
  await act(async () => s.api().commit(s.api().edit!, "key", "blur"));
  expect(s.api().edit).toMatchObject({ kind: "col", error: ER_MESSAGES.tableGone("customers") });
  expect(s.run).not.toHaveBeenCalled();
  doc = DOC;
});
