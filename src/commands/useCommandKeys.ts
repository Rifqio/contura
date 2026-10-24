import {
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { keymap as loadKeymap, saveKeymap } from "../api/client";
import type { KeymapOverrides } from "../api/types";
import { keysFromEvent, whilePressed } from "./keys";
import { type Keymap, knownOverrides, resolveKeymap } from "./keymap";
import { COMMANDS, type CommandId, REGION_SHARED_KEYS } from "./registry";

export type CommandHandlers = Partial<Record<CommandId, () => void>>;

const APP_IDS = new Set(COMMANDS.filter((c) => c.scope === "app").map((c) => c.id));
const REGION_ONLY = new Set(COMMANDS.filter((c) => c.regionOnly).map((c) => c.id));

/** A command owner: its handlers and the element it draws in, when it has one. */
interface Entry {
  handlers: MutableRefObject<CommandHandlers>;
  region?: RefObject<HTMLElement | null>;
  /** Offered to the Command Palette only: keys never reach it (an editor's own commands run from its keymap). */
  paletteOnly?: boolean;
}

const modalOpen = () => !!document.querySelector('dialog[open], [aria-modal="true"]');

/**
 * WebView2 prints on Ctrl+P and opens print preview on Ctrl+Shift+P; Ctrl+K is Quick Open's second key. These are
 * taken on the way down (capture), so a cell editor or rename box that stops every key cannot let them through.
 */
const BROWSER_PRINT = new Set(["Ctrl+P", "Ctrl+Shift+P", "Ctrl+K"]);

/** An element (and what is inside it) that reads these keys itself: Quick Open's box, the keymap's capture field. */
const OWNS_KEYS = "[data-keys-own]";

/**
 * The one window `keydown` listener and the handlers registered for it. A key bound to an
 * app command is always kept from the browser (PR41), even when nothing handles it here.
 */
class CommandBus {
  private byKey = new Map<string, CommandId[]>();
  private entries: Entry[] = [];
  private users = 0;

  constructor(map: Keymap) {
    this.setMap(map);
  }

  setMap(map: Keymap) {
    const byKey = new Map<string, CommandId[]>();
    for (const [id, keys] of map) {
      if (!APP_IDS.has(id)) continue;
      for (const k of keys) byKey.set(k, [...(byKey.get(k) ?? []), id]);
    }
    this.byKey = byKey;
  }

  /**
   * Runs the best placed handler registered for app command `id`; false when none may run (or
   * for an editor command). While a dialog is open the command is held: true, but nothing runs.
   */
  run(id: CommandId): boolean {
    if (!APP_IDS.has(id)) return false;
    return this.start(this.ownerOf(id, true), id);
  }

  /** The owner that would run `id` now, or null when none may (every owner is in a [hidden] pane). */
  private ownerOf(id: CommandId, keys: boolean): Entry | null {
    // The owner whose region holds focus wins (the innermost of several), then one whose region is
    // on screen, then one without a region. An owner inside a [hidden] pane never runs. Ties go to
    // the latest registered.
    const focus = document.activeElement;
    let best: Entry | null = null;
    let bestRank = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (!entry.handlers.current[id] || (keys && entry.paletteOnly)) continue;
      const el = entry.region?.current ?? null;
      const rank = !el ? 1 : el.closest("[hidden]") ? 0 : focus && el.contains(focus) ? 3 : el.isConnected ? 2 : 1;
      const deeper = rank === 3 && bestRank === 3 && best?.region?.current?.contains(el) && best.region.current !== el;
      if (rank > bestRank || deeper) {
        best = entry;
        bestRank = rank;
      }
    }
    return best;
  }

  /** True when some owner could run `id` now: the Command Palette lists only these (VS Code's when clauses). */
  available(id: CommandId): boolean {
    return this.ownerOf(id, false) !== null;
  }

  /**
   * Runs `id`, an app or an editor command, as the Command Palette does: the editor that registered its commands
   * runs them. Held while a dialog is open, as `run` is. False when no owner may run it.
   */
  invoke(id: CommandId): boolean {
    return this.start(this.ownerOf(id, false), id);
  }

  private start(best: Entry | null, id: CommandId): boolean {
    if (!best) return false;
    if (modalOpen()) return true;
    best.handlers.current[id]!();
    return true;
  }

  /** True when an owner of `id` draws a region that holds focus. */
  private focusedIn(id: CommandId): boolean {
    const focus = document.activeElement;
    return !!focus && this.entries.some((e) => e.handlers.current[id] && e.region?.current?.contains(focus));
  }

  register(entry: Entry): () => void {
    this.entries.push(entry);
    const release = this.retain();
    return () => {
      this.entries = this.entries.filter((e) => e !== entry);
      release();
    };
  }

  /** Keeps the window listener while anyone needs it. */
  retain(): () => void {
    if (this.users++ === 0) {
      window.addEventListener("keydown", this.onPrintKey, true);
      window.addEventListener("keydown", this.onKeyDown);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.users === 0) {
        window.removeEventListener("keydown", this.onPrintKey, true);
        window.removeEventListener("keydown", this.onKeyDown);
      }
    };
  }

  /** The print keys, first of all: never to the browser, and to their command unless the target reads them itself. */
  private onPrintKey = (e: KeyboardEvent) => {
    const keys = keysFromEvent(e);
    if (!keys || !BROWSER_PRINT.has(keys)) return;
    e.preventDefault();
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(OWNS_KEYS)) return;
    // Handled here, once: nothing below (an editor's keymap, the bubble listener) runs it again.
    e.stopPropagation();
    for (const id of this.byKey.get(keys) ?? []) if (this.run(id)) return;
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const keys = keysFromEvent(e);
    const ids = keys ? this.byKey.get(keys) : undefined;
    if (!ids) return;
    // Keys of commands that act only in their region are left to the page (a text field, the SQL editor) elsewhere.
    if (ids.every((id) => REGION_ONLY.has(id) && !this.focusedIn(id))) return;
    e.preventDefault();
    // Two commands may share a key when one is scoped to a region (Ctrl+N: New chat in the Ask panel, else New Connection):
    // the one whose region holds focus goes first.
    // The region-scoped one of a shared pair never runs unless focus is in its region.
    const scoped = new Set(REGION_SHARED_KEYS.filter((r) => r.keys === keys).map((r) => r.ids[1]));
    const usable = ids.length > 1 ? ids.filter((id) => !scoped.has(id) || this.focusedIn(id)) : ids;
    const ordered = usable.length > 1 ? [...usable].sort((a, b) => Number(this.focusedIn(b)) - Number(this.focusedIn(a))) : usable;
    whilePressed(keys!, () => {
      for (const id of ordered) if (this.run(id)) return;
    });
  };
}

