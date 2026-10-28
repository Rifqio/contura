// B4 Task 6: Publish on the board in FlowTab (Decisions 2, 6 and 13; R6, R7, R13, R15). The real dialog opens, wrapped
// so its mounts and the sources it was given are counted; the image is read back from the preview.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { PublishSource } from "../../diagram/export/source";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import { resetIcons } from "../icons";
import { composeHooks } from "./publish/boardSvg";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
patientFile();

const dialog = vi.hoisted(() => ({ mounted: 0, sources: [] as PublishSource[] }));
vi.mock("../../diagram/export/PublishDialog", async (load) => {
  const real = await load<typeof import("../../diagram/export/PublishDialog")>();
  const { useEffect } = await import("react");
  type P = Parameters<typeof real.default>[0];
  return {
    default: (p: P) => {
      useEffect(() => {
        dialog.mounted++;
        return () => {
          dialog.mounted--;
        };
      }, []);
      if ("source" in p && dialog.sources[dialog.sources.length - 1] !== p.source) dialog.sources.push(p.source);
      return <real.default {...p} />;
    },
  };
});

// Every icon load Publish starts, so a test can settle them all before it says nothing more happened; and each time
// Publish builds a board's input, which it does at once when it opens on a board.
const loads = vi.hoisted(() => ({ pending: [] as Promise<unknown>[], inputs: 0, sources: 0 }));
vi.mock("./publish/boardSvg", async (load) => {
  const real = await load<typeof import("./publish/boardSvg")>();
  return {
    ...real,
    boardSource: (...a: Parameters<typeof real.boardSource>) => {
      loads.sources++;
      return real.boardSource(...a);
    },
  };
});
vi.mock("../flowScene", async (load) => {
  const real = await load<typeof import("../flowScene")>();
  return {
    ...real,
    loadSceneIcons: (...a: Parameters<typeof real.loadSceneIcons>) => {
      const p = real.loadSceneIcons(...a);
      loads.pending.push(p);
      return p;
    },
  };
});
vi.mock("./publish/boardPublish", async (load) => {
  const real = await load<typeof import("./publish/boardPublish")>();
  return {
    ...real,
    boardPublishInput: (...a: Parameters<typeof real.boardPublishInput>) => {
      loads.inputs++;
      return real.boardPublishInput(...a);
    },
  };
});
/** Waits until every icon load started so far has settled, and what awaited it has run. */
async function settled() {
  for (;;) {
    const now = [...loads.pending];
    await act(async () => {
      await Promise.allSettled(now);
    });
    if (loads.pending.length === now.length) return;
  }
}

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
beforeEach(() => {
  resetIcons();
  dialog.sources = [];
  loads.pending = [];
  loads.inputs = 0;
  loads.sources = 0;
});
afterEach(() => {
  cleanup();
  composeHooks.onCompose = undefined;
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\n';
const BOARD = [CHECKOUT, REFUND, SHIPPING].join("\n");
const entry = (at: number, nodes: Record<string, { x: number; y: number }>) => ({ at: { x: at, y: 0 }, nodes, style: "modern", direction: "TB" });
const NOTE = { id: "n1", kind: "note", x: 0, y: 600, w: 160, h: 80, text: "Ship it" };
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: entry(0, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }),
    Refund: entry(600, { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }),
    Shipping: entry(1200, { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }),
  },
  sketches: [NOTE],
});

const USERS = 'diagram cloud "Users"\nPeople [icon: users]\nGateway [icon: aws-api-gateway]\nPeople > Gateway\n';
const STORE = 'diagram cloud "Store"\nBucket [icon: aws-s3]\nCache [icon: users]\nCache > Bucket\n';
const CLOUD_LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Users: entry(0, { People: { x: 0, y: 0 }, Gateway: { x: 0, y: 160 } }),
    Store: entry(800, { Bucket: { x: 0, y: 0 }, Cache: { x: 0, y: 160 } }),
  },
  sketches: [],
});
const DARK_INK = "#f8f8f2";

