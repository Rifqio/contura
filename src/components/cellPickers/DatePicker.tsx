import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import Icon from "../Icon";
import { addDays, addMonths, type Day, monthWeeks, sameDay, today, weekday } from "./temporal";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const asDate = (d: Day) => new Date(Date.UTC(d.y, d.m - 1, d.d));
const monthTitle = (d: Day) => asDate(d).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const dayName = (d: Day) =>
  asDate(d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export type PickHow = "click" | "enter" | "space";

interface Props {
  /** The day in the text box, or null when it has none the calendar can show. */
  value: Day | null;
  onPick(day: Day, how: PickHow): void;
}

/**
 * A month calendar (the date picker dialog pattern): arrows move a day or a week, PageUp and PageDown a month
 * (with Shift, a year), Home and End the week's ends, Enter or Space picks.
 */
export default function DatePicker({ value, onPick }: Props) {
  const [active, setActive] = useState<Day>(() => value ?? today());
  const grid = useRef<HTMLTableElement>(null);

  // The text box leads: a typed day becomes the calendar's.
  const typed = value ? `${value.y}-${value.m}-${value.d}` : "";
  useEffect(() => {
    if (value) setActive(value);
    // Keyed on the day's text so a new object for the same day does not move the calendar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  // Focus follows the active day while it is in the calendar.
  useEffect(() => {
    if (grid.current?.contains(document.activeElement)) grid.current.querySelector<HTMLElement>('td[tabindex="0"]')?.focus();
  }, [active]);

  function onKey(e: KeyboardEvent) {
    const moves: Record<string, () => Day> = {
      ArrowLeft: () => addDays(active, -1),
      ArrowRight: () => addDays(active, 1),
      ArrowUp: () => addDays(active, -7),
      ArrowDown: () => addDays(active, 7),
      PageUp: () => addMonths(active, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(active, e.shiftKey ? 12 : 1),
      Home: () => addDays(active, -weekday(active)),
      End: () => addDays(active, 6 - weekday(active)),
    };
    const move = moves[e.key];
    if (move && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setActive(move());
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick(active, e.key === "Enter" ? "enter" : "space");
    }
  }

  const title = monthTitle(active);
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="icon-button cal-step" tabIndex={-1} aria-label="Previous month" title="Previous month (PageUp)" onMouseDown={keep} onClick={() => setActive(addMonths(active, -1))}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <span className="cal-title" aria-live="polite">
          {title}
        </span>
        <button type="button" className="icon-button cal-step" tabIndex={-1} aria-label="Next month" title="Next month (PageDown)" onMouseDown={keep} onClick={() => setActive(addMonths(active, 1))}>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
      <table ref={grid} className="cal-grid" role="grid" aria-label={title} onKeyDown={onKey}>
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              <th key={w} scope="col" role="columnheader" abbr={w} aria-label={w}>
                {w.slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthWeeks(active.y, active.m).map((week, wi) => (
            <tr key={wi}>
              {week.map((n, di) => {
                if (n === null) return <td key={di} className="cal-blank" />;
                const d = { y: active.y, m: active.m, d: n };
                const on = sameDay(d, value);
                const now = sameDay(d, today());
                const isActive = n === active.d;
                return (
                  <td
                    key={di}
                    role="gridcell"
                    tabIndex={isActive ? 0 : -1}
                    data-picker-stop={isActive ? "" : undefined}
                    aria-selected={on}
                    aria-label={dayName(d)}
                    aria-current={now ? "date" : undefined}
                    className={["cal-day", on ? "cal-day-on" : "", now ? "cal-day-today" : ""].filter(Boolean).join(" ")}
                    onMouseDown={keep}
                    onClick={() => {
                      setActive(d);
                      onPick(d, "click");
                    }}
                  >
                    {n}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
