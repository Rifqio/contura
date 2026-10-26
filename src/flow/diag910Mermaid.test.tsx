// Diagram step 10 (F28, board DiagramStartWell; rulings of 25 Oct): the Mermaid dialog takes every kind Contura has.
// It counts what came in by kind; a line that cannot be read is marked on its line, listed with its reason, and blocks
// Create ("Fix or delete line N to go on.") with no empty band under it; from New diagram it has Back and no Insert;
// from the canvas it has Insert, for the open diagram's kind only (Ctrl+Shift+Enter); an ER diagram goes to the Schema
// Builder; Esc closes the whole dialog.
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import MermaidImportDialog from "./MermaidImportDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => vi.useRealTimers());

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const CHECKOUT = lines("sequenceDiagram", "    actor C as Customer", "    participant S as Shop", "    C->>S: place order", "    S-->>C: receipt");
const PACKING = lines("flowchart LR", "    A[Pack] --> B[Print label]", "    B --> C[Ship order]");

function setup(more: { onBack?: () => void; insert?: { kind: "flow" | "sequence"; file: string; run(flow: string): Promise<string | null> } } = {}) {
  routeInvoke({ write_diagram: () => undefined });
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const lang = new LangClient(fakeWorker);
  render(
    <ToastProvider>
      <MermaidImportDialog groups={[]} defaultGroup={null} lang={lang} onClose={onClose} onCreated={onCreated} {...more} />
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Diagram from Mermaid" });
  const view = () => EditorView.findFromDOM(dialog.querySelector(".cm-editor") as HTMLElement)!;
  const paste = (text: string) => act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: text } }));
  const button = (name: RegExp) => within(dialog).getByRole("button", { name }) as HTMLButtonElement;
  return { dialog, view, paste, button, onClose, onCreated };
}

test("a sequence comes in counted by its kind, and Create writes it as a sequence", async () => {
  const s = setup();
  s.paste(CHECKOUT);
  await waitFor(() => expect(within(s.dialog).getByText("Sequence: 2 participants, 2 messages")).toBeTruthy());
  expect(s.button(/^Create sequence/).disabled).toBe(false);
  await userEvent.click(s.button(/^Create sequence/));
  // Fix round 1, M8: the default name is New diagram's.
  await waitFor(() => expect(s.onCreated).toHaveBeenCalledWith("Untitled diagram"));
  expect(callsTo("write_diagram")[0].text).toBe(lines('diagram sequence "Untitled diagram"', "actor Customer", "participant Shop", "Customer -> Shop: place order", "Shop --> Customer: receipt"));
});

test("a line that cannot be read is marked on its line, says why, and blocks Create with no empty band under it", async () => {
  const s = setup();
  s.paste(`${CHECKOUT}    Shop ->>\n`);
  const row = await within(s.dialog).findByText("Line 6: cannot read Shop ->>. A message is written A->>B: text.");
  // The line is marked where it is written.
  await waitFor(() => expect(s.dialog.querySelectorAll(".cm-line.cm-mermaid-bad")).toHaveLength(1));
  expect(s.dialog.querySelector(".cm-line.cm-mermaid-bad")?.textContent).toBe("    Shop ->>");
  expect(within(s.dialog).getByText("Fix or delete line 6 to go on.")).toBeTruthy();
  expect(s.button(/^Create sequence/).disabled).toBe(true);
  fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
  expect(callsTo("write_diagram")).toEqual([]);
  // Nothing sits under the error row: no empty band, no notes list, no banner over the preview.
  const problems = row.closest(".mermaid-problems") as HTMLElement;
  expect([...problems.children].map((c) => c.textContent)).toEqual(["Line 6: cannot read Shop ->>. A message is written A->>B: text."]);
  expect(s.dialog.querySelector(".mermaid-left-out")).toBeNull();
  // Fixed, it can go on.
  s.paste(CHECKOUT);
  await waitFor(() => expect(s.button(/^Create sequence/).disabled).toBe(false));
  expect(s.dialog.querySelector(".mermaid-problems")).toBeNull();
});

test("an ER diagram is refused: Mermaid ER is not imported yet", async () => {
  const s = setup();
  s.paste(lines("erDiagram", "    CUSTOMER ||--o{ ORDER : places"));
  expect(await within(s.dialog).findByText("Mermaid ER diagrams are not imported yet. Start an ER diagram and write its tables.")).toBeTruthy();
  expect(s.button(/^Create/).disabled).toBe(true);
});

test("from New diagram: Back returns to it, and there is no Insert", async () => {
  const onBack = vi.fn();
  const s = setup({ onBack });
  expect(within(s.dialog).queryByRole("button", { name: /^Insert/ })).toBeNull();
  await userEvent.click(s.button(/^Back/));
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(s.onClose).not.toHaveBeenCalled();
});

