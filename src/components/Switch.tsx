import { useId } from "react";

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** A short remark beside the label, such as why the switch is disabled. */
  note?: string;
}

export default function Switch({ checked, onChange, label, hint, disabled = false, note }: Props) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const noteId = `${id}-note`;
  const describedBy = [note ? noteId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={disabled ? "sw-row dim" : "sw-row"}>
      <button
        type="button"
        role="switch"
        className={checked ? (disabled ? "sw on overridden" : "sw on") : "sw"}
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
      <span className="sw-label">
        <span id={labelId}>{label}</span>
        {note && (
          <span id={noteId} className="over">
            {note}
          </span>
        )}
      </span>
      {hint && (
        <span id={hintId} className="sw-desc">
          {hint}
        </span>
      )}
    </div>
  );
}
