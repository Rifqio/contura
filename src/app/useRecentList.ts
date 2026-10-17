import { useState } from "react";
import { connectionOpenedTimes, recentItems, recordRecent } from "../api/client";
import type { ConnectionId, RecentItem, RecentTarget } from "../api/types";

export function useRecentList(): {
  recent: RecentItem[];
  openedTimes: Record<ConnectionId, number>;
  /** Reads Recent and when each Connection last opened; failures leave both as they were. */
  load(): void;
  /** Puts an opened item at the top of Recent; a failure to record never stops the open. */
  record(target: RecentTarget, connectionId: ConnectionId | null): void;
} {
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [openedTimes, setOpenedTimes] = useState<Record<ConnectionId, number>>({});

  function load() {
    recentItems()
      .then(setRecent)
      .catch(() => {});
    connectionOpenedTimes()
      .then(setOpenedTimes)
      .catch(() => {});
  }

  function record(target: RecentTarget, connectionId: ConnectionId | null) {
    recordRecent(target, connectionId)
      .then(load)
      .catch(() => {});
  }

  return { recent, openedTimes, load, record };
}
