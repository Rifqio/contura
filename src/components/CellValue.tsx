import { useState } from "react";
import { errorText, fetchFullValue } from "../api/client";
import type { Cell, ConnectionId, FullValue, KeyPart, ObjectPath } from "../api/types";
import Dialog from "./Dialog";

/** Where a cell came from, so its full value can be fetched by primary key. */
export interface CellSource {
  connectionId: ConnectionId;
  table: ObjectPath;
  column: string;
  /** The row's primary key cells; empty when the table has no primary key. */
  rowKey: KeyPart[];
}

/** Showing more than this many bytes as hex would stall the window. */
const HEX_DISPLAY_LIMIT = 64 * 1024;

function hexPairs(hex: string): string {
  return hex.replace(/(..)(?=.)/g, "$1 ");
}

function base64ToHex(base64: string, limit: number): { hex: string; total: number } {
  const raw = atob(base64);
  const shown = Math.min(raw.length, limit);
  let hex = "";
  for (let i = 0; i < shown; i++) hex += raw.charCodeAt(i).toString(16).padStart(2, "0");
  return { hex, total: raw.length };
}

function FullValueView({ value }: { value: FullValue }) {
  if (value.t === "text") return <pre className="full-value">{value.value}</pre>;
  const { hex, total } = base64ToHex(value.base64, HEX_DISPLAY_LIMIT);
  return (
    <>
      {total > HEX_DISPLAY_LIMIT && (
        <p className="dialog-note">
          Showing the first {HEX_DISPLAY_LIMIT.toLocaleString("en-US")} of {total.toLocaleString("en-US")} bytes as hex.
        </p>
      )}
      <pre className="full-value">{hexPairs(hex)}</pre>
    </>
  );
}

/** A boolean column's values as the drivers print them. */
const BOOL_TEXT = /^(true|false|t|f)$/i;

export default function CellValue({
  cell,
  source,
  boolean = false,
}: {
  cell: Cell;
  source?: CellSource;
  /** The cell's column is a boolean type: its true and false take the keyword colour. */
  boolean?: boolean;
}) {
  const [state, setState] = useState<
    { s: "closed" } | { s: "loading" } | { s: "loaded"; value: FullValue } | { s: "failed"; message: string }
  >({ s: "closed" });

  async function openFull() {
    if (!source) return;
    setState({ s: "loading" });
    try {
      const value = await fetchFullValue(source.connectionId, {
        table: source.table,
        column: source.column,
        key: source.rowKey,
      });
      setState({ s: "loaded", value });
    } catch (e) {
      setState({ s: "failed", message: errorText(e) });
    }
  }

  let body;
  switch (cell.t) {
    case "null":
      return <span className="cell-null">NULL</span>;
    case "number":
      return <span className="cell-number">{cell.value}</span>;
    case "text":
      if (boolean && !cell.truncated && BOOL_TEXT.test(cell.value)) {
        return <span className="cell-bool">{cell.value}</span>;
      }
      body = <span className="cell-text">{cell.value}</span>;
      break;
    case "bytes":
      body = <span className="cell-bytes">{cell.previewHex.length > 0 ? `0x${cell.previewHex}` : "0x"}</span>;
      break;
  }
  if (!cell.truncated) return body;

  return (
    <span className="cell-truncated">
      {body}
      <span className="cell-marker">truncated ({cell.totalBytes.toLocaleString("en-US")} bytes)</span>
      {source && (
        <button type="button" className="link-button" onClick={openFull}>
          Open full value
        </button>
      )}
      {source && state.s !== "closed" && (
        <Dialog title={`${source.column}: full value`} onClose={() => setState({ s: "closed" })} wide>
          <div className="dialog-body">
            {state.s === "loading" && <p className="muted">Loading the full value…</p>}
            {state.s === "failed" && (
              <p className="error-text" role="alert">
                {state.message}
              </p>
            )}
            {state.s === "loaded" && <FullValueView value={state.value} />}
          </div>
        </Dialog>
      )}
    </span>
  );
}
