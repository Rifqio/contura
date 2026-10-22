import type { AnswerRecord, StepKind } from "../api/types";
import Icon from "../components/Icon";
import { sentBytes, stepTime } from "./answerRecord";

export const STEP_LABEL: Record<StepKind, string> = {
  access: "Access",
  schema: "Schema",
  tables: "Tables",
  cleaning: "Cleaning",
  request: "Request",
  thinking: "Thinking",
  answer: "Answer",
  sqlCheck: "SQL check",
  outline: "Outline",
  compact: "Compact",
  rows: "Rows",
  diagram: "Diagram",
  toolCheck: "Tool check",
};

/** The first column of a row's evidence table. */
const EVIDENCE_HEAD: Partial<Record<StepKind, string>> = { tables: "Table", rows: "Table", cleaning: "Where", outline: "Name", compact: "Call", toolCheck: "Change" };

/** The Tool check row's evidence reads change, check and result (board 11.12). */
const heads = (k: StepKind): [string, string, string] => (k === "toolCheck" ? ["Change", "Check", "Result"] : [EVIDENCE_HEAD[k] ?? "Item", "Rule", "Evidence"]);

/** The model's tool input as stored, laid out when it is JSON. */
export function prettyInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

/** "You: accepted 3" under a diagram Ask that was reviewed or landed; null while its changes wait. */
export function toolOutcomeText(record: AnswerRecord): string | null {
  const o = record.toolUse?.outcome;
  if (!o) return null;
  return `You: accepted ${o.accepted.toLocaleString("en-US")}`;
}

/**
 * Tables the budget left out, as the Core counted them on the Tables row (its evidence may be cut short). A record
 * saved before the count was kept counts its "not sent" evidence rows.
 */
export function tablesLeftOut(record: AnswerRecord): number {
  const row = record.steps.find((s) => s.step === "tables");
  if (!row) return 0;
  return row.leftOut ?? row.evidence.filter((e) => e[2] === "not sent").length;
}

/**
 * The sample SELECTs that ran on the database, from the Rows row's evidence: one per table whose read was not a
 * failure (sent, "no rows" and left out by the budget all ran). Null when none ran, or the rows stage did not.
 */
export function sampleReads(record: AnswerRecord): number | null {
  const row = record.steps.find((s) => s.step === "rows");
  const ran = row ? row.evidence.filter((e) => e[2] !== "could not read").length : 0;
  return ran > 0 ? ran : null;
}

/** What stayed on this PC: rows and values unless they went, the tables left out, and the key. */
export function notSent(record: AnswerRecord): { value: string; more: string } {
  const kinds = record.sent?.kinds ?? [];
  const held = [!kinds.includes("rows") && "rows", !kinds.includes("values") && "values"].filter(Boolean) as string[];
  const left = tablesLeftOut(record);
  const tables = left > 0 ? `${left.toLocaleString("en-US")} ${left === 1 ? "table" : "tables"}` : null;
  if (held.length === 0) return { value: "The key", more: tables ?? "" };
  const value = held.join(", ");
  return { value: value[0].toUpperCase() + value.slice(1), more: [tables, "the key"].filter(Boolean).join(", ") };
}

interface Props {
  record: AnswerRecord;
  /** The Ask's Connection, named in "Ran on" (board 11.3). */
  connection: string | null;
  /** The Ask's database, in the "Ran on" cell's detail line. */
  database: string | null;
  /** The open row, by its index in `record.steps`: two rows of one kind open separately. */
  open: number | null;
  onToggle(index: number): void;
  /** A diagram Ask (board 11.12): no database cells or line; the user's outcome closes the rows. */
  variant?: "diagram";
  onCopy?(text: string): void;
}

/** The Steps tab (board 11.3): the three cells, then one fixed-wording row per step with its rule and evidence. */
export default function StepsView({ record, connection, database, open, onToggle, variant, onCopy }: Props) {
  const diagram = variant === "diagram";
  const out = notSent(record);
  const reads = sampleReads(record);
  const selects = reads === null ? "" : `${reads.toLocaleString("en-US")} ${reads === 1 ? "SELECT" : "SELECTs"}`;
  const outcome = diagram ? toolOutcomeText(record) : null;
  // The tile names the Connection; the database it ran in goes on the detail line, as a sentence like the rest.
  const ranOn = connection ?? database;
  const where = connection && database && database !== connection ? `Database ${database}. ` : "";
  return (
    <>
      {!diagram && (
        <div className="cells3">
          <div className="cell3">
            <span className="k">Sent</span>
            <span className="v mono">{record.sent ? `${sentBytes(record.sent).toLocaleString("en-US")} B` : "Nothing yet"}</span>
            <span className="k">{record.sent?.host ?? ""}</span>
          </div>
          <div className="cell3">
            <span className="k">Not sent</span>
            <span className="v">{out.value}</span>
            <span className="k">{out.more}</span>
          </div>
          <div className="cell3">
            <span className="k">{ranOn ? `Ran on ${ranOn}` : "Ran on the database"}</span>
            <span className="v">{reads === null ? "Nothing" : "Sample rows, read only"}</span>
            <span className="k">{`${where}${reads === null ? "No tools offered" : `${selects} by Contura. No tools offered`}`}</span>
          </div>
        </div>
      )}
      <div className="psteps">
        {record.steps.map((s, i) => {
          const isOpen = open === i;
          const thinking = s.step === "thinking" && record.thinking ? record.thinking : null;
          return (
            <div key={`${s.step}-${i}`}>
              <div
                className="prow"
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={() => onToggle(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggle(i);
                  }
                }}
              >
                <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} />
                <span className="lb">{STEP_LABEL[s.step]}</span>
                <span className={s.byModel ? "v model" : "v"}>{s.value}</span>
                <span className="tm">{stepTime(s.atMs)}</span>
              </div>
              {isOpen && (
                <div className="pdetail">
                  {s.rule && <p className="prule">{s.rule}</p>}
                  {s.evidence.length > 0 && (
                    <div className="ev">
                      {heads(s.step).map((h) => (
                        <span key={h} className="eh">
                          {h}
                        </span>
                      ))}
                      {s.evidence.map(([a, b, c], j) => (
                        <span key={j} className={s.step === "toolCheck" && c === "dropped" ? "ev-row drop" : "ev-row"}>
                          <span className="mono">{a}</span>
                          <span>{b}</span>
                          <span className="mono">{c}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {s.step === "toolCheck" && record.toolUse && (
                    <section className="jbox" aria-label="Stored tool input">
                      <div className="jhead">
                        <span className="t">Stored tool input</span>
                        <span className="spacer" />
                        {onCopy && (
                          <button type="button" className="icon-button" aria-label="Copy the tool input as stored" onClick={() => onCopy(record.toolUse!.input)}>
                            <Icon name="copy" size={14} />
                          </button>
                        )}
                      </div>
                      <pre className="jcode" aria-label="Input the model sent">
                        {prettyInput(record.toolUse.input)}
                      </pre>
                    </section>
                  )}
                  {thinking && (
                    <pre className="pthinking" aria-label="Thinking, as returned">
                      {thinking}
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!diagram ? (
          <div className="pdone">
            <Icon name="check" size={14} />
            {reads === null ? "Nothing ran on the database" : `Contura read sample rows: ${selects.replace("SELECT", "read-only SELECT")}. Nothing else ran on the database.`}
          </div>
        ) : (
          outcome && (
            <div className="pdone">
              <Icon name="check" size={14} />
              {outcome}
            </div>
          )
        )}
      </div>
    </>
  );
}
