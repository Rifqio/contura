// The Shelf's Icons tab before Plan C (decision 5): today's pack in an 8-column grid, A to Z with nothing typed, at
// most `SHELF_ICON_LIMIT` tiles, then how many more there are. Only the tiles shown mount, and each loads its image
// through `useIcon` (cached by name and theme), so the full pack never draws at once. Plan C replaces this tab.
import { useContext, useEffect, useMemo, useState } from "react";
import { useIcon } from "../../icons";
import { type ShelfIconHit, SHELF_ICON_LIMIT, ShelfIconContext } from "./iconSource";
import { Nothing, ShelfOption, useOptionList } from "./list";
import type { ShelfItem, ShelfTabProps } from "./types";

const fmt = (n: number) => n.toLocaleString("en-US");

/** One icon's image, from a data: URL (ruling P7). */
export function IconTile({ name }: { name: string }) {
  const { url, missing, failed, outline } = useIcon(name);
  return (
    <span className="flow-shelf-tile-image">
      {url && !missing && !failed && <img className={outline ? "icon-hairline" : undefined} src={url} alt="" draggable={false} />}
    </span>
  );
}

/** An icon option's tooltip: its title, and its name when that differs. */
export const iconTip = (hit: ShelfIconHit) => (hit.title && hit.title !== hit.name ? `${hit.title} (${hit.name})` : hit.name);

export default function BasicIconsTab({ query, registerKeys, add, beginDrag, setActiveDescendant, listboxId }: ShelfTabProps) {
  const source = useContext(ShelfIconContext);
  const [state, setState] = useState<"loading" | "ready" | "failed">(() => (source.count("") === null ? "loading" : "ready"));
  useEffect(() => {
    let live = true;
    source.load().then(
      () => live && setState("ready"),
      () => live && setState("failed"),
    );
    return () => {
      live = false;
    };
  }, [source]);
  const hits = useMemo(() => (state === "ready" ? source.results(query, SHELF_ICON_LIMIT) : []), [source, state, query]);
  const total = useMemo(() => (state === "ready" ? (source.count(query) ?? 0) : 0), [source, state, query]);
  const item = (hit: ShelfIconHit): ShelfItem => ({ kind: "icon", name: hit.name });
  const { active, optionId } = useOptionList({
    n: hits.length,
    reset: query,
    registerKeys,
    setActiveDescendant,
    pick: (i) => add(item(hits[i])),
  });
  if (state === "failed") {
    return (
      <p className="flow-shelf-empty" role="alert">
        Couldn't read the icon list.
      </p>
    );
  }
  if (state === "loading") return <p className="flow-shelf-empty">Reading the icon list</p>;
  if (hits.length === 0) return <Nothing query={query} />;
  return (
    <>
      <div id={listboxId} role="listbox" aria-label="Icons" className="flow-shelf-tiles">
        {hits.map((hit, i) => (
          <ShelfOption
            key={hit.name}
            id={optionId(i)}
            active={i === active}
            label={hit.title || hit.name}
            title={iconTip(hit)}
            name={hit.name}
            item={item(hit)}
            drag
            className="flow-shelf-tile"
            add={add}
            beginDrag={beginDrag}
          >
            <IconTile name={hit.name} />
          </ShelfOption>
        ))}
      </div>
      {total > hits.length && <p className="flow-shelf-note">{`Showing ${fmt(hits.length)} of ${fmt(total)}. Type to narrow.`}</p>}
    </>
  );
}
