// Old ER files to table blocks: `customers.id int [pk]` lines move into a `customers {` block, `Billing {` groups
// take the word group, and the old cardinality lines (`1--*`, `*--1`, `1--1`, `*--*`, `--`) become `<`, `>`, `-` and
// `<>`. Read line by line; every byte the rewrite does not own stays.
import { COLUMN_FLAGS, type ColumnFlag, columnFlagsText, columnTypeText } from "./model";

/** Each old ER line and what it is written as now. */
export const OLD_ER_ARROWS = { "1--*": "<", "*--1": ">", "1--1": "-", "*--*": "<>", "--": "-" } as const;
export type OldErArrow = keyof typeof OLD_ER_ARROWS;

const isWs = (c: number) => c === 32 || c === 9 || c === 11 || c === 12 || c === 13;

/** The old arrow at `q` (the statement ends at `e`), when white space or the end follows it. */
export function oldErArrowAt(s: string, q: number, e: number): OldErArrow | null {
  if (q >= e) return null;
  const c = s.charCodeAt(q);
  const ends = (i: number) => q + i >= e || isWs(s.charCodeAt(q + i));
  if (c === 45) return q + 1 < e && s.charCodeAt(q + 1) === 45 && ends(2) ? "--" : null;
  if (!(c === 49 || c === 42) || q + 3 >= e || s.charCodeAt(q + 1) !== 45 || s.charCodeAt(q + 2) !== 45) return null;
  const far = s.charCodeAt(q + 3);
  if (!(far === 49 || far === 42) || !ends(4)) return null;
  return `${c === 49 ? "1" : "*"}--${far === 49 ? "1" : "*"}` as OldErArrow;
}

/**
 * True when the name `s[from, to)`, read up to a `--`, ends in an old line's near multiplicity
 * (`customers 1--* orders`): a `1` or `*` alone after white space, with a name before it.
 */
export function endsInMultiplicity(s: string, from: number, to: number): boolean {
  const last = s.charCodeAt(to - 1);
  return to - from >= 3 && (last === 49 || last === 42) && isWs(s.charCodeAt(to - 2));
}

type Line = { body: string; eol: string };
type Bracket = { from: number; to: number };
/** A name line: `customers [weak]`, `Billing {`, or an old column `customers.id int[] [pk] // key`. */
type NameLine = { name: string; quoted: boolean; nameTo: number; brackets: Bracket[]; opens: boolean; comment: number };
/** A statement line as the scan read it: a link (with its old arrows swapped, else null) or a name line. */
type LineInfo = { p: number; end: number; name: NameLine | null; link: string | null };
/**
 * A `{` block: its first and `}` lines (-1 while open), the block it sits in, its name when `Name {` opens it, and
 * whether it holds a block.
 */
type Block = { line: number; close: number; parent: number; name: string | null; nested: boolean };

/** An old column line: its table, the line as a block line, and its statement's span in the frame. */
export type OldColumn = { table: string; text: string; from: number; to: number };

/** An old ER frame as read for the rewrite; the parser reads its column lines and its groups from it. */
export type OldErScan = {
  lines: Line[];
  infos: (LineInfo | null)[];
  /** By 0-based line. */
  columns: Map<number, OldColumn>;
  tables: Set<string>;
  /** The 0-based lines of the `Name {` blocks that are old groups; any other `Name {` block is a table. */
  groups: Set<number>;
  blocks: Block[];
  /** Each line's innermost block, -1 at the top. */
  inBlock: Int32Array;
};

/** At most this many dots of a name are tried as the end of a table's name (`db.schema.table.column`). */
export const MAX_PREFIX_DOTS = 4;

/**
 * Reads the frame for old forms; null when it has none, so a new frame reads as it is. A frame is old when it has an
 * old arrow outside every `Name {` block, or a column line `T.col type [flags]` anywhere, at the top or inside a
 * block, whose `T` (the longest part before a dot that names one) is a table defined anywhere in the frame. A
 * `T.col` with no type or flags inside `T`'s own block is a column of the new kind.
 *
 * In an old frame a `Name {` block is an old group when it holds a block; or another table's old column, unless one
 * of its lines is a typed column (`id int`); or a name that is a table: one with old columns, or defined as a table
 * outside every `Name {` block. Any other is a table, and its lines are its columns.
 */
