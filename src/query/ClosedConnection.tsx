import type { KeyboardEvent } from "react";
import type { ConnectionConfig } from "../api/types";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { durationText } from "../format/units";

export interface OpenFailure {
  /** What went wrong, in a sentence. */
  reason: string;
  /** What the server or driver said, shown as it came. */
  server: string | null;
}

interface Props {
  state: "closed" | "connecting" | "failed";
  connection: ConnectionConfig;
  /** How long the open has been running, while connecting. */
  elapsedMs: number;
  error: OpenFailure | null;
  production?: boolean;
  /** A cancelled open has not settled yet, so opening again waits. */
  stopping?: boolean;
  onOpen(): void;
  onCancel(): void;
  onEdit(): void;
}

const seconds = (ms: number) => (ms < 60_000 ? `${Math.floor(ms / 1000)}s` : durationText(ms));

/** The result area of a query tab whose Connection is not open: what to do, and what is happening (frame 10). */
export default function ClosedConnection({ state, connection, elapsedMs, error, production = false, stopping = false, onOpen, onCancel, onEdit }: Props) {
  const target = connection.dialect === "sqlite" ? (connection.file ?? connection.name) : `${connection.host}:${connection.port}`;

  // Keys act while the region has focus; the editor keeps Enter and Escape for itself.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target instanceof HTMLButtonElement) return;
    if (e.key === "Enter" && state !== "connecting" && !stopping) {
      e.preventDefault();
      onOpen();
    } else if (e.key === "Escape" && state === "connecting") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div
      className={`closed-connection${production ? " prod-wash" : ""}`}
      role="group"
      aria-label="Connection state"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {state === "closed" && (
        <>
          <Icon name="plug" size={20} />
          <h3>Open the Connection to run this query</h3>
          <p>{connection.name} is closed. Opening it connects and reads the schema. Nothing runs until you press Run.</p>
          <button type="button" className="button button-primary" disabled={stopping} onClick={onOpen}>
            <Icon name="plug" size={14} />
            {stopping ? "Stopping..." : <>Open {connection.name} <Kbd keys="Enter" /></>}
          </button>
        </>
      )}
      {state === "connecting" && (
        <>
          <Icon name="plug" size={20} />
          <h3>Connecting to {connection.name}...</h3>
          <p>
            {target}, {seconds(elapsedMs)} so far. The query runs only when you press Run.
          </p>
          <button type="button" className="button" onClick={onCancel}>
            Cancel <Kbd keys="Esc" />
          </button>
        </>
      )}
      {state === "failed" && (
        <div role="alert" className="closed-connection-failed">
          <span className="closed-connection-bad">
            <Icon name="alert" size={20} />
          </span>
          <h3>Could not open {connection.name}</h3>
          {error && <p>{error.reason}</p>}
          {error?.server && <pre className="closed-connection-server">{error.server}</pre>}
          <div className="closed-connection-actions">
            <button type="button" className="button button-primary" onClick={onOpen}>
              <Icon name="refresh" size={14} />
              Try again <Kbd keys="Enter" />
            </button>
            <button type="button" className="button" onClick={onEdit}>
              <Icon name="edit" size={14} />
              Edit Connection...
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
