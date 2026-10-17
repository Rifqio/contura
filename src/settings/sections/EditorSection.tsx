import { useEffect, useMemo, useState } from "react";
import type { EditorPrefs } from "../../api/types";
import Select from "../../components/Select";
import { usePrefs } from "../../prefs/usePrefs";
import * as fontDetect from "../fontDetect";
import { Row, type RowKey, Section, SwitchRow } from "./layout";

const ROW = {
  font: { label: "Font", terms: "family size line height JetBrains Mono Cascadia Mono Consolas" },
  ligatures: { label: "Ligatures" },
  brighter: { label: "Brighter comments", terms: "Dracula" },
} satisfies Record<string, RowKey>;
export const EDITOR_ROWS: readonly RowKey[] = Object.values(ROW);

/** JetBrains Mono ships with Contura; the others are offered only when Windows has them (D9, PR34). */
const BUNDLED = "JetBrains Mono";
const OPTIONAL = ["Cascadia Mono", "Consolas"];

const LIGATURES = ["!=", ">=", "<=", "->", "->>", "=>"];

interface NumberProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (n: number) => void;
}

/** A whole number that applies as soon as it is in range, and is pulled into range on leaving. */
function NumberField({ label, value, min, max, unit, onChange }: NumberProps) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const settle = () => {
    const n = Math.round(Number(text));
    const next = text.trim() === "" || !Number.isFinite(n) ? value : Math.min(max, Math.max(min, n));
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <span className="num-field">
      <input
        type="number"
        className="input mono"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isInteger(n) && n >= min && n <= max && n !== value) onChange(n);
        }}
        onBlur={settle}
        onKeyDown={(e) => e.key === "Enter" && settle()}
      />
      <span className="num-unit" aria-hidden="true">
        {unit}
      </span>
    </span>
  );
}

/** Settings, Editor: the editor font and how it draws (D9). Copied and sent SQL never changes. */
export default function EditorSection() {
  const { prefs, update } = usePrefs();
  const e = prefs.editor;
  const set = (patch: Partial<EditorPrefs>) => update({ editor: { ...prefs.editor, ...patch } });

  const families = useMemo(() => [BUNDLED, ...OPTIONAL.filter((f) => fontDetect.isInstalled(f))], []);
  // A stored family this PC no longer has stays listed, so the control never shows blank.
  const options = (families.includes(e.family) ? families : [...families, e.family]).map((f) => ({ value: f, label: f }));

  return (
    <Section id="editor" title="Editor" rows={EDITOR_ROWS}>
      <Row {...ROW.font}>
        <Select label="Font" value={e.family} options={options} onChange={(family) => set({ family })} mono className="srow-grow" />
        <NumberField label="Font size" min={11} max={20} value={e.size} unit="px" onChange={(size) => set({ size })} />
        <NumberField label="Line height" min={16} max={28} value={e.lineHeight} unit="lh" onChange={(lineHeight) => set({ lineHeight })} />
      </Row>
      <SwitchRow
        {...ROW.ligatures}
        checked={e.ligatures}
        onChange={(ligatures) => set({ ligatures })}
        hint="Only the drawing changes. Copied and sent SQL stays as typed."
      >
        <span className="lig-sample" aria-hidden="true">
          {LIGATURES.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </span>
      </SwitchRow>
      <SwitchRow
        {...ROW.brighter}
        checked={prefs.brighterComments}
        onChange={(brighterComments) => update({ brighterComments })}
        hint="Dracula comments are faint by design. This swaps in a brighter blue, 5.5 to 1."
        note={prefs.theme === "light" ? "Used in Dracula only." : undefined}
      />
    </Section>
  );
}
