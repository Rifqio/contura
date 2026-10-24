/**
 * The strict subset an answer renders as (R5.1): paragraphs split on blank lines, `#` to `###` headings, `-`, `*` and
 * `1.` lists, `**bold**`, `` `code` `` and fenced code. Anything else, HTML, links and images included, stays plain text.
 */
export type Inline = { kind: "text" | "bold" | "code"; text: string };

export type Block =
  | { kind: "para"; inlines: Inline[] }
  /** One line: `#` to `###`, a space, then the text; closing `#`s are dropped. `####` and deeper stay text. */
  | { kind: "heading"; level: 1 | 2 | 3; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  /** `fence` counts every fence of the answer, as the Core's `fences` does, so it matches `SqlBlock.fence`. */
  | { kind: "code"; lang: string | null; text: string; fence: number; closed: boolean };

const ITEM = /^\s*([-*]|\d+\.)\s+(.*)$/;
const HEADING = /^ {0,3}(#{1,3})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** The level and text of a heading line, or null; a heading needs text after its marks. */
function headingOf(line: string): { level: 1 | 2 | 3; text: string } | null {
  const m = HEADING.exec(line);
  if (!m || m[2] === "") return null;
  return { level: m[1].length as 1 | 2 | 3, text: m[2] };
}
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*/g;

/**
 * Characters the parsers have read since the page loaded: `parseAnswer` counts its whole text, the streaming parser
 * each line once and the unsettled part of the line still being written. The streaming cost test reads it.
 */
export const parseCost = { chars: 0 };

/** Text with inline code and bold picked out; adjacent text runs merge. */
export function parseInline(text: string): Inline[] {
  parseCost.chars += text.length;
  return inlines(text);
}

function inlines(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (kind: Inline["kind"], t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (kind === "text" && last?.kind === "text") last.text += t;
    else out.push({ kind, text: t });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    push("text", text.slice(at, start));
    if (m[1] !== undefined) push("code", m[1]);
    else push("bold", m[2]);
    at = start + m[0].length;
  }
  push("text", text.slice(at));
  return out;
}

/** Prose between fences: blank lines split paragraphs; list lines make lists; other lines continue an item or a paragraph. */
function prose(lines: string[], out: Block[]) {
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length > 0) out.push({ kind: "para", inlines: inlines(para.join("\n")) });
    if (list) out.push({ kind: "list", ordered: list.ordered, items: list.items.map((i) => inlines(i)) });
    para = [];
    list = null;
  };
  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      flush();
      out.push({ kind: "heading", level: heading.level, inlines: inlines(heading.text) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = item[1] !== "-" && item[1] !== "*";
      if (para.length > 0 || (list && list.ordered !== ordered)) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push(item[2]);
    } else if (list) {
      list.items[list.items.length - 1] += `\n${line.trim()}`;
    } else {
      para.push(line);
    }
  }
  flush();
}

/**
 * Only space and tab are white space on a fence line (its indent, the end of its language word, a closing line's
 * tail), as in the Core's `fences`: JS and Rust disagree on NEL and BOM, and a fence counted by one and not the other
 * would number the blocks apart.
 */
const FENCE_BLANK_LEAD = /^[ \t]+/;
const FENCE_BLANK = /^[ \t]*$/;
const fenceLang = (rest: string): string | null => rest.split(/[ \t]+/).find((w) => w !== "") ?? null;

/**
 * An answer as blocks. A fence opens on a line whose first non-space characters are three or more backticks with
 * no other backtick after them, and closes on a line of at least as many backticks; an unclosed fence runs to the end.
 * CRLF and a lone CR are line ends, as in the editor and the Core's `fences`, so a block holds the text the Core
 * checked and the fence numbers match.
 */
export function parseAnswer(text: string): Block[] {
  parseCost.chars += text.length;
  const out: Block[] = [];
  let pending: string[] = [];
  let open: { ticks: number; lang: string | null; body: string[] } | null = null;
  let fence = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const lead = line.replace(FENCE_BLANK_LEAD, "");
    const ticks = /^`*/.exec(lead)![0].length;
    const rest = lead.slice(ticks);
    if (!open) {
      if (ticks >= 3 && !rest.includes("`")) {
        prose(pending, out);
        pending = [];
        open = { ticks, lang: fenceLang(rest), body: [] };
      } else {
        pending.push(line);
      }
    } else if (ticks >= open.ticks && FENCE_BLANK.test(rest)) {
      out.push({ kind: "code", lang: open.lang, text: open.body.join("\n"), fence: fence++, closed: true });
      open = null;
    } else {
      open.body.push(line);
    }
  }
  if (open) out.push({ kind: "code", lang: open.lang, text: open.body.join("\n"), fence, closed: false });
  else prose(pending, out);
  return out;
}

