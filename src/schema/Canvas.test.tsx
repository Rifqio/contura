import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import { routeInvoke } from "../test/invoke";
import type { AskContext, AskKit } from "../assistant/context";
import { mockReactFlowDom } from "../test/reactFlow";
import { applyEdits, renameColumn, renameTable } from "../lang/dbml/edits";
import { KFC_MODEL, KFC_TEXT } from "../lang/dbml/fixtures";
import { parseDbml } from "../lang/dbml/parse";
import { type Ranges, type TextEdit, tableKey } from "../lang/protocol";
import Canvas, { edgeSides, edgesFor, refFromConnection } from "./Canvas";
import { sourceConnectionFor } from "./sourceConnection";
import { autoLayout, followRenames, parseLayout, serializeLayout } from "./layout";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(mockReactFlowDom);

type Make = (text: string, ranges: Ranges) => TextEdit[];

function renderCanvas(blocked = false, ask?: { getDbml(): string; label: string; kit: AskKit; connection?: AskContext["connection"] }) {
  const onEdit = vi.fn<(make: Make) => void>();
  const onLayout = vi.fn();
  const layout = { version: 1 as const, tables: { "public.stores": { x: 0, y: 0 }, "public.orders": { x: 320, y: 0 } } };
  render(
    <div style={{ width: 800, height: 600 }}>
      <Canvas
        model={KFC_MODEL}
        layout={layout}
        blocked={blocked}
        errorAt={blocked ? { line: 7, message: "Expect a closing brace '}'" } : undefined}
        onLayout={onLayout}
        onEdit={onEdit}
        onGoToError={() => {}}
        ask={ask}
      />
    </div>,
  );
  return { onEdit, onLayout };
}

test("layout_round_trips_and_bad_json_is_empty", () => {
  const l = { version: 1 as const, tables: { "b.t": { x: 1, y: 2 }, "a.t": { x: 3, y: 4 } } };
  const json = serializeLayout(l);
  expect(json.indexOf('"a.t"')).toBeLessThan(json.indexOf('"b.t"'));
  expect(parseLayout(json)).toEqual(l);
  expect(parseLayout("not json")).toEqual({ version: 1, tables: {} });
  expect(parseLayout('{"version":2}')).toEqual({ version: 1, tables: {} });
});

test("a_renamed_table_keeps_its_position", () => {
  const parsed = parseDbml(KFC_TEXT, "postgres");
  const before = parsed.model!;
  const renamed = applyEdits(KFC_TEXT, renameTable(KFC_TEXT, parsed.ranges, "public.stores", "shops"));
  const after = parseDbml(renamed, "postgres").model!;
  const l = { version: 1 as const, tables: { "public.stores": { x: 7, y: 8 }, "public.orders": { x: 320, y: 0 } } };
  expect(followRenames(l, before, after).tables).toEqual({ "public.shops": { x: 7, y: 8 }, "public.orders": { x: 320, y: 0 } });
  // Adding a table is not a rename.
  const added = parseDbml(`${KFC_TEXT}\nTable extra {\n  id integer\n}\n`, "postgres").model!;
  expect(followRenames(l, before, added)).toBe(l);
});

test("auto_layout_places_only_new_tables", async () => {
  const existing = { version: 1 as const, tables: { "public.stores": { x: 500, y: 500 } } };
  const l = await autoLayout(KFC_MODEL, existing);
  expect(l.tables["public.stores"]).toEqual({ x: 500, y: 500 });
  expect(l.tables["public.orders"]).toBeDefined();
});

test("add_table_places_the_new_card_in_view", async () => {
  const { onEdit, onLayout } = renderCanvas();
  await userEvent.click(screen.getByRole("button", { name: "Add table" }));
  expect(onEdit).toHaveBeenCalledTimes(1);
  const l = onLayout.mock.lastCall?.[0];
  expect(l.tables["public.stores"]).toEqual({ x: 0, y: 0 });
  expect(l.tables["public.new_table"]).toEqual({ x: expect.any(Number), y: expect.any(Number) });
});

test("a_card_drags_by_its_name_but_not_by_its_edit_box", async () => {
  renderCanvas();
  const stores = screen.getByRole("group", { name: "Table stores" });
  const name = within(stores).getByRole("button", { name: "Table name stores" });
  expect(name.closest(".nodrag")).toBeNull();
  // fireEvent: a userEvent mousedown has no view in jsdom, which d3-drag reads.
  fireEvent.doubleClick(name);
  expect(within(stores).getByRole("textbox", { name: "Table name stores" }).classList.contains("nodrag")).toBe(true);
});

