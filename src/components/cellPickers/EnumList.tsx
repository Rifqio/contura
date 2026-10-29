import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

/** Beyond this many values the list gets a filter box. */
export const FILTER_FROM = 9;

interface Props {
  values: string[];
  /** What the text box holds; the value equal to it is the selected row. */
  current: string;
  /** Shown as a NULL row first when the column is nullable. */
  nullable: boolean;
  label: string;
  /** `null` is NULL. */
  onPick(value: string | null, how: "click" | "enter"): void;
}

/** The allowed values as a listbox in the Select's rows: Up, Down, Home, End and type-to-find move, Enter picks. */
export default function EnumList({ values, current, nullable, label, onPick }: Props) {
  const id = useId();
  const [filter, setFilter] = useState("");
  const filtered = values.length >= FILTER_FROM;
  const rows = useMemo(() => {
    const all: { value: string | null; label: string }[] = [...(nullable ? [{ value: null, label: "NULL" }] : []), ...values.map((v) => ({ value: v, label: v }))];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((r) => r.label.toLowerCase().includes(q)) : all;
  }, [values, nullable, filter]);
  const [active, setActive] = useState(() => Math.max(0, rows.findIndex((r) => r.value === current)));
  const typed = useRef({ text: "", timer: 0 });
  const optionId = (i: number) => `${id}-opt-${i}`;

  useEffect(() => () => window.clearTimeout(typed.current.timer), []);
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // optionId only depends on the stable id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const at = Math.min(active, rows.length - 1);

  function typeahead(ch: string) {
    window.clearTimeout(typed.current.timer);
    typed.current.text += ch.toLowerCase();
    typed.current.timer = window.setTimeout(() => (typed.current.text = ""), 700);
    const hit = rows.findIndex((r) => r.label.toLowerCase().startsWith(typed.current.text));
    if (hit >= 0) setActive(hit);
  }

  function onKey(e: KeyboardEvent, inList: boolean) {
    const k = e.key;
    const last = rows.length - 1;
    if (k === "ArrowDown") setActive(Math.min(at + 1, last));
    else if (k === "ArrowUp") setActive(Math.max(at - 1, 0));
    else if (k === "Home" && inList) setActive(0);
    else if (k === "End" && inList) setActive(last);
    else if (k === "Enter") {
      if (rows[at]) onPick(rows[at].value, "enter");
    } else if (inList && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeahead(k);
    else return;
    e.preventDefault();
  }

  const activeId = rows.length ? optionId(at) : undefined;
  return (
    <div className="enum-list">
      {filtered && (
        <input
          type="search"
          className="input input-small enum-filter"
          aria-label="Filter values"
          aria-controls={`${id}-list`}
          aria-activedescendant={activeId}
          placeholder="Filter values"
          spellCheck={false}
          autoComplete="off"
          data-picker-stop=""
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => onKey(e, false)}
        />
      )}
      <div
        id={`${id}-list`}
        className="enum-options"
        role="listbox"
        aria-label={`Values of ${label}`}
        tabIndex={filtered ? -1 : 0}
        data-picker-stop={filtered ? undefined : ""}
        aria-activedescendant={filtered ? undefined : activeId}
        onKeyDown={(e) => onKey(e, true)}
      >
        {rows.map((r, i) => (
          <div
            key={r.value ?? "\u0000null"}
            id={optionId(i)}
            role="option"
            aria-selected={r.value === current}
            className={["select-option", i === at ? "select-option-active" : "", r.value === current ? "select-option-on" : ""].filter(Boolean).join(" ")}
            onMouseMove={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(r.value, "click")}
          >
            <span className={r.value === null ? "select-label cell-null" : "select-label"}>{r.label}</span>
          </div>
        ))}
        {rows.length === 0 && <div className="enum-empty">No values match</div>}
      </div>
    </div>
  );
}
