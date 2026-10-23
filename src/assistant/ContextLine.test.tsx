import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import type { AiSettings, AiSettingsView, AskRequest, ContextInfo, SchemaCheck } from "../api/types";
import { fakePreview } from "../test/aiPreview";
import { patientFile } from "../test/load";
import { callsTo, routeInvoke } from "../test/invoke";
import { modelList } from "../test/settingsRoutes";
import AssistantPanel from "./AssistantPanel";
import { SENDS_OPEN_KEY, saveSendsOpen } from "./sendsFold";
import ContextLine from "./ContextLine";
import { contextLineText, contextNotice, contextTip, ctxName, sendsAge } from "./contextText";
import type { AskContext } from "./context";

patientFile();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

const NOW = new Date(2026, 9, 20, 11, 42, 0).getTime();
const MIN = 60_000;
const DAY = 86_400_000;

const info = (over: Partial<ContextInfo> = {}): ContextInfo => ({
  connectionId: "c1",
  database: "freight",
  schema: "public",
  sync: "automatic",
  builtAt: NOW - 3 * MIN,
  tableCount: 6,
  stale: false,
  check: { kind: "unchecked" },
  ...over,
});
const stg = { name: "freight-stg", access: "schemaQuery" as const };
const prod = { name: "freight-prod", access: "never" as const };

test("hidden_when_fresh", () => {
  for (const check of [{ kind: "match" }, { kind: "recent" }, { kind: "unchecked" }, { kind: "rebuilt", reason: "first" }] as SchemaCheck[]) {
    expect(contextLineText(info({ check }), stg, NOW)).toBeNull();
  }
  expect(contextLineText(null, stg, NOW)).toBeNull();
  expect(contextLineText(null, null, NOW)).toBeNull();
  const { container } = render(<ContextLine info={info({ check: { kind: "match" } })} connection={stg} onResync={vi.fn()} busy={false} />);
  expect(container.firstChild).toBeNull();
});

test("stale_line_with_resync", async () => {
  const user = userEvent.setup();
  const stale = info({ stale: true, check: { kind: "stale" }, sync: "manual" });
  expect(contextLineText(stale, stg, NOW)).toEqual({
    tone: "warn",
    icon: "alert",
    text: "Context: freight-stg · the schema changed since the last sync",
    resync: true,
  });
  // Marked stale but not checked yet (the preview never checks) reads the same.
  expect(contextLineText(info({ stale: true }), stg, NOW)?.text).toBe("Context: freight-stg · the schema changed since the last sync");
  const onResync = vi.fn();
  const { rerender } = render(<ContextLine info={stale} connection={stg} onResync={onResync} busy={false} />);
  const line = document.querySelector(".ctxalert")!;
  expect(line.classList.contains("warnline")).toBe(true);
  expect(line.textContent).toContain("Context: freight-stg · the schema changed since the last sync");
  await user.click(screen.getByRole("button", { name: "Re-sync" }));
  expect(onResync).toHaveBeenCalledTimes(1);
  rerender(<ContextLine info={stale} connection={stg} onResync={onResync} busy />);
  expect(screen.queryByRole("button", { name: "Re-sync" })).toBeNull();
  expect(screen.getByText("Re-syncing...")).toBeTruthy();
  rerender(<ContextLine info={stale} connection={stg} onResync={onResync} busy={false} error="Open the Connection to re-sync." />);
  expect(screen.getByText("Open the Connection to re-sync.")).toBeTruthy();
});

test("never_line_without_resync", () => {
  expect(contextLineText(null, prod, NOW)).toEqual({
    tone: "plain",
    icon: "lock",
    text: "This Connection sends nothing. The assistant sees only your question.",
    resync: false,
  });
  render(<ContextLine info={null} connection={prod} onResync={vi.fn()} busy={false} />);
  const line = document.querySelector(".ctxalert")!;
  expect(line.classList.contains("warnline")).toBe(false);
  expect(line.textContent).toBe("This Connection sends nothing. The assistant sees only your question.");
  expect(screen.queryByRole("button", { name: "Re-sync" })).toBeNull();
});

