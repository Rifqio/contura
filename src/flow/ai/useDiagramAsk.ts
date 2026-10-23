// One diagram's assistant (board 11.5): its thread under `diagram:<name>`, the Ask that runs with the text held
// read-only, and the proposal that waits for review or lands at once. A landing is planned here on the text the
// Ask was made against and goes into the editor as one transaction on that parse's version, so one undo takes it
// back. Closing the tab, or opening another diagram in it, stops a running Ask.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { aiCancelPlace, aiDiagramAsk, aiDiagramPreview, aiRecordToolResult, appendAiTurn, errorText, getAiThread, listAiThreads, saveAiThread, withTurn } from "../../api/client";
import type { AiMessage, AiThread, Candidate, DiagramAskRequest, DiagramProposal, DiagramScope, FlowAssistMode, FlowOutline, ModelPicks, Preview, ProposedChange, ToolOutcome } from "../../api/types";
import { buildRecord, type LiveRecord } from "../../assistant/answerRecord";
import { type StreamEnd, textStore } from "../../assistant/answerStream";
import type { LangClient } from "../../lang/client";
import { type FlowParse, parseFlow } from "../../lang/flow/parse";
import type { TextEdit } from "../../lang/protocol";
import type { FlowHold } from "../flowRegistry";
import type { FlowDocApi, Parsed } from "../useFlowDoc";
import { landedSummary, planLanding, removalCount, withDependents, wouldBreak } from "./proposal";
import { reviewOverlay } from "./reviewOverlay";

/** The tool's name on the wire and in the record. */
export const DIAGRAM_TOOL = "propose_diagram_changes";

/** How long a shape just added keeps its ring: the 600 ms hold and the 1,800 ms fade of `airing`. */
export const AIRING_MS = 2400;

/** The place a diagram's thread and Ask live in. */
export const diagramPlace = (name: string) => `diagram:${name}`;

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** The Ask running now: the question and the Core's status line. Its text so far is in `streamed`. */
export interface Working {
  q: string;
  askedAt: number;
  status: string | null;
  /** The Core's earlier status lines, done. */
  steps: string[];
}

/** A proposal waiting for the user, with the text and parse version it was made against. */
export interface Waiting {
  threadId: string;
  /** The time of the answer that holds it, which names it to the Core. */
  messageAt: number;
  proposal: DiagramProposal;
  outline: FlowOutline;
  text: string;
  version: number;
  rejected: ReadonlySet<number>;
  /** Auto-apply was on when it arrived. */
  auto: boolean;
  /**
   * `remove` while the more-than-3-shapes question is open, `pick` while a word waits for the user to choose its shape,
   * `broken` when Auto-apply refused a set that would leave the text a problem, `stale` when the text is no longer the
   * one the changes were made against.
   */
  step: "review" | "remove" | "pick" | "broken" | "stale";
  /** The question that was asked and how: the same Ask goes again from the error cards. */
  q: string;
  opts: AskOptions;
  /** What the text would have, for `broken`. */
  broke: { line: number; lineText: string; message: string } | null;
  /** Why the last landing did nothing. */
  problem: string | null;
  /** The thread holding it was saved; the outcome goes to the Core only then. */
  saved: boolean;
}

/** What the last landing did, under its answer. */
export interface Landed {
  messageAt: number;
  summary: string;
  /** The 1-based lines of the new text the landing wrote. */
  lines: number[];
  /** The text before the landing: an undo that brings it back took the landing back. */
  before: string;
  /** The text the landing left: a redo that brings it back puts the landing back. */
  after: string;
  /** The landing was undone: its card offers no Undo or "Show in the text" until a redo lands it again. */
  undone?: boolean;
}

/** An Ask that left nothing to keep: its question, and why (null when it was stopped). */
export interface Failure {
  q: string;
  error: unknown;
  /** Why it was not sent, when that was not an error of the Ask. */
  note?: string;
}

export interface AskOptions {
  scope: DiagramScope;
  model: string | null;
  picks: ModelPicks | null;
}

/** The first change whose target word still waits for a pick. */
export const firstAmbiguous = (changes: ProposedChange[]): ProposedChange | undefined => changes.find((c) => c.status.kind === "ambiguous");

