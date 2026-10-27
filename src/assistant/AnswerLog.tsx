import { useState } from "react";
import type { AnswerRecord, DialectKind, StepKind } from "../api/types";
import Icon from "../components/Icon";
import { logText } from "./answerRecord";
import { secondsText } from "./answerStream";
import DiagramView from "./DiagramView";
import LogView from "./LogView";
import { NOT_KEPT } from "./SentRecord";
import StepsView from "./StepsView";

type Tab = "log" | "steps" | "diagram";

const TABS: [Tab, string][] = [
  ["log", "Log"],
  ["steps", "Steps"],
  ["diagram", "Diagram"],
];

interface Props {
  question: string;
  /** The answer text so far, for the bytes that came back. */
  answer?: string;
  record: AnswerRecord;
  /** The answer is still being written: the record grows as events arrive. */
  live?: boolean;
  /** The Ask's Connection, named in "Ran on" and "no path to". */
  connection?: string | null;
  /** The Ask's database or schema, on the "Ran on" cell's detail line. */
  database?: string | null;
  providerName?: string;
  /** Opens on the Steps tab with this step's row open (the first of that kind), as Open does from AI settings. */
  initialStep?: StepKind;
  /** Called by the back button; omitted when the log sits in a dialog that has its own Close, and no back button shows. */
  onBack?(): void;
  /**
   * A diagram Ask (board 11.12): opens on Steps, with the Diagram and Tool check rows and no database; the Diagram tab
   * draws the one tool. No hover text, as in the diagram tab's side panel.
   */
  variant?: "diagram";
  /** The diagram's name, `<file>.flow`. */
  file?: string;
  /** The Ask's dialect, for the checked statements' colours. */
  dialect?: DialectKind;
}

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

/**
 * Show log (boards 11.3 and 11.6): the record of how one answer was made, in place of the thread. Three tabs over one
 * record: Log (opens first), Steps and Diagram.
 */
export default function AnswerLog({ question, answer = "", record, live = false, connection = null, database = null, providerName, initialStep, onBack, variant, file, dialect = "postgres" }: Props) {
  const diagram = variant === "diagram";
  const first = initialStep ? record.steps.findIndex((s) => s.step === initialStep) : -1;
  const [tab, setTab] = useState<Tab>(initialStep || diagram ? "steps" : "log");
  const [openStep, setOpenStep] = useState<number | null>(first >= 0 ? first : null);
  const [picked, setPicked] = useState<number | null>(null);
  const [exact, setExact] = useState(false);
  const total = record.millis ?? (record.log.length ? record.log[record.log.length - 1].atMs : 0);
  const provider = providerName ?? record.sent?.provider ?? "";

  return (
    <section className="alog" aria-label="Answer log">
      <div className="alog-head">
        {onBack && (
          <button type="button" className="icon-button" aria-label="Back to the answer" title={diagram ? undefined : "Back to the answer"} onClick={onBack}>
            <Icon name="chevronLeft" size={16} />
          </button>
        )}
        <span className="t">Answer log</span>
        <span className="spacer" />
        <span className="alog-time">{secondsText(total)}</span>
      </div>
      <div className="alog-tabs" role="tablist" aria-label="Process views">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            className={tab === key ? "alog-tab on" : "alog-tab"}
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              setExact(false);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="alog-body">
        {question && <p className="alog-for">{`For: ${question}`}</p>}
        {exact ? (
          <section className="alog-exact" aria-label="Exactly what was sent">
            {record.sent?.exact != null ? <pre>{record.sent.exact}</pre> : <p className="alog-note">{NOT_KEPT}</p>}
          </section>
        ) : tab === "log" ? (
          <LogView
            lines={record.log}
            onCopy={copy}
            hoverText={!diagram}
            bodies={{ answer, thinking: record.thinking ?? null, sqlBlocks: record.sqlBlocks ?? [], dialect }}
          />
        ) : tab === "steps" ? (
          <StepsView
            record={record}
            connection={connection}
            database={database}
            open={openStep}
            onToggle={(s) => setOpenStep((o) => (o === s ? null : s))}
            variant={variant}
            onCopy={copy}
            answer={answer}
            dialect={dialect}
          />
        ) : (
          <DiagramView
            record={record}
            question={question}
            answer={answer}
            providerName={provider}
            connection={connection}
            live={live}
            picked={picked}
            onPick={setPicked}
            onOpenInSteps={(s) => {
              setOpenStep(s);
              setTab("steps");
            }}
            variant={variant}
            file={file ?? record.toolUse?.file ?? ""}
          />
        )}
      </div>
      <div className="alog-foot">
        <button type="button" className="button button-small" onClick={() => copy(logText(record.log))}>
          <Icon name="copy" size={14} />
          Copy record
        </button>
        <span className="spacer" />
        <button type="button" className="link-button" aria-pressed={exact} onClick={() => setExact((x) => !x)}>
          Show exactly what was sent
        </button>
      </div>
    </section>
  );
}
