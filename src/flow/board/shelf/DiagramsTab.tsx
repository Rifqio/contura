// The Shelf's Diagrams tab (spec, decision 12): the nine kinds, 3 by 3 in the spec's order, each card its kind's
// icon, name and line. A click or Enter adds an empty frame of that kind; a drag drops it where released.
import { type HTMLAttributes, useMemo } from "react";
import Icon from "../../../components/Icon";
import { searchKinds } from "../catalog/search";
import { KIND_HEAD, KIND_ICON } from "../chips";
import { Nothing, ShelfOption, useOptionList } from "./list";
import type { ShelfTabProps } from "./types";

/**
 * `still`: nothing drags (the New diagram catalog has no board to drop on). `listbox`: attributes for the listbox
 * itself, where it owns focus instead of a search (the assistant's start screen: its tab stop, active option and keys).
 */
export default function DiagramsTab({ query, registerKeys, add, beginDrag, setActiveDescendant, listboxId, still = false, listbox }: ShelfTabProps & { still?: boolean; listbox?: HTMLAttributes<HTMLDivElement> }) {
  const kinds = useMemo(() => searchKinds(query), [query]);
  const { active, optionId } = useOptionList({
    n: kinds.length,
    reset: query,
    registerKeys,
    setActiveDescendant,
    pick: (i) => add({ kind: "diagram", diagram: kinds[i] }),
  });
  if (kinds.length === 0) return <Nothing query={query} />;
  return (
    <div id={listboxId} role="listbox" aria-label="Diagrams" className="flow-shelf-cards" {...listbox}>
      {kinds.map((kind, i) => (
        <ShelfOption
          key={kind}
          id={optionId(i)}
          active={i === active}
          label={KIND_HEAD[kind].name}
          describedBy={`${optionId(i)}l`}
          item={{ kind: "diagram", diagram: kind }}
          drag={!still}
          className="flow-shelf-card"
          add={add}
          beginDrag={beginDrag}
        >
          <Icon name={KIND_ICON[kind]} size={20} />
          <span className="flow-shelf-card-name">{KIND_HEAD[kind].name}</span>
          <span id={`${optionId(i)}l`} className="flow-shelf-card-line">
            {KIND_HEAD[kind].line}
          </span>
        </ShelfOption>
      ))}
    </div>
  );
}