/** `change` with its word replaced by the shape `name` and its status Ok. */
function picked(change: ProposedChange, name: string): ProposedChange {
  if (change.status.kind !== "ambiguous") return change;
  const [tag, fields] = Object.entries(change.op)[0];
  return { ...change, op: { [tag]: { ...(fields as object), [change.status.field]: name } } as ProposedChange["op"], status: { kind: "ok" } };
}

/** What a diagram Ask asks again after a dropped or unusable set (board 11.5, e-checker). */
export const fixQuestion = (messages: string[]): string => `Some changes could not be used: ${messages.map((m) => m.replace(/\.$/, "")).join("; ")}. Propose them again so they fit this diagram.`;

// ----- line hunks

type Seg = { op: "same" | "del" | "add"; text: string };

/** The lines of `s` with their line breaks, so a diff of them rebuilds the text byte for byte. */
const segmentsOf = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** A line diff by longest common subsequence; within a change, removed lines come before added ones. */
function diffLines(before: string, after: string): Seg[] {
  const a = segmentsOf(before);
  const b = segmentsOf(after);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Seg[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: "same", text: a[i++] });
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ op: "del", text: a[i++] });
    else out.push({ op: "add", text: b[j++] });
  }
  return out;
}

/** `after` as edits on `before`, one per run of changed lines, so the ghost marks cover only the lines that change. */
export function ghostEdits(before: string, after: string): TextEdit[] {
  const edits: TextEdit[] = [];
  let pos = 0;
  let open: TextEdit | null = null;
  for (const s of diffLines(before, after)) {
    if (s.op === "same") {
      if (open) edits.push(open);
      open = null;
      pos += s.text.length;
      continue;
    }
    open ??= { from: pos, to: pos, insert: "" };
    if (s.op === "del") {
      pos += s.text.length;
      open.to = pos;
    } else open.insert += s.text;
  }
  if (open) edits.push(open);
  return edits;
}

/** The 1-based lines of `after` that are not in `before` (what a landing wrote). */
export function addedLines(before: string, after: string): number[] {
  const out: number[] = [];
  let line = 1;
  for (const s of diffLines(before, after)) {
    if (s.op === "del") continue;
    if (s.op === "add") out.push(line);
    line++;
  }
  return out;
}

/** The 1-based lines of `before` a change touches: the ones it removes, and the line an insert goes before. */
export function touchedLines(before: string, after: string): number[] {
  const out = new Set<number>();
  let line = 1;
  for (const s of diffLines(before, after)) {
    if (s.op === "add") out.add(line);
    else {
      if (s.op === "del") out.add(line);
      line++;
    }
  }
  const last = Math.max(1, segmentsOf(before).length);
  return [...out].map((n) => Math.min(n, last));
}

/** The changes `index` needs, directly or through others, with it. */
function withNeeds(w: Waiting, index: number): Set<number> {
  const out = new Set([index]);
  const stack = [index];
  while (stack.length) {
    const at = stack.pop();
    const c = w.proposal.changes.find((x) => x.index === at);
    for (const d of c?.dependsOn ?? []) {
      if (out.has(d)) continue;
      out.add(d);
      stack.push(d);
    }
  }
  return out;
}

const okIndexes = (p: DiagramProposal) => p.changes.filter((c) => c.status.kind === "ok").map((c) => c.index);
const acceptedOf = (w: Waiting) => new Set(okIndexes(w.proposal).filter((i) => !w.rejected.has(i)));

/** The landing of `accepted` on the text the proposal was made against; null when it does not apply. */
function planOf(w: Waiting, accepted: ReadonlySet<number>, parse: FlowParse = parseFlow(w.text)) {
  return planLanding(w.text, parse, w.proposal.changes, accepted, parse.kind);
}

/** The parse of the text the tab holds now and the worker's outline of that same version; null when either is missing. */
async function currentOutline(doc: FlowDocApi, client: LangClient): Promise<{ cur: Parsed; outline: FlowOutline } | null> {
  let cur = await doc.current();
  for (let i = 0; cur && i < 3; i++) {
    const o = await client.flowOutline(doc.docId, cur.result.version).catch(() => ({ stale: true as const }));
    if (!o.stale) return { cur, outline: o.outline };
    cur = await doc.current();
  }
  return null;
}

