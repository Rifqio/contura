import { Fragment, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorText } from "../../api/client";
import type { KeymapOverrides } from "../../api/types";
import { type Clash, applyRebind, findClash, keyProblem, keysFor, resetCommand } from "../../commands/keymap";
import { keysFromEvent, normalizeKeys } from "../../commands/keys";
import { COMMANDS, type Command, type CommandId, commandById } from "../../commands/registry";
import { platform } from "../../platform";
import { useKeymap } from "../../commands/useCommandKeys";
import Icon from "../../components/Icon";
import Kbd from "../../components/Kbd";
import Segmented from "../../components/Segmented";
import Select from "../../components/Select";
import { FlashContext, PageHead, defineRows, matches } from "./layout";

const ROW = defineRows({
  keymap: { label: "Keymap", terms: "VS Code shortcuts keys Reset all" },
});
export const KEYMAP_ROWS = Object.values(ROW);

/** The nine numbered commands sit in a group as one folded row until shown. */
const FOLDS = {
  "group.open": { title: "Open Group 1 to 9", hint: "In the order Groups have on Home", keys: "Ctrl+Alt+1…9" },
  "tab.goto": { title: "Go to tab 1 to 9", hint: "Ctrl+9 goes to the last tab", keys: "Ctrl+1…9" },
} as const;
type Fold = keyof typeof FOLDS;
const isFold = (id: string): id is Fold => Object.prototype.hasOwnProperty.call(FOLDS, id);
const foldMembers = (fold: Fold) => COMMANDS.filter((c) => c.id.startsWith(`${fold}.`)).map((c) => c.id);

/** The board's groups; every command of the registry is in one (a test holds that). */
export const KEYMAP_GROUPS: { name: string; ids: (CommandId | Fold)[] }[] = [
  {
    name: "Queries and the editor",
    ids: ["query.run", "query.runAll", "query.explain", "query.format", "query.save", "editor.ask", "editor.quickFix", "editor.rename", "editor.definition", "editor.parameterHints"],
  },
  { name: "Tabs and windows", ids: ["query.new", "tab.close", "tab.reopen", "tab.next", "tab.previous", "tab.goto", "pane.next", "pane.previous", "home.open", "settings.open", "history.toggle"] },
  { name: "Connections and schema", ids: ["connection.new", "tree.filter", "tree.refresh", "group.open"] },
  { name: "AI assistant", ids: ["assistant.toggle", "assistant.newChat"] },
  {
    name: "Data, Visual Query and diagrams",
    ids: ["export.open", "visualQuery.openInEditor", "diagram.toggle", "flow.new", "flow.fromMermaid", "flow.saveCopy", "flow.rename", "flow.delete"],
  },
];

/** Where a command works, when it is not everywhere. */
const NOTES: Partial<Record<CommandId, string>> = {
  "export.open": "In a table grid or a result",
  "visualQuery.openInEditor": "In a Visual Query tab",
  "diagram.toggle": "In a Visual Query tab",
};

type Filter = "all" | "editor" | "app" | "changed";

/** What a key press led to while a command is being rebound. */
type Pressed = { keys: string; problem: string } | { keys: string; clash: Clash };

/** A reset whose default keys another command has taken since: asked like a rebind. */
type ResetAsk = { id: CommandId; keys: string; clash: Clash };

/** Where focus goes after the control that had it is gone: a row's change button, or the search. */
type FocusTo = { row: CommandId; order: readonly CommandId[] } | { search: true };

/** The question before keys move: what has them now, and what it is left with. */
function clashText(keys: string, clash: Clash, map: ReturnType<typeof useKeymap>["map"]): string {
  if (clash.kind === "editor") return `${keys} is used by ${clash.title} in the editor. Use it here?`;
  const left = keysFor(map, clash.id).filter((k) => k !== keys);
  return left.length === 0
    ? `${keys} is used by ${clash.title}. Use it here, and ${clash.title} has no shortcut?`
    : `${keys} is used by ${clash.title}. Use it here? ${clash.title} keeps ${left.join(" or ")}.`;
}

/** Whether a command's keys differ from its defaults. */
function isChanged(c: Command, keys: string[]): boolean {
  return keys.join("\n") !== c.keys.map(normalizeKeys).join("\n");
}

function Keys({ keys }: { keys: string[] }) {
  if (keys.length === 0) return <span className="krow-none">No shortcut</span>;
  return (
    <span className="kmap-keys">
      {keys.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && <span className="krow-or">or</span>}
          <Kbd keys={k} />
        </Fragment>
      ))}
    </span>
  );
}

