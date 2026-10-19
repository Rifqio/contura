// Real diagram tabs with the file actions and the New diagram sheet: what reaches the disk when a diagram that is
// open is replaced, copied, deleted or renamed (ruling P19).
import { EditorView } from "@codemirror/view";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { usePendingEditsGuard } from "../app/usePendingEditsGuard";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { holdTimers } from "../test/timers";
import { type DiagramFileActions, useDiagramFileActions } from "./diagramFileActions";
import { flowEntry, unsavedFlows } from "./flowRegistry";
import FlowTab from "./FlowTab";
import NewDiagramSheet from "./NewDiagramSheet";
import { SAVE_DELAY_MS } from "./useFlowDoc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
// A busy machine stretches the tabs' work; waits still end as soon as their condition holds.
patientFile();

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});

const DFD = ['diagram dfd "Checkout"', "", "Customer [entity]", "Checkout [process, id: 1.0]", "", "Customer > Checkout: order details", ""].join("\n");
const REFUNDS = ['diagram flow "Refunds"', "", "Start [start]", ""].join("\n");

type Files = { text: string; layout: string | null };

/** Contura's diagrams folder, kept in memory; names are not case-sensitive. */
function folder(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  const disk = new Map<string, Files>([
    ["checkout", { text: DFD, layout: null }],
    ["refunds", { text: REFUNDS, layout: null }],
  ]);
  const key = (n: unknown) => String(n).toLowerCase();
  routeInvoke({
    list_diagrams: () => [],
    read_diagram: ({ name }) => {
      const f = disk.get(key(name));
      if (!f) throw { kind: "notFound", message: `${name}.flow` };
      return f;
    },
    write_diagram: ({ name, text, layout, overwrite }) => {
      if (!overwrite && disk.has(key(name))) throw { kind: "diagramExists", message: { name } };
      disk.set(key(name), { text: text as string, layout: layout as string });
      return null;
    },
    write_diagram_layout: ({ name, layout }) => {
      // As the Core: only the layout file, and never for a .flow that is gone.
      const f = disk.get(key(name));
      if (!f) throw { kind: "notFound", message: `${name}.flow` };
      disk.set(key(name), { text: f.text, layout: layout as string });
      return null;
    },
    rename_diagram: ({ from, to }) => {
      const f = disk.get(key(from))!;
      disk.delete(key(from));
      disk.set(key(to), f);
      return null;
    },
    delete_diagram: ({ name }) => {
      disk.delete(key(name));
      return null;
    },
    save_diagram_copy: () => null,
    reveal_in_folder: () => null,
    ...over,
  });
  return disk;
}

/** Every Core call in order, as [command, args]. */
const calls = () => vi.mocked(invoke).mock.calls.map(([c, a]) => [c, (a ?? {}) as Record<string, unknown>] as const);

const ws = vi.hoisted(() => ({ files: null as DiagramFileActions | null, tabs: [] as string[], close: (_t: string) => {} }));

function Workspace({ client, initial, sheet = false }: { client: LangClient; initial: string[]; sheet?: boolean }) {
  const [tabs, setTabs] = useState(initial);
  const [sheetOpen, setSheetOpen] = useState(sheet);
  const g = usePendingEditsGuard({ tabs: [], connections: [], savedQueries: [], activate() {}, onSavedQuerySaved() {}, onError() {} });
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const files = useDiagramFileActions({
    tabOf: (n) => tabs.find((t) => same(t, n)) ?? null,
    confirmClose: (t) => g.confirmCloseFlow(t),
    dropTab: (t) => setTabs((all) => all.filter((x) => x !== t)),
    openTab: (n) => setTabs((all) => (all.some((x) => same(x, n)) ? all : [...all, n])),
    renameTab: (from, to) => setTabs((all) => all.map((x) => (x === from ? to : x))),
    onChanged() {},
  });
  ws.files = files;
  ws.tabs = tabs;
  // The user closes a tab at once (no guard), as the strip does for a saved tab.
  ws.close = (t) => setTabs((all) => all.filter((x) => x !== t));
  return (
    <div style={{ width: 1280, height: 800 }}>
      {tabs.map((t) => (
        <div key={t} data-tab={t}>
          <FlowTab name={t} client={client} />
        </div>
      ))}
      {sheetOpen && (
        <NewDiagramSheet
          onClose={() => setSheetOpen(false)}
          beforeReplace={files.beforeReplace}
          onCreated={(n) => {
            setSheetOpen(false);
            setTabs((all) => (all.some((x) => same(x, n)) ? all : [...all, n]));
          }}
          onMermaid={() => {}}
          onOpenDiagram={() => {}}
        />
      )}
      {files.dialog}
      {g.dialog}
    </div>
  );
}

