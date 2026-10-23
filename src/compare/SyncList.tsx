import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import type { DialectKind, ItemId, SyncGroup, SyncItem, SyncPlan } from "../api/types";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { highlightSql } from "../lang/sql/highlightStatic";
import { GROUP_TITLE, SYNC_FOOT_HINT, lossLine, prodNote, scriptLines, scriptTitle } from "./compareModel";
import { MarkIcon } from "./DiffTree";
import { useWindowed } from "./useWindowed";

interface ListProps {
  items: SyncItem[];
  ticked: ReadonlySet<ItemId>;
  /** The name each item's data-loss line uses (the column or table). */
  nameOf(id: ItemId): string;
  selected: ItemId | null;
  onSelect(id: ItemId): void;
  onToggle(id: ItemId, on: boolean): void;
}

/** The second line: why Contura cannot script it, else data loss in the danger text, else what the item needs. */
function secondLine(item: SyncItem, byId: Map<ItemId, SyncItem>, nameOf: (id: ItemId) => string): { text: string; tone: "danger" | "subtle" } | null {
  if (item.notScriptable) return { text: item.notScriptable, tone: "subtle" };
  if (item.losesData) return { text: lossLine({ kind: item.kind, object: item.object, name: nameOf(item.id) }, item.dataLoss), tone: "danger" };
  const need = item.needs.map((id) => byId.get(id)).find((i) => i !== undefined);
  if (need) return { text: `Needs ${need.line}`, tone: "subtle" };
  return null;
}

/** Fixed heights, so the list can draw only the rows on screen: a group heading, a one-line and a two-line change. */
const HEAD_H = 28;
const ITEM_H = 30;
const ITEM2_H = 48;

type Entry = { kind: "head"; group: SyncGroup } | { kind: "item"; item: SyncItem; l2: ReturnType<typeof secondLine> };

