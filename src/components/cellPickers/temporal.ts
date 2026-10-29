// Date and time values as the grid shows and writes them, read into parts for the pickers and written back.
// The text box stays the source: a value is only rewritten when a picker changes it.
import type { DialectKind } from "../../api/types";

export type TemporalKind = "date" | "time" | "datetime";

export interface TemporalSpec {
  kind: TemporalKind;
  /** How many fraction-of-a-second digits the column keeps (0: none). */
  fraction: number;
  /** PostgreSQL and SQLite write no trailing zeros; MySQL writes exactly `fraction` digits. */
  trim: boolean;
  /** The type keeps an offset (PostgreSQL `with time zone`). */
  zone: boolean;
}

export interface Day {
  y: number;
  m: number;
  d: number;
}

export interface Clock {
  h: number;
  mi: number;
  s: number;
  /** The fraction's digits as typed, such as "120". */
  frac: string;
}

export interface Temporal {
  date: Day | null;
  time: Clock | null;
  /** The offset exactly as typed (`+00`, `+05:30`, `Z`), or "". */
  zone: string;
}

const PG_DEFAULT_FRACTION = 6;
const SQLITE_FRACTION = 3;

/** What picker a column type gets, or null when it has none. */
export function temporalSpec(typeName: string, dialect: DialectKind): TemporalSpec | null {
  const t = typeName.trim().toLowerCase();
  if (dialect === "mysql") {
    if (t === "date") return { kind: "date", fraction: 0, trim: false, zone: false };
    const m = /^(time|datetime|timestamp)(?:\((\d)\))?$/.exec(t);
    if (!m) return null;
    return { kind: m[1] === "time" ? "time" : "datetime", fraction: m[2] ? Number(m[2]) : 0, trim: false, zone: false };
  }
  if (dialect === "postgres") {
    if (t === "date") return { kind: "date", fraction: 0, trim: true, zone: false };
    const short = /^(timestamptz|timetz)(?:\((\d)\))?$/.exec(t);
    if (short) return { kind: short[1] === "timetz" ? "time" : "datetime", fraction: precision(short[2]), trim: true, zone: true };
    const m = /^(time|timestamp)(?:\((\d)\))?(?: (with|without) time zone)?$/.exec(t);
    if (!m) return null;
    return { kind: m[1] === "time" ? "time" : "datetime", fraction: precision(m[2]), trim: true, zone: m[3] === "with" };
  }
  if (t === "date") return { kind: "date", fraction: 0, trim: true, zone: false };
  if (t === "time") return { kind: "time", fraction: SQLITE_FRACTION, trim: true, zone: false };
  if (t === "datetime" || t === "timestamp") return { kind: "datetime", fraction: SQLITE_FRACTION, trim: true, zone: false };
  return null;
}

const precision = (p: string | undefined) => (p === undefined ? PG_DEFAULT_FRACTION : Number(p));

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/;
const ZONE = /^(?:Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)$/;

function readDay(y: string, m: string, d: string): Day | null {
  const day = { y: Number(y), m: Number(m), d: Number(d) };
  if (day.y < 1 || day.m < 1 || day.m > 12 || day.d < 1 || day.d > daysInMonth(day.y, day.m)) return null;
  return day;
}

function readClock(h: string, mi: string, s: string | undefined, frac: string | undefined): Clock | null {
  const c = { h: Number(h), mi: Number(mi), s: s === undefined ? 0 : Number(s), frac: frac ?? "" };
  return c.h > 23 || c.mi > 59 || c.s > 59 ? null : c;
}

/** The value's parts, or null when the picker cannot show it (empty, `infinity`, BC, out of range). */
export function parseTemporal(text: string, spec: TemporalSpec): Temporal | null {
  let rest = text.trim();
  let date: Day | null = null;
  let time: Clock | null = null;
  if (spec.kind !== "time") {
    const d = DATE.exec(rest);
    if (!d) return null;
    date = readDay(d[1], d[2], d[3]);
    if (!date) return null;
    rest = rest.slice(d[0].length);
    if (spec.kind === "date") return rest === "" ? { date, time: null, zone: "" } : null;
    if (rest === "") return { date, time: null, zone: "" };
    if (rest[0] !== " " && rest[0] !== "T") return null;
    rest = rest.slice(1);
  }
  const t = TIME.exec(rest);
  if (!t) return null;
  time = readClock(t[1], t[2], t[3], t[4]);
  if (!time) return null;
  const zone = rest.slice(t[0].length);
  if (zone !== "" && !(spec.zone && ZONE.test(zone))) return null;
  return { date, time, zone };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function fraction(frac: string, spec: TemporalSpec): string {
  if (spec.fraction === 0) return "";
  const digits = frac.slice(0, spec.fraction);
  const out = spec.trim ? digits.replace(/0+$/, "") : digits.padEnd(spec.fraction, "0");
  return out ? `.${out}` : "";
}

const MIDNIGHT: Clock = { h: 0, mi: 0, s: 0, frac: "" };

/** The value's text in the column's format: seconds always, the fraction to the column's precision. */
export function formatTemporal(v: Temporal, spec: TemporalSpec): string {
  const d = v.date ? `${pad(v.date.y, 4)}-${pad(v.date.m)}-${pad(v.date.d)}` : "";
  if (spec.kind === "date") return d;
  const c = v.time ?? MIDNIGHT;
  const t = `${pad(c.h)}:${pad(c.mi)}:${pad(c.s)}${fraction(c.frac, spec)}${v.zone}`;
  return spec.kind === "time" ? t : `${d} ${t}`;
}

const dayOf = (now: Date): Day => ({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });

/** The value with `date` picked; the time and offset stay. */
export function withDate(v: Temporal | null, date: Day): Temporal {
  return { date, time: v?.time ?? null, zone: v?.zone ?? "" };
}

/** The value with `time` set; with no day yet, today's. */
export function withTime(v: Temporal | null, time: Clock, now = new Date()): Temporal {
  return { date: v?.date ?? dayOf(now), time, zone: v?.zone ?? "" };
}

export const today = (now = new Date()): Day => dayOf(now);

/** The month's weeks, Sunday first, with null where a week runs into the month before or after. */
export function monthWeeks(y: number, m: number): (number | null)[][] {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = daysInMonth(y, m);
  const cells: (number | null)[] = [...Array<null>(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function addDays(day: Day, n: number): Day {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The same day `n` months on, or that month's last day when it is shorter. */
export function addMonths(day: Day, n: number): Day {
  const index = day.y * 12 + (day.m - 1) + n;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { y, m, d: Math.min(day.d, daysInMonth(y, m)) };
}

export const weekday = (day: Day) => new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();

export const sameDay = (a: Day | null, b: Day | null) => !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
