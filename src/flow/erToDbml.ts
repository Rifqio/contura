// One ERD (ADR 0030): the flow language has no `diagram er` any more, and DBML is the only way to draw tables. An
// old ER file opens read-only with "Open as DBML", which converts it here. It reads the ER text on its own (the
// flow parser no longer knows the kind): tables, `table.column type [pk, not null, unique]` lines, and lines with
// a cardinality (`1--*`, `*--1`, `1--1`, `*--*`, or `--`), whose ends may name columns. A line between two whole
// tables joins the key and the referring column the ER board would have made; when there is none, its words stay
// as a comment and no column is invented. Relationship names and `[weak]` become notes.

const HEAD = /^﻿?[ \t]*diagram[ \t]+(\w+)/;

/** True when the text's first line is `diagram er`: an ER diagram from before ADR 0030. */
export function isErFlowText(text: string): boolean {
  return HEAD.exec(text)?.[1] === "er";
}

type Card = "1--*" | "*--1" | "1--1" | "*--*" | "--";
const CARDS: readonly Card[] = ["1--*", "*--1", "1--1", "*--*", "--"];

interface Column {
  name: string;
  type: string;
  flags: string[];
  notes: string[];
}
interface Table {
  name: string;
  weak: boolean;
  columns: Column[];
}
interface End {
  name: string;
  quoted: boolean;
}
interface Line {
  from: End;
  to: End;
  card: Card;
  label: string | null;
}

/** Where a `//` comment starts outside quotes, or the line's length. */
function commentAt(s: string): number {
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "/" && s[i + 1] === "/") return i;
  }
  return s.length;
}

const ws = (c: string | undefined) => c === " " || c === "\t";

/** The cardinality at `i`, as the flow parser read one: `--` and `1--*` stand alone between spaces. */
function cardAt(s: string, i: number): Card | null {
  const ends = (k: number) => k >= s.length || ws(s[k]);
  for (const c of CARDS) if (s.startsWith(c, i) && ends(i + c.length) && (c !== "--" || i === 0 || ws(s[i - 1]))) return c;
  return null;
}

/** A bare name stops where the flow parser stopped one: brackets, braces, `:`, `>`, `<`, quotes, `--`, a lone `-`. */
function stopsName(s: string, j: number): boolean {
  const c = s[j];
  if ("[]{}:<>\"\\".includes(c)) return true;
  if (c === "-") return s[j + 1] === "-" || s[j + 1] === ">" || ((j === 0 || ws(s[j - 1])) && (j + 1 >= s.length || ws(s[j + 1])));
  return false;
}

/** A name at `i`: quoted with `\"`, `\\`, `\n`, or bare; and where reading stopped. */
function nameAt(s: string, i: number): { name: End; to: number } | null {
  while (ws(s[i])) i++;
  if (s[i] === '"') {
    let out = "";
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "\\" && j + 1 < s.length) {
        const n = s[++j];
        out += n === "n" || n === "r" ? " " : n;
      } else if (s[j] === '"') return { name: { name: out, quoted: true }, to: j + 1 };
      else out += s[j];
    }
    return null;
  }
  let j = i;
  while (j < s.length && !stopsName(s, j)) j++;
  let name = s.slice(i, j).trim();
  // `customers 1--* orders`: the near multiplicity sits against the name before the `--`.
  if (s.startsWith("--", j) && /\s[1*]$/.test(name) && (s[j - 1] === "1" || s[j - 1] === "*")) {
    name = name.slice(0, -1).trim();
    j -= 1;
  }
  return name === "" ? null : { name: { name, quoted: false }, to: j };
}

/** The words of a `[...]` list, lower case; null when it never closes. */
function listAt(s: string, i: number): { words: string[]; to: number } | null {
  const close = s.indexOf("]", i);
  if (close < 0) return null;
  const words = s
    .slice(i + 1, close)
    .split(",")
    .map((w) => w.trim().toLowerCase().split(/\s+/).join(" "))
    .filter((w) => w !== "");
  return { words, to: close + 1 };
}

const FLAGS = ["pk", "not null", "unique"];

