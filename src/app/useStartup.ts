import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, lastGroup, listConnections, listGroups } from "../api/client";
import type { ConnectionConfig, Group, GroupId } from "../api/types";
import type { Place } from "../shell/tabs";

export type Startup = { s: "loading" } | { s: "ready" } | { s: "failed"; message: string };

export interface StartData {
  groups: Group[];
  connections: ConnectionConfig[];
  first: Place;
}

// PR6: the last Group, else Ungrouped; Home opens without a last Group, or when the Group restores no tabs.
export function firstPlace(groups: Group[], last: GroupId | null): Place {
  return last && groups.some((x) => x.id === last) ? { kind: "group", groupId: last } : { kind: "ungrouped" };
}

export function useStartup(on: {
  /** The three startup reads answered: App sets groups, Connections, the place and the first tabs. */
  loaded(data: StartData): void;
  /** After every start, worked or not: Saved Queries and Recent (conveniences; the app works without them). */
  always(): void;
}): { startup: Startup; step: 0 | 1 | 2 | 3; startedAt: number; retry(): void } {
  const onRef = useRef(on);
  onRef.current = on;
  const [startup, setStartup] = useState<Startup>({ s: "loading" });
  /** How many of the startup reads are done, and when loading began, for the launch screen (D24). */
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const startedAt = useRef(Date.now());

  const start = useCallback(async () => {
    setStartup({ s: "loading" });
    setStep(0);
    startedAt.current = Date.now();
    const done = <T,>(p: Promise<T>) =>
      p.then((v) => {
        setStep((n) => Math.min(3, n + 1) as 0 | 1 | 2 | 3);
        return v;
      });
    try {
      const [g, c, last] = await Promise.all([done(listGroups()), done(listConnections()), done(lastGroup())]);
      onRef.current.loaded({ groups: g, connections: c, first: firstPlace(g, last) });
      setStartup({ s: "ready" });
    } catch (e) {
      setStartup({ s: "failed", message: errorText(e) });
    }
    onRef.current.always();
  }, []);

  useEffect(() => {
    start();
  }, [start]);

  return { startup, step, startedAt: startedAt.current, retry: start };
}
