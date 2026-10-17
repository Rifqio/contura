import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import { THEME_MIRROR_KEY, applyStoredTheme, applyTheme, readMirror } from "./theme";
import { PrefsProvider } from "../prefs/usePrefs";
import { effectiveTheme, themeReducer, useTheme } from "./useTheme";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const root = () => document.documentElement;
// The theme lives in the one prefs holder; usePrefs.test.tsx checks that choosing keeps the other prefs.
const wrapper = ({ children }: { children: ReactNode }) => createElement(PrefsProvider, null, children);

/** A fake `matchMedia` whose listeners the test can see and fire. */
function fakeMatchMedia(matches: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const add = vi.fn((_: string, l: (e: { matches: boolean }) => void) => listeners.add(l));
  const remove = vi.fn((_: string, l: (e: { matches: boolean }) => void) => listeners.delete(l));
  window.matchMedia = vi.fn(() => ({ matches, addEventListener: add, removeEventListener: remove })) as never;
  return { add, remove, fire: (m: boolean) => listeners.forEach((l) => l({ matches: m })), listeners };
}

beforeEach(() => {
  localStorage.clear();
  root().removeAttribute("data-theme");
  fakeMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyTheme", () => {
  test("sets light", () => {
    applyTheme(root(), "light");
    expect(root().getAttribute("data-theme")).toBe("light");
  });
  test("sets dark", () => {
    applyTheme(root(), "dark");
    expect(root().getAttribute("data-theme")).toBe("dark");
  });
  test("removes the attribute for system", () => {
    applyTheme(root(), "dark");
    applyTheme(root(), "system");
    expect(root().hasAttribute("data-theme")).toBe(false);
  });
});

describe("readMirror", () => {
  test("gives dark when empty", () => {
    expect(readMirror()).toBe("dark");
  });
  test("gives dark for an unknown value", () => {
    localStorage.setItem(THEME_MIRROR_KEY, "sepia");
    expect(readMirror()).toBe("dark");
  });
  test("gives dark when getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readMirror()).toBe("dark");
  });
  test("gives the stored choice", () => {
    localStorage.setItem(THEME_MIRROR_KEY, "system");
    expect(readMirror()).toBe("system");
  });
});

test("reducer_effective_follows_windows_only_for_system", () => {
  let s = themeReducer({ choice: "dark", systemDark: false }, { type: "systemChanged", systemDark: false });
  expect(effectiveTheme(s)).toBe("dark");
  s = themeReducer(s, { type: "chosen", choice: "light" });
  s = themeReducer(s, { type: "systemChanged", systemDark: true });
  expect(effectiveTheme(s)).toBe("light");
  s = themeReducer(s, { type: "loaded", choice: "system" });
  expect(s.choice).toBe("system");
  expect(effectiveTheme(s)).toBe("dark");
  s = themeReducer(s, { type: "systemChanged", systemDark: false });
  expect(effectiveTheme(s)).toBe("light");
});

test("first_render_has_the_mirrored_attribute", () => {
  localStorage.setItem(THEME_MIRROR_KEY, "light");
  applyStoredTheme();
  expect(root().getAttribute("data-theme")).toBe("light");
});

test("nothing_saved_paints_dracula_first", () => {
  applyStoredTheme();
  expect(root().getAttribute("data-theme")).toBe("dark");
});

test("core_choice_wins_and_rewrites_the_mirror", async () => {
  localStorage.setItem(THEME_MIRROR_KEY, "dark");
  applyStoredTheme();
  routeInvoke({ ui_prefs: () => ({ theme: "light" }) });
  const { result } = renderHook(() => useTheme(), { wrapper });
  await waitFor(() => expect(result.current.choice).toBe("light"));
  expect(root().getAttribute("data-theme")).toBe("light");
  expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("light");
  expect(result.current.effective).toBe("light");
});

test("choose_saves_through_the_core", async () => {
  routeInvoke({ ui_prefs: () => ({ theme: "dark" }), save_ui_prefs: () => null });
  const { result } = renderHook(() => useTheme(), { wrapper });
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  await waitFor(() => expect(root().getAttribute("data-theme")).toBe("dark"));
  act(() => result.current.choose("system"));
  expect(root().hasAttribute("data-theme")).toBe(false);
  expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("system");
  expect(result.current.choice).toBe("system");
  expect(callsTo("save_ui_prefs")).toEqual([{ prefs: { ...DEFAULT_UI_PREFS, theme: "system" } }]);
});

test("listens_to_windows_only_when_following", async () => {
  const mm = fakeMatchMedia(false);
  routeInvoke({ ui_prefs: () => ({ theme: "dark" }), save_ui_prefs: () => null });
  const { result } = renderHook(() => useTheme(), { wrapper });
  await waitFor(() => expect(result.current.choice).toBe("dark"));
  expect(mm.add).not.toHaveBeenCalled();

  act(() => result.current.choose("system"));
  expect(mm.add).toHaveBeenCalledTimes(1);
  expect(result.current.effective).toBe("light");
  act(() => mm.fire(true));
  expect(result.current.effective).toBe("dark");

  act(() => result.current.choose("light"));
  expect(mm.remove).toHaveBeenCalledTimes(1);
  expect(mm.listeners.size).toBe(0);
});

test("system_on_dark_windows_reads_dark_from_the_first_render", async () => {
  localStorage.setItem(THEME_MIRROR_KEY, "system");
  fakeMatchMedia(true);
  routeInvoke({ ui_prefs: () => ({ theme: "system" }) });
  const seen: string[] = [];
  renderHook(() => {
    const t = useTheme();
    seen.push(t.effective);
    return t;
  }, { wrapper });
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((e) => e === "dark")).toBe(true);
});

test("a_failed_core_read_keeps_the_mirrored_choice", async () => {
  localStorage.setItem(THEME_MIRROR_KEY, "light");
  routeInvoke({
    ui_prefs: () => {
      throw { kind: "storage", message: "no" };
    },
  });
  const { result } = renderHook(() => useTheme(), { wrapper });
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  expect(result.current.choice).toBe("light");
});
