import type { ConnectionConfig } from "../api/types";
import type { Place } from "../shell/tabs";

export const placeOf = (c: ConnectionConfig): Place => (c.groupId ? { kind: "group", groupId: c.groupId } : { kind: "ungrouped" });