test("context_texts_per_state", () => {
  expect(contextTip(info(), stg, NOW)).toBe("Context: freight-stg, 6 tables, synced 3m ago. It re-syncs on its own when the schema changes.");
  expect(contextTip(info({ sync: "manual", builtAt: NOW - 2 * DAY }), stg, NOW)).toBe(
    "Context: freight-stg, 6 tables, synced 2d ago. It re-syncs only when you press Re-sync.",
  );
  expect(contextTip(info({ tableCount: 1, builtAt: NOW - 10_000 }), stg, NOW)).toBe(
    "Context: freight-stg, 1 table, synced just now. It re-syncs on its own when the schema changes.",
  );
  expect(contextTip(info({ tableCount: 2000 }), stg, NOW)).toContain("2,000 tables");
  expect(contextTip(info({ stale: true, check: { kind: "stale" } }), stg, NOW)).toBe(
    "The schema changed since the last sync. Re-sync to refresh the context.",
  );
  expect(contextTip(null, prod, NOW)).toBe("AI access on freight-prod is Never: only your question is sent.");
  // The preview builds a missing Context, so the tip does not promise the next Ask.
  expect(contextTip(info({ builtAt: null, tableCount: 0, check: { kind: "missing" } }), stg, NOW)).toBe(
    "Context: freight-stg, not built yet.",
  );
  // A failed check never reads fresh, however recent the Context.
  expect(contextTip(info({ check: { kind: "failed" }, builtAt: NOW - 10_000 }), stg, NOW)).toBe(
    "Context: freight-stg, 6 tables. The schema could not be checked, so the last context is used.",
  );
  expect(contextTip(null, stg, NOW)).toBeNull();
  expect(contextTip(info(), null, NOW)).toBeNull();

  expect(sendsAge(info({ stale: true, check: { kind: "stale" }, builtAt: NOW - 2 * DAY }), NOW)).toBe("Context from 2d ago");
  expect(sendsAge(info({ check: { kind: "failed" }, builtAt: NOW - 12 * MIN }), NOW)).toBe("Context from 12m ago");
  expect(sendsAge(info({ check: { kind: "failed" }, builtAt: NOW - 10_000 }), NOW)).toBe("Context not checked");
  expect(sendsAge(info({ stale: true, builtAt: NOW - 10_000 }), NOW)).toBe("Context from just now");
  expect(sendsAge(info({ check: { kind: "match" } }), NOW)).toBeNull();
  expect(sendsAge(null, NOW)).toBeNull();

  const built = new Date(2026, 9, 20, 9, 12).getTime();
  expect(contextNotice(info({ check: { kind: "failed" }, builtAt: built }))).toBe("Could not check the schema. Using the context from 09:12.");
  expect(contextNotice(info({ check: { kind: "match" } }))).toBeNull();
  expect(contextNotice(null)).toBeNull();
});

// ---- Through the panel: the failed check, then Re-sync (Review Focus 4) ----

