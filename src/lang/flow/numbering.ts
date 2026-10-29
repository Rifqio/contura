// A sequence's message numbers: what `autonumber` lines make of the messages after them.
import type { FlowDoc } from "./model";

/** The largest number a message shows. */
export const AUTONUMBER_MAX = 999_999;

/** One entry per link: its number, or null when numbering is off there. Directives are not scoped by blocks. */
export function messageNumbers(doc: FlowDoc): (number | null)[] {
  const dirs = doc.autonumber ?? [];
  const out: (number | null)[] = [];
  let d = 0;
  let on = false;
  let next = 1;
  for (let i = 0; i < doc.links.length; i++) {
    for (; d < dirs.length && dirs[d].from <= i; d++) {
      if (dirs[d].off) on = false;
      else {
        on = true;
        if (dirs[d].start !== undefined) next = dirs[d].start!;
      }
    }
    out.push(on && next <= AUTONUMBER_MAX ? next++ : null);
  }
  return out;
}

/**
 * Whether the numbering toggle is pressed (Decision 3): any message is numbered, or, with no messages, the last
 * directive turns numbering on.
 */
export function numberingOn(doc: FlowDoc): boolean {
  if (doc.links.length) return messageNumbers(doc).some((n) => n !== null);
  return numberingOnAtEnd(doc);
}

/** Whether numbering is still on after the last line: the last directive is not `autonumber off`. */
export function numberingOnAtEnd(doc: FlowDoc): boolean {
  const dirs = doc.autonumber;
  return !!dirs?.length && !dirs[dirs.length - 1].off;
}
