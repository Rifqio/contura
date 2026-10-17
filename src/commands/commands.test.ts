import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import { keysFromEvent, normalizeKeys, toCodeMirror } from "./keys";
import { applyRebind, findClash, hintFor, keyProblem, keysFor, resetCommand, resolveKeymap } from "./keymap";
import { COMMANDS } from "./registry";
import { KeymapProvider, useCommandKeys, useKeymap } from "./useCommandKeys";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

test("normalize_orders_modifiers", () => {
  expect(normalizeKeys("shift+ctrl+enter")).toBe("Ctrl+Shift+Enter");
  expect(normalizeKeys("ctrl+,")).toBe("Ctrl+,");
  expect(normalizeKeys("alt+shift+f")).toBe("Shift+Alt+F");
  expect(normalizeKeys("alt+arrowup")).toBe("Alt+ArrowUp");
  expect(normalizeKeys("f5")).toBe("F5");
});

test("keys_from_event_use_the_physical_key", () => {
  expect(keysFromEvent(ev({ ctrlKey: true, shiftKey: true, code: "KeyF", key: "F" }))).toBe("Ctrl+Shift+F");
  expect(keysFromEvent(ev({ ctrlKey: true, code: "Digit1", key: "1" }))).toBe("Ctrl+1");
  expect(keysFromEvent(ev({ shiftKey: true, code: "ShiftLeft", key: "Shift" }))).toBeNull();
  expect(keysFromEvent(ev({ ctrlKey: true, altKey: true, code: "KeyI", key: "ˆ" }))).toBe("Ctrl+Alt+I");
  expect(keysFromEvent(ev({ key: "F5", code: "F5" }))).toBe("F5");
  expect(keysFromEvent(ev({ ctrlKey: true, key: "," , code: "Comma" }))).toBe("Ctrl+,");
});

test("to_code_mirror", () => {
  expect(toCodeMirror("Ctrl+Shift+Enter")).toBe("Ctrl-Shift-Enter");
  expect(toCodeMirror("Shift+Alt+F")).toBe("Shift-Alt-f");
  expect(toCodeMirror("Ctrl+,")).toBe("Ctrl-,");
  expect(toCodeMirror("F5")).toBe("F5");
});

test("default_keys_are_unique_per_scope", () => {
  for (const scope of ["app", "editor"] as const) {
    const keys = COMMANDS.filter((c) => c.scope === scope).flatMap((c) => c.keys);
    expect(new Set(keys).size).toBe(keys.length);
  }
  // Every default is already in its printed form.
  for (const c of COMMANDS) for (const k of c.keys) expect(normalizeKeys(k)).toBe(k);
});

test("the_registry_has_the_defaults", () => {
  const map = resolveKeymap({});
  expect(keysFor(map, "query.run")).toEqual(["Ctrl+Enter"]);
  expect(keysFor(map, "editor.quickFix")).toEqual(["Ctrl+.", "Alt+Enter"]);
  expect(keysFor(map, "group.open.9")).toEqual(["Ctrl+9"]);
  expect(hintFor(map, "settings.open")).toBe("Ctrl+,");
  expect(hintFor(map, "query.explain")).toBeNull();
  expect(hintFor(map, "history.toggle")).toBeNull();
});

test("find_clash_names_the_other_command", () => {
  const map = resolveKeymap({});
  expect(findClash(map, "query.run", "Ctrl+T")).toEqual({ kind: "command", id: "query.new", title: "New query" });
  expect(findClash(map, "query.new", "Ctrl+T")).toBeNull();
  expect(findClash(map, "query.run", "Ctrl+Q")).toBeNull();
});

test("find_clash_names_the_editor_key", () => {
  const map = resolveKeymap({});
  expect(findClash(map, "query.run", "Ctrl+Z")).toEqual({ kind: "editor", title: "Undo" });
  expect(findClash(map, "query.run", "Shift+Alt+ArrowDown")).toEqual({ kind: "editor", title: "Copy line down" });
});

test("key_problem_rules", () => {
  expect(keyProblem("A")).toBe("Choose keys with Ctrl, Alt or Shift, or a function key.");
  expect(keyProblem("Tab")).toBe("Tab and Escape cannot be shortcuts.");
  expect(keyProblem("Escape")).toBe("Tab and Escape cannot be shortcuts.");
  expect(keyProblem("Shift+A")).toBe("Choose keys with Ctrl, Alt or Shift, or a function key.");
  expect(keyProblem("F5")).toBeNull();
  expect(keyProblem("Ctrl+Tab")).toBeNull();
  expect(keyProblem("Shift+Enter")).toBeNull();
});