export function scanOldEr(text: string): OldErScan | null {
  const lines = splitLines(text);
  const infos: (LineInfo | null)[] = [];
  const starts: number[] = [];
  const blocks: Block[] = [];
  const inBlock = new Int32Array(lines.length).fill(-1);
  const groupNames: string[] = [];
  let open = -1;
  let header = false;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].body;
    starts.push(start);
    start += s.length + lines[i].eol.length;
    infos.push(null);
    inBlock[i] = open;
    const p = skipWs(s, s.charCodeAt(0) === 0xfeff ? 1 : 0);
    if (p >= s.length || isComment(s, p)) continue;
    if (!header) {
      header = true;
      continue;
    }
    const end = s.indexOf("//", p) < 0 ? trimBack(s, s.length, p) : statementEnd(s, p);
    if (s.charCodeAt(p) === 125 && end === p + 1) {
      if (open >= 0) {
        blocks[open].close = i;
        open = blocks[open].parent;
      }
      continue;
    }
    let name: string | null = null;
    if (s.charCodeAt(end - 1) === 123 && s.startsWith("group", p) && isWs(s.charCodeAt(p + 5))) {
      const g = readName(s, skipWs(s, p + 5, end), end, false);
      if (g) groupNames.push(nameValue(s, g));
    } else {
      // A link never reads as a name line: its arrow stops the name. Only a line with a `-` can hold an old arrow.
      const n = nameLine(s, p, end);
      if (n) {
        infos[i] = { p, end, name: n, link: null };
        if (n.opens && n.brackets.length <= 1) name = n.name;
      } else {
        const dash = s.indexOf("-", p);
        const link = dash >= 0 && dash < end ? linkArrows(s, p, end) : null;
        if (link !== null && link !== s) infos[i] = { p, end, name: null, link };
      }
    }
    if (s.charCodeAt(end - 1) === 123) {
      if (open >= 0) blocks[open].nested = true;
      blocks.push({ line: i, close: -1, parent: open, name, nested: false });
      open = blocks.length - 1;
    }
  }
  const ownBlock = (i: number) => (inBlock[i] >= 0 ? blocks[inBlock[i]].name : null);
  // Only a name no longer than the longest part before a dot can be a column's table, so no longer name is hashed.
  const dotted = (n: NameLine) => !n.opens && !n.quoted && n.name.indexOf(".", 1) > 0;
  let longest = 0;
  for (const info of infos) if (info?.name && dotted(info.name)) longest = Math.max(longest, prefixLength(info.name.name));
  const defined = new Set<string>();
  for (const g of groupNames) if (g.length <= longest) defined.add(g);
  for (const info of infos) if (info?.name && info.name.name.length <= longest) defined.add(info.name.name);
  const candidate = new Set<number>();
  infos.forEach((info, i) => {
    const n = info?.name;
    if (n && dotted(n) && !n.brackets.some((b) => nodeBracket(lines[i].body, b)) && longestPrefix(n.name, defined) !== null) candidate.add(i);
  });
  const isTable = (n: NameLine, i: number) => n.brackets.length <= 1 && (n.opens || !candidate.has(i));
  const shortTables = new Set<string>();
  infos.forEach((info, i) => {
    const n = info?.name;
    if (n && n.name.length <= longest && isTable(n, i)) shortTables.add(n.name);
  });
  const columns = new Map<number, OldColumn>();
  for (const i of candidate) {
    const info = infos[i]!;
    const n = info.name!;
    const table = longestPrefix(n.name, shortTables);
    if (table === null) continue;
    if (table === ownBlock(i) && n.brackets.length === 0 && !hasWs(n.name, table.length + 1)) continue;
    const text = columnText(lines[i].body, n, table.length);
    if (text !== null) columns.set(i, { table, text, from: starts[i] + info.p, to: starts[i] + info.end });
  }
  const outerArrow = infos.some((info, i) => info?.link && ownBlock(i) === null);
  // A bare `T.x` with no type or flags is a node of its own unless the frame is old by other evidence.
  const typeless = (i: number) => {
    const n = infos[i]!.name!;
    return n.brackets.length === 0 && !hasWs(n.name, columns.get(i)!.table.length + 1);
  };
  if (!outerArrow && [...columns.keys()].every(typeless)) columns.clear();
  if (columns.size === 0 && !outerArrow) return null;
  const tables = new Set<string>();
  infos.forEach((info, i) => {
    const n = info?.name;
    if (n && isTable(n, i)) tables.add(n.name);
  });

  // Names that are tables by evidence: they have old columns, or are defined outside every `Name {` block.
  const evidence = new Set<string>();
  for (const c of columns.values()) evidence.add(c.table);
  const outside = (i: number) => {
    for (let b = inBlock[i]; b >= 0; b = blocks[b].parent) if (blocks[b].name !== null) return false;
    return true;
  };
  infos.forEach((info, i) => {
    const n = info?.name;
    if (n && !columns.has(i) && (n.opens || outside(i))) evidence.add(n.name);
  });
  const typed = new Set<number>();
  const foreign = new Set<number>();
  const grouped = new Set<number>();
  blocks.forEach((b, k) => {
    if (b.name !== null && b.nested) grouped.add(k);
  });
  infos.forEach((info, i) => {
    const k = inBlock[i];
    if (k < 0 || blocks[k].name === null || !info) return;
    const n = info.name;
    const c = columns.get(i);
    if (c) {
      if (c.table !== blocks[k].name) foreign.add(k);
    } else if (n && !n.opens && evidence.has(n.name)) grouped.add(k);
    if (!c && typedRow(lines[i].body, info.p, info.end)) typed.add(k);
  });
  for (const k of foreign) if (!typed.has(k)) grouped.add(k);
  const groups = new Set<number>();
  for (const k of grouped) groups.add(blocks[k].line);
  return { lines, infos, columns, tables, groups, blocks, inBlock };
}

