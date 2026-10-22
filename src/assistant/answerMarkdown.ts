/**
 * The strict subset an answer renders as (R5.1): paragraphs split on blank lines, `-`, `*` and `1.` lists,
 * `**bold**`, `` `code` `` and fenced code. Anything else, HTML, links and images included, stays plain text.
 */
export type Inline = { kind: "text" | "bold" | "code"; text: string };

export type Block =
  | { kind: "para"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  /** `fence` counts every fence of the answer, as the Core's `fences` does, so it matches `SqlBlock.fence`. */
  | { kind: "code"; lang: string | null; text: string; fence: number; closed: boolean };

const ITEM = /^\s*([-*]|\d+\.)\s+(.*)$/;
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*/g;

/** Text with inline code and bold picked out; adjacent text runs merge. */
export function parseInline(text: string): Inline[] {
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
    if (para.length > 0) out.push({ kind: "para", inlines: parseInline(para.join("\n")) });
    if (list) out.push({ kind: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    para = [];
    list = null;
  };
  for (const line of lines) {
    if (line.trim() === "") {
      flush();
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
 * An answer as blocks. A fence opens on a line whose first non-space characters are three or more backticks with
 * no other backtick after them, and closes on a line of at least as many backticks; an unclosed fence runs to the end.
 */
export function parseAnswer(text: string): Block[] {
  const out: Block[] = [];
  let pending: string[] = [];
  let open: { ticks: number; lang: string | null; body: string[] } | null = null;
  let fence = 0;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const lead = line.trimStart();
    const ticks = /^`*/.exec(lead)![0].length;
    const rest = lead.slice(ticks);
    if (!open) {
      if (ticks >= 3 && !rest.includes("`")) {
        prose(pending, out);
        pending = [];
        open = { ticks, lang: rest.trim().split(/\s+/)[0] || null, body: [] };
      } else {
        pending.push(line);
      }
    } else if (ticks >= open.ticks && rest.trim() === "") {
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
