import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LOAD_TIMEOUT, patient } from "../test/load";
import { beforeAll, expect, test, vi } from "vitest";
import { LangClient } from "../lang/client";
import { KFC_MODEL, KFC_TEXT } from "../lang/dbml/fixtures";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockEditorDom } from "../test/editor";
import { mockReactFlowDom } from "../test/reactFlow";
import tauriConf from "../../src-tauri/tauri.conf.json?raw";
import { svgImageUrl } from "./exportPng";
import { exportPalette } from "./exportPalette";
import { exportSvg } from "./exportSvg";
import { CARD_WIDTH } from "./layout";
import SchemaBuilder, { type ModelDoc } from "./SchemaBuilder";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});

const doc = (over: Partial<ModelDoc> = {}): ModelDoc => ({
  path: "C:\\m\\shop.dbml",
  dbml: KFC_TEXT,
  savedDbml: KFC_TEXT,
  layout: { version: 1, tables: {} },
  dialect: "postgres",
  source: "file",
  connectionId: null,
  ...over,
});

function setup(d: ModelDoc) {
  const onClose = vi.fn();
  const utils = render(<SchemaBuilder doc={d} onClose={onClose} client={new LangClient(() => fakeWorker())} />);
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  return { ...utils, onClose, view };
}

test("save_without_path_asks_where", async () => {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.save).mockResolvedValue("C:\\m\\new.dbml");
  routeInvoke({ write_model_files: () => null });
  setup(doc({ path: null, savedDbml: "", source: "connection" }));
  await userEvent.click(screen.getByRole("button", { name: "DBML options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Save" }));
  await waitFor(() => expect(callsTo("write_model_files")).toHaveLength(1));
  expect(vi.mocked(dialog.save).mock.calls[0][0]).toMatchObject({ filters: [{ name: "DBML", extensions: ["dbml"] }] });
  expect(callsTo("write_model_files")[0]).toMatchObject({ path: "C:\\m\\new.dbml", dbml: KFC_TEXT });
  expect(await screen.findByText("Saved new.dbml")).toBeTruthy();
});

test("ctrl_s_saves_and_clears_changed_lines", async () => {
  routeInvoke({ write_model_files: () => null });
  const { container, view } = setup(doc({ savedDbml: "" }));
  expect(container.querySelectorAll(".cm-changed-marker").length).toBeGreaterThan(0);
  fireEvent.keyDown(view().contentDOM, { key: "s", ctrlKey: true });
  await waitFor(() => expect(callsTo("write_model_files")).toHaveLength(1));
  await waitFor(() => expect(container.querySelectorAll(".cm-changed-marker")).toHaveLength(0));
});

test("renaming_a_table_on_its_card_keeps_its_saved_position", async () => {
  routeInvoke({ write_model_files: () => null });
  setup(doc({ layout: { version: 1, tables: { "public.stores": { x: 7, y: 8 }, "public.orders": { x: 320, y: 0 } } } }));
  const stores = await screen.findByRole("group", { name: "Table stores" });
  // fireEvent: a userEvent mousedown has no view in jsdom, which d3-drag reads.
  fireEvent.doubleClick(within(stores).getByRole("button", { name: "Table name stores" }));
  await userEvent.type(within(stores).getByRole("textbox", { name: "Table name stores" }), "{Control>}a{/Control}shops{Enter}");
  await screen.findByRole("group", { name: "Table shops" });
  await userEvent.click(screen.getByRole("button", { name: "DBML options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Save" }));
  await waitFor(() => expect(callsTo("write_model_files")).toHaveLength(1));
  const layout = JSON.parse(callsTo("write_model_files")[0].layout as string);
  expect(layout.tables).toEqual({ "public.shops": { x: 7, y: 8 }, "public.orders": { x: 320, y: 0 } });
});

