// The Result node: each output column with its source and type, then the clauses (frame 6.2, ruling D1).
import type { NodeProps } from "@xyflow/react";
import CardFrame from "../diagram/CardFrame";
import { CARD_HEADER, CARD_ROW, RESULT_WIDTH } from "../diagram/metrics";
import { type QueryShape, resultHeader } from "../lang/sql/queryShape";
import { Anchors } from "./ShapeCard";

export type ResultNodeData = { shape: QueryShape };

/** The node id of the Result in every query diagram. */
export const RESULT_ID = "result";

/** Each clause line is 18 px with 4 px between, inside 6 px and 8 px padding and a 1 px rule. */
const CLAUSE_LINE = 18;
const CLAUSE_GAP = 4;
const CLAUSE_PAD = 6 + 8 + 1;

/** The Result row a port names: by index, since output names can repeat. */
export const resultPort = (index: number) => `r${index}`;

export function resultHeight(shape: QueryShape): number {
  const rows = shape.result.columns.length + (shape.result.more > 0 ? 1 : 0);
  const n = shape.result.clauses.length;
  const clauses = n === 0 ? 0 : CLAUSE_PAD + CLAUSE_LINE * n + CLAUSE_GAP * (n - 1);
  return CARD_HEADER + CARD_ROW * rows + 8 + clauses;
}

export default function ResultNode({ data, selected }: NodeProps & { data: ResultNodeData }) {
  const { result } = data.shape;
  const rows = (
    <>
      {result.columns.map((c, i) => (
        <li key={i} className="qd-result-row">
          <Anchors id={resultPort(i)} />
          <span className="qd-result-main">
            <span className="qd-row-name">{c.name}</span>
            {c.source !== c.name && <span className="qd-result-source">{c.source}</span>}
          </span>
          <span className="qd-result-type">{c.type ?? ""}</span>
        </li>
      ))}
      {result.more > 0 && (
        <li className="qd-more">
          {result.more} more {result.more === 1 ? "column" : "columns"}
        </li>
      )}
      {result.clauses.length > 0 && (
        <li className="qd-clauses">
          {result.clauses.map((c, i) => (
            <div key={i} className="qd-clause">
              <span className="qd-clause-keyword">{c.keyword}</span>
              {c.keyword === "LIMIT" ? <span className="qd-clause-number">{c.text}</span> : c.text}
            </div>
          ))}
        </li>
      )}
    </>
  );
  return (
    <div className="qd-card qd-result">
      <Anchors id="card" />
      <CardFrame
        kind="result"
        label="Result"
        name="Result"
        title={<span className="table-card-name">Result</span>}
        actions={<span className="table-card-schema">{resultHeader(data.shape)}</span>}
        rows={rows}
        count={result.columns.length + result.more}
        selected={!!selected}
        width={RESULT_WIDTH}
      />
    </div>
  );
}
