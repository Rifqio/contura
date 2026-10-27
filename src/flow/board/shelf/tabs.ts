// The Shelf's tab registry (decision 6): each tab's name, icon, count and body. Plan C swaps the Icons row for its
// own tab; nothing else in the Shelf names a tab.
import type { ComponentType } from "react";
import type { IconName } from "../../../components/Icon";
import type { DiagramKind } from "../../../lang/flow/model";
import { searchKinds } from "../catalog/search";
import BasicIconsTab from "./BasicIconsTab";
import DiagramsTab from "./DiagramsTab";
import type { ShelfIconSource } from "./iconSource";
import ShapesTab, { shapeCount } from "./ShapesTab";
import type { ShelfTabProps } from "./types";

export interface ShelfTabDef {
  id: string;
  label: string;
  icon: IconName;
  /**
   * How many items the tab holds, or matches while searching; null while unknown (the icon pack is loading).
   * `icons` is the Shelf's one icon source.
   */
  count(query: string, frameKind: DiagramKind | null, icons: ShelfIconSource): number | null;
  Body: ComponentType<ShelfTabProps>;
}

export const SHELF_TABS: readonly ShelfTabDef[] = [
  { id: "diagrams", label: "Diagrams", icon: "grid", count: (q) => searchKinds(q).length, Body: DiagramsTab },
  { id: "icons", label: "Icons", icon: "image", count: (q, _kind, icons) => icons.count(q), Body: BasicIconsTab },
  { id: "shapes", label: "Shapes", icon: "shapes", count: shapeCount, Body: ShapesTab },
];
