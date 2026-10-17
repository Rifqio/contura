import type { ConnectionConfig } from "../api/types";
import Icon from "./Icon";

/** The Production or Read-only mark of a Connection; Read-only wins when both are set. */
export default function SafetyTag({
  connection,
  small,
}: {
  connection: Pick<ConnectionConfig, "production" | "readOnly">;
  small?: boolean;
}) {
  const size = small ? " safety-tag-small" : "";
  if (connection.readOnly) {
    return (
      <span className={`safety-tag safety-tag-readonly${size}`}>
        <Icon name="lock" />
        Read-only
      </span>
    );
  }
  if (connection.production) return <span className={`safety-tag safety-tag-production${size}`}>Production</span>;
  return null;
}
