import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type NodeProps, ReactFlowProvider } from "@xyflow/react";
import { useState } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Group } from "../api/types";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import flowCss from "../styles/flow.css?raw";
import { mockReactFlowDom } from "../test/reactFlow";
import { FLOW_NODE_TYPES } from "./flowNodes";
import flowTabCss from "../styles/flow-tab.css?raw";
import flowFixture from "./fixtures/order-handover.flow?raw";
import mmdFixture from "./fixtures/order-handover.mmd?raw";
import type { MermaidAdd } from "./FlowTab";
import MermaidImportDialog from "./MermaidImportDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => vi.useRealTimers());

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const MMD = lf(mmdFixture);
const FLOW = lf(flowFixture);
const GROUPS: Group[] = [{ id: "g-kes", name: "Kestrel Foods", color: "teal", hasImage: false }];

function setup(beforeReplace?: (name: string) => void, add?: MermaidAdd) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const lang = new LangClient(fakeWorker);
  render(
    <ToastProvider>
      <MermaidImportDialog groups={GROUPS} defaultGroup={null} lang={lang} onClose={onClose} onCreated={onCreated} beforeReplace={beforeReplace} add={add} />
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Diagram from Mermaid" });
  const view = () => EditorView.findFromDOM(dialog.querySelector(".cm-editor") as HTMLElement)!;
  const paste = (text: string) => act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: text } }));
  const create = () => within(dialog).getByRole("button", { name: /Create flow/ }) as HTMLButtonElement;
  const nodes = () => dialog.querySelectorAll(".fnode");
  return { dialog, view, paste, create, nodes, onClose, onCreated };
}

test("pasting_draws_the_nodes_150ms_after_the_last_keystroke", async () => {
  // Only setTimeout is faked, so the clock moves only when the test moves it, even on a busy machine.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { dialog, paste, nodes } = setup();
  paste(MMD);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(nodes()).toHaveLength(0);
  await act(() => vi.advanceTimersByTimeAsync(60));
  vi.useRealTimers();
  await waitFor(() => expect(nodes()).toHaveLength(7));
  expect(within(dialog).getByText("Flowchart: 7 shapes, 7 lines")).toBeTruthy();
});

test("the_flow_text_tab_shows_the_text_create_flow_writes", async () => {
  const { dialog, paste } = setup();
  paste(MMD);
  await waitFor(() => expect(within(dialog).getByText("Flowchart: 7 shapes, 7 lines")).toBeTruthy());
  await userEvent.click(within(dialog).getByRole("radio", { name: ".flow text" }));
  const block = within(dialog).getByRole("group", { name: "The .flow text" });
  // The Name field's default is New diagram's, so the title is Untitled diagram (fix round 1, M8).
  const lines = [...block.querySelectorAll("code")].map((c) => c.textContent);
  expect(lines.join("\n")).toBe(FLOW.replace('"Order handover"', '"Untitled diagram"').trimEnd());
});

test("the_notes_list_names_what_was_not_carried_over", async () => {
  const { dialog, paste } = setup();
  paste(MMD);
  const list = await within(dialog).findByRole("list", { name: "Not carried over" });
  expect(within(dialog).getByText("Not carried over")).toBeTruthy();
  expect(within(dialog).getByText("4", { selector: ".chip" })).toBeTruthy();
  expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "Line 6: the hexagon {{ }} is not a .flow shape. Pack order became a step.",
    "Line 7: the cylinder [( )] became a step with the database icon.",
    "Line 13: style is left out. Colours come from the theme.",
    "Line 14: classDef is left out.",
  ]);
});

