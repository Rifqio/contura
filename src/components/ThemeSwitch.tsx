import { useRef } from "react";
import type { ThemeChoice } from "../api/types";
import Icon from "./Icon";
import Menu, { type MenuItem } from "./Menu";

const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Alucard" },
  { value: "dark", label: "Dracula" },
];

interface Props {
  value: ThemeChoice;
  onChange(c: ThemeChoice): void;
}

/** System, Alucard or Dracula, as a segmented radio group. Arrow keys move the choice. */
export default function ThemeSwitch({ value, onChange }: Props) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + CHOICES.length) % CHOICES.length;
    onChange(CHOICES[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label="Theme" className="theme-switch">
      {CHOICES.map((c, i) => {
        const on = c.value === value;
        return (
          <button
            key={c.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={on ? "theme-option theme-option-on" : "theme-option"}
            onClick={() => onChange(c.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

const MENU: { value: ThemeChoice; label: string }[] = [
  { value: "dark", label: "Dracula" },
  { value: "light", label: "Alucard" },
  { value: "system", label: "Follow Windows" },
];

/** The status bar's theme button (a sun) and its menu: Dracula, Alucard, Follow Windows. */
export function ThemeMenu({ value, onChange }: Props) {
  const items: MenuItem[] = MENU.map((m) => ({
    key: m.value,
    label: m.label,
    current: m.value === value,
    onSelect: () => onChange(m.value),
  }));
  return (
    <Menu
      label="Theme"
      align="end"
      compact
      items={items}
      trigger={(props) => (
        <button type="button" className="icon-button app-status-button" aria-label="Theme" title="Theme" {...props}>
          <Icon name="sun" size={14} />
        </button>
      )}
    />
  );
}