/** Reads the ER text into tables and lines, in the order the flow parser read them. */
function read(text: string): { tables: Table[]; lines: Line[] } {
  const tables: Table[] = [];
  const byName = new Map<string, Table>();
  const lines: Line[] = [];
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).slice(1);
  for (const raw of rows) {
    const s = raw.slice(0, commentAt(raw)).trim();
    if (s === "" || s === "{" || s === "}") continue;
    const first = nameAt(s, 0);
    if (!first) continue;
    let q = first.to;
    while (ws(s[q])) q++;
    const card = cardAt(s, q);
    if (card) {
      const names: End[] = [first.name];
      const cards: Card[] = [];
      let c: Card | null = card;
      while (c) {
        cards.push(c);
        const next = nameAt(s, q + c.length);
        if (!next) break;
        names.push(next.name);
        q = next.to;
        while (ws(s[q])) q++;
        c = cardAt(s, q);
      }
      let label: string | null = null;
      if (s[q] === ":") {
        const rest = s.slice(q + 1).trim();
        label = rest.startsWith('"') ? (nameAt(rest, 0)?.name.name ?? rest) : rest;
        if (label === "") label = null;
      }
      for (let k = 0; k + 1 < names.length; k++) lines.push({ from: names[k], to: names[k + 1], card: cards[k], label: k === cards.length - 1 ? label : null });
      continue;
    }
    const n = first.name.name;
    const dot = first.name.quoted ? -1 : n.indexOf(".");
    const owner = dot > 0 ? byName.get(n.slice(0, dot)) : undefined;
    // A column: `customers.email text [not null]`, once its table is there (else `sales.orders [entity]` is a table).
    if (dot > 0 && !byName.has(n) && (s[q] !== "[" || owner)) {
      if (!owner) continue;
      const row = n.slice(dot + 1).trim();
      const space = row.search(/\s/);
      const name = space < 0 ? row : row.slice(0, space);
      const type = space < 0 ? "" : row.slice(space).trim();
      const flags = s[q] === "[" ? (listAt(s, q)?.words ?? []).filter((w) => FLAGS.includes(w)) : [];
      owner.columns.push({ name, type, flags: FLAGS.filter((f) => flags.includes(f)), notes: [] });
      continue;
    }
    if (byName.has(n)) continue;
    const kind = s[q] === "[" ? (listAt(s, q)?.words ?? []).find((w) => !w.includes(":")) : undefined;
    const table: Table = { name: n, weak: kind === "weak", columns: [] };
    tables.push(table);
    byName.set(n, table);
  }
  return { tables, lines };
}

const plain = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
const ident = (name: string) => (plain(name) ? name : `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
const typeText = (type: string) => (type === "" ? "text" : /^[A-Za-z_][A-Za-z0-9_]*(\([0-9, ]*\))?$/.test(type) ? type : `"${type.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
const noteText = (s: string) => `'${s.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The board's rules (ER build C): a table's key is its pk column, else one named id. */
function keyOf(t: Table): Column | null {
  return t.columns.find((c) => c.flags.includes("pk")) ?? t.columns.find((c) => c.name.toLowerCase() === "id") ?? null;
}

/** The column of `many` that refers to `one`'s key, named as the ER board named it (`customers` gives `customer_id`). */
function referring(many: Table, one: Table, key: Column): Column | null {
  const upper = /[A-Z]/.test(one.name) && one.name === one.name.toUpperCase();
  const base = upper ? singular(one.name) : underscore(singular(one.name));
  const wanted = `${base}_${key.name}`.toLowerCase();
  return many.columns.find((c) => c.name.toLowerCase() === wanted) ?? null;
}

/**
 * Converts an ER diagram's text to DBML for the Schema Builder. `name` is the diagram's name, for the comment at
 * the top. The result always reads as valid DBML: what cannot be a table or a Ref stays as a comment.
 */
export function erToDbml(text: string, name: string): string {
  const { tables, lines } = read(text);
  const byName = new Map(tables.map((t) => [t.name, t]));
  const end = (e: End): { table: Table; column: Column | null } | null => {
    const whole = byName.get(e.name);
    if (whole || e.quoted) return whole ? { table: whole, column: null } : null;
    const dot = e.name.indexOf(".");
    const table = dot > 0 ? byName.get(e.name.slice(0, dot)) : undefined;
    const column = table?.columns.find((c) => c.name === e.name.slice(dot + 1).trim());
    return table && column ? { table, column } : null;
  };
  const refs: string[] = [];
  const seen = new Set<string>();
  const comments: string[] = [];
  for (const l of lines) {
    const a = end(l.from);
    const b = end(l.to);
    const words = `${l.from.name} ${l.card} ${l.to.name}${l.label ? ` : ${l.label}` : ""}`;
    if (!a || !b) {
      comments.push(`// Not converted: ${words}. One end is not a table or a column of one.`);
      continue;
    }
    // Which end is the many one: `*--1` reads from the first, `1--*` from the second; otherwise text order.
    const flip = l.card === "1--*";
    let many = flip ? b : a;
    let one = flip ? a : b;
    let manyCol = many.column;
    let oneCol = one.column;
    if (!oneCol) oneCol = keyOf(one.table);
    if (!manyCol && oneCol) manyCol = l.card === "*--*" ? keyOf(many.table) : referring(many.table, one.table, oneCol);
    // A bare `--` or `1--1` whose referring column is on the other side.
    if ((!manyCol || !oneCol) && (l.card === "--" || l.card === "1--1") && !a.column && !b.column) {
      const key = keyOf(a.table);
      const col = key ? referring(b.table, a.table, key) : null;
      if (key && col) {
        many = b;
        one = a;
        manyCol = col;
        oneCol = key;
      }
    }
    if (!manyCol || !oneCol) {
      comments.push(`// Not converted: ${words}. No column joins these tables; add one and a Ref.`);
      continue;
    }
    const op = l.card === "1--1" ? "-" : l.card === "*--*" ? "<>" : ">";
    if (l.label) manyCol.notes.push(`${a.table.name} ${l.label} ${b.table.name}`);
    const left = `${ident(many.table.name)}.${ident(manyCol.name)}`;
    const right = `${ident(one.table.name)}.${ident(oneCol.name)}`;
    const key = [left, right].sort().join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(`Ref: ${left} ${op} ${right}`);
  }

  const out: string[] = [`// Converted from the ER diagram ${name}. The original file is unchanged.`];
  for (const t of tables) {
    out.push("");
    if (t.columns.length === 0) {
      out.push(`// Table ${t.name} had no columns in the ER diagram; add one to keep it.`);
      continue;
    }
    out.push(`Table ${ident(t.name)} {`);
    for (const c of t.columns) {
      const settings = [...c.flags, ...(c.notes.length > 0 ? [`note: ${noteText(c.notes.join("; "))}`] : [])];
      out.push(`  ${ident(c.name)} ${typeText(c.type)}${settings.length > 0 ? ` [${settings.join(", ")}]` : ""}`);
    }
    if (t.weak) out.push("  Note: 'Weak entity'");
    out.push("}");
  }
  if (refs.length > 0 || comments.length > 0) out.push("", ...refs, ...comments);
  return `${out.join("\n")}\n`;
}

