// DBML identifier quoting; the same rules as the Core's DBML writer (dbml_writer.rs).

const RESERVED = new Set([
  "table", "ref", "enum", "note", "project", "indexes", "as", "tablegroup", "null", "true", "false",
  "select", "from", "where", "order", "group", "user", "index", "key", "default", "check",
]);

export function ident(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toLowerCase())
    ? name
    : `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Types with spaces or quotes are written quoted; `numeric(10,2)` and `text[]` stay bare. */
export function typeText(t: string): string {
  return /[\s"']/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t;
}

/** Splits a qualified name into its segments, keeping quoted segments whole. */
export function splitSegments(text: string): { text: string; from: number; to: number }[] {
  const out: { text: string; from: number; to: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    if (text[i] === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (text[i] === "(") {
      while (i < text.length && text[i] !== ")") i += 1;
      i += 1;
    } else {
      while (i < text.length && text[i] !== ".") i += 1;
    }
    out.push({ text: text.slice(start, i), from: start, to: i });
    if (text[i] === ".") i += 1;
  }
  return out;
}

export function unquoteName(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s;
}
