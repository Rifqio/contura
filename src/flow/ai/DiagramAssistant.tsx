// The Assistant side of the diagram tab's side panel (scenes idle, working, review, auto and ask):
// the diagram's thread, the composer, "Review first" or "Auto-apply", the model and Send, and
// each answer's proposal as its card, its remove question or what landed. The assistant adds the Sends line from the
// Core's preview, the Sent line and Show log under each answer, and the note when the tool is off in Settings. No
// hover text: aria-labels only. The head has `+` (assistant.newChat) and the clock, D2's history of the board's chats;
// switching frames keeps the chat.
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { aiSettingsChanged } from "../../api/changes";
import { aiAnswerRecord, aiClearAttachment, aiKnownModels, aiPickAttachment, aiSettings, errorText, setAiModelPrefs } from "../../api/client";
import type { AiMessage, AiSettingsView, AnswerRecord, FlowAssistMode, ModelList, ModelPicks, Preview } from "../../api/types";
import AnswerLog from "../../assistant/AnswerLog";
import { mainNeverLeft, providerName as nameOf, recordError, recordOf, sentLine } from "../../assistant/answerRecord";
import answerState, { aiErrorOf } from "../../assistant/answerState";
import { type TextStore, useStoreText } from "../../assistant/answerStream";
import AnswerText from "../../assistant/AnswerText";
import ModelPicker from "../../assistant/ModelPicker";
import Sends from "../../assistant/Sends";
import SentRecord from "../../assistant/SentRecord";
import ThreadHistory from "../../assistant/ThreadHistory";
import { useCommandKeys } from "../../commands/useCommandKeys";
import Icon from "../../components/Icon";
import Kbd from "../../components/Kbd";
import SlashCommands, { optionId } from "../../assistant/SlashCommands";
import { slashKey } from "../../assistant/slash";
import type { DiagramKind } from "../../lang/flow/model";
import { earlierLabel, SHOWN_TURNS, turnWindow } from "../../assistant/turnWindow";
import { answerRefs, type PartFrame, type PartLink, proseCodes } from "./answerRefs";
import AskChips, { type BoardFrame, CLASH_REASON, frameRefs, useAskChips } from "./AskChips";
import { foldedOutcome, outcomeText } from "./proposal";
import ProposalCard, { BrokenCard, PickCard, StaleCard } from "./ProposalCard";
import RemoveDialog from "./RemoveDialog";
import StartScreen from "./StartScreen";
import FollowUpCard from "./FollowUpCard";
import { type AskOptions, BLANK_REPLY, type BoardAsk, isLeftToAi, LEFT_TO_AI, trimmedNote, trimmedOf } from "./useBoardAsk";

interface Props {
  ai: BoardAsk;
  /** The diagram's name: `<name>.flow`. */
  name: string;
  kind: DiagramKind | null;
  /** The canvas selection: the Sends line is built again when it changes (it goes with the board). */
  selected: string[];
  /** The selected sketches' ids: with the shapes they make the selection chip, and the Sends line is built again when they change. */
  sketches?: string[];
  /** The board's frames in order, for the `/` list and the chips' kind words. */
  frames?: readonly BoardFrame[];
  /** The selected frame: the automatic frame chip. */
  selectedFrame?: { title: string; index: number; key?: string } | null;
  /** A frame whose AI Chat was opened without selecting it: its chip is added (a new object each time). */
  frameChip?: { title: string; index: number } | null;
  /** What each frame holds now, by frame place: the names an answer's backticks can link to. */
  parts?: readonly PartFrame[];
  /** A part button was pressed: the frame at `link.at` is selected and the part shown. */
  onShowPart?(link: PartLink): void;
  mode: FlowAssistMode;
  onMode(mode: FlowAssistMode): void;
  /** Switches to the Editor and bands these 1-based lines. */
  onShowText(lines: number[]): void;
  /** One undo in the diagram's history. */
  onUndo(): void;
  /**
   * The Assistant is in view (the tab on top, the pane shown): the AI settings are read again each time, as they may
   * have changed in Settings, and the Sends line is built only then.
   */
  active?: boolean;
  /** Open Settings on the tool-off note: the AI settings' tools table. */
  onOpenSettings?(): void;
  /** The start screen's Template: the board Shelf opens on its templates side. */
  onTemplate?(): void;
}

/** How long typing, the selection or the text must settle before the Sends line is built again. */
const PREVIEW_MS = 300;

const TOOL_OFF = "The assistant cannot suggest diagram changes: Propose diagram changes is off in Settings.";

const NO_SKETCHES: string[] = [];
const NO_FRAMES: readonly BoardFrame[] = [];
const NO_CONNECTIONS: [] = [];

const isToolOff = (e: unknown) => aiErrorOf(e)?.kind === "toolOff";
const isFileGone = (e: unknown) => aiErrorOf(e)?.kind === "attachmentGone";

/** Each kind by the name people call it (Mermaid's docs): a card name that is not a diagram on its own takes "diagram". */
const KIND_NOUN: Record<DiagramKind, string> = {
  dfd: "data flow diagram",
  flow: "flowchart",
  cloud: "cloud architecture diagram",
  er: "ER diagram",
  sequence: "sequence diagram",
  state: "state diagram",
  class: "class diagram",
  mindmap: "mind map",
  timeline: "timeline",
};

/** The composer's placeholder under a kind card's chip: "Describe the sequence diagram", "Describe the flowchart". */
const describeKind = (kind: DiagramKind): string => `Describe the ${KIND_NOUN[kind]}`;

