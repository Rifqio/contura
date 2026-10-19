// The feature bar under the title bar (item 16, frame Main option A): every main feature as a large icon with its
// name under it, in groups, so people learn where things are. Ask sits at the right end. Right-click the bar to hide
// the labels (the compact bar keeps the icons and their tooltips).
import { type ReactNode, useState } from "react";
import { PlacedMenu, type PlacedMenuState } from "../flow/DiagramMenu";
import FeatureIcon, { type FeatureIconName } from "./FeatureIcon";
import Icon from "./Icon";

export interface Feature {
  id: FeatureIconName;
  label: string;
  /** What it does, for the tooltip; the shortcut follows it. */
  tip: string;
  shortcut?: string | null;
  run?: () => void;
  /** Why it is off, in the tooltip (still focusable, DN 7). */
  disabledWhy?: string | null;
}

export interface FeatureBarProps {
  /** Groups of features, divided by a line. */
  groups: Feature[][];
  /** At the right end. */
  end?: Feature;
}

const LABELS_KEY = "contura.featureBar.labels";

/** The per-viewer choice, kept in this window's storage; a storage that throws leaves labels on. */
function readLabels(): boolean {
  try {
    return localStorage.getItem(LABELS_KEY) !== "off";
  } catch {
    return true;
  }
}
function writeLabels(on: boolean) {
  try {
    localStorage.setItem(LABELS_KEY, on ? "on" : "off");
  } catch {
    // Not kept: the bar still switches for this run.
  }
}

/** The tooltip line: what it does and its key, or why it is off. */
export function featureTip(f: Feature): string {
  if (f.disabledWhy) return `${f.label}: ${f.disabledWhy}`;
  return f.shortcut ? `${f.tip} (${f.shortcut})` : f.tip;
}

function FeatureButton({ f, labels }: { f: Feature; labels: boolean }) {
  const off = !!f.disabledWhy || !f.run;
  const tip = featureTip(f);
  return (
    <button
      type="button"
      className="feature-button"
      aria-label={f.label}
      aria-disabled={off || undefined}
      aria-keyshortcuts={f.shortcut ?? undefined}
      data-tip={tip}
      aria-description={tip}
      onClick={() => {
        if (!off) f.run?.();
      }}
    >
      <FeatureIcon name={f.id} size={labels ? 28 : 22} />
      {labels && <span className="feature-label">{f.label}</span>}
    </button>
  );
}

export default function FeatureBar({ groups, end }: FeatureBarProps) {
  const [labels, setLabels] = useState(readLabels);
  const [menu, setMenu] = useState<PlacedMenuState | null>(null);
  const toggle = () => {
    setLabels((on) => {
      writeLabels(!on);
      return !on;
    });
  };
  const items: ReactNode[] = groups.map((g, i) => (
    <div key={i} className="feature-group" role="group">
      {g.map((f) => (
        <FeatureButton key={f.id} f={f} labels={labels} />
      ))}
    </div>
  ));
  return (
    <div
      className={labels ? "feature-bar" : "feature-bar is-compact"}
      role="toolbar"
      aria-label="Features"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({
          x: e.clientX,
          y: e.clientY,
          label: "Feature bar",
          items: [{ key: "labels", label: "Show labels", checked: labels, icon: <Icon name="list" />, onSelect: toggle }],
        });
      }}
    >
      {items}
      <span className="spacer" />
      {end && <FeatureButton f={end} labels={labels} />}
      {menu && <PlacedMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
