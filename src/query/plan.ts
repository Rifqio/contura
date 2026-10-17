import type { Plan, PlanNode } from "../api/types";

export type PlanFlag = { path: number[]; kind: "fullScan" | "heavyStep"; text: string };

/** A full scan of a table estimated over this many rows is worth a mark. */
export const FULL_SCAN_ROWS = 10_000;
/** A step costing more than this share of the whole plan is worth a mark. */
const HEAVY_SHARE = 0.5;

const fmt = (n: number) => n.toLocaleString("en-US");

/** What a step costs on its own: the server's cost adds up the children, so they are taken off. */
function ownCost(node: PlanNode): number | null {
  if (node.cost == null) return null;
  const below = node.children.reduce((a, c) => a + (c.cost ?? 0), 0);
  return Math.max(0, node.cost - below);
}

/** Marks for the plan tree: full scans of big tables and steps that carry most of the cost. */
export function planFlags(plan: Plan): PlanFlag[] {
  const out: PlanFlag[] = [];
  const visit = (nodes: PlanNode[], parent: number[]) =>
    nodes.forEach((node, i) => {
      const path = [...parent, i];
      if (node.fullScan && node.rows != null && node.rows > FULL_SCAN_ROWS) {
        out.push({ path, kind: "fullScan", text: `Full scan of ${node.object ?? "a table"}, about ${fmt(node.rows)} rows` });
      }
      const own = ownCost(node);
      if (plan.totalCost && own != null && own / plan.totalCost > HEAVY_SHARE) {
        out.push({
          path,
          kind: "heavyStep",
          text: `This step is ${Math.round((own / plan.totalCost) * 100)} percent of the cost`,
        });
      }
      visit(node.children, path);
    });
  visit(plan.nodes, []);
  return out;
}