/** True when `s` has white space at or after `from`. */
function hasWs(s: string, from: number): boolean {
  for (let j = from; j < s.length; j++) if (isWs(s.charCodeAt(j))) return true;
  return false;
}

/** A line written as a typed column, `id int ..`: a bare word, then a word that is no list, brace, colon or arrow. */
function typedRow(s: string, p: number, end: number): boolean {
  if (s.charCodeAt(p) === 34) return false;
  let k = p;
  while (k < end && !isWs(s.charCodeAt(k))) k++;
  if (k >= end || s.charCodeAt(k - 1) === 44) return false;
  const q = skipWs(s, k, end);
  const c = s.charCodeAt(q);
  if (c === 91 || c === 123 || c === 58) return false;
  return arrowLength(s, q, end) === 0 && oldErArrowAt(s, q, end) === null;
}

/**
 * The frame rewritten: each table's old column lines move into a block after its table line, in the order written
 * (comment and blank lines among them move with them; any other line between them leaves them where they were), or
 * before the `}` of a table already written as a block; one inside its own table's block stays where it is. An old
 * group `Billing {` is written `group Billing {`. `[entity]` is dropped, other attributes stay; old arrows outside
 * table blocks become `<`, `>`, `-` and `<>`. Line breaks and a BOM are kept, and a frame with nothing old in it
 * comes back as it was. `scan` is the frame's own, when the caller has read it already.
 */