function setup(initial: string[] = ["checkout"], sheet = false) {
  const utils = render(
    <ToastProvider>
      <Workspace client={new LangClient(() => fakeWorker())} initial={initial} sheet={sheet} />
    </ToastProvider>,
  );
  const editor = (tab: string) => {
    const el = utils.container.querySelector(`[data-tab="${tab}"] .cm-editor`) as HTMLElement | null;
    return el ? EditorView.findFromDOM(el) : null;
  };
  const text = (tab: string) => editor(tab)?.state.doc.toString() ?? null;
  /** Types at the end of the tab's text. */
  const typeIn = (tab: string, insert: string) =>
    act(() => {
      const v = editor(tab)!;
      v.dispatch({ changes: { from: v.state.doc.length, insert } });
    });
  return { ...utils, editor, text, typeIn };
}

const ready = (s: ReturnType<typeof setup>, tab: string) => waitFor(() => expect(s.editor(tab)).not.toBeNull(), { timeout: 4000 });
const later = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

test("replace_over_an_open_tab_drops_its_edits_and_opens_the_new_text", async () => {
  const disk = folder();
  const s = setup(["checkout"], true);
  await ready(s, "checkout");
  const sheet = screen.getByRole("dialog", { name: "New diagram" });
  await userEvent.type(within(sheet).getByRole("textbox", { name: "Name" }), "Checkout{Enter}");
  const replace = await within(sheet).findByRole("button", { name: "Replace" });
  // An edit in the old tab, still waiting to be saved, when the user says Replace.
  s.typeIn("checkout", "Refunds [process]\n");
  await userEvent.click(replace);
  // The tab opens fresh on the new file, under the name typed.
  await waitFor(() => expect(s.text("Checkout")).toBe('diagram dfd "Checkout"\n'), { timeout: 4000 });
  await later(700);
  // The old tab wrote nothing over the new diagram.
  expect(disk.get("checkout")!.text).toBe('diagram dfd "Checkout"\n');
  expect(callsTo("write_diagram").filter((c) => String(c.text).includes("Refunds"))).toEqual([]);
  expect(ws.tabs).toEqual(["Checkout"]);
});

test("save_a_copy_of_an_open_tab_copies_what_the_tab_shows_even_when_its_save_failed", async () => {
  const plugin = await import("@tauri-apps/plugin-dialog");
  vi.mocked(plugin.save).mockResolvedValue("D:\\backup\\checkout.flow");
  folder({
    write_diagram: () => {
      throw { kind: "io", message: "The disk is full." };
    },
  });
  const s = setup();
  await ready(s, "checkout");
  s.typeIn("checkout", "Refunds [process]\n");
  await waitFor(() => expect(s.container.querySelector(".flow-save-failed")).not.toBeNull(), { timeout: 4000 });
  // Asked by the disk name in another case (from Recent): still the open tab.
  await act(() => ws.files!.saveCopy("Checkout"));
  const copy = callsTo("save_diagram_copy");
  expect(copy).toHaveLength(1);
  expect(copy[0].text).toBe(`${DFD}Refunds [process]\n`);
  expect(JSON.parse(copy[0].layout as string).version).toBe(1);
  expect(await screen.findByText("Saved a copy as checkout.flow")).toBeTruthy();
});

