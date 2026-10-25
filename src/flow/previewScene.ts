// diag-910 fix round 1, M8 (board DiagramStartWell): each New diagram card draws its kind's real example, from the
// example text, with the Publish drawing (flowScene and sceneToSvg). A sequence, mind map or timeline is placed from
// its text as the canvas places it; the other kinds get a small rank layout here (sources first, layer by layer, as
// Mermaid and the board draw them), so the preview needs no layout worker.
import type { Positions } from "../diagram/layout";
import { type ExportPalette } from "../diagram/export/palette";
import { sceneToSvg } from "../diagram/export/svg";
import { FIXED_KINDS, type FlowDoc, shownName } from "../lang/flow/model";
import { parseFlow } from "../lang/flow/parse";
import { drawnKind, nodeSize } from "./flowNodes";
import { flowScene } from "./flowScene";
import { emptyPositions } from "./layout";

/** Layers by the longest path from the sources, lines that go back left out; each layer a column, left to right. */
export function rankPositions(doc: FlowDoc): Positions {
  const out = emptyPositions();
  const names = doc.nodes.map((n) => n.name);
  const index = new Map(names.map((n, i) => [n, i] as const));
  const rank = new Map<string, number>(names.map((n) => [n, 0] as const));
  // Lines from a later shape back to an earlier one are back edges: only forward lines push a shape right.
  const forward = doc.links.filter((l) => !l.tree && index.has(l.from) && index.has(l.to) && index.get(l.from)! < index.get(l.to)!);
  for (let pass = 0; pass < names.length; pass++) {
    let moved = false;
    for (const l of forward) {
      const r = rank.get(l.from)! + 1;
      if (r > rank.get(l.to)!) {
        rank.set(l.to, r);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const size = (name: string) => {
    const n = doc.nodes[index.get(name)!];
    return nodeSize(drawnKind(n.kind, doc.kind, n.name), "modern", shownName(n), n.attrs.id, n);
  };
  const columns = new Map<number, string[]>();
  for (const n of names) columns.set(rank.get(n)!, [...(columns.get(rank.get(n)!) ?? []), n]);
  let x = 0;
  for (const r of [...columns.keys()].sort((a, b) => a - b)) {
    const col = columns.get(r)!;
    let y = 0;
    let w = 0;
    for (const n of col) {
      const s = size(n);
      out[n] = { x, y };
      y += s.h + 50;
      w = Math.max(w, s.w);
    }
    x += w + 70;
  }
  return out;
}

/** The SVG of the example `text`, scaled to fill its box. */
export function exampleSvg(text: string, palette: ExportPalette): string {
  const doc = parseFlow(text).doc;
  if (!doc || doc.nodes.length === 0) return "";
  const positions = FIXED_KINDS.has(doc.kind) ? emptyPositions() : rankPositions(doc);
  const scene = flowScene(doc, positions, "modern", new Map());
  return sceneToSvg(scene, palette, { padding: 16, background: "transparent", mark: false }).replace(/ width="[\d.]+" height="[\d.]+"/, ' width="100%" height="100%" preserveAspectRatio="xMidYMid meet"');
}