function setup(text = BOARD, layout: string | null = LAYOUT) {
  routeInvoke({
    read_diagram: () => ({ text, layout }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    icon_index: () => ["users", "aws-api-gateway", "aws-s3"].map((n) => ({ name: n, set: n.startsWith("aws-") ? "aws" : "lucide", title: n, licence: null })),
    icon: ({ ink }) => `<svg xmlns="http://www.w3.org/2000/svg" data-ink="${ink}"/>`,
  });
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const publish = () => within(strip()).getByRole("button", { name: "Publish" }) as HTMLButtonElement;
  return { ...utils, canvasEl, press, publish };
}
type Setup = ReturnType<typeof setup>;

async function opened(titles: string[]) {
  for (const t of titles) await screen.findByRole("button", { name: new RegExp(` ${t}$`) });
}

/** The open dialog, its radios, and the image its preview shows. */
async function publishDialog() {
  const d = await screen.findByRole("dialog", { name: "Publish image" });
  const radio = (name: string) => within(d).getByRole("radio", { name }) as HTMLElement;
  const svg = () => {
    const src = (d.querySelector(".publish-image") as HTMLImageElement | null)?.getAttribute("src") ?? "";
    const b64 = src.split(",")[1] ?? "";
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  };
  return { d, radio, svg };
}

/** The frame groups of `svg` with the shape names inside each, and its sketch ids. */
function contents(svg: string) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const frames = [...doc.querySelectorAll("[data-board-frame]")].map((g) => ({
    index: g.getAttribute("data-board-frame"),
    nodes: [...g.querySelectorAll("[data-node]")].map((n) => n.getAttribute("data-node")).sort(),
  }));
  const sketches = [...doc.querySelectorAll("[data-sketch]")].map((g) => g.getAttribute("data-sketch"));
  return { frames, sketches };
}

const WHOLE = {
  frames: [
    { index: "0", nodes: ["Cart", "Pay"] },
    { index: "1", nodes: ["Ask", "Refund it"] },
    { index: "2", nodes: ["Pack", "Send"] },
  ],
  sketches: ["n1"],
};

async function ready(s: Setup) {
  await opened(["Checkout", "Refund", "Shipping"]);
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
}

