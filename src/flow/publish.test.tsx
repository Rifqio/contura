// Publish from a diagram tab (spec 6+ section 8): the step 6 dialog opens with the drawn diagram's scene, cloud
// icons are loaded for it (only the ones the diagram uses) and embedded as images, and closing the dialog lets
// the scene go.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { Scene } from "../diagram/export/scene";
import { LangClient } from "../lang/client";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";
import { resetIcons } from "./icons";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The dialog has its own tests; here it only has to open with the diagram's scene, and close.
const dialog = vi.hoisted(() => ({ opened: [] as { scene: Scene; fileName: string; selected: string[] }[], mounted: 0 }));
vi.mock("../diagram/export/PublishDialog", async () => {
  const { useEffect } = await import("react");
  return {
    default: (p: { scene: Scene; fileName: string; selected: string[]; onClose(): void }) => {
      useEffect(() => {
        dialog.mounted++;
        dialog.opened.push({ scene: p.scene, fileName: p.fileName, selected: p.selected });
        return () => {
          dialog.mounted--;
        };
      }, []);
      return (
        <div role="dialog" aria-label="Publish image">
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
  return { ...utils, strip, publish };
}

test("publish_opens_with_the_drawn_diagram_in_its_look_and_closing_lets_it_go", { timeout: 20000 }, async () => {
  const s = setup(DFD, LAYOUT, "checkout");
  await waitFor(() => expect(s.publish().disabled).toBe(false), { timeout: 4000 });
  await userEvent.click(s.publish());
  await screen.findByRole("dialog", { name: "Publish image" });
  const { scene, fileName } = dialog.opened[0];
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
  const { scene } = dialog.opened[0];
  const icons = scene.nodes.map((n) => n.icon);
  expect(icons).toHaveLength(2);
  for (const url of icons) expect(url).toBe(`data:image/svg+xml;base64,${btoa(ICON)}`);
});
