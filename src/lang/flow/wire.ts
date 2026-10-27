// What the worker posts for a parse: only the docs the editor side does not already hold. Each doc has an id (Decision
// 13); the worker remembers the ids of the last result it sent, the client keeps those docs, and an unchanged frame
// is posted as its id alone. The merge gives back the very objects first posted, so memo checks by identity still hold.
import type { FlowDoc } from "./model";
import type { FlowProblem } from "./problems";
import type { FlowResult, FrameResult } from "./service";

export type FrameWire = Omit<FrameResult, "doc" | "lastValid"> & { doc?: FlowDoc | null; lastValid?: FlowDoc | null };
export type FlowResultWire = { problems: FlowProblem[]; frames: FrameWire[]; version: number };

/** Omits each doc whose id is in `sent`, then sets `sent` to this result's ids. */
export function toWire(result: FlowResult, sent: Set<number>): FlowResultWire {
  const frames = result.frames.map((f): FrameWire => {
    const { doc, lastValid, ...rest } = f;
    const out: FrameWire = rest;
    if (f.docId === null || !sent.has(f.docId)) out.doc = doc;
    if (f.lastValidId === null || !sent.has(f.lastValidId)) out.lastValid = lastValid;
    return out;
  });
  sent.clear();
  for (const f of result.frames) {
    if (f.docId !== null) sent.add(f.docId);
    if (f.lastValidId !== null) sent.add(f.lastValidId);
  }
  return { problems: result.problems, frames, version: result.version };
}

/** An omitted doc the receiver does not hold: it asks for a full post. */
export class WireMiss extends Error {}

function held(id: number | null, own: FlowDoc | null | undefined, have: ReadonlyMap<number, FlowDoc>): FlowDoc | null {
  if (own !== undefined) return own;
  const doc = id === null ? undefined : have.get(id);
  if (!doc) throw new WireMiss(`doc ${id} is not held`);
  return doc;
}

/** Restores the full result; frame 0 gives `kind`, `doc`, `lastValid` and `oldEr`. Throws `WireMiss` on an id not in `have`. */
export function fromWire(wire: FlowResultWire, have: ReadonlyMap<number, FlowDoc>): FlowResult {
  const frames: FrameResult[] = wire.frames.map((f) => ({ ...f, doc: held(f.docId, f.doc, have), lastValid: held(f.lastValidId, f.lastValid, have) }));
  const top = frames[0];
  return { kind: top.kind, doc: top.doc, problems: wire.problems, lastValid: top.lastValid, frames, version: wire.version, ...(top.oldEr ? { oldEr: true as const } : {}) };
}

/** The docs of a result by id: what the receiver holds for the next post. */
export function docsById(result: FlowResult): Map<number, FlowDoc> {
  const m = new Map<number, FlowDoc>();
  for (const f of result.frames) {
    if (f.doc && f.docId !== null) m.set(f.docId, f.doc);
    if (f.lastValid && f.lastValidId !== null) m.set(f.lastValidId, f.lastValid);
  }
  return m;
}
