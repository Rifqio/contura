// The packed cloud icons on the front end (step 6+, C1b): each icon is fetched from the Core
// only when a diagram shows it, and at most ICON_CACHE_SIZE stay in memory.
//
// Icons are third-party files, so they are only ever shown as an image from a data: URL
// (Ruling P7), never put into the page as markup: whatever an icon holds cannot run.

import { useEffect, useState } from "react";
import { icon, iconIndex, isCommandError } from "../api/client";
import type { IconEntry } from "../api/types";
import { providerOf } from "../lang/flow/iconRank";

export const ICON_CACHE_SIZE = 200;

/** Name to data: URL; a Map keeps insertion order, so the first key is the oldest use. */
const cache = new Map<string, string>();
/** Names the pack does not have, so a misspelt icon asks the Core once per session. */
const missing = new Set<string>();
/** Loads in flight, so two nodes with one icon fetch it once. */
const pending = new Map<string, Promise<string | null>>();
let index: Promise<IconEntry[]> | null = null;

function svgUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function remember(name: string, url: string) {
  cache.delete(name);
  cache.set(name, url);
  while (cache.size > ICON_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Icon `name`'s image URL when it is in memory, without loading it. */
export function iconUrl(name: string): string | null {
  return cache.get(name) ?? null;
}

/**
 * Icon `name`'s image URL, from memory or the Core. Resolves null when the pack has no such
 * icon (remembered for the session); rejects on any other error, which the next call retries.
 */
export function loadIcon(name: string): Promise<string | null> {
  if (missing.has(name)) return Promise.resolve(null);
  const hit = cache.get(name);
  if (hit !== undefined) {
    remember(name, hit);
    return Promise.resolve(hit);
  }
  let load = pending.get(name);
  if (!load) {
    load = icon(name)
      .then(
        (svg) => {
          const url = svgUrl(svg);
          remember(name, url);
          return url;
        },
        (e: unknown) => {
          if (!isCommandError(e) || e.kind !== "notFound") throw e;
          missing.add(name);
          return null;
        },
      )
      .finally(() => pending.delete(name));
    pending.set(name, load);
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
}

/** Icon `name` for an `<img src>`; loads it the first time a node shows it. Null loads nothing. */
export function useIcon(name: string | null): IconState {
  const [state, setState] = useState(() => ({ name, url: name === null ? null : iconUrl(name), missing: false, failed: false }));
  useEffect(() => {
    if (name === null) return;
    let live = true;
    loadIcon(name).then(
      (url) => {
        if (live) setState({ name, url, missing: url === null, failed: false });
      },
      () => {
        if (live) setState({ name, url: null, missing: false, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [name]);
  if (name === null) return { url: null, missing: false, failed: false };
  if (state.name !== name) return { url: iconUrl(name), missing: false, failed: false };
  return { url: state.url, missing: state.missing, failed: state.failed };
}

/**
 * True when the icon needs the light plate behind it: general (Lucide) and brand icons draw black inside an
 * `<img>`, which a dark theme would hide. Provider icons bring their own coloured square and draw without it,
 * as frame 6+.5 shows them.
 */
export function iconPlate(name: string): boolean {
  return providerOf(name) === null;
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
}
