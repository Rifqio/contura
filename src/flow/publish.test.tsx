// Publish from a diagram tab: the step 6 dialog opens with the drawn diagram's scene, cloud
// icons are loaded for it (only the ones the diagram uses) and embedded as images, and closing the dialog lets
// the scene go.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { exportPalette } from "../diagram/export/palette";
import type { Box, Scene } from "../diagram/export/scene";
import { type PublishSource, sceneSource } from "../diagram/export/source";
import { sceneToSvg } from "../diagram/export/svg";
import { parseFlow } from "../lang/flow/parse";
import { LangClient } from "../lang/client";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";
import { flowScene, loadSceneIcons } from "./flowScene";
import { resetIcons } from "./icons";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The dialog has its own tests; here it only has to open with the diagram's scene, and close. A board opens it with
// a source (R11): its initial part is drawn in Light so the image can be read.
const dialog = vi.hoisted(() => ({
  opened: [] as { scene?: Scene; source?: PublishSource; fileName: string; selected?: string[]; onScreen?: Box }[],
  mounted: 0,
}));
vi.mock("../diagram/export/PublishDialog", async () => {
  const { useEffect } = await import("react");
  const { exportPalette } = await import("../diagram/export/palette");
  return {
    default: (p: { scene?: Scene; source?: PublishSource; fileName: string; selected?: string[]; onScreen?: Box; onClose(): void; onTheme?(t: "light" | "dark"): void }) => {
      useEffect(() => {
        dialog.mounted++;
        dialog.opened.push({ scene: p.scene, source: p.source, fileName: p.fileName, selected: p.selected, onScreen: p.onScreen });
        return () => {
          dialog.mounted--;
        };
      }, []);
      const icon = p.scene
        ? (p.scene.nodes.find((n) => n.icon)?.icon ?? "")
        : (/<image [^>]*href="([^"]+)"/.exec(p.source!.draw(p.source!.initial, exportPalette("light"), true).svg({ padding: 0, background: "theme", mark: false }))?.[1] ?? "");
      return (
        <div role="dialog" aria-label="Publish image" data-icon={icon}>
          <button type="button" onClick={() => p.onTheme?.("dark")}>
            Dark
          </button>
          <button type="button" onClick={() => p.onTheme?.("light")}>
            Light
          </button>
          <button type="button" onClick={p.onClose}>
            Close
          </button>
        </div>
      );
    },
  };
});

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
beforeEach(() => {
  resetIcons();
  dialog.opened.length = 0;
});
afterEach(cleanup);

const DFD = ['diagram dfd "Checkout"', "Customer [entity]", "Checkout [process, id: 1.0]", "Customer > Checkout: order details", ""].join("\n");
const LAYOUT = JSON.stringify({ version: 1, nodes: { Customer: { x: 0, y: 0 }, Checkout: { x: 300, y: 0 } }, style: "classic" });

const CLOUD = ['diagram cloud "Order API"', "Users [icon: users]", "API Gateway [icon: aws-api-gateway]", "Users > API Gateway: HTTPS", ""].join("\n");
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48"/></svg>';

