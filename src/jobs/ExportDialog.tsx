// The Export dialog (spec "Export", frame 7.1): three numbered steps on the left, the preview
// alone on the right, and the running frame once a long export is under way.
import { documentDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errorText, fileName, isCommandError } from "../api/client";
import { newJobId, previewExport, revealInFolder, startExport } from "../api/jobs";
import {
  type BinaryText,
  type ConnectionConfig,
  DEFAULT_EXPORT_OPTIONS,
  type Delimiter,
  type ExportOptions,
  type ExportPreview,
  type ExportRequest,
  type ExportSource,
  type Format,
  type Group,
  type JobId,
  type JsonLayout,
  type NullText,
  type SqlTableName,
} from "../api/types";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import { groupStyle } from "../components/GroupBadge";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import Segmented from "../components/Segmented";
import Switch from "../components/Switch";
import { useToast } from "../components/Toast";
import {
  EXPORT_CANCELLED,
  type ExportOrigin,
  exportedText,
  fileNameFor,
  formatHint,
  optionsSummary,
  sizeLine,
  stripExtension,
} from "./exportText";
import RunningFrame from "./RunningFrame";
import { useJobs } from "./useJobs";

interface Props {
  connection: ConnectionConfig;
  group: Group | null;
  origin: ExportOrigin;
  /** Opens on a running export again (from the status bar) instead of the form. */
  attach?: JobId;
  onClose(): void;
}

/** The last folder an export went to. */
export const FOLDER_KEY = "contura.exportFolder";
/** D24: an export that ends within this keeps the form and closes with the toast. */
const SHORT_MS = 2000;
const PREVIEW_DELAY_MS = 200;
const PREVIEW_LINES = 6;

const PRODUCTION_BANNER = "The file is plain text and holds Production rows. Keep it somewhere safe.";
const RERUN_HINT = "Runs the query again on its own connection.";
const ROWS_SHOWN_HINT = "The rows this tab holds. Values cut to 1 KB previews stay cut.";

/** The file each export writes, so the dialog can name it when it is opened on the job again. */
const jobPaths = new Map<JobId, string>();

type Scope = "all" | "filter" | "selected";

const FORMATS: { value: Format; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "xlsx", label: "Excel" },
  { value: "sql", label: "SQL INSERT" },
];
const FORMAT_FILTER: Record<Format, string> = { csv: "CSV file", json: "JSON file", xlsx: "Excel workbook", sql: "SQL file" };
const DELIMITER_WORD: Record<Delimiter, string> = { comma: "comma", semicolon: "semicolon", tab: "tab" };

function readFolder(): string | null {
  try {
    return localStorage.getItem(FOLDER_KEY);
  } catch {
    return null;
  }
}

function writeFolder(folder: string) {
  try {
    localStorage.setItem(FOLDER_KEY, folder);
  } catch {
    // Remembering the folder is a convenience only.
  }
}

function joinPath(folder: string, name: string): string {
  if (/[\\/]$/.test(folder)) return folder + name;
  const sep = folder.includes("/") && !folder.includes("\\") ? "/" : "\\";
  return `${folder}${sep}${name}`;
}

function splitPath(path: string): { folder: string; name: string } {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return { folder: path.slice(0, cut), name: path.slice(cut + 1) };
}

const n = (v: number) => v.toLocaleString("en-US");

/** The result panel's shown columns, as indexes in the order shown; all of them when it would hide every one. */
function shownIndexes(origin: Extract<ExportOrigin, { kind: "result" }>): number[] {
  const hidden = new Set(origin.hidden ?? []);
  const order = origin.order && origin.order.length === origin.columns.length ? origin.order : origin.columns.map((_, i) => i);
  const keep = order.filter((i) => origin.columns[i] && !hidden.has(origin.columns[i].name));
  return keep.length === 0 ? order : keep;
}

const ownOrder = (keep: number[], n: number) => keep.length === n && keep.every((c, i) => c === i);