test("cards_show_key_link_and_nullable_marks_without_text_badges", () => {
  renderCanvas();
  const stores = screen.getByRole("group", { name: "Table stores" });
  expect(within(stores).getByText("varchar(80)")).toBeTruthy();
  // The header: name, schema and column count.
  expect(within(stores).getByText("public")).toBeTruthy();
  expect(within(stores).getByText("4")).toBeTruthy();
  // One key icon on the primary key, no PK / FK / NN / UQ text.
  expect(stores.querySelectorAll(".table-card-key .icon")).toHaveLength(1);
  for (const t of ["PK", "FK", "NN", "UQ"]) expect(within(stores).queryByText(t)).toBeNull();
  expect(stores.querySelector(".badge")).toBeNull();
  // kind and opened_at are nullable.
  expect(stores.querySelectorAll(".table-card-nullable")).toHaveLength(2);
  expect(within(stores).getAllByText("?")).toHaveLength(2);
  const orders = screen.getByRole("group", { name: "Table orders" });
  // store_id is a Foreign Key: a link icon in its row.
  const row = within(orders).getByRole("button", { name: "Column store_id" }).closest("li")!;
  expect(row.querySelector(".table-card-key .icon")).not.toBeNull();
  expect(within(orders).queryByText("FK")).toBeNull();
});

test("edges_use_crows_foot_markers", () => {
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <Canvas
        model={KFC_MODEL}
        layout={{ version: 1, tables: { "public.stores": { x: 0, y: 0 }, "public.orders": { x: 320, y: 0 } } }}
        blocked={false}
        onLayout={() => {}}
        onEdit={() => {}}
        onGoToError={() => {}}
      />
    </div>,
  );
  expect(container.querySelector("marker#crow-many")).not.toBeNull();
  expect(container.querySelector("marker#bar-one")).not.toBeNull();
  // React Flow draws an edge only once it has measured both cards' handles, which jsdom cannot; check what it is given.
  const [edge] = edgesFor(KFC_MODEL);
  expect(edge).toMatchObject({ type: "smoothstep", pathOptions: { borderRadius: 8 }, markerStart: "crow-many", markerEnd: "bar-one", source: "public.orders", target: "public.stores" });
});

test("edge_sides_face_the_other_card", () => {
  // Source left of target: out on the right, in on the left.
  expect(edgeSides(0, 300, 216)).toEqual({ source: "right", target: "left" });
  // Source right of target (orders.customer_id to customers on its left): out on the left, in on the right.
  expect(edgeSides(300, 0, 216)).toEqual({ source: "left", target: "right" });
  // One above the other: both on the right.
  expect(edgeSides(0, 100, 216)).toEqual({ source: "right", target: "right" });
});

test("edges_use_the_handles_on_the_facing_sides", () => {
  // KFC_MODEL's first Ref: public.orders (many) to public.stores (one).
  const at = (pos: Record<string, number>) => edgesFor(KFC_MODEL, (k) => pos[k])[0];
  expect(at({ "public.orders": 320, "public.stores": 0 })).toMatchObject({ sourceHandle: expect.stringMatching(/:sl$/), targetHandle: expect.stringMatching(/:tr$/) });
  expect(at({ "public.orders": 0, "public.stores": 320 })).toMatchObject({ sourceHandle: expect.stringMatching(/:s$/), targetHandle: expect.stringMatching(/:t$/) });
});

test("cards_have_no_add_column_row_and_the_menu_adds_one", async () => {
  const { onEdit } = renderCanvas();
  const stores = screen.getByRole("group", { name: "Table stores" });
  expect(within(stores).queryByRole("button", { name: "Add column" })).toBeNull();
  await userEvent.click(within(stores).getByRole("button", { name: "Table actions" }));
  expect(screen.queryByRole("menuitem", { name: "Ask AI" })).toBeNull();
  await userEvent.click(screen.getByRole("menuitem", { name: "Add column" }));
  expect(onEdit).toHaveBeenCalledTimes(1);
});

test("zoom_shows_percent_and_a_minimap_without_attribution", async () => {
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <Canvas
        model={KFC_MODEL}
        layout={{ version: 1, tables: { "public.stores": { x: 0, y: 0 }, "public.orders": { x: 320, y: 0 } } }}
        blocked={false}
        onLayout={() => {}}
        onEdit={() => {}}
        onGoToError={() => {}}
      />
    </div>,
  );
  const zoom = screen.getByRole("group", { name: "Zoom" });
  expect(within(zoom).getByRole("button", { name: "Zoom out" })).toBeTruthy();
  expect(within(zoom).getByRole("button", { name: "Zoom in" })).toBeTruthy();
  expect(within(zoom).getByRole("button", { name: "Fit to view" })).toBeTruthy();
  expect(within(zoom).getByText(/^\d+%$/)).toBeTruthy();
  expect(container.querySelector(".react-flow__minimap")).not.toBeNull();
  expect(container.querySelector(".react-flow__attribution")).toBeNull();
  expect(container.querySelector(".react-flow__controls")).toBeNull();
});