/** Selects a frame by its tab and waits for its bar. */
async function pick(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Flowchart ${title}` }));
  return await screen.findByRole("toolbar", { name: `${title} settings` });
}

test("ctrl_shift_e_on_an_empty_selection_publishes_the_whole_board", { timeout: 20000 }, async () => {
  const s = setup();
  await ready(s);
  expect(screen.queryByRole("toolbar", { name: /settings$/ })).toBeNull();
  s.press("E", { ctrlKey: true, shiftKey: true });
  const v = await publishDialog();
  expect(v.radio("Whole board").getAttribute("aria-checked")).toBe("true");
  // Every frame's shapes, though the canvas may draw static frames as one preview each (A13), and the note.
  expect(contents(v.svg())).toEqual(WHOLE);
});

test("the_context_menu_publishes_the_board_with_nothing_selected", { timeout: 20000 }, async () => {
  const s = setup();
  await ready(s);
  fireEvent.contextMenu(s.container.querySelector(".react-flow__pane") as HTMLElement, { clientX: 1270, clientY: 790 });
  const menu = await screen.findByRole("menu", { name: "Canvas actions" });
  const item = within(menu).getByRole("menuitem", { name: "Publish image..." }) as HTMLButtonElement;
  expect(item.disabled).toBe(false);
  expect(item.textContent).toContain("Ctrl+Shift+E");
  fireEvent.click(item);
  const v = await publishDialog();
  expect(v.radio("Whole board").getAttribute("aria-checked")).toBe("true");
  expect(contents(v.svg())).toEqual(WHOLE);
});

test("the_strip_button_publishes_the_board_with_nothing_selected", { timeout: 20000 }, async () => {
  const s = setup();
  await ready(s);
  expect(s.publish().title).toBe("Publish image (Ctrl+Shift+E)");
  await userEvent.click(s.publish());
  const v = await publishDialog();
  expect(v.radio("Whole board").getAttribute("aria-checked")).toBe("true");
  expect(contents(v.svg())).toEqual(WHOLE);
});

test("publish_is_off_when_no_frame_has_anything_drawn", { timeout: 20000 }, async () => {
  const s = setup('diagram flow "Plan"\n\ndiagram flow "Draft"\n', JSON.stringify({ version: 2, frames: { Plan: entry(0, {}), Draft: entry(600, {}) }, sketches: [] }));
  await opened(["Plan", "Draft"]);
  // The tabs are drawn from the parse, and the button is worked out in the same render: off, and stays off.
  expect(s.publish().disabled).toBe(true);
  // A positive signal of the same parse: an empty frame's bar is up, and its Publish board is off.
  fireEvent.click(await screen.findByRole("button", { name: "Flowchart Plan" }));
  const bar = await screen.findByRole("toolbar", { name: "Plan settings" });
  fireEvent.click(within(bar).getByRole("button", { name: "More" }));
  expect((await screen.findByRole("menuitem", { name: "Publish board..." }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  s.press("Escape");
  await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Plan settings" })).toBeNull());
  expect(s.publish().disabled).toBe(true);
  fireEvent.contextMenu(s.container.querySelector(".react-flow__pane") as HTMLElement, { clientX: 1270, clientY: 790 });
  const menu = await screen.findByRole("menu", { name: "Canvas actions" });
  expect((within(menu).getByRole("menuitem", { name: "Publish image..." }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu", { name: "Canvas actions" })).toBeNull());
  // Publish builds the board's input at once when it opens: none built, no load started, no dialog.
  s.press("E", { ctrlKey: true, shiftKey: true });
  expect(loads.inputs).toBe(0);
  await settled();
  expect(loads.pending).toHaveLength(0);
  expect(screen.queryByRole("dialog", { name: "Publish image" })).toBeNull();
});

test("publish_frame_from_the_bar_opens_on_selected_frame", { timeout: 20000 }, async () => {
  const s = setup();
  await ready(s);
  const bar = await pick("Refund");
  fireEvent.click(within(bar).getByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Publish frame..." }));
  const v = await publishDialog();
  expect(v.radio("Selected frame").getAttribute("aria-checked")).toBe("true");
  expect(contents(v.svg())).toEqual({ frames: [{ index: "1", nodes: ["Ask", "Refund it"] }], sketches: [] });
});

test("publish_board_from_the_bar_opens_on_whole_board", { timeout: 20000 }, async () => {
  const s = setup();
  await ready(s);
  const bar = await pick("Refund");
  fireEvent.click(within(bar).getByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Publish board..." }));
  const v = await publishDialog();
  expect(v.radio("Whole board").getAttribute("aria-checked")).toBe("true");
  expect(contents(v.svg())).toEqual(WHOLE);
});

test("focus_returns_to_the_more_button", { timeout: 20000 }, async () => {
  const s = setup();
  await ready(s);
  const bar = await pick("Refund");
  const more = within(bar).getByRole("button", { name: "More" });
  more.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("menu");
  // Down to "Publish board..." and Enter, from the keyboard.
  const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
  const at = items.findIndex((m) => m.getAttribute("aria-label") === "Publish board...");
  expect(at).toBeGreaterThan(0);
  items[at].focus();
  await userEvent.keyboard("{Enter}");
  await publishDialog();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish image" })).toBeNull());
  expect(document.activeElement).toBe(more);
});

test("fast_theme_toggles_on_a_board_end_inked_for_the_last_choice", { timeout: 20000 }, async () => {
  const s = setup([USERS, STORE].join("\n"), CLOUD_LAYOUT);
  await opened(["Users", "Store"]);
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  let composes = 0;
  composeHooks.onCompose = () => composes++;
  await userEvent.click(s.publish());
  const v = await publishDialog();
  await waitFor(() => expect(v.svg()).toContain("<image"));
  const inks = () =>
    [...v.svg().matchAll(/<image [^>]*href="data:image\/svg\+xml;base64,([^"]+)"/g)].map((m) => /data-ink="([^"]+)"/.exec(atob(m[1]))?.[1] ?? "");
  const light = inks();
  expect(light.length).toBeGreaterThan(0);
  expect(light).not.toContain(DARK_INK);
  // Dark's icons are slow and answer out of order; Light is chosen again before any of them answers.
  const held: ((v: string) => void)[] = [];
  routeInvoke({ icon: ({ ink }) => (ink === DARK_INK ? new Promise<string>((r) => held.unshift(r)) : `<svg xmlns="http://www.w3.org/2000/svg" data-ink="${ink}"/>`) });
  await userEvent.click(v.radio("Dark"));
  await waitFor(() => expect(held.length).toBeGreaterThan(0));
  await userEvent.click(v.radio("Light"));
  await act(async () => held.splice(0).forEach((r) => r(`<svg xmlns="http://www.w3.org/2000/svg" data-ink="${DARK_INK}"/>`)));
  await settled();
  expect(v.radio("Light").getAttribute("aria-checked")).toBe("true");
  expect(inks()).toEqual(light);
  // One compose per source that arrived (D2, R13): only Light's.
  expect(dialog.sources).toHaveLength(1);
  expect(composes).toBe(dialog.sources.length);
});

test("a_late_dark_load_never_lands_after_a_newer_dark", { timeout: 20000 }, async () => {
  const s = setup([USERS, STORE].join("\n"), CLOUD_LAYOUT);
  await opened(["Users", "Store"]);
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  let composes = 0;
  composeHooks.onCompose = () => composes++;
  await userEvent.click(s.publish());
  const v = await publishDialog();
  await waitFor(() => expect(dialog.sources).toHaveLength(1));
  const inks = () =>
    [...v.svg().matchAll(/<image [^>]*href="data:image\/svg\+xml;base64,([^"]+)"/g)].map((m) => /data-ink="([^"]+)"/.exec(atob(m[1]))?.[1] ?? "");
  // Dark's icons are held. Light comes back (its own source), then Dark is chosen again while the first Dark load is
  // still out: two Dark loads in flight, the first one stale.
  const held: ((v: string) => void)[] = [];
  routeInvoke({ icon: ({ ink }) => (ink === DARK_INK ? new Promise<string>((r) => held.push(r)) : `<svg xmlns="http://www.w3.org/2000/svg" data-ink="${ink}"/>`) });
  await userEvent.click(v.radio("Dark"));
  await waitFor(() => expect(held.length).toBeGreaterThan(0));
  await userEvent.click(v.radio("Light"));
  // Light's own source is still the one given: the dialog stops waiting, and no new source was made.
  await waitFor(() => expect(v.d.querySelector(".publish-preview")!.hasAttribute("aria-busy")).toBe(false));
  expect(dialog.sources).toHaveLength(1);
  const before = loads.pending.length;
  await userEvent.click(v.radio("Dark"));
  await waitFor(() => expect(loads.pending.length).toBe(before + 1));
  expect(dialog.sources).toHaveLength(1);
  // Both Dark loads answer now (the pack fetches each icon once for both): only the newer one lands.
  await act(async () => held.splice(0).forEach((r) => r(`<svg xmlns="http://www.w3.org/2000/svg" data-ink="${DARK_INK}"/>`)));
  await settled();
  await waitFor(() => expect(v.d.querySelector(".publish-preview")!.hasAttribute("aria-busy")).toBe(false));
  expect(v.radio("Dark").getAttribute("aria-checked")).toBe("true");
  // One source per theme, one compose per source: Light's and one Dark's; the stale Dark load built none.
  expect(loads.sources).toBe(2);
  expect(dialog.sources).toHaveLength(2);
  expect(dialog.sources[1].inkedFor).toBe("dark");
  expect(inks().length).toBeGreaterThan(0);
  expect(inks().every((i) => i === DARK_INK)).toBe(true);
  expect(composes).toBe(2);
});

test("toggling_back_to_light_reuses_its_source", { timeout: 20000 }, async () => {
  const s = setup([USERS, STORE].join("\n"), CLOUD_LAYOUT);
  await opened(["Users", "Store"]);
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  let composes = 0;
  composeHooks.onCompose = () => composes++;
  await userEvent.click(s.publish());
  const v = await publishDialog();
  await waitFor(() => expect(dialog.sources).toHaveLength(1));
  await userEvent.click(v.radio("Dark"));
  await waitFor(() => expect(dialog.sources).toHaveLength(2));
  await waitFor(() => expect(v.d.querySelector(".publish-preview")!.hasAttribute("aria-busy")).toBe(false));
  expect(composes).toBe(2);
  await userEvent.click(v.radio("Light"));
  await waitFor(() => expect(dialog.sources).toHaveLength(3));
  await settled();
  // Light's own source again, not a new one: the dialog's drawing of it is reused and nothing composes.
  expect(dialog.sources[2]).toBe(dialog.sources[0]);
  expect(composes).toBe(2);
});

test("closing_lets_the_board_drawing_go", { timeout: 20000 }, async () => {
  const s = setup();
  await ready(s);
  await userEvent.click(s.publish());
  await publishDialog();
  expect(dialog.mounted).toBe(1);
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish image" })).toBeNull());
  expect(dialog.mounted).toBe(0);
  expect(s.container.querySelector(".publish-dialog")).toBeNull();
});

test("publish_frame_is_off_for_an_empty_frame", { timeout: 20000 }, async () => {
  const s = setup(`diagram flow "Plan"\n\n${CHECKOUT}`, JSON.stringify({ version: 2, frames: { Plan: entry(0, {}), Checkout: entry(600, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }) }, sketches: [] }));
  await opened(["Plan", "Checkout"]);
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  const rows = async (title: string) => {
    const bar = await pick(title);
    fireEvent.click(within(bar).getByRole("button", { name: "More" }));
    const frame = (await screen.findByRole("menuitem", { name: "Publish frame..." })) as HTMLButtonElement;
    const board = screen.getByRole("menuitem", { name: "Publish board..." }) as HTMLButtonElement;
    const out = { frame: frame.disabled, board: board.disabled };
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    return out;
  };
  // The empty frame is left out of Publish, so its row is off; the board still publishes Checkout.
  expect(await rows("Plan")).toEqual({ frame: true, board: false });
  expect(await rows("Checkout")).toEqual({ frame: false, board: false });
});
