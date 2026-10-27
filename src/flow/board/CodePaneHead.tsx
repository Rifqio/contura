// The code pane round the shown frame's block (Decision 25): a header with the kind's icon, name and one line and the
// save state, then the pane's body (the editor and its Problems), then a footer with Syntax help and the kind's chips.
// Every name comes from the one kind-name source through `KIND_HEAD`; the chips insert the language's own syntax.
import type { ReactNode } from "react";
import Icon from "../../components/Icon";
import type { DiagramKind } from "../../lang/flow/model";
import type { SaveState } from "../useFlowDoc";
import { LAYOUT_TOO_BIG } from "../useFlowDoc";
import { CHIPS, KIND_HEAD, KIND_ICON } from "./chips";

interface Props {
  /** The shown frame's kind; null while it has none (no header word yet). */
  kind: DiagramKind | null;
  save: SaveState;
  /** A chip's text, to go in where you are typing. */
  onChip(text: string): void;
  /** Syntax Help (Task 14); the button shows only once it has somewhere to go. */
  onHelp?(): void;
  /** The text of the line you are typing on, up to where you are, so a chip fits it. */
  lineBefore(): string;
  /** The Assistant holds the text: the chips insert nothing. */
  disabled?: boolean;
  children: ReactNode;
}

export default function CodePaneHead({ kind, save, onChip, onHelp, lineBefore, disabled = false, children }: Props) {
  const head = kind ? KIND_HEAD[kind] : null;
  return (
    <>
      <div className="schema-pane-head flow-strip code-pane-head">
        {kind && <Icon name={KIND_ICON[kind]} size={16} />}
        <h2 className="schema-pane-title">{head?.name ?? ""}</h2>
        {head && <span className="code-pane-line">{head.line}</span>}
        <span className="spacer" />
        {save.kind === "saved" ? (
          <span className="schema-pane-saved flow-saved">
            <Icon name="check" size={14} />
            Saved
          </span>
        ) : save.kind === "waiting" ? (
          <span className="schema-pane-saved">Not saved</span>
        ) : (
          <span className="schema-pane-saved flow-save-failed" role="alert">
            {save.message === LAYOUT_TOO_BIG ? save.message : `Not saved: ${save.message}`}
          </span>
        )}
      </div>
      {children}
      {(onHelp || kind) && (
        <div className="code-pane-chips" role="group" aria-label="Insert syntax">
          {onHelp && (
            <button type="button" className="code-pane-chip" aria-label="Syntax help" onClick={onHelp}>
              {"<?>"}
            </button>
          )}
          {kind &&
            CHIPS[kind].map((c) => (
              <button
                key={c.name}
                type="button"
                className="code-pane-chip"
                aria-label={`Insert ${c.name}`}
                disabled={disabled}
                // The editor keeps its place: a press here does not take focus from it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChip(c.insert(lineBefore()))}
              >
                {c.op}
              </button>
            ))}
        </div>
      )}
    </>
  );
}
