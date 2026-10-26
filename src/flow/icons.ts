// The packed cloud icons on the front end (step 6+, C1b): each icon is fetched from the Core
// only when a diagram shows it, and at most ICON_CACHE_SIZE stay in memory.
//
// Icons are third-party files, so they are only ever shown as an image from a data: URL
// (Ruling P7), never put into the page as markup: whatever an icon holds cannot run.

import { useEffect, useState, useSyncExternalStore } from "react";
import { icon, iconIndex, isCommandError } from "../api/client";
import type { IconEntry } from "../api/types";

export const ICON_CACHE_SIZE = 200;

/** The ink an outline or mono icon is drawn in: the theme's `--c-text` (tokens.css; a test keeps them equal). */
export const ICON_INK = { light: "#1f1f1f", dark: "#f8f8f2" } as const;
export type IconTheme = keyof typeof ICON_INK;

/**
 * What a loaded icon is drawn on in each theme: the canvas (`--c-bg-canvas` in tokens.css; a test keeps them
 * equal), since a service tile with an icon is bare, without its plate.
 */
export const ICON_BG = { light: "#f8f4e3", dark: "#21222c" } as const;

/** WCAG 2.x relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2.x contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Below this contrast with the canvas a logo's own colour is too faint to see. */
const FAINT = 1.5;

/** The ink an icon is asked for in, and whether it draws with a hairline in the text colour. */
export interface IconInk {
  ink: string;
  outline: boolean;
}

/**
 * How icon `entry` is drawn in theme `t` (owner rulings 26 Oct). Logos are exempt from WCAG's contrast rule, so a
 * logo keeps its brand colour down to 1.5:1 on the theme's canvas. Below that, on light it keeps its colour with
 * a hairline in the text colour (a white or yellow logo); on dark it is drawn in the text colour (a black
 * logo). Lucide has no colour of its own; cloud icons ignore the ink.
 */
export function inkFor(entry: IconEntry | undefined, t: IconTheme): IconInk {
  const hex = entry?.hex;
  if (!hex) return { ink: ICON_INK[t], outline: false };
  if (contrastRatio(hex, ICON_BG[t]) >= FAINT) return { ink: hex, outline: false };
  return t === "light" ? { ink: hex, outline: true } : { ink: ICON_INK[t], outline: false };
}

let theme: IconTheme = "light";
const listeners = new Set<() => void>();

/** The theme icons are inked for on screen; App sets it from the painted theme. */
export function setIconTheme(t: IconTheme): void {
  if (t === theme) return;
  theme = t;
  // Only the theme on screen stays in memory; the old one's images are fetched again if it comes back.
  for (const k of [...cache.keys()]) if (!k.startsWith(`${t}:`)) cache.delete(k);
  for (const l of [...listeners]) l();
}

export const getIconTheme = (): IconTheme => theme;

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The icon theme, from the one store (no per-node subscription to prefs). */
export function useIconTheme(): IconTheme {
  return useSyncExternalStore(subscribe, getIconTheme, getIconTheme);
}

/** `"<theme>:<name>"` to data: URL; a Map keeps insertion order, so the first key is the oldest use. */
const cache = new Map<string, string>();
/** Names the pack does not have, so a misspelt icon asks the Core once per session. */
const missing = new Set<string>();
/** Loads in flight (by the cache key), so two nodes with one icon fetch it once. */
const pending = new Map<string, Promise<string | null>>();
let index: Promise<IconEntry[]> | null = null;
/** The index by name, built once from `index`, for each icon's ink. */
let byName: Promise<Map<string, IconEntry>> | null = null;
/** `byName` once it is read, so a drawn icon's outline is known without waiting. */
let logos: Map<string, IconEntry> | null = null;

function svgUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const keyOf = (name: string, t: IconTheme) => `${t}:${name}`;