test("selected_card_has_the_outline_and_four_handles", async () => {
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <Canvas
        model={KFC_MODEL}
        layout={{ version: 1, tables: { "public.stores": { x: 0, y: 0 }, "public.orders": { x: 320, y: 0 } } }}
        blocked={false}
        onLayout={() => {}}
        onEdit={() => {}}
        onGoToError={() => {}}
      />
    </div>,
  );
  expect(container.querySelector(".selbox")).toBeNull();
  const node = container.querySelector('.react-flow__node[data-id="public.orders"]') as HTMLElement;
  fireEvent.keyDown(node, { key: "Enter" });
  await waitFor(() => expect(container.querySelectorAll(".selbox")).toHaveLength(1));
  expect(container.querySelectorAll(".selbox i")).toHaveLength(4);
  expect(node.contains(container.querySelector(".selbox"))).toBe(true);
  expect(screen.getByText("orders selected")).toBeTruthy();
});

test("renaming_column_on_card_calls_onEdit", async () => {
  const { onEdit } = renderCanvas();
  const stores = screen.getByRole("group", { name: "Table stores" });
  // fireEvent: a userEvent mousedown has no view in jsdom, which d3-drag reads.
  fireEvent.doubleClick(within(stores).getByRole("button", { name: "Column name" }));
  const input = within(stores).getByRole("textbox", { name: "Column name" });
  await userEvent.clear(input);
  await userEvent.type(input, "label{Enter}");
  expect(onEdit).toHaveBeenCalledTimes(1);
  const { ranges } = parseDbml(KFC_TEXT, "postgres");
  const edits = onEdit.mock.calls[0][0](KFC_TEXT, ranges);
  expect(edits).toEqual(renameColumn(KFC_TEXT, ranges, "public.stores", "name", "label"));
  expect(applyEdits(KFC_TEXT, edits)).toContain("  label varchar(80)");
});

test("blocked_canvas_disables_edits_and_shows_banner", async () => {
  const { onEdit } = renderCanvas(true);
  expect(
    screen.getByText("The DBML has an error on line 7: Expect a closing brace '}'. The canvas shows the last valid version."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Go to error" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add table" }) as HTMLButtonElement).disabled).toBe(true);
  const stores = screen.getByRole("group", { name: "Table stores" });
  // fireEvent: a userEvent mousedown has no view in jsdom, which d3-drag reads.
  fireEvent.doubleClick(within(stores).getByRole("button", { name: "Column name" }));
  expect(within(stores).queryByRole("textbox")).toBeNull();
  expect(onEdit).not.toHaveBeenCalled();
});

test("connecting_columns_adds_ref_and_warns_for_plain_target", () => {
  const ok = refFromConnection(KFC_MODEL, {
    source: "public.orders",
    sourceHandle: "line:s",
    target: "public.stores",
    targetHandle: "id:t",
  });
  expect(ok?.from).toEqual({ schema: "public", table: "orders", columns: ["line"] });
  expect(ok?.to).toEqual({ schema: "public", table: "stores", columns: ["id"] });
  expect(ok?.warning).toBeNull();
  const plain = refFromConnection(KFC_MODEL, {
    source: "public.orders",
    sourceHandle: "line:s",
    target: "public.stores",
    targetHandle: "kind:t",
  });
  expect(plain?.warning).toBe("stores.kind is not a key, unique or indexed. The database may refuse this Foreign Key.");
});

