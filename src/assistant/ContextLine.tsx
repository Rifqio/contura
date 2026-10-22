import type { ContextInfo } from "../api/types";
import Icon from "../components/Icon";
import { type ContextConnection, contextLineText } from "./contextText";

interface Props {
  info: ContextInfo | null;
  connection: ContextConnection | null;
  onResync(): void;
  /** Re-sync is running. */
  busy: boolean;
  /** Why the last Re-sync did not work; shown in place of the line's text. */
  error?: string | null;
  now?: number;
}

/** The Context line above the composer box (board 11.1): shown only when the AI Context needs attention. */
export default function ContextLine({ info, connection, onResync, busy, error = null, now = Date.now() }: Props) {
  const line = contextLineText(info, connection, now);
  if (!line) return null;
  return (
    <div className={line.tone === "warn" ? "ctxalert warnline" : "ctxalert"} role="status">
      <Icon name={line.icon} size={14} />
      <span className="ctxalert-text">{error ?? line.text}</span>
      {line.resync &&
        (busy ? (
          <span className="ctxalert-busy">Re-syncing...</span>
        ) : (
          <button type="button" className="link-button" onClick={onResync}>
            Re-sync
          </button>
        ))}
    </div>
  );
}
