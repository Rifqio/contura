import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import { mockReactFlowDom } from "../test/reactFlow";
import { applyEdits, renameColumn, renameTable } from "../lang/dbml/edits";
import { KFC_MODEL, KFC_TEXT } from "../lang/dbml/fixtures";
import { parseDbml } from "../lang/dbml/parse";
import type { Ranges, TextEdit } from "../lang/protocol";
import Canvas, { refFromConnection } from "./Canvas";
import { autoLayout, followRenames, parseLayout, serializeLayout } from "./layout";

beforeAll(mockReactFlowDom);

type Make = (text: string, ranges: Ranges) => TextEdit[];

function renderCanvas(blocked = false) {
  const onEdit = vi.fn<(make: Make) => void>();
  const onLayout = vi.fn();
  const layout = { version: 1 as const, tables: { "public.stores": { x: 0, y: 0 }, "public.orders": { x: 320, y: 0 } } };
  render(
    <div style={{ width: 800, height: 600 }}>
      <Canvas
        model={KFC_MODEL}
        layout={layout}
        blocked={blocked}
        errorAt={blocked ? { line: 7, message: "Expect a closing brace '}'" } : undefined}
        onLayout={onLayout}
        onEdit={onEdit}
        onGoToError={() => {}}
      />
    </div>,
  );
  return { onEdit, onLayout };
}

test("layout_round_trips_and_bad_json_is_empty", () => {
  const l = { version: 1 as const, tables: { "b.t": { x: 1, y: 2 }, "a.t": { x: 3, y: 4 } } };
  const json = serializeLayout(l);
  expect(json.indexOf('"a.t"')).toBeLessThan(json.indexOf('"b.t"'));
  expect(parseLayout(json)).toEqual(l);
  expect(parseLayout("not json")).toEqual({ version: 1, tables: {} });
  expect(parseLayout('{"version":2}')).toEqual({ version: 1, tables: {} });
});

test("a_renamed_table_keeps_its_position", () => {
  const parsed = parseDbml(KFC_TEXT, "postgres");
  const before = parsed.model!;
  const renamed = applyEdits(KFC_TEXT, renameTable(KFC_TEXT, parsed.ranges, "public.stores", "shops"));
  const after = parseDbml(renamed, "postgres").model!;
  const l = { version: 1 as const, tables: { "public.stores": { x: 7, y: 8 }, "public.orders": { x: 320, y: 0 } } };
  expect(followRenames(l, before, after).tables).toEqual({ "public.shops": { x: 7, y: 8 }, "public.orders": { x: 320, y: 0 } });
  // Adding a table is not a rename.
  const added = parseDbml(`${KFC_TEXT}\nTable extra {\n  id integer\n}\n`, "postgres").model!;
  expect(followRenames(l, before, added)).toBe(l);
});

test("auto_layout_places_only_new_tables", async () => {
  const existing = { version: 1 as const, tables: { "public.stores": { x: 500, y: 500 } } };
  const l = await autoLayout(KFC_MODEL, existing);
  expect(l.tables["public.stores"]).toEqual({ x: 500, y: 500 });
  expect(l.tables["public.orders"]).toBeDefined();
});

test("add_table_places_the_new_card_in_view", async () => {
  const { onEdit, onLayout } = renderCanvas();
  await userEvent.click(screen.getByRole("button", { name: "Add table" }));
  expect(onEdit).toHaveBeenCalledTimes(1);
  const l = onLayout.mock.lastCall?.[0];
  expect(l.tables["public.stores"]).toEqual({ x: 0, y: 0 });
  expect(l.tables["public.new_table"]).toEqual({ x: expect.any(Number), y: expect.any(Number) });
});

test("a_card_drags_by_its_name_but_not_by_its_edit_box", async () => {
  renderCanvas();
  const stores = screen.getByRole("group", { name: "Table stores" });
  const name = within(stores).getByRole("button", { name: "Table name stores" });
  expect(name.closest(".nodrag")).toBeNull();
  // fireEvent: a userEvent mousedown has no view in jsdom, which d3-drag reads.
  fireEvent.doubleClick(name);
  expect(within(stores).getByRole("textbox", { name: "Table name stores" }).classList.contains("nodrag")).toBe(true);
});

test("cards_render_columns_and_badges", () => {
  renderCanvas();
  const stores = screen.getByRole("group", { name: "Table stores" });
  expect(within(stores).getByText("varchar(80)")).toBeTruthy();
  expect(within(stores).getAllByText("PK")).toHaveLength(1);
  const orders = screen.getByRole("group", { name: "Table orders" });
  expect(within(orders).getByText("FK")).toBeTruthy();
});

test("renaming_column_on_card_calls_onEdit", async () => {
  const { onEdit } = renderCanvas();
  const stores = screen.getByRole("group", { name: "Table stores" });
  // fireEvent: a userEvent mousedown has no view in jsdom, which d3-drag reads.
  fireEvent.doubleClick(within(stores).getByRole("button", { name: "Column name" }));
  const input = within(stores).getByRole("textbox", { name: "Column name" });
  await userEvent.clear(input);
  await userEvent.type(input, "label{Enter}");
  expect(onEdit).toHaveBeenCalledTimes(1);
  const { ranges } = parseDbml(KFC_TEXT, "postgres");
  const edits = onEdit.mock.calls[0][0](KFC_TEXT, ranges);
  expect(edits).toEqual(renameColumn(KFC_TEXT, ranges, "public.stores", "name", "label"));
  expect(applyEdits(KFC_TEXT, edits)).toContain("  label varchar(80)");
});

test("blocked_canvas_disables_edits_and_shows_banner", async () => {
  const { onEdit } = renderCanvas(true);
  expect(
    screen.getByText("The DBML has an error on line 7: Expect a closing brace '}'. The canvas shows the last valid version."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Go to error" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add table" }) as HTMLButtonElement).disabled).toBe(true);
  const stores = screen.getByRole("group", { name: "Table stores" });
  // fireEvent: a userEvent mousedown has no view in jsdom, which d3-drag reads.
  fireEvent.doubleClick(within(stores).getByRole("button", { name: "Column name" }));
  expect(within(stores).queryByRole("textbox")).toBeNull();
  expect(onEdit).not.toHaveBeenCalled();
});

test("connecting_columns_adds_ref_and_warns_for_plain_target", () => {
  const ok = refFromConnection(KFC_MODEL, {
    source: "public.orders",
    sourceHandle: "line:s",
    target: "public.stores",
    targetHandle: "id:t",
  });
  expect(ok?.from).toEqual({ schema: "public", table: "orders", columns: ["line"] });
  expect(ok?.to).toEqual({ schema: "public", table: "stores", columns: ["id"] });
  expect(ok?.warning).toBeNull();
  const plain = refFromConnection(KFC_MODEL, {
    source: "public.orders",
    sourceHandle: "line:s",
    target: "public.stores",
    targetHandle: "kind:t",
  });
  expect(plain?.warning).toBe("stores.kind is not a key, unique or indexed. The database may refuse this Foreign Key.");
});

test("ask_ai_shows_placeholder", async () => {
  renderCanvas();
  const stores = screen.getByRole("group", { name: "Table stores" });
  await userEvent.click(within(stores).getByRole("button", { name: "Table actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ask AI" }));
  expect(screen.getByText("Connect an AI provider in Settings.")).toBeTruthy();
  const settings = screen.getByRole("button", { name: "Settings" }) as HTMLButtonElement;
  expect(settings.disabled).toBe(true);
  expect(settings.title).toBe("AI providers arrive in a later step");
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });
});