test("Esc closes the whole dialog", async () => {
  const onBack = vi.fn();
  const s = setup({ onBack });
  fireEvent.keyDown(s.dialog, { key: "Escape" });
  expect(s.onClose).toHaveBeenCalledTimes(1);
  expect(onBack).not.toHaveBeenCalled();
});

test("from the canvas: Insert puts it into the open diagram of the same kind; another kind is refused with the reason", async () => {
  const run = vi.fn(async () => null);
  const s = setup({ insert: { kind: "flow", file: "Order handling", run } });
  expect(within(s.dialog).queryByRole("button", { name: /^Back/ })).toBeNull();
  s.paste(CHECKOUT);
  await waitFor(() => expect(within(s.dialog).getByText("Sequence: 2 participants, 2 messages")).toBeTruthy());
  const insert = s.button(/^Insert into Order handling/);
  expect(insert.disabled).toBe(true);
  expect(insert.title).toBe("Insert takes a flowchart here; this is a sequence. Create makes it a new diagram.");
  expect(within(s.dialog).getByText("Insert takes a flowchart here; this is a sequence. Create makes it a new diagram.")).toBeTruthy();
  expect(s.button(/^Create sequence/).disabled).toBe(false);
  s.paste(PACKING);
  await waitFor(() => expect(s.button(/^Insert into Order handling/).disabled).toBe(false));
  // Ctrl+Shift+Enter inserts.
  fireEvent.keyDown(document, { key: "Enter", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect((run.mock.calls[0] as unknown as [string])[0]).toContain("Pack [step]");
  await waitFor(() => expect(s.onClose).toHaveBeenCalledTimes(1));
  expect(callsTo("write_diagram")).toEqual([]);
});

test("an Insert the open diagram refuses keeps the dialog open with the reason", async () => {
  const run = vi.fn(async () => "The assistant is working on the text.");
  const s = setup({ insert: { kind: "flow", file: "Order handling", run } });
  s.paste(PACKING);
  await waitFor(() => expect(s.button(/^Insert into Order handling/).disabled).toBe(false));
  await userEvent.click(s.button(/^Insert into Order handling/));
  expect(await within(s.dialog).findByText("The assistant is working on the text.")).toBeTruthy();
  expect(s.onClose).not.toHaveBeenCalled();
});

test("fix round 1, M8: the default name follows New diagram's free-name rule, and a Mermaid title names it when free", async () => {
  routeInvoke({ write_diagram: () => undefined, list_diagrams: () => [{ name: "Untitled diagram", kind: "flow", title: "Untitled diagram", modifiedMs: 0 }, { name: "Checkout", kind: "sequence", title: "Checkout", modifiedMs: 0 }] });
  const lang = new LangClient(fakeWorker);
  render(
    <ToastProvider>
      <MermaidImportDialog groups={[]} defaultGroup={null} lang={lang} onClose={() => {}} onCreated={() => {}} />
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Diagram from Mermaid" });
  const name = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
  await waitFor(() => expect(name.value).toBe("Untitled diagram 2"));
  const view = EditorView.findFromDOM(dialog.querySelector(".cm-editor") as HTMLElement)!;
  act(() => view.dispatch({ changes: { from: 0, insert: lines("sequenceDiagram", "    title Checkout", "    A->>B: hi") } }));
  await waitFor(() => expect(name.value).toBe("Checkout 2"));
});

test("fix round 1, M3: Back with Mermaid typed asks first; Keep editing stays, Discard goes back", async () => {
  const onBack = vi.fn();
  const s = setup({ onBack });
  s.paste(CHECKOUT);
  await userEvent.click(s.button(/^Back/));
  const ask = await within(s.dialog).findByRole("alert", { name: "Discard your changes?" });
  expect(onBack).not.toHaveBeenCalled();
  await userEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
  expect(within(s.dialog).queryByRole("alert", { name: "Discard your changes?" })).toBeNull();
  expect(s.view().state.doc.toString()).toBe(CHECKOUT);
  await userEvent.click(s.button(/^Back/));
  await userEvent.click(within(await within(s.dialog).findByRole("alert", { name: "Discard your changes?" })).getByRole("button", { name: "Discard" }));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("fix round 2, L3 and L4: the dialog opens with focus in the Mermaid text, and the toast names the diagram without .flow", async () => {
  const s = setup();
  await waitFor(() => expect(document.activeElement?.closest(".cm-editor")).toBeTruthy());
  s.paste(CHECKOUT);
  await waitFor(() => expect(s.button(/^Create sequence/).disabled).toBe(false));
  await userEvent.click(s.button(/^Create sequence/));
  expect(await screen.findByText("Created Untitled diagram")).toBeTruthy();
});