/** Lets the Core forget a file whose chip went; a failure leaves it to the next pick, which replaces it. */
const forgetFile = (token: string) => void aiClearAttachment(token).catch(() => {});

/** Tool off: the assistant cannot propose anything, so there is no composer; Open Settings goes to the switch. */
/** Under an answer given on a trimmed board: how many diagrams went as names only or were left out. */
function TrimmedNote({ record }: { record: AnswerRecord }) {
  const t = trimmedOf(record);
  return t ? <p className="answer-p flow-assist-trimmed">{trimmedNote(t)}</p> : null;
}

function ToolOffNote({ onOpenSettings }: { onOpenSettings?(): void }) {
  return (
    <div className="ccard warnc2 flow-tooloff" role="status">
      <div className="ehead">
        <Icon name="lock" size={14} />
        <span>{TOOL_OFF}</span>
      </div>
      {onOpenSettings && (
        <div className="efoot">
          <span className="spacer" />
          <button type="button" className="btn pbtn2" onClick={onOpenSettings}>
            <Icon name="gear" size={14} />
            Open Settings
          </button>
        </div>
      )}
    </div>
  );
}

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

/** An answer's text in the assistant's renderer; a diagram answer has no checked SQL. */
function Said({ text, notes, streaming = false, parts, onShowPart }: { text: string; notes?: string[]; streaming?: boolean; parts?: readonly PartFrame[]; onShowPart?(link: PartLink): void }) {
  // The names an answer gives that are on the board now. A finished answer only; a part gone since reads as plain code.
  const links = useMemo(() => (streaming || !parts || !onShowPart ? NO_LINKS : answerRefs(text, parts)), [text, parts, streaming, onShowPart]);
  // `renderCode` keeps its identity while the links are the same, so a parse of the board that changes nothing here
  // does not draw every block of every older answer again (AnswerBlock is memoised on it).
  const signature = links.map((l) => `${l.from}:${l.to}:${l.at}:${l.name}:${l.column}:${l.frame}:${parts?.[l.at]?.clash ? 1 : 0}`).join("|");
  const linksRef = useRef(links);
  linksRef.current = links;
  const clashRef = useRef(parts);
  clashRef.current = parts;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for what `links` and `parts` hold here.
  const renderCode = useMemo(() => {
    const links = linksRef.current;
    if (links.length === 0 || !onShowPart) return undefined;
    const codes = proseCodes(text);
    const byFrom = new Map(links.map((l) => [l.from, l]));
    return (n: number, code: string) => {
      const at = codes[n];
      const link = at?.text === code ? byFrom.get(at.from) : undefined;
      if (!link) return null;
      // The name starts with the words the button shows; a frame that cannot be selected only scrolls into view.
      const only = clashRef.current?.[link.at]?.clash ? " (shows the frame only)" : "";
      return (
        <button type="button" className="answer-part" aria-label={`${code}, show in ${link.frame}${only}`} onClick={() => onShowPart(link)}>
          <code>{code}</code>
        </button>
      );
    };
  }, [signature, text, onShowPart]);
  if (!text && !notes?.length) return null;
  return <AnswerText text={text} notes={notes} streaming={streaming} blocks={[]} sqlBlocks={false} dialect="sqlite" onCopy={copy} renderCode={renderCode} />;
}

const NO_LINKS: PartLink[] = [];

/** The answer being written. Only this follows the text as it streams; `onGrow` runs after each new piece is drawn. */
function LiveSaid({ source, onGrow }: { source: TextStore; onGrow(): void }) {
  const text = useStoreText(source);
  useEffect(() => onGrow(), [text, onGrow]);
  return <Said text={text} streaming />;
}

/** What a provider error says after it. Tool and file-name errors have their one line only. */
function keptNote(kind: string | undefined): string | null {
  if (kind === "badFileName") return null;
  if (kind === "toolRejected" || kind === "badToolInput") return null;
  return "Nothing was changed. Your request is kept below, so you can send it again.";
}

/** The card for an Ask that changed nothing: the file changed on disk, or the assistant's card for the error with Retry. */
function ErrorCard({ error, name, kept, keySaved, tries, onRetry, onDiscard, onAskAgain, onShowLog, onOpenSettings }: { error: unknown; name: string; kept: boolean; keySaved?: boolean; tries?: number; onRetry?(): void; onDiscard?(): void; onAskAgain?(): void; onShowLog?(): void; onOpenSettings?(): void }) {
  const ai = aiErrorOf(error);
  if (ai?.kind === "toolOff") return <ToolOffNote onOpenSettings={onOpenSettings} />;
  // Only the newest failed turn can be discarded or asked again; an older one shows the text alone.
  if (ai?.kind === "fileChanged")
    return <StaleCard file={ai.file || name} line={ai.line} nowReads={ai.nowReads} onDiscard={kept ? onDiscard : undefined} onAskAgain={kept ? onAskAgain : undefined} />;
  const note = kept ? keptNote(ai?.kind) : null;
  return (
    <>
      {answerState(error, { keySaved, tries, onRetry: kept && ai?.kind !== "badFileName" ? onRetry : undefined, onShowLog, onOpenSettings })}
      {note && <p className="answer-p flow-assist-kept">{note}</p>}
    </>
  );
}

/** The newest assistant turn whose text is `question`: the follow-up the card shows. */
function questionTurn(messages: readonly AiMessage[], question: string): AiMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant" && messages[i].text === question) return messages[i];
  return undefined;
}