export function migrateOldEr(frameText: string, scan: OldErScan | null = scanOldEr(frameText)): string {
  if (!scan) return frameText;
  const { lines, infos, columns, tables, groups, blocks, inBlock } = scan;
  // A line inside a table block is one of its columns, never a table, and is never rewritten.
  const tableOf = (i: number) => {
    const b = inBlock[i] >= 0 ? blocks[inBlock[i]] : null;
    return b && b.name !== null && !groups.has(b.line) ? b.name : null;
  };
  const tableBlock = new Map<number, Block>();
  for (const b of blocks) if (b.name !== null && !groups.has(b.line)) tableBlock.set(b.line, b);
  // Each table's first line, and the column lines that go in it: by its table line, or by its `}`.
  const tableAt = new Map<string, number>();
  infos.forEach((info, i) => {
    const n = info?.name;
    if (!n || columns.has(i) || tableOf(i) !== null || tableAt.has(n.name) || !tables.has(n.name)) return;
    if (!n.opens) tableAt.set(n.name, i);
    else if (tableBlock.has(i)) tableAt.set(n.name, tableBlock.get(i)!.close >= 0 ? tableBlock.get(i)!.close : i);
  });
  const held = new Map<number, number[]>();
  const inPlace = new Set<number>();
  for (const [i, c] of columns) {
    if (tableOf(i) === c.table) {
      inPlace.add(i);
      continue;
    }
    const at = tableAt.get(c.table);
    if (at === undefined) continue;
    const list = held.get(at) ?? [];
    list.push(i);
    held.set(at, list);
  }
  const placed = new Set<number>();
  for (const list of held.values()) for (const i of list) placed.add(i);
  const out: Line[] = [];
  const done = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    // A column line is written with its table, above or below it.
    if (done.has(i) || placed.has(i)) continue;
    const info = infos[i];
    const s = lines[i].body;
    const n = info?.name;
    const own = held.get(i);
    if (inPlace.has(i)) {
      out.push({ body: `${s.slice(0, info!.p)}${columns.get(i)!.text}`, eol: lines[i].eol });
      continue;
    }
    if (own && !n) {
      // The `}` of a table block: its old columns go in after the ones it has.
      const indent = s.slice(0, skipWs(s, 0));
      for (const j of own) out.push({ body: `${indent}  ${columns.get(j)!.text}`, eol: lines[j].eol });
      out.push(lines[i]);
      continue;
    }
    if (tableOf(i) !== null) out.push(lines[i]);
    else if (info?.link) out.push({ body: info.link, eol: lines[i].eol });
    else if (n?.opens && groups.has(i)) out.push({ body: `${s.slice(0, info!.p)}group ${s.slice(info!.p)}`, eol: lines[i].eol });
    else if (n && !n.opens && tables.has(n.name)) {
      const body = dropEntity(s, n);
      if (!own) {
        out.push({ body, eol: lines[i].eol });
        continue;
      }
      const indent = s.slice(0, info!.p);
      out.push({ body: openBrace(body), eol: lines[i].eol });
      const last = own[own.length - 1];
      const mine = new Set(own);
      let run = last > i;
      for (let j = i + 1; j < last && run; j++) run = mine.has(j) || isBlankOrComment(lines[j].body);
      for (const j of run ? range(i + 1, last) : own) {
        out.push(mine.has(j) ? { body: `${indent}  ${columns.get(j)!.text}`, eol: lines[j].eol } : lines[j]);
        done.add(j);
      }
      out.push({ body: `${indent}}`, eol: out[out.length - 1].eol });
    } else if (n?.opens && own) {
      // An unclosed table block: its old columns go right after its first line.
      out.push(lines[i]);
      const indent = s.slice(0, info!.p);
      for (const j of own) out.push({ body: `${indent}  ${columns.get(j)!.text}`, eol: lines[j].eol });
    } else out.push(lines[i]);
  }
  // A line moved off the end of the text takes the text's own line break; the last line keeps the text's ending.
  const lf = frameText.indexOf("\n");
  const eol = lf > 0 && frameText.charCodeAt(lf - 1) === 13 ? "\r\n" : "\n";
  let text = "";
  for (let k = 0; k < out.length; k++) text += out[k].body + (k === out.length - 1 ? "" : out[k].eol || eol);
  return text;
}

