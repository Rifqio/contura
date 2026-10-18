import { type ReactNode, useEffect, useRef } from "react";
import { DIALECT_LABEL } from "../api/client";
import type { DialectKind } from "../api/types";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import SqlBlock from "../components/SqlBlock";
import { missingName, nearName } from "./nearName";
import { missingKind, serverError } from "./serverError";
import type { Stmt } from "./statements";

interface Props {
  /** The failed statement's number in its run, from 1. */
  statementIndex: number;
  line: number;
  column: number;
  dialect: DialectKind;
  /** The server's message, as it was sent. */
  message: string;
  /** The statements after the failed one that did not run. */
  notRun: Stmt[];
  /** Table and column names in the loaded tree, for "Did you mean". */
  names: string[];
  /** Table names alone, so a missing table is matched against tables only; falls back to `names`. */
  tableNames?: string[];
  /** Where a missing table was looked for, such as "shop.public". */
  scope?: string | null;
  /** The editor line of an offset, so each not-run statement shows its own line numbers (R41). */
  lineOf?(offset: number): number;
  /** The connection dropped: the failure is not the statement's. */
  lost: boolean;
  /** The message is Contura's own words, not the server's. */
  own?: boolean;
  /** An extra line under the message, such as why a Read-only refusal changed nothing. */
  note?: string;
  connectionName?: string;
  /** The result number of the statement that ran just before, when there is one. */
  earlierResult?: number | null;
  onGoTo(): void;
  /** Absent when AI access is off. */
  onAsk?(): void;
  onCopy(text: string): void;
  onReconnect(): void;
  /** One more action after Go to line, such as a Visual Query's "Show the Join". */
  extraAction?: ReactNode;
}

/** "Statement 2", "Statements 2 and 3", "Statements 2, 3 and 4". */
function statements(nums: number[]): string {
  if (nums.length === 1) return `Statement ${nums[0]}`;
  return `Statements ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]}`;
}

/** A failed statement, said once and plainly; or the dropped connection behind it. */
export default function QueryError(p: Props) {
  const reconnect = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (p.lost) reconnect.current?.focus();
  }, [p.lost]);

  if (p.lost) {
    const name = p.connectionName ?? "The connection";
    const didNot = statements([p.statementIndex, ...p.notRun.map((_, i) => p.statementIndex + 1 + i)]);
    const ran = p.statementIndex - 1;
    const before =
      ran === 1
        ? ` Statement 1 ran and its rows are in Result ${p.earlierResult ?? 1}.`
        : ran > 1
          ? ` Statements 1 to ${ran} ran.`
          : "";
    return (
      <div className="query-error query-error-lost" role="alert">
        <div className="query-error-head">
          <Icon name="error" />
          <h3>Lost the connection to {name}</h3>
        </div>
        <p>{`${name} is closed now. ${didNot} did not run.${before}`}</p>
        <div className="result-actions">
          <button type="button" className="button button-primary" ref={reconnect} onClick={p.onReconnect}>
            Reconnect and run statement {p.statementIndex}
            <Kbd keys="Enter" />
          </button>
          <button type="button" className="button button-ghost" onClick={() => p.onCopy(copyText(p))}>
            Copy error
          </button>
        </div>
      </div>
    );
  }

  const said = p.own ? { code: null, text: p.message } : serverError(p.message, p.dialect);
  const word = missingName(said.text);
  const kind = word ? missingKind(said.text) : null;
  const near = word ? nearName(word, kind === "table" && p.tableNames?.length ? p.tableNames : p.names) : null;
  // "shop.shipment" names its own scope; otherwise the database and schema the query ran in.
  const quoted = /(['"`])([^'"`]+)\1/.exec(said.text)?.[2] ?? "";
  const scope = quoted.includes(".") ? quoted.slice(0, quoted.lastIndexOf(".")) : p.scope ?? null;
  return (
    <div className="query-error" role="alert">
      <div className="query-error-head">
        <Icon name="error" className="query-error-icon" />
        <h3>Statement {p.statementIndex} failed</h3>
        <span className="query-error-pos">
          Line {p.line}, Col {p.column}
        </span>
      </div>
      {/* Frame 2: one red box, the source and its SQLSTATE over the message. */}
      <div className="query-error-said">
        <div className="query-error-said-head">
          <span className="query-error-source">{p.own ? "Contura said" : `${DIALECT_LABEL[p.dialect]} said`}</span>
          {said.code && (
            <span className="query-error-code" title="SQLSTATE">
              {said.code}
            </span>
          )}
        </div>
        <code className="query-error-message">{quotedParts(said.text)}</code>
      </div>
      {near && word && (
        <p className="query-error-near">
          <Icon name="info" size={14} />
          <span>
            {kind ? (
              <>
                There is no {kind} named <code>{word}</code>
                {kind === "table" && scope ? ` in ${scope}` : ""}. Did you mean <code>{near}</code>?
              </>
            ) : (
              <>
                Did you mean <code>{near}</code>?
              </>
            )}
          </span>
        </p>
      )}
      {p.note && <p className="muted">{p.note}</p>}
      {p.notRun.length > 0 && (
        <section className="query-error-notrun">
          <h4>Not run, because statement {p.statementIndex} failed</h4>
          {/* R41: one block per statement, numbered from its own line, so statements apart in the editor keep their real numbers. */}
          <div className="query-error-notrun-list" role="group" aria-label="Statements that did not run">
            {p.notRun.map((s, i) => (
              <SqlBlock
                key={`${i}:${s.from}`}
                sql={`${s.text};`}
                dialect={p.dialect}
                lineNumbers={p.lineOf !== undefined}
                startLine={p.lineOf?.(s.from) ?? 1}
              />
            ))}
          </div>
        </section>
      )}
      <div className="result-actions">
        <button type="button" className="button" onClick={p.onGoTo}>
          <Icon name="arrowRight" size={14} />
          Go to line {p.line}
        </button>
        {p.extraAction}
        {p.onAsk && (
          <button type="button" className="button" onClick={p.onAsk}>
            <Icon name="msg" size={14} />
            Ask AI
          </button>
        )}
        <button type="button" className="button button-ghost" onClick={() => p.onCopy(copyText(p))}>
          <Icon name="copy" size={14} />
          Copy error
        </button>
      </div>
    </div>
  );
}

/** The message with its quoted names in the string colour, as frame 2 draws `relation "shipment"`. */
function quotedParts(text: string) {
  const parts = text.split(/("[^"\n]*"|'[^'\n]*')/);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="query-error-quoted">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

const copyText = (p: Props) => `Statement ${p.statementIndex}, line ${p.line}: ${p.message}`;
