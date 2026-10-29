// The diagram assistant's changes as a card (board 11.5, review): one row per change with its mark and .flow
// line, Accept and Reject on each, and the footer that lands the accepted ones as one undo step. On a board of
// several diagrams the rows are grouped by frame in text order, new frames last, each group headed with its title, its
// count, Accept frame and Reject frame (Plan D Decision 12, GitHub's review grouped by file). Without the handlers it
// only shows the rows (a proposal from a reloaded thread). With a dropped change it says which, why and, on a board,
// in which diagram; the cards for the other error states of board 11.5 (changed on disk, unclear target, would break
// the text) are here too. No hover text: aria-labels only.
import type { KeyboardEvent } from "react";
import type { Candidate, ProposedChange } from "../../api/types";
import { changedBody, changedTitle } from "../../assistant/answerState";
import Icon from "../../components/Icon";
import Kbd from "../../components/Kbd";
import { plural } from "../../format/plural";
import type { DiagramKind } from "../../lang/flow/model";
import { changeFrame, changeLine, changeMark } from "./proposal";

interface Props {
  changes: ProposedChange[];
  kind: DiagramKind | null;
  /** The changes the user rejected; absent on a card that only shows. */
  rejected?: ReadonlySet<number>;
  onReject?(index: number): void;
  onAccept?(index: number): void;
  onRejectAll?(): void;
  onAcceptAll?(): void;
  onShowText?(): void;
  /** Asks again with what the checker dropped; given, the footer offers "Ask to fix it" beside "Accept <n>". */
  onAskFix?(messages: string[]): void;
  /** What the user did with it, for a card from a reloaded thread (`outcomeText`). */
  outcome?: string | null;
  /** The board's titles in text order: with more than one the rows group by frame. */
  frames?: readonly string[];
  /** Accept frame: every change in that frame, with what they need (Decision 12). */
  onAcceptFrame?(title: string): void;
  /** Reject frame: every change in that frame, with what depends on them. */
  onRejectFrame?(title: string): void;
}

const NO_TITLES: readonly string[] = [];

const MARK_CLASS = { "+": "add", "-": "del", "~": "mod", "!": "drop" } as const;

/** "4 changes", or "3 of 4 changes" when the checker dropped some. */
export function cardTitle(changes: ProposedChange[]): string {
  const ok = changes.filter((c) => c.status.kind === "ok").length;
  return ok === changes.length ? plural(changes.length, "change", "changes") : `${ok.toLocaleString("en-US")} of ${plural(changes.length, "change", "changes")}`;
}

/** "Accept all" while every change would land, else "Accept <k>". */
export function acceptLabel(changes: ProposedChange[], rejected: ReadonlySet<number>): string {
  const k = changes.filter((c) => c.status.kind === "ok" && !rejected.has(c.index)).length;
  return k === changes.length ? "Accept all" : `Accept ${k.toLocaleString("en-US")}`;
}

/** The changes the checker dropped, in order, each with the frame it names on a board of several (else null). */
function droppedOf(changes: ProposedChange[], titles: readonly string[]): { message: string; frame: string | null }[] {
  return changes.flatMap((c) => (c.status.kind === "dropped" ? [{ message: c.status.message, frame: titles.length > 1 ? changeFrame(c, titles) : null }] : []));
}

/**
 * The messages of the changes the checker dropped, in order, for "Ask to fix it": on a board of several diagrams each
 * starts with its frame, "<title>: <message>", as the broken card's does.
 */
export const droppedMessages = (changes: ProposedChange[], titles: readonly string[] = NO_TITLES): string[] =>
  droppedOf(changes, titles).map((d) => (d.frame ? `${d.frame}: ${d.message}` : d.message));

/**
 * "Contura dropped one change: <message>. The other <n> still fit together." ("<k> changes", messages joined by "; ",
 * when more). On a board of several diagrams the frame is named: "one change in <title>: ..." when every dropped change
 * is in it, else "<message> (in <title>)" each.
 */
export function droppedNote(changes: ProposedChange[], titles: readonly string[] = NO_TITLES): string | null {
  const dropped = droppedOf(changes, titles);
  if (dropped.length === 0) return null;
  const rest = changes.filter((c) => c.status.kind === "ok").length;
  const frames = new Set(dropped.map((d) => d.frame));
  const one = frames.size === 1 ? [...frames][0] : null;
  const count = dropped.length === 1 ? "one change" : plural(dropped.length, "change", "changes");
  const listed = dropped.map((d) => (one === null && d.frame ? `${asClause(d.message)} (in ${d.frame})` : asClause(d.message))).join("; ");
  const head = `Contura dropped ${count}${one ? ` in ${one}` : ""}: ${listed}.`;
  if (rest === 0) return head;
  return `${head} ${rest === 1 ? "The other change still fits together." : `The other ${rest.toLocaleString("en-US")} still fit together.`}`;
}

