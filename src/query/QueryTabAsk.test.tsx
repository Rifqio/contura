import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { AiSettings, AskRequest, ConnectionConfig, SqlBlock } from "../api/types";
import type { AskKit } from "../assistant/context";
import { clearAllSteps, RecordStepContext } from "../assistant/recentSteps";
import { sha256Hex } from "../assistant/sha256";
import { ToastProvider } from "../components/Toast";
import { fakePreview } from "../test/aiPreview";
import { aiStream, delta, done } from "../test/aiStream";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import QueryTab, { type QueryTabDoc } from "./QueryTab";
import type { SqlEditorApi } from "./SqlEditor";

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
  vi.clearAllMocks();
  clearAllSteps();
});
patientFile();

const conn: ConnectionConfig = {
  id: "c1",
  name: "KFC Postgres",
  dialect: "postgres",
  host: "127.0.0.1",
  port: 5432,
  user: "u",
  database: "kfc_shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schemaQuery",
  production: false,
  readOnly: false,
};

const groq: AiSettings = {
  provider: "groq",
  preset: null,
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.3-70b-versatile",
  temperature: null,
  maxTokens: null,
  inlineAsk: true,
  errorAsk: true,
  newConnectionAccess: "schema",
  defaultThinking: "medium",
  promptCaching: true,
  shareThinking: true,
  keepExactText: false,
  pickTables: true,
  modelPrefs: {},
};

const WRITE = /^\s*(UPDATE|INSERT|DELETE)\b/i;

/** Routes a query session and a provider that answers each Ask with what the test emits. */
function routes() {
  const stream = aiStream();
  stream.hold();
  routeInvoke({
    open_query_session: () => "s1",
    close_query_session: () => null,
    list_databases: () => ["kfc_shop"],
    execute_sql: () => ({ outcome: { t: "affected", rows: 1 }, elapsedMs: 2 }),
    classify_sql: ({ sql }) => (WRITE.test(sql as string) ? "write" : "read"),
    prepare_run: ({ statements }) => {
      const planned = (statements as string[]).map((text) => ({ text, class: WRITE.test(text) ? "write" : "read" }));
      const writes = planned.filter((p) => p.class === "write").length;
      return writes === 0 ? { kind: "ok" } : { kind: "needsConfirmation", connection: "KFC Postgres", database: "kfc_shop", statements: planned, writes };
    },
    confirm_run: () => "p1",
    ai_settings: () => ({ settings: groq, groupOverride: false, keySaved: true, keyLast4: null }),
    ai_preview: (a) => fakePreview(a.request as AskRequest),
    ai_ask_stream: stream.handler,
    ai_cancel: () => true,
  });
  return stream;
}

const kit: AskKit = { groupId: null, inlineAsk: true, errorAsk: true, onOpenSettings: () => {}, onOpenInNewTab: vi.fn() };

function setup(text: string, c: ConnectionConfig = conn) {
  const editorRef = { current: null as SqlEditorApi | null };
  const d: QueryTabDoc = { id: "t1", name: "Query 2", text, connectionId: "c1", database: "kfc_shop", savedId: null, savedText: null };
  let current = d;
  const ui = (x: QueryTabDoc) => (
    <RecordStepContext.Provider value="ungrouped">
      <ToastProvider>
        <QueryTab
          tab={x}
          connections={[c]}
          openIds={new Set(["c1"])}
          onChange={(next) => {
            current = next;
          }}
          onSaved={() => {}}
          historyOpen={false}
          onToggleHistory={() => {}}
          editorRef={editorRef}
          ask={kit}
        />
      </ToastProvider>
    </RecordStepContext.Provider>
  );
  const utils = render(ui(d));
  const view = () => EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
  return { ...utils, view, editorRef, rerender: () => utils.rerender(ui(current)) };
}

const check = (body: string, cls: "read" | "write" = "read"): SqlBlock => ({
  fence: 0,
  label: cls === "read" ? "1 statement: 1 read" : "1 statement: 1 write (UPDATE)",
  statements: [{ text: body, class: cls, flags: [] }],
  bodySha256: sha256Hex(body),
});

