// The board Ask's chips (Plan D Decision 7, Copilot Chat's references and Slack's chip input): the frame chip, which
// follows the selected frame while it is automatic; frames added by hand; a selection chip; the "create" chip of a
// kind card; and the chip of an attached file. Chips are focus, never a lock: the AI reads the whole board.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SlashCommand } from "../../assistant/slash";
import Icon from "../../components/Icon";
import type { DiagramKind } from "../../lang/flow/model";
import { CARDS, DIAGRAM_KIND_WORD } from "../diagramKinds";

export type AskChip =
  | { kind: "frame"; title: string; index: number; auto: boolean }
  | { kind: "selection"; count: number }
  | { kind: "create"; diagram: DiagramKind }
  | { kind: "file"; name: string; token: string };

/** The most references one question holds. */
export const MAX_CHIPS = 8;

/** Why a ninth chip is not added. */
export const CHIPS_FULL = `A question holds at most ${MAX_CHIPS} references.`;

/** A chip in words: the kind word and title of a frame, "3 selected", "New Sequence", a file's name. */
export function chipLabel(chip: AskChip, kindOf?: DiagramKind | null): string {
  switch (chip.kind) {
    case "frame":
      return kindOf ? `${DIAGRAM_KIND_WORD[kindOf]} ${chip.title}` : chip.title;
    case "selection":
      return `${chip.count} selected`;
    case "create":
      return `New ${CARDS[chip.diagram].title}`;
    case "file":
      return chip.name;
  }
}

/** A frame of the board as the chips see it. `key` is its layout key; `clash` says another frame has its title. */
export type BoardFrame = { title: string; kind: DiagramKind | null; clash?: boolean; key?: string };

/** Why a frame whose title another frame has cannot be added by hand: the Ask names frames by title. */
export const CLASH_REASON = "Two frames share this title. Rename one to refer to it.";

/**
 * The `/` list's rows for the frames whose title holds `typed` (any case), those it starts first; `name` is the
 * frame's place in `frames`. A clashing frame shows its place in its label, so rows never read alike.
 */
export function frameRefs(frames: readonly BoardFrame[], typed: string): SlashCommand[] {
  const t = typed.toLowerCase();
  const rows = frames.flatMap((f, i) => {
    const at = f.title.toLowerCase().indexOf(t);
    if (at < 0) return [];
    const kind = f.kind ? DIAGRAM_KIND_WORD[f.kind] : "Diagram";
    return [{ at, row: { name: String(i), label: f.clash ? `${f.title}, frame ${i + 1}` : f.title, hint: kind } }];
  });
  // Array sort is stable: frames keep board order within each group.
  return rows.sort((a, b) => Number(a.at > 0) - Number(b.at > 0)).map((r) => r.row);
}

type HandChip = Exclude<AskChip, { kind: "selection" }>;

export interface AskChipsApi {
  chips: AskChip[];
  /** Adds a frame chip by hand; the refusal note past the cap, else null. A frame already chipped adds nothing. */
  addFrame(title: string, index: number): string | null;
  addCreate(kind: DiagramKind): void;
  addFile(f: { name: string; token: string }): void;
  /** Takes off the create chip of `create` and the file chip of `attachment`: an Ask sent them, or the file is gone. A chip picked since stays. */
  drop(sent: { create: DiagramKind | null; attachment: string | null }): void;
  remove(i: number): void;
  popLast(): void;
  /** The frame chips' titles in chip order: the request's focus. */
  focus(): string[];
  /** The selection chip was removed: the request leaves the selected shapes and sketches out until the selection changes. */
  selectionOff: boolean;
  /** The last refusal or loss, for the status line under the box; null when there is none. */
  note: string | null;
  clearNote(): void;
}

/**
 * The composer's chips. The selected frame is an automatic chip while it is not chipped by hand and was not removed;
 * the selection is a chip while something is selected. A removed automatic chip stays away until another frame is
 * selected (or none), a removed selection chip until the selection (`selectionKey`, its ids) changes. Hand chips stay,
 * by title: with `frames` each is found again by its title, and one whose frame is gone, renamed or no longer alone
 * with its title is dropped with a note, so a chip is never shown that the Ask would not name.
 */
