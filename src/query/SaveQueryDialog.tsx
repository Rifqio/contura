import { useEffect, useId, useState } from "react";
import { errorText, listSavedQueries, saveSavedQuery } from "../api/client";
import type { ConnectionConfig, ConnectionId, SavedQuery, SavedQueryInput } from "../api/types";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import Select from "../components/Select";

interface Props {
  sql: string;
  /** Set when renaming an existing Saved Query; a Visual Query keeps its kind and model. */
  existing?: { id: string; name: string; kind?: SavedQuery["kind"]; visualJson?: string | null };
  /** The Connections of the place, for "Opens on". */
  connections?: ConnectionConfig[];
  /** The Connection the query opens on to begin with: the tab's. */
  connectionId?: ConnectionId | null;
  onSaved(q: SavedQuery): void;
  onCancel(): void;
}

const NONE = "";

/** Asks for a Saved Query's name and the Connection it opens on. Names are unique, ignoring case. */
export default function SaveQueryDialog({ sql, existing, connections = [], connectionId = null, onSaved, onCancel }: Props) {
  const id = useId();
  const [name, setName] = useState(existing?.name ?? "");
  const [opensOn, setOpensOn] = useState<string>(connectionId ?? NONE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [others, setOthers] = useState<SavedQuery[]>([]);

  // The names in use, so a taken one turns Save into Replace before anything is sent.
  useEffect(() => {
    let live = true;
    listSavedQueries()
      .then((all) => live && setOthers(all))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const wanted = name.trim().toLowerCase();
  const taken = wanted ? others.find((q) => q.id !== existing?.id && q.name.toLowerCase() === wanted) : undefined;
  // V8: a SQL query never replaces a Visual Query, which would lose its model.
  const takenVisual = !!taken && taken.kind === "visual" && existing?.kind !== "visual";
  // Renaming onto another query's name is not a replace: the Core refuses it.
  const replacing = !!taken && !existing && !takenVisual;

  async function submit() {
    if (!name.trim()) {
      setError("Give the query a name.");
      return;
    }
    if ((taken && existing) || takenVisual) return;
    setBusy(true);
    try {
      const input: SavedQueryInput = { id: replacing ? taken.id : (existing?.id ?? null), name: name.trim(), sql };
      // Renaming keeps the stored Connection (R10): only a new or replaced query sends one.
      if (!existing) input.connectionId = opensOn === NONE ? null : opensOn;
      // A renamed Visual Query stays one.
      if (existing?.kind === "visual") {
        input.kind = "visual";
        input.visualJson = existing.visualJson ?? null;
      }
      onSaved(await saveSavedQuery(input));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const options = [
    ...(connectionId === null ? [{ value: NONE, label: "No Connection" }] : []),
    ...connections.map((c) => ({
      value: c.id as string,
      label: c.name,
      lead: <DbMark dialect={c.dialect} open label={null} size={14} />,
      hint: c.database ? `· ${c.database}` : undefined,
    })),
  ];
  const message =
    error ??
    (takenVisual
      ? "This name belongs to a Visual Query. Pick another name."
      : taken
        ? "A Saved Query with this name already exists. Replace it, or change the name."
        : null);

  return (
    <Dialog title={existing ? "Rename Saved Query" : "Save query"} icon="bookmark" size="form" onClose={onCancel}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-body save-query-body">
          <div className="field">
            <label htmlFor={`${id}-name`}>Name</label>
            <input
              id={`${id}-name`}
              className={message ? "input input-error" : "input"}
              aria-invalid={message ? true : undefined}
              value={name}
              autoFocus
              autoComplete="off"
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
            {message ? (
              <p className="field-error" role="alert">
                <Icon name="alert" size={14} />
                {message}
              </p>
            ) : (
              <span className="field-help">
                Saved Queries are kept in Contura's data folder and listed under Saved Queries in the sidebar.
              </span>
            )}
          </div>
          {!existing && options.length > 0 && (
            <div className="field">
              <span id={`${id}-opens`}>Opens on</span>
              <Select
                value={opensOn}
                options={options}
                onChange={setOpensOn}
                label="Opens on"
                describedBy={`${id}-opens-help`}
              />
              <span id={`${id}-opens-help`} className="field-help">
                The Connection it opens on next time. You can still switch it in the editor.
              </span>
            </div>
          )}
        </div>
        <footer className="dialog-footer">
          <span className="spacer" />
          <button type="button" className="button" onClick={onCancel}>
            Cancel
            <Kbd keys="Esc" />
          </button>
          <button type="submit" className="button button-primary" disabled={busy || (!!taken && !!existing) || takenVisual}>
            {replacing ? "Replace" : "Save"}
            <Kbd keys="Enter" />
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
