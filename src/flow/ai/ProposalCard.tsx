// The diagram assistant's changes as a card (board 11.5, review): one row per change with its mark and .flow
// line, Accept and Reject on each, and the footer that lands the accepted ones as one undo step. Without the
// handlers it only shows the rows (a proposal from a reloaded thread). With a dropped change it says which and
// why; the cards for the other error states of board 11.5 (changed on disk, unclear target, would break the
// text) are here too. No hover text: aria-labels only.
import type { KeyboardEvent } from "react";
import type { Candidate, ProposedChange } from "../../api/types";
import { changedBody, changedTitle } from "../../assistant/answerState";
import Icon from "../../components/Icon";
import Kbd from "../../components/Kbd";
import { plural } from "../../format/plural";
import type { DiagramKind } from "../../lang/flow/model";
import { changeLine, changeMark } from "./proposal";

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
}

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

/** The messages of the changes the checker dropped, in order. */
export const droppedMessages = (changes: ProposedChange[]): string[] => changes.flatMap((c) => (c.status.kind === "dropped" ? [c.status.message] : []));

/** "Contura dropped one change: <message>. The other <n> still fit together." ("<k> changes", messages joined by "; ", when more). */
export function droppedNote(changes: ProposedChange[]): string | null {
  const messages = droppedMessages(changes);
  if (messages.length === 0) return null;
  const rest = changes.filter((c) => c.status.kind === "ok").length;
  const head = `Contura dropped ${messages.length === 1 ? "one change" : plural(messages.length, "change", "changes")}: ${messages.map(stripStop).join("; ")}.`;
  if (rest === 0) return head;
  return `${head} ${rest === 1 ? "The other change still fits together." : `The other ${rest.toLocaleString("en-US")} still fit together.`}`;
}

export default function ProposalCard({ changes, kind, rejected, onReject, onAccept, onRejectAll, onAcceptAll, onShowText, onAskFix, outcome }: Props) {
  const live = rejected !== undefined && !!onAcceptAll;
  const note = droppedNote(changes);
  const accepted = changes.filter((c) => c.status.kind === "ok" && !rejected?.has(c.index)).length;
  const onKey = (e: KeyboardEvent) => {
    if (!live || e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    e.preventDefault();
    if (accepted > 0) onAcceptAll?.();
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
      {changes.map((c) => {
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
            <button type="button" className="btn pbtn2" onClick={() => onAskFix(droppedMessages(changes))}>
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
        <span>{inEditor ? `${file}.flow changed while I worked` : changedTitle(file)}</span>
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

const WORDS = ["", "", "Two", "Three"];

/** "Two shapes could be "<word>": which one should come after the new step?" and a button per candidate (board 11.5, e-unclear). */
export function PickCard({ change, onPick, onCancel, problem }: { change: ProposedChange; onPick(candidate: Candidate): void; onCancel(): void; problem?: string | null }) {
  if (change.status.kind !== "ambiguous") return null;
  const { word, candidates } = change.status;
  const many = candidates.length < WORDS.length ? WORDS[candidates.length] : candidates.length.toLocaleString("en-US");
  const which = "add_flow" in change.op ? "which one should come after the new step?" : "which one did you mean?";
  return (
    <>
      <p className="answer-p">{`${many} shapes could be "${word}": ${which}`}</p>
      <div className="ccard" role="group" aria-label="Pick a shape">
        {candidates.map((c) => (
          <button key={c.name} type="button" className="btn pickrow" onClick={() => onPick(c)}>
            <span className="mono pid">{c.id ?? ""}</span>
            <span className="pname">{c.name}</span>
            <span className="pnote">{c.detail}</span>
          </button>
        ))}
        <div className="efoot">
          <span className="ccard-note">{problem ?? "Nothing changes until you pick."}</span>
          <span className="spacer" />
          <button type="button" className="btn pbtn2" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

/** Auto-apply refused a set that would leave the text a problem (board 11.5, e-broken). */
export function BrokenCard({ file, broke, onReview, onAskFix }: { file: string; broke: { line: number; lineText: string; message: string }; onReview(): void; onAskFix(): void }) {
  return (
    <div className="ccard warnc2" role="alert">
      <div className="ehead">
        <Icon name="alert" size={14} />
        <span>Not applied: the text would have a problem</span>
      </div>
      <div className="ebody">
        {`With these changes, line ${broke.line.toLocaleString("en-US")} would read `}
        <span className="mono">{broke.lineText}</span>
        {`: ${stripStop(broke.message)}. Auto-apply never lands a change that leaves a problem, so ${file}.flow is as it was.`}
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
