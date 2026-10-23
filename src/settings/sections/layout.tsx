import { createContext, type ReactNode, useContext, useId } from "react";
import Icon from "../../components/Icon";

/** A row as search sees it: its anchor, its label and other words it answers to. */
export interface RowKey {
  /** The row's anchor (`data-row`): search results and links go there. */
  id: string;
  label: string;
  terms?: string;
  /** The card it sits in, for the search result's trail. */
  card?: string;
}

/** Rows keyed by their anchor: each key becomes the row's `id`. */
export function defineRows<K extends string>(rows: Record<K, Omit<RowKey, "id">>): Record<K, RowKey> {
  return Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, { id, ...(r as Omit<RowKey, "id">) }])) as Record<K, RowKey>;
}

/** The row a search result or a link went to: it stays highlighted until the next move. */
export const FlashContext = createContext<string | null>(null);

export function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || texts.some((t) => t !== undefined && t.toLowerCase().includes(q));
}

/** The class of a row (or block) by its anchor, with the highlight when it is the row gone to. */
export function useFlashClass(id: string | undefined, base: string): string {
  const flash = useContext(FlashContext);
  return id !== undefined && flash === id ? `${base} srow-flash` : base;
}

/** A page's title and its one line, with room for actions on the right. */
export function PageHead({ title, desc, children }: { title: string; desc: ReactNode; children?: ReactNode }) {
  return (
    <header className="settings-head">
      <div className="settings-head-text">
        <h1>{title}</h1>
        <p>{desc}</p>
      </div>
      {children && <div className="settings-head-actions">{children}</div>}
    </header>
  );
}

/** A card of rows, its name on top when it has one. */
export function Card({ title, row, children }: { title?: string; row?: string; children: ReactNode }) {
  const headingId = useId();
  const cls = useFlashClass(row, "scard");
  return (
    <section className={cls} data-row={row} aria-labelledby={title ? headingId : undefined}>
      {title && (
        <h2 className="scard-head" id={headingId}>
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

export interface RowIds {
  labelId: string;
  hintId: string | undefined;
}

interface RowProps extends RowKey {
  hint?: ReactNode;
  /** The label shown, when it differs from the one search reads. */
  shownLabel?: string;
  /** Full width under the label and the control, such as a test result. */
  below?: ReactNode;
  children: ReactNode | ((ids: RowIds) => ReactNode);
}

/** A label with its hint under it on the left, the control on the right. */
export function Row({ id, label, hint, shownLabel, below, children }: RowProps) {
  const uid = useId();
  const cls = useFlashClass(id, "srow");
  const ids: RowIds = { labelId: `${uid}-label`, hintId: hint ? `${uid}-hint` : undefined };
  return (
    <div className={cls} data-row={id}>
      <span className="srow-text">
        <span className="srow-label" id={ids.labelId}>
          {shownLabel ?? label}
        </span>
        {hint && (
          <span className="srow-hint" id={ids.hintId}>
            {hint}
          </span>
        )}
      </span>
      <div className="srow-control">{typeof children === "function" ? children(ids) : children}</div>
      {below && <div className="srow-below">{below}</div>}
    </div>
  );
}

interface SwitchRowProps extends RowKey {
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  shownLabel?: string;
  /** A short remark beside the switch. */
  note?: string;
  /** Drawn before the switch, such as the ligature sample. */
  children?: ReactNode;
}

/** A row whose control is a switch named by the row label. */
export function SwitchRow({ checked, onChange, note, children, ...row }: SwitchRowProps) {
  return (
    <Row {...row}>
      {({ labelId, hintId }) => (
        <>
          {children}
          {note && <span className="srow-note">{note}</span>}
          <button
            type="button"
            role="switch"
            className={checked ? "sw on" : "sw"}
            aria-checked={checked}
            aria-labelledby={labelId}
            aria-describedby={hintId}
            onClick={() => onChange(!checked)}
          />
        </>
      )}
    </Row>
  );
}

/** What a row read from the Core: a line while it loads, the answer, or the error with an icon. */
export type DataState = { s: "loading"; text: string } | { s: "ready"; text: ReactNode } | { s: "error"; text: string };

export function StateText({ state }: { state: DataState }) {
  if (state.s === "error") {
    return (
      <span className="sstate sstate-error" role="alert">
        <Icon name="alert" size={14} />
        <span>{state.text}</span>
      </span>
    );
  }
  return (
    <span className="sstate" role="status">
      {state.s === "loading" && <span className="spin" aria-hidden="true" />}
      <span>{state.text}</span>
    </span>
  );
}
