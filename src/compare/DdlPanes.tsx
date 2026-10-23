import { useMemo } from "react";
import type { DdlPair, DialectKind } from "../api/types";
import { highlightSql, type Span } from "../lang/sql/highlightStatic";
import { type AlignedRow, type LineMark, alignLines, ddlLines, lineKey } from "./align";

/** One side's header: its database mark and name, PROD where it applies, and Source or Target. */
export interface PaneSide {
  name: string;
  /** Item 44: the database, then the schema on PostgreSQL, so two sides on one Connection read apart. */
  scope?: string[];
  lead?: React.ReactNode;
  tag?: React.ReactNode;
}

interface Props {
  pair: DdlPair | null;
  dialect: DialectKind;
  source: PaneSide;
  target: PaneSide;
  /** The target is a Production Connection: its pane carries the Production wash. */
  production: boolean;
  /** The selected column or value: its lines get the focus bar. */
  focus: string | null;
  loading?: boolean;
  error?: string | null;
}

const MARK_CHAR: Record<LineMark, string> = { same: "", changed: "~", added: "+", removed: "−" };
const MARK_CLASS: Record<LineMark, string> = { same: "", changed: "compare-dl-chg", added: "compare-dl-add", removed: "compare-dl-rem" };
const MARK_WORD: Record<LineMark, string | null> = { same: null, changed: "differs", added: "in source only", removed: "in target only" };

function Spans({ spans }: { spans: Span[] | undefined }) {
  if (!spans) return null;
  return (
    <>
      {spans.map((s, j) =>
        s.cls ? (
          <span key={j} className={s.cls}>
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

function Pane({
  side,
  role,
  rows,
  spans,
  focus,
  wash,
}: {
  side: PaneSide;
  role: "Source" | "Target";
  rows: AlignedRow[];
  spans: Span[][];
  focus: string | null;
  wash: boolean;
}) {
  const left = role === "Source";
  return (
    <section className={wash ? "compare-pane prod-wash" : "compare-pane"} aria-label={`${role} DDL, ${[side.name, ...(side.scope ?? [])].join(", ")}`}>
      <header className="compare-pane-head">
        {side.lead}
        <span className="compare-pane-name">{side.name}</span>
        {side.scope?.map((part, i) => (
          <span key={i} className="compare-pane-scope-part">
            <span className="compare-pane-sep" aria-hidden="true">
              ·
            </span>
            <span className="compare-pane-scope mono">{part}</span>
          </span>
        ))}
        {side.tag}
        <span className="compare-pane-role">{role}</span>
      </header>
      <div className="compare-pane-body mono">
        {rows.map((r, i) => {
          const line = left ? r.left : r.right;
          if (!line) return <div key={i} className="compare-dl compare-dl-fill" data-mark="fill" aria-hidden="true" />;
          const foc = focus !== null && lineKey(line.text) === focus;
          const word = MARK_WORD[r.mark];
          return (
            <div key={i} className={["compare-dl", MARK_CLASS[r.mark], foc && "compare-dl-foc"].filter(Boolean).join(" ")} data-mark={r.mark}>
              <span className="compare-dl-n" aria-hidden="true">
                {line.n}
              </span>
              <span className="compare-dl-mk" title={word ?? undefined}>
                {MARK_CHAR[r.mark]}
                {word && <span className="visually-hidden">{word}</span>}
              </span>
              <code className="compare-dl-ct">
                <Spans spans={spans[line.n - 1]} />
              </code>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The selected table's DDL on both sides, aligned line by line: source left, target right, filler rows opposite one-sided lines. */
export default function DdlPanes({ pair, dialect, source, target, production, focus, loading, error }: Props) {
  const view = useMemo(() => {
    const l = ddlLines(pair?.source ?? null);
    const r = ddlLines(pair?.target ?? null);
    return {
      rows: alignLines(l, r),
      left: l.length > 0 ? highlightSql(l.join("\n"), dialect) : [],
      right: r.length > 0 ? highlightSql(r.join("\n"), dialect) : [],
    };
  }, [pair, dialect]);
  if (error) {
    return (
      <div className="compare-panes compare-panes-state" role="alert">
        {error}
      </div>
    );
  }
  if (!pair) return <div className="compare-panes compare-panes-state">{loading ? "Reading both sides..." : null}</div>;
  return (
    <div className="compare-panes">
      <Pane side={source} role="Source" rows={view.rows} spans={view.left} focus={focus} wash={false} />
      <Pane side={target} role="Target" rows={view.rows} spans={view.right} focus={focus} wash={production} />
    </div>
  );
}
