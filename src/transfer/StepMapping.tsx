import { useEffect, useId, useState } from "react";
import { DIALECT_LABEL } from "../api/client";
import type { TransferNote, TransferPlan, TransferSetting } from "../api/types";
import Icon, { type IconName } from "../components/Icon";
import Segmented from "../components/Segmented";
import { typeSuggestions } from "../design/typeSuggestions";

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

/** "1 column needs a choice before Review SQL. ...", or null when none does. */
export function choiceBanner(blocked: number): string | null {
  if (blocked === 0) return null;
  return `${blocked === 1 ? "1 column needs" : `${n(blocked)} columns need`} a choice before Review SQL. Every type here can be changed; the SQL in the next step uses what you set.`;
}

/** The Type mapping footer. */
export function mappingFooter(plan: TransferPlan): string {
  return `${plural(plan.mappingNotes.length, "note", "notes")}. Rows that do not fit their new type stop the run with the row number.`;
}

const NOTE_LOOK: Record<TransferNote["kind"]["kind"], { icon: IconName; className: string }> = {
  info: { icon: "info", className: "transfer-note" },
  new: { icon: "plus", className: "transfer-note transfer-note-info" },
  needsChoice: { icon: "alert", className: "transfer-note transfer-note-warn" },
  noMatch: { icon: "alert", className: "transfer-note transfer-note-bad" },
  lossy: { icon: "warning", className: "transfer-note transfer-note-warn" },
};

/** A long-name note: the server would cut the name, so the user picks one (its option is the cut name). */
export function isNameNote(note: TransferNote | null): note is TransferNote & { kind: { kind: "needsChoice"; options: string[] } } {
  return note?.kind.kind === "needsChoice" && note.text.startsWith("The name ");
}

