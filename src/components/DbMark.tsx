import { DIALECT_LABEL } from "../api/client";
import type { DialectKind } from "../api/types";
import {
  MYSQL_PATH,
  MYSQL_VIEWBOX,
  POSTGRESQL_PATH,
  POSTGRESQL_VIEWBOX,
  SQLITE_PATH,
  SQLITE_VIEWBOX,
} from "./dbMarkPaths";

const MARKS: Record<DialectKind, { viewBox: string; d: string; colour: string; hairline?: string }> = {
  mysql: { viewBox: MYSQL_VIEWBOX, d: MYSQL_PATH, colour: "var(--db-mysql)", hairline: ".5" },
  postgres: { viewBox: POSTGRESQL_VIEWBOX, d: POSTGRESQL_PATH, colour: "var(--db-pg)", hairline: ".35" },
  sqlite: { viewBox: SQLITE_VIEWBOX, d: SQLITE_PATH, colour: "var(--db-sqlite)" },
};

interface Props {
  dialect: DialectKind;
  /** An open Connection shows the brand colour; a closed one goes faint. */
  open: boolean;
  size?: 14 | 16;
  /** Accessible name; `null` hides the mark where the database is already named in text. */
  label?: string | null;
}

/** The database brand mark of a Connection. */
export default function DbMark({ dialect, open, size = 16, label }: Props) {
  const m = MARKS[dialect];
  const name = label === undefined ? DIALECT_LABEL[dialect] : label;
  return (
    <svg
      className={`db-mark db-mark-${dialect}`}
      viewBox={m.viewBox}
      width={size}
      height={size}
      fill="currentColor"
      stroke={m.hairline ? "currentColor" : "none"}
      strokeWidth={m.hairline}
      strokeLinejoin="round"
      style={{ color: open ? m.colour : "var(--c-text-faint)" }}
      focusable="false"
      {...(name === null ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
    >
      <path d={m.d} />
    </svg>
  );
}