/**
 * The edit's save stays due until the delete is on its way, then comes due while it runs. Without the hold a
 * busy machine let the 400ms save land before Delete was pressed: a write before the delete, which is fine.
 */
async function saveDueDuringDelete(s: ReturnType<typeof setup>) {
  const save = holdTimers(SAVE_DELAY_MS);
  s.typeIn("checkout", "Refunds [process]\n");
  act(() => ws.files!.remove("checkout"));
  const ask = await screen.findByRole("dialog", { name: "Move checkout.flow to the Recycle Bin?" });
  await userEvent.click(within(ask).getByRole("button", { name: "Move to Recycle Bin" }));
  await waitFor(() => expect(callsTo("delete_diagram")).toHaveLength(1));
  expect(save.count()).toBeGreaterThan(0);
  act(() => save.release());
}

test("delete_that_fails_keeps_the_tab_its_edits_and_the_file", async () => {
  const del = gate();
  const disk = folder({ delete_diagram: () => del.done });
  const s = setup();
  await ready(s, "checkout");
  await saveDueDuringDelete(s);
  await later(50);
  // Nothing was written while the delete was on its way.
  expect(callsTo("write_diagram")).toEqual([]);
  await act(async () => del.fail({ kind: "file", message: "The Recycle Bin could not take checkout.flow." }));
  expect(await screen.findByText("The Recycle Bin could not take checkout.flow.")).toBeTruthy();
  expect(ws.tabs).toEqual(["checkout"]);
  expect(s.text("checkout")).toBe(`${DFD}Refunds [process]\n`);
  // Writes go on after it: the edit reaches the file.
  await waitFor(() => expect(disk.get("checkout")!.text).toBe(`${DFD}Refunds [process]\n`), { timeout: 4000 });
});

test("delete_that_works_closes_the_tab_and_writes_nothing_after", async () => {
  const del = gate();
  const disk = folder({
    delete_diagram: async () => {
      await del.done;
      disk.delete("checkout");
      return null;
    },
  });
  const s = setup();
  await ready(s, "checkout");
  await saveDueDuringDelete(s);
  await later(50);
  await act(async () => del.open(null));
  await waitFor(() => expect(ws.tabs).toEqual([]));
  await later(700);
  expect(disk.has("checkout")).toBe(false);
  expect(callsTo("write_diagram")).toEqual([]);
});

test("rename_of_an_open_tab_saves_under_the_old_name_first_and_keeps_its_place", async () => {
  const disk = folder();
  const s = setup(["checkout", "refunds"]);
  await ready(s, "checkout");
  s.typeIn("checkout", "Refunds [process]\n");
  act(() => ws.files!.rename("checkout"));
  const dialog = await screen.findByRole("dialog", { name: "Rename checkout.flow" });
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  // A typed .flow is dropped once.
  await userEvent.type(name, "payments.FLOW{Enter}");
  await waitFor(() => expect(ws.tabs).toEqual(["payments", "refunds"]));
  const order = calls().filter(([c]) => c === "write_diagram" || c === "rename_diagram");
  const at = order.findIndex(([c]) => c === "rename_diagram");
  expect(order[at][1]).toEqual({ from: "checkout", to: "payments" });
  // The waiting save landed under the old name before the rename, and nothing wrote to it after.
  expect(order.slice(0, at).some(([, a]) => a.name === "checkout" && String(a.text).includes("Refunds [process]"))).toBe(true);
  await ready(s, "payments");
  await waitFor(() => expect(s.text("payments")).toBe(`${DFD}Refunds [process]\n`));
  await later(700);
  expect(calls().slice(calls().findIndex(([c]) => c === "rename_diagram")).filter(([c, a]) => c === "write_diagram" && a.name === "checkout")).toEqual([]);
  expect(disk.has("checkout")).toBe(false);
});

/** A Core call that waits until the test lets it go. */
function gate<T = null>() {
  let open!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const done = new Promise<T>((res, rej) => {
    open = res;
    fail = rej;
  });
  return { done, open, fail };
}

