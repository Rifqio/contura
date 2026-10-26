// The words an ER diagram's shapes are called by in the in-place edits and notes.
import { expect, test } from "vitest";
import { GROUP_WORD, NO_GROUPS, needsName, nounOf } from "./editWords";

test("an_er_entity_is_a_table_and_a_weak_one_a_weak_table", () => {
  expect(nounOf("entity", "er")).toBe("table");
  expect(nounOf("weak", "er")).toBe("weak table");
  // A data flow's entity is still an outside party.
  expect(nounOf("entity", "dfd")).toBe("outside party");
  expect(nounOf("entity")).toBe("outside party");
  expect(needsName("entity", "er")).toBe("A table needs a name.");
  expect(needsName("weak", "er")).toBe("A weak table needs a name.");
  expect(needsName("entity", "dfd")).toBe("An outside party needs a name.");
});

test("an_er_diagram_has_groups", () => {
  expect(GROUP_WORD.er).toBe("Group");
  expect(NO_GROUPS.er).toBeUndefined();
});
