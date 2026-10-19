import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import type { ItemId } from "../api/types";
import { toggleTick } from "./compareModel";
import { ITEMS, planFor } from "./fixtures";
import SyncList, { ScriptPane } from "./SyncList";

const nameOf = (id: ItemId) => ITEMS.find((i) => i.id === id)?.path.name ?? id;

function Harness() {
  const plan = planFor(null);
  const [ticked, setTicked] = useState(new Set(plan.items.filter((i) => i.ticked).map((i) => i.id)));
  const [selected, setSelected] = useState<ItemId | null>(null);
  return (
    <SyncList
      items={plan.items}
      ticked={ticked}
      nameOf={nameOf}
      selected={selected}
      onSelect={setSelected}
      onToggle={(id, on) => setTicked((t) => toggleTick(plan.items, t, id, on))}
    />
  );
}

const box = (line: string) => screen.getByRole("checkbox", { name: line }) as HTMLInputElement;

test("groups_ticks_and_second_lines", () => {
  render(<Harness />);
  expect(screen.getAllByRole("heading").map((g) => g.textContent)).toEqual(["1. Drop", "2. Change", "3. Create"]);
  expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label")).slice(0, 2)).toEqual([
    "DROP COLUMN invoices.fax",
    "DROP TABLE legacy_invoices",
  ]);
  // Data-loss items start unticked, with the danger second line.
  expect(box("DROP COLUMN invoices.fax").checked).toBe(false);
  expect(screen.getByText("Drops values in 18,402 rows").className).toContain("danger");
  expect(screen.getByText("Drops about 2,310 rows")).toBeTruthy();
  // A need is named on the second line.
  expect(screen.getByText("Needs ADD COLUMN invoices.due_on")).toBeTruthy();
  // Items Contura cannot script are disabled, with their reason.
  expect(box("Remove plan_kind value 'trial'").disabled).toBe(true);
  expect(screen.getByText("PostgreSQL cannot remove a value from an enum. Remove trial by hand.")).toBeTruthy();
  expect(screen.getByText("Unticking a change also unticks what needs it. Data-loss items start unticked.")).toBeTruthy();
  // The mark has its word.
  expect(within(box("DROP COLUMN invoices.fax").closest("label")!).getByRole("img", { name: "removed" })).toBeTruthy();
});

test("unticking_closes_over_what_needs_it", async () => {
  render(<Harness />);
  await userEvent.click(box("ADD COLUMN invoices.due_on"));
  expect(box("CREATE INDEX invoices_due_on_idx").checked).toBe(false);
  await userEvent.click(box("CREATE INDEX invoices_due_on_idx"));
  expect(box("ADD COLUMN invoices.due_on").checked).toBe(true);
});

test("space_ticks_the_selected_change", () => {
  render(<Harness />);
  const list = screen.getByRole("group", { name: "Changes" });
  fireEvent.keyDown(list, { key: "ArrowDown" });
  fireEvent.keyDown(list, { key: " " });
  expect(box("DROP COLUMN invoices.fax").checked).toBe(true);
  fireEvent.keyDown(list, { key: " " });
  expect(box("DROP COLUMN invoices.fax").checked).toBe(false);
});

test("script_pane_headings_notes_line_and_actions", async () => {
  const plan = planFor(ITEMS.filter((i) => !i.notScriptable).map((i) => i.id));
  const onCopy = vi.fn();
  const onSave = vi.fn();
  const onOpen = vi.fn();
  const { container } = render(
    <ScriptPane plan={plan} dialect="postgres" target="freight-prod" production onCopy={onCopy} onSave={onSave} onOpenInEditor={onOpen} />,
  );
  expect(screen.getByText("Sync Script, 8 statements, PostgreSQL")).toBeTruthy();
  const text = [...container.querySelectorAll(".script-line-ct")].map((c) => c.textContent);
  expect(text.filter((t) => t?.startsWith("-- "))).toEqual(["-- 1. Drop", "-- 2. Change", "-- 3. Create"]);
  // Production: each writing line has the band, each data-loss statement its note.
  expect(container.querySelectorAll(".script-line-w").length).toBe(text.filter((t) => t && !t.startsWith("-- ")).length);
  expect([...container.querySelectorAll(".script-note")].map((n) => n.textContent)).toEqual([
    "Drops data in billing.invoices.fax on freight-prod (Production)",
    "Drops data in billing.legacy_invoices on freight-prod (Production)",
  ]);
  expect(screen.getByText("Apply runs exactly this, in one transaction.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /^Copy/ }));
  await userEvent.click(screen.getByRole("button", { name: "Save as..." }));
  await userEvent.click(screen.getByRole("button", { name: "Open in editor" }));
  expect([onCopy.mock.calls.length, onSave.mock.calls.length, onOpen.mock.calls.length]).toEqual([1, 1, 1]);
  fireEvent.keyDown(screen.getByLabelText("Sync Script, read-only"), { key: "c", ctrlKey: true });
  expect(onCopy).toHaveBeenCalledTimes(2);
});

test("the_mysql_line_shows_as_the_core_words_it", () => {
  const line = "MySQL runs these 9 statements one by one. If one fails, the ones before it stay applied.";
  render(
    <ScriptPane
      plan={planFor(null, { mode: { kind: "sequential" }, line })}
      dialect="mysql"
      target="kestrel-pos"
      production={false}
      onCopy={() => {}}
      onSave={() => {}}
      onOpenInEditor={() => {}}
    />,
  );
  expect(screen.getByText(line)).toBeTruthy();
  expect(document.querySelectorAll(".script-line-w")).toHaveLength(0);
});

test("a_long_list_draws_only_the_rows_on_screen", () => {
  const base = planFor(null).items[0];
  const items = Array.from({ length: 900 }, (_, i) => ({ ...base, id: `column:billing.t${i}.c:added`, kind: "added" as const, group: "create" as const, line: `ADD COLUMN t${i}.c`, losesData: false, dataLoss: null, needs: [] }));
  render(<SyncList items={items} ticked={new Set()} nameOf={(id) => id} selected={null} onSelect={() => {}} onToggle={() => {}} />);
  expect(screen.getAllByRole("checkbox").length).toBeLessThanOrEqual(60);
  const list = screen.getByRole("group", { name: "Changes" });
  const spacers = list.querySelectorAll<HTMLElement>(':scope > [role="presentation"]');
  // The spacer below holds the place of every change not drawn.
  expect(parseFloat(spacers[1].style.height)).toBeGreaterThan(30 * 800);
});
