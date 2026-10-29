// Lineage's side panel (344 px): what deleting a row does, then each key in a plain sentence
// with its columns and a tag, then the diagrams or views that use the table.
import type { ReactNode } from "react";
import type { Lineage, LineageLink } from "../api/types";
import Icon, { type IconName } from "../components/Icon";
import {
  type DeleteEffects,
  type KeyContext,
  type LinkTag,
  columnsText,
  deleteCheckingLine,
  deleteTitle,
  linkSentence,
  samePath,
  tablesCount,
  tagOf,
  updateSentence,
} from "./sentences";

/** A diagram or view row; `key` is its line's id on the canvas. */
export interface RefRow {
  key: string;
  kind: "flow" | "view";
  title: string;
  file: string;
  /** The diagram's own name, so the frames of one board count once. */
  diagram: string;
  /** Opens the diagram or view; without it the row has no Open. */
  onOpen?(): void;
}

export interface LineagePanelProps {
  lineage: Lineage;
  /** The warning block, from its own read of everything using the table; null while it is read. */
  effects: DeleteEffects | null;
  /** Defaults of key columns, for SET DEFAULT. */
  hasDefault?: KeyContext["hasDefault"];
  /** SQLite runs Foreign Keys only when they are on, so the warning says so. */
  sqlite?: boolean;
  /** Null while they are read. */
  refs: RefRow[] | null;
  /** Under the Diagrams or Views rows: what was not checked. */
  refNotes?: string[];
  source: "flows" | "views";
  /** "shop, PostgreSQL". */
  where: string;
  /** The marked row's key (`link:3`, `ref:0`), shared with the canvas. */
  hot: string | null;
  onHot(key: string | null): void;
}

const TAGS: Record<LinkTag, { icon: IconName; word: string }> = {
  blocks: { icon: "ban", word: "Blocks" },
  cascade: { icon: "trash", word: "Also deletes" },
  info: { icon: "info", word: "Info" },
};

function Group({ label, count, icon, notes, children }: { label: string; count: string; icon: IconName; notes?: string[]; children: ReactNode }) {
  return (
    <section className="lineage-group" aria-label={label}>
      <div className="lineage-group-head">
        <span className="lineage-group-icon">
          <Icon name={icon} size={14} />
        </span>
        <span>{label}</span>
        <em>{count}</em>
      </div>
      <ul className="lineage-group-rows">{children}</ul>
      {notes?.map((n) => (
        <p key={n} className="lineage-group-note">
          {n}
        </p>
      ))}
    </section>
  );
}

const distinct = (paths: LineageLink["to"][]) => paths.filter((p, i) => paths.findIndex((q) => samePath(p, q)) === i).length;

export default function LineagePanel({ lineage, effects, hasDefault, sqlite, refs, refNotes, source, where, hot, onHot }: LineagePanelProps) {
  const center = lineage.center;
  const indexed = lineage.links.map((link, i) => ({ link, key: `link:${i}` }));
  const uses = indexed.filter(({ link }) => samePath(link.from, center));
  const usedBy = indexed.filter(({ link }) => samePath(link.to, center) && !samePath(link.from, center));
  const ctx: KeyContext = { lineage, hasDefault };
  const warned = effects !== null && (effects.blocks.length > 0 || effects.cascades.length > 0 || effects.incomplete !== null);
  // Unchecked is never shown as "nothing happens elsewhere".
  const checking = effects === null;
  const title = deleteTitle(center);

  const hover = (key: string) => ({
    className: hot === key ? "lineage-row lineage-row-hot" : "lineage-row",
    onMouseEnter: () => onHot(key),
    onMouseLeave: () => onHot(null),
  });

  const linkRow = ({ link, key }: { link: LineageLink; key: string }) => {
    const kind = tagOf(link, ctx);
    const tag = TAGS[kind];
    const update = updateSentence(link, ctx);
    return (
      <li key={key} {...hover(key)}>
        <span className="lineage-row-sentence">{linkSentence(link, center, ctx)}</span>
        {update && <span className="lineage-row-update">{update}</span>}
        <span className="lineage-row-meta">
          <code>{columnsText(link, center)}</code>
          <span className={`lineage-tag lineage-tag-${kind}`}>
            <Icon name={tag.icon} size={14} />
            {tag.word}
          </span>
        </span>
      </li>
    );
  };

  return (
    <aside className="lineage-panel" aria-label="What links do">
      <div className="lineage-panel-strip">
        <span className="lineage-panel-title">{center.name}</span>
        <span className="lineage-panel-where">{where}</span>
      </div>
      {checking && (
        <div className="lineage-warning" role="note" aria-label={title}>
          <div className="lineage-warning-title">
            <Icon name="alert" size={16} />
            {title}
          </div>
          <p className="lineage-warning-note">{deleteCheckingLine(center)}</p>
        </div>
      )}
      {warned && effects && (
        <div className="lineage-warning" role="note" aria-label={title}>
          <div className="lineage-warning-title">
            <Icon name="alert" size={16} />
            {title}
          </div>
          <ul>
            {effects.blocks.map((s) => (
              <li key={s}>
                <Icon name="ban" size={14} className="lineage-warning-block" />
                <span>{s}</span>
              </li>
            ))}
            {effects.cascades.map((s) => (
              <li key={s}>
                <Icon name="trash" size={14} className="lineage-warning-cascade" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
          {effects.incomplete && <p className="lineage-warning-note">{effects.incomplete}</p>}
          {sqlite && <p className="lineage-warning-note">SQLite enforces these only when foreign keys are on.</p>}
        </div>
      )}
      {uses.length > 0 && (
        <Group label={`${center.name} points to`} count={tablesCount(distinct(uses.map((u) => u.link.to)))} icon="arrowRight">
          {uses.map(linkRow)}
        </Group>
      )}
      {usedBy.length > 0 && (
        <Group label={`Points to ${center.name}`} count={tablesCount(distinct(usedBy.map((u) => u.link.from)))} icon="arrowLeft">
          {usedBy.map(linkRow)}
        </Group>
      )}
      {refs && (refs.length > 0 || (refNotes?.length ?? 0) > 0) && (
        <Group
          label={source === "flows" ? "Diagrams" : "Views"}
          // Diagrams counts diagrams, not their process rows (P18).
          count={String(source === "flows" ? new Set(refs.map((r) => r.diagram)).size : refs.length)}
          icon={source === "flows" ? "flow" : "view"}
          notes={refNotes}
        >
          {refs.map((r) => (
            <li key={r.key} {...hover(r.key)}>
              <span className="lineage-ref-row">
                <Icon name={r.kind === "flow" ? "flow" : "view"} size={14} className="lineage-ref-icon" />
                <span className="lineage-ref-text">
                  <span className="lineage-row-sentence">{r.title}</span>
                  <code>{r.file}</code>
                </span>
                {r.onOpen && (
                  <button type="button" className="lineage-open" aria-label={`Open ${r.file}`} onClick={r.onOpen}>
                    Open
                    <Icon name="arrowRight" size={14} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </Group>
      )}
    </aside>
  );
}