test("an_unreadable_line_shows_the_banner_and_disables_create_flow_until_fixed", async () => {
  const { dialog, paste, create } = setup();
  paste(MMD.replace("  D --> B", "  D -> B"));
  const banner = await within(dialog).findByText("Line 5: cannot read the link D -> B. Mermaid links are -->, ---, -.-> or ==>.");
  expect(banner.closest("[role=alert]")).toBeTruthy();
  // Step 10: the line blocks Create until it is fixed or deleted.
  expect(within(dialog).getByText("Fix or delete line 5 to go on.")).toBeTruthy();
  expect(within(dialog).getByText("Flowchart: 7 shapes, 6 lines read")).toBeTruthy();
  expect(create().disabled).toBe(true);
  paste(MMD);
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(within(dialog).queryByRole("alert")).toBeNull();
});

test("ctrl_o_opens_a_mmd_file_into_the_editor_and_names_the_flow", async () => {
  const plugin = await import("@tauri-apps/plugin-dialog");
  vi.mocked(plugin.open).mockResolvedValue("C:\\flows\\order-handover.mmd");
  routeInvoke({ read_text_file: () => MMD });
  const { dialog, view } = setup();
  fireEvent.keyDown(dialog, { key: "o", ctrlKey: true });
  await waitFor(() => expect(view().state.doc.toString()).toBe(MMD));
  expect(plugin.open).toHaveBeenCalledTimes(1);
  expect(callsTo("read_text_file")).toEqual([{ path: "C:\\flows\\order-handover.mmd" }]);
  expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("order-handover");
});

async function readyToCreate(exists: boolean | "refuse", beforeReplace?: (name: string) => void) {
  routeInvoke({
    write_text_file: () => undefined,
    write_diagram: (a) => {
      if (exists === "refuse") throw { kind: "invalidInput", message: RULE };
      if (exists && !a.overwrite) throw { kind: "diagramExists", message: { name: "order-handover" } };
      return undefined;
    },
  });
  const s = setup(beforeReplace);
  const name = within(s.dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "order-handover.flow");
  await userEvent.click(within(s.dialog).getByRole("combobox", { name: "Group" }));
  await userEvent.click(screen.getByRole("option", { name: "Kestrel Foods" }));
  s.paste(MMD);
  await waitFor(() => expect(within(s.dialog).getByText("Flowchart: 7 shapes, 7 lines")).toBeTruthy());
  return s;
}

const RULE = 'Use a name without \\ / : * ? " < > | and under 120 characters.';
const LAYOUT = `${JSON.stringify({ version: 1, direction: "LR", group: "g-kes", nodes: {} }, null, 2)}\n`;

test("create_flow_saves_by_name_in_the_diagrams_folder_and_reports_the_name", async () => {
  const plugin = await import("@tauri-apps/plugin-dialog");
  const { dialog, onCreated } = await readyToCreate(false);
  fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("order-handover"));
  // Q35: no Save dialog; the Core keeps it in the diagrams folder.
  expect(plugin.save).not.toHaveBeenCalled();
  // Both files in one Core call by name, through writeDiagram (step 7 finding I1).
  expect(callsTo("write_text_file")).toEqual([]);
  expect(callsTo("write_diagram")).toEqual([{ name: "order-handover", text: FLOW, layout: LAYOUT, overwrite: false }]);
  expect(screen.getByText("Created order-handover")).toBeTruthy();
});

