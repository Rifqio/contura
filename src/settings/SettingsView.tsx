import type { ConnectionConfig, GroupId } from "../api/types";
import Icon from "../components/Icon";
import AiSettingsForm from "./ai/AiSettingsForm";

interface Props {
  /** The open Group, so its settings can differ from the global ones; null when none is open. */
  groupId: GroupId | null;
  groupName: string | null;
  connections: ConnectionConfig[];
  onConnectionSaved: (saved: ConnectionConfig) => void;
  onClose: () => void;
}

export default function SettingsView({ groupId, groupName, connections, onConnectionSaved, onClose }: Props) {
  return (
    <div className="settings-view">
      <h1 className="visually-hidden">Settings</h1>
      <nav className="snav" aria-label="Settings sections">
        <span className="on" aria-current="page">
          <Icon name="settings" />
          AI assistant
        </span>
      </nav>
      <div className="settings-scroll">
        <AiSettingsForm
          groupId={groupId}
          groupName={groupName}
          connections={connections}
          onConnectionSaved={onConnectionSaved}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
