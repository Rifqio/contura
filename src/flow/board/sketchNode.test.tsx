// Task 7: an icon sketch draws the pack's image 40 px in its 64 px box with the pack's title under it (R18, R19).
import { render, screen, waitFor } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { createElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../../test/invoke";
import { ICON_CACHE_SIZE, iconCacheSize, resetIcons } from "../icons";
import type { Sketch } from "./boardLayout";
import { SketchNode } from "./SketchNode";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const svg = (name: string) => `<svg xmlns="http://www.w3.org/2000/svg"><title>${name}</title></svg>`;
let release: (() => void) | null = null;

function route(slowIndex = false) {
  routeInvoke({
    icon: ({ name }) => {
      if (name === "gone") throw { kind: "notFound", message: "gone is not an icon" };
      return svg(name as string);
    },
    icon_index: () =>
      slowIndex
        ? new Promise((res) => {
            release = () => res([{ name: "brand-postgresql", set: "simple", title: "PostgreSQL", licence: null, aliasOf: null }]);
          })
        : [{ name: "brand-postgresql", set: "simple", title: "PostgreSQL", licence: null, aliasOf: null }],
  });
}

beforeEach(() => {
  resetIcons();
  release = null;
});

const node = (s: Sketch) => createElement(SketchNode, { id: s.id, type: "sketch", data: { sketch: s }, selected: false, dragging: false } as unknown as NodeProps);
const icon = (name: string, id = "i1"): Sketch => ({ id, kind: "icon", x: 0, y: 0, w: 64, h: 64, icon: name });

test("an_icon_sketch_draws_its_image_and_title", async () => {
  route();
  const { container } = render(node(icon("brand-postgresql")));
  expect(await screen.findByRole("img", { name: "Icon sketch: PostgreSQL" })).toBeTruthy();
  const img = await waitFor(() => {
    const i = container.querySelector("img.board-sketch-icon") as HTMLImageElement;
    expect(i.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
    return i;
  });
  expect(img.getAttribute("alt")).toBe("");
  expect(img.getAttribute("width")).toBe("40");
  expect(img.getAttribute("height")).toBe("40");
  expect(container.querySelector(".board-sketch-icon-title")?.textContent).toBe("PostgreSQL");
});

test("the_name_shows_until_the_pack_loads", async () => {
  route(true);
  const { container } = render(node(icon("brand-postgresql")));
  expect(screen.getByRole("img", { name: "Icon sketch: brand-postgresql" })).toBeTruthy();
  expect(container.querySelector(".board-sketch-icon-title")?.textContent).toBe("brand-postgresql");
  await waitFor(() => expect(release).not.toBeNull());
  release!();
  await waitFor(() => expect(container.querySelector(".board-sketch-icon-title")?.textContent).toBe("PostgreSQL"));
});

test("a_missing_icon_draws_a_placeholder", async () => {
  route();
  const { container } = render(node(icon("gone")));
  await waitFor(() => expect(container.querySelector(".board-sketch-icon-missing")).toBeTruthy());
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".board-sketch-icon-title")?.textContent).toBe("gone");
});

test("a_thousand_icon_sketches_keep_the_icon_cache_bounded", async () => {
  route();
  const list = Array.from({ length: 1000 }, (_, i) => icon(`icon-${i}`, `i${i}`));
  const { container } = render(<>{list.map((s) => node(s))}</>);
  await waitFor(() => expect(callsTo("icon").length).toBe(1000), { timeout: 20_000 });
  await waitFor(() => expect(container.querySelectorAll("img.board-sketch-icon").length).toBe(1000), { timeout: 20_000 });
  expect(iconCacheSize()).toBeLessThanOrEqual(ICON_CACHE_SIZE);
  expect(callsTo("icon_index")).toHaveLength(1);
}, 60_000);
