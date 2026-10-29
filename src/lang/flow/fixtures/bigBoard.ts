// A5's board at the limit, for the perf tests: 50 frames, each 200 shapes (198 nodes in two groups, and the groups,
// which count as shapes) and 300 labelled links, so 10,000 shapes and 15,000 links in all.
import type { ProposedChange } from "../../../api/types";

export const FRAMES = 50;
export const NODES = 198;
export const LINKS = 300;
export const TYPED_FRAME = 25;

/** Frame `k`; `typed` is added to its last link's label, as typing in it would. */
export function frame(k: number, typed = ""): string {
  const lines = [`diagram flow "Area ${k}"`, ""];
  for (const [g, side] of ["Left", "Right"].entries()) {
    lines.push(`${side} ${k} {`);
    for (let i = 0; i < NODES / 2; i++) lines.push(`  Step ${g * (NODES / 2) + i}`);
    lines.push("}");
  }
  for (let i = 0; i < LINKS; i++) lines.push(`Step ${i % NODES} > Step ${(i * 7 + 1) % NODES}: go ${i}${i === LINKS - 1 ? typed : ""}`);
  return `${lines.join("\n")}\n`;
}

const BEFORE = Array.from({ length: 25 }, (_, k) => `${frame(k)}\n`).join("");
const AFTER = Array.from({ length: FRAMES - 26 }, (_, k) => `\n${frame(k + 26)}`).join("");

/** The whole board; `typed` lands in frame 25's last link label. */
export const board = (typed = "") => `${BEFORE}${frame(TYPED_FRAME, typed)}${AFTER}`;

/** The frames `bigProposal` changes: five, spread over the board. */
export const PROPOSAL_FRAMES = [0, 12, TYPED_FRAME, 37, 49];

/**
 * A 40-change proposal over the five `PROPOSAL_FRAMES`, eight in each, every one Ok: three new shapes,
 * two lines to them, a relabel, a rename and a move between the frame's groups.
 */
export function bigProposal(): ProposedChange[] {
  const out: ProposedChange[] = [];
  const add = (frame: string, op: ProposedChange["op"], dependsOn: number[] = []) => out.push({ index: out.length, op, status: { kind: "ok" }, dependsOn, frame });
  for (const k of PROPOSAL_FRAMES) {
    const f = `Area ${k}`;
    const first = out.length;
    for (let i = 0; i < 3; i++) add(f, { add_node: { name: `New ${i}`, group: `Left ${k}` } });
    add(f, { add_flow: { from: "Step 3", to: "New 0", label: "next" } }, [first]);
    add(f, { add_flow: { from: "New 1", to: "New 2" } }, [first + 1, first + 2]);
    add(f, { relabel_flow: { from: "Step 0", to: "Step 1", label: "first" } });
    add(f, { rename_node: { target: "Step 197", name: "Last step" } });
    add(f, { move_to_group: { target: "Step 5", group: `Right ${k}` } });
  }
  return out;
}
