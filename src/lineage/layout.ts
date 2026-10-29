// Lineage's moved cards: one layout file per Connection and table, kept by the Core
// in Contura's diagrams folder. Moves are saved after a short pause; Reset removes the file.
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteLineageLayout, readLineageLayout, writeLineageLayout } from "../api/client";
import type { ConnectionId, ObjectPath } from "../api/types";
import { parseLayoutFile, serializeLayoutFile } from "../diagram/layout";
import type { Positions } from "./scene";
import { tableId } from "./scene";

/** How long after the last move the layout is saved. */
export const LAYOUT_SAVE_MS = 400;

/** The positions object's name in the file: `{ version: 1, cards: { ... } }`. */
const KEY = "cards";

/** Card keys the file keeps: table cards (`t:`) and diagram or view cards (`r:`). */
const isCardKey = (k: string) => k.startsWith("t:") || k.startsWith("r:");

export function layoutText(moves: Positions): string {
  return serializeLayoutFile({ version: 1, nodes: moves }, KEY);
}

/** The moved cards in a layout file; anything unreadable is nothing moved. */
export function readLayoutText(text: string): Positions {
  const out: Positions = {};
  for (const [k, v] of Object.entries(parseLayoutFile(text, KEY).nodes)) if (isCardKey(k)) out[k] = v;
  return out;
}

/**
 * The layout file's key for canvas node `id`: a diagram or view card (`ref:<i>`) is kept by its row's stable
 * key, so it keeps its place when the rows change; a table card's id is already stable. A row that is gone
 * keeps the node id, which the file drops.
 */
export function keyFor(id: string, refs: readonly { key: string }[] | null): string {
  const m = /^ref:(\d+)$/.exec(id);
  return (m && refs?.[Number(m[1])]?.key) || id;
}

type Waiting ={ id: ConnectionId; path: ObjectPath; text: string; timer: ReturnType<typeof setTimeout> };

export interface LineageLayout {
  /** Moved cards by their stable key. */
  moves: Positions;
  move(key: string, at: { x: number; y: number }): void;
  /** Puts every card back and removes the file. */
  reset(): void;
}

export function useLineageLayout(id: ConnectionId, path: ObjectPath): LineageLayout {
  const [moves, setMoves] = useState<Positions>({});
  const current = useRef<Positions>({});
  const waiting = useRef<Waiting | null>(null);
  /** Moved or reset since the file was asked for: the answer must not undo it. */
  const edited = useRef(false);
  /** Reset since the file was asked for: the saved moves are dropped when it answers (P18). */
  const wasReset = useRef(false);
  /** Settles when the file has answered. */
  const loaded = useRef<Promise<void>>(Promise.resolve());
  /** The save or Reset's removal still running: each waits for the one before, so a removal never runs before a
   * save already on its way (the file would come back) and a later move is never removed. */
  const busy = useRef<Promise<void> | null>(null);
  const target = useRef({ id, path });
  target.current = { id, path };
  const pathKey = tableId(path);

  const after = useCallback((op: () => Promise<void>) => {
    const p = (busy.current ? busy.current.then(op) : op()).catch(() => {});
    busy.current = p;
    void p.finally(() => {
      if (busy.current === p) busy.current = null;
    });
  }, []);

  const flush = useCallback(() => {
    const w = waiting.current;
    if (!w) return;
    clearTimeout(w.timer);
    waiting.current = null;
    // A failed save keeps the moves on screen; the next move tries again. Tracked, so Reset waits for it.
    after(() => writeLineageLayout(w.id, w.path, w.text));
  }, [after]);

  useEffect(() => {
    let alive = true;
    edited.current = false;
    wasReset.current = false;
    current.current = {};
    setMoves({});
    loaded.current = readLineageLayout(id, path).then(
      (text) => {
        if (!alive || !text) return;
        // After a Reset nothing saved comes back; a move made before the answer stays on top.
        const saved = wasReset.current ? {} : readLayoutText(text);
        const next = edited.current ? { ...saved, ...current.current } : saved;
        current.current = next;
        setMoves(next);
      },
      () => {},
    );
    return () => {
      alive = false;
      flush();
    };
    // `path` is read through its key, so a new object for the same table does not read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, pathKey, flush]);

  const move = useCallback(
    (key: string, at: { x: number; y: number }) => {
      edited.current = true;
      const next = { ...current.current, [key]: { x: at.x, y: at.y } };
      current.current = next;
      setMoves(next);
      if (waiting.current) clearTimeout(waiting.current.timer);
      const { id: forId, path: forPath } = target.current;
      waiting.current = { id: forId, path: forPath, text: layoutText(next), timer: setTimeout(flush, LAYOUT_SAVE_MS) };
    },
    [flush],
  );

  // Reset cancels a waiting save, and removes the file only once the read has answered.
  const reset = useCallback(() => {
    edited.current = true;
    wasReset.current = true;
    if (waiting.current) clearTimeout(waiting.current.timer);
    waiting.current = null;
    current.current = {};
    setMoves({});
    const { id: forId, path: forPath } = target.current;
    const load = loaded.current;
    after(() => load.then(() => deleteLineageLayout(forId, forPath)));
  }, [after]);

  return { moves, move, reset };
}