const none: AiSettings = {
  provider: null,
  preset: null,
  baseUrl: "",
  model: "",
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
const view: AiSettingsView = { settings: none, groupOverride: false, keySaved: false, keyLast4: null };
const ctx: AskContext = {
  kind: "sql",
  connection: { id: "c1", name: "freight-stg", dialect: "postgres", database: "freight", access: "schemaQuery" },
  sql: "SELECT 1",
  lines: [1, 1],
  tables: [{ schema: "public", name: "orders" }],
  label: "Selected SQL",
};

let check: SchemaCheck = { kind: "failed" };
let resync: () => ContextInfo = () => info({ check: { kind: "rebuilt", reason: "asked" } });

beforeEach(() => {
  check = { kind: "failed" };
  resync = () => {
    check = { kind: "match" };
    return info({ check: { kind: "rebuilt", reason: "asked" } });
  };
  routeInvoke({
    ai_settings: () => view,
    ai_known_models: () => modelList([]),
    list_ai_threads: () => [],
    ai_preview: (a) => ({ ...fakePreview(a.request as AskRequest), context: info({ check }) }),
    ai_resync: () => resync(),
  });
});

test("failed_check_note_and_resync", async () => {
  const user = userEvent.setup();
  render(<AssistantPanel place="ungrouped" groupId={null} context={ctx} schema={null} onOpenSettings={vi.fn()} openIds={new Set(["c1"])} />);
  expect(await screen.findByText("Context: freight-stg · could not check the schema")).toBeTruthy();
  expect(document.querySelector(".ctxalert.warnline")).toBeTruthy();
  const before = callsTo("ai_preview").length;
  await user.click(screen.getByRole("button", { name: "Re-sync" }));
  await waitFor(() => expect(callsTo("ai_resync")).toEqual([{ connectionId: "c1", database: "freight", schema: "public" }]));
  // A new preview is asked for, and the line goes once it says match.
  await waitFor(() => expect(callsTo("ai_preview").length).toBeGreaterThan(before));
  await waitFor(() => expect(document.querySelector(".ctxalert")).toBeNull());
});

test("resync_on_a_closed_connection_says_open_it", async () => {
  const user = userEvent.setup();
  resync = () => info({ check: { kind: "failed" } });
  render(<AssistantPanel place="ungrouped" groupId={null} context={ctx} schema={null} onOpenSettings={vi.fn()} openIds={new Set()} />);
  await user.click(await screen.findByRole("button", { name: "Re-sync" }));
  expect(await screen.findByText("Open the Connection to re-sync.")).toBeTruthy();
});

test("resync_uses_the_schema_the_ask_uses", async () => {
  const user = userEvent.setup();
  const billing: AskContext = { ...ctx, tables: [{ schema: "billing", name: "invoices" }] };
  render(<AssistantPanel place="ungrouped" groupId={null} context={billing} schema={null} onOpenSettings={vi.fn()} openIds={new Set(["c1"])} />);
  await user.click(await screen.findByRole("button", { name: "Re-sync" }));
  await waitFor(() => expect(callsTo("ai_resync")).toEqual([{ connectionId: "c1", database: "freight", schema: "billing" }]));
  // The Ask asks for the same schema.
  expect((callsTo("ai_preview")[0].request as AskRequest).schema).toBe("billing");
});

test("context_texts_name_a_schema_other_than_public", () => {
  expect(ctxName(stg, info())).toBe("freight-stg");
  expect(ctxName(stg, info({ schema: "" }))).toBe("freight-stg");
  expect(ctxName(stg, info({ schema: "billing" }))).toBe("freight-stg.billing");
  const billing = (over: Partial<ContextInfo> = {}) => info({ schema: "billing", ...over });
  expect(contextLineText(billing({ check: { kind: "failed" } }), stg, NOW)?.text).toBe("Context: freight-stg.billing · could not check the schema");
  expect(contextLineText(billing({ builtAt: null, check: { kind: "missing" } }), stg, NOW)?.text).toBe(
    "Context: freight-stg.billing · could not read the schema",
  );
  expect(contextLineText(billing({ stale: true }), stg, NOW)?.text).toBe("Context: freight-stg.billing · the schema changed since the last sync");
  expect(contextTip(billing(), stg, NOW)).toBe(
    "Context: freight-stg.billing, 6 tables, synced 3m ago. It re-syncs on its own when the schema changes.",
  );
  expect(contextTip(billing({ builtAt: null, tableCount: 0, check: { kind: "missing" } }), stg, NOW)).toBe(
    "Context: freight-stg.billing, not built yet.",
  );
  expect(contextTip(billing({ check: { kind: "failed" } }), stg, NOW)).toBe(
    "Context: freight-stg.billing, 6 tables. The schema could not be checked, so the last context is used.",
  );
  // Public reads as the Connection alone, as before.
  expect(contextLineText(info({ check: { kind: "failed" } }), stg, NOW)?.text).toBe("Context: freight-stg · could not check the schema");
});

test("missing_context_line_offers_resync", () => {
  expect(contextLineText(info({ builtAt: null, tableCount: 0, check: { kind: "missing" } }), stg, NOW)).toEqual({
    tone: "warn",
    icon: "alert",
    text: "Context: freight-stg · could not read the schema",
    resync: true,
  });
});

test("resync_that_builds_nothing_says_so", async () => {
  const user = userEvent.setup();
  resync = () => {
    check = { kind: "missing" };
    return info({ builtAt: null, tableCount: 0, check: { kind: "missing" } });
  };
  routeInvoke({
    ai_settings: () => view,
    ai_known_models: () => modelList([]),
    list_ai_threads: () => [],
    ai_preview: (a) => ({
      ...fakePreview(a.request as AskRequest),
      context: check.kind === "missing" ? info({ builtAt: null, tableCount: 0, check }) : info({ check }),
    }),
    ai_resync: () => resync(),
  });
  render(<AssistantPanel place="ungrouped" groupId={null} context={ctx} schema={null} onOpenSettings={vi.fn()} openIds={new Set(["c1"])} />);
  await user.click(await screen.findByRole("button", { name: "Re-sync" }));
  // The new preview says missing too; the line stays and says why.
  await waitFor(() => expect(callsTo("ai_preview").length).toBeGreaterThan(1));
  await waitFor(() => expect(screen.getByText("Could not build the AI context.")).toBeTruthy());
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByText("Could not build the AI context.")).toBeTruthy();
});

