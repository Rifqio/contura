// The ER table card on its own: what it draws from the text, and that it edits nothing while the assistant
// holds the diagram (read-only) or in a preview with no editing context.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { type ErCanvasApi, ErCanvasContext } from "./erCanvas";
import { KindNode, type KindNodeData } from "./kindNodes";

afterEach(cleanup);

const DATA: KindNodeData = {
  name: "customers",
  kind: "erTable",
  look: "modern",
  rows: ["id int", "email text", "note"],
  rowFlags: [["pk"], ["not null", "unique"], []],
};

function api(readOnly: boolean): ErCanvasApi {
  return {
    edit: null,
    selected: null,
    readOnly,
    editTable: vi.fn(),
    editColumn: vi.fn(),
    addColumn: vi.fn(),
    firstColumn: vi.fn(),
    selectColumn: vi.fn(),
    pickTable: vi.fn(),
    blocked: vi.fn((t: string) => (t.includes(".") ? "Edit this table's columns in the text: its name has a dot or needs quotes." : null)),
    pointColumn: vi.fn(),
    toggleFlag: vi.fn(),
    duplicateColumn: vi.fn(),
    deleteColumn: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  };
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".fkind-er-row")];

test("the card draws each column's key, name, type and not-null mark from the text", () => {
  render(
    <ErCanvasContext.Provider value={api(false)}>
      <KindNode d={DATA} selected={false} />
    </ErCanvasContext.Provider>,
  );
  expect(rows().map((r) => [r.querySelector(".fkind-col")!.textContent, r.querySelector(".fkind-type")!.textContent])).toEqual([
    ["id", "int"],
    ["email", "text"],
    ["note", ""],
  ]);
  expect(rows().map((r) => !!r.querySelector(".fkind-key"))).toEqual([true, false, false]);
  expect(rows().map((r) => r.querySelector<HTMLElement>(".fkind-nn")!.title)).toEqual(["Not null", "Not null", "Nullable"]);
  expect(rows()[1].title).toBe("email text (unique, not null)");
});

test("read-only while the assistant works: double-clicks, the gutter and + column do nothing", () => {
  const er = api(true);
  render(
    <ErCanvasContext.Provider value={er}>
      <KindNode d={DATA} selected />
    </ErCanvasContext.Provider>,
  );
  fireEvent.doubleClick(document.querySelector(".fkind-head")!);
  fireEvent.doubleClick(rows()[1].querySelector(".fkind-col")!);
  fireEvent.doubleClick(rows()[1].querySelector(".fkind-type")!);
  fireEvent.doubleClick(document.querySelector(".fkind-er-body")!);
  const gut = within(rows()[2]).getByRole("button", { name: "Primary key" }) as HTMLButtonElement;
  expect(gut.disabled).toBe(true);
  fireEvent.click(gut);
  expect(screen.queryByRole("button", { name: "Add column" })).toBeNull();
  for (const f of [er.editTable, er.editColumn, er.addColumn, er.toggleFlag]) expect(f).not.toHaveBeenCalled();
});

test("with no editing context (a preview) the card only draws", () => {
  render(<KindNode d={DATA} selected={false} />);
  expect(rows()).toHaveLength(3);
  expect(screen.queryByRole("button", { name: "Add column" })).toBeNull();
  fireEvent.doubleClick(document.querySelector(".fkind-head")!);
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("a table the card cannot write columns for offers no column edits and says why (I6)", () => {
  const er = api(false);
  render(
    <ErCanvasContext.Provider value={er}>
      <KindNode d={{ ...DATA, name: "sales.orders" }} selected />
    </ErCanvasContext.Provider>,
  );
  expect(screen.queryByRole("button", { name: "Add column" })).toBeNull();
  const gut = within(rows()[0]).getByRole("button", { name: "Primary key" }) as HTMLButtonElement;
  expect(gut.disabled).toBe(true);
  expect(gut.title).toBe("Edit this table's columns in the text: its name has a dot or needs quotes.");
  fireEvent.doubleClick(document.querySelector(".fkind-er-body")!);
  fireEvent.doubleClick(rows()[1].querySelector(".fkind-col")!);
  expect(er.addColumn).not.toHaveBeenCalled();
  expect(er.editColumn).not.toHaveBeenCalled();
  // Its name can still be edited in place.
  fireEvent.doubleClick(document.querySelector(".fkind-head")!);
  expect(er.editTable).toHaveBeenCalledWith("sales.orders");
});
