import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import { LangClient } from "../lang/client";
import { KFC_MODEL, KFC_TEXT } from "../lang/dbml/fixtures";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import tauriConf from "../../src-tauri/tauri.conf.json?raw";
import { svgImageUrl } from "./exportPng";
import { exportSvg } from "./exportSvg";
import { CARD_WIDTH } from "./layout";
import SchemaBuilder, { type ModelDoc } from "./SchemaBuilder";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

beforeAll(mockReactFlowDom);

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
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
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
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("write_model_files")).toHaveLength(1));
  const layout = JSON.parse(callsTo("write_model_files")[0].layout as string);
  expect(layout.tables).toEqual({ "public.shops": { x: 7, y: 8 }, "public.orders": { x: 320, y: 0 } });
});

test("close_with_changes_asks_to_save", async () => {
  const { onClose } = setup(doc({ savedDbml: "" }));
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByText("Save changes to shop?")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Don't save" }));
  expect(onClose).toHaveBeenCalled();
});

test("apply_is_disabled_with_hint", () => {
  setup(doc());
  const apply = screen.getByRole("button", { name: "Apply to Connection" }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  expect(screen.getByText("Arrives with Schema Compare")).toBeTruthy();
});

test("export_during_error_uses_last_valid_with_note", async () => {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.save).mockResolvedValue("C:\\m\\shop.sql");
  routeInvoke({ export_sql: () => "CREATE TABLE x ();", write_text_file: () => null });
  const { view } = setup(doc());
  await waitFor(() => expect(screen.queryByText(/Parsing/)).toBeNull());
  const broken = KFC_TEXT.replace("Table orders {", "Table orders ");
  act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: broken } }));
  await screen.findByText(/The canvas shows the last valid version/);
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
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
  expect(svg.match(/<path /g)).toHaveLength(1);
  expect(svg).not.toContain("foreignObject");
  expect(svg).not.toContain("http://fonts");
});
