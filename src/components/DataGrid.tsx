import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { errorText, fetchPage, isNotOpen } from "../api/client";
import type { ColumnInfo, ConnectionId, DialectKind, KeyPart, ObjectPath, Page, SortSpec } from "../api/types";
import type { LangClient } from "../lang/client";
import { type SchemaCache, schemaKey } from "../lang/sql/schemaCache";
import InlineAsk from "../assistant/InlineAsk";
import type { AskContext, AskKit } from "../assistant/context";
import SqlEditor, { type AskSelection, type SqlEditorApi } from "../query/SqlEditor";
import ResultGrid from "./ResultGrid";
import Icon from "./Icon";
import { objectPrefix } from "../objectPath";

/** The table as SQL names it, so the filter is checked as `SELECT * FROM <it> WHERE <filter>`. */
function sqlName(dialect: DialectKind, t: ObjectPath): string {
  const q = (s: string) => (dialect === "mysql" ? `\`${s.replace(/`/g, "``")}\`` : `"${s.replace(/"/g, '""')}"`);
  if (dialect === "postgres") return t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
  return dialect === "mysql" ? `${q(t.database)}.${q(t.name)}` : q(t.name);
}

const noSubscribe = () => () => {};

const PAGE_SIZE = 1000;
const NUMERIC_TYPE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)\b/i;
interface Props {
  connectionId: ConnectionId;
  table: ObjectPath;
  onClose: () => void;
  /** The session is gone; the Connection must be opened again. */
  onNotOpen?: () => void;
  /** The Connection's Dialect, for the filter box. */
  dialect?: DialectKind;
  /** Completion and checks in the filter box. */
  lang?: { client: LangClient; schemas: SchemaCache };
  /** Ctrl+I in the filter box asks AI; absent, it does nothing. */
  ask?: AskKit & { connection: AskContext["connection"] };
}

/** The page on screen and its index. Replaced, never accumulated. */
type Shown = { index: number; page: Page };

function nextSort(current: SortSpec | null, column: string): SortSpec {
  if (current?.column === column) return { column, descending: !current.descending };
  return { column, descending: false };
}

function rowKey(columns: ColumnInfo[], row: Page["rows"][number]): KeyPart[] {
  return columns.flatMap((c, i) => (c.isPrimaryKey ? [{ column: c.name, value: row[i] }] : []));
}

/**
 * The read-only grid for one table or view. Only the current page lives in
 * state (ADR 0003): moving to another page replaces it, and the parent keys
 * this component by table so opening another table starts fresh. Only the
 * rows near the viewport are in the DOM; spacer rows stand in for the rest.
 */