test("ages_move_on_while_the_panel_is_open", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.setSystemTime(NOW);
    check = { kind: "stale" };
    render(<AssistantPanel place="ungrouped" groupId={null} context={ctx} schema={null} onOpenSettings={vi.fn()} />);
    expect(await screen.findByText("Context from 3m ago")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(2 * MIN);
    });
    expect(screen.getByText("Context from 5m ago")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test("resync_error_shows_in_the_line", async () => {
  const user = userEvent.setup();
  resync = () => {
    throw { kind: "invalidInput", message: "AI access is Never for this Connection." };
  };
  render(<AssistantPanel place="ungrouped" groupId={null} context={ctx} schema={null} onOpenSettings={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Re-sync" }));
  expect(await screen.findByText("AI access is Never for this Connection.")).toBeTruthy();
});

test("parity_P11_10_a_manual_context_shows_its_line_with_resync", async () => {
  const user = userEvent.setup();
  const manual = info({ sync: "manual", builtAt: NOW - 3 * MIN });
  expect(contextLineText(manual, stg, NOW)).toEqual({
    tone: "plain",
    icon: "database",
    text: "Context: freight-stg · 6 tables · synced 3m ago",
    resync: true,
  });
  expect(contextLineText(info({ sync: "manual", builtAt: null }), stg, NOW)?.text).toBe("Context: freight-stg · not built yet");
  // An automatic Context that is fresh stays quiet.
  expect(contextLineText(info({ sync: "automatic" }), stg, NOW)).toBeNull();
  const onResync = vi.fn();
  render(<ContextLine info={manual} connection={stg} onResync={onResync} busy={false} now={NOW} />);
  expect(screen.getByRole("status").textContent).toContain("Context: freight-stg · 6 tables · synced 3m ago");
  await user.click(screen.getByRole("button", { name: "Re-sync" }));
  expect(onResync).toHaveBeenCalledTimes(1);
});

test("parity_P11_10_the_panel_offers_resync_beside_a_manual_context", async () => {
  const user = userEvent.setup();
  routeInvoke({
    ai_settings: () => view,
    ai_known_models: () => modelList([]),
    list_ai_threads: () => [],
    ai_preview: (a) => ({ ...fakePreview(a.request as AskRequest), context: info({ sync: "manual", check: { kind: "match" } }) }),
    ai_resync: () => info({ sync: "manual", check: { kind: "rebuilt", reason: "asked" } }),
  });
  // The tip sits under the Sends rows, which start folded.
  saveSendsOpen(true);
  onTestFinished(() => localStorage.removeItem(SENDS_OPEN_KEY));
  render(<AssistantPanel place="ungrouped" groupId={null} context={ctx} schema={null} onOpenSettings={vi.fn()} openIds={new Set(["c1"])} />);
  // The tip says to press Re-sync, and the button is on the Context line.
  expect(await screen.findByText(/It re-syncs only when you press Re-sync\./)).toBeTruthy();
  await user.click(await screen.findByRole("button", { name: "Re-sync" }));
  await waitFor(() => expect(callsTo("ai_resync")).toEqual([{ connectionId: "c1", database: "freight", schema: "public" }]));
});
