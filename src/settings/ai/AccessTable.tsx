import { useEffect, useState } from "react";
import { aiContextStatus, DIALECT_LABEL, errorText, setAiSyncMode, setConnectionAiAccess } from "../../api/client";
import type { AiAccess, AiSyncMode, ConnectionConfig, ContextStatusRow } from "../../api/types";
import DbMark from "../../components/DbMark";
import Select from "../../components/Select";
import { AI_ACCESS_OPTIONS, AI_SYNC_OPTIONS, contextAge, contextText } from "./providers";

interface Props {
  connections: ConnectionConfig[];
  /** Called with the saved Connection after a row's change is stored. */
  onSaved: (saved: ConnectionConfig) => void;
  /** The id of the heading that names the table. */
  labelledBy?: string;
}

/** What AI can see, per Connection. Each row is stored as soon as it changes, without touching open sessions. */
export default function AccessTable({ connections, onSaved, labelledBy }: Props) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, AiAccess>>({});
  const [syncs, setSyncs] = useState<Record<string, AiSyncMode>>({});
  const [status, setStatus] = useState<ContextStatusRow[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Read again when a row's access changes, since Never clears that Connection's AI Context.
  const accessKey = connections.map((c) => `${c.id}:${c.aiAccess}`).join(",");
  useEffect(() => {
    let live = true;
    aiContextStatus(null)
      .then((rows) => {
        if (!live) return;
        setStatus(rows);
        setNow(Date.now());
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [accessKey]);

  async function change(c: ConnectionConfig, next: AiAccess) {
    setValues((v) => ({ ...v, [c.id]: next }));
    setErrors(({ [c.id]: _, ...rest }) => rest);
    try {
      onSaved(await setConnectionAiAccess(c.id, next));
    } catch (e) {
      setValues(({ [c.id]: _, ...rest }) => rest);
      setErrors((all) => ({ ...all, [c.id]: errorText(e, c.dialect) }));
    }
  }

  async function changeSync(c: ConnectionConfig, next: AiSyncMode) {
    setSyncs((v) => ({ ...v, [c.id]: next }));
    setErrors(({ [c.id]: _, ...rest }) => rest);
    try {
      onSaved(await setAiSyncMode(c.id, next));
    } catch (e) {
      setErrors((all) => ({ ...all, [c.id]: errorText(e, c.dialect) }));
    }
    // Saved or not, the row shows the stored value from here on, so a change made elsewhere shows too.
    setSyncs(({ [c.id]: _, ...rest }) => rest);
  }

  if (connections.length === 0) {
    return <p className="muted">No Connections yet. Add one, then choose here what AI can see in it.</p>;
  }

  // Not in a scrolling box: each row's list opens below the table without being cut off.
  return (
    <>
      {/* The built columns at set widths: the table keeps to the 512px Settings column (P11-3). */}
      <table className="share-table share-table-fit" aria-labelledby={labelledBy}>
        <colgroup>
          <col className="share-col-conn" />
          <col className="share-col-dialect" />
          <col className="share-col-access" />
          <col className="share-col-sync" />
          <col className="share-col-ctx" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Connection</th>
            <th scope="col">Dialect</th>
            <th scope="col">AI can see</th>
            <th scope="col">Sync</th>
            <th scope="col">Context</th>
          </tr>
        </thead>
        <tbody>
          {connections.map((c) => {
            const access = values[c.id] ?? c.aiAccess;
            const age = contextAge(
              status.filter((r) => r.connectionId === c.id),
              now,
            );
            const never = access === "never";
            return (
              <tr key={c.id}>
                <td>
                  <span className="cname">
                    <DbMark dialect={c.dialect} open size={14} label={null} />
                    <span className="cname-text">{c.name}</span>
                  </span>
                </td>
                <td className="muted share-dialect">{DIALECT_LABEL[c.dialect]}</td>
                <td>
                  <Select<AiAccess>
                    label={`What AI can see in ${c.name}`}
                    value={access}
                    options={AI_ACCESS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    onChange={(next) => void change(c, next)}
                  />
                  {errors[c.id] && (
                    <span className="field-error" role="alert">
                      {errors[c.id]}
                    </span>
                  )}
                </td>
                <td>
                  {never ? (
                    <span className="muted">Off</span>
                  ) : (
                    <Select<AiSyncMode>
                      label={`Keep the AI context of ${c.name} in sync`}
                      className="sync-select"
                      value={syncs[c.id] ?? c.aiSync ?? "automatic"}
                      options={AI_SYNC_OPTIONS}
                      onChange={(next) => void changeSync(c, next)}
                    />
                  )}
                </td>
                <td className="share-ctx">
                  {/* Never has no AI Context, whatever the last read said. */}
                  {never || age.builtAt === null ? (
                    <span className="muted">Not built</span>
                  ) : (
                    <span className={age.stale ? "warn-text" : undefined}>{contextText(age, now)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="share-help">
        Plus sample rows: Contura reads at most 5 rows of each named table, read only, only when the Sample rows switch is on for that Ask, and never keeps
        them.
      </p>
      <p className="share-help">Production Connections stay at Never: turning Production on also clears their AI Context.</p>
    </>
  );
}
