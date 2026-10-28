// B4 Task 5: the Publish dialog on a board source (Decisions 1, 2, 5, 10, 12 and 14; R13, R18). The source comes from
// `boardSource` over a hand-built input, wrapped here so its `draw` calls and each drawing's `svg` calls are counted.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import limitsSource from "../../../diagram/export/limits.ts?raw";
import type { ExportPalette, ExportTheme } from "../../../diagram/export/palette";
import PublishDialog from "../../../diagram/export/PublishDialog";
import publishDialogSource from "../../../diagram/export/PublishDialog.tsx?raw";
import type { PublishDrawn, PublishSource } from "../../../diagram/export/source";
import sourceSource from "../../../diagram/export/source.ts?raw";
import type { SvgOptions } from "../../../diagram/export/svg";
import { parseFlow } from "../../../lang/flow/parse";
import { emptyPositions } from "../../layout";
import type { Sketch } from "../boardLayout";
import type { BoardPart, BoardPublishInput, PublishFrame } from "./boardPublish";
import { boardSource, composeHooks } from "./boardSvg";
import boardSvgSource from "./boardSvg.ts?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

afterEach(() => {
  composeHooks.onCompose = undefined;
  composeHooks.maxBytes = undefined;
});

/** A frame of `text` at `at`, its nodes at `nodes` (frame units), its box 600 by 400. */
function placed(index: number, text: string, nodes: Record<string, { x: number; y: number }>, at: { x: number; y: number }, live = false): PublishFrame {
  const d = parseFlow(text).doc!;
  return {
    key: d.title,
    index,
    title: d.title,
    kind: d.kind,
    at,
    box: { x: at.x, y: at.y, w: 600, h: 400 },
    doc: d,
    layout: { version: 1, nodes: Object.assign(emptyPositions(), nodes), style: "modern", direction: "TB" },
    textScale: 1,
    notation: "crow",
    live,
  };
}

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const ORDERS = 'diagram er "Orders"\norders {\n  id int pk\n}\n';
const NOTE: Sketch = { id: "n1", kind: "note", x: 1800, y: 500, w: 160, h: 80, text: "Ship it" };
const BOX: Sketch = { id: "r1", kind: "rect", x: -200, y: -200, w: 80, h: 60 };

function input(over: Partial<BoardPublishInput> & { live?: boolean } = {}): BoardPublishInput {
  const { live = false, ...rest } = over;
  const frames = [placed(0, CHECKOUT, { Cart: { x: 40, y: 40 }, Pay: { x: 40, y: 200 } }, { x: 0, y: 0 }, live), placed(1, ORDERS, { orders: { x: 40, y: 40 } }, { x: 1000, y: 0 })];
  return {
    frames,
    nothingDrawn: 0,
    clashing: 0,
    sketches: [BOX, NOTE],
    iconTitles: new Map(),
    frameIndex: live ? 0 : null,
    shapes: [],
    sketchIds: [],
    onScreen: { x: 0, y: 0, w: 800, h: 600 },
    ...rest,
  };
}

/** The source wrapped so its draws and each drawing's `svg` calls are counted; the last SVG drawn is kept. */
function counted(src: PublishSource) {
  const c = { draw: 0, svg: 0, parts: [] as string[], last: "" };
  const source: PublishSource = {
    ...src,
    draw(part: string, palette: ExportPalette, titles: boolean): PublishDrawn {
      c.draw++;
      c.parts.push(part);
      const d = src.draw(part, palette, titles);
      return {
        ...d,
        svg: (o: SvgOptions) => {
          c.svg++;
          c.last = d.svg(o);
          return c.last;
        },
      };
    },
  };
  return { c, source };
}

function open(src: PublishSource, onTheme?: (t: ExportTheme) => void) {
  const onClose = vi.fn();
  const r = render(<PublishDialog source={src} fileName="board" onClose={onClose} onSaved={vi.fn()} onTheme={onTheme} />);
  const dialog = screen.getByRole("dialog", { name: "Publish image" });
  const radio = (name: string) => within(dialog).getByRole("radio", { name }) as HTMLButtonElement;
  const note = () => (dialog.querySelector(".publish-note") as HTMLElement).textContent;
  const output = () => within(dialog).getByRole("status", { name: "Output" }).textContent;
  const titlesSwitch = () => within(dialog).queryByRole("switch", { name: "Frame titles" });
  return { ...r, dialog, radio, note, output, titlesSwitch, onClose };
}

const source = (i: BoardPublishInput, initial?: BoardPart, theme: ExportTheme = "light") => boardSource(i, new Map(), theme, initial);

