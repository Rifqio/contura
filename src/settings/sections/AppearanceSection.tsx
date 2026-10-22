import { useId } from "react";
import type { RowHeight, ThemeChoice } from "../../api/types";
import Segmented from "../../components/Segmented";
import { usePrefs } from "../../prefs/usePrefs";
import { Row, type RowKey, Section } from "./layout";

const ROW = {
  theme: { label: "Theme", terms: "Dark Light Follow the system Windows Dracula Alucard" },
  rowHeight: { label: "Row height", terms: "density compact" },
} satisfies Record<string, RowKey>;
export const APPEARANCE_ROWS: readonly RowKey[] = Object.values(ROW);

const THEMES: { value: ThemeChoice; name: string; sub: string; draws: ("dark" | "light")[] }[] = [
  // Item 15: Dark and Light by name; the palettes (Dracula, Alucard) stay only as search words.
  { value: "dark", name: "Dark", sub: "", draws: ["dark"] },
  { value: "light", name: "Light", sub: "", draws: ["light"] },
  { value: "system", name: "Follow the system", sub: "", draws: ["light", "dark"] },
];

/** The frame's sample, drawn with the theme's own syntax tokens. */
function Preview() {
  return (
    <pre className="theme-preview-code">
      <span className="tp-comment">-- late orders</span>
      {"\n"}
      <span className="tp-keyword">SELECT</span> <span className="tp-function">count</span>(*)
      {"\n"}
      <span className="tp-keyword">FROM</span> orders <span className="tp-keyword">WHERE</span> total &gt;={" "}
      <span className="tp-number">100</span>
    </pre>
  );
}

/** Settings, Appearance: the theme cards and the row height (D8, ST3). */
export default function AppearanceSection() {
  const { prefs, update } = usePrefs();
  const name = useId();
  return (
    <Section id="appearance" title="Appearance" rows={APPEARANCE_ROWS}>
      <Row {...ROW.theme} stacked hint="Follow the system uses Light when the system is light and Dark when it is dark.">
        {({ labelId, hintId }) => (
          <div className="theme-cards" role="radiogroup" aria-labelledby={labelId} aria-describedby={hintId}>
            {THEMES.map((t) => {
              const on = prefs.theme === t.value;
              return (
                <label key={t.value} className={on ? "theme-card on" : "theme-card"}>
                  <span className={t.draws.length > 1 ? "theme-preview two" : "theme-preview"} aria-hidden="true">
                    {t.draws.map((d) => (
                      <span key={d} className={`theme-${d} theme-preview-pane`}>
                        <Preview />
                      </span>
                    ))}
                  </span>
                  <span className="theme-card-foot">
                    <input
                      type="radio"
                      className="radio"
                      name={name}
                      aria-label={t.name}
                      checked={on}
                      onChange={() => update({ theme: t.value })}
                    />
                    <span>{t.name}</span>
                    {t.sub && <span className="theme-card-sub">{t.sub}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </Row>
      <Row {...ROW.rowHeight}>
        <Segmented<"28" | "24">
          label="Row height"
          value={String(prefs.rowHeight) as "28" | "24"}
          options={[
            { value: "28", label: "28 px" },
            { value: "24", label: "24 px, compact" },
          ]}
          onChange={(v) => update({ rowHeight: Number(v) as RowHeight })}
        />
      </Row>
    </Section>
  );
}