test("an_existing_name_asks_before_replacing", async () => {
  const { dialog, onCreated } = await readyToCreate(true);
  await userEvent.click(within(dialog).getByRole("button", { name: /^Create flow/ }));
  expect(await within(dialog).findByText("order-handover.flow already exists. Replace it?")).toBeTruthy();
  expect(callsTo("write_diagram").map((c) => c.overwrite)).toEqual([false]);
  // Cancel keeps the dialog and writes nothing.
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(within(dialog).queryByText("order-handover.flow already exists. Replace it?")).toBeNull();
  expect(onCreated).not.toHaveBeenCalled();
  // Asked again, Replace writes it.
  await userEvent.click(within(dialog).getByRole("button", { name: /^Create flow/ }));
  await userEvent.click(await within(dialog).findByRole("button", { name: "Replace" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("order-handover"));
  expect(callsTo("write_diagram").map((c) => c.overwrite)).toEqual([false, false, true]);
  expect(callsTo("write_diagram")[2]).toEqual({ name: "order-handover", text: FLOW, layout: LAYOUT, overwrite: true });
});

test("replace_lets_the_open_tab_go_before_the_write", async () => {
  const order: string[] = [];
  const { dialog, onCreated } = await readyToCreate(true, (n) => order.push(`before ${n}`));
  await userEvent.click(within(dialog).getByRole("button", { name: /^Create flow/ }));
  await userEvent.click(await within(dialog).findByRole("button", { name: "Replace" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("order-handover"));
  expect(order).toEqual(["before order-handover"]);
});

test("a_name_the_rule_refuses_shows_the_rule_verbatim", async () => {
  const { dialog, onCreated } = await readyToCreate("refuse");
  await userEvent.click(within(dialog).getByRole("button", { name: /^Create flow/ }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(RULE);
  expect(onCreated).not.toHaveBeenCalled();
});

test("flow_nodes_draw_with_tokens_only_and_a_handle_at_each_port", () => {
  const kinds = [
    ["flowchart", "step"],
    ["flowchart", "decision"],
    ["flowchart", "start"],
    ["flowchart", "end"],
    ["flowchart", "io"],
    ["flowchart", "subprocess"],
    ["dfd", "process"],
    ["dfd", "store"],
    ["dfd", "external"],
    ["service", "service"],
  ] as const;
  const { container } = render(
    <ReactFlowProvider>
      {kinds.map(([family, kind]) => {
        const Shape = FLOW_NODE_TYPES[family];
        return <Shape key={kind} {...({ id: kind, data: { name: kind, kind, look: "modern" }, selected: false } as unknown as NodeProps)} />;
      })}
      {(() => {
        const G = FLOW_NODE_TYPES.area;
        return <G {...({ id: "g", data: { name: "Kitchen" }, selected: false } as unknown as NodeProps)} />;
      })()}
    </ReactFlowProvider>,
  );
  expect(container.querySelectorAll(".fnode")).toHaveLength(10);
  expect(container.querySelector('.flow-area[aria-label="Group Kitchen"]')).toBeTruthy();
  // Each node has a handle where each of its round ports shows (data-side r, l, t, b).
  const sides = [...container.querySelectorAll(".react-flow__handle.fnode-handle")].map((h) => h.getAttribute("data-side"));
  expect(sides).toHaveLength(40);
  expect(new Set(sides)).toEqual(new Set(["r", "l", "t", "b"]));
  // The node types are memo wrappers, so a canvas re-render does not redraw every node.
  for (const t of Object.values(FLOW_NODE_TYPES)) expect((t as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  expect(container.innerHTML.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![\w-])/gi) ?? []).toEqual([]);
  expect(container.innerHTML).toContain("var(--c-node-");
  // Both sheets are read for real (vitest's CSS include), so the checks below are not empty.
  expect(flowCss.length).toBeGreaterThan(0);
  expect(flowTabCss.length).toBeGreaterThan(0);
  for (const css of [flowCss, flowTabCss]) expect(css.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![\w-])/gi) ?? []).toEqual([]);
  // No literal durations: motion comes from the tokens, which reduced motion turns into 0.
  expect(flowTabCss.match(/\b\d+m?s\b/g) ?? []).toEqual([]);
});

test("two_unreadable_lines_are_both_named_under_the_preview", async () => {
  const { dialog, paste } = setup();
  paste("flowchart TB\n  A --> B\n  B -> C\n  C -> D");
  expect(await within(dialog).findByText("Fix or delete the 2 lines marked to go on.")).toBeTruthy();
  expect(within(dialog).getAllByRole("alert")).toHaveLength(2);
});

test("the_notes_list_shows_the_first_200_and_counts_the_rest", async () => {
  const { dialog, paste } = setup();
  paste(`flowchart TB\n${"A:::c\n".repeat(250)}`);
  const list = await within(dialog).findByRole("list", { name: "Not carried over" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(200);
  expect(within(dialog).getByText("250", { selector: ".chip" })).toBeTruthy();
  expect(within(dialog).getByText("And 50 more.")).toBeTruthy();
});

test("the Mermaid editor takes the dark flag in the dark theme (item 50)", () => {
  document.documentElement.setAttribute("data-theme", "dark");
  try {
    const s = setup();
    expect(s.view().state.facet(EditorView.darkTheme)).toBe(true);
  } finally {
    document.documentElement.removeAttribute("data-theme");
  }
});

test("the Mermaid editor's gutter takes the app tokens, not CodeMirror's dark grey (item 50)", () => {
  const plain = flowCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = [...plain.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1].trim() === ".mermaid-editor .cm-gutters");
  expect(rule?.[2]).toMatch(/background:\s*var\(--c-bg-surface\)/);
  expect(rule?.[2]).toMatch(/border-right:[^;]*var\(--c-border-subtle\)/);
  const numbers = [...plain.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1].trim() === ".mermaid-editor .cm-lineNumbers");
  expect(numbers?.[2]).toMatch(/color:\s*var\(--c-text-faint\)/);
});

const TB = "flowchart TD\n  A[Start] --> B[Done]";
const addOf = (run: MermaidAdd["run"]): MermaidAdd => ({ file: "board", run });

test("add_mode_adds_a_frame_and_closes", async () => {
  const run = vi.fn(async (_f: string, _d: "TB" | "LR") => null);
  const { dialog, paste, onClose, onCreated } = setup(undefined, addOf(run));
  const title = within(dialog).getByRole("textbox", { name: "Title" }) as HTMLInputElement;
  expect(title.value).toBe("Untitled diagram");
  expect(within(dialog).queryByRole("button", { name: /^Create/ })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: /^Insert/ })).toBeNull();
  expect(within(dialog).queryByRole("combobox", { name: "Group" })).toBeNull();
  const add = within(dialog).getByRole("button", { name: /Add to board/ }) as HTMLButtonElement;
  paste(TB);
  await waitFor(() => expect(add.disabled).toBe(false));
  fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][0]).toContain("Start");
  expect(run.mock.calls[0][1]).toBe("TB");
  expect(onCreated).not.toHaveBeenCalled();
  expect(callsTo("write_diagram")).toEqual([]);
});