test("close_with_changes_asks_to_save", async () => {
  const onClose = vi.fn();
  const closeRef = { current: null as (() => void) | null };
  render(<SchemaBuilder doc={doc({ savedDbml: "" })} onClose={onClose} closeRef={closeRef} client={new LangClient(() => fakeWorker())} />);
  act(() => closeRef.current!());
  expect(screen.getByText("Save changes to shop?")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Don't save" }));
  expect(onClose).toHaveBeenCalled();
});

test("apply_is_disabled_with_hint", async () => {
  setup(doc());
  const apply = (await screen.findByRole("button", { name: "Apply to Connection..." })) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  expect(apply.closest("[title]")?.getAttribute("title")).toBe("Arrives with Schema Compare");
});

test("dbml_and_canvas_are_two_islands", async () => {
  const { container } = setup(doc());
  await screen.findByRole("group", { name: "Table stores" });
  const islands = container.querySelectorAll(".schema-island");
  expect(islands).toHaveLength(2);
  expect(islands[0].querySelector(".cm-editor")).not.toBeNull();
  expect(islands[1].querySelector(".canvas-flow")).not.toBeNull();
  expect(container.querySelector(".schema-toolbar")).toBeNull();
});

test("dbml_pane_header_and_problems_footer", async () => {
  const { container, view } = setup(doc());
  await screen.findByRole("group", { name: "Table stores" });
  const head = container.querySelector(".schema-pane-head") as HTMLElement;
  expect(within(head).getByText("DBML")).toBeTruthy();
  expect(within(head).getByText("PostgreSQL")).toBeTruthy();
  expect(within(head).getByText("Saved")).toBeTruthy();
  const foot = container.querySelector(".schema-pane-foot") as HTMLElement;
  expect(within(foot).getByText("No problems")).toBeTruthy();
  expect(foot.querySelector(".icon")).not.toBeNull();
  expect(within(foot).getByText("2 tables, 1 ref")).toBeTruthy();
  await userEvent.click(within(head).getByRole("button", { name: "DBML options" }));
  const names = within(screen.getByRole("menu", { name: "DBML options" }))
    .getAllByRole("menuitem")
    .map((m) => m.getAttribute("aria-label"));
  expect(names).toEqual(["Save", "Save as...", "Export", "Hide DBML"]);
  await userEvent.keyboard("{Escape}");
  act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: KFC_TEXT.replace("Table orders {", "Table orders ") } }));
  await within(head).findByText("Unsaved");
  await within(foot).findByText(/^\d+ problems?$/);
  await userEvent.click(within(head).getByRole("button", { name: "DBML options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Hide DBML" }));
  expect(container.querySelectorAll(".schema-island:not([hidden])")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Show DBML" }));
  expect(container.querySelectorAll(".schema-island:not([hidden])")).toHaveLength(2);
});

test(
  "canvas_toolbar_matches_the_design",
  patient(async () => {
    const { container } = setup(doc());
    await screen.findByRole("group", { name: "Table stores" });
    const bar = container.querySelector(".canvas-toolbar") as HTMLElement;
    const buttons = within(bar).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Select", "Add table", "Arrange", "Publish", "Apply to Connection..."]);
    expect(within(bar).getByRole("button", { name: "Select" }).getAttribute("aria-pressed")).toBe("true");
    expect((within(bar).getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(bar).getByRole("button", { name: "Apply to Connection..." }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(container.querySelector('.react-flow__node[data-id="public.orders"]')!, { key: "Enter" });
    await within(bar).findByText("orders selected");
    await waitFor(() => expect(container.querySelectorAll(".cm-line.cm-block-band").length).toBeGreaterThan(0));
  }),
  LOAD_TIMEOUT,
);

test("export_during_error_uses_last_valid_with_note", async () => {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.save).mockResolvedValue("C:\\m\\shop.sql");
  routeInvoke({ export_sql: () => "CREATE TABLE x ();", write_text_file: () => null });
  const { view } = setup(doc());
  await waitFor(() => expect(screen.queryByText(/Parsing/)).toBeNull());
  const broken = KFC_TEXT.replace("Table orders {", "Table orders ");
  act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: broken } }));
  await screen.findByText(/The canvas shows the last valid version/);
  await userEvent.click(screen.getByRole("button", { name: "DBML options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Export" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "SQL script" }));
  expect(screen.getByText("The DBML has an error, so this export uses the last valid version.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(callsTo("write_text_file")).toHaveLength(1));
  expect(callsTo("export_sql")[0]).toEqual({ model: KFC_MODEL });
  expect(callsTo("write_text_file")[0]).toEqual({ path: "C:\\m\\shop.sql", text: "CREATE TABLE x ();" });
});

