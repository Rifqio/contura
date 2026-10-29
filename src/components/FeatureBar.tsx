// The feature bar under the title bar (item 16, frame Main option A): every main feature as a large icon with its
// name under it, in groups, so people learn where things are. Ask sits at the right end. Right-click the bar to hide
// the labels (the compact bar keeps the icons and their tooltips).
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { PlacedMenu, type PlacedMenuState } from "../flow/DiagramMenu";
import FeatureIcon, { type FeatureIconName } from "./FeatureIcon";
import Icon from "./Icon";
import Menu from "./Menu";

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

function FeatureButton({ f, labels, overflow = false }: { f: Feature; labels: boolean; overflow?: boolean }) {
  const off = !!f.disabledWhy || !f.run;
  const tip = featureTip(f);
  return (
    <button
      type="button"
      className="feature-button"
      data-feature-id={f.id}
      // Past the end of the groups' box it is listed under More instead.
      data-overflow={overflow || undefined}
      aria-hidden={overflow || undefined}
      tabIndex={overflow ? -1 : undefined}
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

/** The features whose button ends past the right edge of the groups' box; none while it is not laid out. */
function overflowing(box: HTMLElement): string[] {
  const width = box.clientWidth;
  if (width === 0) return [];
  return Array.from(box.querySelectorAll<HTMLElement>(".feature-button"))
    .filter((b) => b.offsetLeft + b.offsetWidth > width + 1)
    .map((b) => b.dataset.featureId ?? "");
}

export default function FeatureBar({ groups, end }: FeatureBarProps) {
  const [labels, setLabels] = useState(readLabels);
  const [menu, setMenu] = useState<PlacedMenuState | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<readonly string[]>([]);
  // Measured after every render (labels on or off change the widths) and on resize; a hidden button keeps its
  // place, so the measure does not move.
  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const next = overflowing(el);
    setHidden((was) => (was.length === next.length && was.every((id, i) => id === next[i]) ? was : next));
  }, []);
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [measure]);
  const more = groups.flat().filter((f) => hidden.includes(f.id));
  const toggle = () => {
    setLabels((on) => {
      writeLabels(!on);
      return !on;
    });
  };
  const items: ReactNode[] = groups.map((g, i) => (
    <div key={i} className="feature-group" role="group">
      {g.map((f) => (
        <FeatureButton key={f.id} f={f} labels={labels} overflow={hidden.includes(f.id)} />
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
      <div className="feature-groups" ref={box}>
        {items}
      </div>
      {more.length > 0 && (
        <Menu
          label="More features"
          align="end"
          trigger={(p) => (
            <button type="button" {...p} className="feature-button" aria-label="More features">
              <Icon name="moreHorizontal" size={20} />
              {labels && <span className="feature-label">More</span>}
            </button>
          )}
          items={more.map((f) => ({
            key: f.id,
            label: f.label,
            icon: <FeatureIcon name={f.id} size={16} />,
            shortcut: f.shortcut ?? undefined,
            disabled: !!f.disabledWhy || !f.run,
            title: f.disabledWhy ?? undefined,
            onSelect: () => f.run?.(),
          }))}
        />
      )}
      <span className="spacer" />
      {end && <FeatureButton f={end} labels={labels} />}
      {menu && <PlacedMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
