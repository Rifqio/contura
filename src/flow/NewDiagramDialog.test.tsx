// Task 12 (decision 18): the New diagram dialog hosts the Shelf with host="new". A pick writes a new file and opens its
// tab; a kind as "Untitled diagram" made free, a template under its own name made free. One frame saves in the old
// single-diagram format (a v1 layout of its kind), so B1's bytes stay stable.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import { ToastProvider } from "../components/Toast";
import NewDiagramDialog, { firstKind } from "./NewDiagramDialog";
import { BOARD_TEMPLATES, SINGLE_TEMPLATES } from "./board/catalog/templates";
import { blankText, CARDS } from "./diagramKinds";
import { parseFlowLayout, serializeFlowLayout } from "./layout";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const layoutOf = (kind: Parameters<typeof parseFlowLayout>[1]) => serializeFlowLayout(parseFlowLayout(null, kind));

function setup(over: Record<string, (a: Record<string, unknown>) => unknown> = {}, props: Partial<Parameters<typeof NewDiagramDialog>[0]> = {}) {
  routeInvoke({ list_diagrams: () => [], write_diagram: () => undefined, icon_index: () => [], ...over });
  const calls = { close: vi.fn(), created: vi.fn(), mermaid: vi.fn(), database: vi.fn() };
  render(
    <ToastProvider>
      <NewDiagramDialog initialQuery="" onClose={calls.close} onCreated={calls.created} onMermaid={calls.mermaid} onDatabase={calls.database} {...props} />
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "New diagram" });
  return { dialog, calls };
}

test("the_dialog_hosts_the_catalog", () => {
  const { dialog } = setup();
  expect(within(dialog).getByText("Pick a kind or start from a template. Rename it any time from the File menu.")).toBeTruthy();
  expect(within(dialog).getByRole("listbox", { name: "Diagrams" })).toBeTruthy();
  expect(within(dialog).getByRole("listbox", { name: "Templates" })).toBeTruthy();
  expect(within(dialog).queryByRole("tablist")).toBeNull();
  expect(within(dialog).queryByRole("textbox", { name: "Name" })).toBeNull();
});

test("a_kind_creates_untitled_diagram_and_opens_it", async () => {
  const { dialog, calls } = setup();
  await userEvent.click(within(dialog).getByRole("option", { name: "Flowchart" }));
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith("Untitled diagram"));
  expect(callsTo("write_diagram")).toEqual([
    { name: "Untitled diagram", text: 'diagram flow "Untitled diagram"\n', layout: layoutOf("flow"), overwrite: false },
  ]);
  expect(JSON.parse(layoutOf("flow")).version).toBe(1);
});

test("a_taken_name_moves_to_the_next_free_one", async () => {
  const { dialog, calls } = setup({ list_diagrams: () => [{ name: "untitled diagram", kind: "flow", title: "x", modifiedMs: 0 }] });
  await userEvent.click(within(dialog).getByRole("option", { name: "Sequence" }));
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith("Untitled diagram 2"));
  expect(callsTo("write_diagram")[0]).toMatchObject({ name: "Untitled diagram 2", text: blankText("sequence", "Untitled diagram 2") });
});

test("a_name_taken_in_between_retries_once_with_the_next_and_then_says_so", async () => {
  let n = 0;
  const { dialog, calls } = setup({
    write_diagram: () => {
      n++;
      if (n <= 1) throw { kind: "diagramExists", message: { name: "Untitled diagram" } };
    },
  });
  await userEvent.click(within(dialog).getByRole("option", { name: "State" }));
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith("Untitled diagram 2"));
  expect(callsTo("write_diagram").map((c) => c.name)).toEqual(["Untitled diagram", "Untitled diagram 2"]);
});

