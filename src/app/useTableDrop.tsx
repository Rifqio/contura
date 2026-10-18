import { type ReactNode, useRef, useState } from "react";
import { applyDesign, confirmDesign, errorText, planDesign, tableDesign } from "../api/client";
import type { ConnectionConfig, ConnectionId, DesignRequest, DesignVerdict, Group, ObjectPath, RunVerdict } from "../api/types";
import { useToast } from "../components/Toast";
import ConfirmDrop from "../design/ConfirmDrop";
import { warningText } from "../design/warnings";
import { objectKey } from "../objectPath";
import ConfirmRun from "../query/ConfirmRun";
import { designKey } from "../shell/tabs";

type Ask = Extract<RunVerdict, { kind: "needsConfirmation" }>;

interface DropAsk {
  connection: ConnectionConfig;
  path: ObjectPath;
  request: DesignRequest;
  plan: DesignVerdict;
  /** Planned again after an expired pass; a second refusal is shown, not asked again. */
  replanned: boolean;
  busy: boolean;
}

/**
 * Drop table from the tree or the designer strip (D7, D11): asks about the table's tabs first,
 * plans the drop, then asks with ConfirmDrop (plain) or ConfirmRun (Production). Read-only refuses.
 */
export function useTableDrop(opts: {
  connections: ConnectionConfig[];
  groups: Group[];
  confirmLeave(keys: string[]): Promise<boolean>;
  /** The drop ran: close the table's tabs and reload what shows it. */
  onDropped(connectionId: ConnectionId, path: ObjectPath): void;
}): { drop(connectionId: ConnectionId, path: ObjectPath): Promise<void>; dialog: ReactNode } {
  const [ask, setAsk] = useState<DropAsk | null>(null);
  const running = useRef(false);
  const { show: showToast } = useToast();

  const readOnlyToast = (c: ConnectionConfig) =>
    showToast({ kind: "readOnly", text: `${c.name} is Read-only. Changes are not allowed.` });

  function fail(c: ConnectionConfig, e: unknown) {
    const kind = (e as { kind?: string })?.kind;
    if (kind === "readOnly" || kind === "readOnlyRefused") readOnlyToast(c);
    else showToast({ kind: "error", text: errorText(e, c.dialect) });
  }

  function finish() {
    running.current = false;
    setAsk(null);
  }

  /** Plans the drop and asks; resolves once the ask is open, or with nothing to ask. */
  async function plan(c: ConnectionConfig, path: ObjectPath, request: DesignRequest, replanned: boolean) {
    const p = await planDesign(c.id, request);
    if (p.verdict.kind === "readOnly") {
      readOnlyToast(c);
      finish();
      return;
    }
    setAsk({ connection: c, path, request, plan: p, replanned, busy: false });
  }

  async function drop(connectionId: ConnectionId, path: ObjectPath) {
    const c = opts.connections.find((x) => x.id === connectionId);
    if (!c || running.current) return;
    if (c.readOnly) {
      readOnlyToast(c);
      return;
    }
    running.current = true;
    // D11: Pending Edits or an unapplied design of this table are asked about before, never after.
    if (!(await opts.confirmLeave([objectKey(connectionId, "table", path), designKey(connectionId, path)]))) {
      running.current = false;
      return;
    }
    try {
      const base = await tableDesign(connectionId, path);
      await plan(c, path, { target: { kind: "drop", base }, edits: [] }, false);
    } catch (e) {
      fail(c, e);
      finish();
    }
  }

  async function send(a: DropAsk, pass: string | null) {
    try {
      await applyDesign(a.connection.id, a.request, pass);
      finish();
      opts.onDropped(a.connection.id, a.path);
      showToast({ kind: "success", text: `Dropped ${a.path.name}.` });
    } catch (e) {
      if ((e as { kind?: string })?.kind === "needsConfirmation" && !a.replanned) {
        try {
          await plan(a.connection, a.path, a.request, true);
        } catch (again) {
          fail(a.connection, again);
          finish();
        }
        return;
      }
      fail(a.connection, e);
      finish();
    }
  }

  function dropPlain(a: DropAsk) {
    setAsk({ ...a, busy: true });
    void send(a, null);
  }

  async function dropOnProduction(a: DropAsk) {
    setAsk({ ...a, busy: true });
    try {
      const pass = await confirmDesign(a.connection.id, a.request);
      await send(a, pass);
    } catch (e) {
      fail(a.connection, e);
      finish();
    }
  }

  const sql = ask ? ask.plan.plan.statements.join("\n\n") : "";
  const warnings = ask ? ask.plan.plan.warnings.map(warningText) : [];
  const group = ask?.connection.groupId ? (opts.groups.find((g) => g.id === ask.connection.groupId) ?? null) : null;
  let dialog: ReactNode = null;
  if (ask && ask.plan.verdict.kind === "needsConfirmation") {
    // Once Drop on Production is chosen the dialog closes while the drop runs.
    if (!ask.busy) {
      dialog = (
        <ConfirmRun
          verb="Drop"
          verdict={ask.plan.verdict as Ask}
          warnings={warnings}
          dialect={ask.connection.dialect}
          group={group}
          onRun={() => void dropOnProduction(ask)}
          onCancel={finish}
        />
      );
    }
  } else if (ask) {
    dialog = (
      <ConfirmDrop
        table={ask.path.name}
        dialect={ask.connection.dialect}
        warnings={warnings}
        sql={sql}
        busy={ask.busy}
        onDrop={() => dropPlain(ask)}
        onCancel={finish}
      />
    );
  }
  return { drop, dialog };
}