function remember(key: string, url: string) {
  cache.delete(key);
  cache.set(key, url);
  while (cache.size > ICON_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Icon `name`'s image URL in `t`'s ink when it is in memory, without loading it. */
export function iconUrl(name: string, t: IconTheme = getIconTheme()): string | null {
  return cache.get(keyOf(name, t)) ?? null;
}

/**
 * Whether icon `name` draws with a hairline in `t` (a pale logo on light). Known once the index is read, which
 * is before any icon is in memory; an icon loaded without the index is never outlined.
 */
export function iconOutline(name: string, t: IconTheme = getIconTheme()): boolean {
  return inkFor(logos?.get(name), t).outline;
}

/** How many icons are in memory (tests). */
export const iconCacheSize = (): number => cache.size;

/**
 * Icon `name`'s image URL in `t`'s ink, from memory or the Core. Resolves null when the pack has no such
 * icon (remembered for the session); rejects on any other error, which the next call retries.
 */
export function loadIcon(name: string, t: IconTheme = getIconTheme()): Promise<string | null> {
  if (missing.has(name)) return Promise.resolve(null);
  const key = keyOf(name, t);
  const hit = cache.get(key);
  if (hit !== undefined) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  let load = pending.get(key);
  if (!load) {
    load = inkOf(name, t)
      .then(({ ink, sure }) => icon(name, ink).then((svg) => ({ svg, sure })))
      .then(
        ({ svg, sure }) => {
          const url = svgUrl(svg);
          if (sure) remember(key, url);
          return url;
        },
        (e: unknown) => {
          if (!isCommandError(e) || e.kind !== "notFound") throw e;
          missing.add(name);
          return null;
        },
      )
      .finally(() => pending.delete(key));
    pending.set(key, load);
  }
  return load;
}

export interface IconState {
  /** The image URL once loaded. */
  url: string | null;
  /** The pack has no icon by this name. */
  missing: boolean;
  /** Loading failed for another reason, such as a damaged pack. */
  failed: boolean;
  /** A pale logo on light: drawn with a hairline in the text colour (`icon-hairline`). */
  outline: boolean;
}

/** Icon `name` for an `<img src>`, inked for the current theme; loads it the first time a node shows it. Null loads nothing. */
export function useIcon(name: string | null): IconState {
  const t = useIconTheme();
  const [state, setState] = useState(() => ({ name, t, url: name === null ? null : iconUrl(name, t), missing: false, failed: false }));
  useEffect(() => {
    if (name === null) return;
    let live = true;
    loadIcon(name, t).then(
      (url) => {
        if (live) setState({ name, t, url, missing: url === null, failed: false });
      },
      () => {
        if (live) setState({ name, t, url: null, missing: false, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [name, t]);
  if (name === null) return { url: null, missing: false, failed: false, outline: false };
  if (state.name !== name) return { url: iconUrl(name, t), missing: false, failed: false, outline: iconOutline(name, t) };
  if (state.t !== t) {
    // The same icon in another ink: keep drawing the old image, with its own outline, until the new one arrives.
    const now = iconUrl(name, t);
    return { url: now ?? state.url, missing: state.missing, failed: false, outline: iconOutline(name, now ? t : state.t) };
  }
  return { url: state.url, missing: state.missing, failed: state.failed, outline: state.url !== null && iconOutline(name, t) };
}

/** The engines that have the icon names, so each gets them once per session. */
const sent = new WeakMap<object, Promise<boolean>>();

/**
 * Sends every icon name to the language worker once, for completion after `icon:` and the unknown-icon check.
 * Resolves true once sent; false when the index could not be read (the next call tries again).
 */
export function sendIconNames(client: { setFlowIcons(names: string[]): void }): Promise<boolean> {
  let p = sent.get(client);
  if (!p) {
    p = iconNames().then(
      (names) => {
        client.setFlowIcons(names);
        return true;
      },
      () => {
        sent.delete(client);
        return false;
      },
    );
    sent.set(client, p);
  }
  return p;
}

/** Every icon with its set and title, read from the Core once. */
export function iconEntries(): Promise<IconEntry[]> {
  if (!index) {
    index = iconIndex();
    index.catch(() => {
      index = null;
    });
  }
  return index;
}

/**
 * The ink icon `name` is asked for in `t`. Without the index (it is read from the same pack, so the icons fail
 * too) it is the theme ink, marked unsure so the image is not cached in a guessed ink.
 */
function inkOf(name: string, t: IconTheme): Promise<{ ink: string; sure: boolean }> {
  if (!byName) {
    // Only logos carry a colour of their own; every other icon is drawn in the theme ink.
    const built = iconEntries().then((list) => {
      const m = new Map<string, IconEntry>();
      for (const e of list) if (e.hex) m.set(e.name, e);
      logos = m;
      return m;
    });
    byName = built;
    built.catch(() => {
      if (byName === built) byName = null;
    });
  }
  return byName.then(
    (m) => ({ ink: inkFor(m.get(name), t).ink, sure: true }),
    () => ({ ink: ICON_INK[t], sure: false }),
  );
}

/** Every icon name, read from the Core once (completion, the picker, unknown-icon hints). */
export async function iconNames(): Promise<string[]> {
  return (await iconEntries()).map((e) => e.name);
}

/** Forgets every loaded icon and the index (tests). */
export function resetIcons() {
  cache.clear();
  missing.clear();
  pending.clear();
  index = null;
  byName = null;
  logos = null;
  theme = "light";
}
