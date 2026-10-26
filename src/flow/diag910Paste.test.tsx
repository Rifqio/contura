// Diagram step 10 (user decision, 25 Oct): Mermaid pasted into a .flow file's text or onto its canvas is translated
// in place by the Mermaid importer, as one undo step, and the strip says so; a second Ctrl+Z leaves the Mermaid exactly
// as pasted (VS Code's paste-then-undo). An empty file takes the pasted kind; another kind is refused and nothing is
// pasted; a line it cannot read stays as a // comment with its reason; an ER diagram goes to the Schema Builder.
// Plain text pastes as before.
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { LangClient } from "../lang/client";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(cleanup);

const lines = (...l: string[]) => `${l.join("\n")}\n`;

function setup(initial: string) {
  routeInvoke({ read_diagram: () => ({ text: initial, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="d910p" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const status = () => within(utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement).queryByRole("status")?.textContent ?? "";
  const pasteOnCanvas = (text: string) => fireEvent.paste(canvasEl(), { clipboardData: { getData: () => text } });
  /** A paste in the text where you are typing, as the WebView sends it. */
  const pasteInText = (text: string, at: number) => {
    act(() => view().dispatch({ selection: { anchor: at } }));
    const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    e.clipboardData = { getData: (t: string) => (t === "text/plain" ? text : "") };
    act(() => void view().contentDOM.dispatchEvent(e));
  };
  return { ...utils, view, doc, canvasEl, status, pasteOnCanvas, pasteInText };
}
type Setup = ReturnType<typeof setup>;
const ready = (s: Setup, text: string) => waitFor(() => expect(s.doc()).toBe(text), { timeout: 4000 });

const SEQ = lines('diagram sequence "Checkout"', "participant Shop", "participant Payments", "Shop -> Payments: charge");
const MERMAID_SEQ = lines("sequenceDiagram", "    participant Shop", "    participant Bank", "    Shop->>Bank: pay");

test("canvas: a Mermaid sequence pasted on a sequence comes in translated, one undo step; a second Ctrl+Z leaves the Mermaid as pasted", async () => {
  const s = setup(SEQ);
  await ready(s, SEQ);
  // Let the first parse arrive.
  await waitFor(() => expect(s.container.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 4000 });
  s.pasteOnCanvas(MERMAID_SEQ);
  const translated = SEQ + lines("", "participant Bank", "Shop -> Bank: pay");
  await waitFor(() => expect(s.doc()).toBe(translated));
  expect(s.status()).toBe("Pasted Mermaid as flow text.");
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(SEQ + MERMAID_SEQ));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(SEQ));
});

test("text: a Mermaid flowchart pasted where you are typing comes in there, translated, with free names", async () => {
  const FLOW = lines('diagram flow "Orders"', "Ship order", "Done [end]", "", "Ship order > Done");
  const s = setup(FLOW);
  await ready(s, FLOW);
  await waitFor(() => expect(s.container.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 4000 });
  s.pasteInText(lines("flowchart LR", "    A[Pack] --> B[Ship order]"), FLOW.indexOf("Done [end]"));
  await waitFor(() => expect(s.doc()).toBe(lines('diagram flow "Orders"', "Ship order", "Pack [step]", "Ship order 2 [step]", "", "Pack > Ship order 2", "Done [end]", "", "Ship order > Done")));
  expect(s.status()).toBe("Pasted Mermaid as flow text.");
});

test("an empty file takes the pasted kind, its title kept", async () => {
  const EMPTY = lines('diagram flow "Invoice"');
  const s = setup(EMPTY);
  await ready(s, EMPTY);
  await waitFor(() => expect(s.container.querySelector(".flow-first-node")).not.toBeNull(), { timeout: 4000 });
  s.pasteOnCanvas(lines("stateDiagram-v2", "    [*] --> Draft", "    Draft --> Sent : send"));
  await waitFor(() => expect(s.doc()).toBe(lines('diagram state "Invoice"', "", "Draft", "Sent", "", "[*] > Draft", "Draft > Sent: send")));
  act(() => void undo(s.view()));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(EMPTY));
});

test("another kind is refused with the reason, and the Mermaid is not pasted", async () => {
  const s = setup(SEQ);
  await ready(s, SEQ);
  await waitFor(() => expect(s.container.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 4000 });
  s.pasteOnCanvas(lines("classDiagram", "    class Invoice"));
  await waitFor(() => expect(s.status()).toBe("The pasted Mermaid is a class diagram and this is a sequence, so nothing was pasted. New diagram > From Mermaid makes it a diagram of its own."));
  expect(s.doc()).toBe(SEQ);
  s.pasteInText(lines("classDiagram", "    class Invoice"), SEQ.length);
  await waitFor(() => expect(s.status()).toContain("nothing was pasted"));
  expect(s.doc()).toBe(SEQ);
});

test("a Mermaid ER diagram is not imported yet, and nothing is pasted", async () => {
  const s = setup(SEQ);
  await ready(s, SEQ);
  await waitFor(() => expect(s.container.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 4000 });
  s.pasteOnCanvas(lines("erDiagram", "    CUSTOMER ||--o{ ORDER : places"));
  await waitFor(() => expect(s.status()).toBe("Mermaid ER diagrams are not imported yet. Start an ER diagram and write its tables."));
  expect(s.doc()).toBe(SEQ);
});

test("a line it cannot read is kept as a // comment with its reason, never dropped", async () => {
  const s = setup(SEQ);
  await ready(s, SEQ);
  await waitFor(() => expect(s.container.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 4000 });
  s.pasteOnCanvas(lines("sequenceDiagram", "    Shop->>Payments: refund", "    Shop ->>"));
  await waitFor(() => expect(s.doc()).toBe(SEQ + lines("", "// Shop ->>  // cannot read Shop ->>. A message is written A->>B: text.", "Shop -> Payments: refund")));
});

test("plain text that is not Mermaid pastes as it does today", async () => {
  const s = setup(SEQ);
  await ready(s, SEQ);
  s.pasteInText("participant Bank\n", SEQ.length);
  // The editor's own paste: the text goes in as it is.
  await waitFor(() => expect(s.doc()).toBe(`${SEQ}participant Bank\n`));
});

test("the canvas's Mermaid... opens the dialog for this diagram; Insert writes it in one undo step, the new shapes selected", async () => {
  const FLOW = lines('diagram flow "Orders"', "Ship order", "Done [end]", "", "Ship order > Done");
  routeInvoke({ read_diagram: () => ({ text: FLOW, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const onMermaid = vi.fn();
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="orders" client={client} onMermaid={onMermaid} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  await waitFor(() => expect(utils.container.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 4000 });
  fireEvent.click(within(utils.container.querySelector(".flow-toolbar") as HTMLElement).getByRole("button", { name: "Mermaid..." }));
  expect(onMermaid).toHaveBeenCalledTimes(1);
  const target = onMermaid.mock.calls[0][0] as { kind: string; file: string; run(flow: string): Promise<string | null> };
  expect([target.kind, target.file]).toEqual(["flow", "orders"]);
  let why: string | null = "not run";
  await act(async () => {
    why = await target.run(lines('diagram flow "P"', "", "Pack [step]", "Ship order [step]", "", "Pack > Ship order"));
  });
  expect(why).toBeNull();
  const after = FLOW + lines("", "Pack [step]", "Ship order 2 [step]", "", "Pack > Ship order 2");
  expect(view().state.doc.toString()).toBe(after);
  const strip = utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  await waitFor(() => expect(strip.textContent).toContain("2 selected"));
  expect(strip.textContent).toContain("Inserted from Mermaid into orders, selected. One undo step.");
  act(() => void undo(view()));
  await waitFor(() => expect(view().state.doc.toString()).toBe(FLOW));
});

// ----- fix round 1: I1 where a paste in the text lands, I2 a paste is never lost, M12 comments stay

const FLOW2 = lines('diagram flow "Orders"', "Ship order", "Spare", "Done [end]", "", "Ship order > Done");
const PACK = lines("flowchart LR", "    A[Pack] --> B[Ship order]");
const PACKED = (at: string) => FLOW2.replace(at, `${lines("Pack [step]", "Ship order 2 [step]", "", "Pack > Ship order 2")}${at}`);

async function drawnFlow(s: Setup, text: string) {
  await ready(s, text);
  await waitFor(() => expect(s.container.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 4000 });
}

test("I1 a paste with the text at its very start goes after the diagram line, never above it", async () => {
  const s = setup(FLOW2);
  await drawnFlow(s, FLOW2);
  s.pasteInText(PACK, 0);
  await waitFor(() => expect(s.doc()).toBe(PACKED("Ship order\nSpare")));
  expect(s.doc().startsWith('diagram flow "Orders"\n')).toBe(true);
});

test("I1 a paste over a selection replaces it", async () => {
  const s = setup(FLOW2);
  await drawnFlow(s, FLOW2);
  const from = FLOW2.indexOf("Spare");
  act(() => s.view().dispatch({ selection: { anchor: from, head: from + "Spare\n".length } }));
  const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  e.clipboardData = { getData: (t: string) => (t === "text/plain" ? PACK : "") };
  act(() => void s.view().contentDOM.dispatchEvent(e));
  await waitFor(() => expect(s.doc()).toBe(PACKED("Spare\n").replace("Spare\n", "")));
});

test("I1 a paste over the whole file replaces it: the kind comes from the Mermaid, the title stays", async () => {
  const s = setup(FLOW2);
  await drawnFlow(s, FLOW2);
  act(() => s.view().dispatch({ selection: { anchor: 0, head: FLOW2.length } }));
  const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  e.clipboardData = { getData: (t: string) => (t === "text/plain" ? lines("stateDiagram-v2", "    [*] --> Draft") : "") };
  act(() => void s.view().contentDOM.dispatchEvent(e));
  await waitFor(() => expect(s.doc()).toBe(lines('diagram state "Orders"', "", "Draft", "", "[*] > Draft")));
});

test("M12 a file with only its first line and comments keeps its comments, and takes the pasted kind", async () => {
  const NOTES = lines('diagram flow "Notes"', "// keep me");
  const s = setup(NOTES);
  await ready(s, NOTES);
  await waitFor(() => expect(s.container.querySelector(".flow-first-node")).not.toBeNull(), { timeout: 4000 });
  s.pasteOnCanvas(lines("sequenceDiagram", "    A->>B: hi"));
  await waitFor(() => expect(s.doc()).toBe(lines('diagram sequence "Notes"', "// keep me", "A -> B: hi")));
});

test("I2 a translation that fails leaves the Mermaid as pasted, and says why", async () => {
  const spy = vi.spyOn(LangClient.prototype, "mermaid").mockRejectedValueOnce(new Error("The worker stopped."));
  const s = setup(SEQ);
  await drawnFlow(s, SEQ);
  s.pasteOnCanvas(MERMAID_SEQ);
  await waitFor(() => expect(s.status()).toBe("The Mermaid could not be translated (The worker stopped.), so it stays as pasted."));
  expect(s.doc()).toBe(SEQ + MERMAID_SEQ);
  spy.mockRestore();
});

test("I2 text typed while the Mermaid is translated keeps the Mermaid as pasted, and says why", async () => {
  let release: () => void = () => {};
  const real = LangClient.prototype.mermaid;
  const spy = vi.spyOn(LangClient.prototype, "mermaid").mockImplementationOnce(function (this: LangClient, ...args) {
    return new Promise((r) => {
      release = () => r(real.apply(this, args));
    });
  });
  const s = setup(SEQ);
  await drawnFlow(s, SEQ);
  s.pasteOnCanvas(MERMAID_SEQ);
  await waitFor(() => expect(s.doc()).toBe(SEQ + MERMAID_SEQ));
  act(() => s.view().dispatch({ changes: { from: 0, insert: "// typed\n" }, userEvent: "input.type" }));
  await act(async () => release());
  await waitFor(() => expect(s.status()).toBe("The text changed while the Mermaid was translated, so it stays as pasted."));
  expect(s.doc()).toBe(`// typed\n${SEQ}${MERMAID_SEQ}`);
  spy.mockRestore();
});

test("I2 a Mermaid kind this diagram does not take is refused before anything is pasted; the strip says why", async () => {
  const s = setup(SEQ);
  await drawnFlow(s, SEQ);
  s.pasteInText(lines("classDiagram", "    class Invoice"), SEQ.length);
  await waitFor(() => expect(s.status()).toContain("nothing was pasted"));
  expect(s.doc()).toBe(SEQ);
});

// ----- fix round 2: N4, N5

function pasteOver(s: Setup, text: string, from: number, to: number) {
  act(() => s.view().dispatch({ selection: { anchor: from, head: to } }));
  const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  e.clipboardData = { getData: (t: string) => (t === "text/plain" ? text : "") };
  act(() => void s.view().contentDOM.dispatchEvent(e));
}

test("N4 a paste over a selection in a file with no shapes replaces the selection", async () => {
  const NOTES = lines('diagram flow "Notes"', "// one", "// two");
  const s = setup(NOTES);
  await ready(s, NOTES);
  await waitFor(() => expect(s.container.querySelector(".flow-first-node")).not.toBeNull(), { timeout: 4000 });
  const from = NOTES.indexOf("// one");
  pasteOver(s, lines("flowchart LR", "    A --> B"), from, from + "// one\n".length);
  await waitFor(() => expect(s.status()).toBe("Pasted Mermaid as flow text."));
  expect(s.doc()).not.toContain("// one");
  expect(s.doc()).toContain("// two");
});

test("N5 a selection that takes the diagram line but not the whole file keeps the Mermaid as pasted and says how to go on", async () => {
  const s = setup(FLOW2);
  await drawnFlow(s, FLOW2);
  pasteOver(s, PACK, 0, FLOW2.indexOf("Spare"));
  await waitFor(() => expect(s.status()).toBe("The selection takes the diagram's first line, so the Mermaid stays as pasted. Select from line 2, or the whole file, to translate it."));
  expect(s.doc()).toBe(PACK + FLOW2.slice(FLOW2.indexOf("Spare")));
});

// ----- a board: the paste goes to the frame that holds it

const BOARD_FLOW = lines('diagram flow "Orders"', "Ship order", "Done [end]", "", "Ship order > Done");
const BOARD_SEQ = lines('diagram sequence "Checkout"', "participant Shop", "participant Payments", "Shop -> Payments: charge");
const BOARD = `${BOARD_FLOW}\n${BOARD_SEQ}`;

test("on a board, Mermaid on the canvas goes to the end of frame 0, its names free against frame 0 only", async () => {
  const s = setup(BOARD);
  await drawnFlow(s, BOARD);
  // Shop is a participant of the sequence frame, not a shape of frame 0, so it keeps its name.
  s.pasteOnCanvas(lines("flowchart LR", "    A[Shop] --> B[Ship order]"));
  await waitFor(() => expect(s.status()).toBe("Pasted Mermaid as flow text."));
  expect(s.doc()).toBe(`${BOARD_FLOW}${lines("", "Shop [step]", "Ship order 2 [step]", "", "Shop > Ship order 2")}\n${BOARD_SEQ}`);
});

test("on a board, Mermaid pasted in the text is checked against the frame it goes into, and lands there", async () => {
  const s = setup(BOARD);
  await drawnFlow(s, BOARD);
  // A flowchart pasted inside the sequence frame is refused: that frame is a sequence.
  s.pasteInText(PACK, BOARD.length);
  await waitFor(() => expect(s.status()).toBe("The pasted Mermaid is a flowchart and this is a sequence, so nothing was pasted. New diagram > From Mermaid makes it a diagram of its own."));
  expect(s.doc()).toBe(BOARD);
  // A sequence goes in there, though frame 0 is a flowchart.
  s.pasteInText(lines("sequenceDiagram", "    Shop->>Bank: pay"), BOARD.length);
  await waitFor(() => expect(s.status()).toBe("Pasted Mermaid as flow text."));
  expect(s.doc()).toBe(BOARD + lines("Shop -> Bank: pay"));
});