test("the_parts_read_part_of_the_board", () => {
  const { dialog } = open(source(input({ live: true })));
  const group = within(dialog).getByRole("radiogroup", { name: "Part of the board" });
  expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Whole board", "Selected frame", "Selection", "What's on screen"]);
});

test("nothing_selected_opens_on_whole_board", () => {
  const { radio } = open(source(input()));
  expect(radio("Whole board").getAttribute("aria-checked")).toBe("true");
});

test("a_selected_sketch_opens_on_selection", () => {
  const { radio } = open(source(input({ sketchIds: ["n1"] })));
  expect(radio("Selection").getAttribute("aria-checked")).toBe("true");
});

test("off_parts_give_their_reasons", () => {
  const { dialog, radio, unmount } = open(source(input()));
  expect(radio("Selected frame").disabled).toBe(true);
  expect(radio("Selected frame").getAttribute("title")).toBe("Select a frame to publish it.");
  expect(radio("Selection").disabled).toBe(true);
  expect(radio("Selection").getAttribute("title")).toBe("Select shapes or sketches to publish them.");
  expect(radio("Whole board").hasAttribute("title")).toBe(false);
  const group = within(dialog).getByRole("radiogroup", { name: "Part of the board" });
  const ids = (group.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  const said = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  expect(said).toContain("Select a frame to publish it.");
  expect(said).toContain("Select shapes or sketches to publish them.");
  unmount();
  // A selection of names no longer drawn is off too: it would publish an empty picture.
  const stale = open(source(input({ live: true, shapes: ["Gone"] })));
  expect(stale.radio("Selection").disabled).toBe(true);
});

test("frame_titles_switch_hides_the_chrome", async () => {
  const { c, source: src } = counted(source(input()));
  const { titlesSwitch } = open(src);
  expect(titlesSwitch()!.getAttribute("aria-checked")).toBe("true");
  expect(c.last).toContain("data-frame-tab");
  expect(c.last).toContain("data-frame-box");
  await userEvent.click(titlesSwitch()!);
  expect(titlesSwitch()!.getAttribute("aria-checked")).toBe("false");
  expect(c.last).toContain("data-board-frame");
  expect(c.last).not.toContain("data-frame-tab");
  expect(c.last).not.toContain("data-frame-box");
});

test("the_switch_shows_only_when_the_part_holds_a_frame", async () => {
  // The note sketch alone, far from every frame.
  const { titlesSwitch, radio } = open(source(input({ sketchIds: ["n1"] }), "board"));
  expect(titlesSwitch()).not.toBeNull();
  await userEvent.click(radio("Selection"));
  expect(titlesSwitch()).toBeNull();
});

test("left_out_frames_are_counted_in_the_note", () => {
  const one = open(source(input({ nothingDrawn: 1 })));
  expect(one.note()).toBe("1 frame with nothing drawn yet is left out.");
  one.unmount();
  const clash = open(source(input({ clashing: 1 })));
  expect(clash.note()).toBe("1 frame with a repeated title is left out.");
  clash.unmount();
  const many = open(source(input({ nothingDrawn: 2, clashing: 1_200 })));
  expect(many.note()).toBe("2 frames with nothing drawn yet are left out. 1,200 frames with repeated titles are left out.");
});

test("the_note_shows_the_first_that_applies", () => {
  composeHooks.maxBytes = 10;
  const big = open(source(input({ nothingDrawn: 1 })));
  expect(big.note()).toBe("Too large to publish as one image. Publish a frame or the selection.");
  big.unmount();
  composeHooks.maxBytes = undefined;
  const counts = open(source(input({ nothingDrawn: 1 })));
  expect(counts.note()).toBe("1 frame with nothing drawn yet is left out.");
  counts.unmount();
  const plain = open(source(input()));
  expect(plain.note()).toBe("Uses Light theme colours. Hover and selection are left out.");
});

test("too_large_turns_off_copy_and_save", () => {
  composeHooks.maxBytes = 10;
  const { dialog } = open(source(input()));
  expect((within(dialog).getByRole("button", { name: /Copy/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole("button", { name: /Save as/ }) as HTMLButtonElement).disabled).toBe(true);
  // The preview says why instead of drawing an empty image.
  expect(dialog.querySelector(".publish-preview")!.textContent).toContain("Too large to publish as one image.");
  expect(dialog.querySelector(".publish-image")).toBeNull();
});

test("a_refused_image_says_no_size", () => {
  composeHooks.maxBytes = 10;
  const { dialog } = open(source(input()));
  // The compose stopped at the cap, so any size would be too low: nothing is said, as while a part loads.
  expect((dialog.querySelector(".publish-output-file") as HTMLElement | null)?.textContent ?? "").toBe("");
  expect((dialog.querySelector(".publish-output-size") as HTMLElement | null)?.textContent ?? "").toBe("");
  expect(dialog.textContent).not.toMatch(/about [\d,]+ KB/);
});

test("a_crop_needs_no_new_compose", () => {
  let composes = 0;
  composeHooks.onCompose = () => composes++;
  const { c, source: src } = counted(source(input()));
  const { dialog, output } = open(src);
  const before = { draw: c.draw, svg: c.svg, composes };
  expect(before.draw).toBe(1);
  const label = output();
  const handle = dialog.querySelector(".publish-handle-e") as HTMLElement;
  const preview = dialog.querySelector(".publish-preview") as HTMLElement;
  for (const dx of [-20, -40, -60]) {
    fireEvent.pointerDown(handle, { clientX: 400, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(preview, { clientX: 400 + dx, clientY: 100, pointerId: 1, altKey: true });
    fireEvent.pointerUp(preview, { pointerId: 1 });
  }
  expect(output()).not.toBe(label);
  expect({ draw: c.draw, svg: c.svg, composes }).toEqual(before);
});

test("the_cache_holds_two_drawings", async () => {
  const { c, source: src } = counted(source(input({ live: true }), "board"));
  const { radio } = open(src);
  expect(c.parts).toEqual(["board"]);
  await userEvent.click(radio("Selected frame"));
  await userEvent.click(radio("Whole board"));
  // Board, frame, board: the third is a hit.
  expect(c.parts).toEqual(["board", "frame"]);
  await userEvent.click(radio("What's on screen"));
  expect(c.parts).toEqual(["board", "frame", "screen"]);
  // Two drawings kept: screen and board. Frame was the oldest and went.
  await userEvent.click(radio("Whole board"));
  expect(c.draw).toBe(3);
  await userEvent.click(radio("Selected frame"));
  expect(c.parts).toEqual(["board", "frame", "screen", "frame"]);
});

test("a_theme_toggle_keeps_the_crop", async () => {
  const onTheme = vi.fn();
  const i = input();
  const { c, source: light } = counted(source(i));
  const view = open(light, onTheme);
  const crop = () => (view.dialog.querySelector(".publish-size") as HTMLElement).textContent;
  const handle = view.dialog.querySelector(".publish-handle-e") as HTMLElement;
  const preview = view.dialog.querySelector(".publish-preview") as HTMLElement;
  fireEvent.pointerDown(handle, { clientX: 400, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(preview, { clientX: 300, clientY: 100, pointerId: 1, altKey: true });
  fireEvent.pointerUp(preview, { pointerId: 1 });
  const cropped = crop();
  await userEvent.click(view.radio("Dark"));
  expect(onTheme).toHaveBeenCalledWith("dark");
  // Until the source inked for Dark arrives, the Light drawing stays and Copy and Save as wait.
  expect(c.draw).toBe(1);
  expect((within(view.dialog).getByRole("button", { name: /Copy/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(view.dialog).getByRole("button", { name: /Save as/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(crop()).toBe(cropped);
  const dark = counted(source(i, undefined, "dark"));
  view.rerender(<PublishDialog source={dark.source} fileName="board" onClose={view.onClose} onSaved={vi.fn()} onTheme={onTheme} />);
  expect(dark.c.draw).toBe(1);
  expect(crop()).toBe(cropped);
  expect((within(view.dialog).getByRole("button", { name: /Copy/ }) as HTMLButtonElement).disabled).toBe(false);
});

test("the_switch_leaving_keeps_focus_on_the_part_control", async () => {
  const { titlesSwitch, radio } = open(source(input({ sketchIds: ["n1"] }), "board"));
  titlesSwitch()!.focus();
  expect(document.activeElement).toBe(titlesSwitch());
  // A click that does not move focus (as an assistive tool's) picks the sketch-only Selection: the switch leaves.
  fireEvent.click(radio("Selection"));
  await waitFor(() => expect(titlesSwitch()).toBeNull());
  expect(document.activeElement).toBe(radio("Selection"));
});

test("the_dialog_is_keyboard_complete", async () => {
  const src = source(input({ sketchIds: ["n1"] }), "board");
  function Host() {
    const [on, setOn] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOn(true)}>
          Publish image
        </button>
        {on && <PublishDialog source={src} fileName="board" onClose={() => setOn(false)} />}
      </>
    );
  }
  render(<Host />);
  const opener = screen.getByRole("button", { name: "Publish image" });
  await userEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Publish image" });
  const reached = new Set<Element>();
  for (let n = 0; n < 40; n++) {
    await userEvent.tab();
    if (document.activeElement) reached.add(document.activeElement);
  }
  const radio = (name: string) => within(dialog).getByRole("radio", { name });
  expect(reached.has(radio("Whole board"))).toBe(true);
  expect(reached.has(within(dialog).getByRole("switch", { name: "Frame titles" }))).toBe(true);
  expect(reached.has(radio("PNG"))).toBe(true);
  expect(reached.has(within(dialog).getByRole("slider", { name: "Scale" }))).toBe(true);
  expect(reached.has(within(dialog).getByRole("button", { name: /Copy/ }))).toBe(true);
  expect(reached.has(within(dialog).getByRole("button", { name: /Save as/ }))).toBe(true);
  // Arrows move within the part control and skip the off Selected frame.
  radio("Whole board").focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(radio("Selection").getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(radio("Selection"));
  await userEvent.keyboard("{ArrowLeft}");
  expect(radio("Whole board").getAttribute("aria-checked")).toBe("true");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Publish image" })).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("no_dash_or_banned_word_in_publish_copy", () => {
  for (const [name, text] of [
    ["boardSvg.ts", boardSvgSource],
    ["source.ts", sourceSource],
    ["PublishDialog.tsx", publishDialogSource],
    ["limits.ts", limitsSource],
  ] as const) {
    const strings = [...text.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
    expect(strings.length, name).toBeGreaterThan(0);
    for (const s of strings) {
      expect(s, name).not.toMatch(/[–—]/);
      expect(s, name).not.toMatch(/\b(cursor|caret)\b/i);
    }
  }
});

test("a_part_chosen_while_a_theme_loads_never_shows_the_old_part", async () => {
  const i = input({ live: true });
  const light = counted(source(i, "board"));
  const view = open(light.source, vi.fn());
  const preview = () => view.dialog.querySelector(".publish-preview") as HTMLElement;
  await userEvent.click(view.radio("Dark"));
  // Same part, theme loading: the drawing before stays, dimmed.
  expect(preview().getAttribute("aria-busy")).toBe("true");
  expect(view.dialog.querySelector(".publish-image")).not.toBeNull();
  await userEvent.click(view.radio("Selected frame"));
  // Another part while loading: the board's drawing is not shown under "Selected frame"; only the loading state.
  expect(view.radio("Selected frame").getAttribute("aria-checked")).toBe("true");
  expect(preview().getAttribute("aria-busy")).toBe("true");
  expect(view.dialog.querySelector(".publish-image")).toBeNull();
  expect(view.dialog.querySelector(".publish-crop")).toBeNull();
  expect((within(view.dialog).getByRole("button", { name: /Copy/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(view.dialog).getByRole("button", { name: /Save as/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(light.c.parts).toEqual(["board"]);
  const dark = counted(source(i, "board", "dark"));
  view.rerender(<PublishDialog source={dark.source} fileName="board" onClose={view.onClose} onSaved={vi.fn()} />);
  expect(dark.c.parts).toEqual(["frame"]);
  expect(view.dialog.querySelector(".publish-image")).not.toBeNull();
  expect(preview().hasAttribute("aria-busy")).toBe(false);
});

test("the_output_line_waits_while_a_new_part_loads", async () => {
  const i = input({ live: true });
  const view = open(source(i, "board"), vi.fn());
  const size = () => (view.dialog.querySelector(".publish-output-size") as HTMLElement | null)?.textContent ?? "";
  const file = () => (view.dialog.querySelector(".publish-output-file") as HTMLElement | null)?.textContent ?? "";
  const board = size();
  expect(board).toMatch(/^[\d,]+ x [\d,]+ px$/);
  await userEvent.click(view.radio("Dark"));
  // Same part while the theme loads: the size shown is still the drawing's.
  expect(size()).toBe(board);
  await userEvent.click(view.radio("Selected frame"));
  // Another part while loading: the board's size and file size are not said of "Selected frame".
  expect(size()).toBe("");
  expect(file()).toBe("");
  expect(view.output()).not.toContain(board);
  view.rerender(<PublishDialog source={source(i, "board", "dark")} fileName="board" onClose={view.onClose} onSaved={vi.fn()} />);
  expect(size()).toMatch(/^[\d,]+ x [\d,]+ px$/);
  expect(size()).not.toBe(board);
  expect(file()).toMatch(/about [\d,]+ KB/);
});