/** The length of the longest part of `name` that `longestPrefix` tries. */
function prefixLength(name: string): number {
  let last = 0;
  let count = 0;
  for (let d = name.indexOf(".", 1); d > 0 && count < MAX_PREFIX_DOTS; d = name.indexOf(".", d + 1), count++) last = d;
  return last;
}

/** The longest part of `name` before one of its first dots that is in `names`; null when none is. */
export function longestPrefix(name: string, names: ReadonlySet<string>): string | null {
  const dots: number[] = [];
  for (let d = name.indexOf(".", 1); d > 0 && dots.length < MAX_PREFIX_DOTS; d = name.indexOf(".", d + 1)) dots.push(d);
  for (let k = dots.length - 1; k >= 0; k--) {
    const prefix = name.slice(0, dots[k]);
    if (names.has(prefix)) return prefix;
  }
  return null;
}

/** `from` through `to`. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let j = from; j <= to; j++) out.push(j);
  return out;
}

/** The lines and their breaks; the last has none (it is empty when the text ends with a break). */
function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) {
      out.push({ body: text.slice(start), eol: "" });
      return out;
    }
    const cr = nl > start && text.charCodeAt(nl - 1) === 13;
    out.push({ body: text.slice(start, cr ? nl - 1 : nl), eol: cr ? "\r\n" : "\n" });
    start = nl + 1;
  }
}

function skipWs(s: string, p: number, e = s.length): number {
  while (p < e && isWs(s.charCodeAt(p))) p++;
  return p;
}

function trimBack(s: string, p: number, from: number): number {
  while (p > from && isWs(s.charCodeAt(p - 1))) p--;
  return p;
}

const isComment = (s: string, p: number) => s.charCodeAt(p) === 47 && s.charCodeAt(p + 1) === 47;

function isBlankOrComment(s: string): boolean {
  const p = skipWs(s, 0);
  return p >= s.length || isComment(s, p);
}

/** Where the statement ends: before a comment outside quotes, without the white space. */
function statementEnd(s: string, p: number): number {
  let inQuote = false;
  let j = p;
  for (; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && inQuote) j++;
    else if (c === 34) inQuote = !inQuote;
    else if (c === 47 && !inQuote && s.charCodeAt(j + 1) === 47) break;
  }
  return trimBack(s, Math.min(j, s.length), p);
}

/** Where the parser's bare name stops: the characters the writer's quoting rule reserves, and the arrows. */
function stopsName(s: string, j: number, e: number, atComma: boolean): boolean {
  const c = s.charCodeAt(j);
  if (c === 91 || c === 93 || c === 123 || c === 125 || c === 58 || c === 62 || c === 60 || c === 34 || c === 92) return true;
  if (atComma && c === 44) return true;
  if (c === 47) return isComment(s, j);
  if (c === 45) {
    const next = j + 1 < e ? s.charCodeAt(j + 1) : -1;
    if (next === 45 || next === 62) return true;
    return (j === 0 || isWs(s.charCodeAt(j - 1))) && (j + 1 >= e || isWs(next));
  }
  if (c === 46) return s.charCodeAt(j + 1) === 46 && s.charCodeAt(j + 2) === 62;
  return false;
}

/** A name at `p`, quoted (with `\"`) or bare; null when there is none or its quote never closes. */
function readName(s: string, p: number, e: number, atComma: boolean): { from: number; to: number; quoted: boolean } | null {
  if (s.charCodeAt(p) === 34) {
    for (let j = p + 1; j < e; j++) {
      const c = s.charCodeAt(j);
      if (c === 92) j++;
      else if (c === 34) return { from: p, to: j + 1, quoted: true };
    }
    return null;
  }
  let j = p;
  while (j < e) {
    const c = s.charCodeAt(j);
    // Letters, digits, `_` and a dot not starting `..>` never stop a name.
    if ((c >= 65 && c !== 91 && c !== 92 && c !== 93 && c !== 123 && c !== 125) || (c >= 48 && c <= 57) || (c === 46 && s.charCodeAt(j + 1) !== 46)) j++;
    else if (stopsName(s, j, e, atComma)) break;
    else j++;
  }
  const to = trimBack(s, j, p);
  return to === p ? null : { from: p, to, quoted: false };
}