interface KeymapValue {
  map: Keymap;
  overrides: KeymapOverrides;
  save(o: KeymapOverrides): Promise<void>;
  /** Runs an app command's handler, for keys pressed inside an editor; false when nothing handles it. */
  run(id: CommandId): boolean;
  /** Whether an owner could run the command now (the Command Palette hides the others). */
  available(id: CommandId): boolean;
  /** Runs an app or editor command from the Command Palette; false when nothing handles it. */
  invoke(id: CommandId): boolean;
}

type KeymapContextValue = KeymapValue & { bus: CommandBus };

const DEFAULT_MAP = resolveKeymap({});
// Without a provider (single components in tests) the defaults apply and nothing is saved.
const fallbackBus = new CommandBus(DEFAULT_MAP);
const FALLBACK: KeymapContextValue = {
  map: DEFAULT_MAP,
  overrides: {},
  save: () => Promise.reject(new Error("No keymap to save to.")),
  run: (id) => fallbackBus.run(id),
  available: (id) => fallbackBus.available(id),
  invoke: (id) => fallbackBus.invoke(id),
  bus: fallbackBus,
};

const KeymapContext = createContext<KeymapContextValue | null>(null);

/**
 * Loads the keymap overrides and owns the one window key listener. A save made before the
 * stored overrides are read (or after reading them failed) goes over the stored copy, so it
 * never wipes them, and a read that answers late never replaces a save.
 */
export function KeymapProvider({ children }: { children: ReactNode }) {
  const [overrides, setOverrides] = useState<KeymapOverrides>({});
  const [bus] = useState(() => new CommandBus(DEFAULT_MAP));
  const map = useMemo(() => resolveKeymap(overrides), [overrides]);
  useLayoutEffect(() => bus.setMap(map), [bus, map]);

  useEffect(() => bus.retain(), [bus]);

  /** The stored overrides once read, else null. */
  const stored = useRef<KeymapOverrides | null>(null);
  const saved = useRef(false);
  /** Saves run one at a time, after the first read. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let live = true;
    const read = loadKeymap()
      .then((o) => {
        stored.current = knownOverrides(o ?? {});
        if (live && !saved.current) setOverrides(stored.current);
      })
      .catch(() => {
        // The defaults stand; a save reads them once more first.
      });
    queue.current = queue.current.then(() => read);
    return () => {
      live = false;
    };
  }, []);

  const save = (o: KeymapOverrides): Promise<void> => {
    // Made from what was on screen: before the read that is only the defaults, so it goes over the stored copy.
    const partial = stored.current === null;
    const job = queue.current.then(async () => {
      let next = o;
      if (partial) {
        if (stored.current === null) {
          try {
            stored.current = knownOverrides((await loadKeymap()) ?? {});
          } catch {
            // Still unreadable: save what was asked over nothing.
          }
        }
        next = { ...(stored.current ?? {}), ...o };
      }
      await saveKeymap(next);
      saved.current = true;
      stored.current = next;
      setOverrides(next);
    });
    queue.current = job.catch(() => {});
    return job;
  };

  const value = useMemo<KeymapContextValue>(
    () => ({ map, overrides, save, run: (id) => bus.run(id), available: (id) => bus.available(id), invoke: (id) => bus.invoke(id), bus }),
    // `save` reads only refs.
    [bus, map, overrides],
  );
  return createElement(KeymapContext.Provider, { value }, children);
}

export function useKeymap(): KeymapValue {
  return useContext(KeymapContext) ?? FALLBACK;
}

/**
 * Handles app commands from anywhere in the window. Keys already handled (an editor or a
 * grid) are skipped; every key bound to an app command is kept from the browser (PR41).
 * `region` is the element the owner draws in: focus inside it, or being on screen, puts this
 * owner ahead of others for the same command, and inside a [hidden] pane it never runs.
 * With `paletteOnly` the handlers run only from the Command Palette, never from a key.
 */
export function useCommandKeys(handlers: CommandHandlers, opts?: { region?: RefObject<HTMLElement | null>; paletteOnly?: boolean }): void {
  const bus = (useContext(KeymapContext) ?? FALLBACK).bus;
  const ref = useRef(handlers);
  ref.current = handlers;
  const region = opts?.region;
  const paletteOnly = opts?.paletteOnly ?? false;
  useEffect(() => bus.register({ handlers: ref, region, paletteOnly }), [bus, region, paletteOnly]);
}
