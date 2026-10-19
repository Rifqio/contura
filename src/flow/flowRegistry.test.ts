import { expect, test } from "vitest";
import { flowEntry, registerFlow, unsavedFlows } from "./flowRegistry";

const entry = () => ({ save: "saved" as const, line: null, col: null, errors: 0, flush: async () => true });

test("entries_are_per_tab_instance_so_a_closed_tab_never_marks_a_new_one", () => {
  const old = registerFlow("checkout", entry());
  old();
  const fresh = registerFlow("checkout", entry());
  try {
    // A write of the closed tab finishing late: its update goes nowhere.
    old.update({ save: "failed", message: "late" });
    expect(flowEntry("checkout")?.save).toBe("saved");
    expect(unsavedFlows()).toEqual([]);
    fresh.update({ save: "waiting" });
    expect(flowEntry("checkout")?.save).toBe("waiting");
    expect(unsavedFlows()).toEqual(["checkout"]);
  } finally {
    fresh();
  }
  expect(flowEntry("checkout")).toBeUndefined();
});
