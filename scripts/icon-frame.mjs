// Fits an icon into the 24 by 24 frame (Plan C, Decision 3). Only the root <svg> start tag is
// rewritten; every byte before it (XML declaration, comments) and after it (the drawing) is
// copied unchanged. The SVG is untrusted: a root this file cannot read with certainty is
// refused with a reason, never guessed at.

const FRAME = 24;
const DROPPED = new Set(["width", "height", "viewBox", "preserveAspectRatio"]);
const NUMBER = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
const SIZE = new RegExp(`^\\s*(${NUMBER})(?:px)?\\s*$`);
const VIEW_BOX = new RegExp(`^\\s*(${NUMBER})(?:\\s*,\\s*|\\s+)(${NUMBER})(?:\\s*,\\s*|\\s+)(${NUMBER})(?:\\s*,\\s*|\\s+)(${NUMBER})\\s*$`);
const WS = /\s/;

/** The index just past the markup at `i` when it is a comment, declaration, DOCTYPE or PI; else -1. */
function skipProlog(text, i) {
  if (text.startsWith("<!--", i)) {
    const close = text.indexOf("-->", i + 4);
    return close < 0 ? -1 : close + 3;
  }
  if (text.startsWith("<?", i)) {
    const close = text.indexOf("?>", i + 2);
    return close < 0 ? -1 : close + 2;
  }
  if (/^<!DOCTYPE/i.test(text.slice(i, i + 9))) {
    let quote = "";
    let depth = 0;
    for (let j = i + 9; j < text.length; j++) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === ">" && depth <= 0) return j + 1;
    }
  }
  return -1;
}

/**
 * The first `<svg` element's start tag: `start` is its `<`, `end` is just past its `>`.
 * Null when the document does not open with one (after a BOM, whitespace, XML declaration,
 * comments, DOCTYPE and processing instructions), when the tag ends `/>`, or when the tag is
 * not well formed (an unquoted value, a repeated name, no space between attributes).
 */
export function rootTag(text) {
  let i = text[0] === "﻿" ? 1 : 0;
  for (;;) {
    while (i < text.length && WS.test(text[i])) i++;
    if (text[i] !== "<") return null;
    if (/^<svg[\s>/]/.test(text.slice(i, i + 5))) break;
    i = skipProlog(text, i);
    if (i < 0) return null;
  }
  const start = i;
  i += 4;
  const attrs = [];
  const seen = new Set();
  for (;;) {
    const spaced = i < text.length && WS.test(text[i]);
    while (i < text.length && WS.test(text[i])) i++;
    if (i >= text.length) return null;
    if (text[i] === ">") return { start, end: i + 1, attrs };
    if (text[i] === "/") return null;
    if (!spaced) return null;
    const name = /^[^\s=/>"'<]+/.exec(text.slice(i, i + 256))?.[0];
    if (!name || seen.has(name)) return null;
    i += name.length;
    while (WS.test(text[i] ?? "")) i++;
    if (text[i] !== "=") return null;
    i++;
    while (WS.test(text[i] ?? "")) i++;
    const quote = text[i];
    if (quote !== '"' && quote !== "'") return null;
    const close = text.indexOf(quote, i + 1);
    if (close < 0) return null;
    seen.add(name);
    attrs.push([name, text.slice(i + 1, close)]);
    i = close + 1;
  }
}

/** At most 4 decimals, no trailing zeros, no "-0". */
function num(n) {
  return String(Number(n.toFixed(4)));
}

/** Finite numbers, and a width and height that still print as more than 0. */
function usable(box) {
  return box.every(Number.isFinite) && Number(box[2].toFixed(4)) > 0 && Number(box[3].toFixed(4)) > 0;
}

/** `[minX, minY, w, h]` from the viewBox, else from width and height, else a refusal reason. */
function sourceBox(attrs) {
  const viewBox = attrs.get("viewBox");
  if (viewBox !== undefined) {
    const m = VIEW_BOX.exec(viewBox);
    if (!m) return "no size";
    const box = m.slice(1).map(Number);
    return usable(box) ? box : "no size";
  }
  const w = attrs.get("width");
  const h = attrs.get("height");
  if ((w ?? "").trim().endsWith("%") || (h ?? "").trim().endsWith("%")) return "relative size";
  const mw = SIZE.exec(w ?? "");
  const mh = SIZE.exec(h ?? "");
  if (!mw) return "no size";
  if (!mh) return "no size";
  const box = [0, 0, Number(mw[1]), Number(mh[1])];
  return usable(box) ? box : "no size";
}

/**
 * Rewrites the root start tag so the icon fills a square viewBox shown at 24 by 24, with
 * `rule.pad` (a fraction of the frame) of margin on each side. `inkAt` is the UTF-8 byte offset
 * of the new tag's `>` when `rule.ink` is set and the root has no `color` of its own, where the Core inserts ` color="..."`.
 */
export function frameRoot(text, rule) {
  if (!(rule.pad >= 0 && rule.pad < 0.5)) throw new RangeError(`icon-frame: pad must be in [0, 0.5), got ${rule.pad}`);
  const tag = rootTag(text);
  if (!tag) return { refused: "no root svg", head: text.slice(0, 80) };
  if (tag.attrs.some(([, value]) => value.includes('"'))) return { refused: "quote in a value" };
  const attrs = new Map(tag.attrs);
  const aspect = attrs.get("preserveAspectRatio");
  if (aspect !== undefined && !/^(xMidYMid)(\s+meet)?$/.test(aspect.trim().replace(/\s+/g, " "))) {
    return { refused: "aspect ratio" };
  }
  const box = sourceBox(attrs);
  if (typeof box === "string") return { refused: box };
  if (rule.stroke !== undefined && text.slice(tag.end).includes("stroke-width")) {
    return { refused: "stroke width inside" };
  }

  const [minX, minY, w, h] = box;
  const side = Math.max(w, h) / (1 - 2 * rule.pad);
  if (![side, minX + w / 2 - side / 2, minY + h / 2 - side / 2].every(Number.isFinite)) return { refused: "no size" };
  const x = minX + w / 2 - side / 2;
  const y = minY + h / 2 - side / 2;

  const kept = tag.attrs.filter(([name]) => !DROPPED.has(name));
  if (rule.stroke !== undefined) {
    const at = kept.findIndex(([name]) => name === "stroke-width");
    if (at >= 0) kept[at] = ["stroke-width", rule.stroke];
    else kept.push(["stroke-width", rule.stroke]);
  }
  kept.push(["width", String(FRAME)], ["height", String(FRAME)], ["viewBox", `${num(x)} ${num(y)} ${num(side)} ${num(side)}`]);
  if (rule.ink === "mono" && !attrs.has("fill")) kept.push(["fill", "currentColor"]);

  const open = `<svg${kept.map(([name, value]) => ` ${name}="${value}"`).join("")}>`;
  const before = text.slice(0, tag.start);
  const svg = before + open + text.slice(tag.end);
  // A root with its own `color` would get a second one from the Core: record no ink for it.
  const inkAt = rule.ink && !attrs.has("color") ? Buffer.byteLength(before + open.slice(0, -1)) : null;
  return { svg, inkAt };
}
