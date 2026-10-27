// The Shelf's template side (decisions 4, 12 and 14): board cards with a preview of each frame, then single
// templates tagged by kind, then "From my database" and "From Mermaid", which stay whatever the filter or search and
// never drag. The search owns focus, so the chips take no press and the list is stepped by the Shelf's keys.
import { type DragEvent, type KeyboardEvent, memo, useMemo } from "react";
import Icon from "../../../components/Icon";
import Segmented from "../../../components/Segmented";
import { useIconTheme } from "../../icons";
import { boardPreviewUrls } from "../catalog/preview";
import { frameTitle, searchTemplates } from "../catalog/search";
import type { BoardTemplate, SingleTemplate, TemplateFilter } from "../catalog/templates";
import { KIND_HEAD, KIND_ICON } from "../chips";
import { ShelfOption, useOptionList } from "./list";
import type { ShelfItem } from "./types";

/** The chips, in order; Ctrl+PageDown steps through them. */
export const TEMPLATE_FILTERS: readonly { value: TemplateFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "boards", label: "Boards" },
  { value: "er", label: "ERD" },
  { value: "flow", label: "Flow" },
  { value: "cloud", label: "Cloud" },
  { value: "sequence", label: "Sequence" },
];

interface Props {
  query: string;
  filter: TemplateFilter;
  setFilter(f: TemplateFilter): void;
  registerKeys(handler: (e: KeyboardEvent) => boolean): void;
  setActiveDescendant(id: string | undefined): void;
  add(item: ShelfItem): void;
  beginDrag(item: ShelfItem, e: DragEvent): void;
  listboxId: string;
  /** Nothing drags (the New diagram catalog). */
  still?: boolean;
}

type Row = { kind: "board"; t: BoardTemplate } | { kind: "single"; t: SingleTemplate } | { kind: "from"; item: "fromDatabase" | "fromMermaid" };

const fmt = (n: number) => n.toLocaleString("en-US");

/** A board card's frames, drawn side by side; each is one image of a cached SVG URL (the one-theme cache). */
let previewRenders = 0;
/** How many times a Preview rendered; a keystroke in the search must not add any. */
export const previewRenderCount = () => previewRenders;

const Preview = memo(function Preview({ id }: { id: string }) {
  previewRenders++;
  const theme = useIconTheme();
  const srcs = boardPreviewUrls(id, theme);
  return (
    <div className="flow-shelf-preview" aria-hidden="true">
      {srcs.map((src, i) => (
        <span key={i} className="flow-shelf-preview-frame">
          <img className="flow-shelf-preview-frame-image" src={src} alt="" draggable={false} />
        </span>
      ))}
    </div>
  );
});

export default function TemplatesSide({ query, filter, setFilter, registerKeys, setActiveDescendant, add, beginDrag, listboxId, still = false }: Props) {
  const searching = query.trim() !== "";
  const shown: TemplateFilter = searching ? "all" : filter;
  const found = useMemo(() => searchTemplates(query, shown), [query, shown]);
  const rows = useMemo<Row[]>(
    () => [
      ...found.boards.map((t): Row => ({ kind: "board", t })),
      ...found.singles.map((t): Row => ({ kind: "single", t })),
      { kind: "from", item: "fromDatabase" },
      { kind: "from", item: "fromMermaid" },
    ],
    [found],
  );
  const total = found.boards.length + found.singles.length;
  const { active, optionId } = useOptionList({
    n: rows.length,
    reset: `${query}\n${shown}`,
    registerKeys,
    setActiveDescendant,
    pick: (i) => {
      const r = rows[i];
      add(r.kind === "from" ? { kind: r.item } : { kind: "template", id: r.t.id });
    },
  });

  const option = (r: Row, i: number) => {
    const id = optionId(i);
    if (r.kind === "board") {
      const titles = r.t.frames.map(frameTitle).join(" · ");
      const item: ShelfItem = { kind: "template", id: r.t.id };
      return (
        <ShelfOption key={r.t.id} id={id} active={i === active} label={r.t.name} describedBy={`${id}d`} item={item} drag={!still} className="flow-shelf-board" add={add} beginDrag={beginDrag}>
          <Preview id={r.t.id} />
          <span className="flow-shelf-board-head">
            <span className="flow-shelf-row-name" title={r.t.name}>{r.t.name}</span>
            <span className="flow-shelf-badge">Board</span>
          </span>
          <span id={`${id}d`} className="flow-shelf-board-frames">
            {titles}
          </span>
        </ShelfOption>
      );
    }
    if (r.kind === "single") {
      const item: ShelfItem = { kind: "template", id: r.t.id };
      return (
        <ShelfOption key={r.t.id} id={id} active={i === active} label={r.t.name} item={item} drag={!still} className="flow-shelf-row" add={add} beginDrag={beginDrag}>
          <Icon name={KIND_ICON[r.t.kind]} size={16} />
          <span className="flow-shelf-row-name" title={r.t.name}>{r.t.name}</span>
          <span className="flow-shelf-tag">{KIND_HEAD[r.t.kind].name}</span>
        </ShelfOption>
      );
    }
    const db = r.item === "fromDatabase";
    return (
      <ShelfOption
        key={r.item}
        id={id}
        active={i === active}
        label={db ? "From my database" : "From Mermaid"}
        item={{ kind: r.item }}
        drag={false}
        className={i === rows.length - 2 ? "flow-shelf-row flow-shelf-from is-first" : "flow-shelf-row flow-shelf-from"}
        add={add}
        beginDrag={beginDrag}
      >
        <Icon name={db ? "database" : "code"} size={16} />
        <span className="flow-shelf-row-name">{db ? "From my database" : "From Mermaid"}</span>
      </ShelfOption>
    );
  };

  return (
    <section className="flow-shelf-templates" aria-label="Templates">
      <h3 className="flow-shelf-title">
        Start from a template <span className="flow-shelf-count">{fmt(total)}</span>
      </h3>
      {!searching && (
        // A press on a chip must not take focus from the search; Ctrl+PageDown steps the chips from there. Tab reaches
        // them as one toolbar stop (the chosen chip, roving), and the arrows move inside (WAI-ARIA toolbar, B1's pattern).
        <div className="flow-shelf-filter" role="toolbar" aria-label="Filter templates" onMouseDown={(e) => e.preventDefault()}>
          <Segmented<TemplateFilter> label="Template filter" value={filter} options={TEMPLATE_FILTERS.map((f) => ({ ...f }))} onChange={setFilter} />
        </div>
      )}
      {total === 0 && <p className="flow-shelf-empty">{`No template matches "${query.trim()}".`}</p>}
      <div id={listboxId} role="listbox" aria-label="Templates" className="flow-shelf-rows">
        {rows.map(option)}
      </div>
    </section>
  );
}