test("ask_ai_opens_the_inline_ask_for_the_card", async () => {
  routeInvoke({
    ai_settings: () => ({
      settings: { provider: null, preset: null, baseUrl: "", model: "", temperature: null, maxTokens: null, inlineAsk: true, errorAsk: true },
      groupOverride: false,
      keySaved: false,
      keyLast4: null,
    }),
    ai_ask: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
  });
  const onOpenSettings = vi.fn();
  renderCanvas(false, { getDbml: () => KFC_TEXT, label: "shop.dbml", kit: { groupId: null, inlineAsk: true, errorAsk: true, onOpenSettings } });
  const stores = screen.getByRole("group", { name: "Table stores" });
  await userEvent.click(within(stores).getByRole("button", { name: "Table actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ask AI" }));
  expect(screen.getByRole("button", { name: "Generate DBML for…" })).toBeTruthy();
  // The whole model is sent, so the pill counts the model's tables, not the card's.
  expect(screen.getByRole("button", { name: `DBML · ${KFC_MODEL.tables.length} tables` })).toBeTruthy();
  expect(KFC_MODEL.tables.length).toBeGreaterThan(1);
  await userEvent.click(screen.getByRole("button", { name: "Explain" }));
  expect(await screen.findByText("Connect an AI provider in Settings")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Connect a provider" }));
  expect(onOpenSettings).toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Ask AI" }), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();
});

const KIT: AskKit = { groupId: null, inlineAsk: true, errorAsk: true, onOpenSettings: () => {} };

const sent: string[] = [];

async function openCardAsk(connection?: AskContext["connection"]) {
  sent.length = 0;
  routeInvoke({
    ai_ask: (args: unknown) => {
      sent.push(JSON.stringify(args));
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    ai_settings: () => ({
      settings: { provider: null, preset: null, baseUrl: "", model: "", temperature: null, maxTokens: null, inlineAsk: true, errorAsk: true },
      groupOverride: false,
      keySaved: false,
      keyLast4: null,
    }),
  });
  renderCanvas(false, { getDbml: () => KFC_TEXT, label: "shop.dbml", kit: KIT, connection });
  const stores = screen.getByRole("group", { name: "Table stores" });
  await userEvent.click(within(stores).getByRole("button", { name: "Table actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ask AI" }));
}

test("card_ask_from_never_connection_sends_no_dbml", async () => {
  await openCardAsk({ id: "c1", name: "KFC shop", dialect: "postgres", database: "shop", access: "never" });
  expect(screen.queryByRole("button", { name: /^DBML/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Explain" }));
  await screen.findByText("Connect an AI provider in Settings");
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toContain("CREATE");
  expect(sent[0]).not.toContain("stores");
});

test("card_ask_without_source_still_sends_dbml", async () => {
  await openCardAsk(undefined);
  expect(screen.getByRole("button", { name: `DBML · ${KFC_MODEL.tables.length} tables` }).getAttribute("aria-disabled")).toBeNull();
});

test("card_ask_with_deleted_source_connection_sends_no_dbml", async () => {
  await openCardAsk(sourceConnectionFor("gone", "postgres", []));
  expect(screen.queryByRole("button", { name: /^DBML/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Explain" }));
  await screen.findByText("Connect an AI provider in Settings");
  expect(sent[0]).not.toContain("stores");
});

test("card_ask_follows_live_access_changes", async () => {
  routeInvoke({
    ai_settings: () => ({
      settings: { provider: null, preset: null, baseUrl: "", model: "", temperature: null, maxTokens: null, inlineAsk: true, errorAsk: true },
      groupOverride: false,
      keySaved: false,
      keyLast4: null,
    }),
  });
  const layout = { version: 1 as const, tables: { "public.stores": { x: 0, y: 0 }, "public.orders": { x: 320, y: 0 } } };
  const view = (access: NonNullable<AskContext["connection"]>["access"]) => (
    <div style={{ width: 800, height: 600 }}>
      <Canvas
        model={KFC_MODEL}
        layout={layout}
        blocked={false}
        onLayout={() => {}}
        onEdit={() => {}}
        onGoToError={() => {}}
        ask={{
          getDbml: () => KFC_TEXT,
          label: "shop.dbml",
          kit: KIT,
          connection: { id: "c1", name: "KFC shop", dialect: "postgres", database: null, access },
        }}
      />
    </div>
  );
  const pill = { name: `DBML · ${KFC_MODEL.tables.length} tables` };
  const { rerender } = render(view("never"));
  const stores = () => screen.getByRole("group", { name: "Table stores" });
  await userEvent.click(within(stores()).getByRole("button", { name: "Table actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ask AI" }));
  expect(screen.queryByRole("button", pill)).toBeNull();
  rerender(view("schema"));
  expect(await screen.findByRole("button", pill)).toBeTruthy();
  rerender(view("never"));
  await waitFor(() => expect(screen.queryByRole("button", pill)).toBeNull());
});

test("a_card_has_no_ask_ai_without_the_setting", async () => {
  renderCanvas();
  const stores = screen.getByRole("group", { name: "Table stores" });
  await userEvent.click(within(stores).getByRole("button", { name: "Table actions" }));
  expect(screen.queryByRole("menuitem", { name: "Ask AI" })).toBeNull();
});

test("arrange_falls_back_to_the_in_process_layout_when_the_worker_fails", async () => {
  const onLayout = vi.fn();
  const runLayout = vi.fn(() => Promise.reject(new Error("worker gone")));
  const layout = { version: 1 as const, tables: { "public.stores": { x: 0, y: 0 }, "public.orders": { x: 320, y: 0 } } };
  render(
    <div style={{ width: 800, height: 600 }}>
      <Canvas model={KFC_MODEL} layout={layout} blocked={false} onLayout={onLayout} onEdit={() => {}} onGoToError={() => {}} runLayout={runLayout} />
    </div>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Arrange" }));
  await waitFor(() => expect(onLayout).toHaveBeenCalledTimes(1));
  expect(runLayout).toHaveBeenCalledTimes(1);
  const placed = onLayout.mock.calls[0][0].tables;
  expect(Object.keys(placed).sort()).toEqual(KFC_MODEL.tables.map(tableKey).sort());
});
