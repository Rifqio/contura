// A diagram's file actions: Rename, Save a copy as... and Delete (to the Recycle Bin), and the step before a
// Replace. Each keeps an open tab right (ruling P19):
// - a rename writes the tab's last save through the close guard, holds its writes while the files move, then
//   swaps the tab to the new name in place;
// - a delete holds the tab's writes while the files go to the Recycle Bin; only then is the tab discarded and
//   closed, so a failed delete keeps the tab, its edits and the file;
// - Save a copy as copies what the open tab shows, so a failed save cannot make the copy stale;
// - before a Replace, the open tab is discarded and closed, so it can never write the old diagram back.
import { save } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { deleteDiagram, errorText, readDiagram, renameDiagram, saveDiagramCopy } from "../api/client";
import { revealInFolder } from "../api/jobs";
import Dialog from "../components/Dialog";
import { useToast } from "../components/Toast";
import { typedDiagramName } from "./diagramKinds";
import { flowEntry } from "./flowRegistry";
import { parseFlowLayout, serializeFlowLayout } from "./layout";
import { kindOfText } from "./useFlowDoc";

export interface DiagramFileActions {
  rename(name: string): void;
  saveCopy(name: string): Promise<void>;
  remove(name: string): void;
  /**
   * Before a write that replaces diagram `name`: its open tab is discarded and closed (no further writes), once a
   * write already on its way has landed, so it cannot land after the replace.
   */
  beforeReplace(name: string): Promise<void>;
  /** The Rename or Delete dialog while one is open, else null. */
  dialog: ReactNode;
}

interface Opts {
  /** The open tab's own name for diagram `name` (names are not case-sensitive), or null. */
  tabOf(name: string): string | null;
  /** The close guard for that tab: writes what is waiting, asks when that fails; false means the user kept it. */
  confirmClose(tab: string): Promise<boolean>;
  /** Removes the tab at once, without asking. */
  dropTab(tab: string): void;
  openTab(name: string): void;
  /** Puts diagram `to` in the place of tab `from`. */
  renameTab(from: string, to: string): void;
  /** The diagrams folder changed: Recent reloads. */
  onChanged(): void;
}

type Ask = { kind: "rename"; name: string } | { kind: "delete"; name: string };