/** A target name for a table or column whose name is too long; set on Enter or leaving it. */
function NameCell({ label, suggested, onSet }: { label: string; suggested: string; onSet(value: string): void }) {
  const [text, setText] = useState("");
  const commit = () => {
    const v = text.trim();
    if (v) onSet(v);
  };
  return (
    <input
      className="input mono transfer-type transfer-type-warn"
      aria-label={label}
      placeholder={suggested}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

interface CellProps {
  table: string;
  column: string;
  type: string;
  /** The choices a needs-a-choice column offers; empty otherwise. */
  options: string[];
  /** Picked from `options` already. */
  chosen: boolean;
  suggestions: string[];
  tone: "warn" | "bad" | null;
  onSet(value: string): void;
}

/** A target type: free text with the target Dialect's suggestions, set on Enter or leaving it. */
function TypeCell({ table, column, type, options, chosen, suggestions, tone, onSet }: CellProps) {
  const listId = useId();
  const pick = options.length > 0 && !chosen;
  const [text, setText] = useState(pick ? "" : type);
  useEffect(() => setText(pick ? "" : type), [type, pick]);
  const commit = () => {
    const v = text.trim();
    if (v && v !== type) onSet(v);
    else if (!v) setText(pick ? "" : type);
  };
  return (
    <>
      <input
        className={["input mono transfer-type", tone ? `transfer-type-${tone}` : ""].join(" ").trim()}
        aria-label={`Target type of ${table}.${column}`}
        placeholder={pick ? "Pick a type" : undefined}
        list={listId}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // A pick from the list sets at once; typing waits for Enter or leaving.
          if (options.includes(e.target.value) || (e.nativeEvent as InputEvent).inputType === "insertReplacementText") onSet(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setText(pick ? "" : type);
          }
        }}
      />
      <datalist id={listId}>
        {[...options, ...suggestions.filter((s) => !options.includes(s))].map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
}

interface Props {
  plan: TransferPlan;
  /** The ticked tables in load order (source names). */
  tables: string[];
  choices: TransferSetting[];
  /** A refused type, from the last plan call. */
  error: string | null;
  onType(table: string, column: string, value: string): void;
  /** A name for a table (`column` null) or column whose name is too long for the target. */
  onName(table: string, column: string | null, value: string): void;
}

/** Step 3 (frame 8.1): every column's target type, editable, with its note. */
export default function StepMapping({ plan, tables, choices, error, onType, onName }: Props) {
  const [selected, setSelected] = useState(tables[0] ?? "");
  const [notesOnly, setNotesOnly] = useState<"all" | "notes">("all");
  useEffect(() => {
    if (!tables.includes(selected)) setSelected(tables[0] ?? "");
  }, [tables, selected]);

  const notesOf = (table: string) => plan.mappingNotes.filter((m) => m.table === table);
  const planned = plan.tables.find((t) => t.name === selected);
  const notes = notesOf(selected);
  const columnNote = (col: string) => notes.find((m) => m.column === col) ?? null;
  const tableNotes = notes.filter((m) => m.column === null);
  const columns = planned?.columns ?? [];
  const noted = columns.filter((c) => columnNote(c.name) !== null);
  const shown = notesOnly === "notes" ? noted : columns;
  const asks = notes.filter((m) => m.kind.kind === "needsChoice").length;
  const banner = choiceBanner(plan.blocked.length);
  const suggestions = typeSuggestions(plan.targetDialect);
  const others = plan.notCopied.filter((s) => s.includes(`${selected}.`) || s.endsWith(` on ${selected}`));

  return (
    <div className="transfer-mapping">
      <nav className="transfer-mapping-side" aria-label="Ticked tables">
        <span className="transfer-flab">Tables</span>
        {tables.map((t) => {
          const count = notesOf(t).length;
          return (
            <button
              key={t}
              type="button"
              className={t === selected ? "transfer-mapping-table on" : "transfer-mapping-table"}
              aria-current={t === selected || undefined}
              onClick={() => setSelected(t)}
            >
              <Icon name="table" size={14} />
              <span className="m">{t}</span>
              {count > 0 ? (
                <span className="transfer-chip transfer-chip-warn" aria-label={plural(count, "note", "notes")}>
                  {count}
                </span>
              ) : (
                <span className="transfer-ok" aria-label="No notes">
                  <Icon name="check" size={14} />
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <section className="transfer-mapping-main" aria-label={`Columns of ${selected}`}>
        <header className="transfer-pane-head">
          <span className="transfer-sect m">{selected}</span>
          <span className="transfer-count">
            {plural(columns.length, "column", "columns")}, {plural(notes.length, "note", "notes")}
            {asks > 0 ? `, ${asks} ${asks === 1 ? "needs" : "need"} a choice` : ""}
          </span>
          <span className="transfer-sp" />
          <Segmented
            label="Show columns"
            value={notesOnly}
            options={[
              { value: "all", label: `All ${n(columns.length)} columns` },
              { value: "notes", label: `Notes only ${n(noted.length)}` },
            ]}
            onChange={setNotesOnly}
          />
        </header>
        {banner && (
          <div className="transfer-ban transfer-ban-warn" role="status">
            <Icon name="alert" size={14} />
            <span>{banner}</span>
          </div>
        )}
        {error && (
          <div className="transfer-ban transfer-ban-bad" role="alert">
            <Icon name="error" size={14} />
            <span>{error}</span>
          </div>
        )}
        {tableNotes.map((m) => (
          <div key={m.text} className="transfer-mapping-tnote">
            <p className={isNameNote(m) ? "transfer-hint transfer-note-warn" : "transfer-hint"}>{m.text}</p>
            {isNameNote(m) && <NameCell label={`Target name of ${selected}`} suggested={m.kind.options[0] ?? ""} onSet={(v) => onName(selected, null, v)} />}
          </div>
        ))}
        <div className="transfer-mapping-grid">
          <div className="transfer-box">
            <table className="transfer-lt">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>{DIALECT_LABEL[plan.sourceDialect]} type</th>
                  <th className="w0" aria-label="becomes" />
                  <th>{DIALECT_LABEL[plan.targetDialect]} type</th>
                  <th className="transfer-note-col">Note</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const note = columnNote(c.name);
                  const naming = isNameNote(note);
                  const kind = note?.kind.kind ?? null;
                  const options = note?.kind.kind === "needsChoice" && !naming ? note.kind.options : [];
                  const chosen = choices.some((x) => x.table === selected && x.column === c.name);
                  const look = kind ? NOTE_LOOK[kind] : null;
                  return (
                    <tr key={c.name} className={kind === "needsChoice" && !chosen ? "att" : kind === "noMatch" ? "err" : undefined}>
                      <td className="m">
                        {c.name}
                        {naming && <NameCell label={`Target name of ${selected}.${c.name}`} suggested={note.kind.options[0] ?? ""} onSet={(v) => onName(selected, c.name, v)} />}
                      </td>
                      <td className="m transfer-srctype">{c.sourceType}</td>
                      <td>
                        <Icon name="arrowRight" size={14} />
                      </td>
                      <td>
                        <TypeCell
                          table={selected}
                          column={c.name}
                          type={c.targetType}
                          options={options}
                          chosen={chosen}
                          suggestions={suggestions}
                          tone={kind === "needsChoice" && !chosen && !naming ? "warn" : kind === "noMatch" ? "bad" : null}
                          onSet={(v) => onType(selected, c.name, v)}
                        />
                      </td>
                      <td className="transfer-note-col">
                        {note && look && (
                          <span className={look.className}>
                            <Icon name={look.icon} size={14} />
                            {note.text}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {others.length > 0 && (
            <p className="transfer-hint">
              Also not copied from {selected}: {others.join(", ")}. They are listed again on Review SQL.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
