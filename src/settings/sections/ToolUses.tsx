import { useEffect, useState } from "react";
import { toolUsesChanged } from "../../api/changes";
import { aiRecentToolUses, aiAnswerRecord, errorText } from "../../api/client";
import type { AnswerRecord, ConnectionConfig, ToolUseRow } from "../../api/types";
import AnswerLog from "../../assistant/AnswerLog";
import Dialog from "../../components/Dialog";

const NAME: Record<ToolUseRow["tool"], string> = { proposeDiagramChanges: "Propose diagram changes", pickTables: "Pick tables" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The list's time column (board 11.4): `10:42` today, `Yesterday`, then the date (`Oct 18`). */
export function rowTime(at: number, now: number): string {
  const d = new Date(at);
  const midnight = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(d)) / 86_400_000);
  if (days === 0) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return days === 1 ? "Yesterday" : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

interface Opened {
  row: ToolUseRow;
  record?: AnswerRecord;
  error?: string;
}

/** Recent tool uses (board 11.4): the last 20 uses of a tool, newest first, each with the answer log of its use. */
export default function ToolUses({ connections }: { connections: ConnectionConfig[] }) {
  const [rows, setRows] = useState<ToolUseRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);

  // Read again whenever a tool use is saved or its outcome recorded, so an open Settings tab shows it.
  useEffect(() => {
    let live = true;
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      aiRecentToolUses().then(
        (r) => {
          if (!live || mine !== seq) return;
          setRows(r);
          setLoadError(null);
        },
        (e: unknown) => live && mine === seq && setLoadError(errorText(e)),
      );
    };
    load();
    const off = toolUsesChanged.on(load);
    return () => {
      live = false;
      off();
    };
  }, []);

  function open(row: ToolUseRow) {
    setOpened({ row });
    aiAnswerRecord(row.threadId, row.messageAt).then(
      (record) => setOpened((o) => (o?.row === row ? (record ? { row, record } : { row, error: "This answer's record is no longer stored." }) : o)),
      (e: unknown) => setOpened((o) => (o?.row === row ? { row, error: errorText(e) } : o)),
    );
  }

  const now = Date.now();
  const target = (r: ToolUseRow) => (r.tool === "pickTables" ? `Ask on ${connections.find((c) => c.id === r.connectionId)?.name ?? "a Connection"}` : r.target);
  const close = () => setOpened(null);
  return (
    <>
      <h3>Recent tool uses</h3>
      {loadError !== null ? (
        <p className="field-error" role="alert">
          Could not load tool uses. {loadError}
        </p>
      ) : rows !== null && rows.length === 0 ? (
        <p className="muted">No tool uses yet.</p>
      ) : (
        <ul className="uses-table">
          {(rows ?? []).map((r) => (
            <li key={`${r.threadId}:${r.messageAt}`} className="urow">
              <span className="tab-n subtle">{rowTime(r.at, now)}</span>
              <span className="uname">{NAME[r.tool]}</span>
              <span className={r.tool === "proposeDiagramChanges" ? "mono-small" : undefined}>{target(r)}</span>
              <span>{r.result}</span>
              <button type="button" className="link-button" aria-label={`Open ${NAME[r.tool]} ${target(r)}`} onClick={() => open(r)}>
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">Open shows the exact input the model sent and what Contura did with it.</p>
      {opened && (
        <Dialog title="Tool use" size="wide" onClose={close}>
          <div className="dialog-body tool-use-log">
            {opened.record ? (
              <AnswerLog
                question=""
                record={opened.record}
                connection={connections.find((c) => c.id === opened.row.connectionId)?.name ?? null}
                initialStep={opened.row.tool === "proposeDiagramChanges" ? "toolCheck" : undefined}
                variant={opened.row.tool === "proposeDiagramChanges" ? "diagram" : undefined}
                file={opened.row.target.replace(/\.flow$/, "")}
              />
            ) : (
              <p className="msg-notice" role={opened.error ? "alert" : "status"}>
                {opened.error ?? "Loading the log..."}
              </p>
            )}
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" data-autofocus onClick={close}>
              Close
            </button>
          </footer>
        </Dialog>
      )}
    </>
  );
}
