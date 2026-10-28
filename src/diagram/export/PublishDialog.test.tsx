import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../../test/invoke";
import PublishDialog from "./PublishDialog";
import type { Scene } from "./scene";
import { sceneSource } from "./source";

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

test("dragging_a_handle_snaps_to_a_node_edge_and_alt_drags_freely", () => {
  const { dialog } = setup();
  const handle = dialog.querySelector(".publish-handle-e") as HTMLElement;
  const preview = dialog.querySelector(".publish-preview") as HTMLElement;
  // The preview shows the 1132 x 220 frame at 472 / 1132 px per unit; 187 px left puts the right edge 3.5 units
  // past the stores card's right edge (616), within the 8 px reach.
  const k = 472 / 1132;
  const dx = -Math.round((1068 - 619.5) * k);
  fireEvent.pointerDown(handle, { clientX: 500, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(preview, { clientX: 500 + dx, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(preview, { pointerId: 1 });
  expect(within(dialog).getByText("680 x 220")).toBeTruthy();
  // Alt turns snapping off.
  fireEvent.pointerDown(handle, { clientX: 500, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(preview, { clientX: 500 + 2, clientY: 100, pointerId: 1, altKey: true });
  fireEvent.pointerUp(preview, { pointerId: 1 });
  expect(within(dialog).queryByText("680 x 220")).toBeNull();
  expect(within(dialog).getByText("685 x 220")).toBeTruthy();
});

test("selected_nodes_is_off_when_no_selected_node_is_in_the_scene", () => {
  // A node selected in the text but not yet placed is not drawn, so it is not in the scene.
  const { dialog } = setup(["not-placed"]);
  expect((within(dialog).getByRole("radio", { name: "Selected nodes" }) as HTMLButtonElement).disabled).toBe(true);
});

// ---- B4 Task 5: sizes past the limits, notes and off reasons on the diagram source (Decisions 10 and 14). ----

/** Two tables `width` apart edge to edge: the whole diagram is `width` by 80. */
function wide(width: number): Scene {
  return {
    nodes: [
      { id: "a", kind: "table", x: 0, y: 0, w: 100, h: 80, title: "orders", rows: [] },
      { id: "b", kind: "table", x: width - 100, y: 0, w: 100, h: 80, title: "stores", rows: [] },
    ],
    edges: [],
  };
}

function setupScene(scene: Scene, selected: string[] = []) {
  const { unmount } = render(<PublishDialog scene={scene} fileName="big" selected={selected} onScreen={{ x: 0, y: 0, w: 500, h: 300 }} onClose={vi.fn()} onSaved={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Publish image" });
  const note = () => dialog.querySelector(".publish-note") as HTMLElement;
  const radio = (name: string) => within(dialog).getByRole("radio", { name }) as HTMLButtonElement;
  return { dialog, note, radio, unmount };
}

test("past_the_png_limit_the_scale_steps_down_and_png_turns_off", async () => {
  const png = await import("./png");
  const tauri = await import("@tauri-apps/plugin-dialog");
  vi.mocked(png.exportPng).mockClear();
  vi.mocked(tauri.save).mockResolvedValue("C:\\m\\big.png");
  routeInvoke({ write_binary_file: () => null });
  // 9,000 px wide: 9,064 with padding, so 2x passes 16,384 px and the scale is limited to 1x.
  const first = setupScene(wide(9000));
  const slider = within(first.dialog).getByRole("slider", { name: "Scale" }) as HTMLInputElement;
  expect(slider.max).toBe("1");
  expect(slider.value).toBe("1");
  expect(first.note().textContent).toBe("Scale is limited to 1x for this drawing.");
  await userEvent.click(within(first.dialog).getByRole("button", { name: /Save as/ }));
  await waitFor(() => expect(callsTo("write_binary_file").length).toBeGreaterThan(0));
  expect(vi.mocked(png.exportPng).mock.calls.slice(-1)[0][1]).toBe(1);
  first.unmount();

  // 17,000 px wide: even 1x passes, so PNG is off and SVG chosen.
  const second = setupScene(wide(17000));
  expect(second.radio("PNG").disabled).toBe(true);
  expect(second.radio("SVG").getAttribute("aria-checked")).toBe("true");
  expect(within(second.dialog).queryByRole("slider", { name: "Scale" })).toBeNull();
  expect(second.note().textContent).toBe("This drawing is too large for PNG. Save as SVG, or publish the selected nodes.");
  // A crop under the limit turns PNG back on; the format stays SVG as left.
  const handle = second.dialog.querySelector(".publish-handle-e") as HTMLElement;
  const preview = second.dialog.querySelector(".publish-preview") as HTMLElement;
  fireEvent.pointerDown(handle, { clientX: 500, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(preview, { clientX: 100, clientY: 100, pointerId: 1, altKey: true });
  fireEvent.pointerUp(preview, { pointerId: 1 });
  expect(second.radio("PNG").disabled).toBe(false);
  expect(second.radio("SVG").getAttribute("aria-checked")).toBe("true");
  await userEvent.click(second.radio("PNG"));
  // The scale was never raised on its own: it stays at the 2x the dialog opened with.
  expect((within(second.dialog).getByRole("slider", { name: "Scale" }) as HTMLInputElement).value).toBe("2");
});

test("copy_never_rasterises_past_the_limit", async () => {
  const png = await import("./png");
  const write = vi.fn(async () => {});
  const writeText = vi.fn(async () => {});
  class Item {
    constructor(public items: Record<string, unknown>) {}
  }
  vi.stubGlobal("ClipboardItem", Item);
  Object.defineProperty(navigator, "clipboard", { value: { write, writeText }, configurable: true });
  try {
    // Positive control: under the limit Copy rasterises once at the chosen scale.
    vi.mocked(png.exportPng).mockClear();
    const small = setupScene(SCENE);
    await userEvent.click(within(small.dialog).getByRole("button", { name: /Copy/ }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(vi.mocked(png.exportPng)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(png.exportPng).mock.calls[0][1]).toBe(2);
    small.unmount();

    // Past the limit: no rasterising at all; the SVG text is copied.
    vi.mocked(png.exportPng).mockClear();
    const big = setupScene(wide(17000));
    await userEvent.click(within(big.dialog).getByRole("button", { name: /Copy/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(vi.mocked(png.exportPng)).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a_diagram_past_the_limits_never_says_frame", () => {
  // The Schema Builder's scene: tables only.
  const notes = sceneSource(wide(9000), [], { x: 0, y: 0, w: 1, h: 1 }).notes;
  const all = [notes.partLabel, ...Object.values(notes.offReason), notes.scaleLimited(1), notes.scaleLimited(2), notes.pngOff, notes.tooLarge, notes.leftOut ?? ""];
  for (const s of all) expect(s).not.toMatch(/frame/i);
  const first = setupScene(wide(9000));
  expect(first.note().textContent).not.toMatch(/frame/i);
  expect(first.note().textContent).toContain("1x");
  first.unmount();
  const second = setupScene(wide(17000));
  expect(second.note().textContent).toContain("too large");
  expect(second.note().textContent).not.toMatch(/frame/i);
});

test("selected_nodes_off_gives_its_reason", () => {
  const { dialog, radio } = setupScene(SCENE, []);
  const off = radio("Selected nodes");
  expect(off.disabled).toBe(true);
  expect(off.getAttribute("title")).toBe("Select nodes to publish them.");
  const group = within(dialog).getByRole("radiogroup", { name: "Part of the diagram" });
  const ids = (group.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.map((id) => document.getElementById(id)?.textContent).join(" ")).toContain("Select nodes to publish them.");
});

test("an_error_in_the_note_keeps_its_alert", async () => {
  const tauri = await import("@tauri-apps/plugin-dialog");
  vi.mocked(tauri.save).mockRejectedValueOnce(new Error("the disk is full"));
  const { dialog, note } = setupScene(SCENE);
  expect(note().getAttribute("role")).toBe("status");
  await userEvent.click(within(dialog).getByRole("button", { name: /Save as/ }));
  await waitFor(() => expect(within(note()).getByRole("alert").textContent).toBe("the disk is full"));
  expect(note().getAttribute("role")).toBe("status");
});

test("copied_clears_on_any_option_change", async () => {
  const write = vi.fn(async () => {});
  const writeText = vi.fn(async () => {});
  class Item {
    constructor(public items: Record<string, unknown>) {}
  }
  vi.stubGlobal("ClipboardItem", Item);
  Object.defineProperty(navigator, "clipboard", { value: { write, writeText }, configurable: true });
  try {
    const { dialog, note } = setupScene(SCENE);
    const copied = async () => {
      await userEvent.click(within(dialog).getByRole("button", { name: /Copy/ }));
      await waitFor(() => expect(note().textContent).toBe("Copied the image."));
    };
    const changes: [string, () => void | Promise<void>][] = [
      ["padding", () => void fireEvent.change(within(dialog).getByRole("slider", { name: "Padding" }), { target: { value: "8" } })],
      ["scale", () => void fireEvent.change(within(dialog).getByRole("slider", { name: "Scale" }), { target: { value: "1" } })],
      ["mark", () => userEvent.click(within(dialog).getByRole("switch", { name: "Made with Contura mark" }))],
      ["background", () => userEvent.click(within(dialog).getByRole("radio", { name: "Transparent" }))],
      ["aspect", () => userEvent.click(within(dialog).getByRole("radio", { name: "16:9" }))],
      [
        "crop",
        () => {
          const handle = dialog.querySelector(".publish-handle-e") as HTMLElement;
          const preview = dialog.querySelector(".publish-preview") as HTMLElement;
          fireEvent.pointerDown(handle, { clientX: 400, clientY: 100, pointerId: 1 });
          fireEvent.pointerMove(preview, { clientX: 360, clientY: 100, pointerId: 1, altKey: true });
          fireEvent.pointerUp(preview, { pointerId: 1 });
        },
      ],
    ];
    for (const [name, change] of changes) {
      await copied();
      await change();
      expect(note().textContent, name).not.toBe("Copied the image.");
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
