import { EditorView, showTooltip } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { AiAccess, AiSettings, AiSettingsView } from "../api/types";
import ResultsPanel from "../query/ResultsPanel";
import { EMPTY_RUNNER, runnerReducer } from "../query/runner";
import SqlEditor, { type AskSelection, type SqlEditorApi } from "../query/SqlEditor";
import { KFC_SCHEMA } from "../lang/sql/fixtures";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockReactFlowDom } from "../test/reactFlow";
import { type AskContext, type AskKit, type AskSetup, tablesIn } from "./context";
import InlineAsk from "./InlineAsk";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(() => {
  mockEditorDom();
  mockReactFlowDom();
});

const base: AiSettings = {
  provider: null,
  preset: null,
  baseUrl: "",
  model: "",
  temperature: null,
  maxTokens: null,
  inlineAsk: true,
  errorAsk: true,
  newConnectionAccess: "schema",
};
const view = (s: AiSettings): AiSettingsView => ({ settings: s, groupOverride: false, keySaved: false, keyLast4: null });

beforeEach(() => {
  routeInvoke({
    ai_settings: () => view(base),
    ai_ask: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
  });
});

const conn = (access: AiAccess = "schemaQuery") => ({
  id: "c1",
  name: "KFC shop",
  dialect: "postgres" as const,
  database: "kfc",
  access,
});

const SQL = "SELECT 1;\nSELECT * FROM orders;";

