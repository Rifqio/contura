import { save } from "@tauri-apps/plugin-dialog";
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DIALECT_LABEL, errorText, exportSql, writeBinaryFile, writeModelFiles, writeTextFile } from "../api/client";
import type { DialectKind, SchemaModel } from "../api/types";
import { dbmlErrorNotice } from "../compare/compareModel";
import type { AskContext, AskKit } from "../assistant/context";
import { type TabAskFields, usePublishTabAsk } from "../assistant/tabAsk";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import Menu, { type MenuItem } from "../components/Menu";
import { blobToBase64, exportPng } from "../diagram/export/png";
import PublishDialog from "../diagram/export/PublishDialog";
import type { Box } from "../diagram/export/scene";
import type { LayoutRequest } from "../diagram/layout";
import type { LangClient } from "../lang/client";
import type { ParseResult, TextEdit } from "../lang/protocol";
import Canvas from "./Canvas";
import DbmlEditor from "./DbmlEditor";
import { exportSvg, schemaScene } from "./exportSvg";
import { followRenames, type Layout, serializeLayout } from "./layout";
import type { MakeEdits } from "./TableCard";

export type ModelDoc = {
  /** Null until the first Save asks where to put it. */
  path: string | null;
  /** The name of a model with no file yet, such as an ER diagram opened as DBML (ADR 0030); the first Save suggests it. */
  name?: string;
  dbml: string;
  /** The text as last saved; empty for a model that was never saved. */
  savedDbml: string;
  layout: Layout;
  dialect: DialectKind;
  source: "blank" | "file" | "connection";
  /** The Connection a model was read from; its AI access governs the card asks. */
  connectionId: string | null;
};

type ExportKind = "sql" | "svg" | "png";