export function useDiagramAsk(name: string, doc: FlowDocApi, client: LangClient, mode: FlowAssistMode) {
  const place = diagramPlace(name);
  const [thread, setThreadState] = useState<AiThread | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [waiting, setWaitingState] = useState<Waiting | null>(null);
  const [landed, setLanded] = useState<Landed | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [airing, setAiring] = useState<ReadonlySet<string>>(new Set());
  /** Why the last turn or outcome could not be kept, shown in the panel until the next Ask. */
  const [notSaved, setNotSaved] = useState<string | null>(null);
  /** The running Ask's answer text, drawn at most once per animation frame by whoever follows it. */
  const [streamed] = useState(textStore);

  const threadRef = useRef<AiThread | null>(null);
  /** Threads whose last save failed: the next Ask saves them whole, since the Core may lack what they show. */
  const unsaved = useRef(new Set<string>());
  const setThread = useCallback((t: AiThread | null) => {
    threadRef.current = t;
    setThreadState(t);
  }, []);
  const waitingRef = useRef<Waiting | null>(null);
  const setWaiting = useCallback((w: Waiting | null) => {
    waitingRef.current = w;
    setWaitingState(w);
  }, []);
  /** The read-only hold of the Ask running or the proposal waiting; released once, when either is done. */
  const holdRef = useRef<FlowHold | null>(null);
  const release = useCallback(() => {
    const h = holdRef.current;
    holdRef.current = null;
    h?.();
  }, []);
  /** Holds the text read-only again, for the steps that draw the changes in it. */
  const holdText = useCallback(() => {
    if (!holdRef.current) holdRef.current = docRef.current.hold({ readOnly: true });
  }, []);
  /** The running Ask: stopping it ends its stream at once and tells the Core once it has the Ask. */
  const run = useRef<{ stopped: boolean; end(patch: Partial<StreamEnd>): void; started: Promise<boolean>; place: string } | null>(null);
  /**
   * The diagram the hook is on: bumped when the tab closes or opens another diagram, so an Ask of the old one that
   * resumes afterwards changes nothing here.
   */
  const generation = useRef(0);
  const docRef = useRef(doc);
  docRef.current = doc;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const airTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stop = useCallback(() => {
    const r = run.current;
    if (!r) return;
    run.current = null;
    r.stopped = true;
    r.end({ stopped: true });
    void r.started.then((ok) => (ok ? aiCancelPlace(r.place) : false)).catch(() => {});
  }, []);

  // The diagram's thread loads when the tab opens; closing the tab or opening another diagram in it stops the Ask
  // and lets the text go.
  useEffect(() => {
    const g = ++generation.current;
    const live = () => generation.current === g;
    setThread(null);
    setWorking(null);
    streamed.set("", "");
    streamed.flush();
    setWaiting(null);
    setLanded(null);
    setFailure(null);
    setNotSaved(null);
    listAiThreads(place)
      .then((list) => {
        const newest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        return newest ? getAiThread(newest.id) : null;
      })
      .then((v) => {
        if (live() && v && threadRef.current === null) setThread(v.thread);
      })
      .catch(() => {});
    return () => {
      generation.current++;
      stop();
      release();
      clearTimeout(airTimer.current);
    };
  }, [place, stop, release, setThread, setWaiting, streamed]);

  /** Saves the turn into the diagram's thread; returns the thread's id and the answer's time. */
  const persist = useCallback(
    async (q: string, askedAt: number, text: string, answeredAt: number, record: AiMessage["record"], requestId: string, live: () => boolean) => {
      const base = threadRef.current;
      const at = Math.max(answeredAt, askedAt + 1);
      const add: AiMessage[] = [
        { role: "user", text: q, context: [], at: askedAt },
        { role: "assistant", text, context: [], at, record },
      ];
      const next: AiThread = base
        ? { ...base, messages: [...base.messages, ...add], updatedAt: askedAt }
        : { id: newId(), place, title: q.length > 40 ? `${q.slice(0, 40)}…` : q, messages: add, updatedAt: askedAt };
      let failed: string | null = null;
      const fail = (e: unknown) => {
        failed = errorText(e);
        return null;
      };
      // Only the new turn goes to the Core (memory: the whole thread used to go both ways on each Ask). A thread whose
      // last save failed goes whole once more: the Core may lack turns and outcomes it shows.
      const kept =
        base && unsaved.current.has(base.id)
          ? ((await saveAiThread(next, requestId).catch(fail))?.thread ?? next)
          : await appendAiTurn({ threadId: next.id, place: next.place, title: next.title, updatedAt: askedAt, messages: add }, requestId).then(
              // An outcome kept meanwhile in this copy stays: the turn goes after the thread as it is now.
              (v) => withTurn(threadRef.current?.id === v.threadId ? threadRef.current : base, v),
              (e: unknown) => fail(e) ?? next,
            );
      if (failed === null) unsaved.current.delete(next.id);
      else unsaved.current.add(next.id);
      if (live()) {
        // An unsaved turn still shows here, with why it was not kept.
        setThread(kept);
        if (failed !== null) setNotSaved(`Not saved: ${failed}`);
      }
      return { threadId: kept.id, at, saved: failed === null };
    },
    [place, setThread],
  );

  /** Keeps what the user did with the proposal, in the Core and in this thread's copy. */
  const record = useCallback(
    (w: Waiting, accepted: number) => {
      const outcome: ToolOutcome = { accepted, rejected: okIndexes(w.proposal).length - accepted, auto: w.auto, at: Date.now() };
      const t = threadRef.current;
      if (t && t.id === w.threadId) {
        setThread({
          ...t,
          messages: t.messages.map((m) =>
            m.role === "assistant" && m.at === w.messageAt && m.record?.toolUse ? { ...m, record: { ...m.record, toolUse: { ...m.record.toolUse, outcome } } } : m,
          ),
        });
      }
      // A thread the Core does not have cannot take its outcome.
      if (!w.saved) return;
      const g = generation.current;
      void aiRecordToolResult(w.threadId, w.messageAt, outcome).catch((e: unknown) => {
        if (generation.current === g) setNotSaved(`Not saved: ${errorText(e)}`);
      });
    },
    [setThread],
  );

  /** Lands `accepted` as one transaction on the proposal's version; false, with nothing changed, when it does not apply. */
  const land = useCallback(
    (w: Waiting, accepted: ReadonlySet<number>): boolean => {
      const plan = accepted.size > 0 ? planOf(w, accepted) : null;
      if (!plan) {
        // The accepted changes passed the Core's check one by one but do not land on the text together.
        setWaiting({ ...w, step: "review", problem: "These changes do not fit together. Review them again, or ask to fix it." });
        return false;
      }
      if (!docRef.current.land(plan.edits, w.version)) {
        // The editor no longer holds the text these changes were made against.
        release();
        setWaiting({ ...w, step: "stale", problem: null });
        return false;
      }
      setWaiting(null);
      release();
      // Shapes drawn for review that did not land lose the place they were given.
      docRef.current.settleProposed(parseFlow(plan.text).defined);
      const added = w.proposal.changes.flatMap((c) => (accepted.has(c.index) && "add_node" in c.op ? [c.op.add_node.name] : []));
      clearTimeout(airTimer.current);
      setAiring(new Set(added));
      airTimer.current = setTimeout(() => setAiring(new Set()), AIRING_MS);
      setLanded({ messageAt: w.messageAt, summary: landedSummary(w.proposal.changes, accepted), lines: addedLines(w.text, plan.text), before: w.text, after: plan.text });
      record(w, accepted.size);
      return true;
    },
    [record, release, setWaiting],
  );

  /** Where a proposal with nothing left to pick goes: the remove question, Auto-apply's landing, or the review card. */
  const proceed = useCallback(
    (w: Waiting) => {
      holdText();
      const ok = new Set(okIndexes(w.proposal));
      if (ok.size > 0 && removalCount(w.proposal.changes, ok, w.outline).shapes.length > 3) {
        setWaiting({ ...w, step: "remove" });
        return;
      }
      if (ok.size > 0 && w.auto) {
        // Auto-apply lands the whole set at once unless it would leave the text with a new problem.
        const parse = parseFlow(w.text);
        const plan = planOf(w, ok, parse);
        if (plan) {
          const broke = wouldBreak(parse, parseFlow(plan.text), plan.text);
          if (broke === null) {
            // A landing that did not apply has already put the proposal up for review with why.
            land(w, ok);
            return;
          }
          // The board draws the lock only while the assistant works: the text is free to type in.
          release();
          setWaiting({ ...w, step: "broken", broke });
          return;
        }
      }
      setWaiting({ ...w, step: "review" });
    },
    [land, release, holdText, setWaiting],
  );

  const send = useCallback(
    async (q: string, opts: AskOptions) => {
      if (run.current || waitingRef.current || !q.trim()) return;
      const g = generation.current;
      const current = () => generation.current === g;
      const askedAt = Date.now();
      const requestId = newId();
      const live: LiveRecord = { sent: null, steps: [], log: [], thinking: "" };
      let text = "";
      let proposal = null as DiagramProposal | null;
      let input = "";
      let ended = false;
      let finish: (e: StreamEnd) => void = () => {};
      const ending = new Promise<StreamEnd>((resolve) => (finish = resolve));
      const r = {
        stopped: false,
        place,
        started: Promise.resolve(false),
        end(patch: Partial<StreamEnd>) {
          if (ended) return;
          ended = true;
          finish({ text, done: null, error: null, partial: false, stopped: false, at: Date.now(), live: { ...live }, ...patch });
        },
      };
      run.current = r;
      setFailure(null);
      setLanded(null);
      setNotSaved(null);
      streamed.set("", "");
      streamed.flush();
      setWorking({ q, askedAt, status: null, steps: [] });
      const d = docRef.current;
      // What the tab holds goes to disk first, so the Core reads and hashes the same text; then the text is held.
      // A save that fails stops here: the Core would read a file that is not what the tab shows.
      const flushed = await d.flush();
      if (!flushed && !r.stopped && current()) {
        if (run.current === r) run.current = null;
        setWorking(null);
        setFailure({ q, error: null, note: "Not saved, so nothing was sent. Save the diagram, then send it again." });
        return;
      }
      if (!r.stopped && current()) holdRef.current = d.hold({ readOnly: true });
      const read = r.stopped ? null : await currentOutline(d, client);
      const cur = read?.cur ?? null;
      const outline = read?.outline ?? null;
      if (r.stopped || !current() || !cur || !outline) {
        if (run.current === r) run.current = null;
        // The diagram this Ask was on is gone: its hold went with it, and nothing here is its business.
        if (!current()) return;
        release();
        setWorking(null);
        setFailure({ q, error: null });
        return;
      }
      const sentText = cur.text;
      const version = cur.result.version;
      // No history: each Ask is a new one on the current text (plan ruling P7).
      const request: DiagramAskRequest = { requestId, file: name, text: sentText, outline, question: q, scope: opts.scope, threadId: null, model: opts.model, picks: opts.picks };
      const asking = aiDiagramAsk(request, (e) => {
        if (ended) return;
        switch (e.type) {
          case "delta":
            text += e.text;
            if (current()) streamed.set(text, "");
            break;
          case "status":
            if (current()) setWorking((w) => w && { ...w, status: e.step, steps: w.status && w.status !== e.step ? [...w.steps, w.status] : w.steps });
            break;
          case "thinking":
            live.thinking += e.text;
            break;
          case "thinkingKept":
            live.thinking = e.text;
            break;
          case "log": {
            const { type: _, ...line } = e;
            live.log = [...live.log, line];
            break;
          }
          case "sent": {
            const { type: _, ...sent } = e;
            live.sent = sent;
            break;
          }
          case "process": {
            const { type: _, ...step } = e;
            live.steps = [...live.steps, step];
            break;
          }
          case "proposal":
            proposal = e.proposal;
            input = e.input;
            break;
          case "done":
            r.end({ done: e });
            break;
          case "error":
            if (e.error.kind === "cancelled") r.end({ stopped: true });
            else r.end({ error: { kind: "ai", message: e.error }, partial: e.partial });
            break;
        }
      });
      r.started = asking.then(
        () => true,
        (error: unknown) => {
          r.end({ error });
          return false;
        },
      );
      const end = await ending;
      if (run.current === r) run.current = null;
      // The answer is in the thread once it is saved; the streamed copy lets go of it now.
      if (current()) {
        streamed.set("", "");
        streamed.flush();
      }
      // A closed tab, or another diagram in it, keeps nothing and lands nothing.
      if (!current()) return;
      setWorking(null);
      const keep = end.done !== null || end.text !== "" || (end.error !== null && end.live.sent !== null);
      if (!keep) {
        release();
        setFailure({ q, error: end.error });
        return;
      }
      const rec = buildRecord(end, end.live);
      rec.millis ??= end.at - askedAt;
      const got: DiagramProposal | null = end.done ? proposal : null;
      if (got) {
        rec.toolUse = { tool: DIAGRAM_TOOL, file: name, input, proposal: got, outcome: null };
      }
      const saved = await persist(q, askedAt, end.text, end.at, rec, requestId, current);
      if (!current()) return;
      if (!got) {
        release();
        return;
      }
      const w: Waiting = {
        threadId: saved.threadId,
        messageAt: saved.at,
        proposal: got,
        outline,
        text: sentText,
        version,
        rejected: new Set(),
        auto: modeRef.current === "auto",
        step: "review",
        q,
        opts,
        broke: null,
        problem: null,
        saved: saved.saved,
      };
      if (firstAmbiguous(got.changes)) {
        release();
        setWaiting({ ...w, step: "pick" });
        return;
      }
      proceed(w);
    },
    [place, name, client, persist, release, proceed, setWaiting, streamed],
  );

  const reject = useCallback(
    (index: number) => {
      const w = waitingRef.current;
      if (w) setWaiting({ ...w, rejected: new Set([...w.rejected, ...withDependents(w.proposal.changes, index)]), problem: null });
    },
    [setWaiting],
  );

  const accept = useCallback(
    (index: number) => {
      const w = waitingRef.current;
      if (!w) return;
      const back = withNeeds(w, index);
      setWaiting({ ...w, rejected: new Set([...w.rejected].filter((i) => !back.has(i))), problem: null });
    },
    [setWaiting],
  );

  const acceptAll = useCallback(() => {
    const w = waitingRef.current;
    if (!w || w.step !== "review") return;
    const accepted = acceptedOf(w);
    if (accepted.size > 0) land(w, accepted);
  }, [land]);

  /** Reject all, or Cancel on the remove question: nothing lands, and that is recorded. */
  const rejectAll = useCallback(() => {
    const w = waitingRef.current;
    if (!w) return;
    setWaiting(null);
    release();
    docRef.current.settleProposed(parseFlow(w.text).defined);
    record(w, 0);
  }, [record, release, setWaiting]);

  const reviewEach = useCallback(() => {
    const w = waitingRef.current;
    if (!w) return;
    holdText();
    setWaiting({ ...w, step: "review" });
  }, [holdText, setWaiting]);

  /** The user chose `name` for the word the first unclear change holds; the set is checked again, then goes on. */
  const pick = useCallback(
    (candidate: Candidate) => {
      const w = waitingRef.current;
      if (!w || w.step !== "pick") return;
      const at = firstAmbiguous(w.proposal.changes);
      if (!at) return;
      const changes = w.proposal.changes.map((c) => (c === at ? picked(c, candidate.name) : c));
      const next: Waiting = { ...w, proposal: { ...w.proposal, changes }, problem: null };
      const ok = new Set(okIndexes(next.proposal));
      if (ok.size > 0 && !planOf(next, ok)) {
        setWaiting({ ...w, problem: "That choice does not fit the text. Pick another, or cancel." });
        return;
      }
      if (firstAmbiguous(changes)) setWaiting({ ...next, step: "pick" });
      else proceed(next);
    },
    [proceed, setWaiting],
  );

  /** "Ask to fix it": the changes wait no more, and a new Ask on the current text says what could not be used. */
  const askToFix = useCallback(
    (messages: string[]) => {
      const w = waitingRef.current;
      if (!w) return;
      setWaiting(null);
      docRef.current.settleProposed(parseFlow(w.text).defined);
      release();
      record(w, 0);
      void send(fixQuestion(messages), w.opts);
    },
    [record, release, send, setWaiting],
  );

  /** Reads the text from disk into the tab, then sends `q` again on it. */
  const askAgain = useCallback(
    async (q: string, opts: AskOptions) => {
      const w = waitingRef.current;
      if (w) {
        setWaiting(null);
        docRef.current.settleProposed(parseFlow(w.text).defined);
        release();
        record(w, 0);
      }
      const g = generation.current;
      const ok = await docRef.current.reload();
      if (generation.current !== g) return;
      if (!ok) {
        setFailure({ q, error: null, note: "Could not read the file from disk, so nothing was sent." });
        return;
      }
      await send(q, opts);
    },
    [record, release, send, setWaiting],
  );

  /** "Remove and redraw": the whole set, as asked. */
  const removeAll = useCallback(() => {
    const w = waitingRef.current;
    if (w) land(w, new Set(okIndexes(w.proposal)));
  }, [land]);

  // What the waiting changes would make of the text: the ghost marks in the editor and the canvas's overlay.
  const planned = useMemo(() => {
    // An unclear word, a refused landing and a stale text have nothing to show yet.
    if (!waiting || (waiting.step !== "review" && waiting.step !== "remove")) return null;
    const parse = parseFlow(waiting.text);
    const accepted = acceptedOf(waiting);
    const plan = accepted.size > 0 ? planOf(waiting, accepted, parse) : null;
    const after = plan?.text ?? waiting.text;
    const proposed = plan ? parseFlow(plan.text).doc : parse.doc;
    return {
      ghost: { edits: ghostEdits(waiting.text, after), text: waiting.text },
      lines: touchedLines(waiting.text, after),
      overlay: parse.doc && proposed ? reviewOverlay(parse.doc, proposed) : null,
      count: accepted.size,
      removal: waiting.step === "remove" ? { ...removalCount(waiting.proposal.changes, accepted, waiting.outline), adds: waiting.proposal.changes.filter((c) => accepted.has(c.index) && "add_node" in c.op).length } : null,
    };
  }, [waiting]);

  /**
   * What an Ask of `q` would send on the text the tab holds now, as the Core builds it (R1.6), for the Sends line and
   * Show exactly. Null when the text has no outline yet.
   */
  const preview = useCallback(
    async (q: string, opts: AskOptions): Promise<Preview | null> => {
      const now = await currentOutline(docRef.current, client);
      if (!now) return null;
      return aiDiagramPreview({ requestId: newId(), file: name, text: now.cur.text, outline: now.outline, question: q, scope: opts.scope, threadId: null, model: opts.model, picks: opts.picks });
    },
    [client, name],
  );

  return {
    place,
    /** The parse version of the text the tab holds; a new one previews the Sends line again. */
    version: doc.parsed?.result.version ?? null,
    preview,
    thread,
    working,
    /** The running Ask's answer text so far; `useStoreText(streamed)` follows it. */
    streamed,
    waiting,
    landed,
    failure,
    airing,
    /** The changes that would land now; 0 when none wait. */
    pending: planned?.count ?? 0,
    /** The text is held: an Ask is running or changes wait. */
    locked: working !== null || (waiting !== null && (waiting.step === "review" || waiting.step === "remove")),
    ghost: planned?.ghost ?? null,
    /** The lines of the text the waiting changes touch, for "Show in the text". */
    lines: planned?.lines ?? [],
    overlay: planned?.overlay ?? null,
    removal: planned?.removal ?? null,
    send,
    stop,
    reject,
    accept,
    acceptAll,
    rejectAll,
    reviewEach,
    removeAll,
    pick,
    askToFix,
    askAgain,
    notSaved,
    clearFailure: () => setFailure(null),
    /**
     * An undo or redo ran in the text: back at the text before the landing, the landing is undone; back at the text it
     * left, it is landed again and the card offers Undo once more.
     */
    historyMoved: useCallback(
      (text: string) =>
        setLanded((l) => {
          if (!l) return l;
          if (!l.undone && text === l.before) return { ...l, undone: true };
          if (l.undone && text === l.after) return { ...l, undone: false };
          return l;
        }),
      [],
    ),
  };
}

export type DiagramAsk = ReturnType<typeof useDiagramAsk>;
