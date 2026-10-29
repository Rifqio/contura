import type { ReactNode } from "react";
import type { AnswerActionKind, AnswerRecord, LogLine, ProcessStep, StepKind } from "../api/types";
import Icon from "../components/Icon";
import { mainNeverLeft, stepTime } from "./answerRecord";
import { notSent, sampleReads, STEP_LABEL, toolOutcomeText } from "./StepsView";
import { thisComputer, yourComputer } from "../platform";

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
  /** A diagram Ask: no database, one tool, and the Tool check box opens its row in Steps. */
  variant?: "diagram";
  /** The diagram's name, `<file>.flow`, for the one-tool line. */
  file?: string;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const bytes = (n: number) => `${n.toLocaleString("en-US")} B`;

/** The "You:" box of what the user did with the answer's SQL. */
const YOU: Record<AnswerActionKind, string> = {
  inserted: "You: Inserted into the editor",
  insertedCommented: "You: Inserted commented out",
  openedInNewTab: "You: Opened in a new tab",
};

/** The failed outline call's box: the kind its Warn line names, in words. */
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
  if (s.step === "compact") {
    const m = /^(\d[\d,]*) messages?/.exec(s.value);
    return m ? `Compact, ${m[1]} ${m[1] === "1" ? "message" : "messages"}` : "Compact";
  }
  if (s.step === "rows") {
    const asked = s.evidence.length;
    const read = s.evidence.filter((e) => /^\d[\d,]* rows?,/.test(e[2])).length;
    return asked > 0 ? `Rows, ${read} of ${asked} ${asked === 1 ? "table" : "tables"}` : "Rows";
  }
  if (s.step === "sqlCheck") return `SQL check, ${s.value.split(", ")[0]}`;
  return STEP_LABEL[s.step];
}

/**
 * The Diagram tab: the record drawn as DOM boxes in three zones, the one line that leaves the PC in the
 * accent, the database as a store box reached only for its catalog, and no path from the model to the database.
 */
