import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import CellEditor from "./CellEditor";
import { type CellPicker, pickerFor } from "./cellPickers/picker";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 29, 12, 0, 0));
});
afterEach(() => vi.useRealTimers());

function setup(initial: string, picker: CellPicker | null, extra: { onSetNull?: () => void } = {}) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const table = document.createElement("table");
  document.body.appendChild(table);
  render(
    <CellEditor
      initial={initial}
      multiline={false}
      onCommit={onCommit}
      onCancel={onCancel}
      picker={picker ?? undefined}
      pickerLabel="created_at"
      onSetNull={extra.onSetNull}
    />,
    { container: table.appendChild(document.createElement("tbody")).appendChild(document.createElement("tr")).appendChild(document.createElement("td")) },
  );
  const box = screen.getByRole("textbox", { name: "Cell value" }) as HTMLTextAreaElement;
  return { box, onCommit, onCancel };
}

const spec = (type: string, dialect: "mysql" | "postgres" | "sqlite" = "mysql") => pickerFor(type, dialect)!;
const dialog = () => screen.queryByRole("dialog");
const day = (name: string) => screen.getByRole("gridcell", { name });

test("a date column opens a calendar under the cell and keeps focus in the text box", () => {
  const { box } = setup("2026-03-05", spec("date"));
  expect(dialog()).not.toBeNull();
  expect(dialog()!.getAttribute("aria-label")).toBe("Pick a date for created_at");
  const grid = screen.getByRole("grid", { name: "March 2026" });
  expect(within(grid).getAllByRole("columnheader")).toHaveLength(7);
  expect(day("Thursday, March 5, 2026").getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(box);
});

test("clicking a day of a date column keeps that date", () => {
  const { onCommit } = setup("2026-03-05", spec("date"));
  fireEvent.mouseDown(day("Tuesday, March 10, 2026"));
  fireEvent.click(day("Tuesday, March 10, 2026"));
  expect(onCommit).toHaveBeenCalledWith("2026-03-10", "none");
});

test("typing a full value commits it unchanged, even one the picker cannot read", () => {
  const { box, onCommit } = setup("2026-03-05 10:00:00.000", spec("datetime(3)"));
  fireEvent.change(box, { target: { value: "2026-03-05 1:2" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onCommit).toHaveBeenLastCalledWith("2026-03-05 1:2", "down");
});

test("the text box drives the calendar: a typed date shows its month", () => {
  const { box } = setup("2026-03-05", spec("date"));
  fireEvent.change(box, { target: { value: "2027-01-20" } });
  expect(screen.getByRole("grid", { name: "January 2027" })).toBeTruthy();
  expect(day("Wednesday, January 20, 2027").getAttribute("aria-selected")).toBe("true");
});

test("an empty value opens on today's month with no day selected", () => {
  setup("", spec("date"));
  expect(screen.getByRole("grid", { name: "October 2026" })).toBeTruthy();
  expect(screen.queryAllByRole("gridcell").filter((c) => c.getAttribute("aria-selected") === "true")).toHaveLength(0);
});

test("calendar keys: Alt+Down enters, arrows move a day or week, PageUp and PageDown a month, Home and End the week", () => {
  const { box, onCommit } = setup("2026-03-05", spec("date"));
  fireEvent.keyDown(box, { key: "ArrowDown", altKey: true });
  expect(document.activeElement).toBe(day("Thursday, March 5, 2026"));
  const press = (key: string, extra: object = {}) => fireEvent.keyDown(document.activeElement!, { key, ...extra });
  press("ArrowRight");
  expect(document.activeElement).toBe(day("Friday, March 6, 2026"));
  press("ArrowDown");
  expect(document.activeElement).toBe(day("Friday, March 13, 2026"));
  press("ArrowLeft");
  press("ArrowUp");
  expect(document.activeElement).toBe(day("Thursday, March 5, 2026"));
  press("Home");
  expect(document.activeElement).toBe(day("Sunday, March 1, 2026"));
  press("End");
  expect(document.activeElement).toBe(day("Saturday, March 7, 2026"));
  press("PageDown");
  expect(document.activeElement).toBe(day("Tuesday, April 7, 2026"));
  press("PageUp");
  press("PageUp");
  expect(document.activeElement).toBe(day("Saturday, February 7, 2026"));
  press("Enter");
  expect(onCommit).toHaveBeenCalledWith("2026-02-07", "down");
});

test("Esc in the picker closes it and goes back to the text box; Alt+Down opens it again; Esc there cancels", () => {
  const { box, onCancel, onCommit } = setup("2026-03-05", spec("date"));
  fireEvent.keyDown(box, { key: "ArrowDown", altKey: true });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(box);
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: "ArrowDown", altKey: true });
  expect(dialog()).not.toBeNull();
  expect(document.activeElement).toBe(box);
  fireEvent.keyDown(box, { key: "Escape" });
  expect(onCancel).toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
});

test("datetime(3): time fields to milliseconds, synced both ways, and a picked day keeps the time", () => {
  const { box, onCommit } = setup("2026-03-05 10:20:30.400", spec("datetime(3)"));
  const hour = screen.getByRole("spinbutton", { name: "Hour" }) as HTMLInputElement;
  expect(hour.value).toBe("10");
  expect((screen.getByRole("spinbutton", { name: "Minute" }) as HTMLInputElement).value).toBe("20");
  expect((screen.getByRole("spinbutton", { name: "Second" }) as HTMLInputElement).value).toBe("30");
  expect((screen.getByRole("spinbutton", { name: "Milliseconds" }) as HTMLInputElement).value).toBe("400");
  act(() => hour.focus());
  fireEvent.change(hour, { target: { value: "7" } });
  expect(box.value).toBe("2026-03-05 07:20:30.400");
  fireEvent.keyDown(hour, { key: "ArrowUp" });
  expect(box.value).toBe("2026-03-05 08:20:30.400");
  fireEvent.mouseDown(day("Friday, March 6, 2026"));
  fireEvent.click(day("Friday, March 6, 2026"));
  // A datetime is not finished by a day alone: the editor stays open.
  expect(onCommit).not.toHaveBeenCalled();
  expect(box.value).toBe("2026-03-06 08:20:30.400");
  fireEvent.change(box, { target: { value: "2026-03-06 23:59:00.000" } });
  expect(hour.value).toBe("23");
  act(() => hour.focus());
  fireEvent.keyDown(hour, { key: "Enter" });
  expect(onCommit).toHaveBeenCalledWith("2026-03-06 23:59:00.000", "down");
});

test("datetime without precision shows seconds and no fraction; time(6) shows microseconds", () => {
  setup("2026-03-05 10:20:30", spec("datetime"));
  expect(screen.getByRole("spinbutton", { name: "Second" })).toBeTruthy();
  expect(screen.queryByRole("spinbutton", { name: "Milliseconds" })).toBeNull();
});

test("time(6) has no calendar, only the fields", () => {
  setup("10:20:30.000001", spec("time(6)"));
  expect(screen.queryByRole("grid")).toBeNull();
  expect(dialog()!.getAttribute("aria-label")).toBe("Pick a time for created_at");
  expect((screen.getByRole("spinbutton", { name: "Microseconds" }) as HTMLInputElement).value).toBe("000001");
});

test("timestamptz keeps its offset text when the picker changes the value", () => {
  const { box } = setup("2026-03-05 10:20:30+05:30", pickerFor("timestamptz", "postgres"));
  fireEvent.mouseDown(day("Monday, March 9, 2026"));
  fireEvent.click(day("Monday, March 9, 2026"));
  expect(box.value).toBe("2026-03-09 10:20:30+05:30");
});

test("Tab inside the picker moves between the calendar and the time fields; in the text box it moves on", () => {
  const { box, onCommit } = setup("2026-03-05 10:20:30", spec("datetime"));
  fireEvent.keyDown(box, { key: "ArrowDown", altKey: true });
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("spinbutton", { name: "Hour" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(day("Thursday, March 5, 2026"));
  expect(onCommit).not.toHaveBeenCalled();
  act(() => box.focus());
  fireEvent.keyDown(box, { key: "Tab" });
  expect(onCommit).toHaveBeenCalledWith("2026-03-05 10:20:30", "right");
});

test("focus moving into the picker keeps the editor open; leaving both keeps the value once", () => {
  const { box, onCommit } = setup("2026-03-05", spec("date"));
  const cell = day("Thursday, March 5, 2026");
  fireEvent.blur(box, { relatedTarget: cell });
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.blur(cell, { relatedTarget: document.body });
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenCalledWith("2026-03-05", "none", true);
});

const sizes = (): CellPicker => ({ kind: "enum", values: ["small", "medium", "large"] });

test("an enum column lists its values with NULL first when the column is nullable", () => {
  const onSetNull = vi.fn();
  const { box } = setup("medium", sizes(), { onSetNull });
  const list = screen.getByRole("listbox", { name: "Values of created_at" });
  const options = within(list).getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual(["NULL", "small", "medium", "large"]);
  expect(options[2].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(box);
  fireEvent.click(options[0]);
  expect(onSetNull).toHaveBeenCalled();
});

test("a column that is not nullable has no NULL row", () => {
  setup("medium", sizes());
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["small", "medium", "large"]);
});

test("enum keys: Alt+Down enters the list, Up/Down/Home/End and type-to-find move, Enter picks", () => {
  const { box, onCommit } = setup("medium", sizes());
  fireEvent.keyDown(box, { key: "ArrowDown", altKey: true });
  const list = screen.getByRole("listbox");
  expect(document.activeElement).toBe(list);
  const active = () => document.getElementById(list.getAttribute("aria-activedescendant")!)?.textContent;
  expect(active()).toBe("medium");
  fireEvent.keyDown(list, { key: "ArrowDown" });
  expect(active()).toBe("large");
  fireEvent.keyDown(list, { key: "Home" });
  expect(active()).toBe("small");
  fireEvent.keyDown(list, { key: "End" });
  expect(active()).toBe("large");
  fireEvent.keyDown(list, { key: "ArrowUp" });
  expect(active()).toBe("medium");
  fireEvent.keyDown(list, { key: "s" });
  expect(active()).toBe("small");
  fireEvent.keyDown(list, { key: "Enter" });
  expect(onCommit).toHaveBeenCalledWith("small", "down");
});

test("clicking a value keeps it", () => {
  const { onCommit } = setup("medium", sizes());
  fireEvent.click(screen.getByRole("option", { name: "large" }));
  expect(onCommit).toHaveBeenCalledWith("large", "none");
});

test("more than eight values get a filter box", () => {
  const values = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"];
  const { box, onCommit } = setup("", { kind: "enum", values });
  fireEvent.keyDown(box, { key: "ArrowDown", altKey: true });
  const filter = screen.getByRole("searchbox", { name: "Filter values" }) as HTMLInputElement;
  expect(document.activeElement).toBe(filter);
  fireEvent.change(filter, { target: { value: "eta" } });
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["beta", "zeta", "eta", "theta"]);
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(onCommit).toHaveBeenCalledWith("zeta", "down");
});

test("a short enum has no filter box", () => {
  setup("medium", sizes());
  expect(screen.queryByRole("searchbox")).toBeNull();
});

test("no picker for plain text, and the larger editor never gets one", () => {
  setup("hello", null);
  expect(dialog()).toBeNull();
});