/** The result panel's shown column names, in the order shown; empty when it shows them all in the query's order. */
function shownColumns(origin: Extract<ExportOrigin, { kind: "result" }>): string[] {
  const keep = shownIndexes(origin);
  return ownOrder(keep, origin.columns.length) ? [] : keep.map((i) => origin.columns[i].name);
}

/** Rows shown as the result panel shows them: its hidden columns left out, the rest in the order shown. */
function shownRows(origin: Extract<ExportOrigin, { kind: "result" }>): ExportSource {
  const keep = shownIndexes(origin);
  if (ownOrder(keep, origin.columns.length)) return { kind: "rows", columns: origin.columns, rows: origin.rows };
  return { kind: "rows", columns: keep.map((i) => origin.columns[i]), rows: origin.rows.map((r) => keep.map((i) => r[i])) };
}

export default function ExportDialog({ connection, group, origin, attach, onClose }: Props) {
  const jobs = useJobs();
  const toast = useToast();
  const table = origin.kind === "table" ? origin : null;
  const allColumns = table?.columns ?? [];
  const baseName = table ? table.path.name : "query-result";

  const [scope, setScope] = useState<Scope>("all");
  // D16 and Q26: a result's statement counts as not read until a preview says it reads.
  const [readState, setReadState] = useState<"unknown" | "read" | "notRead">("unknown");
  // The grid's order when it moved columns (view only), so the export writes them as shown.
  const [order, setOrder] = useState<string[]>(() => {
    const shown = table?.order;
    return shown && shown.length === allColumns.length && allColumns.every((c) => shown.includes(c)) ? shown : allColumns;
  });
  // Columns hidden in the grid start off, but at least one column stays on.
  const [off, setOff] = useState<Set<string>>(() => {
    const hidden = (table?.hidden ?? []).filter((c) => allColumns.includes(c));
    return new Set(hidden.length < allColumns.length ? hidden : []);
  });
  const [format, setFormat] = useState<Format>("csv");
  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [name, setName] = useState(() => fileNameFor(baseName, "csv", DEFAULT_EXPORT_OPTIONS.jsonLayout));
  const [folder, setFolder] = useState<string | null>(() => readFolder());
  const [moreOpen, setMoreOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<JobId | null>(attach ?? null);
  const [running, setRunning] = useState(attach !== undefined);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shortTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chooseButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (folder !== null) return;
    let live = true;
    documentDir().then(
      (dir) => live && setFolder((f) => f ?? dir),
      () => live && setFolder((f) => f ?? ""),
    );
    return () => {
      live = false;
    };
  }, [folder]);
  useEffect(() => () => clearTimeout(shortTimer.current), []);

  const chosen = order.filter((c) => !off.has(c));
  const sameColumns = chosen.length === allColumns.length && chosen.every((c, i) => c === allColumns[i]);
  const path = folder === null ? null : joinPath(folder, name);

  const source: ExportSource =
    origin.kind === "table"
      ? {
          kind: "table",
          path: origin.path,
          columns: sameColumns ? [] : chosen,
          filter: scope === "filter" ? origin.filter : null,
          sort: origin.sort,
          keys: scope === "selected" ? origin.selected : [],
        }
      : readState === "read"
        ? { kind: "query", database: origin.database, sql: origin.sql, columns: shownColumns(origin) }
        : shownRows(origin);
  // The preview asks about the statement itself until the answer is known; the export never does.
  const previewSource: ExportSource =
    origin.kind === "result" && readState === "unknown"
      ? { kind: "query", database: origin.database, sql: origin.sql, columns: shownColumns(origin) }
      : source;

  // D8: only All rows (the tree's estimate), Selected rows and the rows shown have a count.
  const rows: number | null =
    origin.kind === "table"
      ? scope === "all"
        ? origin.rowEstimate
        : scope === "selected"
          ? origin.selected.length
          : null
      : readState === "read"
        ? null
        : origin.rows.length;

  const req: ExportRequest | null =
    path === null ? null : { connectionId: connection.id, source, format, options: opts, path, rowsHint: rows };
  const previewReq: ExportRequest | null = req && { ...req, source: previewSource, rowsHint: previewSource === source ? rows : null };
  const reqKey = JSON.stringify(previewReq);

  const previewSeq = useRef(0);
  useEffect(() => {
    if (!previewReq || running) return;
    const seq = ++previewSeq.current;
    const asked = previewReq.source.kind === "query";
    const t = setTimeout(() => {
      previewExport(previewReq).then(
        (p) => {
          if (seq !== previewSeq.current) return;
          setPreview(p);
          setPreviewError(null);
          // A failed preview leaves the state unknown, so only Rows shown stays offered.
          if (asked) setReadState(p.queryRead ? "read" : "notRead");
        },
        (e) => {
          if (seq === previewSeq.current) setPreviewError(errorText(e, connection.dialect));
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(t);
    // The request text is the key: a new object with the same fields does not preview again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, running]);

  const job = jobId ? jobs.jobs.find((j) => j.id === jobId) : undefined;
  const busy = jobId !== null && !running;

  useEffect(() => {
    if (!job?.done) return;
    clearTimeout(shortTimer.current);
    if (job.background) {
      // Opened again from the status bar: its item announces the end.
      onClose();
      return;
    }
    const done = job.done;
    jobs.dismiss(job.id);
    setJobId(null);
    setRunning(false);
    if ("report" in done) {
      const file = done.report.file ?? jobPaths.get(job.id) ?? null;
      toast.show({
        kind: "success",
        text: exportedText(done.report.rowsWritten, file ? fileName(file) : name),
        action: file ? { label: "Open folder", run: () => void revealInFolder(file) } : undefined,
      });
      onClose();
    } else if (done.error.kind === "cancelled") {
      toast.show({ kind: "info", text: EXPORT_CANCELLED });
      onClose();
    } else {
      setError(errorText(done.error, connection.dialect));
    }
    // Reacts to the job's end only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.done]);

  const label = table ? `Exporting ${table.path.name}` : "Exporting the query result";

  async function start(overwrite: boolean) {
    if (!req || jobId !== null || folder === null) return;
    const id = newJobId();
    // Q2: track before the start, so no event is lost.
    const onEvent = jobs.track(id, "export", label, connection.id);
    jobPaths.set(id, req.path);
    setJobId(id);
    setError(null);
    clearTimeout(shortTimer.current);
    shortTimer.current = setTimeout(() => setRunning(true), SHORT_MS);
    try {
      await startExport(id, req, overwrite, onEvent);
      writeFolder(folder);
    } catch (e) {
      clearTimeout(shortTimer.current);
      jobs.dismiss(id);
      jobPaths.delete(id);
      setJobId(null);
      setRunning(false);
      if (isCommandError(e) && e.kind === "fileExists") setAsking(true);
      else setError(errorText(e, connection.dialect));
    }
  }

  function cancelJob() {
    if (!jobId) return;
    jobs.cancel(jobId).catch((e) => setError(errorText(e, connection.dialect)));
  }

  function toBackground() {
    clearTimeout(shortTimer.current);
    if (jobId) jobs.background(jobId);
    onClose();
  }

  async function browse() {
    if (path === null) return;
    const ext = name.slice(name.lastIndexOf(".") + 1);
    const target = await save({ defaultPath: path, filters: [{ name: FORMAT_FILTER[format], extensions: [ext] }] });
    if (!target) return;
    const parts = splitPath(target);
    setFolder(parts.folder);
    setName(parts.name);
  }

  function changeFormat(f: Format, layout: JsonLayout = opts.jsonLayout) {
    setFormat(f);
    setName((current) => fileNameFor(stripExtension(current) || baseName, f, layout));
  }

  function set<K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) {
    setOpts((o) => ({ ...o, [key]: value }));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!running && !asking) void start(false);
    }
  }

  /**
   * Every way of closing (Esc, the close button, a click outside). Q25: while an export runs,
   * in the running frame or in the first 2s, it goes to the background; only Cancel cancels.
   */
  function closeDialog() {
    if (asking) setAsking(false);
    else if (jobId !== null) toBackground();
    else onClose();
  }

  // One Dialog for every view, so focus goes back to the opener at the end (I3). A new view
  // moves focus to its own first control, since the old one is gone.
  const view = asking && path !== null ? "ask" : running && jobId ? "running" : "form";
  // J2: a form with changes ignores a click outside and asks before Escape discards it.
  const formState = JSON.stringify([scope, order, [...off], format, opts, name, folder]);
  const firstFormState = useRef(formState);
  const dirty = view === "form" && jobId === null && formState !== firstFormState.current;
  const keys = useRef<HTMLDivElement>(null);
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    keys.current?.querySelector<HTMLElement>("[data-view-focus]")?.focus();
  }, [view]);

  const title =
    view === "ask" ? (
      "Replace the file"
    ) : (
      <>
        Export <span className="mono export-title-name">{table ? [table.path.schema, table.path.name].filter(Boolean).join(".") : "query result"}</span>
      </>
    );
  const subtitle =
    view === "ask" ? undefined : (
      <span className="export-subtitle">
        <DbMark dialect={connection.dialect} open size={14} label={null} />
        {connection.name}
      </span>
    );

  const sheetName = table ? table.path.name : "result";
  const resultHint = readState === "read" ? RERUN_HINT : ROWS_SHOWN_HINT;
  // Q20 and the result hint: a note the form already shows is not repeated.
  const notes = (preview?.notes ?? []).filter((note) => note !== PRODUCTION_BANNER && (table !== null || note !== resultHint));
  const columnsText = sameColumns
    ? `All ${allColumns.length} columns`
    : chosen.length === allColumns.length
      ? `All ${allColumns.length} columns, reordered`
      : `${chosen.length} of ${allColumns.length} columns`;

  const formBody = (
    <>
        <div className="dialog-body export-body">
          {connection.production && (
            <div className="export-banner export-banner-prod">
              <Icon name="warning" size={14} />
              <span>{PRODUCTION_BANNER}</span>
            </div>
          )}
          <div className="export-grid">
            <div className="export-steps">
              <section className="export-step">
                <h3 className="export-step-head">
                  <span className="export-step-num">1</span>
                  What to export
                </h3>
                <div className="export-step-body" role="radiogroup" aria-label="What to export">
                  {table ? (
                    <>
                      <label className="export-choice">
                        <input type="radio" className="radio" name="export-rows" checked={scope === "all"} onChange={() => setScope("all")} />
                        All rows
                        {table.rowEstimate !== null && (
                          <span className="export-count">{table.estimated ? `about ${n(table.rowEstimate)}` : n(table.rowEstimate)}</span>
                        )}
                      </label>
                      {table.filter !== null && (
                        <label className="export-choice">
                          <input type="radio" className="radio" name="export-rows" checked={scope === "filter"} onChange={() => setScope("filter")} />
                          Rows in the current filter
                        </label>
                      )}
                      <label className={table.hasPrimaryKey && table.selected.length > 0 ? "export-choice" : "export-choice export-choice-off"}>
                        <input
                          type="radio"
                          className="radio"
                          name="export-rows"
                          checked={scope === "selected"}
                          disabled={!table.hasPrimaryKey || table.selected.length === 0}
                          onChange={() => setScope("selected")}
                        />
                        Selected rows
                        {table.hasPrimaryKey ? (
                          <span className="export-count">{n(table.selected.length)}</span>
                        ) : (
                          <span className="export-count">Needs a primary key</span>
                        )}
                      </label>
                      <div className="export-columns">
                        <span>{columnsText}</span>
                        <button ref={chooseButton} type="button" className="link-button" aria-expanded={choosing} onClick={() => setChoosing((c) => !c)}>
                          Choose...
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <label className="export-choice">
                        <input type="radio" className="radio" name="export-rows" checked onChange={() => {}} />
                        {readState === "read" ? "The result of this query" : "Rows shown"}
                        {readState !== "read" && origin.kind === "result" && <span className="export-count">{n(origin.rows.length)}</span>}
                      </label>
                      <span className="export-hint">{resultHint}</span>
                    </>
                  )}
                </div>
              </section>

              <section className="export-step">
                <h3 className="export-step-head">
                  <span className="export-step-num">2</span>
                  Format
                </h3>
                <div className="export-step-body">
                  <Segmented label="Format" value={format} onChange={(f) => changeFormat(f)} options={FORMATS} />
                  <span className="export-hint">{formatHint(format, sheetName, connection.dialect, opts.jsonLayout)}</span>
                </div>
              </section>

              <section className="export-step">
                <h3 className="export-step-head">
                  <span className="export-step-num">3</span>
                  Save to
                </h3>
                <div className="export-step-body">
                  <div className="export-file">
                    <input
                      className="input mono"
                      aria-label="File name"
                      value={name}
                      spellCheck={false}
                      onChange={(e) => setName(e.target.value)}
                    />
                    <button type="button" className="button" onClick={() => void browse()}>
                      <Icon name="folder" size={14} />
                      Browse...
                    </button>
                  </div>
                  {folder !== null && <span className="export-hint mono">{`in ${folder}`}</span>}
                </div>
              </section>

              <div className="export-more">
                <button type="button" className={moreOpen ? "export-more-toggle export-more-on" : "export-more-toggle"} aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
                  <Icon name={moreOpen ? "chevronDown" : "chevronRight"} size={14} />
                  <span>More options</span>
                  <span className="spacer" />
                  {!moreOpen && <span className="export-summary">{optionsSummary(format, opts)}</span>}
                </button>
                {moreOpen && (
                  <MoreOptions
                    format={format}
                    opts={opts}
                    set={set}
                    onLayout={(l) => {
                      set("jsonLayout", l);
                      changeFormat(format, l);
                    }}
                  />
                )}
              </div>
            </div>

            <div className="export-preview">
              <h3 className="export-preview-head">
                Preview<span className="export-preview-sub">first lines, exactly as written</span>
              </h3>
              <div className="export-box">
                {format === "xlsx" ? (
                  <>
                    <div className="export-box-head">
                      <Icon name="grid" size={14} />
                      {`Sheet ${sheetName}`}
                      <span className="spacer" />
                      {opts.freezeHeader && <span>Header row frozen</span>}
                    </div>
                    {preview?.sheet && (
                      <div className="export-sheet-wrap">
                        <table className="export-sheet" aria-label={`Sheet ${sheetName}`}>
                          <tbody>
                            {preview.sheet.slice(0, PREVIEW_LINES + 1).map((row, r) => (
                              // Preview rows and cells have no identity beyond their position.
                              <tr key={r}>
                                {row.map((cell, c) =>
                                  r === 0 && opts.header ? <th key={c}>{cell}</th> : <td key={c}>{cell}</td>,
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="export-box-head">
                      <Icon name="fileCode" size={14} />
                      <span className="export-box-name">{name}</span>
                      <span className="spacer" />
                      {preview && <span>{format === "csv" ? `${preview.encoding}, ${DELIMITER_WORD[opts.delimiter]}` : preview.encoding}</span>}
                    </div>
                    {preview && (
                      <pre className="export-lines" aria-label="Preview lines">
                        {preview.lines.slice(0, PREVIEW_LINES).join("\n")}
                      </pre>
                    )}
                  </>
                )}
                {previewError && (
                  <p className="export-error" role="alert">
                    {previewError}
                  </p>
                )}
              </div>
              {preview && (
                <div className="export-size">
                  <span className="export-hint">File</span>
                  <b>{sizeLine(preview, rows)}</b>
                </div>
              )}
              {notes.map((note) => (
                <span key={note} className="export-hint">
                  {note}
                </span>
              ))}
            </div>
          </div>
        </div>
        <footer className="dialog-footer">
          {error ? (
            <p className="export-error" role="alert">
              {error}
            </p>
          ) : (
            <span className="export-hint">Writes a file only. The database is not changed.</span>
          )}
          <span className="spacer" />
          {/* In the first 2s Cancel cancels the export; Esc sends it to the background (Q25). */}
          <button type="button" className="button" onClick={busy ? cancelJob : onClose}>
            Cancel
            {!busy && <Kbd keys="Esc" />}
          </button>
          <button
            type="button"
            className="button button-primary"
            data-view-focus
            disabled={busy || !req}
            aria-busy={busy}
            onClick={() => void start(false)}
          >
            <Icon name="save" size={14} />
            Export
            <Kbd keys="Ctrl+Enter" />
          </button>
        </footer>
        {choosing && table && (
          <ColumnChooser
            anchor={chooseButton.current}
            order={order}
            off={off}
            onOrder={setOrder}
            onToggle={(c) =>
              setOff((s) => {
                const next = new Set(s);
                if (next.has(c)) next.delete(c);
                else if (chosen.length > 1) next.add(c);
                return next;
              })
            }
            onClose={() => {
              setChoosing(false);
              chooseButton.current?.focus();
            }}
          />
        )}
    </>
  );

  return (
    <Dialog
      title={title}
      icon={view === "ask" ? undefined : "save"}
      subtitle={subtitle}
      size={view === "ask" ? "confirm" : view === "running" ? "form" : "large"}
      className="export-dialog"
      dirty={dirty}
      onClose={closeDialog}
    >
      <div ref={keys} className="export-keys" style={groupStyle(group?.color)} onKeyDown={onKeyDown}>
        {view === "ask" && path !== null ? (
          <>
            <div className="dialog-body">
              <p>{`${fileName(path)} exists. Replace it?`}</p>
            </div>
            <footer className="dialog-footer">
              <button type="button" className="button" data-view-focus onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  setAsking(false);
                  void start(true);
                }}
              >
                Replace
              </button>
            </footer>
          </>
        ) : view === "running" && jobId ? (
          <>
            {job ? (
              <RunningFrame job={job} path={jobPaths.get(jobId) ?? path ?? ""} onBackground={toBackground} onCancel={cancelJob} />
            ) : (
              <div className="dialog-body">
                <p className="export-hint">This export has ended.</p>
              </div>
            )}
            {error && (
              <p className="export-error" role="alert">
                {error}
              </p>
            )}
          </>
        ) : (
          formBody
        )}
      </div>
    </Dialog>
  );

}

interface MoreProps {
  format: Format;
  opts: ExportOptions;
  set<K extends keyof ExportOptions>(key: K, value: ExportOptions[K]): void;
  onLayout(l: JsonLayout): void;
}

/** The format's details, under More options. */
function MoreOptions({ format, opts, set, onLayout }: MoreProps) {
  const binary = (
    <div className="field">
      <span className="fl">Binary values</span>
      <Segmented<BinaryText>
        label="Binary values"
        value={opts.binary}
        onChange={(v) => set("binary", v)}
        options={[
          { value: "hex", label: "Hex" },
          { value: "base64", label: "Base64" },
        ]}
      />
    </div>
  );
  return (
    <div className="export-more-box">
      {format === "csv" && (
        <>
          <div className="field">
            <span className="fl">Delimiter</span>
            <Segmented<Delimiter>
              label="Delimiter"
              value={opts.delimiter}
              onChange={(v) => set("delimiter", v)}
              options={[
                { value: "comma", label: "Comma" },
                { value: "semicolon", label: "Semicolon" },
                { value: "tab", label: "Tab" },
              ]}
            />
          </div>
          <div className="field">
            <span className="fl">NULL is written as</span>
            <Segmented<NullText>
              label="NULL is written as"
              value={opts.nullAs}
              onChange={(v) => set("nullAs", v)}
              options={[
                { value: "emptyCell", label: "Empty cell" },
                { value: "nullWord", label: "The text NULL" },
              ]}
            />
          </div>
          <Switch label="Header row" checked={opts.header} onChange={(v) => set("header", v)} />
          <Switch label="Add a BOM for Excel" checked={opts.bom} onChange={(v) => set("bom", v)} />
          {binary}
        </>
      )}
      {format === "json" && (
        <>
          <div className="field">
            <span className="fl">Layout</span>
            <Segmented<JsonLayout>
              label="Layout"
              value={opts.jsonLayout}
              onChange={onLayout}
              options={[
                { value: "array", label: "Array, .json" },
                { value: "lines", label: "JSON Lines, .jsonl" },
              ]}
            />
          </div>
          {binary}
        </>
      )}
      {format === "xlsx" && (
        <>
          <Switch label="Header row frozen" checked={opts.freezeHeader} onChange={(v) => set("freezeHeader", v)} />
          {binary}
        </>
      )}
      {format === "sql" && (
        <>
          <div className="field">
            <span className="fl">Rows per statement</span>
            <Segmented<"100" | "500" | "1000">
              label="Rows per statement"
              value={String(opts.rowsPerStatement) as "100" | "500" | "1000"}
              onChange={(v) => set("rowsPerStatement", Number(v))}
              options={[
                { value: "100", label: "100" },
                { value: "500", label: "500" },
                { value: "1000", label: "1,000" },
              ]}
            />
          </div>
          <div className="field">
            <span className="fl">Table name</span>
            <Segmented<SqlTableName>
              label="Table name"
              value={opts.tableName}
              onChange={(v) => set("tableName", v)}
              options={[
                { value: "asSource", label: "As in the source" },
                { value: "unqualified", label: "Unqualified" },
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}

interface ChooserProps {
  anchor: HTMLElement | null;
  order: string[];
  off: Set<string>;
  onOrder(order: string[]): void;
  onToggle(column: string): void;
  onClose(): void;
}

/** Choose...: pick and order the columns. Portalled, so the dialog body never clips it. */
function ColumnChooser({ anchor, order, off, onOrder, onToggle, onClose }: ChooserProps) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect();
    if (r) setAt({ left: r.left, top: r.bottom + 4 });
    box.current?.querySelector<HTMLElement>("input")?.focus();
  }, [anchor]);

  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // Capture runs before the Dialog's own Escape, which would close the whole dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor?.contains(t)) close.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [anchor]);

  const move = (i: number, by: number) => {
    const next = [...order];
    const [c] = next.splice(i, 1);
    next.splice(i + by, 0, c);
    onOrder(next);
  };

  return createPortal(
    <div
      ref={box}
      className="export-chooser"
      role="dialog"
      aria-label="Columns"
      style={at}
      onBlur={(e) => {
        // Tab past the last control leaves the popover; it is outside the Dialog's Tab trap.
        const to = e.relatedTarget as Node | null;
        // Focus going to Choose... itself is left to its click, which toggles the chooser (M8).
        if (to && !box.current?.contains(to) && !anchor?.contains(to)) close.current();
      }}
    >
      {order.map((c, i) => (
        <div key={c} className="export-chooser-row">
          <label className="export-chooser-name">
            <input type="checkbox" checked={!off.has(c)} onChange={() => onToggle(c)} />
            <span className="mono">{c}</span>
          </label>
          <button type="button" className="icon-button" aria-label={`Move ${c} up`} disabled={i === 0} onClick={() => move(i, -1)}>
            <Icon name="arrowUp" size={14} />
          </button>
          <button type="button" className="icon-button" aria-label={`Move ${c} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>
            <Icon name="arrowDown" size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
