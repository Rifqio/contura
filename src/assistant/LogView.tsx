import { useMemo, useState } from "react";
import type { LogLevel, LogLine } from "../api/types";
import Icon from "../components/Icon";
import { fieldsText, logText, logTime } from "./answerRecord";
import { secondsText } from "./answerStream";

type Filter = "all" | "info" | "warn" | "error";

const CHIPS: [Filter, string][] = [
  ["all", "All"],
  ["info", "Info"],
  ["warn", "Warn"],
  ["error", "Error"],
];

/** Debug lines count and show under Info. */
const inLevel = (f: Filter, level: LogLevel) => f === "all" || level === f || (f === "info" && level === "debug");

/** A field value as JSON: numbers and booleans bare, everything else a string. */
function jsonValue(v: string): { text: string; cls: string } {
  if (/^-?\d+(\.\d+)?$/.test(v)) return { text: v, cls: "jn" };
  if (v === "true" || v === "false") return { text: v, cls: "jb" };
  return { text: JSON.stringify(v), cls: "js" };
}

interface Props {
  lines: LogLine[];
  onCopy(text: string): void;
}

/** The Log tab (board 11.3): a Grafana-style view of the answer log, one monospace row per line. */
export default function LogView({ lines, onCopy }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(false);
  const firstError = lines.findIndex((l) => l.level === "error");
  // The first error opens on its own; the set holds line indexes.
  const [open, setOpen] = useState<ReadonlySet<number> | null>(null);
  const opened = open ?? new Set(firstError >= 0 ? [firstError] : []);
  const toggle = (i: number) => {
    const next = new Set(opened);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setOpen(next);
  };

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => inLevel(filter, line.level))
        .filter(({ line }) => !q || `${line.source} ${fieldsText(line)}`.toLowerCase().includes(q)),
    [lines, filter, q],
  );
  const span = lines.length ? lines[lines.length - 1].atMs : 0;
  const errors = lines.filter((l) => l.level === "error").length;
  const wrapLabel = wrap ? "Do not wrap long lines" : "Wrap long lines";

  return (
    <>
      <div className="lvol" aria-label="Events over time">
        {lines.map((l, i) => (
          <span key={i} className={`vb ${l.level}`} style={{ left: `${span ? Math.min(90, (l.atMs / span) * 90) : 0}%` }} />
        ))}
        <span className="vt1">{secondsText(span)}</span>
      </div>
      <div className="lgbar">
        {CHIPS.map(([key, label]) => {
          const count = lines.filter((l) => inLevel(key, l.level)).length.toLocaleString("en-US");
          return (
            <button
              key={key}
              type="button"
              className={filter === key ? "lchip on" : "lchip"}
              aria-label={`${label} ${count}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              <span className={`ldot ${key}`} aria-hidden="true" />
              {label}
              <span className="n">{count}</span>
            </button>
          );
        })}
        <span className="spacer" />
        <button
          type="button"
          className={wrap ? "icon-button icon-button-on" : "icon-button"}
          aria-label={wrapLabel}
          title={wrapLabel}
          aria-pressed={wrap}
          onClick={() => setWrap((w) => !w)}
        >
          <Icon name="list" size={14} />
        </button>
        <button type="button" className="icon-button" aria-label="Copy the log" title="Copy the log" onClick={() => onCopy(logText(lines))}>
          <Icon name="copy" size={14} />
        </button>
      </div>
      <label className="lsearch">
        <Icon name="search" size={14} />
        <input
          className="mono"
          aria-label="Search the log"
          placeholder="Search the log, for example status=429"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className={wrap ? "lgrid wrap" : "lgrid"} role="log" aria-label="Answer log">
        {shown.map(({ line, i }) => {
          const isOpen = opened.has(i) && line.fields.length > 0;
          const tone = line.level === "error" || line.level === "warn" ? ` ${line.level}` : "";
          return (
            <div key={i} className="lline">
              <div
                className={`lrow${tone}`}
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={() => toggle(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(i);
                  }
                }}
              >
                <span className={line.fields.length ? "lchev" : "lchev none"} aria-hidden="true">
                  <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} />
                </span>
                <span className="lt">{logTime(line.atMs)}</span>
                <span className={`lv ${line.level}`}>{line.level.toUpperCase()}</span>
                <span className="ls">{line.source}</span>
                <span className="lm">{fieldsText(line)}</span>
              </div>
              {isOpen && (
                <div className="ljson">
                  {line.fields.map(([k, v], j) => {
                    const val = jsonValue(v);
                    return (
                      <div key={j}>
                        <span className="jk">{JSON.stringify(k)}</span>
                        <span className="jp">: </span>
                        <span className={val.cls}>{val.text}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {shown.length === 0 && <div className="lempty">{q ? "No lines match." : "No lines at this level."}</div>}
      </div>
      <div className="lfoot">
        {`${shown.length.toLocaleString("en-US")} of ${lines.length.toLocaleString("en-US")} lines`}
        {errors > 0 && ` · ${errors.toLocaleString("en-US")} ${errors === 1 ? "error" : "errors"}`}
        {" · click a line for its fields"}
      </div>
    </>
  );
}
