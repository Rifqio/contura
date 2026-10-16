import { useState } from "react";
import { DIALECT_LABEL, errorText, setConnectionAiAccess } from "../../api/client";
import type { AiAccess, ConnectionConfig } from "../../api/types";
import Icon from "../../components/Icon";
import { AI_ACCESS_OPTIONS } from "./providers";

interface Props {
  connections: ConnectionConfig[];
  /** Called with the saved Connection after a row's change is stored. */
  onSaved: (saved: ConnectionConfig) => void;
}

/** What AI can see, per Connection. Each row is stored as soon as it changes, without touching open sessions. */
export default function AccessTable({ connections, onSaved }: Props) {
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, AiAccess>>({});

  async function change(c: ConnectionConfig, next: AiAccess) {
    setValues((v) => ({ ...v, [c.id]: next }));
    setErrors(({ [c.id]: _, ...rest }) => rest);
    setSaving((s) => new Set(s).add(c.id));
    try {
      onSaved(await setConnectionAiAccess(c.id, next));
    } catch (e) {
      setValues(({ [c.id]: _, ...rest }) => rest);
      setErrors((all) => ({ ...all, [c.id]: errorText(e, c.dialect) }));
    } finally {
      setSaving((s) => {
        const left = new Set(s);
        left.delete(c.id);
        return left;
      });
    }
  }

  if (connections.length === 0) {
    return <p className="muted">No Connections yet. Add one, then choose here what AI can see in it.</p>;
  }

  return (
    <div className="share-scroll">
      <table className="share-table">
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
                  <Icon name="database" />
                  {c.name}
                </span>
              </td>
              <td className="muted">{DIALECT_LABEL[c.dialect]}</td>
              <td>
                <select
                  className="input"
                  aria-label={`What AI can see in ${c.name}`}
                  value={values[c.id] ?? c.aiAccess}
                  aria-busy={saving.has(c.id)}
                  onChange={(e) => void change(c, e.target.value as AiAccess)}
                >
                  {AI_ACCESS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
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
    </div>
  );
}
