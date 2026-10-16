import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useRef, useState } from "react";
import { errorText, exportSql, writeBinaryFile, writeModelFiles, writeTextFile } from "../api/client";
import type { DialectKind, SchemaModel } from "../api/types";
import Dialog from "../components/Dialog";
import type { LangClient } from "../lang/client";
import type { ParseResult, TextEdit } from "../lang/protocol";
import Canvas from "./Canvas";
import DbmlEditor from "./DbmlEditor";
import { exportPng, blobToBase64 } from "./exportPng";
import { exportSvg } from "./exportSvg";
import { followRenames, type Layout, serializeLayout } from "./layout";
import type { MakeEdits } from "./TableCard";

export type ModelDoc = {
  /** Null until the first Save asks where to put it. */
  path: string | null;
  dbml: string;
  /** The text as last saved; empty for a model that was never saved. */
  savedDbml: string;
  layout: Layout;
  dialect: DialectKind;
  source: "blank" | "file" | "connection";
};

type ExportKind = "sql" | "svg" | "png";

const EXPORTS: { kind: ExportKind; label: string; filter: { name: string; extensions: string[] } }[] = [
  { kind: "sql", label: "SQL script", filter: { name: "SQL script", extensions: ["sql"] } },
  { kind: "svg", label: "SVG image", filter: { name: "SVG image", extensions: ["svg"] } },
  { kind: "png", label: "PNG image", filter: { name: "PNG image", extensions: ["png"] } },
];

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

interface Props {
  doc: ModelDoc;
  onClose: () => void;
  /** The language engine; the editor makes one when absent. */
  client?: LangClient;
}

export default function SchemaBuilder({ doc, onClose, client }: Props) {
  const [text, setText] = useState(doc.dbml);
  const [saved, setSaved] = useState(doc.savedDbml);
  const [path, setPath] = useState(doc.path);
  const [layout, setLayout] = useState(doc.layout);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [result, setResult] = useState<{ r: ParseResult; text: string } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [exportMenu, setExportMenu] = useState(false);
  const [pendingExport, setPendingExport] = useState<ExportKind | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const editsRef = useRef<((edits: TextEdit[]) => void) | null>(null);
  const focusRef = useRef<((offset: number) => void) | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const name = path ? basename(path).replace(/\.dbml$/i, "") : "schema";
  const model: SchemaModel | null = result ? (result.r.model ?? result.r.lastValid) : null;
  const blocked = !!result && result.r.model === null;
  const firstError = result?.r.diagnostics.find((d) => d.severity === "error");
  const dirty = text !== saved || layoutDirty;

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
    setExportMenu(false);
    if (blocked) setPendingExport(kind);
    else void runExport(kind);
  }

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
      <div className="toolbar schema-toolbar">
        <h2 className="toolbar-title">
          {path ? basename(path) : "Untitled model"}
          {dirty && <span className="muted"> (unsaved)</span>}
        </h2>
        <button type="button" className="button button-small" onClick={() => setCollapsed((c) => !c)} aria-pressed={collapsed}>
          {collapsed ? "Show DBML" : "Hide DBML"}
        </button>
        <span className="spacer" />
        <button type="button" className="button button-small" onClick={() => void saveModel()}>
          Save
        </button>
        <button type="button" className="button button-small" onClick={() => void saveModel(true)}>
          Save as
        </button>
        <div className="menu-anchor">
          <button
            type="button"
            className="button button-small"
            aria-haspopup="menu"
            aria-expanded={exportMenu}
            onClick={() => setExportMenu((m) => !m)}
          >
            Export
          </button>
          {exportMenu && (
            <div className="menu" role="menu" onKeyDown={(e) => e.key === "Escape" && setExportMenu(false)}>
              {EXPORTS.map((x) => (
                <button key={x.kind} type="button" role="menuitem" className="menu-item" onClick={() => chooseExport(x.kind)}>
                  {x.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="button button-small" disabled aria-describedby="apply-hint">
          Apply to Connection
        </button>
        <span id="apply-hint" className="muted toolbar-meta">
          Arrives with Schema Compare
        </span>
        <button type="button" className="button button-small" onClick={() => (dirty ? setConfirmClose(true) : onClose())}>
          Close
        </button>
      </div>
      {status && (
        <p className="schema-status" role="status">
          {status}
        </p>
      )}
      <div className={collapsed ? "schema-panes schema-panes-collapsed" : "schema-panes"}>
        <div className="schema-text" hidden={collapsed}>
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
            client={client}
          />
        </div>
        <div className="schema-diagram">
          {!result ? (
            <p className="state-panel muted">Parsing the DBML…</p>
          ) : !model ? (
            <p className="state-panel muted">Fix the DBML to see the diagram: {firstError?.message ?? "it has an error"}.</p>
          ) : (
            <Canvas
              model={model}
              layout={layout}
              blocked={blocked}
              errorAt={firstError ? { line: firstError.line, message: firstError.message } : undefined}
              onLayout={(l) => {
                setLayout(l);
                setLayoutDirty(true);
              }}
              onEdit={onEdit}
              onGoToError={() => {
                setCollapsed(false);
                if (firstError) focusRef.current?.(firstError.from);
              }}
            />
          )}
        </div>
      </div>
      {pendingExport && (
        <Dialog title="Export" onClose={() => setPendingExport(null)}>
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
        <Dialog title="Unsaved changes" onClose={() => setConfirmClose(false)}>
          <div className="dialog-body">
            <p>Save changes to {name}?</p>
          </div>
          <footer className="dialog-footer">
            <button type="button" className="button" onClick={onClose}>
              Don't save
            </button>
            <span className="spacer" />
            <button type="button" className="button" onClick={() => setConfirmClose(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={async () => {
                if (await saveModel()) onClose();
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