function RenameDialog({ name, onClose, onRename }: { name: string; onClose(): void; onRename(to: string): Promise<string | null> }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const to = typedDiagramName(value);
  async function submit() {
    if (busy || to === "") return;
    if (to === name) return onClose();
    setBusy(true);
    setMessage(null);
    const failed = await onRename(to);
    setBusy(false);
    if (failed === null) onClose();
    else setMessage(failed);
  }
  return (
    <Dialog title={`Rename ${name}.flow`} icon="flow" size="confirm" onClose={onClose}>
      <div className="dialog-body diagram-rename">
        <label className="field">
          <span>Name</span>
          <input
            className="input mono"
            value={value}
            spellCheck={false}
            onChange={(e) => {
              setValue(e.target.value);
              setMessage(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void submit();
            }}
          />
        </label>
        {message && (
          <p className="error-text" role="alert">
            {message}
          </p>
        )}
      </div>
      <footer className="dialog-footer">
        <span className="spacer" />
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button button-primary" disabled={busy || to === ""} onClick={() => void submit()}>
          Rename
        </button>
      </footer>
    </Dialog>
  );
}

function DeleteDialog({ name, onClose, onDelete }: { name: string; onClose(): void; onDelete(): void }) {
  return (
    <Dialog title={`Move ${name}.flow to the Recycle Bin?`} icon="trash" size="confirm" onClose={onClose}>
      <p className="dialog-body">Its layout file goes with it. You can restore both from the Recycle Bin.</p>
      <footer className="dialog-footer">
        <span className="spacer" />
        <button type="button" className="button" data-autofocus="true" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button button-danger" onClick={onDelete}>
          Move to Recycle Bin
        </button>
      </footer>
    </Dialog>
  );
}

export function useDiagramFileActions(opts: Opts): DiagramFileActions {
  const toast = useToast();
  const [ask, setAsk] = useState<Ask | null>(null);
  // Read after each await: the tabs may have changed meanwhile.
  const o = useRef(opts);
  o.current = opts;

  async function renameTo(from: string, to: string): Promise<string | null> {
    const tab = o.current.tabOf(from);
    let release: (() => void) | undefined;
    if (tab) {
      // The tab's last save lands under the old name first; then nothing is written while the files move.
      if (!(await o.current.confirmClose(tab))) return null;
      const held = flowEntry(tab)?.hold?.({ readOnly: true });
      release = held;
      // A write already on its way lands under the old name before the files move (P24 M2).
      await held?.settled;
    }
    try {
      await renameDiagram(from, to);
    } catch (e) {
      if (tab) {
        if (flowEntry(tab)?.isDiscarded?.()) {
          // The user chose Discard at the guard: show the file as it is on disk.
          flushSync(() => o.current.dropTab(tab));
          o.current.openTab(tab);
        } else release?.();
      }
      return errorText(e);
    }
    if (tab) {
      flowEntry(tab)?.discard?.();
      o.current.renameTab(tab, to);
    }
    o.current.onChanged();
    return null;
  }

  async function removeNow(name: string) {
    setAsk(null);
    const tab = o.current.tabOf(name);
    // Nothing is written while the files go to the Recycle Bin.
    const release = tab ? flowEntry(tab)?.hold?.() : undefined;
    try {
      // A write already on its way lands first, so it cannot bring the file back after the delete.
      await release?.settled;
      await deleteDiagram(name);
    } catch (e) {
      // The file is still there: the tab keeps its edits and writes them again.
      release?.();
      toast.show({ kind: "error", text: errorText(e) });
      return;
    }
    if (tab) {
      flowEntry(tab)?.discard?.();
      o.current.dropTab(tab);
    }
    toast.show({ kind: "info", text: `Moved ${name}.flow to the Recycle Bin.` });
    o.current.onChanged();
  }

  async function saveCopy(name: string) {
    try {
      const tab = o.current.tabOf(name);
      // An open tab is copied as it shows (its save may be waiting or have failed); else the file.
      const shown = tab ? flowEntry(tab)?.snapshot?.() : null;
      const files = shown ?? (await readDiagram(name));
      const path = await save({ defaultPath: `${name}.flow`, filters: [{ name: "Diagram", extensions: ["flow"] }] });
      if (typeof path !== "string") return;
      const layout = files.layout ?? serializeFlowLayout(parseFlowLayout(null, kindOfText(files.text)));
      await saveDiagramCopy(files.text, layout, path);
      const file = path.split(/[\\/]/).pop() ?? path;
      toast.show({
        kind: "success",
        text: `Saved a copy as ${file}`,
        action: { label: "Open folder", run: () => void revealInFolder(path).catch(() => {}) },
      });
    } catch (e) {
      toast.show({ kind: "error", text: errorText(e) });
    }
  }

  async function beforeReplace(name: string) {
    const tab = o.current.tabOf(name);
    if (!tab) return;
    // A write already on its way lands first, so it cannot put the old diagram back over the new one (P24 M2).
    const release = flowEntry(tab)?.hold?.();
    await release?.settled;
    flowEntry(tab)?.discard?.();
    release?.();
    // Closed now, so the tab opened after the write is a new one that reads the new files.
    flushSync(() => o.current.dropTab(tab));
  }

  const dialog =
    ask?.kind === "rename" ? (
      <RenameDialog name={ask.name} onClose={() => setAsk(null)} onRename={(to) => renameTo(ask.name, to)} />
    ) : ask?.kind === "delete" ? (
      <DeleteDialog name={ask.name} onClose={() => setAsk(null)} onDelete={() => void removeNow(ask.name)} />
    ) : null;

  return {
    rename: (name) => setAsk({ kind: "rename", name }),
    remove: (name) => setAsk({ kind: "delete", name }),
    saveCopy,
    beforeReplace,
    dialog,
  };
}
