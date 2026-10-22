import { useState } from "react";
import type { AnswerRecord } from "../api/types";
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
  /** The Ask's database, named in "Ran on"; the Connection when absent. */
  database?: string | null;
  providerName?: string;
  onBack(): void;
}

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

/**
 * Show log (boards 11.3 and 11.6): the record of how one answer was made, in place of the thread. Three tabs over one
 * record: Log (opens first), Steps and Diagram.
 */
export default function AnswerLog({ question, answer = "", record, live = false, connection = null, database = null, providerName, onBack }: Props) {
  const [tab, setTab] = useState<Tab>("log");
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [exact, setExact] = useState(false);
  const total = record.millis ?? (record.log.length ? record.log[record.log.length - 1].atMs : 0);
  const provider = providerName ?? record.sent?.provider ?? "";

  return (
    <section className="alog" aria-label="Answer log">
      <div className="alog-head">
        <button type="button" className="icon-button" aria-label="Back to the answer" title="Back to the answer" onClick={onBack}>
          <Icon name="chevronLeft" size={16} />
        </button>
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
        <p className="alog-for">{`For: ${question}`}</p>
        {exact ? (
          <section className="alog-exact" aria-label="Exactly what was sent">
            {record.sent?.exact != null ? <pre>{record.sent.exact}</pre> : <p className="alog-note">{NOT_KEPT}</p>}
          </section>
        ) : tab === "log" ? (
          <LogView lines={record.log} onCopy={copy} />
        ) : tab === "steps" ? (
          <StepsView
            record={record}
            database={database ?? connection}
            open={openStep}
            onToggle={(s) => setOpenStep((o) => (o === s ? null : s))}
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
