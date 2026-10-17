import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import { useTheme } from "../theme/useTheme";
import { PrefsProvider, applyPrefs, usePrefs } from "./usePrefs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => <PrefsProvider>{children}</PrefsProvider>;
const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never;
});

test("choosing_a_theme_keeps_the_other_prefs", async () => {
  routeInvoke({
    ui_prefs: () => ({ ...DEFAULT_UI_PREFS, theme: "dark", rowHeight: 24, historyKeepDays: 30 }),
    save_ui_prefs: () => null,
  });
  const { result } = renderHook(() => ({ theme: useTheme(), prefs: usePrefs() }), { wrapper });
  await waitFor(() => expect(result.current.prefs.prefs.rowHeight).toBe(24));
  act(() => result.current.theme.choose("light"));
  expect(callsTo("save_ui_prefs")).toEqual([
    { prefs: { ...DEFAULT_UI_PREFS, theme: "light", rowHeight: 24, historyKeepDays: 30 } },
  ]);
  expect(result.current.prefs.prefs.theme).toBe("light");
  expect(root().getAttribute("data-theme")).toBe("light");
});

test("update_merges_applies_and_saves_the_whole_struct", async () => {
  routeInvoke({ ui_prefs: () => ({ ...DEFAULT_UI_PREFS, historyKeepDays: 7 }), save_ui_prefs: () => null });
  const { result } = renderHook(() => usePrefs(), { wrapper });
  await waitFor(() => expect(result.current.prefs.historyKeepDays).toBe(7));
  act(() => result.current.update({ rowHeight: 24 }));
  act(() => result.current.update({ brighterComments: true }));
  expect(callsTo("save_ui_prefs").slice(-1)[0]).toEqual({
    prefs: { ...DEFAULT_UI_PREFS, historyKeepDays: 7, rowHeight: 24, brighterComments: true },
  });
  expect(root().getAttribute("data-density")).toBe("compact");
  expect(root().hasAttribute("data-brighter-comments")).toBe(true);
});

test("an_update_before_the_core_answers_is_kept_over_the_stored_prefs", async () => {
  let answer: (v: unknown) => void = () => {};
  routeInvoke({ ui_prefs: () => new Promise((r) => (answer = r)), save_ui_prefs: () => null });
  const { result } = renderHook(() => usePrefs(), { wrapper });
  act(() => result.current.update({ rowHeight: 24 }));
  // Saving now would write the defaults over what is stored.
  expect(callsTo("save_ui_prefs")).toEqual([]);
  await act(async () => answer({ ...DEFAULT_UI_PREFS, historyKeepDays: 30 }));
  expect(result.current.prefs).toEqual({ ...DEFAULT_UI_PREFS, historyKeepDays: 30, rowHeight: 24 });
  expect(callsTo("save_ui_prefs")).toEqual([{ prefs: { ...DEFAULT_UI_PREFS, historyKeepDays: 30, rowHeight: 24 } }]);
});

test("after_a_failed_read_the_first_update_reads_again_before_saving", async () => {
  let reads = 0;
  routeInvoke({
    ui_prefs: () => {
      if (reads++ === 0) throw { kind: "storage", message: "no" };
      return { ...DEFAULT_UI_PREFS, historyKeepDays: 30 };
    },
    save_ui_prefs: () => null,
  });
  const { result } = renderHook(() => usePrefs(), { wrapper });
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  act(() => result.current.update({ rowHeight: 24 }));
  await waitFor(() => expect(callsTo("save_ui_prefs")).toHaveLength(1));
  expect(callsTo("ui_prefs")).toHaveLength(2);
  expect(callsTo("save_ui_prefs")).toEqual([{ prefs: { ...DEFAULT_UI_PREFS, historyKeepDays: 30, rowHeight: 24 } }]);
  expect(result.current.prefs.historyKeepDays).toBe(30);
});

test("when_the_read_fails_twice_the_update_saves_over_the_defaults", async () => {
  routeInvoke({
    ui_prefs: () => {
      throw { kind: "storage", message: "no" };
    },
    save_ui_prefs: () => null,
  });
  const { result } = renderHook(() => usePrefs(), { wrapper });
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  act(() => result.current.update({ rowHeight: 24 }));
  await waitFor(() => expect(callsTo("save_ui_prefs")).toHaveLength(1));
  expect(callsTo("ui_prefs")).toHaveLength(2);
  expect(callsTo("save_ui_prefs")).toEqual([{ prefs: { ...DEFAULT_UI_PREFS, rowHeight: 24 } }]);
});

test("apply_prefs_sets_density_and_editor_variables", () => {
  const el = document.createElement("div");
  applyPrefs(el, {
    ...DEFAULT_UI_PREFS,
    rowHeight: 24,
    brighterComments: true,
    editor: { family: "Fira Code", size: 14, lineHeight: 22, ligatures: false },
  });
  expect(el.getAttribute("data-density")).toBe("compact");
  expect(el.hasAttribute("data-brighter-comments")).toBe(true);
  expect(el.style.getPropertyValue("--editor-font-family")).toBe('"Fira Code", var(--font-family-code)');
  expect(el.style.getPropertyValue("--editor-font-size")).toBe("14px");
  expect(el.style.getPropertyValue("--editor-line-height")).toBe("22px");
  expect(el.style.getPropertyValue("--editor-ligatures")).toBe("none");
  expect(el.style.getPropertyValue("--editor-features")).toBe('"calt" 0, "liga" 0');

  applyPrefs(el, DEFAULT_UI_PREFS);
  expect(el.hasAttribute("data-density")).toBe(false);
  expect(el.hasAttribute("data-brighter-comments")).toBe(false);
  expect(el.style.getPropertyValue("--editor-font-size")).toBe("13px");
  expect(el.style.getPropertyValue("--editor-ligatures")).toBe("contextual");
  expect(el.style.getPropertyValue("--editor-features")).toBe('"calt" 1, "liga" 1');
});