/** `a` then `b`, a text run at the seam merged as `parseInline` merges it; neither array is changed. */
function joinInlines(a: Inline[], b: Inline[]): Inline[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const last = a[a.length - 1];
  if (last.kind === "text" && b[0].kind === "text") return [...a.slice(0, -1), { kind: "text", text: last.text + b[0].text }, ...b.slice(1)];
  return [...a, ...b];
}

const NEW_LINE: Inline[] = [{ kind: "text", text: "\n" }];
const OPENER = /[`*]/;

/**
 * `text` as inlines split where nothing later can change what comes before: at the first backtick or star outside
 * every match, since a character still to come could close it. `head` is final; `tail` may change as text arrives.
 * A match never spans a line break, so this is for one line.
 */
function settleInline(text: string): { head: Inline[]; tail: Inline[]; at: number } {
  parseCost.chars += text.length;
  const head: Inline[] = [];
  const tail: Inline[] = [];
  let at = -1;
  const push = (out: Inline[], kind: Inline["kind"], t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (kind === "text" && last?.kind === "text") out[out.length - 1] = { kind, text: last.text + t };
    else out.push({ kind, text: t });
  };
  const gap = (from: number, to: number) => {
    const t = text.slice(from, to);
    if (at >= 0) return push(tail, "text", t);
    const o = t.search(OPENER);
    if (o < 0) return push(head, "text", t);
    at = from + o;
    push(head, "text", t.slice(0, o));
    push(tail, "text", t.slice(o));
  };
  let pos = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    gap(pos, start);
    if (m[1] !== undefined) push(at >= 0 ? tail : head, "code", m[1]);
    else push(at >= 0 ? tail : head, "bold", m[2]);
    pos = start + m[0].length;
  }
  gap(pos, text.length);
  return { head, tail, at: at < 0 ? text.length : at };
}

/** One answer parsed as it streams in. */
export interface AnswerParser {
  /** `parseAnswer(text)`, reading only what arrived since the last call when `text` extends the last one. */
  parse(text: string): Block[];
}

type ProseState = { para: Inline[] | null; list: { ordered: boolean; items: Inline[][] } | null };

/** The blocks a prose state ends in: a paragraph, then a list (only one of the two is ever open). */
function proseBlocks(p: ProseState): Block[] {
  const out: Block[] = [];
  if (p.para) out.push({ kind: "para", inlines: p.para });
  if (p.list) out.push({ kind: "list", ordered: p.list.ordered, items: p.list.items });
  return out;
}

/**
 * A parser for an answer that grows at its end (R5.1, as `parseAnswer`). Each finished line is read once; finished
 * blocks are kept and handed back as the same objects; the line still being written is read again only from its
 * first unsettled backtick or star. A text that does not extend the last one starts it over.
 */
export function createAnswerParser(): AnswerParser {
  let seen = "";
  /** Where the line still being written starts. */
  let lineAt = 0;
  let blocks: Block[] = [];
  let fence = 0;
  let open: { ticks: number; lang: string | null; text: string; lines: number } | null = null;
  let prose: ProseState = { para: null, list: null };
  /** The settled start of the line being written: its text and inlines, for the line at `settledAt`. */
  let settled = { at: -1, src: "", inl: [] as Inline[] };

  const flush = () => {
    blocks.push(...proseBlocks(prose));
    prose = { para: null, list: null };
  };

  /** The prose state after `line`, and whether it closed the blocks before; the state given is not changed. */
  function proseLine(p: ProseState, line: string, inline: (s: string) => Inline[]): { next: ProseState; closed: Block[] } {
    if (line.trim() === "") return { next: { para: null, list: null }, closed: proseBlocks(p) };
    const heading = headingOf(line);
    if (heading) {
      return { next: { para: null, list: null }, closed: [...proseBlocks(p), { kind: "heading", level: heading.level, inlines: inline(heading.text) }] };
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = item[1] !== "-" && item[1] !== "*";
      const restart = p.para !== null || (p.list !== null && p.list.ordered !== ordered);
      const list = restart || !p.list ? { ordered, items: [] as Inline[][] } : p.list;
      return { next: { para: null, list: { ordered, items: [...list.items, inline(item[2])] } }, closed: restart ? proseBlocks(p) : [] };
    }
    if (p.list) {
      const items = p.list.items.slice();
      items[items.length - 1] = joinInlines(joinInlines(items[items.length - 1], NEW_LINE), inline(line.trim()));
      return { next: { para: null, list: { ordered: p.list.ordered, items } }, closed: [] };
    }
    const para = p.para ? joinInlines(joinInlines(p.para, NEW_LINE), inline(line)) : inline(line);
    return { next: { para, list: null }, closed: [] };
  }

  const fenceOf = (line: string) => {
    const lead = line.replace(FENCE_BLANK_LEAD, "");
    const ticks = /^`*/.exec(lead)![0].length;
    return { ticks, rest: lead.slice(ticks) };
  };

  /** A finished line, read once. */
  function finished(raw: string) {
    parseCost.chars += raw.length;
    const line = raw;
    const { ticks, rest } = fenceOf(line);
    if (!open) {
      if (ticks >= 3 && !rest.includes("`")) {
        flush();
        open = { ticks, lang: fenceLang(rest), text: "", lines: 0 };
      } else {
        const { next, closed } = proseLine(prose, line, inlines);
        blocks.push(...closed);
        prose = next;
      }
    } else if (ticks >= open.ticks && FENCE_BLANK.test(rest)) {
      blocks.push({ kind: "code", lang: open.lang, text: open.text, fence: fence++, closed: true });
      open = null;
    } else {
      open.text = open.lines === 0 ? line : `${open.text}\n${line}`;
      open.lines++;
    }
  }

  /** Inlines of the line being written: its settled start is kept, only the rest is read. */
  function partialInline(s: string): Inline[] {
    if (settled.at !== lineAt || !s.startsWith(settled.src)) settled = { at: lineAt, src: "", inl: [] };
    const { head, tail, at } = settleInline(s.slice(settled.src.length));
    if (at > 0) settled = { at: lineAt, src: settled.src + s.slice(settled.src.length, settled.src.length + at), inl: joinInlines(settled.inl, head) };
    return joinInlines(settled.inl, tail);
  }

  /** The blocks with the line being written, as `parseAnswer` would read it if the text ended here; the state is not changed. */
  function partial(line: string): Block[] {
    const { ticks, rest } = fenceOf(line);
    if (open) {
      if (ticks >= open.ticks && FENCE_BLANK.test(rest)) return [...blocks, { kind: "code", lang: open.lang, text: open.text, fence, closed: true }];
      return [...blocks, { kind: "code", lang: open.lang, text: open.lines === 0 ? line : `${open.text}\n${line}`, fence, closed: false }];
    }
    if (ticks >= 3 && !rest.includes("`")) return [...blocks, ...proseBlocks(prose), { kind: "code", lang: fenceLang(rest), text: "", fence, closed: false }];
    const { next, closed } = proseLine(prose, line, partialInline);
    return [...blocks, ...closed, ...proseBlocks(next)];
  }

  function reset() {
    seen = "";
    lineAt = 0;
    blocks = [];
    fence = 0;
    open = null;
    prose = { para: null, list: null };
    settled = { at: -1, src: "", inl: [] };
  }

  return {
    parse(text: string): Block[] {
      if (!text.startsWith(seen)) reset();
      seen = text;
      // Line ends as `parseAnswer` reads them: LF, CRLF or a lone CR. A CR at the very end may still become a CRLF,
      // so it is not taken yet.
      const ends = /\r\n|\r|\n/g;
      for (;;) {
        ends.lastIndex = lineAt;
        const hit = ends.exec(text);
        if (!hit || (hit[0] === "\r" && hit.index === text.length - 1)) break;
        finished(text.slice(lineAt, hit.index));
        lineAt = hit.index + hit[0].length;
      }
      const tail = text.slice(lineAt);
      if (!tail.endsWith("\r")) return partial(tail);
      // As `parseAnswer` reads the text now, the CR ends the line and an empty one follows: read so on a copy of the
      // state, which is put back, since the next piece may make the CR a CRLF.
      const kept = { lineAt, blocks: blocks.slice(), fence, open: open && { ...open }, prose, settled };
      finished(tail.slice(0, -1));
      lineAt = text.length;
      const out = partial("");
      ({ lineAt, blocks, fence, open, prose, settled } = kept);
      return out;
    },
  };

}