const EXPORTS: { kind: ExportKind; label: string; filter: { name: string; extensions: string[] } }[] = [
  { kind: "sql", label: "SQL script", filter: { name: "SQL script", extensions: ["sql"] } },
  { kind: "svg", label: "SVG image", filter: { name: "SVG image", extensions: ["svg"] } },
  { kind: "png", label: "PNG image", filter: { name: "PNG image", extensions: ["png"] } },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** The DBML the Ask gets: twice the Core's 64 KB cap at most, cut at a line end. */
const DBML_MAX = 128 * 1024;

/**
 * What a Schema Builder tab tells the Ask (spec 4.5): the file's base name, the table count and the first error's
 * line, with the DBML the editor holds as the DBML item.
 */
export function schemaTabAsk(file: string, tables: number, errorLine: number | null, dbml: string): TabAskFields {
  const cut = dbml.length > DBML_MAX ? dbml.slice(0, Math.max(0, dbml.lastIndexOf("\n", DBML_MAX))) : dbml;
  return { tab: { kind: "schema", file: basename(file), tables, errorLine }, dbml: cut };
}

interface Props {
  doc: ModelDoc;
  onClose: () => void;
  /** The language engine; the editor makes one when absent. */
  client?: LangClient;
  /** Ask AI on a table card; the Builder has no assistant panel, so there is no Open in chat. */
  ask?: AskKit;
  /** The live source Connection of the model, if it still exists; carries the AI access for card asks. */
  sourceConnection?: AskContext["connection"];
  /** Set to the builder's own Close, so its tab's close asks about unsaved changes the same way. */
  /** Asks to close; resolves true once the builder closed, false when the user kept it open (Cancel). */
  closeRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  /** The tab's key: the builder publishes what the Ask may know of the model (`tabAsk.ts`). */
  askKey?: string | null;
  /** The file the model was saved to, once a Save picks one; its tab is named after it. */
  onPathChange?: (path: string) => void;
  /**
   * Apply to Connection...: opens Schema Compare with this model as the source (saving nothing).
   * `notice` is set while the DBML has an error and the compare uses the last valid version.
   */
  onApplyToConnection?: (source: { model: SchemaModel; path: string | null; dialect: DialectKind; notice: string | null; connectionId: string | null }) => void;
}

export default function SchemaBuilder({ doc, onClose, client, ask, sourceConnection, closeRef, onPathChange, onApplyToConnection, askKey = null }: Props) {
  const [text, setText] = useState(doc.dbml);
  const [saved, setSaved] = useState(doc.savedDbml);
  const [path, setPath] = useState(doc.path);
  const [layout, setLayout] = useState(doc.layout);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [result, setResult] = useState<{ r: ParseResult; text: string } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [pendingExport, setPendingExport] = useState<ExportKind | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  /** The part of the canvas on screen when Publish was pressed; the dialog is open while set. */
  const [publishAt, setPublishAt] = useState<Box | null>(null);
  const editsRef = useRef<((edits: TextEdit[]) => void) | null>(null);
  const focusRef = useRef<((offset: number) => void) | null>(null);
  const revealRef = useRef<((offset: number) => void) | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const bandRef = useRef<{ from: number; to: number }[]>([]);
  const name = path ? basename(path).replace(/\.dbml$/i, "") : (doc.name ?? "schema");
  const model: SchemaModel | null = result ? (result.r.model ?? result.r.lastValid) : null;
  const blocked = !!result && result.r.model === null;
  const firstError = result?.r.diagnostics.find((d) => d.severity === "error");
  const dirty = text !== saved || layoutDirty;
  const pendingClose = useRef<((closed: boolean) => void) | null>(null);
  const settleClose = (closed: boolean) => {
    pendingClose.current?.(closed);
    pendingClose.current = null;
  };
  useEffect(() => () => settleClose(false), []);
  const requestClose = (): Promise<boolean> => {
    if (!dirty) {
      onClose();
      return Promise.resolve(true);
    }
    settleClose(false);
    setConfirmClose(true);
    return new Promise((resolve) => {
      pendingClose.current = resolve;
    });
  };
  if (closeRef) closeRef.current = requestClose;

  // The blocks of the selected cards. While a newer parse is pending the old ranges would be off, so the band waits.
  const band = useMemo(() => {
    if (result && result.text === text) {
      bandRef.current = selected.flatMap((k) => {
        const r = result.r.ranges[`table:${k}`];
        return r ? [{ from: r.from, to: r.to }] : [];
      });
    }
    return bandRef.current;
  }, [selected, result, text]);

  // Picking a card brings its block into view; typing later does not pull the text back.
  useEffect(() => {
    const first = bandRef.current[0];
    if (first) revealRef.current?.(first.from);
  }, [selected]);

  const askForCards = useMemo(
    () => (ask?.inlineAsk ? { getDbml: () => textRef.current, label: `${name}.dbml`, connection: sourceConnection, kit: { ...ask, onOpenInChat: undefined } } : undefined),
    [ask, name, sourceConnection],
  );

  /** Arrange runs in the language worker when there is a client (ruling D14). */
  const runLayout = useMemo(() => (client ? (r: LayoutRequest) => client.layout(r) : undefined), [client]);

  const onEdit = useCallback(
    (make: MakeEdits) => {
      if (!result || !result.r.model || result.text !== textRef.current) return;
      editsRef.current?.(make(textRef.current, result.r.ranges));
    },
    [result],
  );

  async function saveModel(asNew = false): Promise<boolean> {
    let target = path;
    if (!target || asNew) {
      target = await save({ filters: [{ name: "DBML", extensions: ["dbml"] }], defaultPath: `${name}.dbml` });
      if (!target) return false;
    }
    try {
      await writeModelFiles(target, textRef.current, serializeLayout(layout));
      setPath(target);
      if (target !== path) onPathChange?.(target);
      setSaved(textRef.current);
      setLayoutDirty(false);
      setStatus(`Saved ${basename(target)}`);
      return true;
    } catch (e) {
      setStatus(errorText(e));
      return false;
    }
  }

  async function runExport(kind: ExportKind) {
    if (!model) {
      setStatus("Fix the DBML first: there is no valid version to export yet.");
      return;
    }
    const spec = EXPORTS.find((x) => x.kind === kind)!;
    try {
      const target = await save({ filters: [spec.filter], defaultPath: `${name}.${spec.filter.extensions[0]}` });
      if (!target) return;
      if (kind === "sql") await writeTextFile(target, await exportSql(model));
      else if (kind === "svg") await writeTextFile(target, exportSvg(model, layout));
      else await writeBinaryFile(target, await blobToBase64(await exportPng(exportSvg(model, layout))));
      setStatus(`Exported ${basename(target)}`);
    } catch (e) {
      setStatus(errorText(e));
    }
  }

  function chooseExport(kind: ExportKind) {
    if (blocked) setPendingExport(kind);
    else void runExport(kind);
  }

  // The DBML is read from the editor's ref when the Ask asks; a new parse, not each key, bumps the count.
  const tableCount = model?.tables.length ?? 0;
  const errorLine = firstError?.line ?? null;
  usePublishTabAsk(askKey, () => schemaTabAsk(`${name}.dbml`, tableCount, errorLine, textRef.current), [name, tableCount, errorLine, result]);

  const problems = result ? result.r.diagnostics.filter((d) => d.severity !== "hint").length : 0;
  const counts = model ? `${plural(model.tables.length, "table")}, ${plural(model.refs.length, "ref")}` : "";

  const optionItems: MenuItem[] = [
    { key: "save", label: "Save", shortcut: "Ctrl+S", onSelect: () => void saveModel() },
    { key: "save-as", label: "Save as...", onSelect: () => void saveModel(true) },
    {
      key: "export",
      label: "Export",
      submenu: EXPORTS.map((x) => ({ key: x.kind, label: x.label, onSelect: () => chooseExport(x.kind) })),
    },
    { key: "hide", label: "Hide DBML", shortcut: "Ctrl+B", separatorBefore: true, onSelect: () => setCollapsed(true) },
  ];

  return (
    <section
      className="schema-builder"
      aria-label={`Schema Model ${name}`}
      onKeyDown={(e) => {
        if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saveModel();
        } else if (e.ctrlKey && e.key.toLowerCase() === "b") {
          e.preventDefault();
          setCollapsed((c) => !c);
        }
      }}
    >
      {status && (
        <p className="schema-status" role="status">
          {status}
        </p>
      )}
      <div className="schema-panes">
        <div className="schema-island schema-text-island" hidden={collapsed}>
          <div className="schema-pane-head">
            <h2 className="schema-pane-title">DBML</h2>
            <span className="chip">{DIALECT_LABEL[doc.dialect]}</span>
            <span className="spacer" />
            <span className="schema-pane-saved">{dirty ? "Unsaved" : "Saved"}</span>
            <Menu
              label="DBML options"
              align="end"
              compact
              items={optionItems}
              trigger={(p) => (
                <button type="button" {...p} className="icon-button" aria-label="DBML options" title="DBML options">
                  <Icon name="more" size={14} />
                </button>
              )}
            />
          </div>
          <div className="schema-text">
            <DbmlEditor
              value={text}
              savedValue={saved}
              dialect={doc.dialect}
              onChange={setText}
              onResult={(r, t) => {
                const before = result?.r.model;
                if (before && r.model) {
                  const next = followRenames(layout, before, r.model);
                  if (next !== layout) {
                    setLayout(next);
                    setLayoutDirty(true);
                  }
                }
                setResult({ r, text: t });
              }}
              editsRef={editsRef}
              focusRef={focusRef}
              revealRef={revealRef}
              band={band}
              client={client}
            />
          </div>
          <div className={problems > 0 ? "schema-pane-foot schema-pane-foot-problems" : "schema-pane-foot"}>
            {result && (
              <span className="schema-problems">
                {problems === 0 ? <Icon name="check" size={14} /> : <Icon name="warning" size={14} />}
                {problems === 0 ? "No problems" : plural(problems, "problem")}
              </span>
            )}
            <span className="spacer" />
            <span className="schema-counts">{counts}</span>
          </div>
        </div>
        <div className="schema-island schema-diagram">
          {!result ? (
            <p className="state-panel muted">Parsing the DBML…</p>
          ) : !model ? (
            <div className="state-panel">
              <p className="muted">Fix the DBML to see the diagram: {firstError?.message ?? "it has an error"}.</p>
              {collapsed && (
                <button type="button" className="button button-small" onClick={() => setCollapsed(false)}>
                  Show DBML
                </button>
              )}
            </div>
          ) : (
            <Canvas
              ask={askForCards}
              runLayout={runLayout}
              model={model}
              layout={layout}
              blocked={blocked}
              errorAt={firstError ? { line: firstError.line, message: firstError.message } : undefined}
              onLayout={(l) => {
                setLayout(l);
                setLayoutDirty(true);
              }}
              onEdit={onEdit}
              onSelectionChange={setSelected}
              onPublish={setPublishAt}
              onApplyToConnection={
                onApplyToConnection &&
                (() =>
                  onApplyToConnection({
                    model,
                    path,
                    dialect: doc.dialect,
                    notice: blocked && firstError ? dbmlErrorNotice(firstError.line) : null,
                    connectionId: doc.connectionId,
                  }))
              }
              onShowText={collapsed ? () => setCollapsed(false) : undefined}
              onGoToError={() => {
                setCollapsed(false);
                if (firstError) focusRef.current?.(firstError.from);
              }}
            />
          )}
        </div>
      </div>
      {publishAt && model && (
        <PublishDialog
          scene={schemaScene(model, layout)}
          fileName={name}
          selected={selected}
          onScreen={publishAt}
          onClose={() => setPublishAt(null)}
          onSaved={(target) => {
            setPublishAt(null);
            setStatus(`Exported ${basename(target)}`);
          }}
        />
      )}
      {pendingExport && (
        <Dialog title="Export" size="confirm" onClose={() => setPendingExport(null)}>
          <div className="dialog-body">
            <p>The DBML has an error, so this export uses the last valid version.</p>
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" onClick={() => setPendingExport(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={() => {
                const kind = pendingExport;
                setPendingExport(null);
                void runExport(kind);
              }}
            >
              Continue
            </button>
          </footer>
        </Dialog>
      )}
      {confirmClose && (
        <Dialog
          title="Unsaved changes"
          size="confirm"
          onClose={() => {
            setConfirmClose(false);
            settleClose(false);
          }}
        >
          <div className="dialog-body">
            <p>Save changes to {name}?</p>
          </div>
          <footer className="dialog-footer">
            <button
              type="button"
              className="button"
              onClick={() => {
                onClose();
                settleClose(true);
              }}
            >
              Don't save
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="button"
              onClick={() => {
                setConfirmClose(false);
                settleClose(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={async () => {
                if (await saveModel()) {
                  onClose();
                  settleClose(true);
                }
              }}
            >
              Save
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