test("ctrl_enter_in_create_mode_is_unchanged", async () => {
  const { dialog, onCreated } = await readyToCreate(false);
  expect(within(dialog).queryByRole("button", { name: /Add to board/ })).toBeNull();
  expect(within(dialog).getByRole("textbox", { name: "Name" })).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("order-handover"));
});

test("a_refused_add_keeps_the_dialog_with_its_note", async () => {
  const run = vi.fn(async () => "The board is full.");
  const { dialog, paste, onClose } = setup(undefined, addOf(run));
  paste(TB);
  const add = within(dialog).getByRole("button", { name: /Add to board/ }) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(false));
  fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
  expect(await within(dialog).findByText("The board is full.")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

test("a_typed_title_names_the_frame", async () => {
  const run = vi.fn(async (_f: string, _d: "TB" | "LR") => null);
  const { dialog, paste, onClose } = setup(undefined, addOf(run));
  const title = within(dialog).getByRole("textbox", { name: "Title" });
  await userEvent.clear(title);
  await userEvent.type(title, "Payments flow");
  paste(TB);
  const add = within(dialog).getByRole("button", { name: /Add to board/ }) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(false));
  fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(run.mock.calls[0][0].split("\n")[0]).toBe('diagram flow "Payments flow"');
});

test("a_dashed_title_is_kept_as_typed", async () => {
  const run = vi.fn(async (_f: string, _d: "TB" | "LR") => null);
  const { dialog, paste, onClose } = setup(undefined, addOf(run));
  const title = within(dialog).getByRole("textbox", { name: "Title" });
  await userEvent.clear(title);
  await userEvent.type(title, "pay-ments");
  paste(TB);
  const add = within(dialog).getByRole("button", { name: /Add to board/ }) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(false));
  fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(run.mock.calls[0][0].split("\n")[0]).toBe('diagram flow "pay-ments"');
});

