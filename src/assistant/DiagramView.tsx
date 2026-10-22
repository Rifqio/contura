import type { ReactNode } from "react";
import type { AnswerActionKind, AnswerRecord, LogLine, ProcessStep, StepKind } from "../api/types";
import Icon from "../components/Icon";
import { mainNeverLeft, stepTime } from "./answerRecord";
import { notSent, STEP_LABEL } from "./StepsView";

interface Props {
  record: AnswerRecord;
  question: string;
  /** The answer text so far, for the bytes that came back. */
  answer: string;
  providerName: string;
  /** Where the model has no path to: the Ask's Connection. */
  connection: string | null;
  /** The answer is still being written: the boxes still to come show as pending. */
  live: boolean;
  /** The picked box, by its row index in `record.steps`. */
  picked: number | null;
  onPick(index: number | null): void;
  onOpenInSteps(index: number): void;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const bytes = (n: number) => `${n.toLocaleString("en-US")} B`;

/** The "You:" box of what the user did with the answer's SQL (board 11.3). */
const YOU: Record<AnswerActionKind, string> = {
  inserted: "You: Inserted into the editor",
  insertedCommented: "You: Inserted commented out",
  openedInNewTab: "You: Opened in a new tab",
};

/** The failed outline call's box (board 11.7): the kind its Warn line names, in words. */
const OUTLINE_FAILURE: Record<string, string> = {
  rateLimited: "Rate limited",
  overloaded: "Busy",
  timeout: "Timed out",
  network: "Network error",
  provider: "Provider error",
  badKey: "Key refused",
  outOfCredit: "Out of credit",
  modelRetired: "Model retired",
  tooLarge: "Too large",
  badResponse: "Bad reply",
  badReply: "Bad reply",
};

/** Why the outline step could not pick, from its Warn line in the log: "Rate limited". */
function outlineFailure(log: LogLine[]): string {
  const line = log.find((l) => l.source === "outline" && l.level === "warn");
  const kind = line?.fields.find(([k]) => k === "error")?.[1];
  return (kind && OUTLINE_FAILURE[kind]) ?? "Failed";
}

/** "Tables, 2 of 6" from the Tables row's "2 of 6 picked". */
function boxLabel(s: ProcessStep): string {
  if (s.step === "schema") return "Schema, catalog only";
  if (s.step === "tables") {
    const m = /(\d[\d,]*) of (\d[\d,]*)/.exec(s.value);
    return m ? `Tables, ${m[1]} of ${m[2]}` : "Tables";
  }
  if (s.step === "outline") {
    const m = /from (\d[\d,]*)/.exec(s.value);
    return m ? `Outline, ${m[1]} ${m[1] === "1" ? "table" : "tables"}` : "Outline";
  }
  if (s.step === "sqlCheck") return `SQL check, ${s.value.split(", ")[0]}`;
  return STEP_LABEL[s.step];
}

/**
 * The Diagram tab (board 11.3): the record drawn as DOM boxes in three zones, the one line that leaves the PC in the
 * accent, the database as a store box reached only for its catalog, and no path from the model to the database.
 */
export default function DiagramView({ record, question, answer, providerName, connection, live, picked, onPick, onOpenInSteps }: Props) {
  const at = (k: StepKind) => record.steps.findIndex((s) => s.step === k);
  const step = (k: StepKind) => record.steps[at(k)] ?? null;
  const box = (k: StepKind): ReactNode => {
    const s = step(k);
    const idx = at(k);
    const model = k === "thinking" || k === "answer";
    if (!s) {
      if (!live) return null;
      return (
        <div key={k} className={model ? "dbox model pending" : "dbox pending"} aria-hidden="true">
          <span className="dlab">{STEP_LABEL[k]}</span>
        </div>
      );
    }
    return (
      <button
        key={k}
        type="button"
        className={`dbox${model ? " model" : ""}${picked === idx ? " on" : ""}`}
        aria-pressed={picked === idx}
        onClick={() => onPick(picked === idx ? null : idx)}
      >
        <span className="dlab">{boxLabel(s)}</span>
        {model && <span className="dmodel">model</span>}
        <span className="t">{stepTime(s.atMs)}</span>
      </button>
    );
  };
  const join = (nodes: ReactNode[]) =>
    nodes.filter(Boolean).flatMap((n, i) => (i === 0 ? [n] : [<div key={`l${i}`} className="vlink" />, n]));
  const sent = record.sent;
  const back = new TextEncoder().encode(answer).length;
  const chosen = picked != null ? (record.steps[picked] ?? null) : null;
  const outline = step("outline");
  const outlineIdx = at("outline");
  const outlineSent = sent?.outline ?? null;
  const out = notSent(record);
  const pcFirst: ReactNode[] = [
    <div key="q" className="dbox">
      <span className="dlab">Your question</span>
      <span className="t">{`${question.length.toLocaleString("en-US")} chars`}</span>
    </div>,
    <div key="access" className="drow">
      {box("access")}
      {step("access") && (
        <div className="dside">
          <span className="dsl" />
          <div className="dbox dashed">
            <span className="dlab">Not shared</span>
            <span className="t">{[out.value, out.more].filter(Boolean).join(", ").toLowerCase()}</span>
          </div>
        </div>
      )}
    </div>,
    step("schema") && (
      <div key="schema" className="drow">
        {box("schema")}
        <div className="dside">
          <span className="dsl" />
          <span className="dnote">catalog only, no rows</span>
        </div>
      </div>
    ),
    outline ? (
      box("outline")
    ) : live && step("schema") && !step("tables") ? (
      <div key="outline" className="dbox pending" aria-hidden="true">
        <span className="dlab">Outline</span>
      </div>
    ) : null,
  ];
  const pcAfter: ReactNode[] = [
    step("tables") && (
      <div key="tables" className="drow">
        {box("tables")}
        <div className="dside">
          <span className="dsl" />
          <span className="dnote">catalog only, no rows</span>
        </div>
      </div>
    ),
    box("cleaning"),
  ];
  // The outline call crosses to the provider on its own (board 11.7), once its request left; a failed one shows why
  // it could not pick, with no picks.
  const outlineCross = outline && outlineSent;
  const outlineFailed = outline?.value.startsWith("could not pick") ?? false;
  // Unsplit, the zone is one list, so the connector between Schema (or Outline) and Tables stays.
  const onPC = join(outlineCross ? pcFirst : [...pcFirst, ...pcAfter]);
  const onPCAfter = join(pcAfter);
  const hasStore = step("schema") || step("tables");
  // The connection failed first, or the Ask ended after the outline step: the main request never left this PC.
  const left = sent && !mainNeverLeft(record) ? sent : null;
  const you = record.actions.map((a, i) => (
    <div key={`you${i}`} className="dbox">
      <span className="dlab">{YOU[a.kind]}</span>
      <span className="t" />
    </div>
  ));

  const store = hasStore && (
    <div className="dstore">
      <Icon name="database" size={14} />
      {connection ?? "The database"}
    </div>
  );
  const providerZone = (content: ReactNode) => (
    <div className="zone">
      <span className="zt">{sent ? `${providerName}, ${sent.model}` : providerName}</span>
      {content}
    </div>
  );

  return (
    <div className="diag">
      <div className="zone">
        <span className="zt">On this PC</span>
        {onPC}
        {!outlineCross && store}
      </div>
      {outlineCross && (
        <>
          <div className="dcross">
            <span className="dline accent" />
            <span className="dchip accent">{`${bytes(outlineSent.bytes)} leave your PC`}</span>
            <span className="dnote">outline call</span>
          </div>
          {providerZone(
            outlineFailed ? (
              <button
                type="button"
                className={`dbox bad${picked === outlineIdx ? " on" : ""}`}
                aria-pressed={picked === outlineIdx}
                onClick={() => onPick(picked === outlineIdx ? null : outlineIdx)}
              >
                <span className="dlab">Could not pick</span>
                <span className="t">{outlineFailure(record.log)}</span>
              </button>
            ) : (
              <button
                type="button"
                className={`dbox model${picked === outlineIdx ? " on" : ""}`}
                aria-pressed={picked === outlineIdx}
                onClick={() => onPick(picked === outlineIdx ? null : outlineIdx)}
              >
                <span className="dlab">{`Picked ${count(outlineSent.pickedAreas, "area", "areas")}, ${count(outlineSent.pickedTables, "table", "tables")}`}</span>
                <span className="dmodel">model</span>
              </button>
            ),
          )}
          <div className="zone">
            <span className="zt">On this PC</span>
            {onPCAfter}
            {store}
          </div>
        </>
      )}
      {left && (
        <div className="dcross">
          <span className="dline accent" />
          <span className="dchip accent">{`${bytes(left.bytes)} leave your PC`}</span>
        </div>
      )}
      {sent && !left && (
        <div className="dcross">
          <span className="dline" />
          <span className="dchip">{sent.bytes === 0 ? "Not sent" : "Not sent, no connection"}</span>
        </div>
      )}
      {(sent || live) && (
        providerZone(join([box("thinking"), box("answer")]))
      )}
      {sent && answer && (
        <div className="dcross">
          <span className="dline" />
          <span className="dchip">{`${bytes(back)} back`}</span>
        </div>
      )}
      {(step("sqlCheck") || live || you.length > 0) && (
        <div className="zone">
          <span className="zt">Back on this PC</span>
          {join([box("sqlCheck"), ...you])}
        </div>
      )}
      <div className="dnopath">
        <Icon name="close" size={14} />
        {`No tools: the model has no path to ${connection ?? "the database"}.`}
      </div>
      {chosen && (
        <section className="ddetail" aria-label={STEP_LABEL[chosen.step]}>
          <div className="ddetail-head">
            <span className="t">{STEP_LABEL[chosen.step]}</span>
            <span className={chosen.byModel ? "v model" : "v"}>{chosen.value}</span>
            <span className="spacer" />
            <span className="tm">{stepTime(chosen.atMs)}</span>
          </div>
          {chosen.rule && <p className="prule">{chosen.rule}</p>}
          <button type="button" className="link-button" onClick={() => picked != null && onOpenInSteps(picked)}>
            Open in Steps
          </button>
        </section>
      )}
    </div>
  );
}