function setup(text: string, layout: string | null, name: string) {
  routeInvoke({
    read_diagram: () => ({ text, layout }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    icon_index: () => ["users", "aws-api-gateway", "aws-s3"].map((n) => ({ name: n, set: n.startsWith("aws-") ? "aws" : "lucide", title: n, licence: null })),
    icon: () => ICON,
  });
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name={name} client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const publish = () => within(strip()).getByRole("button", { name: "Publish" }) as HTMLButtonElement;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  return { ...utils, strip, publish, canvasEl, press };
}

test("publish_opens_with_the_drawn_diagram_in_its_look_and_closing_lets_it_go", { timeout: 20000 }, async () => {
  const s = setup(DFD, LAYOUT, "checkout");
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  await userEvent.click(s.publish());
  await screen.findByRole("dialog", { name: "Publish image" });
  const { scene: given, fileName } = dialog.opened[0];
  const scene = given!;
  expect(fileName).toBe("checkout");
  expect(scene.nodes.map((n) => [n.id, n.kind, n.look, n.x, n.y])).toEqual([
    ["Customer", "external", "classic", 0, 0],
    ["Checkout", "process", "classic", 300, 0],
  ]);
  expect(scene.edges.map((e) => [e.kind, e.label])).toEqual([["flow", "order details"]]);
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Publish image" })).toBeNull();
  expect(dialog.mounted).toBe(0);
});

test("cloud_publish_loads_only_the_used_icons_and_embeds_them", { timeout: 20000 }, async () => {
  const s = setup(CLOUD, JSON.stringify({ version: 1, nodes: { Users: { x: 0, y: 0 }, "API Gateway": { x: 300, y: 0 } } }), "order-api");
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  await userEvent.click(s.publish());
  await screen.findByRole("dialog", { name: "Publish image" });
  expect([...new Set(callsTo("icon").map((c) => c.name))].sort()).toEqual(["aws-api-gateway", "users"]);
  const scene = dialog.opened[0].scene!;
  const icons = scene.nodes.map((n) => n.icon);
  expect(icons).toHaveLength(2);
  for (const url of icons) expect(url).toBe(`data:image/svg+xml;base64,${btoa(ICON)}`);
});

test("fast_theme_toggles_in_the_publish_dialog_end_inked_for_the_last_choice", { timeout: 20000 }, async () => {
  const s = setup(CLOUD, JSON.stringify({ version: 1, nodes: { Users: { x: 0, y: 0 }, "API Gateway": { x: 300, y: 0 } } }), "order-api");
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  const held: ((v: string) => void)[] = [];
  await userEvent.click(s.publish());
  const dlg = await screen.findByRole("dialog", { name: "Publish image" });
  const light = `data:image/svg+xml;base64,${btoa(ICON)}`;
  expect(dlg.getAttribute("data-icon")).toBe(light);
  routeInvoke({ icon: ({ ink }) => new Promise<string>((r) => (ink === "#f8f8f2" ? held.push(r) : r(ICON))) });
  // Dark is asked for and is slow; Light is asked for again before it answers, so Light is the last choice.
  await userEvent.click(within(dlg).getByRole("button", { name: "Dark" }));
  await waitFor(() => expect(held).toHaveLength(2));
  await userEvent.click(within(dlg).getByRole("button", { name: "Light" }));
  await act(async () => held.forEach((r) => r('<svg xmlns="http://www.w3.org/2000/svg" data-ink="dark"/>')));
  await new Promise((r) => setTimeout(r, 50));
  expect(dlg.getAttribute("data-icon")).toBe(light);
});

test("the_publish_dialog_theme_inks_its_icons", { timeout: 20000 }, async () => {
  const s = setup(CLOUD, JSON.stringify({ version: 1, nodes: { Users: { x: 0, y: 0 }, "API Gateway": { x: 300, y: 0 } } }), "order-api");
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  await userEvent.click(s.publish());
  const dlg = await screen.findByRole("dialog", { name: "Publish image" });
  routeInvoke({ icon: ({ ink }) => `<svg xmlns="http://www.w3.org/2000/svg" data-ink="${ink}"/>` });
  await userEvent.click(within(dlg).getByRole("button", { name: "Dark" }));
  await waitFor(() => expect(atob(dlg.getAttribute("data-icon")!.split(",")[1])).toContain("#f8f8f2"));
});

test("publish_draws_a_logo_in_its_colour_for_the_chosen_theme", async () => {
  routeInvoke({
    icon_index: () => [
      { name: "brand-postgresql", set: "simple", title: "PostgreSQL", licence: null, aliasOf: null, hex: "#4169e1" },
      { name: "brand-ink", set: "simple", title: "Ink", licence: null, aliasOf: null, hex: "#000000" },
      { name: "brand-js", set: "simple", title: "JavaScript", licence: null, aliasOf: null, hex: "#f7df1e" },
    ],
    icon: () => ICON,
  });
  const dark = await loadSceneIcons(["brand-postgresql", "brand-ink", "brand-js"], "dark");
  expect([...dark.keys()].sort()).toEqual(["brand-ink", "brand-js", "brand-postgresql"]);
  const asked = new Map(callsTo("icon").map((c) => [c.name, c.ink]));
  expect(asked.get("brand-postgresql")).toBe("#4169e1");
  // Black is too faint on the dark canvas: it draws in the dark theme's text colour.
  expect(asked.get("brand-ink")).toBe("#f8f8f2");
  expect([...dark.values()].every((i) => !i.outline)).toBe(true);
  // On light the pale logo keeps its colour and is outlined; nothing else is.
  const light = await loadSceneIcons(["brand-postgresql", "brand-ink", "brand-js"], "light");
  expect(callsTo("icon").filter((c) => c.name === "brand-js").map((c) => c.ink)).toEqual(["#f7df1e", "#f7df1e"]);
  expect(light.get("brand-js")).toEqual({ url: `data:image/svg+xml;base64,${btoa(ICON)}`, outline: true });
  expect(light.get("brand-postgresql")!.outline).toBe(false);
  expect(light.get("brand-ink")!.outline).toBe(false);
});

const OPTS = { padding: 32, background: "theme" as const, mark: true };

test("a_one_frame_file_publishes_byte_for_byte_as_before", { timeout: 20000 }, async () => {
  const s = setup(DFD, LAYOUT, "checkout");
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  await userEvent.click(s.publish());
  await screen.findByRole("dialog", { name: "Publish image" });
  // One frame and no sketch: the diagram's scene with today's parts, never a board source (Decision 6).
  const o = dialog.opened[0];
  expect(o.source).toBeUndefined();
  const scene = o.scene!;
  const doc = parseFlow(DFD).doc!;
  const want = flowScene(doc, JSON.parse(LAYOUT).nodes, "classic", new Map());
  expect(scene).toEqual(want);
  const src = sceneSource(scene, o.selected ?? [], o.onScreen!);
  expect(src.parts.map((p) => p.label)).toEqual(["Whole diagram", "What's on screen", "Selected nodes"]);
  for (const theme of ["light", "dark"] as const) {
    const palette = exportPalette(theme);
    expect(src.draw("whole", palette, true).svg(OPTS)).toBe(sceneToSvg(want, palette, OPTS));
  }
});

test("a_one_frame_board_with_nothing_selected_still_publishes", { timeout: 20000 }, async () => {
  const s = setup(DFD, LAYOUT, "checkout");
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  // Esc lets the one frame go (A7): no live frame, nothing drawn live.
  s.press("Escape");
  await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Checkout settings" })).toBeNull());
  await waitFor(() => expect(s.publish().disabled).toBe(false));
  s.press("E", { ctrlKey: true, shiftKey: true });
  await screen.findByRole("dialog", { name: "Publish image" });
  const o = dialog.opened[0];
  expect(o.source).toBeUndefined();
  // Frame 0's drawing, from its doc and its layout entry, in its look.
  expect(o.scene!.nodes.map((n) => [n.id, n.kind, n.look, n.x, n.y])).toEqual([
    ["Customer", "external", "classic", 0, 0],
    ["Checkout", "process", "classic", 300, 0],
  ]);
  expect(o.scene).toEqual(flowScene(parseFlow(DFD).doc!, JSON.parse(LAYOUT).nodes, "classic", new Map()));
});
