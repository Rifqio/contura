// B4 Task 5 follow-up: a diagram source draws its body once per palette and shares it between parts (ADR 0003).
import { expect, test, vi } from "vitest";
import { exportPalette } from "./palette";
import type { Scene } from "./scene";
import { sceneSource } from "./source";
import { sceneToSvg } from "./svg";

const bodies = vi.hoisted(() => ({ n: 0 }));
vi.mock("./svg", async (orig) => {
  const real = await orig<typeof import("./svg")>();
  return {
    ...real,
    sceneBody: (...a: Parameters<typeof real.sceneBody>) => {
      bodies.n++;
      return real.sceneBody(...a);
    },
  };
});

const SCENE: Scene = {
  nodes: [
    { id: "a", kind: "table", x: 0, y: 0, w: 216, h: 80, title: "orders", rows: [{ left: "id", right: "int", mark: "pk" }] },
    { id: "b", kind: "table", x: 400, y: 100, w: 216, h: 56, title: "stores", rows: [{ left: "id", right: "int" }] },
  ],
  edges: [],
};
const LIGHT = exportPalette("light");
const DARK = exportPalette("dark");
const OPTS = { padding: 32, background: "theme" as const, mark: true };

test("parts_share_one_body", () => {
  const src = sceneSource(SCENE, ["b"], { x: 0, y: 0, w: 500, h: 300 });
  bodies.n = 0;
  const whole = src.draw("whole", LIGHT, true);
  const screen = src.draw("screen", LIGHT, true);
  const selected = src.draw("selected", LIGHT, true);
  expect(bodies.n).toBe(1);
  // Each part's image is still today's, byte for byte.
  for (const d of [whole, screen, selected]) {
    const crop = { ...d.bounds };
    expect(d.svg({ ...OPTS, crop })).toBe(sceneToSvg(SCENE, LIGHT, { ...OPTS, crop }));
    expect(d.bytes({ ...OPTS, crop })).toBe(new TextEncoder().encode(sceneToSvg(SCENE, LIGHT, { ...OPTS, crop })).length);
  }
  // Another theme draws once more, and only the latest palette's body is kept.
  src.draw("whole", DARK, true);
  src.draw("screen", DARK, true);
  expect(bodies.n).toBe(2);
  src.draw("whole", LIGHT, true);
  expect(bodies.n).toBe(3);
});