export default function DiagramView({ record, question, answer, providerName, connection, live, picked, onPick, onOpenInSteps, variant, file = "" }: Props) {
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
  if (variant === "diagram") {
    return (
      <DiagramAskView
        record={record}
        question={question}
        providerName={providerName}
        file={file}
        box={box}
        join={join}
        detail={(s) =>
          s && (
            <section className="ddetail" aria-label={STEP_LABEL[s.step]}>
              <div className="ddetail-head">
                <span className="t">{STEP_LABEL[s.step]}</span>
                <span className={s.byModel ? "v model" : "v"}>{s.value}</span>
                <span className="spacer" />
                <span className="tm">{stepTime(s.atMs)}</span>
              </div>
              {s.rule && <p className="prule">{s.rule}</p>}
              <button type="button" className="link-button" onClick={() => picked != null && onOpenInSteps(picked)}>
                Open in Steps
              </button>
            </section>
          )
        }
        chosen={picked != null ? (record.steps[picked] ?? null) : null}
        onOpenInSteps={onOpenInSteps}
      />
    );
  }
  const back = new TextEncoder().encode(answer).length;
  const chosen = picked != null ? (record.steps[picked] ?? null) : null;
  const outline = step("outline");
  const outlineIdx = at("outline");
  const outlineSent = sent?.outline ?? null;
  const compact = step("compact");
  const compactIdx = at("compact");
  const summarySent = sent?.summary ?? null;
  // The summary or compaction call crosses on its own, like the outline call.
  const summaryCross = compact && summarySent;
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
  const reads = sampleReads(record);
  const rowsStep = step("rows");
  // Board 11.10: the Rows box reaches the database with its own read-only line; the catalog box is not drawn then.
  // With no SELECT run (no named table, every read failed), the Rows box has no read line and the catalog box stays.
  const readRows = rowsStep !== null && reads !== null;
  const rowsBox = !rowsStep ? null : !readRows ? (
    box("rows")
  ) : (
    <div key="rows" className="drow">
      {box("rows")}
      <div className="dside">
        <span className="dread" aria-hidden="true">
          <Icon name="arrowLeft" size={14} />
          <span className="ln" />
        </span>
        <div className="dbox store">
          <Icon name="database" size={14} />
          <span className="dstore2">
            <span>{connection ?? "The database"}</span>
            <span className="dnote">{`${count(reads ?? 0, "SELECT", "SELECTs")}, read only, by Contura`}</span>
          </span>
        </div>
      </div>
    </div>
  );
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
    rowsBox,
    box("cleaning"),
    compact && !summaryCross && box("compact"),
  ];
  // The outline call crosses to the provider on its own, once its request left; a failed one shows why
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

  const store = hasStore && !readRows && (
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
        <span className="zt">{`On ${thisComputer()}`}</span>
        {onPC}
        {!outlineCross && store}
      </div>
      {outlineCross && (
        <>
          <div className="dcross">
            <span className="dline accent" />
            <span className="dchip accent">{`${bytes(outlineSent.bytes)} leave ${yourComputer()}`}</span>
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
            <span className="zt">{`On ${thisComputer()}`}</span>
            {onPCAfter}
            {store}
          </div>
        </>
      )}
      {summaryCross && (
        <>
          <div className="dcross">
            <span className="dline accent" />
            <span className="dchip accent">{`${bytes(summarySent.bytes)} leave ${yourComputer()}`}</span>
            <span className="dnote">{summarySent.kind === "compact" ? "compaction call" : "summary call"}</span>
          </div>
          {providerZone(
            <button
              type="button"
              className={`dbox model${picked === compactIdx ? " on" : ""}`}
              aria-pressed={picked === compactIdx}
              onClick={() => onPick(picked === compactIdx ? null : compactIdx)}
            >
              <span className="dlab">{`${summarySent.kind === "compact" ? "Compaction" : "Summary"}, ${count(summarySent.messages, "message", "messages")}`}</span>
              <span className="dmodel">model</span>
            </button>,
          )}
          <div className="zone">
            <span className="zt">{`On ${thisComputer()}`}</span>
            {box("compact")}
          </div>
        </>
      )}
      {left && (
        <div className="dcross">
          <span className="dline accent" />
          <span className="dchip accent">{`${bytes(left.bytes)} leave ${yourComputer()}`}</span>
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
          <span className="zt">{`Back on ${thisComputer()}`}</span>
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

/**
 * The Diagram tab of a diagram Ask: the question, the .flow text and its cleaning on this PC, the one
 * crossing, the model's answer and its proposal, then the Tool check and what the user did. No database box: the
 * one tool can only suggest edits to the file.
 */
function DiagramAskView({
  record,
  question,
  providerName,
  file,
  box,
  join,
  detail,
  chosen,
  onOpenInSteps,
}: {
  record: AnswerRecord;
  question: string;
  providerName: string;
  file: string;
  box(k: StepKind): ReactNode;
  join(nodes: ReactNode[]): ReactNode[];
  detail(s: ProcessStep | null): ReactNode;
  chosen: ProcessStep | null;
  onOpenInSteps(index: number): void;
}) {
  const sent = record.sent;
  const left = sent && !mainNeverLeft(record) ? sent : null;
  const diagramAt = record.steps.findIndex((s) => s.step === "diagram");
  const checkAt = record.steps.findIndex((s) => s.step === "toolCheck");
  const check = record.steps[checkAt] ?? null;
  // What the model proposed, as the Tool check counted it ("4 proposed, 1 dropped"), else the stored proposal.
  const counted = check ? /^(\d[\d,]*) proposed/.exec(check.value) : null;
  const proposed = counted ? Number(counted[1].replace(/,/g, "")) : (record.toolUse?.proposal.changes.length ?? null);
  const outcome = toolOutcomeText(record);
  const diagramBox =
    diagramAt >= 0 ? (
      <div key="diagram" className="dbox">
        <span className="dlab">Diagram</span>
        <span className="t">{record.steps[diagramAt].value}</span>
      </div>
    ) : null;
  return (
    <div className="diag">
      <div className="zone">
        <span className="zt">{`On ${thisComputer()}`}</span>
        {join([
          <div key="q" className="dbox">
            <span className="dlab">Your question</span>
            {/* Opened from Settings, the question is not known: no count rather than "0 chars". */}
            {question && <span className="t">{`${question.length.toLocaleString("en-US")} chars`}</span>}
          </div>,
          diagramBox,
          box("cleaning"),
        ])}
      </div>
      {left && (
        <div className="dcross">
          <span className="dline accent" />
          <span className="dchip accent">{`${bytes(left.bytes)} leave ${yourComputer()}`}</span>
        </div>
      )}
      {sent && !left && (
        <div className="dcross">
          <span className="dline" />
          <span className="dchip">{sent.bytes === 0 ? "Not sent" : "Not sent, no connection"}</span>
        </div>
      )}
      {sent && (
        <div className="zone">
          <span className="zt">{`${providerName}, ${sent.model}`}</span>
          {join([
            box("answer"),
            proposed !== null && (
              <div key="proposed" className="dbox model">
                <span className="dlab">{`Proposed ${count(proposed, "change", "changes")}`}</span>
                <span className="dmodel">model</span>
              </div>
            ),
          ])}
        </div>
      )}
      {(check || outcome) && (
        <>
          <div className="dcross">
            <span className="dline" />
          </div>
          <div className="zone">
            <span className="zt">{`Back on ${thisComputer()}`}</span>
            {join([
              check && (
                <button key="check" type="button" className="dbox" aria-label={`Tool check, ${check.value}. Open in Steps`} onClick={() => onOpenInSteps(checkAt)}>
                  <span className="dlab">Tool check</span>
                  <span className="t">{check.value}</span>
                </button>
              ),
              outcome && (
                <div key="you" className="dbox you">
                  <span className="dlab">{outcome}</span>
                </div>
              ),
            ])}
          </div>
        </>
      )}
      <div className="dnopath dtool">
        <Icon name="edit" size={14} />
        {`One tool: it can only suggest edits to ${file}.`}
      </div>
      {detail(chosen)}
    </div>
  );
}
