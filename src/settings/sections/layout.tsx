import { createContext, type ReactNode, useContext, useId } from "react";
import type { SettingsSection } from "../../shell/tabs";

/** A row as search sees it: its label and other words it answers to. */
export interface RowKey {
  label: string;
  terms?: string;
}

/** What is typed in Search settings. */
export const SearchContext = createContext("");
/** The search names the section itself, so every row of it shows. */
const WholeSection = createContext(false);

export function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || texts.some((t) => t !== undefined && t.toLowerCase().includes(q));
}

/** Whether a section has anything to show for the search. */
export function sectionShown(query: string, title: string, rows: readonly RowKey[]): boolean {
  return matches(query, title) || rows.some((r) => matches(query, r.label, r.terms));
}

interface SectionProps {
  id: SettingsSection;
  title: string;
  rows: readonly RowKey[];
  children: ReactNode;
}

/** One section of the Settings page; gone while the search matches none of its rows. */
export function Section({ id, title, rows, children }: SectionProps) {
  const query = useContext(SearchContext);
  const headingId = useId();
  if (!sectionShown(query, title, rows)) return null;
  return (
    <section className="ssec" data-section={id} aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <WholeSection.Provider value={matches(query, title) && query.trim() !== ""}>{children}</WholeSection.Provider>
    </section>
  );
}

/** Whether a row (or a block that is not a row) shows for the search. */
export function useRowShown(key: RowKey): boolean {
  const query = useContext(SearchContext);
  const whole = useContext(WholeSection);
  return whole || matches(query, key.label, key.terms);
}

export interface RowIds {
  labelId: string;
  hintId: string | undefined;
}

interface RowProps extends RowKey {
  hint?: ReactNode;
  /** The label above a full-width control, as for the theme cards. */
  stacked?: boolean;
  /** The label shown, when it differs from the one search reads. */
  shownLabel?: string;
  children: ReactNode | ((ids: RowIds) => ReactNode);
}

/** A label, its control and an optional hint under the control. */
export function Row({ label, terms, hint, stacked, shownLabel, children }: RowProps) {
  const id = useId();
  const shown = useRowShown({ label, terms });
  if (!shown) return null;
  const ids: RowIds = { labelId: `${id}-label`, hintId: hint ? `${id}-hint` : undefined };
  return (
    <div className={stacked ? "srow srow-stacked" : "srow"}>
      <span className="srow-label" id={ids.labelId}>
        {shownLabel ?? label}
      </span>
      <div className="srow-control">{typeof children === "function" ? children(ids) : children}</div>
      {hint && (
        <span className="srow-hint" id={ids.hintId}>
          {hint}
        </span>
      )}
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
  /** Drawn after the switch, such as the ligature sample. */
  children?: ReactNode;
}

/** A row whose control is a switch named by the row label. */
export function SwitchRow({ checked, onChange, note, children, ...row }: SwitchRowProps) {
  return (
    <Row {...row}>
      {({ labelId, hintId }) => (
        <>
          <button
            type="button"
            role="switch"
            className={checked ? "sw on" : "sw"}
            aria-checked={checked}
            aria-labelledby={labelId}
            aria-describedby={hintId}
            onClick={() => onChange(!checked)}
          />
          {children}
          {note && <span className="srow-note">{note}</span>}
        </>
      )}
    </Row>
  );
}
