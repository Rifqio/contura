import { expect, test } from "vitest";
import type { AskRequest, AskTab, ItemKind, StepIn } from "../api/types";
import { fakePreview } from "./aiPreview";
import parity from "./previewParity.json";

/** The fake preview gives the This tab and Recent steps rows exactly as the Core does (the Core checks the same file). */
test("the fake preview matches the Core's This tab and Recent steps rows", () => {
  const r = parity.request;
  const step = (n: number): StepIn => ({ at: n, verb: "runVisual", tab: "visual", title: null, connectionId: "c1", database: r.database, schema: null, count: 1 });
  for (const c of parity.cases) {
    const req = {
      requestId: "r",
      place: "ungrouped",
      groupId: null,
      connectionId: "c1",
      database: r.database,
      schema: null,
      action: "ask",
      question: r.question,
      threadId: null,
      focus: { sql: null, selection: null, error: null, filter: null, dbml: null, tables: [], untiedModel: false },
      switches: { rows: false, values: false },
      off: c.off as ItemKind[],
      tab: r.tab as AskTab,
      steps: Array.from({ length: r.steps }, (_, n) => step(n)),
    } satisfies AskRequest;
    const got = fakePreview(req)
      .items.filter((i) => i.kind === "tab" || i.kind === "steps")
      .map((i) => ({ kind: i.kind, label: i.label, on: i.on, sends: i.bytes > 0 }));
    expect(got, `off ${c.off.join(", ")}`).toEqual(c.items);
  }
});
