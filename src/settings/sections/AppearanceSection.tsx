import { useEffect, useId, useState } from "react";
import { INTERFACE_SIZES, type InterfaceSize, type NullDisplay, type RowHeight, type ThemeChoice } from "../../api/types";
import Icon from "../../components/Icon";
import Segmented, { type SegmentedOption } from "../../components/Segmented";
import { platform } from "../../platform";
import { NULL_TEXT } from "../../prefs/gridDisplay";
import { usePrefs } from "../../prefs/usePrefs";
import { Card, Row, SwitchRow, defineRows, useFlashClass } from "./layout";

const ROW = defineRows({
  theme: { label: "Theme", terms: "Dark Light Follow the system Windows Dracula Alucard preview", card: "Theme" },
  rowHeight: { label: "Row height", terms: "density compact grid", card: "Data grids" },
  stripeRows: { label: "Stripe every other row", terms: "zebra stripes alternate rows shade grid", card: "Data grids" },
  nullAs: { label: "Show NULL as", terms: "null empty value blank symbol grid", card: "Data grids" },
  interfaceSize: { label: "Interface size", terms: "zoom scale text size bigger smaller window", card: "Window" },
});
export const APPEARANCE_ROWS = Object.values(ROW);

/** P11-38: the board's "Follow Windows" on Windows, "Follow the system" elsewhere. */
const followName = () => (platform() === "windows" ? "Follow Windows" : "Follow the system");
const systemName = () => (platform() === "windows" ? "Windows" : "the system");

// Item 15: Dark and Light by name; the palettes (Dracula, Alucard) stay only as search words.
const themes = (): { value: ThemeChoice; name: string; draws: ("dark" | "light")[] }[] => [
  { value: "dark", name: "Dark", draws: ["dark"] },
  { value: "light", name: "Light", draws: ["light"] },
  { value: "system", name: followName(), draws: ["light", "dark"] },
];

const DARK_QUERY = "(prefers-color-scheme: dark)";
const systemIsDark = () => typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;

/** Whether the system is dark now, followed while the page shows, so the system card's "Now" stays true. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(systemIsDark);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: { matches: boolean }) => setDark(e.matches);
    setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/** The card's sample, drawn with the theme's own syntax tokens. */
function Sample() {
  return (
    <pre className="theme-preview-code">
      <span className="tp-comment">-- late orders</span>
      {"\n"}
      <span className="tp-keyword">SELECT</span> <span className="tp-function">count</span>(*)
      {"\n"}
      <span className="tp-keyword">FROM</span> orders <span className="tp-keyword">WHERE</span>
      {"\n  "}total &gt;= <span className="tp-number">100</span>
    </pre>
  );
}

/** Made-up rows for the preview; the empty shipped dates show how NULL reads. */
const ROWS: [string, string, string, string | null][] = [
  ["1041", "Ada Lovelace", "312.00", "2026-10-21"],
  ["1042", "Grace Hopper", "128.50", null],
  ["1043", "Alan Turing", "940.10", "2026-10-22"],
  ["1044", "Edsger Dijkstra", "105.00", null],
  ["1045", "Barbara Liskov", "233.75", "2026-10-23"],
  ["1046", "Ken Thompson", "410.00", "2026-10-23"],
];

/** The board's NULL choices: the segment shows the drawing itself, the screen reader hears its name. */
const NULL_OPTIONS: SegmentedOption<NullDisplay>[] = [
  { value: "null", label: "NULL" },
  { value: "symbol", label: NULL_TEXT.symbol, ariaLabel: "Empty set sign" },
  { value: "blank", label: "blank" },
];

interface PreviewProps {
  theme: "dark" | "light";
  rowHeight: RowHeight;
  stripes: boolean;
  nullAs: NullDisplay;
}

/**
 * A small window drawn with the theme's own tokens, the chosen row height, stripes and NULL. The interface size
 * zooms the whole window, this preview with it.
 */