/** The length of an arrow any kind draws at `q`, or 0. */
function arrowLength(s: string, q: number, e: number): number {
  if (q >= e) return 0;
  const c = s.charCodeAt(q);
  const at = (i: number) => (q + i < e ? s.charCodeAt(q + i) : -1);
  const ends = (i: number) => q + i >= e || isWs(s.charCodeAt(q + i));
  if (c === 62) return 1;
  if (c === 60) {
    if (at(1) === 62) return 2;
    if (at(1) === 124) return at(2) === 45 && at(3) === 45 ? 4 : 0;
    return at(1) === 45 || at(1) === 61 ? 0 : 1;
  }
  if (c === 45) {
    if (at(1) === 45 && at(2) === 62) return 3;
    if (at(1) === 62) return 2;
    return at(1) !== 45 && ends(1) ? 1 : 0;
  }
  if (c === 42 && at(1) === 45 && at(2) === 45 && ends(3)) return 3;
  if (c === 46 && at(1) === 46 && at(2) === 62) return 3;
  return 0;
}

/**
 * A link line with its old arrows swapped (the line itself when none is old); null when the line is no link. Only
 * the arrows between the ends are read, so a label and a comment keep every byte.
 */
function linkArrows(s: string, p: number, e: number): string | null {
  let out = "";
  let copied = 0;
  let arrows = 0;
  let q = p;
  const done = () => (arrows > 0 ? out + s.slice(copied) : null);
  for (;;) {
    // One end: a comma list of names.
    let name = readName(s, q, e, true);
    if (!name) return done();
    for (let c = skipWs(s, name.to, e); c < e && s.charCodeAt(c) === 44; c = skipWs(s, name.to, e)) {
      const next = readName(s, skipWs(s, c + 1, e), e, true);
      if (!next) return done();
      name = next;
    }
    q = skipWs(s, name.to, e);
    if (!name.quoted && s.charCodeAt(q) === 45 && s.charCodeAt(q + 1) === 45 && endsInMultiplicity(s, name.from, name.to)) q = name.to - 1;
    const old = oldErArrowAt(s, q, e);
    if (old) {
      out += s.slice(copied, q) + OLD_ER_ARROWS[old];
      copied = q + old.length;
      q = skipWs(s, copied, e);
      arrows++;
      continue;
    }
    const length = arrowLength(s, q, e);
    if (length === 0) return done();
    arrows++;
    q = skipWs(s, q + length, e);
  }
}

/** A name, then `[..]` lists, then the end or `{`; null for any other line. */
function nameLine(s: string, p: number, end: number): NameLine | null {
  const n = readName(s, p, end, false);
  if (!n) return null;
  const brackets: Bracket[] = [];
  let q = skipWs(s, n.to, end);
  while (q < end && s.charCodeAt(q) === 91) {
    const close = closeBracket(s, q, end);
    if (close < 0) return null;
    brackets.push({ from: q, to: close + 1 });
    q = skipWs(s, close + 1, end);
  }
  const opens = q === end - 1 && s.charCodeAt(q) === 123;
  if (q < end && !opens) return null;
  const comment = skipWs(s, end);
  return { name: nameValue(s, n), quoted: n.quoted, nameTo: n.to, brackets, opens, comment: comment < s.length ? comment : -1 };
}

function nameValue(s: string, n: { from: number; to: number; quoted: boolean }): string {
  return n.quoted ? unquote(s.slice(n.from + 1, n.to - 1)) : s.slice(n.from, n.to);
}

function unquote(inner: string): string {
  let out = "";
  for (let j = 0; j < inner.length; j++) {
    if (inner.charCodeAt(j) === 92 && j + 1 < inner.length) j++;
    out += inner[j];
  }
  return out;
}

