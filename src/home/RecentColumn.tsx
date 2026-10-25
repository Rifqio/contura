import { useState } from "react";
import { clearRecent, errorText, restoreRecent } from "../api/client";
import type { ConnectionConfig, ConnectionId, DiagramEntry, RecentItem } from "../api/types";
import DbMark from "../components/DbMark";
import Icon, { type IconName } from "../components/Icon";
import { useToast } from "../components/Toast";
import { DIAGRAM_KIND_WORD } from "../flow/diagramKinds";
import { type DiagramMenuActions, diagramMenuItems, PlacedMenu, type PlacedMenuState } from "../flow/DiagramMenu";
import { RECENT_LIMIT, recentKind, recentTime, recentTitle, sectionsBy } from "./recent";

interface Props {
  items: RecentItem[];
  connections: ConnectionConfig[];
  openIds: ReadonlySet<ConnectionId>;
  /** The clock the day sections and times are measured from; tests fix it. */
  now?: Date;
  onOpen(item: RecentItem): void;
  /** Diagrams in Contura's diagrams folder, newest first; they sit in the days by when they last changed. */
  diagrams?: DiagramEntry[];
  onOpenDiagram?(name: string): void;
  /** A diagram row's right-click menu: Rename, Save a copy as, Delete. */
  diagramActions?: DiagramMenuActions;
  /** Recent was emptied, or put back by Undo; the owner reloads it. */
  onClear(): void;
  /** Opens Query History with scope All. */
  onShowAllHistory(): void;
}

function kindIcon(item: RecentItem): IconName {
  const t = item.target;
  if (t.kind === "query") return "fileQuery";
  if (t.kind === "schemaModel") return "schema";
  return t.object === "view" ? "view" : "table";
}

function itemKey(item: RecentItem): string {
  const t = item.target;
  const what = t.kind === "query" ? t.savedId : t.kind === "schemaModel" ? t.file : `${t.object}:${t.path.database}.${t.path.schema ?? ""}.${t.path.name}`;
  return `${item.connectionId ?? ""}|${t.kind}|${what}`;
}

/** Home's right column: what was opened lately, by day, newest first. */
type Row = { kind: "item"; at: number; item: RecentItem } | { kind: "diagram"; at: number; diagram: DiagramEntry };

export default function RecentColumn({
  items,
  connections,
  openIds,
  now = new Date(),
  onOpen,
  diagrams = [],
  onOpenDiagram,
  diagramActions,
  onClear,
  onShowAllHistory,
}: Props) {
  const rows: Row[] = [
    ...items.map((item): Row => ({ kind: "item", at: item.openedAtMs, item })),
    ...diagrams.map((diagram): Row => ({ kind: "diagram", at: diagram.modifiedMs, diagram })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_LIMIT);
  const sections = sectionsBy(rows, (r) => r.at, now);
  const toast = useToast();
  const [menu, setMenu] = useState<PlacedMenuState | null>(null);

  async function clear() {
    try {
      const removed = await clearRecent();
      onClear();
      toast.show({
        kind: "info",
        text: "Cleared Recent.",
        action: {
          label: "Undo",
          run: () =>
            void restoreRecent(removed)
              .then(onClear)
              .catch((e) => toast.show({ kind: "error", text: errorText(e) })),
        },
      });
    } catch (e) {
      toast.show({ kind: "error", text: errorText(e) });
    }
  }

  return (
    <aside className="recent" aria-label="Recent">
      <div className="recent-head">
        <h2 className="recent-title">Recent</h2>
        <button type="button" className="button button-small button-ghost" disabled={items.length === 0} onClick={() => void clear()}>
          Clear
        </button>
      </div>
      {menu && <PlacedMenu menu={menu} onClose={() => setMenu(null)} />}
      {sections.length === 0 ? (
        <p className="recent-empty">Nothing opened yet</p>
      ) : (
        sections.map((s) => (
          <section key={s.label} className="recent-section" aria-label={s.label}>
            <h3 className="recent-day">{s.label}</h3>
            {s.items.map((row) => {
              if (row.kind === "diagram") {
                const d = row.diagram;
                const time = recentTime(d.modifiedMs, now);
                const file = d.name;
                const word = DIAGRAM_KIND_WORD[d.kind];
                const open = () => onOpenDiagram?.(d.name);
                return (
                  <button
                    key={`diagram|${d.name}`}
                    type="button"
                    className="recent-item"
                    title={`${word} diagram. Select to open it.`}
                    aria-label={`${file}, ${word}, ${time}`}
                    onClick={open}
                    onContextMenu={(e) => {
                      if (!diagramActions) return;
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, label: file, items: diagramMenuItems(d.name, diagramActions, open) });
                    }}
                  >
                    <Icon name="flow" className="recent-item-icon" />
                    <span className="recent-item-title recent-item-code">{file}</span>
                    <span className="recent-item-time">{time}</span>
                    <span className="recent-item-meta">
                      <span className="recent-item-connection">{word}</span>
                    </span>
                  </button>
                );
              }
              const item = row.item;
              const c = connections.find((x) => x.id === item.connectionId);
              const tip = c ? `${recentKind(item)} on ${c.name}. Select to reopen it.` : `${recentKind(item)}. Select to reopen it.`;
              const time = recentTime(item.openedAtMs, now);
              const where = c ? `${recentKind(item)} on ${c.name}` : `${recentKind(item)}, No Connection`;
              const name = [recentTitle(item), where, ...(c?.production ? ["Production"] : []), time].join(", ");
              const code = item.target.kind !== "query";
              return (
                <button
                  key={itemKey(item)}
                  type="button"
                  className="recent-item"
                  title={tip}
                  aria-label={name}
                  onClick={() => onOpen(item)}
                >
                  <Icon name={kindIcon(item)} className="recent-item-icon" />
                  <span className={code ? "recent-item-title recent-item-code" : "recent-item-title"}>{recentTitle(item)}</span>
                  <span className="recent-item-time">{time}</span>
                  <span className="recent-item-meta">
                    {c ? (
                      <>
                        <DbMark dialect={c.dialect} open={openIds.has(c.id)} size={14} label={null} />
                        <span className="recent-item-connection">{c.name}</span>
                        {c.production && <span className="recent-item-prod">PROD</span>}
                      </>
                    ) : (
                      <span className="recent-item-connection">No Connection</span>
                    )}
                  </span>
                </button>
              );
            })}
          </section>
        ))
      )}
      <button type="button" className="button button-ghost recent-all" onClick={onShowAllHistory}>
        <Icon name="history" size={14} />
        Show all history
      </button>
    </aside>
  );
}