/** The rows of one frame, in the proposal's order; `title` null for changes that name no diagram of the board. */
interface Group {
  title: string | null;
  changes: ProposedChange[];
}

/**
 * The changes by frame (Decision 12): the board's frames in text order, then new frames in the order they are added,
 * then any change that names no diagram on the board. One group with no title on a board of one diagram.
 */
export function groupByFrame(changes: ProposedChange[], titles: readonly string[]): Group[] {
  if (titles.length <= 1) return [{ title: null, changes }];
  const by = new Map<string | null, ProposedChange[]>();
  for (const c of changes) {
    const t = changeFrame(c, titles);
    by.set(t, [...(by.get(t) ?? []), c]);
  }
  const order = [...titles.filter((t, i) => by.has(t) && titles.indexOf(t) === i), ...[...by.keys()].filter((t): t is string => t !== null && !titles.includes(t))];
  const out: Group[] = order.map((t) => ({ title: t, changes: by.get(t)! }));
  if (by.has(null)) out.push({ title: null, changes: by.get(null)! });
  return out;
}

export default function ProposalCard({ changes, kind, rejected, onReject, onAccept, onRejectAll, onAcceptAll, onShowText, onAskFix, outcome, frames = NO_TITLES, onAcceptFrame, onRejectFrame }: Props) {
  const live = rejected !== undefined && !!onAcceptAll;
  const note = droppedNote(changes, frames);
  const accepted = changes.filter((c) => c.status.kind === "ok" && !rejected?.has(c.index)).length;
  const groups = groupByFrame(changes, frames);
  const onKey = (e: KeyboardEvent) => {
    if (!live || e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    e.preventDefault();
    if (accepted > 0) onAcceptAll?.();
  };
  const row = (c: ProposedChange) => {
    const mark = changeMark(c);
    const off = rejected?.has(c.index) ?? false;
    const cls = `crow${off ? " off" : ""}${mark === "!" ? " dropped" : ""}`;
    return (
      <div key={c.index} className={cls}>
        <span className={`mk ${MARK_CLASS[mark]}`} aria-hidden="true">
          {mark}
        </span>
        <span className="tx">{changeLine(c, kind)}</span>
        {c.status.kind === "dropped" ? (
          <span className="dtag">dropped</span>
        ) : live && mark !== "!" ? (
          <span className="crow-acts">
            <button type="button" className="btn ib2" aria-label="Accept this change" aria-pressed={!off} onClick={() => onAccept?.(c.index)}>
              <Icon name="check" size={14} />
            </button>
            <button type="button" className="btn ib2" aria-label="Reject this change" aria-pressed={off} onClick={() => onReject?.(c.index)}>
              <Icon name="close" size={14} />
            </button>
          </span>
        ) : (
          <span />
        )}
      </div>
    );
  };
  return (
    <div className="ccard" role="region" aria-label={live ? "Changes to review" : "Changes"} onKeyDown={onKey}>
      <div className="ccard-head">
        <span className="ccard-title">{cardTitle(changes)}</span>
        {onShowText && (
          <button type="button" className="btn lnk2" onClick={onShowText}>
            Show in the text
          </button>
        )}
      </div>
      {groups.map((g) => {
        if (g.title === null) return g.changes.map(row);
        const head = `${g.title}, ${plural(g.changes.length, "change", "changes")}`;
        const some = g.changes.some((c) => c.status.kind === "ok");
        return (
          <div key={`g:${g.title}`} className="cgroup" role="group" aria-label={head}>
            <div className="cgroup-head">
              <span className="cgroup-title">{head}</span>
              {live && some && onAcceptFrame && onRejectFrame && (
                <span className="cgroup-acts">
                  <button type="button" className="btn lnk2" onClick={() => onRejectFrame(g.title!)}>
                    Reject frame
                  </button>
                  <button type="button" className="btn lnk2" onClick={() => onAcceptFrame(g.title!)}>
                    Accept frame
                  </button>
                </span>
              )}
            </div>
            {g.changes.map(row)}
          </div>
        );
      })}
      {note && <div className="ebody ccard-dropped">{note}</div>}
      {outcome && !live && <div className="ebody ccard-outcome">{outcome}</div>}
      {live && (
        <div className="ccard-foot">
          {!note && (
            <>
              <span className="ccard-note">Lands as one undo step</span>
              <span className="spacer" />
            </>
          )}
          <button type="button" className="btn pbtn2" onClick={onRejectAll}>
            Reject all
          </button>
          {note && <span className="spacer" />}
          {note && onAskFix && (
            <button type="button" className="btn pbtn2" onClick={() => onAskFix(droppedMessages(changes, frames))}>
              Ask to fix it
            </button>
          )}
          <button type="button" className="btn pbtn2 pri" disabled={accepted === 0} onClick={onAcceptAll}>
            {acceptLabel(changes, rejected ?? new Set())}
            <Kbd keys="Ctrl+Enter" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Changed on disk while the model worked, or (`inEditor`) the editor's text moved in the app before the changes landed
 * (board 11.5, e-stale); the second names the editor instead of another program and the disk.
 */
export function StaleCard({ file, line, nowReads, inEditor = false, onDiscard, onAskAgain }: { file: string; line: number | null; nowReads: string | null; inEditor?: boolean; onDiscard?(): void; onAskAgain?(): void }) {
  const b = inEditor ? { before: "The text changed in the editor after the assistant answered, so none of these changes were applied.", reads: null, after: "" } : changedBody({ line, nowReads });
  return (
    <div className="ccard warnc2" role="alert">
      <div className="ehead">
        <Icon name="alert" size={14} />
        <span>{inEditor ? `${file} changed while I worked` : changedTitle(file)}</span>
      </div>
      <div className="ebody">
        {b.before}
        {b.reads !== null && <b>{b.reads}</b>}
        {b.after}
      </div>
      {onDiscard && onAskAgain && (
        <div className="efoot">
          <button type="button" className="btn pbtn2" onClick={onDiscard}>
            Discard
          </button>
          <button type="button" className="btn pbtn2 pri" onClick={onAskAgain}>
            Ask again on the current text
          </button>
        </div>
      )}
    </div>
  );
}

/** A message without its closing full stop, for a sentence that adds its own. */
const stripStop = (message: string): string => message.replace(/\.$/, "");

/** The words a checker's sentence message opens with ("There is already a diagram called ..."); never a name. */
const OPENERS = /^(A|An|New|The|There) /;

/** A message as a clause inside a longer sentence: no closing full stop, and an opener in lower case. */
const asClause = (message: string): string => {
  const m = stripStop(message);
  return OPENERS.test(m) ? m[0].toLowerCase() + m.slice(1) : m;
};

const WORDS = ["", "", "Two", "Three"];

/**
 * "Two shapes could be "<word>": which one should come after the new step?" and a button per candidate (board 11.5,
 * e-unclear). On a board `frame` names the diagram the word is in: the candidates are its own shapes (Decision 12).
 */
export function PickCard({ change, onPick, onCancel, problem, frame }: { change: ProposedChange; onPick(candidate: Candidate): void; onCancel(): void; problem?: string | null; frame?: string | null }) {
  if (change.status.kind !== "ambiguous") return null;
  const { word, candidates } = change.status;
  const many = candidates.length < WORDS.length ? WORDS[candidates.length] : candidates.length.toLocaleString("en-US");
  const which = "add_flow" in change.op ? "which one should come after the new step?" : "which one did you mean?";
  const where = frame ? ` in ${frame}` : "";
  // The frame's own shapes are all a board offers: with none of them, the card says so and only Cancel is left.
  const ask =
    candidates.length === 0
      ? `Nothing in ${frame ?? "this diagram"} matches "${word}".`
      : candidates.length === 1
        ? `One shape${where} could be "${word}": ${which}`
        : `${many} shapes${where} could be "${word}": ${which}`;
  return (
    <>
      <p className="answer-p">{ask}</p>
      <div className="ccard" role="group" aria-label={frame ? `Pick a shape in ${frame}` : "Pick a shape"}>
        {candidates.map((c) => (
          <button key={c.name} type="button" className="btn pickrow" onClick={() => onPick(c)}>
            <span className="mono pid">{c.id ?? ""}</span>
            <span className="pname">{c.name}</span>
            <span className="pnote">{c.detail}</span>
          </button>
        ))}
        <div className="efoot">
          <span className="ccard-note">{problem ?? (candidates.length === 0 ? "Cancel, then ask again with the shape's name." : "Nothing changes until you pick.")}</span>
          <span className="spacer" />
          <button type="button" className="btn pbtn2" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Auto-apply refused a set that would leave the text a problem (board 11.5, e-broken). On a board `frame` names the
 * diagram, and the line is counted from its start (Decision 13a).
 */
export function BrokenCard({
  file,
  broke,
  frame,
  onReview,
  onAskFix,
}: {
  file: string;
  broke: { line: number; lineText: string; message: string };
  frame?: string | null;
  onReview(): void;
  onAskFix(): void;
}) {
  return (
    <div className="ccard warnc2" role="alert">
      <div className="ehead">
        <Icon name="alert" size={14} />
        <span>Not applied: the text would have a problem</span>
      </div>
      <div className="ebody">
        {`With these changes, line ${broke.line.toLocaleString("en-US")}${frame ? ` of ${frame}` : ""} would read `}
        <span className="mono">{broke.lineText}</span>
        {`: ${stripStop(broke.message)}. Auto-apply never lands a change that leaves a problem, so ${file} is as it was.`}
      </div>
      <div className="efoot">
        <button type="button" className="btn pbtn2" onClick={onReview}>
          Review the changes
        </button>
        <span className="spacer" />
        <button type="button" className="btn pbtn2 pri" onClick={onAskFix}>
          Ask to fix it
        </button>
      </div>
    </div>
  );
}