/** A failed save, by the row it was for; Dismiss hands focus back to the row. */
function SaveAlert({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div className="kverdict kalert" role="alert">
      <Icon name="alert" size={14} />
      <span className="kverdict-text">{text}</span>
      <button type="button" className="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

interface CaptureProps {
  command: Command;
  pressed: Pressed | null;
  onPress: (keys: string) => void;
  onCancel: () => void;
}

/** Takes the next key press for a command; Escape gives up, Tab moves on. */
function Capture({ command, pressed, onPress, onCancel }: CaptureProps) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <input
      ref={field}
      readOnly
      className="input mono keymap-capture"
      aria-label={`New keys for ${command.title}`}
      placeholder="Press the new keys, Esc to cancel"
      value={pressed?.keys ?? ""}
      onKeyDown={(e) => {
        const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
        if (e.key === "Tab" && plain) return;
        // Kept from the window's own keys.
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape" && plain && !e.shiftKey) {
          onCancel();
          return;
        }
        const keys = keysFromEvent(e.nativeEvent);
        if (keys) onPress(keys);
      }}
    />
  );
}

/**
 * Settings, Keymap (D10): every command in its group, search by words or by keys, the filters, and
 * rebinding in the row. Keys another command has are moved only after you choose to; a failed save
 * says so and changes nothing.
 */
