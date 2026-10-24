import { framedScript } from "../api/scriptFrame";
import { useEffect, useRef, useState } from "react";
import { errorText, planDesign } from "../api/client";
import type { ConnectionId, DesignMode, DesignRequest, DesignVerdict, DialectKind } from "../api/types";
import Icon from "../components/Icon";
import SqlBlock from "../components/SqlBlock";
import WarningBanner from "../components/WarningBanner";
import { warningText } from "./warnings";

interface Props {
  connectionId: ConnectionId;
  dialect: DialectKind;
  /** The design to plan; null plans nothing (no changes, a blocked draft, Read-only). */
  request: DesignRequest | null;
  /** Told each new plan, and null when there is none or planning failed. */
  onPlan(p: DesignVerdict | null): void;
  /** A Production Connection: the island gets the wash too. */
  production?: boolean;
  /** Shown instead of the SQL when there is no request. */
  idle?: string;
  /**
   * A plan Apply made for a request (`key` is its JSON): when it is this request's, it shows at
   * once, so the preview shows what Apply checked (S13 I2).
   */
  fresh?: { key: string; plan: DesignVerdict } | null;
}

/** What Apply does with these statements, by the plan's mode. */
export function modeLine(mode: DesignMode, statements: number): string {
  switch (mode.kind) {
    case "transaction":
      return "Apply runs exactly this, in one transaction.";
    case "atomic":
      return "Apply runs exactly this. MySQL applies it all or nothing.";
    case "sequential":
      return statements === 1
        ? "MySQL runs this 1 statement. If it fails, nothing is applied."
        : `MySQL runs these ${statements} statements one by one. If one fails, the ones before it stay applied.`;
    case "copyOnly":
      return `Contura cannot rebuild this table safely: ${mode.reason}. Copy this SQL to run it yourself.`;
  }
}

/** The statements as one text: a blank line between them, each ending with ";". */
export function planSql(statements: string[]): string {
  return statements.length === 0 ? "" : `${statements.join(";\n\n")};`;
}

/** D22: the SQL island under the designer grid, planned 200 ms after the last change. */
export default function DesignPreview({ connectionId, dialect, request, onPlan, production = false, idle, fresh }: Props) {
  const [plan, setPlan] = useState<DesignVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const told = useRef(onPlan);
  told.current = onPlan;
  const key = request ? JSON.stringify(request) : null;
  /** The request whose plan is on screen. */
  const shownKey = useRef<string | null>(null);

  useEffect(() => {
    if (!request) {
      shownKey.current = null;
      setPlan(null);
      setError(null);
      told.current(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      // Apply's plan for this request is on screen already.
      if (shownKey.current === key) return;
      planDesign(connectionId, request).then(
        (p) => {
          if (!live) return;
          shownKey.current = key;
          setPlan(p);
          setError(null);
          told.current(p);
        },
        (e) => {
          if (!live) return;
          shownKey.current = null;
          setPlan(null);
          setError(errorText(e, dialect));
          told.current(null);
        },
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` stands for `request`'s content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, key]);

  useEffect(() => {
    if (!fresh || fresh.key !== key) return;
    shownKey.current = key;
    setPlan(fresh.plan);
    setError(null);
    told.current(fresh.plan);
  }, [fresh, key]);

  const shown = request ? plan : null;
  const sql = shown ? planSql(shown.plan.statements) : "";
  const sub = !request ? (idle ?? "") : shown ? modeLine(shown.plan.mode, shown.plan.statements.length) : "";

  return (
    <section className={["design-island", production && "prod-wash"].filter(Boolean).join(" ")} aria-label="SQL preview">
      <div className="design-island-head">
        <Icon name="fileCode" size={14} className="muted" />
        <span className="design-island-title">SQL preview</span>
        <span className="design-island-sub">{sub}</span>
        <span className="edits-spacer" />
        <button
          type="button"
          className="icon-button"
          aria-label="Copy SQL"
          title="Copy SQL"
          disabled={!sql}
          onClick={() => sql && void navigator.clipboard?.writeText(framedScript(shown?.frame, sql)).catch(() => {})}
        >
          <Icon name="copy" size={14} />
        </button>
      </div>
      <div className="design-island-body">
        {request && error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {shown?.plan.warnings.map((w, i) => (
          <WarningBanner key={i}>{warningText(w)}</WarningBanner>
        ))}
        {sql && <SqlBlock sql={sql} dialect={dialect} className="design-sql" ariaLabel="SQL Apply runs" />}
      </div>
    </section>
  );
}
