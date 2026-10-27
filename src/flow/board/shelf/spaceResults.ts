// The Space box's rows (decision 19): the Shelf's one search, mixed and cut to the top `n`. Kinds first, then board
// templates, then single templates, then icons from the one icon source. With nothing typed: the first three kinds,
// the first board template and the source's top four icons (Plan C makes those the recent ones).
import type { IconName } from "../../../components/Icon";
import { SHELF_KINDS } from "../catalog/kinds";
import { searchKinds, searchTemplates } from "../catalog/search";
import { BOARD_TEMPLATES } from "../catalog/templates";
import { KIND_HEAD, KIND_ICON } from "../chips";
import type { ShelfIconSource } from "./iconSource";
import type { ShelfItem } from "./types";

export interface SpaceRow {
  item: ShelfItem;
  name: string;
  tag: string;
  icon: { app: IconName } | { pack: string };
}

/** An icon's tag by its set. */
const SET_TAG: Record<string, string> = {
  lucide: "Icon",
  simple: "Logo",
  aws: "AWS icon",
  azure: "Azure icon",
  gcp: "Google Cloud icon",
  k8s: "Kubernetes icon",
};

export function spaceResults(query: string, icons: ShelfIconSource, n = 8): SpaceRow[] {
  const typed = query.trim() !== "";
  const rows: SpaceRow[] = [];
  const kinds = typed ? searchKinds(query) : SHELF_KINDS.slice(0, 3);
  for (const k of kinds) {
    if (rows.length >= n) return rows;
    rows.push({ item: { kind: "diagram", diagram: k }, name: KIND_HEAD[k].name, tag: "Diagram", icon: { app: KIND_ICON[k] } });
  }
  const { boards, singles } = typed ? searchTemplates(query, "all") : { boards: BOARD_TEMPLATES.slice(0, 1), singles: [] };
  for (const b of boards) {
    if (rows.length >= n) return rows;
    rows.push({ item: { kind: "template", id: b.id }, name: b.name, tag: "Board template", icon: { app: "grid" } });
  }
  for (const t of singles) {
    if (rows.length >= n) return rows;
    rows.push({ item: { kind: "template", id: t.id }, name: t.name, tag: `${KIND_HEAD[t.kind].name} template`, icon: { app: KIND_ICON[t.kind] } });
  }
  const room = typed ? n - rows.length : Math.min(4, n - rows.length);
  if (room <= 0) return rows;
  for (const hit of icons.top(query, room)) {
    rows.push({ item: { kind: "icon", name: hit.name }, name: hit.title || hit.name, tag: SET_TAG[hit.set] ?? "Icon", icon: { pack: hit.name } });
  }
  return rows;
}
