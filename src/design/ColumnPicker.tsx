import Icon from "../components/Icon";
import Select from "../components/Select";

interface Props {
  /** The picked columns, in key order. */
  value: string[];
  /** Every column that can be picked; the ones in `value` are left out of the list. */
  options: string[];
  onChange(v: string[]): void;
  label: string;
  disabled?: boolean;
}

/** An ordered pick of columns: a chip per column with its remove button, then a list of the rest. */
export default function ColumnPicker({ value, options, onChange, label, disabled }: Props) {
  const rest = options.filter((o) => !value.includes(o));
  return (
    <span className="column-picker" role="group" aria-label={label}>
      {value.map((name, i) => (
        <span key={`${i}-${name}`} className="chip column-picker-chip">
          <span className="column-picker-name">{name}</span>
          <button
            type="button"
            className="column-picker-remove"
            aria-label={`Remove ${name} from ${label}`}
            title={`Remove ${name}`}
            disabled={disabled}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <Icon name="close" size={14} />
          </button>
        </span>
      ))}
      <Select
        value=""
        options={[{ value: "", label: "Pick a column", disabled: true }, ...rest.map((o) => ({ value: o, label: o }))]}
        onChange={(v) => v !== "" && onChange([...value, v])}
        label={`Add a column to ${label}`}
        disabled={disabled || rest.length === 0}
        mono
        className="column-picker-add"
      />
    </span>
  );
}
