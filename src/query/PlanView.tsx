import { useMemo, useState } from "react";
import type { Plan, PlanNode } from "../api/types";
import Icon from "../components/Icon";
import Switch from "../components/Switch";
import { type PlanFlag, planFlags } from "./plan";

const fmt = (n: number) => n.toLocaleString("en-US");

interface Row {
  node: PlanNode;
  path: number[];
  flags: PlanFlag[];
}

function flatten(nodes: PlanNode[], flags: PlanFlag[], parent: number[] = []): Row[] {
  return nodes.flatMap((node, i) => {
    const path = [...parent, i];
    const mine = flags.filter((f) => f.path.length === path.length && f.path.every((p, k) => p === path[k]));
    return [{ node, path, flags: mine }, ...flatten(node.children, flags, path)];
  });
}

/** The Explain answer: an indented tree of steps with flags on the costly ones, and the server's own text one switch away. */
export default function PlanView({ plan }: { plan: Plan }) {
  const [raw, setRaw] = useState(false);
  const rows = useMemo(() => flatten(plan.nodes, planFlags(plan)), [plan]);
  return (
    <div className="plan-view">
      <div className="plan-head">
        <Switch checked={raw} onChange={setRaw} label="Show raw plan" />
      </div>
      {raw ? (
        <pre className="plan-raw">{plan.raw}</pre>
      ) : rows.length === 0 ? (
        <p className="muted plan-empty">The server returned no steps for this statement.</p>
      ) : (
        <div role="tree" aria-label="Plan" className="plan-tree">
          {rows.map(({ node, path, flags }) => (
            <div
              key={path.join(".")}
              role="treeitem"
              aria-level={path.length}
              aria-selected="false"
              className={flags.length ? "plan-step plan-step-flagged" : "plan-step"}
              style={{ paddingLeft: `calc(var(--spacing-md) + ${path.length - 1} * var(--spacing-lg))` }}
            >
              <div className="plan-line">
                <span className="plan-op">{node.label}</span>
                {node.object && <span className="plan-object">{node.object}</span>}
                <span className="spacer" />
                {node.rows != null && <span className="plan-num">{fmt(node.rows)} rows</span>}
                {node.cost != null && <span className="plan-num">cost {fmt(node.cost)}</span>}
              </div>
              {flags.map((f) => (
                <div key={f.kind} className="plan-flag">
                  <Icon name="warning" size={14} />
                  <span>{f.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