export default function DataGrid({ connectionId, table, onClose, onNotOpen, dialect = "postgres", lang, ask }: Props) {
  const [pageIndex, setPageIndex] = useState(0);
  const [sort, setSort] = useState<SortSpec | null>(null);
  /** The filter in use, and what is typed in the box. */
  const [filter, setFilter] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const filterRef = useRef<SqlEditorApi | null>(null);
  const [askSel, setAskSel] = useState<AskSelection | null>(null);
  const schemaLoad = useSyncExternalStore(
    lang ? (l) => lang.schemas.subscribe(l) : noSubscribe,
    () => lang?.schemas.state(connectionId, table.database) ?? null,
  );
  useEffect(() => {
    if (lang) void lang.schemas.ensure(connectionId, table.database);
  }, [lang, connectionId, table.database]);
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // `table` is fixed for this component's lifetime: the parent re-keys it per table.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetchPage(connectionId, { table, page: pageIndex, sort, filter })
      .then((page) => {
        if (!live) return;
        setShown({ index: pageIndex, page });
      })
      .catch((e) => {
        if (!live) return;
        if (isNotOpen(e)) onNotOpen?.();
        setError(errorText(e));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [connectionId, pageIndex, sort, filter, attempt]);

  function applyFilter() {
    const text = (filterRef.current?.text() ?? draft).trim();
    setFilter(text || null);
    setPageIndex(0);
  }

  function clearFilter(): boolean {
    if (!filter && !draft) return false;
    setDraft("");
    filterRef.current?.replaceAll("");
    setFilter(null);
    setPageIndex(0);
    return true;
  }

  function chooseSort(column: string) {
    setSort((s) => nextSort(s, column));
    setPageIndex(0);
  }

  function clearSort() {
    setSort(null);
    setPageIndex(0);
  }

  const askSchema = lang ? lang.client.sqlSchemaFor(schemaKey(connectionId, table.database)) : null;
  const page = shown?.page ?? null;
  const columns = page?.columns ?? [];
  const firstRow = (shown?.index ?? 0) * PAGE_SIZE + 1;

  const rangeText =
    page && page.rows.length > 0
      ? `Rows ${firstRow.toLocaleString("en-US")} to ${(firstRow + page.rows.length - 1).toLocaleString("en-US")}`
      : "";

  return (
    <section className="grid-view" aria-label={`Data of ${table.name}`}>
      <div className="toolbar">
        <Icon name="table" className="muted" />
        <h2 className="toolbar-title">
          <span className="muted">{objectPrefix(table)}</span>
          {table.name}
        </h2>
        <span className="toolbar-meta">
          {loading && <span>Loading rows…</span>}
          {rangeText && <span>{rangeText}</span>}
        </span>
        <button type="button" className="icon-button" aria-label={`Close ${table.name}`} onClick={onClose}>
          <Icon name="close" />
        </button>
        <div className={loading ? "progress progress-on" : "progress"} aria-hidden="true">
          <i />
        </div>
      </div>

      <div className="grid-filter">
        <span className="grid-filter-label" aria-hidden="true">
          WHERE
        </span>
        <SqlEditor
          oneLine
          value={draft}
          dialect={dialect}
          editorRef={filterRef}
          onChange={setDraft}
          onRun={applyFilter}
          onFormat={() => {}}
          onSave={() => {}}
          onEscape={clearFilter}
          onAsk={ask ? setAskSel : undefined}
          lang={
            lang && {
              client: lang.client,
              docId: `filter:${connectionId}:${objectPrefix(table)}${table.name}`,
              schemaKey: schemaKey(connectionId, table.database),
              schemaState: schemaLoad === "loaded" ? "loaded" : schemaLoad === "loading" ? "loading" : "none",
              prefix: `SELECT * FROM ${sqlName(dialect, table)} WHERE `,
            }
          }
        />
        {ask && askSel && (
          <InlineAsk
            context={{
              kind: "filter",
              connection: ask.connection,
              sql: askSel.sql,
              tables: [{ schema: table.schema, name: table.name }],
              label: table.name,
            }}
            schema={askSchema}
            groupId={ask.groupId}
            onOpenInChat={ask.onOpenInChat}
            onOpenSettings={ask.onOpenSettings}
            onClose={() => {
              setAskSel(null);
              filterRef.current?.focus();
            }}
          />
        )}
      </div>

      {error ? (
        <div className="grid-scroll">
          <div className="state-panel" role="alert">
            <p className="error-text">{error}</p>
            <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
            {sort && (
              <button type="button" className="button" onClick={clearSort}>
                Clear sort
              </button>
            )}
            {filter && (
              <button type="button" className="button" onClick={clearFilter}>
                Clear filter
              </button>
            )}
          </div>
        </div>
      ) : (
        <ResultGrid
          columns={columns.map((c) => ({ ...c, numeric: NUMERIC_TYPE.test(c.typeName) }))}
          rows={page?.rows ?? []}
          resetKey={page}
          label={`Rows of ${table.name}`}
          firstRow={firstRow}
          stale={loading}
          sort={sort}
          onSort={chooseSort}
          cellSource={(r, column) =>
            page ? { connectionId, table, column, rowKey: rowKey(page.columns, page.rows[r]) } : undefined
          }
        >
          {page && page.rows.length === 0 && (
            <p className="state-panel muted">
              {shown?.index === 0 ? `${table.name} has no rows.` : "No more rows. Go back a page."}
            </p>
          )}
        </ResultGrid>
      )}

      <div className="status-bar">
        <span className="pager">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous page"
            disabled={pageIndex === 0 || loading}
            onClick={() => setPageIndex((p) => p - 1)}
          >
            <Icon name="chevronLeft" />
          </button>
          <span>Page {(pageIndex + 1).toLocaleString("en-US")}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Next page"
            disabled={loading || !page?.hasMore}
            onClick={() => setPageIndex((p) => p + 1)}
          >
            <Icon name="chevronRight" />
          </button>
        </span>
      </div>
    </section>
  );
}