const ctrlI = (v: EditorView) => fireEvent.keyDown(v.contentDOM, { key: "i", ctrlKey: true });
const box = () => screen.getByRole("dialog", { name: "Ask AI" });
const lines = (sel: string) => Array.from(document.querySelectorAll(sel)).map((l) => l.textContent);
const runButton = () => screen.getByRole("button", { name: /^Run Ctrl\+Enter/ });

async function sessionOpen() {
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  await waitFor(() => expect(runButton().hasAttribute("disabled")).toBe(false));
}

/** Emits an answer with one SQL block into the Ask in flight, and waits until it settles. */
async function answer(stream: ReturnType<typeof aiStream>, n: number, sql: string, cls: "read" | "write" = "read", text = "It reads less.") {
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(n));
  stream.emit(delta(`Use this:\n\`\`\`sql\n${sql}\n\`\`\`\n${text}`), done({ sqlBlocks: [check(sql, cls)] }));
  await within(box()).findByRole("textbox", { name: "Follow-up" });
  await act(async () => {});
}

const DOC = "SELECT 1;\n\nSELECT 9;";

test("ux9_inline_answer_is_a_diff_in_the_editor_run_is_off_and_ctrl_enter_keeps_in_one_undo_step", async () => {
  const stream = routes();
  const user = userEvent.setup();
  const { view } = setup(DOC);
  await sessionOpen();
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  ctrlI(view());
  await user.click(within(box()).getByRole("button", { name: "Optimize" }));
  await answer(stream, 1, "SELECT 2");
  // A2: the diff is in the editor's own lines; the text is unchanged.
  expect(view().state.doc.toString()).toBe(DOC);
  expect(lines(".cm-line.cm-suggest-del")).toEqual(["SELECT 1;"]);
  expect(lines(".cm-suggest-add")).toEqual(["SELECT 2;"]);
  expect(runButton().hasAttribute("disabled")).toBe(true);
  // Ctrl+Enter in the follow-up field keeps; nothing runs.
  fireEvent.keyDown(within(box()).getByRole("textbox", { name: "Follow-up" }), { key: "Enter", ctrlKey: true });
  expect(view().state.doc.toString()).toBe("SELECT 2;\n\nSELECT 9;");
  expect(document.querySelectorAll(".cm-suggest-del, .cm-suggest-add, .cm-suggest-bar").length).toBe(0);
  await waitFor(() => expect(runButton().hasAttribute("disabled")).toBe(false));
  expect(callsTo("prepare_run")).toHaveLength(0);
  expect(callsTo("execute_sql")).toHaveLength(0);
  // One undo step takes the whole suggestion back.
  act(() => void undo(view()));
  expect(view().state.doc.toString()).toBe(DOC);
});