test("svg_export_frames_every_card_at_its_own_size", () => {
  const svg = exportSvg(KFC_MODEL, { version: 1, tables: { "public.stores": { x: -200, y: -50 }, "public.orders": { x: 400, y: 0 } } });
  const attr = (n: string) => new RegExp(`<svg[^>]* ${n}="([^"]+)"`).exec(svg)![1];
  const [vx, vy, vw, vh] = attr("viewBox").split(" ").map(Number);
  expect(Number(attr("width"))).toBe(vw);
  expect(Number(attr("height"))).toBe(vh);
  expect(vx).toBeLessThanOrEqual(-200);
  expect(vy).toBeLessThanOrEqual(-50);
  expect(vx + vw).toBeGreaterThanOrEqual(400 + CARD_WIDTH);
});

test("png_export_loads_the_svg_from_a_source_the_csp_allows", () => {
  const conf = JSON.parse(tauriConf);
  const imgSrc: string[] = /img-src ([^;]+)/.exec(conf.app.security.csp)![1].trim().split(/\s+/);
  const scheme = svgImageUrl("<svg/>").split(":")[0] + ":";
  expect(imgSrc).toContain(scheme);
});

test("svg_export_has_cards_and_refs_without_foreign_object", () => {
  const svg = exportSvg(KFC_MODEL, { version: 1, tables: { "public.stores": { x: 0, y: 0 }, "public.orders": { x: 400, y: 0 } } });
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).toContain(">stores<");
  expect(svg).toContain(">orders<");
  expect(svg).toContain(">varchar(80)<");
  expect(svg.match(/<g data-edge=/g)).toHaveLength(1);
  expect(svg).not.toContain("foreignObject");
  expect(svg).not.toContain("http://fonts");
});

test("svg_export_has_no_literal_colours", () => {
  const node = { fill: "#050505", stroke: "#040404" };
  const palette = {
    surface: "#010101",
    canvas: "#080808",
    text: "#020202",
    subtle: "#030303",
    border: "#070707",
    type: "#060606",
    keyword: "#090909",
    nodes: { table: node, view: node, derived: node, result: node },
  };
  const svg = exportSvg(
    KFC_MODEL,
    { version: 1, tables: { "public.stores": { x: 0, y: 0 }, "public.orders": { x: 400, y: 0 } } },
    palette,
  );
  const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]).filter((c) => c !== "none");
  expect(colours.length).toBeGreaterThan(0);
  const allowed = new Set([...Object.values(palette).filter((v) => typeof v === "string"), node.fill, node.stroke]);
  expect(colours.filter((c) => !allowed.has(c))).toEqual([]);
});

test("export_palette_reads_the_light_tokens_from_a_hidden_theme_light_element", () => {
  const style = document.createElement("style");
  style.textContent =
    ".theme-light{--c-bg-surface:#111111;--c-bg-canvas:#888888;--c-text:#222222;--c-text-subtle:#333333;--c-node-table-stroke:#444444;--c-node-table-fill:#555555;--c-syn-type:#666666;--c-border:#777777;--c-syn-keyword:#999999}";
  document.head.appendChild(style);
  expect(exportPalette()).toMatchObject({
    surface: "#111111",
    canvas: "#888888",
    text: "#222222",
    subtle: "#333333",
    type: "#666666",
    border: "#777777",
    keyword: "#999999",
    nodes: { table: { stroke: "#444444", fill: "#555555" } },
  });
  expect(document.querySelector(".theme-light")).toBeNull();
  style.remove();
});

test(
  "publish_opens_the_publish_image_dialog",
  patient(async () => {
    const { container } = setup(doc());
    await screen.findByRole("group", { name: "Table stores" });
    const bar = container.querySelector(".canvas-toolbar") as HTMLElement;
    await userEvent.click(within(bar).getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish image" });
    expect(within(dialog).getByText("shop")).toBeTruthy();
    expect(within(dialog).getByRole("status", { name: "Output" }).textContent).toMatch(/PNG, about/);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish image" })).toBeNull());
  }),
  LOAD_TIMEOUT,
);