/** The `]` closing the list at `q`, outside quotes; -1 when the statement ends first. */
function closeBracket(s: string, q: number, e: number): number {
  let inQuote = false;
  for (let j = q + 1; j < e; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && inQuote) j++;
    else if (c === 34) inQuote = !inQuote;
    else if (c === 93 && !inQuote) return j;
  }
  return -1;
}

/**
 * An old column line as a block line, `id int[] pk not null // key`, given the length of its table's name; null when
 * its brackets are more than the type's own (glued to it, with no flag in them) and one flag list.
 */
function columnText(s: string, n: NameLine, tableLength: number): string | null {
  let typeEnd = n.nameTo;
  let b = 0;
  for (; b < n.brackets.length && n.brackets[b].from === typeEnd && !hasFlag(s, n.brackets[b]); b++) typeEnd = n.brackets[b].to;
  if (n.brackets.length - b > 1) return null;
  const rest = (n.name.slice(tableLength + 1) + s.slice(n.nameTo, typeEnd)).trim();
  let k = 0;
  while (k < rest.length && !isWs(rest.charCodeAt(k))) k++;
  const type = rest.slice(k).trim();
  let out = type ? `${rest.slice(0, k)} ${columnTypeText(type)}` : rest.slice(0, k);
  const flags = n.brackets[b];
  if (flags) {
    const found = new Set<ColumnFlag>();
    const other: string[] = [];
    for (const item of splitItems(s.slice(flags.from + 1, flags.to - 1))) {
      const word = item.trim().split(/\s+/).join(" ");
      const flag = word.toLowerCase();
      if ((COLUMN_FLAGS as readonly string[]).includes(flag)) found.add(flag as ColumnFlag);
      else if (word) other.push(word);
    }
    // A word that is no flag stays, so the parser points at it.
    out += columnFlagsText(found) + other.map((w) => ` ${w}`).join("");
  }
  return n.comment >= 0 ? `${out} ${s.slice(n.comment)}` : out;
}

/** True when a bracket list says a node: a kind word (`entity`, `weak`) or an attribute key (`icon: box`). */
function nodeBracket(s: string, b: Bracket): boolean {
  return splitItems(s.slice(b.from + 1, b.to - 1)).some((item) => {
    const word = item.trim().toLowerCase();
    return word === "entity" || word === "weak" || /^(id|icon|label|color|table)\s*:/.test(word);
  });
}

/** True when a bracket list holds a column flag. */
function hasFlag(s: string, b: Bracket): boolean {
  return splitItems(s.slice(b.from + 1, b.to - 1)).some((item) => (COLUMN_FLAGS as readonly string[]).includes(item.trim().split(/\s+/).join(" ").toLowerCase()));
}

/** The table line without `entity` in its brackets (the brackets go too when nothing else is in them). */
function dropEntity(s: string, n: NameLine): string {
  const list = n.brackets[0];
  if (!list) return s;
  const items = splitItems(s.slice(list.from + 1, list.to - 1));
  const kept = items.filter((item) => item.trim().toLowerCase() !== "entity");
  if (kept.length === items.length) return s;
  if (kept.every((item) => item.trim() === "")) return s.slice(0, n.nameTo) + s.slice(list.to);
  return `${s.slice(0, list.from)}[${kept.map((item) => item.trim()).join(", ")}]${s.slice(list.to)}`;
}

/** The items of a bracket list, split at commas outside quotes. */
function splitItems(inner: string): string[] {
  const out: string[] = [];
  let inQuote = false;
  let from = 0;
  for (let j = 0; j < inner.length; j++) {
    const c = inner.charCodeAt(j);
    if (c === 92 && inQuote) j++;
    else if (c === 34) inQuote = !inQuote;
    else if (c === 44 && !inQuote) {
      out.push(inner.slice(from, j));
      from = j + 1;
    }
  }
  out.push(inner.slice(from));
  return out;
}

/** The table line with ` {` after its statement, before any comment. */
function openBrace(line: string): string {
  const end = statementEnd(line, skipWs(line, 0));
  return `${line.slice(0, end)} {${line.slice(end)}`;
}
