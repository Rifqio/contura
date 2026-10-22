import { errorText } from "../api/client";
import type { AiAccess, ContextInfo } from "../api/types";
import { agoText } from "../format/units";
import { tablesText } from "../settings/ai/providers";

/** The Connection an Ask is on, as the Context line and the Sends tip name it. */
export interface ContextConnection {
  name: string;
  access: AiAccess;
}

/** The Context line above the composer box (board 11.1, `.ctxalert`). */
export interface ContextLineText {
  tone: "warn" | "plain";
  icon: "alert" | "lock" | "database";
  text: string;
  /** Offers Re-sync. */
  resync: boolean;
}

/** The Connection as the Context names it: `<name>.<schema>` for a schema other than `public`. */
export function ctxName(connection: ContextConnection, info: ContextInfo | null): string {
  const schema = info?.schema ?? "";
  return schema !== "" && schema !== "public" ? `${connection.name}.${schema}` : connection.name;
}

/** "3m ago", "2d ago"; "just now" under a minute. */
const synced = (info: ContextInfo, now: number) => {
  const ms = now - (info.builtAt ?? now);
  return ms < 60_000 ? "just now" : agoText(ms);
};

/** The schema changed since the last sync: marked stale, or a check that found it so. */
const isStale = (info: ContextInfo) => info.stale || info.check.kind === "stale";

/**
 * The Context line, only when it needs attention: the schema changed (stale), the check failed, there is no Context
 * and none could be built, the Connection sends nothing (AI access Never), or the Context re-syncs only by hand, so
 * Re-sync is offered beside it (P11-10, board 11.1). Null otherwise, and with no Connection.
 */
export function contextLineText(
  info: ContextInfo | null,
  connection: ContextConnection | null,
  now: number,
): ContextLineText | null {
  if (!connection) return null;
  if (connection.access === "never") {
    return { tone: "plain", icon: "lock", text: "This Connection sends nothing. The assistant sees only your question.", resync: false };
  }
  if (!info) return null;
  const name = ctxName(connection, info);
  if (info.check.kind === "failed") {
    return { tone: "warn", icon: "alert", text: `Context: ${name} · could not check the schema`, resync: true };
  }
  if (info.check.kind === "missing") {
    return { tone: "warn", icon: "alert", text: `Context: ${name} · could not read the schema`, resync: true };
  }
  if (isStale(info)) {
    return { tone: "warn", icon: "alert", text: `Context: ${name} · the schema changed since the last sync`, resync: true };
  }
  if (info.sync !== "automatic") {
    const text =
      info.builtAt === null
        ? `Context: ${name} · not built yet`
        : `Context: ${name} · ${tablesText(info.tableCount)} · synced ${synced(info, now)}`;
    return { tone: "plain", icon: "database", text, resync: true };
  }
  return null;
}

/** The footer of the Sends list: what the AI Context is and how it stays current. */
export function contextTip(info: ContextInfo | null, connection: ContextConnection | null, now: number): string | null {
  if (!connection) return null;
  if (connection.access === "never") return `AI access on ${connection.name} is Never: only your question is sent.`;
  if (!info) return null;
  const name = ctxName(connection, info);
  if (info.builtAt === null) return `Context: ${name}, not built yet.`;
  if (isStale(info)) return "The schema changed since the last sync. Re-sync to refresh the context.";
  if (info.check.kind === "failed") {
    return `Context: ${name}, ${tablesText(info.tableCount)}. The schema could not be checked, so the last context is used.`;
  }
  const how =
    info.sync === "automatic" ? "It re-syncs on its own when the schema changes." : "It re-syncs only when you press Re-sync.";
  return `Context: ${name}, ${tablesText(info.tableCount)}, synced ${synced(info, now)}. ${how}`;
}

/**
 * "Context from 2d ago" in the Sends header, when the Context sent may be out of date (stale, or the check failed). A
 * failed check under a minute after the build reads "Context not checked", never "just now".
 */
export function sendsAge(info: ContextInfo | null, now: number): string | null {
  if (!info || info.builtAt === null) return null;
  const failed = info.check.kind === "failed" && !isStale(info);
  if (!isStale(info) && !failed) return null;
  if (failed && now - info.builtAt < 60_000) return "Context not checked";
  return `Context from ${synced(info, now)}`;
}

/** Above an answer whose schema check failed: "Could not check the schema. Using the context from 09:12." */
export function contextNotice(info: ContextInfo | null): string | null {
  if (!info || info.check.kind !== "failed" || info.builtAt === null) return null;
  return errorText({ kind: "ai", message: { kind: "contextUnavailable", builtAt: info.builtAt } });
}
