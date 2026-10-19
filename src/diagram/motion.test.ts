import { afterEach, expect, test, vi } from "vitest";
import designNext from "../../DESIGN-NEXT.md?raw";
import tokensCss from "../styles/tokens.css?raw";
import { EASE_IN, EASE_OUT, MOTION, type MotionKey, motionMs, reducedMotion, setReducedMotionPref } from "./motion";

/** DESIGN-NEXT section 8, up to the next heading. */
const section8 = (() => {
  const at = designNext.indexOf("## 8. Motion");
  return designNext.slice(at, designNext.indexOf("\n## ", at + 1));
})();

/** The durations section 8 allows, each with the words that follow it ("80 ms hover and press"). */
function dnDurations(): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of section8.matchAll(/(\d+) ms ([^;.]+)/g)) out.set(Number(m[1]), m[2]);
  return out;
}

function stubReduce(on: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: on && q.includes("prefers-reduced-motion: reduce"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
}

afterEach(() => {
  setReducedMotionPref(false);
  vi.unstubAllGlobals();
});

test("motion_matches_design_next", () => {
  expect(MOTION).toEqual({
    hover: 80,
    ports: 120,
    settle: 120,
    lock: 80,
    menu: 120,
    pullBack: 120,
    enter: 120,
    exit: 120,
    undo: 120,
    toast: 180,
    band: 120,
    tidy: 240,
    fit: 240,
    group: 80,
  });
  const dn = dnDurations();
  expect([...dn.keys()]).toEqual([80, 120, 180, 240]);
  // Every value is one DESIGN-NEXT allows, and nothing is longer than its longest.
  for (const v of Object.values(MOTION)) expect(dn.has(v)).toBe(true);
  expect(Math.max(...Object.values(MOTION))).toBe(240);
  // The named roles land on the duration DESIGN-NEXT gives them.
  expect(dn.get(MOTION.hover)).toMatch(/hover and press/);
  expect(dn.get(MOTION.menu)).toMatch(/menus/);
  expect(dn.get(MOTION.toast)).toMatch(/toasts/);
  expect(dn.get(MOTION.fit)).toMatch(/zoom-to-fit/);
  // The spec's Groups row: the edge turns accent in 80 ms; joining and growing use settle (120 ms).
  expect(MOTION.group).toBe(80);
  expect(MOTION.settle).toBe(120);
  // Easing is copied verbatim, and the CSS tokens carry the same curves and steps.
  expect(section8).toContain(`enter \`${EASE_IN}\``);
  expect(section8).toContain(`exit \`${EASE_OUT}\``);
  expect(tokensCss).toContain(`--ease-enter: ${EASE_IN};`);
  expect(tokensCss).toContain(`--ease-exit: ${EASE_OUT};`);
  expect(tokensCss).toContain("--motion-fast: 80ms;");
  expect(tokensCss).toContain("--motion-base: 120ms;");
  expect(tokensCss).toContain("--motion-slow: 180ms;");
  expect(tokensCss).toContain("--motion-canvas: 240ms;");
});

test("motion_ms_gives_the_table_value_normally", () => {
  stubReduce(false);
  expect(reducedMotion()).toBe(false);
  for (const k of Object.keys(MOTION) as MotionKey[]) expect(motionMs(k)).toBe(MOTION[k]);
});

test("reduced_motion_zeroes_every_duration", () => {
  // Windows "Animation effects" off reaches the webview as prefers-reduced-motion.
  stubReduce(true);
  expect(reducedMotion()).toBe(true);
  for (const k of Object.keys(MOTION) as MotionKey[]) expect(motionMs(k)).toBe(0);

  // The app's own reduced-motion preference does the same with the system setting off.
  stubReduce(false);
  setReducedMotionPref(true);
  expect(reducedMotion()).toBe(true);
  for (const k of Object.keys(MOTION) as MotionKey[]) expect(motionMs(k)).toBe(0);
  // CSS follows the preference too: the root carries the flag that zeroes the motion tokens.
  expect(document.documentElement.hasAttribute("data-reduced-motion")).toBe(true);
  expect(tokensCss).toMatch(/:root\[data-reduced-motion\]\s*\{[^}]*--motion-fast:\s*0ms;[^}]*--motion-base:\s*0ms;[^}]*--motion-slow:\s*0ms;[^}]*--motion-canvas:\s*0ms;/);

  setReducedMotionPref(false);
  expect(document.documentElement.hasAttribute("data-reduced-motion")).toBe(false);
  for (const k of Object.keys(MOTION) as MotionKey[]) expect(motionMs(k)).toBe(MOTION[k]);
});

test("reduced_motion_without_match_media_is_off", () => {
  vi.stubGlobal("matchMedia", undefined);
  expect(motionMs("tidy")).toBe(240);
});