test("rename_after_discard_that_fails_shows_the_file_from_disk", async () => {
  folder({
    write_diagram: () => {
      throw { kind: "io", message: "The disk is full." };
    },
    rename_diagram: () => {
      throw { kind: "diagramExists", message: { name: "payments" } };
    },
  });
  const s = setup();
  await ready(s, "checkout");
  s.typeIn("checkout", "Refunds [process]\n");
  await waitFor(() => expect(s.container.querySelector(".flow-save-failed")).not.toBeNull(), { timeout: 4000 });
  act(() => ws.files!.rename("checkout"));
  const dialog = await screen.findByRole("dialog", { name: "Rename checkout.flow" });
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "payments{Enter}");
  // The guard cannot save and asks; Discard drops the edits.
  await screen.findByText("Save changes to checkout.flow?");
  await userEvent.click(screen.getByRole("button", { name: /^Discard/ }));
  expect(await screen.findByText("payments.flow already exists.")).toBeTruthy();
  // The tab shows the file as it is on disk, and writes again.
  await waitFor(() => expect(s.text("checkout")).toBe(DFD), { timeout: 4000 });
  expect(s.container.querySelector(".flow-save-failed")).toBeNull();
});

test("a_tab_closed_while_its_delete_runs_still_writes_its_edits_when_the_delete_fails", async () => {
  const del = gate();
  const disk = folder({ delete_diagram: () => del.done });
  const s = setup();
  await ready(s, "checkout");
  await saveDueDuringDelete(s);
  act(() => ws.close("checkout"));
  await later(50);
  expect(callsTo("write_diagram")).toEqual([]);
  await act(async () => del.fail({ kind: "file", message: "The Recycle Bin could not take checkout.flow." }));
  await waitFor(() => expect(disk.get("checkout")!.text).toBe(`${DFD}Refunds [process]\n`), { timeout: 4000 });
});

test("delete_waits_for_a_write_already_on_its_way", async () => {
  const write = gate();
  const order: string[] = [];
  const disk = folder({
    write_diagram: async ({ text }) => {
      order.push("write starts");
      await write.done;
      order.push("write lands");
      disk.set("checkout", { text: text as string, layout: null });
      return null;
    },
    delete_diagram: () => {
      order.push("delete");
      disk.delete("checkout");
      return null;
    },
  });
  const s = setup();
  await ready(s, "checkout");
  s.typeIn("checkout", "Refunds [process]\n");
  await waitFor(() => expect(order).toEqual(["write starts"]), { timeout: 4000 });
  act(() => ws.files!.remove("checkout"));
  const ask = await screen.findByRole("dialog", { name: "Move checkout.flow to the Recycle Bin?" });
  await userEvent.click(within(ask).getByRole("button", { name: "Move to Recycle Bin" }));
  await later(50);
  expect(order).toEqual(["write starts"]);
  await act(async () => write.open(null));
  await waitFor(() => expect(order).toEqual(["write starts", "write lands", "delete"]));
  expect(disk.has("checkout")).toBe(false);
});

test("the_text_is_read_only_while_a_rename_runs", async () => {
  const ren = gate();
  folder({ rename_diagram: () => ren.done });
  const s = setup();
  await ready(s, "checkout");
  act(() => ws.files!.rename("checkout"));
  const dialog = await screen.findByRole("dialog", { name: "Rename checkout.flow" });
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "payments{Enter}");
  await waitFor(() => expect(callsTo("rename_diagram")).toHaveLength(1));
  expect(s.editor("checkout")!.state.readOnly).toBe(true);
  await act(async () => ren.fail({ kind: "diagramExists", message: { name: "payments" } }));
  await screen.findByText("payments.flow already exists.");
  // A failed rename gives the text back.
  expect(s.editor("checkout")!.state.readOnly).toBe(false);
});

// ---- Fix wave (ruling P24)