// ----- B2 final review: one add per press (Important 1)

test("add_pressed_twice_in_one_go_adds_once", async () => {
  const run = vi.fn(async (_f: string, _d: "TB" | "LR") => null);
  const { dialog, paste, onClose } = setup(undefined, addOf(run));
  paste(TB);
  const add = within(dialog).getByRole("button", { name: /Add to board/ }) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(false));
  act(() => {
    fireEvent.click(add);
    fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
  });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50));
  expect(run).toHaveBeenCalledTimes(1);
});

test("create_pressed_twice_in_one_go_writes_once", async () => {
  const { dialog, onCreated } = await readyToCreate(false);
  const create = within(dialog).getByRole("button", { name: /^Create flow/ });
  act(() => {
    fireEvent.click(create);
    fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
  });
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50));
  expect(onCreated).toHaveBeenCalledTimes(1);
  expect(callsTo("write_diagram")).toHaveLength(1);
});

// ----- B2 final review: Cancel cancels (Important 2)

/** The dialog as App shows it: `onClose` unmounts it. */
function hosted(add?: MermaidAdd) {
  const onCreated = vi.fn();
  function Host() {
    const [open, setOpen] = useState(true);
    return open ? (
      <MermaidImportDialog groups={GROUPS} defaultGroup={null} lang={new LangClient(fakeWorker)} onClose={() => setOpen(false)} onCreated={onCreated} add={add} />
    ) : null;
  }
  render(
    <ToastProvider>
      <Host />
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Diagram from Mermaid" });
  const view = () => EditorView.findFromDOM(dialog.querySelector(".cm-editor") as HTMLElement)!;
  act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TB } }));
  return { dialog, onCreated };
}

/** Holds the next conversions until `release` is called. */
function slowConvert() {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const real = LangClient.prototype.mermaid;
  const spy = vi.spyOn(LangClient.prototype, "mermaid").mockImplementation(async function (this: LangClient, ...args: Parameters<LangClient["mermaid"]>) {
    await gate;
    return real.apply(this, args);
  });
  return { release: () => release(), spy };
}

test("cancel_while_converting_adds_no_frame", async () => {
  const run = vi.fn(async (_f: string, _d: "TB" | "LR") => null);
  const { dialog } = hosted(addOf(run));
  const add = within(dialog).getByRole("button", { name: /Add to board/ }) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(false));
  const slow = slowConvert();
  try {
    fireEvent.click(add);
    await waitFor(() => expect(slow.spy).toHaveBeenCalled());
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel/ }));
    expect(screen.queryByRole("dialog", { name: "Diagram from Mermaid" })).toBeNull();
    await act(async () => {
      slow.release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(run).not.toHaveBeenCalled();
  } finally {
    slow.spy.mockRestore();
  }
});

test("cancel_while_converting_writes_no_file", async () => {
  routeInvoke({ list_diagrams: () => [], write_diagram: () => undefined });
  const { dialog, onCreated } = hosted();
  const create = within(dialog).getByRole("button", { name: /^Create/ }) as HTMLButtonElement;
  await waitFor(() => expect(create.disabled).toBe(false));
  const slow = slowConvert();
  try {
    fireEvent.click(create);
    await waitFor(() => expect(slow.spy).toHaveBeenCalled());
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel/ }));
    expect(screen.queryByRole("dialog", { name: "Diagram from Mermaid" })).toBeNull();
    await act(async () => {
      slow.release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(callsTo("write_diagram")).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled();
  } finally {
    slow.spy.mockRestore();
  }
});
