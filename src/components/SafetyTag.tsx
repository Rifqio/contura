import type { ConnectionConfig } from "../api/types";
import Icon from "./Icon";

/** The Production and Read-only marks of a Connection; both show when both are set, `PROD` first. */
export default function SafetyTag({
  connection,
  small,
}: {
  connection: Pick<ConnectionConfig, "production" | "readOnly">;
  small?: boolean;
}) {
  const size = small ? " safety-tag-small" : "";
  if (!connection.production && !connection.readOnly) return null;
  return (
    <>
      {/* R8: the chip shows PROD; the spoken name keeps the word. */}
      {connection.production && (
        <span className={`safety-tag safety-tag-production${size}`}>
          <span aria-hidden="true">PROD</span>
          <span className="visually-hidden">Production</span>
        </span>
      )}
      {connection.readOnly && (
        <span className={`safety-tag safety-tag-readonly${size}`}>
          <Icon name="lock" size={14} />
          Read-only
        </span>
      )}
    </>
  );
}