test("confirming_a_clash_moves_the_keys", () => {
  const map = resolveKeymap({});
  expect(applyRebind({}, map, "query.run", "Ctrl+T")).toEqual({ "query.run": ["Ctrl+T"], "query.new": [] });
  // A command with two keys keeps the one not taken.
  expect(applyRebind({}, map, "query.run", "Alt+Enter")).toEqual({
    "query.run": ["Alt+Enter"],
    "editor.quickFix": ["Ctrl+."],
  });
  const moved = resolveKeymap(applyRebind({}, map, "query.run", "Ctrl+T"));
  expect(keysFor(moved, "query.run")).toEqual(["Ctrl+T"]);
  expect(keysFor(moved, "query.new")).toEqual([]);
});

test("reset_removes_the_override", () => {
  const o = { "query.run": ["Ctrl+T"], "query.new": [] };
  expect(resetCommand(o, "query.run")).toEqual({ "query.new": [] });
  expect(o).toEqual({ "query.run": ["Ctrl+T"], "query.new": [] });
  expect(keysFor(resolveKeymap(resetCommand(o, "query.run")), "query.run")).toEqual(["Ctrl+Enter"]);
});

test("unknown_ids_in_overrides_are_ignored", () => {
  const map = resolveKeymap({ "no.such": ["Ctrl+Q"], "query.save": ["ctrl+shift+s"] });
  expect([...map.keys()]).toEqual(COMMANDS.map((c) => c.id));
  expect(keysFor(map, "query.save")).toEqual(["Ctrl+Shift+S"]);
});

