// The label box on a flow just drawn (or a flow's label double-clicked): Enter keeps what was typed, Esc leaves
// the flow as it is (unlabelled when new), and clicking away keeps it, as in the motion design.
import { useRef } from "react";

interface Props {
  /** Where the box sits: the middle of the flow's middle run, in flow coordinates. */
  at: { x: number; y: number };
  initial?: string;
  /** `keep` false for Esc; the text as typed. */
  onDone(keep: boolean, text: string): void;
}

export default function LabelBox({ at, initial = "", onDone }: Props) {
  const done = useRef(false);
  const finish = (keep: boolean, text: string) => {
    if (done.current) return;
    done.current = true;
    onDone(keep, text);
  };
  return (
    <input
      className="flow-label-box nodrag nopan nowheel"
      style={{ left: `${at.x}px`, top: `${at.y}px` }}
      aria-label="Flow label"
      placeholder="Type a label, Enter to keep"
      defaultValue={initial}
      autoFocus
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true, e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false, e.currentTarget.value);
        }
      }}
      onBlur={(e) => finish(true, e.currentTarget.value)}
    />
  );
}