export function useAskChips(selectedFrame: { title: string; index: number; key?: string } | null, selection: number, frames?: readonly BoardFrame[], selectionKey: string = String(selection)): AskChipsApi {
  const [hand, setHand] = useState<HandChip[]>([]);
  const [gone, setGone] = useState<{ frame: string | null; selection: string | null }>({ frame: null, selection: null });
  const [note, setNote] = useState<string | null>(null);
  const frameKey = selectedFrame ? (selectedFrame.key ?? `${selectedFrame.index}\u0000${selectedFrame.title}`) : null;
  const known = frames && frames.length > 0 ? frames : null;
  const nameable = useCallback((title: string) => !known || known.some((f) => f.title === title && !f.clash), [known]);

  // A frame deselected or another selected gives back the removed chips.
  useEffect(() => {
    setGone((g) => (g.frame !== null && g.frame !== frameKey ? { ...g, frame: null } : g));
  }, [frameKey]);
  useEffect(() => {
    setGone((g) => (g.selection !== null && (selection === 0 || g.selection !== selectionKey) ? { ...g, selection: null } : g));
  }, [selection, selectionKey]);

  // A hand chip whose title is no longer a frame's of its own goes, and says so.
  useEffect(() => {
    if (!known) return;
    const lost = hand.filter((c) => c.kind === "frame" && !nameable(c.title));
    if (lost.length === 0) return;
    setHand((h) => h.filter((c) => !lost.includes(c)));
    setNote(lost.map((c) => `${(c as { title: string }).title} is no longer on the board.`).join(" "));
  }, [hand, known, nameable]);

  const chips = useMemo<AskChip[]>(() => {
    const out: AskChip[] = [];
    const handed = selectedFrame !== null && hand.some((c) => c.kind === "frame" && c.title === selectedFrame.title);
    if (selectedFrame && !handed && gone.frame !== frameKey && nameable(selectedFrame.title)) out.push({ kind: "frame", title: selectedFrame.title, index: selectedFrame.index, auto: true });
    // Each hand chip at its frame's place now.
    for (const c of hand) {
      if (c.kind !== "frame") out.push(c);
      else if (nameable(c.title)) out.push(known ? { ...c, index: Math.max(known.findIndex((f) => f.title === c.title && !f.clash), 0) } : c);
    }
    if (selection > 0 && gone.selection !== selectionKey) out.push({ kind: "selection", count: selection });
    return out;
  }, [hand, selectedFrame, frameKey, selection, selectionKey, gone, nameable, known]);

  const addFrame = useCallback(
    (title: string, index: number): string | null => {
      if (!nameable(title)) return null;
      if (chips.some((c) => c.kind === "frame" && c.title === title)) {
        // The automatic chip of that frame becomes a hand chip, which stays when the selection moves on.
        if (chips.some((c) => c.kind === "frame" && c.auto && c.title === title)) setHand((h) => [...h, { kind: "frame", title, index, auto: false }]);
        return null;
      }
      if (chips.length >= MAX_CHIPS) {
        setNote(CHIPS_FULL);
        return CHIPS_FULL;
      }
      setHand((h) => [...h, { kind: "frame", title, index, auto: false }]);
      return null;
    },
    [chips, nameable],
  );

  // One create chip and one file chip at a time: a new one takes the old one's place.
  const addCreate = useCallback((diagram: DiagramKind) => setHand((h) => [...h.filter((c) => c.kind !== "create"), { kind: "create", diagram }]), []);
  const addFile = useCallback((f: { name: string; token: string }) => setHand((h) => [...h.filter((c) => c.kind !== "file"), { kind: "file", ...f }]), []);

  const drop = useCallback(
    (sent: { create: DiagramKind | null; attachment: string | null }) =>
      setHand((h) => {
        const left = h.filter((c) => !(c.kind === "create" && c.diagram === sent.create) && !(c.kind === "file" && c.token === sent.attachment));
        return left.length === h.length ? h : left;
      }),
    [],
  );

  const remove = useCallback(
    (i: number) => {
      const c = chips[i];
      if (!c) return;
      if (c.kind === "frame" && c.auto) setGone((g) => ({ ...g, frame: frameKey }));
      else if (c.kind === "selection") setGone((g) => ({ ...g, selection: selectionKey }));
      else setHand((h) => h.filter((x) => !(x.kind === c.kind && (c.kind !== "frame" || (x as { title: string }).title === c.title))));
    },
    [chips, frameKey, selectionKey],
  );
  const popLast = useCallback(() => remove(chips.length - 1), [chips.length, remove]);

  const focus = useCallback(() => chips.flatMap((c) => (c.kind === "frame" ? [c.title] : [])).filter((t, i, all) => all.indexOf(t) === i), [chips]);
  const clearNote = useCallback(() => setNote(null), []);
  const selectionOff = selection > 0 && gone.selection === selectionKey;

  return { chips, addFrame, addCreate, addFile, drop, remove, popLast, focus, selectionOff, note, clearNote };
}

interface Props {
  chips: readonly AskChip[];
  onRemove(i: number): void;
  /** A frame chip's kind, for its word; none reads as the title alone. */
  kindOf?(chip: Extract<AskChip, { kind: "frame" }>): DiagramKind | null;
}

/** The chips above the box: each a label with its remove button (Slack's and Linear's pills). */
export default function AskChips({ chips, onRemove, kindOf }: Props) {
  if (chips.length === 0) return null;
  return (
    <ul className="ask-chips" aria-label="References for this question">
      {chips.map((c, i) => {
        const label = chipLabel(c, c.kind === "frame" ? (kindOf?.(c) ?? null) : null);
        return (
          <li key={`${c.kind}:${label}:${i}`} className={`ask-chip ask-chip-${c.kind}`}>
            <span className="ask-chip-label">{label}</span>
            <button type="button" className="ask-chip-x" aria-label={`Remove ${label}`} onClick={() => onRemove(i)}>
              <Icon name="close" size={14} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