describe("useCommandKeys", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("runs_app_commands_and_prevents_every_registry_key", () => {
    const onNew = vi.fn();
    renderHook(() => useCommandKeys({ "query.new": onNew }));
    const t = ev({ ctrlKey: true, key: "t", code: "KeyT" });
    window.dispatchEvent(t);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(t.defaultPrevented).toBe(true);
    // F5 has no handler here, yet WebView2 must never reload.
    const f5 = ev({ key: "F5", code: "F5" });
    window.dispatchEvent(f5);
    expect(f5.defaultPrevented).toBe(true);
    const plain = ev({ key: "a", code: "KeyA" });
    window.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });

  test("skips_keys_already_handled_and_editor_commands", () => {
    const onNew = vi.fn();
    const onRun = vi.fn();
    renderHook(() => useCommandKeys({ "query.new": onNew, "query.run": onRun }));
    const t = ev({ ctrlKey: true, key: "t", code: "KeyT" });
    t.preventDefault();
    window.dispatchEvent(t);
    expect(onNew).not.toHaveBeenCalled();
    window.dispatchEvent(ev({ ctrlKey: true, key: "Enter", code: "Enter" }));
    expect(onRun).not.toHaveBeenCalled();
  });

  test("an_open_dialog_holds_the_commands", () => {
    const toggle = vi.fn();
    renderHook(() => useCommandKeys({ "assistant.toggle": toggle }));
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    const e = ev({ ctrlKey: true, altKey: true, key: "i", code: "KeyI" });
    window.dispatchEvent(e);
    expect(toggle).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  test("the_latest_handler_for_a_command_wins_and_unmount_removes_it", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    renderHook(() => useCommandKeys({ "tree.filter": outer }));
    const { unmount } = renderHook(() => useCommandKeys({ "tree.filter": inner }));
    const f = () => window.dispatchEvent(ev({ ctrlKey: true, shiftKey: true, key: "F", code: "KeyF" }));
    f();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    unmount();
    f();
    expect(outer).toHaveBeenCalledTimes(1);
  });

  const filterKey = () => {
    const e = ev({ ctrlKey: true, shiftKey: true, key: "F", code: "KeyF" });
    window.dispatchEvent(e);
    return e;
  };
  const pane = (parent: HTMLElement = document.body) => {
    const el = document.createElement("div");
    parent.appendChild(el);
    return el;
  };
  const focusIn = (el: HTMLElement) => {
    const input = document.createElement("input");
    el.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
  };

  test("a_focused_owner_wins_over_a_later_visible_one", () => {
    const focused = vi.fn();
    const visible = vi.fn();
    const a = pane();
    const b = pane();
    focusIn(a);
    renderHook(() => useCommandKeys({ "tree.filter": focused }, { region: { current: a } }));
    renderHook(() => useCommandKeys({ "tree.filter": visible }, { region: { current: b } }));
    filterKey();
    expect(focused).toHaveBeenCalledTimes(1);
    expect(visible).not.toHaveBeenCalled();
  });

  test("the_innermost_focused_owner_wins", () => {
    const inner = vi.fn();
    const outer = vi.fn();
    const out = pane();
    const inn = pane(out);
    focusIn(inn);
    renderHook(() => useCommandKeys({ "tree.filter": inner }, { region: { current: inn } }));
    renderHook(() => useCommandKeys({ "tree.filter": outer }, { region: { current: out } }));
    filterKey();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  test("a_visible_owner_wins_over_a_later_owner_in_a_hidden_pane", () => {
    const visible = vi.fn();
    const hidden = vi.fn();
    const shown = pane();
    const cover = pane();
    cover.hidden = true;
    const under = pane(cover);
    renderHook(() => useCommandKeys({ "tree.filter": visible }, { region: { current: shown } }));
    renderHook(() => useCommandKeys({ "tree.filter": hidden }, { region: { current: under } }));
    filterKey();
    expect(visible).toHaveBeenCalledTimes(1);
    expect(hidden).not.toHaveBeenCalled();
  });

  test("an_owner_in_a_hidden_pane_never_runs_and_the_key_is_still_kept_from_the_browser", () => {
    const hidden = vi.fn();
    const cover = pane();
    cover.hidden = true;
    const under = pane(cover);
    focusIn(pane());
    renderHook(() => useCommandKeys({ "tree.filter": hidden }, { region: { current: under } }));
    const e = filterKey();
    expect(hidden).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  test("a_region_owner_wins_over_a_global_owner_registered_later", () => {
    const owner = vi.fn();
    const global = vi.fn();
    const shown = pane();
    renderHook(() => useCommandKeys({ "tree.filter": owner }, { region: { current: shown } }));
    renderHook(() => useCommandKeys({ "tree.filter": global }));
    filterKey();
    expect(owner).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });

  test("an_open_dialog_still_holds_a_region_command", () => {
    const owner = vi.fn();
    const shown = pane();
    focusIn(shown);
    renderHook(() => useCommandKeys({ "tree.filter": owner }, { region: { current: shown } }));
    const dialog = pane();
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const e = filterKey();
    expect(owner).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("KeymapProvider", () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(KeymapProvider, null, children);
  const stored = { "query.new": ["Ctrl+Q"] };

  test("a_save_before_the_load_goes_over_the_stored_overrides_and_the_load_never_replaces_it", async () => {
    let answer: (v: unknown) => void = () => {};
    routeInvoke({ keymap: () => new Promise((r) => (answer = r)), save_keymap: () => null });
    const { result } = renderHook(() => useKeymap(), { wrapper });
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.save({ "query.run": ["F9"] });
    });
    expect(callsTo("save_keymap")).toEqual([]);
    await act(async () => {
      answer(stored);
      await saving;
    });
    const merged = { "query.new": ["Ctrl+Q"], "query.run": ["F9"] };
    expect(callsTo("save_keymap")).toEqual([{ overrides: merged }]);
    expect(result.current.overrides).toEqual(merged);
    expect(keysFor(result.current.map, "query.run")).toEqual(["F9"]);
  });

  test("a_save_after_the_load_replaces_the_overrides", async () => {
    routeInvoke({ keymap: () => stored, save_keymap: () => null });
    const { result } = renderHook(() => useKeymap(), { wrapper });
    await waitFor(() => expect(result.current.overrides).toEqual(stored));
    await act(() => result.current.save({ "query.run": ["F9"] }));
    expect(callsTo("save_keymap")).toEqual([{ overrides: { "query.run": ["F9"] } }]);
    expect(result.current.overrides).toEqual({ "query.run": ["F9"] });
  });

  test("a_save_after_a_failed_load_reads_again_first", async () => {
    let reads = 0;
    routeInvoke({
      keymap: () => {
        if (reads++ === 0) throw { kind: "storage", message: "no" };
        return stored;
      },
      save_keymap: () => null,
    });
    const { result } = renderHook(() => useKeymap(), { wrapper });
    await waitFor(() => expect(callsTo("keymap")).toHaveLength(1));
    await act(() => result.current.save({ "query.run": ["F9"] }));
    expect(callsTo("keymap")).toHaveLength(2);
    expect(callsTo("save_keymap")).toEqual([{ overrides: { "query.new": ["Ctrl+Q"], "query.run": ["F9"] } }]);
  });

  test("a_save_when_the_keymap_stays_unreadable_saves_what_was_asked", async () => {
    routeInvoke({
      keymap: () => {
        throw { kind: "storage", message: "no" };
      },
      save_keymap: () => null,
    });
    const { result } = renderHook(() => useKeymap(), { wrapper });
    await waitFor(() => expect(callsTo("keymap")).toHaveLength(1));
    await act(() => result.current.save({ "query.run": ["F9"] }));
    expect(callsTo("save_keymap")).toEqual([{ overrides: { "query.run": ["F9"] } }]);
  });

  test("an_open_dialog_holds_a_command_run_from_an_editor_and_editor_ids_never_reach_app_handlers", () => {
    routeInvoke({ keymap: () => ({}), save_keymap: () => null });
    const onNew = vi.fn();
    const onRun = vi.fn();
    const { result } = renderHook(
      () => {
        useCommandKeys({ "query.new": onNew, "query.run": onRun });
        return useKeymap();
      },
      { wrapper },
    );
    expect(result.current.run("query.run")).toBe(false);
    expect(onRun).not.toHaveBeenCalled();
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    expect(result.current.run("query.new")).toBe(true);
    expect(onNew).not.toHaveBeenCalled();
    document.body.innerHTML = "";
    expect(result.current.run("query.new")).toBe(true);
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});
