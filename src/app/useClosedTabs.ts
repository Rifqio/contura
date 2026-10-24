import { useRef, useState } from "react";
import { listDiagrams, listObjects } from "../api/client";
import type { ConnectionConfig, ConnectionId, ObjectKind, ObjectPath } from "../api/types";
import { type ClosedTab, closedLabel, closedTabOf, rememberClosed, reopenFrom } from "../shell/closedTabs";
import type { AnyTab } from "../shell/tabs";

interface Deps {
  connections: ConnectionConfig[];
  /** Shows a reopened tab. */
  open(c: ClosedTab): void;
  /** A short note for a tab that could not come back. */
  note(text: string): void;
}

/**
 * Reopen closed tab (S2, Edge's Ctrl+Shift+T): the last 20 tabs the user closed, kept by what they showed. A table is
 * read again when it comes back, a query keeps its text, a diagram reopens its file; one whose object is gone is
 * skipped with a note.
 */
export function useClosedTabs(deps: Deps) {
  const stack = useRef<ClosedTab[]>([]);
  const [count, setCount] = useState(0);
  const latest = useRef(deps);
  latest.current = deps;
  const busy = useRef(false);

  const set = (next: ClosedTab[]) => {
    stack.current = next;
    setCount(next.length);
  };

  /** Why a closed tab cannot be shown again, or null when it can. */
  async function check(c: ClosedTab): Promise<string | null> {
    const { connections } = latest.current;
    const label = closedLabel(c);
    const onObject = async (connectionId: ConnectionId, kind: ObjectKind, path: ObjectPath) => {
      if (!connections.some((x) => x.id === connectionId)) return `${label} was on a Connection that is gone`;
      // Only tables and views are looked up; for the rest the tab shows its own error if the object is gone.
      if (kind !== "table" && kind !== "view") return null;
      try {
        const there = (await listObjects(connectionId, path.database, path.schema)).some((o) => o.kind === kind && o.name === path.name);
        return there ? null : `${label} is gone`;
      } catch {
        // Not open or unreachable: the tab opens and says so itself.
        return null;
      }
    };
    switch (c.kind) {
      case "object":
        return onObject(c.selection.connectionId, c.selection.kind, c.selection.path);
      case "design":
      case "lineage":
        return onObject(c.connectionId, "table", c.path);
      case "flow": {
        try {
          const there = (await listDiagrams()).some((d) => d.name.toLowerCase() === c.name.toLowerCase());
          return there ? null : `${label} is gone`;
        } catch {
          return null;
        }
      }
      default:
        return null;
    }
  }

  return {
    /** How many closed tabs wait, for the tab menu's Reopen closed tab. */
    count,
    /** Remembers a tab the user just closed. */
    remember(tab: AnyTab) {
      const c = closedTabOf(tab);
      if (c) set(rememberClosed(stack.current, c));
    },
    /** A Group change takes the place's tabs, so what was closed in it goes too. */
    clear() {
      if (stack.current.length > 0) set([]);
    },
    async reopen() {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await reopenFrom(stack.current, check);
        set(r.stack);
        if (r.opened) latest.current.open(r.opened);
        if (r.skipped.length === 1) latest.current.note(`${r.skipped[0]}, so it was not reopened.`);
        else if (r.skipped.length > 1) latest.current.note(`${r.skipped.length} closed tabs are gone, so they were not reopened.`);
      } finally {
        busy.current = false;
      }
    },
  };
}
