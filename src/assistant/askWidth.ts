import { useEffect, useState } from "react";

/** The Ask panel's width, set by dragging its left edge; remembered on this computer. */
export const ASK_WIDTH_KEY = "contura.ask.width";
export const ASK_WIDTH_DEFAULT = 360;
export const ASK_WIDTH_MIN = 300;
const ASK_WIDTH_CAP = 720;
/** Two column gaps and the body's 6 px padding each side, beside the tree and the work area. */
const EDGES = 2 * 6 + 2 * 6;
/** What the rest of the body keeps: the 264 px tree and a 320 px work area. */
const KEEP = 264 + 320 + EDGES;
/** With History open: the tree, the work area and History at their minimums (180, 320, 220), and one more gap. */
const KEEP_HISTORY = 180 + 320 + 220 + 6 + EDGES;

/**
 * The room the Ask column has in a window this wide: half of it, 720 px, and never the work area's 320 px; with
 * History open, never History's 220 px either. May be under the 300 px minimum.
 */
export function askWidthRoom(windowWidth: number, history: boolean): number {
  return Math.min(ASK_WIDTH_CAP, Math.floor(windowWidth / 2), windowWidth - (history ? KEEP_HISTORY : KEEP));
}

/** The most the panel may take without History; never under the minimum. */
export function askWidthMax(windowWidth: number): number {
  return Math.max(ASK_WIDTH_MIN, askWidthRoom(windowWidth, false));
}

export function clampAskWidth(w: number, max: number): number {
  return Math.round(Math.max(ASK_WIDTH_MIN, Math.min(max, w)));
}

/**
 * The width to draw for the wanted one in this room. Under 300 px of room the panel cannot be resized: no sash, and
 * the column takes what fits.
 */
export function askLayout(wanted: number, room: number): { width: number; max: number; resizable: boolean } {
  if (room < ASK_WIDTH_MIN) return { width: Math.max(0, Math.floor(room)), max: Math.max(0, Math.floor(room)), resizable: false };
  return { width: clampAskWidth(wanted, room), max: room, resizable: true };
}

export function loadAskWidth(): number {
  try {
    const n = Number(localStorage.getItem(ASK_WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? n : ASK_WIDTH_DEFAULT;
  } catch {
    return ASK_WIDTH_DEFAULT;
  }
}

export function saveAskWidth(w: number) {
  try {
    localStorage.setItem(ASK_WIDTH_KEY, String(w));
  } catch {
    // Remembering the width is a convenience only.
  }
}

/**
 * The remembered width and the room the window leaves, with and without History. Only the two rooms follow window
 * resizes, at most once a frame, and an unchanged room does not render; a drag writes --ask-width itself and sets
 * the width here once, when it ends (AskSash).
 */
export function useAskWidth() {
  const [wanted, set] = useState(loadAskWidth);
  const [roomPlain, setRoomPlain] = useState(() => askWidthRoom(window.innerWidth, false));
  const [roomHistory, setRoomHistory] = useState(() => askWidthRoom(window.innerWidth, true));
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      setRoomPlain(askWidthRoom(window.innerWidth, false));
      setRoomHistory(askWidthRoom(window.innerWidth, true));
    };
    const resize = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return { wanted, set, roomPlain, roomHistory };
}