function Place({ inline = true, onOpenInChat = vi.fn(), onOpenSettings = vi.fn() }: Partial<Pick<AskKit, "onOpenInChat" | "onOpenSettings">> & { inline?: boolean }) {
  const editorRef = useRef<SqlEditorApi | null>(null);
  const [sel, setSel] = useState<AskSelection | null>(null);
  return (
    <>
      <SqlEditor
        value={SQL}
        dialect="postgres"
        editorRef={editorRef}
        onChange={() => {}}
        onRun={() => {}}
        onFormat={() => {}}
        onSave={() => {}}
        onEscape={() => false}
        onAsk={setSel}
        askButton={inline}
      />
      {sel && (
        <InlineAsk
          context={{
            kind: "sql",
            connection: conn(),
            sql: sel.sql,
            lines: sel.lines,
            tables: tablesIn(sel.sql, KFC_SCHEMA),
            label: "Query 1",
          }}
          schema={KFC_SCHEMA}
          groupId={null}
          onOpenInChat={onOpenInChat}
          onOpenSettings={onOpenSettings}
          onClose={() => {
            setSel(null);
            editorRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

function editorView(container: HTMLElement) {
  return EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
}
const askTips = (v: EditorView) => v.state.facet(showTooltip).filter((t) => t !== null);

test("selecting_sql_shows_ask_and_ctrl_i_opens_it", async () => {
  const { container } = render(<Place />);
  const v = editorView(container);
  expect(container.querySelector(".ask-btn")).toBeNull();
  act(() => v.dispatch({ selection: { anchor: 3, head: 3 } }));
  expect(container.querySelector(".ask-btn")).toBeNull();

  // The button sits at the end of the selection.
  act(() => v.dispatch({ selection: { anchor: 0, head: 8 } }));
  await waitFor(() => expect(container.querySelector(".ask-btn")).not.toBeNull());
  expect(askTips(v).some((t) => t!.pos === 8)).toBe(true);
  act(() => (container.querySelector(".ask-btn") as HTMLElement).click());
  expect(screen.getByRole("dialog", { name: "Ask AI" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Question" }), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();

  // Ctrl+I with nothing selected asks about the current statement.
  const at = SQL.indexOf("orders");
  act(() => v.dispatch({ selection: { anchor: at } }));
  fireEvent.keyDown(v.contentDOM, { key: "i", ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "Ask AI" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(document.querySelector("pre.payload")!.textContent).toContain("Query (lines 2 to 2):\nSELECT * FROM orders");
});

test("actions_fit_the_place", () => {
  const labels = (kind: AskContext["kind"]) => {
    const { unmount } = render(
      <InlineAsk
        context={{ kind, connection: conn(), sql: "x", tables: [], label: "x" }}
        schema={null}
        groupId={null}
        onOpenSettings={() => {}}
        onClose={() => {}}
      />,
    );
    const names = screen
      .getAllByRole("button")
      .filter((b) => b.classList.contains("act"))
      .map((b) => b.textContent);
    unmount();
    return names;
  };
  expect(labels("sql")).toEqual(["Explain", "Optimize", "Suggest indexes"]);
  expect(labels("error")).toEqual(["Fix this error", "Explain", "Optimize", "Suggest indexes"]);
  expect(labels("filter")[0]).toBe("Write a WHERE for this filter");
  expect(labels("card")).toEqual(["Suggest indexes", "Generate DBML for…", "Explain"]);
});

test("esc_closes_and_focus_returns_to_the_editor", () => {
  const { container } = render(<Place />);
  const v = editorView(container);
  act(() => v.dispatch({ selection: { anchor: 0, head: 8 } }));
  fireEvent.keyDown(v.contentDOM, { key: "i", ctrlKey: true });
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Question" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();
  expect(document.activeElement).toBe(v.contentDOM);
});

test("an_action_asks_and_shows_the_state", async () => {
  const onOpenSettings = vi.fn();
  const user = userEvent.setup();
  render(
    <InlineAsk
      context={{ kind: "sql", connection: conn(), sql: "SELECT * FROM orders", lines: [1, 1], tables: [{ schema: "sales", name: "orders" }], label: "Q" }}
      schema={KFC_SCHEMA}
      groupId={null}
      onOpenSettings={onOpenSettings}
      onClose={() => {}}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Explain" }));
  expect(await screen.findByText("Connect an AI provider in Settings")).toBeTruthy();
  const sent = callsTo("ai_ask")[0].request as { question: string; payload: string };
  expect(sent.question).toBe("Explain");
  expect(sent.payload).toContain("Query (lines 1 to 1):\nSELECT * FROM orders");
  await user.click(screen.getByRole("button", { name: "Connect a provider" }));
  expect(onOpenSettings).toHaveBeenCalled();
});

test("open_in_chat_carries_question_and_context", async () => {
  const onOpenInChat = vi.fn();
  const user = userEvent.setup();
  const context: AskContext = { kind: "sql", connection: conn(), sql: "SELECT 1", lines: [1, 1], tables: [], label: "Q" };
  render(
    <InlineAsk context={context} schema={null} groupId={null} onOpenInChat={onOpenInChat} onOpenSettings={() => {}} onClose={() => {}} />,
  );
  expect((screen.getByRole("button", { name: "Open in chat" }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByRole("textbox", { name: "Question" }), "why is this slow");
  await user.click(screen.getByRole("button", { name: "Open in chat" }));
  expect(onOpenInChat).toHaveBeenCalledWith({ question: "why is this slow", context });
});

function failedPanel(ask?: AskSetup) {
  let s = runnerReducer(EMPTY_RUNNER, { type: "start", stmts: [{ from: 0, to: 15, text: "SELECT id FROM x" }] });
  s = runnerReducer(s, { type: "begin", now: 0 });
  s = runnerReducer(s, { type: "failed", id: s.items[0].id, error: { kind: "query", message: "relation x does not exist" }, ms: 1 });
  const noop = () => {};
  return render(
    <ResultsPanel
      state={s}
      timeoutSecs={null}
      lineAt={() => 1}
      onSelect={noop}
      onPin={noop}
      onCloseUnpinned={noop}
      onFetchMore={noop}
      onCancel={noop}
      onRunAgain={noop}
      onGoTo={noop}
      ask={ask}
    />,
  );
}

const setup = (over: Partial<AskSetup> = {}): AskSetup => ({
  groupId: null,
  inlineAsk: true,
  errorAsk: true,
  onOpenSettings: () => {},
  connection: conn(),
  schema: null,
  ...over,
});

test("inline_ask_respects_the_setting", async () => {
  // inline_ask off: no button on a selection, Ctrl+I still opens it.
  const { container, unmount } = render(<Place inline={false} />);
  const v = editorView(container);
  act(() => v.dispatch({ selection: { anchor: 0, head: 8 } }));
  expect(container.querySelector(".ask-btn")).toBeNull();
  fireEvent.keyDown(v.contentDOM, { key: "i", ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "Ask AI" })).toBeTruthy();
  unmount();

  // error_ask off: no "Ask AI" on a failed query; on: it opens the inline Ask for the error.
  const off = failedPanel(setup({ errorAsk: false }));
  expect(screen.queryByRole("button", { name: "Ask AI" })).toBeNull();
  off.unmount();
  failedPanel(setup());
  await userEvent.setup().click(screen.getByRole("button", { name: "Ask AI" }));
  expect(screen.getByRole("button", { name: "Fix this error" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.getByText(/Error: relation x does not exist/, { selector: "pre" })).toBeTruthy();
});