test("ux9_esc_discards_closes_and_ctrl_i_on_the_same_statement_reopens_the_last_answer", async () => {
  const stream = routes();
  const user = userEvent.setup();
  const { view } = setup(DOC);
  await sessionOpen();
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  ctrlI(view());
  await user.click(within(box()).getByRole("button", { name: "Optimize" }));
  await answer(stream, 1, "SELECT 2");
  fireEvent.keyDown(within(box()).getByRole("textbox", { name: "Follow-up" }), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();
  expect(view().state.doc.toString()).toBe(DOC);
  expect(document.querySelectorAll(".cm-suggest-del, .cm-suggest-add").length).toBe(0);
  await waitFor(() => expect(runButton().hasAttribute("disabled")).toBe(false));
  expect(document.activeElement).toBe(view().contentDOM);

  // A4: Ctrl+I on the same statement brings the answer back, asking nothing.
  ctrlI(view());
  expect(within(box()).getByText("Reopened with Ctrl+I: the last answer on this statement.")).toBeTruthy();
  expect(within(box()).getByText("It reads less.")).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(1);
  // Live check: the caret goes to Refine, so typing after Ctrl+I lands in the box, not the SQL.
  expect(document.activeElement).toBe(within(box()).getByRole("textbox", { name: "Follow-up" }));
  // Esc in the editor closes a box with nothing waiting; Ctrl+I brings it back.
  fireEvent.keyDown(view().contentDOM, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();
  expect(view().state.doc.toString()).toBe(DOC);
  ctrlI(view());
  await user.click(within(box()).getByRole("button", { name: "Apply to the statement" }));
  expect(lines(".cm-suggest-add")).toEqual(["SELECT 2;"]);
  // M4: Esc in the editor discards and closes the box too.
  fireEvent.keyDown(view().contentDOM, { key: "Escape" });
  expect(document.querySelectorAll(".cm-suggest-add").length).toBe(0);
  expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();

  // Elsewhere, Ctrl+I asks afresh.
  act(() => view().dispatch({ selection: { anchor: DOC.indexOf("SELECT 9") + 2 } }));
  ctrlI(view());
  expect(within(box()).queryByText(/^Reopened/)).toBeNull();
  expect(within(box()).getByRole("textbox", { name: "Question" })).toBeTruthy();
});

test("ux9_only_the_last_answer_per_tab_is_kept", async () => {
  const stream = routes();
  const user = userEvent.setup();
  const { view } = setup(DOC);
  await sessionOpen();
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  ctrlI(view());
  await user.click(within(box()).getByRole("button", { name: "Optimize" }));
  await answer(stream, 1, "SELECT 2");
  fireEvent.keyDown(box(), { key: "Escape" });
  // A second question on the other statement replaces the first answer.
  act(() => view().dispatch({ selection: { anchor: DOC.indexOf("SELECT 9") + 2 } }));
  ctrlI(view());
  await user.click(within(box()).getByRole("button", { name: "Optimize" }));
  await answer(stream, 2, "SELECT 8");
  fireEvent.keyDown(box(), { key: "Escape" });
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  ctrlI(view());
  expect(within(box()).queryByText(/^Reopened/)).toBeNull();
  expect(document.querySelectorAll(".cm-suggest-del, .cm-suggest-add, .cm-ai-target, .cm-ai-insert-at").length).toBe(0);
});

test("ux9_a_follow_up_updates_the_diff_in_place", async () => {
  const stream = routes();
  const user = userEvent.setup();
  const { view } = setup(DOC);
  await sessionOpen();
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  ctrlI(view());
  await user.click(within(box()).getByRole("button", { name: "Optimize" }));
  await answer(stream, 1, "SELECT 2");
  await user.type(within(box()).getByRole("textbox", { name: "Follow-up" }), "only active{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  stream.emit(delta("```sql\nSELECT 3\n```\nIt reads less."), done({ sqlBlocks: [check("SELECT 3")] }));
  await waitFor(() => expect(lines(".cm-suggest-add")).toEqual(["SELECT 3;"]));
  expect(lines(".cm-line.cm-suggest-del")).toEqual(["SELECT 1;"]);
  expect(view().state.doc.toString()).toBe(DOC);
});

test("ux9_on_production_a_write_goes_in_commented_out_and_running_it_still_asks", async () => {
  const stream = routes();
  const user = userEvent.setup();
  const { view } = setup(DOC, { ...conn, production: true });
  await sessionOpen();
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  ctrlI(view());
  await user.type(within(box()).getByRole("textbox", { name: "Question" }), "mark them late{Enter}");
  await answer(stream, 1, "UPDATE t SET late = true WHERE id = 1", "write");
  expect(lines(".cm-line.cm-suggest-del")).toEqual([]);
  expect(lines(".cm-suggest-add")).toEqual(["", "-- UPDATE t SET late = true WHERE id = 1;"]);
  await user.click(within(box()).getByRole("button", { name: /^Keep, commented out/ }));
  const kept = "SELECT 1;\n\n-- UPDATE t SET late = true WHERE id = 1;\n\nSELECT 9;";
  expect(view().state.doc.toString()).toBe(kept);
  fireEvent.keyDown(box(), { key: "Escape" });
  // Run on the commented line never runs the write: the comment marks keep it out.
  act(() => view().dispatch({ selection: { anchor: kept.indexOf("-- UPDATE") + 4 } }));
  await waitFor(() => expect(runButton().hasAttribute("disabled")).toBe(false));
  fireEvent.keyDown(view().contentDOM, { key: "Enter", ctrlKey: true });
  await act(async () => {});
  const live = (c: Record<string, unknown>) => (c.statements as string[]).some((t) => /^\s*UPDATE/m.test(t));
  expect(callsTo("prepare_run").filter(live)).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Run on KFC Postgres" })).toBeNull();
  // Uncommented, the write asks before it runs (Production).
  await waitFor(() => expect(runButton().hasAttribute("disabled")).toBe(false));
  const at = kept.indexOf("-- UPDATE");
  act(() => view().dispatch({ changes: { from: at, to: at + 3 }, selection: { anchor: at + 2 } }));
  await waitFor(() => expect(screen.getByRole("button", { name: /^Run on Production/ }).hasAttribute("disabled")).toBe(false));
  fireEvent.keyDown(view().contentDOM, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(callsTo("prepare_run").filter(live)).toHaveLength(1));
  expect(await screen.findByRole("button", { name: "Run on KFC Postgres" })).toBeTruthy();
  // The write waits for the dialog: nothing of it has run.
  expect(callsTo("execute_sql").filter((c) => /^\s*UPDATE/m.test(c.sql as string))).toHaveLength(0);
});

// ---- Fix round 1 ----

test("m2_ctrl_i_reopens_after_edits_above_the_statement", async () => {
  const stream = routes();
  const user = userEvent.setup();
  const { view } = setup(DOC);
  await sessionOpen();
  act(() => view().dispatch({ selection: { anchor: DOC.indexOf("SELECT 9") + 2 } }));
  ctrlI(view());
  await user.click(within(box()).getByRole("button", { name: "Optimize" }));
  await answer(stream, 1, "SELECT 8");
  fireEvent.keyDown(box(), { key: "Escape" });
  // A blank line and a comment go in above it.
  act(() => view().dispatch({ changes: { from: 0, insert: "-- notes\n\n" } }));
  act(() => view().dispatch({ selection: { anchor: view().state.doc.toString().indexOf("SELECT 9") + 2 } }));
  ctrlI(view());
  expect(within(box()).getByText("Reopened with Ctrl+I: the last answer on this statement.")).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(1);
});

test("i2_a_follow_up_after_keep_lands_on_the_kept_statement_in_the_real_editor", async () => {
  const stream = routes();
  const user = userEvent.setup();
  const { view } = setup(DOC);
  await sessionOpen();
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  ctrlI(view());
  await user.click(within(box()).getByRole("button", { name: "Optimize" }));
  await answer(stream, 1, "SELECT 2");
  await user.click(within(box()).getByRole("button", { name: /^Keep/ }));
  expect(view().state.doc.toString()).toBe("SELECT 2;\n\nSELECT 9;");
  // Into the other statement, then a follow-up.
  act(() => view().dispatch({ selection: { anchor: view().state.doc.toString().indexOf("SELECT 9") + 2 } }));
  await user.click(within(box()).getByRole("button", { name: "Show answer" }));
  await user.type(within(box()).getByRole("textbox", { name: "Follow-up" }), "only active{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  stream.emit(delta("```sql\nSELECT 3\n```\nIt reads less."), done({ sqlBlocks: [check("SELECT 3")] }));
  await waitFor(() => expect(lines(".cm-suggest-add")).toEqual(["SELECT 3;"]));
  expect(lines(".cm-line.cm-suggest-del")).toEqual(["SELECT 2;"]);
});

// ---- Fix round 1 (I3): the inline box sits in the editor, right under the statement it is about ----

test("i3_the_box_is_in_the_editor_under_its_statement_and_after_the_diff", async () => {
  const stream = routes();
  const user = userEvent.setup();
  const doc3 = "SELECT 1;\n\nSELECT 9\nFROM t;\n\nSELECT 5;";
  const { view } = setup(doc3);
  await sessionOpen();
  act(() => view().dispatch({ selection: { anchor: doc3.indexOf("SELECT 9") + 2 } }));
  ctrlI(view());
  const zone = box().closest(".cm-ask-zone") as HTMLElement;
  expect(zone).toBeTruthy();
  expect(zone.closest(".cm-content")).toBe(view().contentDOM);
  expect(zone.getAttribute("contenteditable")).toBe("false");
  // Right after the statement's last line.
  expect(zone.previousElementSibling?.textContent).toBe("FROM t;");
  // The question field has the keyboard; typing there never reaches the editor.
  const q = within(box()).getByRole("textbox", { name: "Question" });
  expect(document.activeElement).toBe(q);
  await user.type(q, "x");
  expect(view().state.doc.toString()).toBe(doc3);
  await user.clear(q);
  await user.click(within(box()).getByRole("button", { name: "Optimize" }));
  await answer(stream, 1, "SELECT 8");
  // Below the diff, never over it.
  const order = Array.from(view().contentDOM.children).map((c) =>
    c.classList.contains("cm-ask-zone") ? "box" : c.classList.contains("cm-suggest-block") ? "add" : c.classList.contains("cm-suggest-del") ? "del" : "line",
  );
  expect(order.indexOf("box")).toBeGreaterThan(order.lastIndexOf("add"));
  expect(order.lastIndexOf("del")).toBeLessThan(order.indexOf("add"));
  // Ctrl+Enter in the box keeps; Esc closes it, the box leaves the editor and the keyboard goes back to the text.
  fireEvent.keyDown(within(box()).getByRole("textbox", { name: "Follow-up" }), { key: "Enter", ctrlKey: true });
  expect(view().state.doc.toString()).toBe("SELECT 1;\n\nSELECT 8;\n\nSELECT 5;");
  fireEvent.keyDown(box(), { key: "Escape" });
  expect(document.querySelector(".cm-ask-zone")).toBeNull();
  expect(document.activeElement).toBe(view().contentDOM);
});

test("i3_tab_moves_through_the_box_and_never_indents_the_editor", async () => {
  routes();
  const user = userEvent.setup();
  const { view } = setup(DOC);
  await sessionOpen();
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  ctrlI(view());
  expect(document.activeElement).toBe(within(box()).getByRole("textbox", { name: "Question" }));
  await user.tab();
  expect(box().contains(document.activeElement)).toBe(true);
  expect(document.activeElement).toBe(within(box()).getByRole("button", { name: "Explain" }));
  expect(view().state.doc.toString()).toBe(DOC);
});

test("i3_the_box_follows_its_statement_when_lines_go_in_above", async () => {
  routes();
  const { view } = setup(DOC);
  await sessionOpen();
  act(() => view().dispatch({ selection: { anchor: DOC.indexOf("SELECT 9") + 2 } }));
  ctrlI(view());
  act(() => view().dispatch({ changes: { from: 0, insert: "-- a\n-- b\n" } }));
  expect((box().closest(".cm-ask-zone") as HTMLElement).previousElementSibling?.textContent).toBe("SELECT 9;");
});

// ---- Round 2: Ctrl+I follows the same rule as Run ----

test("r2_ctrl_i_on_a_blank_or_comment_line_says_there_is_no_statement_and_opens_nothing", async () => {
  routes();
  const text = "SELECT 1;\n\n-- note\nSELECT 9;";
  const { view } = setup(text);
  await sessionOpen();
  for (const at of [text.indexOf("\n\n") + 1, text.indexOf("-- note") + 2]) {
    act(() => view().dispatch({ selection: { anchor: at } }));
    ctrlI(view());
    expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();
    expect(await screen.findByText("No statement on this line to ask about.")).toBeTruthy();
  }
  // In a statement it opens as before.
  act(() => view().dispatch({ selection: { anchor: text.indexOf("SELECT 9") + 2 } }));
  ctrlI(view());
  expect(box()).toBeTruthy();
});