/** The Sync Script's change list: 1. Drop, 2. Change, 3. Create, each change a tick. Space ticks the selected one. */
export default function SyncList({ items, ticked, nameOf, selected, onSelect, onToggle }: ListProps) {
  const box = useRef<HTMLDivElement>(null);
  const order = useMemo(() => (["drop", "change", "create"] as const).flatMap((g) => items.filter((i) => i.group === g)), [items]);
  const entries = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const out: Entry[] = [];
    for (const g of ["drop", "change", "create"] as const) {
      const list = order.filter((i) => i.group === g);
      if (list.length === 0) continue;
      out.push({ kind: "head", group: g });
      for (const item of list) out.push({ kind: "item", item, l2: secondLine(item, byId, nameOf) });
    }
    return out;
  }, [items, order, nameOf]);
  const heights = useMemo(() => entries.map((e) => (e.kind === "head" ? HEAD_H : e.l2 ? ITEM2_H : ITEM_H)), [entries]);
  const win = useWindowed(heights, box);
  const { scrollToIndex } = win;

  useEffect(() => {
    scrollToIndex(entries.findIndex((e) => e.kind === "item" && e.item.id === selected));
  }, [selected, entries, scrollToIndex]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const at = order.findIndex((i) => i.id === selected);
    if (e.key === " " || e.key === "Spacebar") {
      // A focused tick handles its own Space.
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      const cur = order[at];
      if (cur && cur.notScriptable === null) onToggle(cur.id, !ticked.has(cur.id));
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = order[Math.max(0, Math.min(order.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) onSelect(next.id);
    }
  }

  return (
    <div className="sync-list-wrap">
      <div ref={box} className="sync-list" role="group" aria-label="Changes" tabIndex={0} onKeyDown={onKey} onScroll={win.onScroll}>
        <div role="presentation" style={{ height: win.before }} />
        {entries.slice(win.start, win.end).map((e) => {
          if (e.kind === "head") {
            return (
              <div key={`head:${e.group}`} className="sync-group-head" role="heading" aria-level={3}>
                {GROUP_TITLE[e.group]}
              </div>
            );
          }
          const { item, l2 } = e;
          const disabled = item.notScriptable !== null;
          const on = item.id === selected;
          return (
            <label
              key={item.id}
              className={["sync-item", l2 && "sync-item-two", on && "sync-item-on", disabled && "sync-item-off", item.losesData && "sync-item-loss"]
                .filter(Boolean)
                .join(" ")}
              onMouseDown={() => onSelect(item.id)}
            >
              <input type="checkbox" checked={ticked.has(item.id)} disabled={disabled} aria-label={item.line} onChange={(ev) => onToggle(item.id, ev.target.checked)} />
              <MarkIcon mark={item.kind} label={item.kind} />
              <span className="sync-item-line mono" title={item.line}>
                {item.line}
              </span>
              {l2 && (
                <span className={`sync-item-l2 sync-item-l2-${l2.tone}`} title={l2.text}>
                  {l2.text}
                </span>
              )}
            </label>
          );
        })}
        <div role="presentation" style={{ height: win.after }} />
      </div>
      <p className="compare-foot-hint">{SYNC_FOOT_HINT}</p>
    </div>
  );
}

interface ScriptProps {
  plan: SyncPlan;
  dialect: DialectKind;
  target: string;
  production: boolean;
  onCopy(): void;
  onSave(): void;
  onOpenInEditor(): void;
}

/** The script exactly as Apply runs it: comment headings per group, the Production band and note on writes. */
export function ScriptPane({ plan, dialect, target, production, onCopy, onSave, onOpenInEditor }: ScriptProps) {
  const lines = useMemo(() => scriptLines(plan.statements), [plan.statements]);
  const spans = useMemo(() => highlightSql(lines.map((l) => l.text).join("\n"), dialect), [lines, dialect]);
  return (
    <section className={production ? "script-pane prod-wash" : "script-pane"} aria-label="Sync Script">
      <header className="script-pane-head">
        <span className="script-pane-title" title={scriptTitle(plan.statements.length, dialect)}>
          {scriptTitle(plan.statements.length, dialect)}
        </span>
        <span className="spacer" />
        <button type="button" className="button button-small button-quiet" onClick={onCopy}>
          <Icon name="copy" size={14} />
          Copy <Kbd keys="Ctrl+C" />
        </button>
        <button type="button" className="button button-small button-quiet" onClick={onSave}>
          Save as...
        </button>
        <button type="button" className="button button-small button-quiet" onClick={onOpenInEditor}>
          <Icon name="fileCode" size={14} />
          Open in editor
        </button>
      </header>
      <div
        className="script-pane-body mono"
        tabIndex={0}
        aria-label="Sync Script, read-only"
        onKeyDown={(e) => {
          // Ctrl+C copies the whole script unless part of it is selected.
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
            e.preventDefault();
            onCopy();
          }
        }}
      >
        {lines.map((l, i) => {
          const st = l.statement === null ? null : plan.statements[l.statement];
          const band = production && st?.writes;
          const note = production && st?.dropsData && l.last && st.object ? prodNote(st.object, target) : null;
          return (
            <div key={i}>
              <div className={band ? "script-line script-line-w" : "script-line"} data-statement={l.statement ?? undefined}>
                <span className="script-line-n" aria-hidden="true">
                  {i + 1}
                </span>
                <code className="script-line-ct">
                  {(spans[i] ?? []).map((s, j) =>
                    s.cls ? (
                      <span key={j} className={s.cls}>
                        {s.text}
                      </span>
                    ) : (
                      s.text
                    ),
                  )}
                </code>
              </div>
              {note && (
                <div className="script-note">
                  <Icon name="warning" size={14} />
                  {note}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="script-pane-line">
        <Icon name={plan.mode.kind === "copyOnly" ? "info" : "check"} size={14} />
        {plan.line}
      </p>
    </section>
  );
}
