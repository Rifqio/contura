import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ToastProvider } from "../components/Toast";
import { callsTo, routeInvoke } from "../test/invoke";
import { type DiagramFileActions, useDiagramFileActions } from "./diagramFileActions";
import { registerFlow } from "./flowRegistry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

type Opts = Parameters<typeof useDiagramFileActions>[0];

function setup(open: string[] = [], over: Partial<Opts> = {}) {
  const opts = {
    tabOf: vi.fn((n: string) => open.find((t) => t.toLowerCase() === n.toLowerCase()) ?? null),
    confirmClose: vi.fn(async () => true),
    dropTab: vi.fn(),
    openTab: vi.fn(),
    renameTab: vi.fn(),
    onChanged: vi.fn(),
    ...over,
  };
  const got: { actions: DiagramFileActions | null } = { actions: null };
  function Harness() {
    const a = useDiagramFileActions(opts);
    got.actions = a;
    return <>{a.dialog}</>;
  }
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
  return { opts, actions: () => got.actions! };
}

test("delete_asks_then_moves_the_diagram_to_the_recycle_bin", async () => {
  routeInvoke({ delete_diagram: () => undefined });
  const flush = vi.fn(async () => true);
  const discard = vi.fn();
  const release = Object.assign(vi.fn(), { settled: Promise.resolve() });
  const hold = vi.fn(() => release);
  const remove = registerFlow("checkout", { save: "waiting", line: null, col: null, errors: 0, flush, discard, hold });
  const { opts, actions } = setup(["checkout"]);
  act(() => actions().remove("checkout"));
  const dialog = await screen.findByRole("dialog", { name: "Move checkout to the Recycle Bin?" });
  expect(callsTo("delete_diagram")).toEqual([]);
  await userEvent.click(within(dialog).getByRole("button", { name: "Move to Recycle Bin" }));
  await waitFor(() => expect(callsTo("delete_diagram")).toEqual([{ name: "checkout" }]));
  // Writes are held while the delete runs; once it worked, what was still to be saved is dropped.
  expect(hold).toHaveBeenCalledTimes(1);
  expect(discard).toHaveBeenCalledTimes(1);
  expect(flush).not.toHaveBeenCalled();
  expect(opts.dropTab).toHaveBeenCalledWith("checkout");
  expect(opts.onChanged).toHaveBeenCalled();
  expect(await screen.findByText("Moved checkout to the Recycle Bin.")).toBeTruthy();
  remove();
});

test("cancel_on_delete_keeps_the_diagram", async () => {
  routeInvoke({ delete_diagram: () => undefined });
  const { opts, actions } = setup();
  act(() => actions().remove("checkout"));
  const dialog = await screen.findByRole("dialog", { name: "Move checkout to the Recycle Bin?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("delete_diagram")).toEqual([]);
  expect(opts.dropTab).not.toHaveBeenCalled();
});

test("save_a_copy_as_writes_both_files_through_save_diagram_copy", async () => {
  const plugin = await import("@tauri-apps/plugin-dialog");
  vi.mocked(plugin.save).mockResolvedValue("D:\\backup\\checkout.flow");
  routeInvoke({
    read_diagram: () => ({ text: 'diagram dfd "checkout"\n', layout: '{"version":1}\n' }),
    save_diagram_copy: () => undefined,
    reveal_in_folder: () => undefined,
  });
  const flush = vi.fn(async () => false);
  const snapshot = vi.fn(() => ({ text: 'diagram dfd "checkout"\n', layout: '{"version":1}\n' }));
  const remove = registerFlow("checkout", { save: "failed", line: null, col: null, errors: 0, flush, snapshot });
  const { actions } = setup(["checkout"]);
  await act(() => actions().saveCopy("checkout"));
  // The open tab's own text is copied, not the file (whose save may have failed).
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(callsTo("read_diagram")).toEqual([]);
  expect(vi.mocked(plugin.save).mock.calls[0][0]).toMatchObject({ defaultPath: "checkout.flow" });
  expect(callsTo("save_diagram_copy")).toEqual([{ text: 'diagram dfd "checkout"\n', layout: '{"version":1}\n', path: "D:\\backup\\checkout.flow" }]);
  expect(await screen.findByText("Saved a copy as checkout.flow")).toBeTruthy();
  remove();
});

test("save_a_copy_as_cancelled_writes_nothing", async () => {
  const plugin = await import("@tauri-apps/plugin-dialog");
  vi.mocked(plugin.save).mockResolvedValue(null);
  routeInvoke({ read_diagram: () => ({ text: "x", layout: null }), save_diagram_copy: () => undefined });
  const { actions } = setup();
  await act(() => actions().saveCopy("checkout"));
  expect(callsTo("save_diagram_copy")).toEqual([]);
});

test("rename_moves_both_files_and_reopens_the_open_tab_under_the_new_name", async () => {
  routeInvoke({ rename_diagram: () => undefined });
  const { opts, actions } = setup(["checkout"]);
  act(() => actions().rename("checkout"));
  const dialog = await screen.findByRole("dialog", { name: "Rename checkout" });
  const name = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
  expect(name.value).toBe("checkout");
  await userEvent.clear(name);
  await userEvent.type(name, "payments{Enter}");
  await waitFor(() => expect(callsTo("rename_diagram")).toEqual([{ from: "checkout", to: "payments" }]));
  // The guard writes the tab's last save under the old name first; the tab then takes the new name in place.
  expect(opts.confirmClose).toHaveBeenCalledWith("checkout");
  expect(opts.renameTab).toHaveBeenCalledWith("checkout", "payments");
  expect(opts.onChanged).toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("rename_to_a_taken_name_says_so_and_keeps_the_old_tab", async () => {
  routeInvoke({
    rename_diagram: () => {
      throw { kind: "diagramExists", message: { name: "payments" } };
    },
  });
  const { opts, actions } = setup(["checkout"]);
  act(() => actions().rename("checkout"));
  const dialog = await screen.findByRole("dialog", { name: "Rename checkout" });
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "payments{Enter}");
  expect((await within(dialog).findByRole("alert")).textContent).toBe("payments.flow already exists.");
  expect(opts.renameTab).not.toHaveBeenCalled();
  expect(opts.dropTab).not.toHaveBeenCalled();
});

test("rename_kept_when_the_close_guard_says_cancel", async () => {
  routeInvoke({ rename_diagram: () => undefined });
  const { actions } = setup(["checkout"], { confirmClose: vi.fn(async () => false) });
  act(() => actions().rename("checkout"));
  const dialog = await screen.findByRole("dialog", { name: "Rename checkout" });
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "payments{Enter}");
  await new Promise((r) => setTimeout(r, 20));
  expect(callsTo("rename_diagram")).toEqual([]);
});

test("before_replace_discards_and_drops_the_open_tab_whatever_its_case", async () => {
  const discard = vi.fn();
  const remove = registerFlow("Checkout", { save: "waiting", line: null, col: null, errors: 0, flush: async () => true, discard });
  const { opts, actions } = setup(["Checkout"]);
  await act(() => actions().beforeReplace("checkout"));
  expect(discard).toHaveBeenCalledTimes(1);
  expect(opts.dropTab).toHaveBeenCalledWith("Checkout");
  remove();
});
