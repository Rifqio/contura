import type { SlashCommand } from "./slash";

interface Props {
  /** The commands the draft matches; empty says that none does. */
  commands: SlashCommand[];
  /** The row Enter would run. */
  active: number;
  /** Why a command cannot run now, by name; such a row is dimmed and does nothing. */
  unavailable?: Record<string, string>;
  /** The draft, for the line that says nothing matched. */
  draft?: string;
  /** The id the composer points `aria-activedescendant` at: `${id}-${name}`. */
  id: string;
  onRun(command: SlashCommand): void;
  /** The listbox's name; "Commands" by default. */
  label?: string;
  /** Rows show their label (a frame's title) with the hint after it, without the slash and name. */
  bare?: boolean;
  /** The line that says nothing matched, instead of the commands' one. */
  empty?: string;
}

/** The id of a row, for the composer's `aria-activedescendant`. */
export const optionId = (id: string, name: string) => `${id}-${name}`;

/** The command list above the Ask composer: a listbox in the Menu look; the composer keeps focus and drives it. */
export default function SlashCommands({ commands, active, unavailable = {}, draft = "/", id, onRun, label = "Commands", bare = false, empty }: Props) {
  return (
    <div className="menu slash-menu">
      <div id={id} role="listbox" aria-label={label}>
        {commands.map((c, i) => {
          const why = unavailable[c.name];
          return (
            <div
              key={c.name}
              id={optionId(id, c.name)}
              role="option"
              aria-selected={i === active}
              aria-disabled={why ? true : undefined}
              className={`menu-item slash-row${bare ? " slash-row-bare" : ""}${i === active ? " menu-item-current" : ""}${why ? " slash-row-off" : ""}`}
              // Keep focus in the composer.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onRun(c)}
            >
              <span className="slash-name">{bare ? c.label : `/${c.name}`}</span>
              <span className="slash-hint">{why ?? c.hint}</span>
            </div>
          );
        })}
      </div>
      {commands.length === 0 && <p className="slash-empty">{empty ?? `No command matches ${draft}. Delete the / to ask a question.`}</p>}
    </div>
  );
}
