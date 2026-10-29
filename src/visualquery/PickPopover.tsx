// The Pick popover (decision 2, 320 px): two or more Foreign Keys link the same cards; the user
// picks the one the Join uses, or "Both", which adds the table again under a second alias.
import type { KeyboardEvent } from "react";
import type { FkChoice } from "../api/types";
import Kbd from "../components/Kbd";
import { Popover } from "./JoinPopover";

export const PICK_POPOVER_WIDTH = 320;

/** A choice with the Foreign Key's constraint name when the schema has it. */
export type PickChoice = FkChoice & { keyName?: string | null };

export interface PickPopoverProps {
  left: string;
  right: string;
  choices: PickChoice[];
  alias2: string;
  onPick(i: number | "both"): void;
  onClose(): void;
  /** The "Pick" badge it opens beside; null centres it over the window. */
  anchor?: DOMRect | null;
  avoid?: DOMRect[];
  /** A problem the Core gave for this Join. */
  problem?: string | null;
  /** Where focus goes on close when what had it before is gone. */
  returnFocus?(): HTMLElement | null;
}

const TIMES = ["once", "twice", "three times"];

export function timesText(n: number): string {
  return TIMES[n - 1] ?? `${n} times`;
}

export default function PickPopover({ left, right, choices, alias2, onPick, onClose, anchor, avoid, problem, returnFocus }: PickPopoverProps) {
  const both = choices.length + 1;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
    const n = Number(e.key);
    if (n <= choices.length) {
      e.preventDefault();
      onPick(n - 1);
    } else if (n === both && choices.length >= 2) {
      e.preventDefault();
      onPick("both");
    }
  };
  return (
    <Popover
      label={`${left} links to ${right} ${timesText(choices.length)}`}
      width={PICK_POPOVER_WIDTH}
      anchor={anchor ?? null}
      avoid={avoid ?? []}
      className="vq-pick-popover"
      onKeyDown={onKey}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      <header className="vq-popover-head">
        <span className="vq-popover-title">
          {left} links to {right} {timesText(choices.length)}
        </span>
        <Kbd keys="Esc" />
      </header>
      <p className="vq-popover-caption">Pick the Foreign Key this Join uses. {right} stays out of the SQL until you pick.</p>
      {problem && <p className="vq-problem vq-popover-problem">{problem}</p>}
      <div className="vq-pick-list">
        {choices.map((c, i) => (
          <button key={`${c.name}:${i}`} type="button" className="vq-pick-choice" onClick={() => onPick(i)}>
            <span className="vq-pick-text">
              <span className="vq-pick-columns">{c.name}</span>
              {c.keyName && <span className="vq-pick-key">{c.keyName}</span>}
              {c.comment && <span className="vq-pick-comment">{c.comment}</span>}
            </span>
            <Kbd keys={String(i + 1)} />
          </button>
        ))}
        {choices.length >= 2 && (
          <button type="button" className="vq-pick-choice vq-pick-both" onClick={() => onPick("both")}>
            <span className="vq-pick-text">
              <span className="vq-pick-name">Both</span>
              <span className="vq-pick-comment">
                Adds {right} a second time as {alias2}
              </span>
            </span>
            <Kbd keys={String(both)} />
          </button>
        )}
      </div>
    </Popover>
  );
}
