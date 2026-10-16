import { useEffect, useState } from "react";
import { connectionTarget, errorText, shortenPath, suggestedConnections } from "../api/client";
import type { ConnectionConfig, Group, GroupId, SuggestedConnection } from "../api/types";
import ConnectionForm from "./ConnectionForm";
import DialectTag from "./DialectTag";
import GroupBadge from "./GroupBadge";
import GroupForm from "./GroupForm";
import Icon from "./Icon";

interface Props {
  groups: Group[];
  connections: ConnectionConfig[];
  /** Opens the Group and remembers it for the next start. */
  onOpenGroup: (id: GroupId) => void;
  /** Opens the Ungrouped workspace with this Connection selected. */
  onOpenUngrouped: (connectionId: string) => void;
  /** Groups or Connections changed; reload them. */
  onChanged: () => void;
  /** An app-level error to show, such as a failed reload. */
  notice?: string | null;
  /** Opens the Schema Builder's starting points; the button shows only when set. */
  onNewSchemaModel?: () => void;
}

export function connectionCountText(n: number): string {
  if (n === 0) return "No Connections";
  return n === 1 ? "1 Connection" : `${n} Connections`;
}

type Form = { kind: "none" } | { kind: "group" } | { kind: "connection"; prefill?: SuggestedConnection };

export default function Home({
  groups,
  connections,
  onOpenGroup,
  onOpenUngrouped,
  onChanged,
  notice,
  onNewSchemaModel,
}: Props) {
  const [suggestions, setSuggestions] = useState<SuggestedConnection[]>([]);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>({ kind: "none" });

  useEffect(() => {
    let live = true;
    suggestedConnections()
      .then((s) => live && setSuggestions(s))
      .catch((e) => live && setSuggestionError(errorText(e)));
    return () => {
      live = false;
    };
  }, [connections]);

  const ungrouped = connections.filter((c) => c.groupId === null);
  const empty = groups.length === 0 && connections.length === 0;

  return (
    <div className="home">
      <header className="home-header">
        <h1>Home</h1>
        {!empty && (
          <div className="home-actions">
            {onNewSchemaModel && (
              <button type="button" className="button" onClick={onNewSchemaModel}>
                New Schema Model
              </button>
            )}
            <button type="button" className="button" onClick={() => setForm({ kind: "connection" })}>
              <Icon name="plus" />
              New Connection
            </button>
            <button type="button" className="button button-primary" onClick={() => setForm({ kind: "group" })}>
              <Icon name="plus" />
              New Group
            </button>
          </div>
        )}
      </header>

      {notice && (
        <p className="error-text" role="alert">
          {notice}
        </p>
      )}

      {empty ? (
        <div className="empty-state">
          <p>
            Groups keep the Connections for one client or project together, so you always know whose data you are in.
          </p>
          <div className="home-actions">
            <button type="button" className="button button-primary" onClick={() => setForm({ kind: "group" })}>
              <Icon name="plus" />
              New Group
            </button>
            {onNewSchemaModel && (
              <button type="button" className="button" onClick={onNewSchemaModel}>
                New Schema Model
              </button>
            )}
            <button type="button" className="button" onClick={() => setForm({ kind: "connection" })}>
              New Connection
            </button>
          </div>
        </div>
      ) : (
        <>
          <section className="home-section" aria-labelledby="home-groups">
            <h2 id="home-groups" className="section-label">
              Groups
            </h2>
            {groups.length === 0 ? (
              <p className="muted">No Groups yet. Create one for each client or project.</p>
            ) : (
              <div className="group-cards">
                {groups.map((g) => (
                  <button key={g.id} type="button" className="group-card" onClick={() => onOpenGroup(g.id)}>
                    <span className="group-card-top">
                      <GroupBadge name={g.name} color={g.color} />
                      <span className="group-card-name">{g.name}</span>
                    </span>
                    <span className="muted">
                      {connectionCountText(connections.filter((c) => c.groupId === g.id).length)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="home-section" aria-labelledby="home-ungrouped">
            <h2 id="home-ungrouped" className="section-label">
              Ungrouped
            </h2>
            {ungrouped.length === 0 ? (
              <p className="muted">Every Connection is in a Group.</p>
            ) : (
              <ul className="list-panel" aria-label="Ungrouped Connections">
                {ungrouped.map((c) => (
                  <li key={c.id} className="list-row">
                    <Icon name="database" className="muted" />
                    <span className="list-row-name">{c.name}</span>
                    <DialectTag dialect={c.dialect} />
                    <span className="list-row-target mono-small muted" title={connectionTarget(c)}>
                      {shortenPath(connectionTarget(c))}
                    </span>
                    <button type="button" className="button button-small" onClick={() => onOpenUngrouped(c.id)}>
                      Open
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {(suggestions.length > 0 || suggestionError) && (
        <section className="home-section" aria-labelledby="home-suggested">
          <h2 id="home-suggested" className="section-label">
            Found on this PC
          </h2>
          {suggestionError ? (
            <p className="error-text">{suggestionError}</p>
          ) : (
            <ul className="list-panel" aria-label="Suggested Connections">
              {suggestions.map((s) => (
                <li key={`${s.dialect}:${s.host}:${s.port}`} className="list-row">
                  <Icon name="database" className="muted" />
                  <span className="list-row-name">{s.name}</span>
                  <DialectTag dialect={s.dialect} />
                  <span className="list-row-target mono-small muted">
                    {s.user}@{s.host}:{s.port}
                  </span>
                  <button
                    type="button"
                    className="button button-small"
                    aria-label={`Add ${s.name}`}
                    onClick={() => setForm({ kind: "connection", prefill: s })}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {form.kind === "group" && (
        <GroupForm
          connectionCount={0}
          onSaved={() => {
            setForm({ kind: "none" });
            onChanged();
          }}
          onDeleted={() => {}}
          onCancel={() => setForm({ kind: "none" })}
        />
      )}
      {form.kind === "connection" && (
        <ConnectionForm
          prefill={form.prefill}
          groups={groups}
          defaultGroupId={null}
          onSaved={() => {
            setForm({ kind: "none" });
            onChanged();
          }}
          onCancel={() => setForm({ kind: "none" })}
        />
      )}
    </div>
  );
}