test("replace_waits_for_a_write_already_on_its_way", async () => {
  const write = gate();
  const order: string[] = [];
  const disk = folder({
    write_diagram: async ({ name, text, layout, overwrite }) => {
      if (!overwrite) throw { kind: "diagramExists", message: { name } };
      if (String(text).includes("Refunds")) {
        order.push("edit write starts");
        await write.done;
        order.push("edit write lands");
      } else order.push("replace");
      disk.set(String(name).toLowerCase(), { text: text as string, layout: layout as string });
      return null;
    },
  });
  const s = setup(["checkout"], true);
  await ready(s, "checkout");
  const sheet = screen.getByRole("dialog", { name: "New diagram" });
  await userEvent.type(within(sheet).getByRole("textbox", { name: "Name" }), "checkout{Enter}");
  const replace = await within(sheet).findByRole("button", { name: "Replace" });
  s.typeIn("checkout", "Refunds [process]\n");
  await waitFor(() => expect(order).toEqual(["edit write starts"]), { timeout: 4000 });
  await userEvent.click(replace);
  await later(50);
  // The new diagram is not written while the old tab's save is still on its way.
  expect(order).toEqual(["edit write starts"]);
  await act(async () => write.open(null));
  await waitFor(() => expect(order).toEqual(["edit write starts", "edit write lands", "replace"]));
  expect(disk.get("checkout")!.text).toBe('diagram dfd "checkout"\n');
});

test("rename_waits_for_a_write_already_on_its_way", async () => {
  const write = gate();
  const order: string[] = [];
  let first = true;
  const disk = folder({
    write_diagram: async ({ text }) => {
      order.push("write starts");
      if (first) {
        first = false;
        await write.done;
      }
      order.push("write lands");
      disk.set("checkout", { text: text as string, layout: null });
      return null;
    },
    rename_diagram: ({ from, to }) => {
      order.push("rename");
      const f = disk.get(String(from).toLowerCase())!;
      disk.delete(String(from).toLowerCase());
      disk.set(String(to).toLowerCase(), f);
      return null;
    },
  });
  const s = setup();
  await ready(s, "checkout");
  s.typeIn("checkout", "Refunds [process]\n");
  await waitFor(() => expect(order).toEqual(["write starts"]), { timeout: 4000 });
  act(() => ws.files!.rename("checkout"));
  const dialog = await screen.findByRole("dialog", { name: "Rename checkout.flow" });
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "payments{Enter}");
  await later(50);
  expect(order).not.toContain("rename");
  await act(async () => write.open(null));
  await waitFor(() => expect(order[order.length - 1]).toBe("rename"));
  expect(order.indexOf("rename")).toBeGreaterThan(order.indexOf("write lands"));
  expect(disk.get("payments")!.text).toBe(`${DFD}Refunds [process]\n`);
});

test("a_failed_write_after_a_held_delete_marks_the_diagram_unsaved", async () => {
  const del = gate();
  let failWrites = false;
  const disk = folder({
    delete_diagram: () => del.done,
    write_diagram: ({ text, layout }) => {
      if (failWrites) throw { kind: "io", message: "The disk is full." };
      disk.set("checkout", { text: text as string, layout: layout as string });
      return null;
    },
  });
  const s = setup();
  await ready(s, "checkout");
  await saveDueDuringDelete(s);
  act(() => ws.close("checkout"));
  await later(50);
  failWrites = true;
  await act(async () => del.fail({ kind: "file", message: "The Recycle Bin could not take checkout.flow." }));
  // No tab is left, but the edits are not lost without a word: the diagram counts as a failed save.
  await waitFor(() => expect(flowEntry("checkout")?.save).toBe("failed"), { timeout: 4000 });
  expect(flowEntry("checkout")?.message).toContain("The disk is full.");
  expect(unsavedFlows()).toContain("checkout");
  // The close guard's retry writes it once the disk takes it, and the mark goes.
  failWrites = false;
  expect(await flowEntry("checkout")!.flush()).toBe(true);
  expect(disk.get("checkout")!.text).toBe(`${DFD}Refunds [process]\n`);
  expect(flowEntry("checkout")).toBeUndefined();
});
