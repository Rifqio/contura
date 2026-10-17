import { clearRecent, errorText, restoreRecent } from "../api/client";
import type { ConnectionConfig, ConnectionId, RecentItem } from "../api/types";
import DbMark from "../components/DbMark";
import Icon, { type IconName } from "../components/Icon";
import { useToast } from "../components/Toast";
import { recentKind, recentSections, recentTime, recentTitle } from "./recent";

interface Props {
  items: RecentItem[];
  connections: ConnectionConfig[];
  openIds: ReadonlySet<ConnectionId>;
  /** The clock the day sections and times are measured from; tests fix it. */
  now?: Date;
  onOpen(item: RecentItem): void;
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
export default function RecentColumn({ items, connections, openIds, now = new Date(), onOpen, onClear, onShowAllHistory }: Props) {
  const sections = recentSections(items, now);
  const toast = useToast();

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
      {sections.length === 0 ? (
        <p className="recent-empty">Nothing opened yet</p>
      ) : (
        sections.map((s) => (
          <section key={s.label} className="recent-section" aria-label={s.label}>
            <h3 className="recent-day">{s.label}</h3>
            {s.items.map((item) => {
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
