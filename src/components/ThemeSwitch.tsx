import { useEffect, useRef, useState } from "react";
import type { ThemeChoice } from "../api/types";
import Icon from "./Icon";

const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

interface Props {
  value: ThemeChoice;
  onChange(c: ThemeChoice): void;
}

/** System, Light or Dark, as a segmented radio group. Arrow keys move the choice. */
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

/** Windows is in dark mode (or no preference is known: Dark is Contura's default). */
function systemDark(): boolean {
  try {
    const q = window.matchMedia?.("(prefers-color-scheme: light)");
    return !q?.matches;
  } catch {
    return true;
  }
}

/** The theme drawn now: the choice, or what Windows uses when the choice is to follow it. */
export function shownTheme(value: ThemeChoice, dark = systemDark()): "dark" | "light" {
  return value === "system" ? (dark ? "dark" : "light") : value;
}

/**
 * Item 15: the status bar's theme toggle, one icon. Dark (the default) shows a moon; a click switches to Light,
 * which shows a sun, and back. The themes are called Dark and Light, never by their palette names.
 */
export function ThemeToggle({ value, onChange }: Props) {
  const [dark, setDark] = useState(systemDark);
  useEffect(() => {
    if (value !== "system") return;
    let q: MediaQueryList | undefined;
    try {
      q = window.matchMedia?.("(prefers-color-scheme: light)");
    } catch {
      return;
    }
    const on = () => setDark(systemDark());
    q?.addEventListener?.("change", on);
    return () => q?.removeEventListener?.("change", on);
  }, [value]);
  const shown = shownTheme(value, dark);
  const label = shown === "dark" ? "Dark theme. Switch to Light" : "Light theme. Switch to Dark";
  return (
    <button
      type="button"
      className="icon-button app-status-button theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => onChange(shown === "dark" ? "light" : "dark")}
    >
      <Icon key={shown} name={shown === "dark" ? "moon" : "sun"} size={14} className="theme-toggle-icon" />
    </button>
  );
}
