import { errorText, saveGroup } from "../api/client";
import type { Group } from "../api/types";
import { UNGROUPED, UNGROUPED_LABEL_MAX, useUngroupedLabel } from "../prefs/usePrefs";

/** What Edit Group and the in-place rename both say for an empty Group name. */
export const EMPTY_GROUP_NAME = "Give the Group a name, such as the client or project it is for.";

/** What the in-place rename of Ungrouped says for an empty name. */
export const EMPTY_PLACE_NAME = "Type a name. Ungrouped brings back the default.";

export const UNGROUPED_NAME_LIMIT = UNGROUPED_LABEL_MAX;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Why a Group may not be called `name`, as the Core says it, or null. The Group keeps a name it already has. */
function groupNameTaken(name: string, groups: Group[], ungroupedLabel: string, self: Group): string | null {
  if (groups.some((g) => g.id !== self.id && same(g.name, name))) return `A Group is already named ${name}. Pick another name.`;
  if (same(ungroupedLabel, name) && !same(self.name, name)) return "That name is what Ungrouped is called. Pick another name.";
  return null;
}

/** Renames a Group the way Edit Group saves it: same save, same colour. Resolves to a message, or null once saved. */
export async function renameGroup(group: Group, name: string, groups: Group[], ungroupedLabel: string): Promise<string | null> {
  const next = name.trim();
  if (next === "") return EMPTY_GROUP_NAME;
  const taken = groupNameTaken(next, groups, ungroupedLabel, group);
  if (taken) return taken;
  try {
    await saveGroup({ id: group.id, name: next, color: group.color });
    return null;
  } catch (err) {
    return errorText(err);
  }
}

/**
 * Checks a new name for Ungrouped. Empty, or a name a Group has (ignoring case), is refused; "Ungrouped" itself is stored
 * as `null`, the default.
 */
export function checkUngroupedName(name: string, groups: Group[]): { error: string } | { label: string | null } {
  const next = name.trim();
  if (next === "") return { error: EMPTY_PLACE_NAME };
  if (groups.some((g) => same(g.name, next))) return { error: `A Group is already named ${next}. Pick another name.` };
  return { label: same(next, UNGROUPED) ? null : next };
}

/** The save behind a place's in-place rename: a Group (null for Ungrouped), checked against every place's name. */
export function usePlaceRename(group: Group | null, groups: Group[], onRenamed: () => void) {
  const { label, set } = useUngroupedLabel();
  return async function commit(name: string): Promise<string | null> {
    if (group) {
      const problem = await renameGroup(group, name, groups, label);
      if (problem === null) onRenamed();
      return problem;
    }
    const checked = checkUngroupedName(name, groups);
    if ("error" in checked) return checked.error;
    set(checked.label);
    return null;
  };
}

/** A double-click selects the word under it; the second press's default is dropped so it does not. */
export function keepTextUnselected(e: { detail: number; preventDefault(): void }) {
  if (e.detail > 1) e.preventDefault();
}
