import type { AnswerRecord, StepKind } from "../api/types";
import Icon from "../components/Icon";
import { stepTime } from "./answerRecord";

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
};

/** The first column of a row's evidence table. */
const EVIDENCE_HEAD: Partial<Record<StepKind, string>> = { tables: "Table", cleaning: "Where", outline: "Name" };

/**
 * Tables the budget left out, as the Core counted them on the Tables row (its evidence may be cut short). A record
 * saved before the count was kept counts its "not sent" evidence rows.
 */
export function tablesLeftOut(record: AnswerRecord): number {
  const row = record.steps.find((s) => s.step === "tables");
  if (!row) return 0;
  return row.leftOut ?? row.evidence.filter((e) => e[2] === "not sent").length;
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
  /** Where nothing ran: the Ask's database or Connection. */
  database: string | null;
  /** The open row, by its index in `record.steps`: two rows of one kind open separately. */
  open: number | null;
  onToggle(index: number): void;
}

/** The Steps tab (board 11.3): the three cells, then one fixed-wording row per step with its rule and evidence. */
export default function StepsView({ record, database, open, onToggle }: Props) {
  const out = notSent(record);
  return (
    <>
      <div className="cells3">
        <div className="cell3">
          <span className="k">Sent</span>
          <span className="v mono">{record.sent ? `${record.sent.bytes.toLocaleString("en-US")} B` : "Nothing yet"}</span>
          <span className="k">{record.sent?.host ?? ""}</span>
        </div>
        <div className="cell3">
          <span className="k">Not sent</span>
          <span className="v">{out.value}</span>
          <span className="k">{out.more}</span>
        </div>
        <div className="cell3">
          <span className="k">{database ? `Ran on ${database}` : "Ran on the database"}</span>
          <span className="v">Nothing</span>
          <span className="k">No tools offered</span>
        </div>
      </div>
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
                      <span className="eh">{EVIDENCE_HEAD[s.step] ?? "Item"}</span>
                      <span className="eh">Rule</span>
                      <span className="eh">Evidence</span>
                      {s.evidence.map(([a, b, c], j) => (
                        <span key={j} className="ev-row">
                          <span className="mono">{a}</span>
                          <span>{b}</span>
                          <span className="mono">{c}</span>
                        </span>
                      ))}
                    </div>
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
        <div className="pdone">
          <Icon name="check" size={14} />
          Nothing ran on the database
        </div>
      </div>
    </>
  );
}
