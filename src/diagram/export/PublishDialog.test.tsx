import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../../test/invoke";
import PublishDialog from "./PublishDialog";
import type { Scene } from "./scene";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("./png", async (orig) => ({
  ...(await orig<typeof import("./png")>()),
  exportPng: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
}));

const SCENE: Scene = {
  nodes: [
    { id: "a", kind: "table", x: 0, y: 0, w: 216, h: 80, title: "orders", rows: [{ left: "id", right: "int", mark: "pk" }] },
    { id: "b", kind: "table", x: 400, y: 100, w: 216, h: 56, title: "stores", rows: [{ left: "id", right: "int" }] },
    { id: "r", kind: "result", x: 800, y: 0, w: 268, h: 104, title: "Result", rows: [] },
  ],
  edges: [],
};

function setup(selected: string[] = []) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <PublishDialog
      scene={SCENE}
      fileName="shop"
      selected={selected}
      onScreen={{ x: 0, y: 0, w: 500, h: 300 }}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Publish image" });
  const output = () => within(dialog).getByRole("status", { name: "Output" }).textContent;
  return { dialog, output, onClose, onSaved };
}

test("the_header_names_the_file_and_the_presets_change_the_output_size", async () => {
  const { dialog, output } = setup(["b"]);
  expect(within(dialog).getByText("shop")).toBeTruthy();
  // Whole diagram: 1068 x 156 plus 32 px padding on each side, at 2x.
  expect(output()).toContain("2,264 x 440 px");
  await userEvent.click(within(dialog).getByRole("radio", { name: "What's on screen" }));
  expect(output()).toContain("1,128 x 728 px");
  await userEvent.click(within(dialog).getByRole("radio", { name: "Selected nodes" }));
  expect(output()).toContain("560 x 240 px");
  expect(within(dialog).getByText("280 x 120")).toBeTruthy();
});

test("selected_nodes_is_off_with_no_selection", () => {
  const { dialog } = setup([]);
  expect((within(dialog).getByRole("radio", { name: "Selected nodes" }) as HTMLButtonElement).disabled).toBe(true);
});

test("aspect_one_to_one_squares_the_crop", async () => {
  const { dialog, output } = setup();
  await userEvent.click(within(dialog).getByRole("radio", { name: "1:1" }));
  expect(within(dialog).getByText("220 x 220")).toBeTruthy();
  expect(output()).toContain("440 x 440 px");
  expect(within(dialog).getByText("Drag the handles to crop. Hold Shift to keep the shape.")).toBeTruthy();
  expect(dialog.querySelectorAll(".publish-handle")).toHaveLength(8);
});

test("svg_hides_scale_and_the_output_line_reads_png_about_kb", async () => {
  const { dialog, output } = setup();
  expect(output()).toMatch(/PNG, about [\d,]+ KB/);
  expect(within(dialog).getByRole("slider", { name: "Scale" })).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("radio", { name: "SVG" }));
  expect(within(dialog).queryByRole("slider", { name: "Scale" })).toBeNull();
  expect(output()).toMatch(/SVG, about [\d,]+ KB/);
  expect(output()).toContain("1,132 x 220 px");
});

test("save_as_writes_the_png_to_the_chosen_path", async () => {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.save).mockResolvedValue("C:\\m\\shop.png");
  routeInvoke({ write_binary_file: () => null });
  const { dialog: el, onSaved } = setup();
  await userEvent.click(within(el).getByRole("button", { name: /Save as/ }));
  await waitFor(() => expect(callsTo("write_binary_file")).toHaveLength(1));
  expect(vi.mocked(dialog.save).mock.calls.slice(-1)[0][0]).toMatchObject({ defaultPath: "shop.png", filters: [{ extensions: ["png"] }] });
  expect(callsTo("write_binary_file")[0]).toEqual({ path: "C:\\m\\shop.png", base64: "AQID" });
  expect(onSaved).toHaveBeenCalledWith("C:\\m\\shop.png");
});

test("save_as_svg_writes_the_text", async () => {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.save).mockResolvedValue("C:\\m\\shop.svg");
  routeInvoke({ write_text_file: () => null });
  const { dialog: el } = setup();
  await userEvent.click(within(el).getByRole("radio", { name: "SVG" }));
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(() => expect(callsTo("write_text_file")).toHaveLength(1));
  expect(vi.mocked(dialog.save).mock.calls.slice(-1)[0][0]).toMatchObject({ defaultPath: "shop.svg" });
  expect(String(callsTo("write_text_file")[0].text)).toMatch(/^<svg/);
});

test("the_note_follows_the_theme", async () => {
  const { dialog } = setup();
  expect(within(dialog).getByText("Uses Light theme colours. Hover and selection are left out.")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("radio", { name: "Dark" }));
  expect(within(dialog).getByText("Uses Dark theme colours. Hover and selection are left out.")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("radio", { name: "Transparent" }));
  expect((within(dialog).getByRole("radio", { name: "Transparent" }) as HTMLInputElement).checked).toBe(true);
});

test("padding_and_mark_change_the_output", async () => {
  const { dialog, output } = setup();
  const padding = within(dialog).getByRole("slider", { name: "Padding" }) as HTMLInputElement;
  expect(within(dialog).getByText("32 px")).toBeTruthy();
  fireEvent.change(padding, { target: { value: "0" } });
  expect(within(dialog).getByText("0 px")).toBeTruthy();
  expect(output()).toContain("2,136 x 312 px");
  expect((within(dialog).getByRole("switch", { name: "Made with Contura mark" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
});

test("no_hex_literal_in_the_rendered_styles", () => {
  const { dialog } = setup(["a"]);
  const styled = [dialog, ...dialog.querySelectorAll<HTMLElement>("[style]")].map((el) => el.getAttribute("style") ?? "");
  expect(styled.join(" ")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});

test("escape_closes", async () => {
  const { onClose } = setup();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalled();
});
