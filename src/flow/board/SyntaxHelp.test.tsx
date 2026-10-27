// Task 14 (Decision 25, owner answer 8): Syntax Help, the code pane's `<?>`, opens a dialog on the shown frame's kind
// only: its rows, a Copy per row, Esc and Close giving focus back to `<?>`.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS } from "../../api/types";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import flowTabCss from "../../styles/flow-tab.css?raw";
import { CARDS } from "../diagramKinds";
import FlowTab from "../FlowTab";
import SyntaxHelp from "./SyntaxHelp";
import { SYNTAX_HELP } from "./syntaxRows";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const LOGIN = 'diagram sequence "Login"\nApp -> Api\n';

function setup() {
  routeInvoke({
    read_diagram: () => ({ text: [CHECKOUT, LOGIN].join("\n"), layout: null }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    ui_prefs: () => DEFAULT_UI_PREFS,
    save_ui_prefs: () => null,
    list_ai_threads: () => [],
    get_ai_thread: () => null,
    ai_settings: () => ({ settings: null, groupOverride: false, keySaved: false, keyLast4: null }),
  });
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  const pane = () => utils.container.querySelector('section[aria-label="Side panel"]') as HTMLElement;
  return { ...utils, pane };
}

/** Opens the board, selects the sequence frame and waits for the pane to show it. */
async function onLogin(s: ReturnType<typeof setup>) {
  fireEvent.click(await within(s.container).findByRole("button", { name: "Sequence Login" }));
  await waitFor(() => expect(within(s.pane()).getByRole("heading", { name: "Sequence" })).toBeTruthy());
}

test("it_shows_only_the_frame_kind", async () => {
  const s = setup();
  await onLogin(s);
  fireEvent.click(within(s.pane()).getByRole("button", { name: "Syntax help" }));
  const dialog = await screen.findByRole("dialog", { name: `${CARDS.sequence.title} syntax` });
  expect(within(dialog).getByRole("columnheader", { name: "Description" })).toBeTruthy();
  expect(within(dialog).getByRole("columnheader", { name: "Example" })).toBeTruthy();
  const rows = within(dialog).getAllByRole("row").slice(1);
  expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(SYNTAX_HELP.sequence.map((r) => r.what));
  // One code line per example line.
  const first = SYNTAX_HELP.sequence.find((r) => r.example.includes("\n"))!;
  const at = SYNTAX_HELP.sequence.indexOf(first);
  expect([...rows[at].querySelectorAll("code .syntax-help-line")].map((l) => l.textContent)).toEqual(first.example.split("\n"));
  // No other kind's rows.
  const text = dialog.textContent ?? "";
  for (const r of SYNTAX_HELP.flow) if (!SYNTAX_HELP.sequence.some((q) => q.example.includes(r.example))) expect(text).not.toContain(r.example);
  expect(within(dialog).getByText(`Covers the ${CARDS.sequence.title} kind only.`)).toBeTruthy();
  // Owner answer 8: no docs links in B1.
  expect(within(dialog).queryByText(/Full syntax|Icon gallery/)).toBeNull();
  expect(dialog.querySelector("a")).toBeNull();

  // The flowchart frame's help is the flowchart's.
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(await within(s.container).findByRole("button", { name: "Flowchart Checkout" }));
  await waitFor(() => expect(within(s.pane()).getByRole("heading", { name: "Flowchart" })).toBeTruthy());
  fireEvent.click(within(s.pane()).getByRole("button", { name: "Syntax help" }));
  const flow = await screen.findByRole("dialog", { name: `${CARDS.flow.title} syntax` });
  expect(within(flow).getAllByRole("row").length).toBe(SYNTAX_HELP.flow.length + 1);
});

test("copy_writes_the_example", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(<SyntaxHelp kind="er" onClose={() => {}} />);
  const row = SYNTAX_HELP.er.find((r) => r.example.includes("\n"))!;
  const label = `Copy ${row.example.replace(/\s*\n\s*/g, " ")}`;
  const copy = screen.getByRole("button", { name: label });
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.click(copy);
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenCalledWith(row.example);
  expect(copy.textContent).toContain("Copied");
  expect(screen.getByRole("status").textContent).toBe("Copied");
  // Only the row copied says so.
  expect(screen.getAllByRole("button", { name: /^Copy / }).filter((b) => b.textContent?.includes("Copied"))).toHaveLength(1);
  act(() => vi.advanceTimersByTime(1500));
  expect(copy.textContent).not.toContain("Copied");
  expect(screen.getByRole("status").textContent).toBe("");
});

test("a_refused_copy_says_so", async () => {
  const writeText = vi.fn(() => Promise.reject(new Error("denied")));
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(<SyntaxHelp kind="flow" onClose={() => {}} />);
  const copy = screen.getByRole("button", { name: `Copy ${SYNTAX_HELP.flow[0].example}` });
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.click(copy);
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenCalledWith(SYNTAX_HELP.flow[0].example);
  expect(copy.textContent).toBe("Could not copy");
  expect(screen.getByRole("status").textContent).toBe("Could not copy");
  act(() => vi.advanceTimersByTime(1500));
  expect(copy.textContent).toBe("Copy");
  expect(screen.getByRole("status").textContent).toBe("");
});

test("esc_closes_and_focus_returns", async () => {
  const s = setup();
  await onLogin(s);
  const help = within(s.pane()).getByRole("button", { name: "Syntax help" });
  help.focus();
  fireEvent.click(help);
  const dialog = await screen.findByRole("dialog", { name: "Sequence syntax" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.contains(document.activeElement)).toBe(true);
  // Tab stays inside: from the last control it goes to the first.
  const copies = within(dialog).getAllByRole("button", { name: /^Copy / });
  copies[copies.length - 1].focus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  // Esc closes and gives focus back to <?>.
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(help);
  // So does Close.
  fireEvent.click(help);
  const again = await screen.findByRole("dialog", { name: "Sequence syntax" });
  fireEvent.click(within(again).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(help);
});

test("code_examples_show_arrows_as_typed", () => {
  // C2: the mono font turns ligatures on through `calt`, so `-->` would draw as one arrow glyph.
  const rule = /\.syntax-help-example code\s*\{([^}]*)\}/.exec(flowTabCss);
  expect(rule).not.toBeNull();
  expect(rule![1]).toMatch(/font-variant-ligatures:\s*none;/);
  expect(rule![1]).toMatch(/font-feature-settings:\s*"liga" 0, "calt" 0;/);
  render(<SyntaxHelp kind="flow" onClose={() => {}} />);
  const lines = [...document.querySelectorAll(".syntax-help-example code .syntax-help-line")].map((l) => l.textContent);
  expect(lines).toContain("Pay --> Audit");
});
