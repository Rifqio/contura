import { useState } from "react";
import { DIALECT_LABEL, errorText, setConnectionAiAccess } from "../../api/client";
import type { AiAccess, ConnectionConfig } from "../../api/types";
import DbMark from "../../components/DbMark";
import Select from "../../components/Select";
import { AI_ACCESS_OPTIONS } from "./providers";

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

  if (connections.length === 0) {
    return <p className="muted">No Connections yet. Add one, then choose here what AI can see in it.</p>;
  }

  // Not in a scrolling box: each row's list opens below the table without being cut off.
  return (
    <table className="share-table" aria-labelledby={labelledBy}>
      <thead>
        <tr>
          <th scope="col">Connection</th>
          <th scope="col">Dialect</th>
          <th scope="col">AI can see</th>
        </tr>
      </thead>
      <tbody>
        {connections.map((c) => (
          <tr key={c.id}>
            <td>
              <span className="cname">
                <DbMark dialect={c.dialect} open size={14} label={null} />
                {c.name}
              </span>
            </td>
            <td className="muted">{DIALECT_LABEL[c.dialect]}</td>
            <td>
              <Select<AiAccess>
                label={`What AI can see in ${c.name}`}
                value={values[c.id] ?? c.aiAccess}
                options={AI_ACCESS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                onChange={(next) => void change(c, next)}
              />
              {errors[c.id] && (
                <span className="field-error" role="alert">
                  {errors[c.id]}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