function Preview({ theme, rowHeight, stripes, nullAs }: PreviewProps) {
  // Scaled down with the rest of the preview, so 24 and 28 px rows still differ.
  const rowPx = Math.round(rowHeight * 0.78);
  return (
    <div className={`theme-${theme} spv`} data-preview-theme={theme} aria-hidden="true">
      <div className="spv-tabs">
        <span className="spv-tab">Home</span>
        <span className="spv-tab on">late orders.sql</span>
        <span className="spv-tab">customers</span>
      </div>
      <div className="spv-body">
        <div className="spv-tree">
          <span className="spv-muted">shop</span>
          <span className="spv-item">customers</span>
          <span className="spv-item on">orders</span>
          <span className="spv-item">products</span>
        </div>
        <div className="spv-main">
          <div className="spv-bar">
            <span className="spv-run">
              <Icon name="play" size={14} />
              Run
            </span>
            <span className="spv-muted">kestrel-main</span>
          </div>
          <div className="spv-code">
            <div>
              <span className="tp-keyword">SELECT</span> id, customer, total
            </div>
            <div>
              <span className="tp-keyword">FROM</span> orders <span className="tp-keyword">WHERE</span> total &gt;= <span className="tp-number">100</span>
            </div>
          </div>
          <div className="spv-grid">
            <div className="spv-row head" style={{ height: rowPx }}>
              <span>id</span>
              <span>customer</span>
              <span>total</span>
              <span>shipped</span>
            </div>
            {ROWS.map(([id, who, total, shipped], i) => (
              <div key={id} className={i === 2 ? "spv-row sel" : stripes && i % 2 === 1 ? "spv-row alt" : "spv-row"} style={{ height: rowPx }}>
                <span className="spv-muted">{id}</span>
                <span>{who}</span>
                <span className="spv-num">{total}</span>
                <span className={shipped === null ? "spv-null" : "spv-mono"}>{shipped ?? NULL_TEXT[nullAs]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Settings, Appearance (D8, ST3): the theme cards, the data grids, the interface size, and a preview of them. */
export default function AppearanceSection() {
  const { prefs, update } = usePrefs();
  const name = useId();
  const hintId = useId();
  const following = prefs.theme === "system";
  const systemDark = useSystemDark();
  const shown: "dark" | "light" = prefs.theme === "system" ? (systemDark ? "dark" : "light") : prefs.theme;
  const themeCls = useFlashClass(ROW.theme.id, "scard-body");
  return (
    <div className="ap">
      <div className="ap-theme">
        <Card title="Theme">
          <div className={themeCls} data-row={ROW.theme.id}>
            <div className="theme-cards" role="radiogroup" aria-label="Theme" aria-describedby={hintId}>
              {themes().map((t) => {
                const on = prefs.theme === t.value;
                return (
                  <label key={t.value} className={on ? "theme-card on" : "theme-card"}>
                    <span className={t.draws.length > 1 ? "theme-preview two" : "theme-preview"} aria-hidden="true">
                      {t.draws.map((d) => (
                        <span key={d} className={`theme-${d} theme-preview-pane`}>
                          <Sample />
                        </span>
                      ))}
                    </span>
                    <span className="theme-card-foot">
                      <input type="radio" className="radio" name={name} aria-label={t.name} checked={on} onChange={() => update({ theme: t.value })} />
                      <span className="theme-card-text">
                        <span>{t.name}</span>
                        {t.value === "system" && <span className="theme-card-sub">{`Now ${systemDark ? "dark" : "light"}`}</span>}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="srow-hint" id={hintId}>
              {`${followName()} uses Light when ${systemName()} is light and Dark when it is dark.`}
            </p>
          </div>
        </Card>
      </div>
      <div className="ap-rest">
        <Card title="Data grids">
          <Row {...ROW.rowHeight} hint="Every table grid and result.">
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
          <SwitchRow {...ROW.stripeRows} hint="Helps follow a wide row across the grid." checked={prefs.stripeRows} onChange={(on) => update({ stripeRows: on })} />
          <Row {...ROW.nullAs} hint="An empty value still reads differently from an empty string.">
            <Segmented<NullDisplay> label="Show NULL as" value={prefs.nullAs} options={NULL_OPTIONS} onChange={(v) => update({ nullAs: v })} />
          </Row>
        </Card>
        <Card title="Window">
          <Row {...ROW.interfaceSize} hint="Text and controls in every Contura window.">
            <Segmented<`${InterfaceSize}`>
              label="Interface size"
              value={String(prefs.interfaceSize) as `${InterfaceSize}`}
              options={INTERFACE_SIZES.map((z) => ({ value: String(z) as `${InterfaceSize}`, label: `${z}%` }))}
              onChange={(v) => update({ interfaceSize: Number(v) as InterfaceSize })}
            />
          </Row>
        </Card>
      </div>
      <figure className="ap-preview">
        <figcaption className="srow-hint">{following ? `Preview, following ${systemName()} (${shown})` : "Preview"}</figcaption>
        <Preview theme={shown} rowHeight={prefs.rowHeight} stripes={prefs.stripeRows} nullAs={prefs.nullAs} />
        <p className="srow-hint">
          Drawn with the real palette, row height, stripes and NULL, at the interface size. The accent stays purple: in Contura a colour always means the
          same thing.
        </p>
      </figure>
    </div>
  );
}