export default function DiagramAssistant({ ai, name, kind, selected, sketches = NO_SKETCHES, frames = NO_FRAMES, selectedFrame = null, frameChip = null, parts, onShowPart, mode, onMode, onShowText, onUndo, active = true, onOpenSettings, onTemplate }: Props) {
  const [question, setQuestion] = useState("");
  const [models, setModels] = useState<ModelList | null>(null);
  /** Why the models could not be listed, or the last pick could not be saved. */
  const [modelError, setModelError] = useState<string | null>(null);
  /** Why the AI settings could not be read. */
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const chat = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /**
   * The pane: Ctrl+Shift+N, and Ctrl+N with focus in it, start a new chat here. With focus in neither this pane
   * nor the Ask panel (on the board canvas), the board's pane on screen takes Ctrl+Shift+N.
   */
  const root = useRef<HTMLDivElement>(null);
  useCommandKeys({ "assistant.newChat": ai.newChat }, { region: root, preferWhenShown: true });
  // The selection by its ids: a removed selection chip comes back when they change, not only their count.
  const selectionKey = `${selected.join("\n")}\u0000${sketches.join("\n")}`;
  const chipApi = useAskChips(selectedFrame, selected.length + sketches.length, frames, selectionKey);
  const { chips } = chipApi;
  const chipped = useRef<typeof frameChip>(null);
  useEffect(() => {
    if (!frameChip || chipped.current === frameChip) return;
    chipped.current = frameChip;
    const at = frames.findIndex((f) => f.title === frameChip.title && !f.clash);
    if (at >= 0) chipApi.addFrame(frameChip.title, at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameChip]);
  /** Where the user is typing in the box: the `/` list opens for the word before it. */
  const [typedAt, setTypedAt] = useState(0);
  const [slashRow, setSlashRow] = useState(0);
  /** Where the `/` Esc closed starts, until the word changes. */
  const [slashClosed, setSlashClosed] = useState<number | null>(null);
  const slashId = useId();
  const waitId = useId();
  /** Failed turns whose error card the user discarded. */
  const [discarded, setDiscarded] = useState<ReadonlySet<number>>(new Set());
  /** Turns shown beyond the newest `SHOWN_TURNS`, by "Show <n> earlier"; back to none on each Ask. */
  const [more, setMore] = useState(0);
  const mounted = useRef(Date.now());
  const { thread, working, waiting, landed, failure, asking } = ai;
  /** The board's titles in text order: a reloaded proposal's rows group by them. */
  const titles = useMemo(() => frames.map((f) => f.title), [frames]);
  const messages = thread?.messages ?? [];
  /** The follow-up's card is on screen: the composer waits for it. */
  const replying = !!asking && !working && !waiting;
  /** The turn that holds the follow-up's question: the card shows it, so the thread does not repeat it. */
  const askedBack = replying ? questionTurn(messages, asking.question) : undefined;
  const shown = turnWindow(messages, SHOWN_TURNS + more);
  /** Answers before this one are older than the newest turns: a proposal card there shows as one line. */
  const foldBefore = turnWindow(messages, SHOWN_TURNS).first;
  const threadId = thread?.id;
  /** The global AI settings: the provider for "Show exactly" and the diagram tool's switch. */
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  /** The Core's preview of the Ask in the composer, or why it could not be built. */
  const [sends, setSends] = useState<{ preview: Preview | null; error: unknown; attachment?: string | null }>({ preview: null, error: null });
  /** The file token the last Ask from the composer sent: a failure that says it is gone drops that chip, no other. */
  const sentFile = useRef<string | null>(null);
  /** Why the last file could not be attached (the Core's refusal names the file only), or null. */
  const [fileNote, setFileNote] = useState<string | null>(null);
  /** The answer whose log takes the panel's place, by its time. */
  const [logAt, setLogAt] = useState<number | null>(null);
  /** The answer whose Sent record is open, by its time. */
  const [sentOpen, setSentOpen] = useState<number | null>(null);
  /** Full records of trimmed answers, fetched for Show log and the Sent record, by time; or why one could not be. */
  const [full, setFull] = useState<ReadonlyMap<number, AnswerRecord | string>>(new Map());
  // Another chat (New chat, a past one): its turns start at the newest, with no log or Sent record of the last one open.
  useEffect(() => {
    setMore(0);
    setLogAt(null);
    setSentOpen(null);
  }, [threadId]);

  const toolOn = settings?.settings.diagramTool ?? true;
  // The Core refused for the switch (it was turned off after the tab read it): the same note, until it is read on again.
  const off = !toolOn || isToolOff(sends.error) || isToolOff(failure?.error);
  const refused = useRef({ sends: sends.error, failure });
  refused.current = { sends: sends.error, failure };

  // Read each time the Assistant comes into view: the switch may have changed in Settings meanwhile. A refusal seen
  // before this read gives way when the switch reads on now.
  useEffect(() => {
    if (!active) return;
    let live = true;
    const before = refused.current;
    aiSettings(null)
      .then((v) => {
        if (!live) return;
        setSettings(v);
        setSettingsError(null);
        if (v.settings.diagramTool === false) return;
        if (isToolOff(before.sends)) setSends((now) => (now.error === before.sends ? { preview: null, error: null } : now));
        if (isToolOff(before.failure?.error) && refused.current.failure === before.failure) ai.clearFailure();
      })
      .catch((e: unknown) => {
        if (live) setSettingsError(`Could not read the AI settings. ${errorText(e)}`);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Diagram Asks use the global settings: the model list without a Group. Read again when the
  // settings or the current model are saved anywhere (Settings, the Ask panel), so the picker never goes stale.
  useEffect(() => {
    let live = true;
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      aiKnownModels(null)
        .then((l) => {
          if (!live || mine !== seq) return;
          setModels(l);
          setModelError(null);
        })
        .catch((e: unknown) => {
          if (live && mine === seq) setModelError(errorText(e));
        });
    };
    let settingsSeq = 0;
    const loadSettings = () => {
      const mine = ++settingsSeq;
      aiSettings(null)
        .then((v) => {
          if (!live || mine !== settingsSeq) return;
          setSettings(v);
          setSettingsError(null);
        })
        .catch((e: unknown) => {
          if (live && mine === settingsSeq) setSettingsError(`Could not read the AI settings. ${errorText(e)}`);
        });
    };
    load();
    const off = aiSettingsChanged.on(() => {
      load();
      loadSettings();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const model = models?.models.find((m) => m.id === models.current) ?? null;

  // The Sends line: the Core's preview of the Ask as typed, 300 ms after the question, the selection or the text last
  // changed. Never while an Ask runs; the last one stays shown until the next arrives.
  // The chips are what the Ask names as focus, with the kind card's and the file's.
  const chipsKey = JSON.stringify([chipApi.selectionOff, ...chips.map((c) => (c.kind === "frame" ? [c.title, c.index] : c.kind === "create" ? c.diagram : c.kind === "file" ? c.token : null))]);
  const running = working !== null;
  const picksKey = JSON.stringify(model?.picks ?? null);
  useEffect(() => {
    if (running || off || !active) return;
    let live = true;
    const timer = setTimeout(() => {
      const opts = askOptions();
      ai.preview(question, opts).then(
        (preview) => {
          // No outline of the text yet: no rows, rather than the last text's.
          if (live) setSends({ preview, error: null });
        },
        (error: unknown) => {
          if (live) setSends({ preview: null, error, attachment: opts.attachment });
        },
      );
    }, PREVIEW_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, selectionKey, chipsKey, ai.version, ai.preview, model?.id, picksKey, running, off, active]);
  const provider = settings?.settings.provider ?? null;
  const header = provider ? `To ${nameOf(provider)}, ${model?.id ?? settings?.settings.model}.` : "Nothing is sent until a provider is set.";

  // Show log and the Sent record of a trimmed answer need the full stored record first.
  const trimmedAt = [logAt, sentOpen].filter((at): at is number => at !== null && !!messages.find((m) => m.role === "assistant" && m.at === at)?.record?.trimmed && !full.has(at));
  const fetchKey = thread && trimmedAt.length > 0 ? `${thread.id}:${trimmedAt.join(",")}` : null;
  // Only the records on screen are kept (memory); one closed is fetched again when it is opened again.
  useEffect(() => {
    setFull((all) => ([...all.keys()].every((at) => at === logAt || at === sentOpen) ? all : new Map([...all].filter(([at]) => at === logAt || at === sentOpen))));
  }, [logAt, sentOpen, threadId]);
  useEffect(() => {
    if (!fetchKey || !thread) return;
    let live = true;
    for (const at of trimmedAt) {
      aiAnswerRecord(thread.id, at).then(
        (r) => live && setFull((m) => new Map(m).set(at, r ? (recordOf(r) as AnswerRecord) : "This answer's record is no longer stored.")),
        (e: unknown) => live && setFull((m) => new Map(m).set(at, errorText(e))),
      );
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey]);
  /** An answer's record for its log and Sent record: the full one, a load message, or the stored one. */
  const fullRecord = (m: AiMessage): AnswerRecord | string | null => {
    const r = recordOf(m.record);
    if (!r?.trimmed) return r;
    return full.get(m.at) ?? "Loading the log...";
  };

  function pickModel(id: string, picks: ModelPicks) {
    setModels((l) => l && { ...l, current: id, models: l.models.map((m) => (m.id === id ? { ...m, picks } : m)) });
    setModelError(null);
    void setAiModelPrefs(null, id, picks).catch((e: unknown) => setModelError(`Could not save the model pick. ${errorText(e)}`));
  }

  // An Ask that left nothing gives its question back to the composer.
  // A reply to a follow-up goes back to the card's box instead.
  useEffect(() => {
    if (!failure || asking) return;
    setQuestion((q) => q || failure.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failure]);

  // The Core no longer holds the attached file (a pick on another board replaced it): its chip goes, so it is never
  // shown as going when it would not, and the Core is told. The preview names the token it asked with; an
  // Ask's failure is about the chip it sent, as the composer is shut while it runs.
  useEffect(() => {
    if (!isFileGone(sends.error) || !sends.attachment) return;
    chipApi.drop({ create: null, attachment: sends.attachment });
    forgetFile(sends.attachment);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sends]);
  useEffect(() => {
    const token = sentFile.current;
    // A reply's own file is the hook's to let go (its chip went with the first Ask).
    if (!isFileGone(failure?.error) || !token || asking) return;
    chipApi.drop({ create: null, attachment: token });
    forgetFile(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failure]);

  // A turn that ended in an error before it was answered gives its question back to the composer.
  const lastMessage = messages[messages.length - 1];
  const lastAsked = messages[messages.length - 2];
  const lastFailedAt = lastMessage?.role === "assistant" && lastAsked?.role === "user" && !lastMessage.text && !lastMessage.record?.toolUse && lastMessage.at >= mounted.current && aiErrorOf(lastMessage.record ? recordError(recordOf(lastMessage.record)!) : null) ? lastMessage.at : null;
  useEffect(() => {
    if (lastFailedAt !== null && lastAsked && !asking) setQuestion((q) => q || lastAsked.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFailedAt]);

  /** The card was left (Continue or Cancel): focus goes to the composer once it is back, never to the page. */
  const refocus = useRef(false);
  useEffect(() => {
    if (replying) refocus.current = false;
    else if (refocus.current && !working && !waiting && input.current && !input.current.disabled) {
      refocus.current = false;
      input.current.focus();
    }
  }, [replying, working, waiting]);

  // The newest turn stays in view.
  const turns = thread?.messages.length ?? 0;
  const toEnd = useCallback(() => {
    const el = chat.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  // A follow-up card is brought into view top first, so a card taller than the chat still shows its question (live
  // check L1). Only the chat scrolls: scrollIntoView would move every scrolling pane around it.
  useEffect(() => {
    const el = chat.current;
    const card = replying ? el?.querySelector<HTMLElement>(":scope > .followup") : null;
    if (!el || !card) return toEnd();
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
    el.scrollTop += card.getBoundingClientRect().top - el.getBoundingClientRect().top - pad;
  }, [turns, waiting, landed, asking, replying, toEnd]);

  // No scope on a board: the chips are focus, never a lock, and the selection goes with the board.
  const askOptions = (): AskOptions => {
    const create = chips.find((c) => c.kind === "create");
    const file = chips.find((c) => c.kind === "file");
    return { model: model?.id ?? null, picks: model?.picks ?? null, focus: chipApi.focus(), create: create?.kind === "create" ? create.diagram : null, attachment: file?.kind === "file" ? file.token : null, withSelection: !chipApi.selectionOff };
  };

  /** The word before where the user is typing that starts with `/`: where it starts and what follows the slash. */
  const slash = useMemo(() => {
    const m = /(^|\s)\/(\S*)$/.exec(question.slice(0, typedAt));
    return m ? { start: m.index + m[1].length, typed: m[2] } : null;
  }, [question, typedAt]);
  const refs = slash && slash.start !== slashClosed && frames.length > 0 ? frameRefs(frames, slash.typed) : null;
  /** Rows of frames that share a title, by row name: the list shows why they cannot be added. */
  const clashed = useMemo(() => Object.fromEntries(frames.flatMap((f, i) => (f.clash ? [[String(i), CLASH_REASON]] : []))), [frames]);
  const refRow = refs ? Math.min(slashRow, Math.max(refs.length - 1, 0)) : 0;

  /** A frame chip's kind: the frame at its place with its title, else the first frame with that title. */
  const kindOfChip = (c: { title: string; index: number }) => (frames[c.index]?.title === c.title ? frames[c.index] : frames.find((f) => f.title === c.title))?.kind ?? null;
  useEffect(() => {
    if (!slash) setSlashClosed(null);
  }, [slash]);

  /** The row picked in the `/` list becomes a frame chip, and its `/word` leaves the box. */
  function pickFrame(row: { name: string }) {
    const at = Number(row.name);
    const f = frames[at];
    // A frame whose title another has cannot be named: no chip.
    if (!f || !slash || f.clash) return;
    chipApi.addFrame(f.title, at);
    const next = question.slice(0, slash.start) + question.slice(slash.start + 1 + slash.typed.length);
    setQuestion(next);
    setTypedAt(slash.start);
    setSlashRow(0);
    requestAnimationFrame(() => input.current?.setSelectionRange(slash.start, slash.start));
  }

  function send() {
    const q = question.trim();
    if (!q || working || waiting || replying) return;
    // A new question starts its own count.
    retried.current = null;
    setQuestion("");
    setMore(0);
    sendOnce(q, askOptions(), ai.send);
  }

  /**
   * Sends with the composer's chips; once the Ask has its answer (a follow-up question is one) the kind card's and the
   * file's chips go, so each is sent once. A failed Ask keeps them for Retry, as the Core keeps the file.
   */
  function sendOnce(q: string, opts: AskOptions, how: (q: string, opts: AskOptions) => Promise<boolean | void>) {
    sentFile.current = opts.attachment;
    void Promise.resolve(how(q, opts)).then((answered) => {
      if (answered) chipApi.drop({ create: opts.create, attachment: opts.attachment });
    });
  }

  /** File: the Core's own open dialog; the file comes back as a chip, or its refusal as the note. */
  const pickingFile = useRef(false);
  function pickFile() {
    if (pickingFile.current) return;
    pickingFile.current = true;
    aiPickAttachment()
      .then(
        (f) => {
          setFileNote(null);
          // A cancelled dialog adds nothing; a new file takes the old chip's place, as it took its place in the Core.
          if (f) chipApi.addFile({ name: f.name, token: f.token });
        },
        (e: unknown) => setFileNote(errorText(e)),
      )
      .finally(() => {
        pickingFile.current = false;
      });
  }

  /** A kind card: its "New <kind>" chip, and the cursor in the box for the description. */
  function pickKind(k: DiagramKind) {
    chipApi.addCreate(k);
    input.current?.focus();
  }

  /** A chip's remove button or Backspace: a file chip lets the Core forget its file too. */
  function removeChip(i: number) {
    const c = chips[i];
    chipApi.clearNote();
    chipApi.remove(i);
    if (c?.kind === "file") forgetFile(c.token);
  }

  /**
   * How many times in a row each failure shown happened, by the failure (or its turn's time): a Retry of a failure
   * whose next one is of the same kind counts on, so a second rate limit in a row does not retry on its own.
   */
  const triesOf = useRef(new Map<unknown, number>());
  /** The failure a Retry was sent for, until the next failure is counted. */
  const retried = useRef<{ kind: string | undefined; tries: number } | null>(null);
  const triesFor = (id: unknown, error: unknown): number => {
    const known = triesOf.current.get(id);
    if (known !== undefined) return known;
    const before = retried.current;
    const n = before && before.kind === aiErrorOf(error)?.kind ? before.tries + 1 : 1;
    retried.current = null;
    triesOf.current.set(id, n);
    return n;
  };

  // A count is kept only while its failure is on screen: the failure card, or a turn still in the thread.
  useEffect(() => {
    const ats = new Set(messages.map((m) => m.at));
    for (const id of [...triesOf.current.keys()]) if (id !== failure && !(typeof id === "number" && ats.has(id))) triesOf.current.delete(id);
  }, [messages, failure]);

  // An answer that did not fail ends the run of failures: a later one, on any path, is the first again.
  const newest = messages[messages.length - 1];
  const newestRecord = newest?.role === "assistant" ? recordOf(newest.record) : null;
  const answered = newestRecord !== null && recordError(newestRecord) === null;
  useEffect(() => {
    if (answered) retried.current = null;
  }, [answered, newest]);

  /** The same question again, from an error card; the composer gives it up. */
  function retry(q: string, error?: unknown, tries = 1) {
    if (working || waiting) return;
    retried.current = { kind: aiErrorOf(error)?.kind, tries };
    setQuestion("");
    setMore(0);
    sendOnce(q, askOptions(), ai.send);
  }

  /** The text is read again from disk first, then the same question goes on it. */
  function askAgain(q: string, opts: AskOptions) {
    if (working) return;
    retried.current = null;
    setQuestion("");
    setMore(0);
    sendOnce(q, opts, ai.askAgain);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (refs && slash && !e.nativeEvent.isComposing) {
      const act = slashKey(e.key === "Tab" && !e.shiftKey ? "Enter" : e.key, refRow, refs.length);
      if (act) {
        e.preventDefault();
        if (act === "close") {
          e.stopPropagation();
          setSlashClosed(slash.start);
        }
        else if (act === "run") pickFrame(refs[refRow]);
        else setSlashRow(act.active);
        return;
      }
    }
    // Backspace in an empty box takes the last chip (Slack's and Linear's chip inputs).
    if (e.key === "Backspace" && question === "" && chips.length > 0 && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      removeChip(chips.length - 1);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function answer(m: AiMessage) {
    const record = recordOf(m.record);
    const tool = m.record?.toolUse ?? null;
    const failed = record ? recordError(record) : null;
    const at = messages.indexOf(m);
    const asked = at > 0 && messages[at - 1].role === "user" ? messages[at - 1].text : null;
    // Only the newest failed turn can be tried again.
    const newest = at === messages.length - 1 && !working && !waiting && !failure && asked !== null && !discarded.has(m.at);
    const live = waiting && waiting.threadId === thread?.id && waiting.messageAt === m.at ? waiting : null;
    if (live?.step === "remove" && ai.removal) {
      const r = ai.removal;
      // The diagrams are named on a board of several.
      return <RemoveDialog shapes={r.shapes} columns={r.columns} lines={r.lines} tables={r.tables} adds={r.adds} frames={live.frames.length > 1 ? r.frames : []} onCancel={ai.rejectAll} onReview={ai.reviewEach} onRemove={ai.removeAll} />;
    }
    return (
      <>
        <Said text={m.text} notes={record?.notes} parts={parts} onShowPart={onShowPart} />
        {failed !== null && !discarded.has(m.at) && (
          <ErrorCard
            error={failed}
            name={name}
            keySaved={settings?.keySaved}
            kept={newest}
            tries={triesFor(m.at, failed)}
            onRetry={() => asked !== null && retry(asked, failed, triesFor(m.at, failed))}
            onDiscard={() => setDiscarded((d) => new Set([...d, m.at]))}
            onAskAgain={() => asked !== null && askAgain(asked, askOptions())}
            onShowLog={record ? () => setLogAt(m.at) : undefined}
            onOpenSettings={onOpenSettings}
          />
        )}
        {live?.step === "pick" ? (
          // The unclear word's own frame is named on a board, and only its shapes are offered.
          ai.picking && <PickCard change={ai.picking.change} frame={live.frames.length > 1 ? ai.picking.frame : null} problem={live.problem} onPick={ai.pick} onCancel={ai.rejectAll} />
        ) : live?.step === "broken" && live.broke ? (
          <BrokenCard
            file={name}
            broke={live.broke}
            frame={live.frames.length > 1 ? live.broke.frame : null}
            onReview={ai.reviewEach}
            // On a board the problem names its frame, so the new Ask knows which diagram to fix.
            onAskFix={() => ai.askToFix([live.frames.length > 1 ? `${live.broke!.frame}: ${live.broke!.message}` : live.broke!.message])}
          />
        ) : live?.step === "stale" ? (
          <StaleCard file={name} line={null} nowReads={null} inEditor onDiscard={ai.rejectAll} onAskAgain={() => askAgain(live.q, live.opts)} />
        ) : live ? (
          <>
            <ProposalCard
              changes={live.proposal.changes}
              kind={kind}
              frames={live.frames.map((f) => f.title)}
              rejected={live.rejected}
              onReject={ai.reject}
              onAccept={ai.accept}
              onAcceptFrame={ai.acceptFrame}
              onRejectFrame={ai.rejectFrame}
              onRejectAll={ai.rejectAll}
              onAcceptAll={ai.acceptAll}
              onShowText={() => onShowText(ai.lines)}
              onAskFix={ai.askToFix}
            />
            {live.problem && (
              <p className="answer-p flow-assist-problem" role="status">
                {live.problem}
              </p>
            )}
          </>
        ) : landed?.messageAt === m.at ? (
          <div className="flow-landed">
            <p className="answer-p">
              <Icon name="check" size={14} />
              <span>{landed.summary}</span>
            </p>
            <div className="flow-landed-acts">
              {/* Once the landing was undone there is nothing left to undo. */}
              {!landed.undone && (
                <button type="button" className="btn pbtn2" onClick={onUndo}>
                  Undo
                  <Kbd keys="Ctrl+Z" />
                </button>
              )}
              {/* Nor anything to show: the lines it wrote are gone. */}
              {!landed.undone && (
                <button type="button" className="btn pbtn2" onClick={() => onShowText(landed.lines)}>
                  Show in the text
                </button>
              )}
            </div>
          </div>
        ) : tool && at < foldBefore ? (
          <p className="answer-p flow-assist-outcome">{foldedOutcome(tool.proposal.changes, tool.outcome)}</p>
        ) : tool ? (
          <ProposalCard changes={tool.proposal.changes} kind={kind} frames={titles} outcome={tool.outcome ? outcomeText(tool.proposal.changes, tool.outcome) : null} />
        ) : failed === null && record?.mark !== "stopped" ? (
          <p className="answer-p flow-assist-none">No changes proposed.</p>
        ) : null}
        {record && <TrimmedNote record={record} />}
        {record && foot(m, record, failed)}
      </>
    );
  }

  /**
   * Under an answer: Show log, unless its error card carries it, and the Sent line, which opens the
   * Sent record.
   */
  function foot(m: AiMessage, record: AnswerRecord, failed: unknown) {
    const errorKind = failed !== null && !discarded.has(m.at) ? aiErrorOf(failed)?.kind : undefined;
    // The assistant's error cards carry Show log; the changed-file card and the tool-off note do not.
    const cardHasLog = failed !== null && !discarded.has(m.at) && errorKind !== "fileChanged" && errorKind !== "toolOff";
    const line = sentLine(record, m.at, { tool: true });
    const opened = sentOpen === m.at ? fullRecord(m) : null;
    return (
      <>
        <div className="msg-mark">
          {!cardHasLog && (
            <button type="button" className="link-button" onClick={() => setLogAt(m.at)}>
              Show log
            </button>
          )}
          {line && (
            <button type="button" className="msg-sent" aria-expanded={sentOpen === m.at} onClick={() => setSentOpen((o) => (o === m.at ? null : m.at))}>
              {line}
            </button>
          )}
        </div>
        {typeof opened === "string" ? (
          <p className="msg-notice" role={full.has(m.at) ? "alert" : "status"}>
            {opened}
          </p>
        ) : (
          opened?.sent && <SentRecord sent={opened.sent} usage={opened.usage} notSent={mainNeverLeft(opened)} onClose={() => setSentOpen(null)} hoverText={false} />
        )}
      </>
    );
  }

  const empty = turns === 0 && !working && !off;
  /** The kind a kind card's chip asks to create: the box asks for its description. */
  const created = chips.find((c) => c.kind === "create");
  const creating = created?.kind === "create" ? created.diagram : null;
  /** An Ask runs or changes wait: the open chat stays. */
  const busy = working !== null || waiting !== null;

  /** The pane's head (the Ask panel's): `+` and the clock of the board's chats, at its end. */
  const head = (
    <div className="flow-assist-head">
      <span className="spacer" />
      <button type="button" className="icon-button" aria-label="New chat" aria-keyshortcuts="Control+Shift+N" disabled={busy} onClick={ai.newChat}>
        <Icon name="plus" size={16} />
      </button>
      <ThreadHistory
        place={ai.place}
        placeName={`${name}.flow`}
        threads={ai.threads}
        currentId={thread?.id ?? null}
        busy={busy}
        connections={NO_CONNECTIONS}
        emptyPlace={null}
        onOpen={(id) => void ai.openThread(id)}
        onRename={ai.renameThread}
        onDelete={(id) => void ai.deleteThread(id)}
        onClearAll={() => void ai.clearThreads()}
        hoverText={false}
      />
    </div>
  );

  // Show log takes the place of the thread and the composer.
  const logMessage = logAt !== null ? messages.find((m) => m.role === "assistant" && m.at === logAt) : undefined;
  if (logMessage) {
    const record = fullRecord(logMessage);
    const at = messages.indexOf(logMessage);
    const asked = at > 0 && messages[at - 1].role === "user" ? messages[at - 1].text : "";
    return (
      <div className="flow-assist" ref={root}>
        {typeof record === "string" || record === null ? (
          <div className="log-loading">
            <button type="button" className="link-button" onClick={() => setLogAt(null)}>
              Back
            </button>
            <p className="msg-notice" role={full.has(logMessage.at) ? "alert" : "status"}>
              {record ?? "This answer has no log."}
            </p>
          </div>
        ) : (
          <AnswerLog
            variant="diagram"
            file={name}
            question={asked}
            answer={logMessage.text}
            record={record}
            providerName={record.sent ? nameOf(record.sent.provider) : provider ? nameOf(provider) : undefined}
            initialStep="toolCheck"
            onBack={() => setLogAt(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flow-assist" ref={root}>
      {head}
      <div ref={chat} className="flow-chat" role="log" aria-label="Assistant conversation">
        {empty && <StartScreen onKind={pickKind} onTemplate={() => onTemplate?.()} onFile={pickFile} fileNote={fileNote} />}
        {shown.hidden > 0 && (
          <div className="msg-mark">
            <button type="button" className="link-button" onClick={() => setMore((n) => n + SHOWN_TURNS)}>
              {earlierLabel(shown.hidden)}
            </button>
          </div>
        )}
        {messages.slice(shown.first).map((m) =>
          m.role === "user" ? (
            isLeftToAi(m) ? (
              <div key={`u${m.at}`} className="umsg umsg-left">
                {LEFT_TO_AI}
              </div>
            ) : (
              <div key={`u${m.at}`} className="umsg">
                {m.text}
              </div>
            )
          ) : m === askedBack ? null : (
            <div key={`a${m.at}`} className="amsg">
              {answer(m)}
            </div>
          ),
        )}
        {working && (
          <>
            <div className={working.q === BLANK_REPLY ? "umsg umsg-left" : "umsg"}>{working.q === BLANK_REPLY ? LEFT_TO_AI : working.q}</div>
            <div className="amsg">
              {working.status && (
                <div className="steps">
                  {working.steps.map((t, i) => (
                    <div key={i} className="step done">
                      <span className="sdot2" />
                      {t}
                    </div>
                  ))}
                  <div className="step now">
                    <span className="sdot2" />
                    {working.status}
                  </div>
                </div>
              )}
              <LiveSaid source={ai.streamed} onGrow={toEnd} />
            </div>
          </>
        )}
        {ai.notSaved && (
          <p className="msg-notice" role="alert">
            {ai.notSaved}
          </p>
        )}
        {ai.chatError && (
          <p className="msg-notice" role="alert">
            {ai.chatError}
          </p>
        )}
        {failure?.note && !working && (
          <p className="msg-notice" role="alert">
            {failure.note}
          </p>
        )}
        {failure && failure.error !== null && !working && (
          <ErrorCard
            error={failure.error}
            name={name}
            keySaved={settings?.keySaved}
            kept
            tries={triesFor(failure, failure.error)}
            onRetry={() => retry(failure.q, failure.error, triesFor(failure, failure.error))}
            onDiscard={() => {
              setQuestion((q) => (q === failure.q ? "" : q));
              ai.clearFailure();
            }}
            onAskAgain={() => askAgain(failure.q, askOptions())}
            onOpenSettings={onOpenSettings}
          />
        )}
        {replying && (
          <FollowUpCard
            // A reply given back by a failed Ask is a new card's start: its box shows the reply.
            key={`${asking.question}\n${asking.reply ?? ""}`}
            question={asking.question}
            reply={asking.reply}
            onContinue={(reply) => {
              refocus.current = true;
              void ai.answer(reply);
            }}
            onCancel={() => {
              refocus.current = true;
              ai.cancelAsk();
            }}
          />
        )}
        {off && !isToolOff(failure?.error) && <ToolOffNote onOpenSettings={onOpenSettings} />}
      </div>
      {!off && (
        <div className="flow-composer">
          {working ? (
            <div className="flow-working">
              <span>{`Working on ${name}. Stop it to type.`}</span>
              <button type="button" className="btn pbtn2" onClick={ai.stop}>
                Stop
                <Kbd keys="Esc" />
              </button>
            </div>
          ) : (
            <>
              <div className="flow-composer-row">
                <div className="seg" role="radiogroup" aria-label="How changes land">
                  {(["review", "auto"] as FlowAssistMode[]).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : undefined} onClick={() => onMode(m)}>
                      {m === "review" ? "Review first" : "Auto-apply"}
                    </button>
                  ))}
                </div>
              </div>
              <Sends
                variant="diagram"
                preview={sends.preview}
                error={sends.error === null ? null : errorText(sends.error)}
                header={header}
                onToggle={() => {}}
                withTip={false}
              />
              <div className="flow-slash-anchor">
                {refs && (
                  <SlashCommands id={slashId} commands={refs} active={refRow} draft={`/${slash?.typed ?? ""}`} label="Diagrams on this board" bare unavailable={clashed} empty={`No diagram matches /${slash?.typed ?? ""}.`} onRun={pickFrame} />
                )}
                <div className="cbox">
                  <AskChips
                    chips={chips}
                    onRemove={removeChip}
                    kindOf={kindOfChip}
                  />
                  {replying && (
                    <span id={waitId} className="visually-hidden">
                      Answer the question above first.
                    </span>
                  )}
                  <textarea
                    ref={input}
                    className="cin2"
                    aria-label="Describe a change"
                    placeholder={replying ? "Answer the question above" : creating ? describeKind(creating) : "Describe a change"}
                    disabled={replying}
                    aria-describedby={replying ? waitId : undefined}
                    value={question}
                    aria-controls={refs ? slashId : undefined}
                    aria-autocomplete="list"
                    aria-activedescendant={refs && refs.length > 0 ? optionId(slashId, refs[refRow].name) : undefined}
                    onChange={(e) => {
                      setQuestion(e.target.value);
                      setTypedAt(e.target.selectionStart);
                      setSlashRow(0);
                      chipApi.clearNote();
                    }}
                    onSelect={(e) => setTypedAt(e.currentTarget.selectionStart)}
                    onKeyDown={onKey}
                  />
                  <div className="cbar">
                    <Kbd keys="Shift+Enter" />
                    <span>new line</span>
                    <span className="spacer" />
                    {models && model && <ModelPicker list={models} onPick={pickModel} hoverText={false} />}
                    <button type="button" className="btn sendb" aria-label="Send" disabled={!question.trim() || waiting !== null || replying} onClick={send}>
                      <Icon name="arrowUp" size={14} />
                    </button>
                  </div>
                </div>
              </div>
              {chipApi.note && (
                <p className="msg-notice" role="status">
                  {chipApi.note}
                </p>
              )}
            </>
          )}
          {modelError && !working && (
            <p className="msg-notice" role="alert">
              {modelError}
            </p>
          )}
          {settingsError && !working && (
            <p className="msg-notice" role="alert">
              {settingsError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