test("a_second_clash_shows_the_message_in_the_dialog", async () => {
  const { dialog, calls } = setup({
    write_diagram: (a) => {
      throw { kind: "diagramExists", message: { name: a.name } };
    },
  });
  await userEvent.click(within(dialog).getByRole("option", { name: "State" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("already exists");
  expect(callsTo("write_diagram")).toHaveLength(2);
  expect(calls.created).not.toHaveBeenCalled();
  expect(calls.close).not.toHaveBeenCalled();
});

test("a_single_template_is_written_under_its_own_name_with_its_kind_layout", async () => {
  const t = SINGLE_TEMPLATES[0];
  const { dialog, calls } = setup({ list_diagrams: () => [{ name: t.name, kind: t.kind, title: t.name, modifiedMs: 0 }] });
  await userEvent.click(within(dialog).getByRole("option", { name: t.name }));
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith(`${t.name} 2`));
  expect(callsTo("write_diagram")[0]).toMatchObject({ name: `${t.name} 2`, text: t.text, layout: layoutOf(t.kind), overwrite: false });
});

test("a_board_template_creates_one_file_with_three_frames", async () => {
  const b = BOARD_TEMPLATES[0];
  const { dialog, calls } = setup();
  await userEvent.click(within(dialog).getByRole("option", { name: b.name }));
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith(b.name));
  const writes = callsTo("write_diagram");
  expect(writes).toHaveLength(1);
  expect(b.frames).toHaveLength(3);
  expect(writes[0].text).toBe(b.frames.join("\n"));
  expect(String(writes[0].text).match(/^diagram /gm)).toHaveLength(3);
  expect(writes[0].layout).toBe(layoutOf("er"));
});

test("from_my_database_and_from_mermaid_hand_over_the_search", async () => {
  const { dialog, calls } = setup({}, { initialQuery: "shop" });
  const search = within(dialog).getByRole("combobox") as HTMLInputElement;
  expect(search.value).toBe("shop");
  fireEvent.change(search, { target: { value: "orders" } });
  await userEvent.click(within(dialog).getByRole("option", { name: "From Mermaid" }));
  expect(calls.mermaid).toHaveBeenCalledWith("orders");
  await userEvent.click(within(dialog).getByRole("option", { name: "From my database" }));
  expect(calls.database).toHaveBeenCalledWith("orders");
  expect(callsTo("write_diagram")).toEqual([]);
});

test("esc_closes_the_dialog_and_nothing_behind_it", async () => {
  routeInvoke({ list_diagrams: () => [], icon_index: () => [] });
  const onClose = vi.fn();
  const { unmount } = render(<NewDiagramDialog initialQuery="" onClose={onClose} onCreated={() => {}} onMermaid={() => {}} onDatabase={() => {}} />);
  // Registered after the dialog, on the document and on an ancestor of it: what the app's board and Home would see.
  const seen: boolean[] = [];
  const root: boolean[] = [];
  const spy = (e: KeyboardEvent) => e.key === "Escape" && seen.push(e.defaultPrevented);
  const rootSpy = (e: KeyboardEvent) => e.key === "Escape" && root.push(e.defaultPrevented);
  document.addEventListener("keydown", spy);
  document.documentElement.addEventListener("keydown", rootSpy);
  const search = screen.getByRole("combobox") as HTMLInputElement;
  fireEvent.change(search, { target: { value: "flow" } });
  await userEvent.keyboard("{Escape}");
  // The first Esc only clears the search; the Shelf keeps it from everything above.
  expect(search.value).toBe("");
  expect(onClose).not.toHaveBeenCalled();
  expect(seen).toEqual([]);
  expect(root).toEqual([]);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  // The second is the Dialog's: anything behind sees it already handled (prevented), so it acts on nothing.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((p) => p)).toBe(true);
  document.removeEventListener("keydown", spy);
  document.documentElement.removeEventListener("keydown", rootSpy);
  unmount();
});

test("the_dialog_says_its_keys", () => {
  const { dialog } = setup();
  const hint = dialog.querySelector(".new-diagram-keys")!;
  expect(hint.textContent).toContain("Esc closes");
  expect(hint.textContent).toContain("Ctrl+PageUp");
  expect(hint.textContent).toContain("Ctrl+PageDown");
});

test("a_template_header_with_no_kind_fails_loudly", () => {
  expect(firstKind('diagram er "Orders"\ncustomers {\n}\n')).toBe("er");
  expect(() => firstKind('diagram nonsense "Orders"\n')).toThrow(/no diagram kind/);
  expect(() => firstKind("customers {\n}\n")).toThrow(/no diagram kind/);
});

test("nothing_drags_in_the_new_diagram_catalog", () => {
  const { dialog } = setup();
  const options = within(dialog).getAllByRole("option");
  expect(options.length).toBe(9 + BOARD_TEMPLATES.length + SINGLE_TEMPLATES.length + 2);
  for (const o of options) expect(o.getAttribute("draggable")).toBe("false");
  const data: Record<string, string> = {};
  const e = new Event("dragstart", { bubbles: true, cancelable: true }) as unknown as DragEvent;
  Object.assign(e, { dataTransfer: { setData: (k: string, v: string) => (data[k] = v), effectAllowed: "" } });
  options[0].dispatchEvent(e);
  expect(data).toEqual({});
});

/** Every source file that is not a test, as text. */
const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });

test("one_kind_list_remains", () => {
  expect(Object.keys(sources).length).toBeGreaterThan(100);
  for (const [file, text] of Object.entries(sources)) {
    expect(text, file).not.toMatch(/\bfindKinds\b|\bKindGroup\b|\bKINDS\b[^=\n]*=\s*DIAGRAM_KINDS|export const KINDS: \{ kind|NewDiagramSheet/);
  }
  expect("group" in CARDS.flow).toBe(false);
  expect(Object.keys(CARDS.flow).sort()).toEqual(["text", "title"]);
});