export default function KeymapSection({ title, desc }: { title: string; desc: string }) {
  const { map, overrides, save } = useKeymap();
  const flash = useContext(FlashContext);
  const [query, setQuery] = useState("");
  const [byKeys, setByKeys] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [unfolded, setUnfolded] = useState<ReadonlySet<Fold>>(new Set());
  const [editing, setEditing] = useState<CommandId | null>(null);
  const [pressed, setPressed] = useState<Pressed | null>(null);
  /** A failed save, shown by the row it was for (null: Reset all, shown on top). */
  const [saveError, setSaveError] = useState<{ row: CommandId | null; text: string } | null>(null);
  const [resetAsk, setResetAsk] = useState<ResetAsk | null>(null);
  const focusTo = useRef<FocusTo | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /** The command rows on screen, in order, as last drawn. */
  const order = useRef<readonly CommandId[]>([]);
  /** The row whose capture or ask is open now, read after a save to see whether the user has moved on. */
  const active = useRef<CommandId | null>(null);
  active.current = editing ?? resetAsk?.id ?? null;

  // After a capture, a clash bar, a reset or the fold goes away, focus moves on instead of to the body,
  // unless the user has put it somewhere else meanwhile.
  useLayoutEffect(() => {
    const to = focusTo.current;
    if (!to) return;
    focusTo.current = null;
    const now = document.activeElement;
    const change = (id: CommandId) => document.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"] [data-change]`);
    if ("search" in to) {
      if (!now || now === document.body || !now.isConnected || now.closest(".khead")) searchRef.current?.focus();
      return;
    }
    if (now && now !== document.body && now.isConnected && !now.closest(`[data-row="${CSS.escape(to.row)}"]`)) return;
    // A row that left the list (a reset under Changed) hands focus to the next row, then the one before, then the search.
    const at = to.order.indexOf(to.row);
    const next = [to.row, ...to.order.slice(at + 1), ...to.order.slice(0, Math.max(0, at)).reverse()].map(change).find((b) => b);
    if (next) next.focus();
    else searchRef.current?.focus();
  });

  const changed = COMMANDS.filter((c) => isChanged(c, keysFor(map, c.id)));
  const changedIds = new Set(changed.map((c) => c.id));
  // A search result for one numbered command shows all nine; so does a change to one of them.
  const isFolded = (fold: Fold) =>
    !unfolded.has(fold) &&
    !(flash !== null && flash.startsWith(`${fold}.`)) &&
    !foldMembers(fold).some((id) => changedIds.has(id)) &&
    filter === "all" &&
    query === "";

  /** Ends a capture or an ask; focus goes back to the row's change button. */
  function stopEditing(row: CommandId | null) {
    setEditing(null);
    setPressed(null);
    setResetAsk(null);
    focusTo.current = row === null ? { search: true } : { row, order: order.current };
  }

  /** Saves `next` for `row` (null: Reset all); a failure is shown by that row and nothing changes. */
  async function store(next: KeymapOverrides, row: CommandId | null) {
    setSaveError(null);
    try {
      await save(next);
    } catch (e) {
      setSaveError({ row, text: `The new keys were not saved: ${errorText(e).replace(/\.$/, "")}. Nothing changed.` });
    }
    // The user may have started on another row while this saved: leave that one alone.
    if (active.current !== null && active.current !== row) return;
    stopEditing(row);
  }

  function dismiss(row: CommandId | null) {
    setSaveError(null);
    focusTo.current = row === null ? { search: true } : { row, order: order.current };
  }

  /** Back to the defaults; when another command has one of them now, ask first, as a rebind does. */
  function reset(c: Command) {
    for (const k of c.keys.map(normalizeKeys)) {
      const clash = findClash(map, c.id, k);
      if (clash?.kind === "command") {
        setEditing(null);
        setPressed(null);
        setResetAsk({ id: c.id, keys: k, clash });
        return;
      }
    }
    void store(resetCommand(overrides, c.id), c.id);
  }

  /** The reset, with its default keys taken off whatever command has them now. */
  function resetTaking(id: CommandId): KeymapOverrides {
    const defaults = commandById(id)!.keys.map(normalizeKeys);
    let next = resetCommand(overrides, id);
    for (const [other, ks] of map) {
      if (other !== id && ks.some((k) => defaults.includes(k))) next = { ...next, [other]: ks.filter((k) => !defaults.includes(k)) };
    }
    return next;
  }

  function press(id: CommandId, keys: string) {
    const problem = keyProblem(keys);
    if (problem) return setPressed({ keys, problem });
    if (keysFor(map, id).includes(keys)) return stopEditing(id);
    const clash = findClash(map, id, keys);
    if (clash) return setPressed({ keys, clash });
    void store(applyRebind(overrides, map, id, keys), id);
  }

  const shows = (c: Command) => {
    if (filter === "editor" && c.scope !== "editor") return false;
    if (filter === "app" && c.scope !== "app") return false;
    if (filter === "changed" && !changedIds.has(c.id)) return false;
    const keys = keysFor(map, c.id);
    if (query === "") return true;
    if (byKeys) return keys.includes(normalizeKeys(query));
    return matches(query, c.title, keys.join(" "), NOTES[c.id]);
  };

  const count = (f: Filter) => COMMANDS.filter((c) => (f === "all" ? true : f === "changed" ? changedIds.has(c.id) : c.scope === f)).length;
  const groups = KEYMAP_GROUPS.map((g) => {
    const ids = g.ids.flatMap((id) => (isFold(id) ? (isFolded(id) ? [id] : foldMembers(id)) : [id]));
    const rows = ids.filter((id) => isFold(id) || shows(commandById(id)!));
    return { name: g.name, rows };
  }).filter((g) => g.rows.length > 0);
  order.current = groups.flatMap((g) => g.rows).filter((id): id is CommandId => !isFold(id));

  function commandRow(c: Command) {
    const keys = keysFor(map, c.id);
    const isEditing = editing === c.id;
    const isChangedRow = changedIds.has(c.id);
    const defaults = c.keys.length > 0 ? c.keys.join(" or ") : "no shortcut";
    const ask = resetAsk?.id === c.id ? resetAsk : null;
    const cls = ["krow", (isEditing || ask) && "cap", flash === c.id && "srow-flash"].filter(Boolean).join(" ");
    return (
      <Fragment key={c.id}>
        <div className={cls} data-row={c.id}>
          <span className="krow-title">
            <span>
              {c.title}
              {isChangedRow && <span className="krow-changed">Changed</span>}
            </span>
            {NOTES[c.id] && <span className="srow-hint">{NOTES[c.id]}</span>}
          </span>
          <span className="krow-scope">{c.scope === "editor" ? "Editor" : "App"}</span>
          <span className="krow-keys">
            {isEditing ? <Capture command={c} pressed={pressed} onPress={(k) => press(c.id, k)} onCancel={() => stopEditing(c.id)} /> : <Keys keys={keys} />}
          </span>
          <span className={isEditing || isChangedRow ? "krow-actions keep" : "krow-actions"}>
            {isChangedRow && (
              <button
                type="button"
                className="icon-button"
                aria-label={`Reset ${c.title} to ${defaults}`}
                title={`Reset to ${defaults}`}
                onClick={() => reset(c)}
              >
                <Icon name="undo" size={14} />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={`Change the keys for ${c.title}`}
              title="Change the keys"
              data-change
              onClick={() => {
                setPressed(null);
                setResetAsk(null);
                setEditing(c.id);
              }}
            >
              <Icon name="edit" size={14} />
            </button>
          </span>
        </div>
        {isEditing && pressed && (
          <div className="kverdict" role="alert">
            <Icon name="alert" size={14} />
            <span className="kverdict-text">
              {"problem" in pressed ? pressed.problem : clashText(pressed.keys, pressed.clash, map)}
            </span>
            <button type="button" className="button" onClick={() => stopEditing(c.id)}>
              Cancel
            </button>
            {"clash" in pressed && (
              <button type="button" className="button button-primary" onClick={() => void store(applyRebind(overrides, map, c.id, pressed.keys), c.id)}>
                Use it here
              </button>
            )}
          </div>
        )}
        {ask && (
          <div className="kverdict" role="alert">
            <Icon name="alert" size={14} />
            <span className="kverdict-text">{`Reset to ${defaults}? ${clashText(ask.keys, ask.clash, map)}`}</span>
            <button type="button" className="button" onClick={() => stopEditing(c.id)}>
              Cancel
            </button>
            <button type="button" className="button button-primary" onClick={() => void store(resetTaking(c.id), c.id)}>
              Use it here
            </button>
          </div>
        )}
        {saveError?.row === c.id && <SaveAlert text={saveError.text} onDismiss={() => dismiss(c.id)} />}
      </Fragment>
    );
  }

  return (
    <>
      <PageHead title={title} desc={desc}>
        <span className="khead" data-row={ROW.keymap.id}>
          <span className="srow-hint">Keymap</span>
          <Select label="Keymap" value="vscode" options={[{ value: "vscode", label: "VS Code" }]} onChange={() => {}} className="keymap-select" />
          <button type="button" className="button" disabled={changed.length === 0} onClick={() => void store({}, null)}>
            <Icon name="undo" size={14} />
            {changed.length > 0 ? `Reset all (${changed.length})` : "Reset all"}
          </button>
        </span>
      </PageHead>
      <div className="ktool">
        <label className="snav-search ktool-search">
          <Icon name={byKeys ? "keyboard" : "search"} size={14} />
          <input
            ref={searchRef}
            aria-label="Search shortcuts"
            placeholder={byKeys ? "Press keys to see what uses them" : `Search ${COMMANDS.length} shortcuts`}
            value={query}
            spellCheck={false}
            onChange={(e) => !byKeys && setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (!byKeys) return;
              const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
              if (e.key === "Tab" && plain) return;
              e.preventDefault();
              e.stopPropagation();
              if ((e.key === "Backspace" || e.key === "Escape") && plain && !e.shiftKey) return setQuery("");
              const keys = keysFromEvent(e.nativeEvent);
              if (keys) setQuery(keys);
            }}
          />
        </label>
        <button
          type="button"
          className={byKeys ? "button button-on" : "button"}
          aria-pressed={byKeys}
          onClick={() => {
            setByKeys((b) => !b);
            setQuery("");
          }}
        >
          <Icon name="keyboard" size={14} />
          Search by keys
        </button>
        <Segmented<Filter>
          label="Show"
          value={filter}
          options={(
            [
              ["all", "All"],
              ["editor", "Editor"],
              ["app", "App"],
              ["changed", "Changed"],
            ] as const
          ).map(([value, label]) => ({ value, label, trail: <span className="seg-count">{count(value)}</span> }))}
          onChange={setFilter}
        />
      </div>
      {saveError && saveError.row === null && (
        <div className="scard">
          <SaveAlert text={saveError.text} onDismiss={() => dismiss(null)} />
        </div>
      )}
      {groups.map((g) => (
        <section key={g.name} className="scard" aria-label={g.name}>
          <h2 className="scard-head kgroup-head">
            <span>{g.name}</span>
            <span className="srow-hint">{`${g.rows.length} ${g.rows.length === 1 ? "shortcut" : "shortcuts"}`}</span>
          </h2>
          {g.rows.map((id) =>
            isFold(id) ? (
              <div key={id} className="krow">
                <span className="krow-title">
                  <span>{FOLDS[id].title}</span>
                  <span className="srow-hint">{FOLDS[id].hint}</span>
                </span>
                <span className="krow-scope">App</span>
                <span className="krow-keys">
                  <Kbd keys={FOLDS[id].keys} />
                </span>
                <span className="krow-actions keep">
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => {
                      setUnfolded((u) => new Set(u).add(id));
                      focusTo.current = { row: foldMembers(id)[0], order: [] };
                    }}
                  >
                    Show 9
                  </button>
                </span>
              </div>
            ) : (
              commandRow(commandById(id)!)
            ),
          )}
        </section>
      ))}
      {groups.length === 0 && (
        <p className="settings-note muted">
          No shortcut matches.{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            Clear the search
          </button>
        </p>
      )}
      <p className="settings-note muted">
        {platform() === "windows"
          ? "Keys Windows keeps for itself, like Alt+F4 and Win+L, cannot be used."
          : "Keys the system keeps for itself, like Alt+F4, cannot be used."}
      </p>
    </>
  );
}