// The Rails inflector's singular rules, as the ER board named a referring column (ER build C, fix round 2, I4).
const SINGULAR_RULES: [RegExp, string][] = [
  [/(database)s$/i, "$1"],
  [/(quiz)zes$/i, "$1"],
  [/(matr)ices$/i, "$1ix"],
  [/(vert|ind)ices$/i, "$1ex"],
  [/^(ox)en/i, "$1"],
  [/(alias|status)(es)?$/i, "$1"],
  [/(octop|vir)(us|i)$/i, "$1us"],
  [/^(a)x[ie]s$/i, "$1xis"],
  [/(cris|test)(is|es)$/i, "$1is"],
  [/(shoe)s$/i, "$1"],
  [/(o)es$/i, "$1"],
  [/(bus)(es)?$/i, "$1"],
  [/^(m|l)ice$/i, "$1ouse"],
  [/(x|ch|ss|sh)es$/i, "$1"],
  [/(m)ovies$/i, "$1ovie"],
  [/(s)eries$/i, "$1eries"],
  [/([^aeiouy]|qu)ies$/i, "$1y"],
  [/([lr])ves$/i, "$1f"],
  [/(tive)s$/i, "$1"],
  [/(hive)s$/i, "$1"],
  [/([^f])ves$/i, "$1fe"],
  [/(^analy)(sis|ses)$/i, "$1sis"],
  [/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/i, "$1sis"],
  [/([ti])a$/i, "$1um"],
  [/(n)ews$/i, "$1ews"],
  [/(ss)$/i, "$1"],
  [/s$/i, ""],
];
const IRREGULAR: [string, string][] = [
  ["person", "people"],
  ["man", "men"],
  ["child", "children"],
  ["sex", "sexes"],
  ["move", "moves"],
  ["zombie", "zombies"],
];
const UNCOUNTABLE = ["equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "jeans", "police"];

/** `categories` is `category`, `people` is `person`; a name in capitals stays in capitals. */
function singular(word: string): string {
  const upper = /[A-Z]/.test(word) && word === word.toUpperCase();
  let out = word;
  if (!UNCOUNTABLE.some((u) => new RegExp(`\\b${u}$`, "i").test(word))) {
    out = (() => {
      for (const [one, many] of IRREGULAR) {
        const m = new RegExp(`(${many[0]})${many.slice(1)}$`, "i").exec(word);
        if (m) return word.slice(0, m.index) + m[1] + one.slice(1);
        if (new RegExp(`(${one[0]})${one.slice(1)}$`, "i").test(word)) return word;
      }
      for (const [rule, to] of SINGULAR_RULES) if (rule.test(word)) return word.replace(rule, to);
      return word;
    })();
  }
  return upper ? out.toUpperCase() : out;
}

/** Rails' `underscore`: `OrderItem` is `order_item`. */
function underscore(word: string): string {
  return word
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}
