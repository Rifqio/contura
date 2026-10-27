import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS } from "../api/types";
import { LangClient } from "../lang/client";
import { PrefsProvider } from "../prefs/usePrefs";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";
import SidePanel, { type SideTab } from "./SidePanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => cleanup());

/** The panel alone, with its state held here as the tab holds it. */
function Harness({ pending = 0, start = "editor", hidden = false }: { pending?: number; start?: SideTab; hidden?: boolean }) {
  const [tab, setTab] = useState<SideTab>(start);
  const [gone, setGone] = useState(hidden);
  return (
    <SidePanel
      tab={tab}
      hidden={gone}
      pending={pending}
      onTab={setTab}
      onHide={() => setGone(true)}
      onShow={(t) => {
        setGone(false);
        if (t) setTab(t);
      }}
      editor={<p>the editor</p>}
      assistant={<p>the assistant</p>}
    />
  );
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

test("switch_moves_between_editor_and_assistant", async () => {
  const { container } = render(<Harness pending={3} />);
  expect(tab("Editor").getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector(".pswitch")!.classList.contains("right")).toBe(false);
  expect(screen.getByText("the editor").parentElement!.hidden).toBe(false);
  expect(screen.getByText("the assistant").parentElement!.hidden).toBe(true);
  await userEvent.click(tab("Assistant"));
  expect(tab("Assistant").getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector(".pswitch")!.classList.contains("right")).toBe(true);
  expect(screen.getByText("the assistant").parentElement!.hidden).toBe(false);
  expect(screen.getByText("the editor").parentElement!.hidden).toBe(true);
  expect(within(tab("Assistant")).getByText("3")).toBeTruthy();
  await userEvent.click(tab("Editor"));
  expect(tab("Editor").getAttribute("aria-selected")).toBe("true");
});

test("hide_to_rail_and_back", async () => {
  render(<Harness />);
  expect(screen.getByRole("region", { name: "Side panel" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Hide the side panel" }));
  expect(screen.getByRole("navigation", { name: "Side panel, hidden" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Side panel" })).toBeNull();
  // Focus moves to the rail's first button, so the keyboard still reaches it.
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show the side panel" }));
  await userEvent.click(screen.getByRole("button", { name: "Show the side panel" }));
  expect(screen.queryByRole("navigation", { name: "Side panel, hidden" })).toBeNull();
  expect(tab("Editor").getAttribute("aria-selected")).toBe("true");
  // The rail's Assistant shows the panel on Assistant.
  await userEvent.click(screen.getByRole("button", { name: "Hide the side panel" }));
  await userEvent.click(screen.getByRole("button", { name: "Show the Assistant" }));
  expect(tab("Assistant").getAttribute("aria-selected")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Hide the side panel" }));
  await userEvent.click(screen.getByRole("button", { name: "Show the Editor" }));
  expect(tab("Editor").getAttribute("aria-selected")).toBe("true");
});

test("rail_shows_pending_count", () => {
  render(<Harness pending={4} hidden />);
  const rail = screen.getByRole("navigation", { name: "Side panel, hidden" });
  expect(within(screen.getByRole("button", { name: "Show the Assistant" })).getByText("4")).toBeTruthy();
  expect(within(rail).queryAllByText("4")).toHaveLength(1);
  cleanup();
  render(<Harness pending={0} hidden />);
  expect(within(screen.getByRole("button", { name: "Show the Assistant" })).queryByText("0")).toBeNull();
});

test("no_hover_text", () => {
  const { container, rerender } = render(<Harness pending={2} />);
  expect(container.querySelectorAll("[title]")).toHaveLength(0);
  expect(container.querySelectorAll("[data-tip]")).toHaveLength(0);
  rerender(<Harness pending={2} hidden />);
  expect(container.querySelectorAll("[title]")).toHaveLength(0);
});

const CLOUD = ['diagram cloud "Order API"', "Users [icon: users]", "API Gateway [icon: aws-api-gateway]", "Users > API Gateway: HTTPS", ""].join("\n");

function flowTab(stored: unknown = DEFAULT_UI_PREFS) {
  routeInvoke({
    read_diagram: () => ({ text: CLOUD, layout: null }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    ui_prefs: () => stored,
    save_ui_prefs: () => null,
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <PrefsProvider>
      <div style={{ width: 1280, height: 800 }}>
        <FlowTab name="orders" client={client} />
      </div>
    </PrefsProvider>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  return { ...utils, view };
}

test("choice_is_remembered", async () => {
  // Decision 16: the tab shown is remembered for every tab and the next start; open or closed is each tab's own and
  // never written, so the stored hidden stays as it was.
  const a = flowTab();
  await waitFor(() => expect(a.container.querySelector(".cm-editor")).not.toBeNull());
  await userEvent.click(tab("Assistant"));
  await userEvent.click(screen.getByRole("button", { name: "Hide the side panel" }));
  const saved = callsTo("save_ui_prefs").slice(-1)[0].prefs as typeof DEFAULT_UI_PREFS;
  expect(saved.flowSidePanel).toEqual({ hidden: false, tab: "assistant" });
  // The next tab reads the tab back, and opens with its pane open (owner answer 6), whatever the stored hidden says.
  cleanup();
  flowTab({ ...DEFAULT_UI_PREFS, flowSidePanel: { hidden: true, tab: "assistant" } });
  await waitFor(() => expect(tab("Assistant").getAttribute("aria-selected")).toBe("true"));
  expect(screen.queryByRole("navigation", { name: "Side panel, hidden" })).toBeNull();
  expect(screen.getByText("Ask for a change to orders")).toBeTruthy();
  expect(screen.getByText("The assistant edits the text and the drawing together. While it works, the text is read-only.")).toBeTruthy();
});

test("a_stored_choice_without_the_field_keeps_the_default", async () => {
  const { flowSidePanel: _omit, ...old } = DEFAULT_UI_PREFS;
  flowTab(old);
  await waitFor(() => expect(tab("Editor").getAttribute("aria-selected")).toBe("true"));
});

test("ctrl_b_toggles_the_panel_from_the_tab", async () => {
  const s = flowTab();
  await waitFor(() => expect(s.container.querySelector(".cm-editor")).not.toBeNull());
  const panel = s.container.querySelector('section[aria-label="Side panel"]') as HTMLElement;
  const content = s.container.querySelector(".cm-content") as HTMLElement;
  content.focus();
  fireEvent.keyDown(content, { key: "b", ctrlKey: true });
  // A board's pane hides to nothing: no rail, and the keys go on from the canvas.
  expect(panel.hidden).toBe(true);
  expect(screen.queryByRole("navigation", { name: "Side panel, hidden" })).toBeNull();
  expect(s.container.querySelector(".flow-canvas")!.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "b", ctrlKey: true });
  expect(panel.hidden).toBe(false);
  expect(screen.getByRole("region", { name: "Side panel" })).toBeTruthy();
});

test("editor_keeps_its_text_and_undo", async () => {
  const s = flowTab();
  await waitFor(() => expect(s.container.querySelector(".cm-editor")).not.toBeNull());
  const before = s.view();
  act(() => before.dispatch({ changes: { from: before.state.doc.length, insert: "Queue [icon: aws-sqs]\n" } }));
  const typed = before.state.doc.toString();
  await userEvent.click(tab("Assistant"));
  await userEvent.click(screen.getByRole("button", { name: "Hide the side panel" }));
  fireEvent.keyDown(document.activeElement!, { key: "b", ctrlKey: true });
  await userEvent.click(tab("Editor"));
  expect(s.view()).toBe(before);
  expect(s.view().state.doc.toString()).toBe(typed);
  act(() => {
    undo(s.view());
  });
  expect(s.view().state.doc.toString()).toBe(CLOUD);
});

test("arrow_keys_move_between_the_tabs_and_panels_name_their_tab", async () => {
  render(<Harness />);
  const editorPanel = screen.getByText("the editor").parentElement!;
  const assistantPanel = screen.getByText("the assistant").parentElement!;
  expect(editorPanel.getAttribute("role")).toBe("tabpanel");
  expect(editorPanel.getAttribute("aria-labelledby")).toBe(tab("Editor").id);
  expect(assistantPanel.getAttribute("aria-labelledby")).toBe(tab("Assistant").id);
  expect(tab("Editor").id).not.toBe("");
  expect(tab("Editor").getAttribute("aria-controls")).toBe(editorPanel.id);
  // One tab stop: the selected tab.
  expect(tab("Editor").tabIndex).toBe(0);
  expect(tab("Assistant").tabIndex).toBe(-1);
  tab("Editor").focus();
  fireEvent.keyDown(tab("Editor"), { key: "ArrowRight" });
  expect(tab("Assistant").getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tab("Assistant"));
  // It wraps, and Left goes back.
  fireEvent.keyDown(tab("Assistant"), { key: "ArrowRight" });
  expect(tab("Editor").getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tab("Editor"));
  fireEvent.keyDown(tab("Editor"), { key: "ArrowLeft" });
  expect(tab("Assistant").getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(tab("Assistant"), { key: "ArrowLeft" });
  expect(tab("Editor").getAttribute("aria-selected")).toBe("true");
});