const SQL_TAGS = new Set(["sql", "postgresql", "postgres", "pgsql", "mysql", "sqlite", "plpgsql"]);
const SQL_STARTS = new Set([
  "SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "TRUNCATE",
  "EXPLAIN", "MERGE", "REPLACE", "GRANT", "REVOKE", "SET", "SHOW", "PRAGMA", "VALUES", "TABLE",
  "DESCRIBE",
]);

/** The first word of SQL, past comments (MySQL's `#` too), upper-cased; "" when there is none. */
export function leadingWord(sql: string): string {
  const body = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
  return (/^[A-Za-z_]+/.exec(body)?.[0] ?? "").toUpperCase();
}

/** The Core's rule for a SQL block: tagged `sql` or a Dialect's name, or untagged and starting with a SQL word. */
export function looksLikeSql(block: { lang: string | null; text: string }): boolean {
  if (block.lang !== null) return SQL_TAGS.has(block.lang.toLowerCase());
  return SQL_STARTS.has(leadingWord(block.text));
}

/**
 * An answer as one line of plain text, for a preview: prose, list items and code all read as words, with no
 * fences, backticks or bold marks, and runs of white space folded to one space.
 */
export function plainText(text: string): string {
  const words = (inlines: Inline[]) => inlines.map((i) => i.text).join("");
  return parseAnswer(text)
    .map((b) => (b.kind === "para" || b.kind === "heading" ? words(b.inlines) : b.kind === "list" ? b.items.map(words).join("; ") : b.text))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
