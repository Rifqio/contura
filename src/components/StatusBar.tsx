import type { ReactNode } from "react";
import { DIALECT_LABEL } from "../api/client";
import type { ConnectionConfig, ThemeChoice } from "../api/types";
import { useFlowEntry } from "../flow/flowRegistry";
import DbMark from "./DbMark";
import Icon from "./Icon";
import { ThemeToggle } from "./ThemeSwitch";

/** What the left side says: each screen of the window has its own status. */
export type StatusScreen =
  | { kind: "home"; connections: number; open: number }
  | { kind: "settings"; dataFolder: string; version: string }
  | { kind: "schema"; fileName: string; appliedTo: string | null }
  | { kind: "flow"; name: string; fileName: string }
  | { kind: "workspace"; connection: ConnectionConfig | null; open: boolean; serverVersion: string | null };

interface Props {
  screen: StatusScreen;
  theme: ThemeChoice;
  onTheme(c: ThemeChoice): void;
  /** The running jobs item (D22), shown before the theme menu. */
  jobs?: ReactNode;
  /** Opens Settings from the gear beside the theme switch; `settingsKey` is its shortcut for the tooltip. */
  onSettings?: () => void;
  settingsKey?: string;
}

/** A diagram, as frames 6+.2 and 6+.3: the file, where you are typing, and its errors. */
function FlowStatus({ name, fileName }: { name: string; fileName: string }) {
  const entry = useFlowEntry(name);
  return (
    <>
      <span className="app-status-name">{fileName}</span>
      {entry?.line != null && entry.col != null && <span>{`Ln ${entry.line}, Col ${entry.col}`}</span>}
      {!!entry?.errors && <span>{`${entry.errors} ${entry.errors === 1 ? "problem" : "problems"}`}</span>}
    </>
  );
}

function Left({ screen }: { screen: StatusScreen }) {
  switch (screen.kind) {
    case "home":
      return (
        <>
          <span>{screen.connections === 0 ? "No Connections" : `${screen.connections} ${screen.connections === 1 ? "Connection" : "Connections"}`}</span>
          {screen.connections > 0 && <span>{screen.open} open</span>}
        </>
      );
    case "settings":
      return (
        <>
          <span>{screen.dataFolder}</span>
          <span>Contura {screen.version}</span>
        </>
      );
    case "schema":
      return (
        <>
          <span>Schema Model</span>
          <span className="app-status-name">{screen.fileName}</span>
          <span>{screen.appliedTo ? `Applied to ${screen.appliedTo}` : "Not applied to a Connection"}</span>
          <span>Layout saved beside the file</span>
        </>
      );
    case "flow":
      return <FlowStatus name={screen.name} fileName={screen.fileName} />;
    case "workspace": {
      const { connection, open, serverVersion } = screen;
      if (!connection) return <span>No Connection open</span>;
      const who = (
        <>
          <DbMark dialect={connection.dialect} open={open} size={14} label={null} />
          <span className="app-status-name">{connection.name}</span>
          {connection.readOnly && (
            <span className="app-status-readonly">
              <Icon name="lock" size={14} />
              Read-only
            </span>
          )}
          {/* Frames 10a to 10c: a closed, connecting or failed Connection says Closed in the version's place. */}
          {!open ? <span>Closed</span> : serverVersion && <span>{`${DIALECT_LABEL[connection.dialect]} ${serverVersion}`}</span>}
        </>
      );
      return connection.production ? (
        <span className="app-status-prod">
          <span className="app-status-prod-label">PRODUCTION</span>
          {who}
        </span>
      ) : (
        <span className="app-status-conn">{who}</span>
      );
    }
  }
}

/**
 * The window's status bar. A visible query or table tab renders its own status (rows, time, position or
 * Pending Edits) into `#app-status-slot`.
 */
export default function StatusBar({ screen, theme, onTheme, jobs, onSettings, settingsKey }: Props) {
  const settingsLabel = settingsKey ? `Settings (${settingsKey})` : "Settings";
  return (
    <footer className="app-status" role="status">
      <Left screen={screen} />
      {/* The query status (Ln, Col changes on every key) is not announced; the left segment is. */}
      <span id="app-status-slot" className="app-status-slot" aria-live="off" />
      <span className="spacer" />
      {jobs}
      <span>UTF-8</span>
      {onSettings && (
        <button type="button" className="icon-button app-status-button" aria-label={settingsLabel} title={settingsLabel} onClick={onSettings}>
          <Icon name="gear" size={14} />
        </button>
      )}
      <ThemeToggle value={theme} onChange={onTheme} />
    </footer>
  );
}
