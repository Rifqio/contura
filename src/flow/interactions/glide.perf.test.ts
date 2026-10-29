import { expect, test } from "vitest";
import { applyLive } from "../../diagram/livePositions";
import type { FlowDoc } from "../../lang/flow/model";
import { bestMedian } from "../../lang/flow/perfGate";
import { buildFlowGraph } from "../flowNodes";
import { emptyPositions } from "../layout";
import { glideFrames } from "./glide";

// Timing test: runs alone through `npm run test:perf`. One glide frame on 2,000 nodes, the worst
// case where every node moves (a Tidy), in 20 groups: the frame's positions and group areas, then the canvas
// applying them over its nodes. Best of three 20-run medians under 16 ms.
test("one_glide_frame_on_2000_nodes_under_16ms", () => {
  const doc: FlowDoc = { kind: "dfd", title: "Large", comments: [], nodes: [], links: [], groups: [] };
  const from = emptyPositions();
  const to = emptyPositions();
  for (let g = 0; g < 20; g++) {
    const names: string[] = [];
    for (let i = 0; i < 100; i++) {
      const n = g * 100 + i;
      const name = `Node ${n}`;
      names.push(name);
      doc.nodes.push({ name, kind: "process", attrs: { id: `${n}.0` } });
      from[name] = { x: (n % 50) * 240, y: Math.floor(n / 50) * 112 };
      to[name] = { x: Math.floor(n / 40) * 240, y: (n % 40) * 96 };
    }
    doc.groups.push({ name: `Area ${g}`, nodes: names, groups: [] });
  }
  for (let i = 0; i < 1999; i++) doc.links.push({ from: `Node ${i}`, to: `Node ${i + 1}`, arrow: ">" });
  const graph = buildFlowGraph(doc, to, "modern");
  expect(graph.nodes).toHaveLength(2020);
  const frame = glideFrames(from, to, doc.groups, graph.nodes);
  let nodes = graph.nodes;
  const median = bestMedian((run) => {
    const live = frame(((run % 19) + 1) / 20);
    nodes = applyLive(nodes, live);
  });
  // Every node that moves (Node 0 starts and ends at 0, 0) and every area was replaced.
  expect(nodes.filter((n, i) => n !== graph.nodes[i])).toHaveLength(2019);
  expect(median).toBeLessThan(16);
});
