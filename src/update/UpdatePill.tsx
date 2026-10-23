import Icon from "../components/Icon";
import { useUpdates } from "./updateStore";

/** The status bar's "Update 1.0.1" once a check found a newer release; it opens Settings > Updates. */
export default function UpdatePill({ onOpen }: { onOpen(): void }) {
  const { status, phase } = useUpdates();
  const offer = status?.offer;
  if (!offer) return null;
  let text = `Update ${offer.version}`;
  if (phase.kind === "downloading" && phase.total) text = `Updating ${Math.floor((phase.done / phase.total) * 100)}%`;
  else if (phase.kind === "downloading") text = "Updating";
  else if (phase.kind === "restarting") text = "Restarting";
  return (
    <button type="button" className="update-pill" title={`Contura ${offer.version} is available`} onClick={onOpen}>
      <Icon name="arrowUp" size={14} />
      <span>{text}</span>
    </button>
  );
}
