import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AiAccess, ConnectionConfig, ConnectionId } from "../api/types";
import { hintFor, withHint } from "../commands/keymap";
import { useKeymap } from "../commands/useCommandKeys";
import DbMark from "../components/DbMark";
import Icon, { type IconName } from "../components/Icon";
import Kbd from "../components/Kbd";
import Menu, { type MenuItem } from "../components/Menu";

/**
 * PR40: a header narrower than this keeps only icons for Run all, Explain and Format. E2: the header also
 * turns compact whenever the labelled strip would overflow once the database name has shrunk to its minimum,
 * so Save and History stay reachable (1280 px window, Run on PROD, a 20-character database name).
 */
const COMPACT_BELOW_PX = 720;

const AI_CHIP: Record<AiAccess, { text: string; tone: string }> = {
  never: { text: "AI: Nothing", tone: "chip-neutral" },
  schema: { text: "AI: Schema only", tone: "chip-info" },
  schemaQuery: { text: "AI: Schema and query text", tone: "chip-info" },
  schemaQueryRows: { text: "AI: Plus sample rows", tone: "chip-warning" },
};

interface Props {
  connection: ConnectionConfig | null;
  connections: ConnectionConfig[];
  openIds: ReadonlySet<ConnectionId>;
  /** The databases of the Connection; null for SQLite or while not known: no database button. */
  databases: string[] | null;
  database: string | null;
  production: boolean;
  running: boolean;
  /** The current statement writes on a Production Connection: Run becomes Run on PROD. */
  writeHazard: boolean;
  canRun: boolean;
  /** Why Run is off, shown as its tooltip; null when it is not blocked. */
  blockedTip: string | null;
  /** Run all is off for the same kind of reason. */
  runAllBlockedTip?: string | null;
  /** What to say after the Connection's name while it is not open: "closed", "connecting..." or "failed". */
  stateWord?: string | null;
  /** The assistant panel is open, so the header is short of room. */
  compact: boolean;
  aiAccess: AiAccess | null;
  historyOpen: boolean;
  assistantOpen?: boolean;
  onPickConnection(id: ConnectionId | null): void;
  onPickDatabase(name: string): void;
  onRun(): void;
  onRunAll(): void;
  onExplain(): void;
  onFormat(): void;
  onSave(): void;
  onToggleHistory(): void;
  onToggleAssistant?(): void;
  onCancel(): void;
}

/** The one 32 px strip above the query editor (E1, E2). */
export default function EditorHeader({
  connection,
  connections,
  openIds,
  databases,
  database,
  production,
  running,
  writeHazard,
  canRun,
  blockedTip,
  runAllBlockedTip = null,
  stateWord = null,
  compact,
  aiAccess,
  historyOpen,
  assistantOpen = false,
  onPickConnection,
  onPickDatabase,
  onRun,
  onRunAll,
  onExplain,
  onFormat,
  onSave,
  onToggleHistory,
  onToggleAssistant,
  onCancel,
}: Props) {
  const map = useKeymap().map;
  const runKey = hintFor(map, "query.run");
  const strip = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const icons = compact || narrow;
  const state = useRef({ icons, narrow, need: 0 });
  state.current.icons = icons;
  state.current.narrow = narrow;
  /** Turns the labels off when they would not fit, and back on once the strip is as wide as they needed. */
  const fit = useCallback(() => {
    const el = strip.current;
    const width = el?.clientWidth ?? 0;
    if (!el || width === 0) return;
    const s = state.current;
    if (!s.icons) {
      if (width < COMPACT_BELOW_PX || el.scrollWidth > width + 1) {
        s.need = Math.max(el.scrollWidth, COMPACT_BELOW_PX);
        setNarrow(true);
      }
    } else if (s.narrow && width >= s.need) setNarrow(false);
  }, []);
  // After every render: Run on PROD, a database or the AI chip can widen the strip without a resize.
  useLayoutEffect(fit);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [fit]);

  const connectionItems: MenuItem[] = connections.map((c) => ({
    key: c.id,
    label: c.name,
    icon: <DbMark dialect={c.dialect} open={openIds.has(c.id)} size={14} label={null} />,
    hint: openIds.has(c.id) ? undefined : "closed",
    current: c.id === connection?.id,
    onSelect: () => onPickConnection(c.id),
  }));
  const databaseItems: MenuItem[] = (databases ?? []).map((d) => ({
    key: d,
    label: d,
    current: d === database,
    onSelect: () => onPickDatabase(d),
  }));

  const labelled = (icon: IconName, label: string, key: string | null, onClick: () => void, disabled?: boolean, tip?: string | null) => {
    const named = withHint(label, key);
    return icons ? (
      <button type="button" className="icon-button" aria-label={named} title={tip ?? named} disabled={disabled} onClick={onClick}>
        <Icon name={icon} size={14} />
      </button>
    ) : (
      <button type="button" className="button button-small button-quiet" title={tip ?? (key ? named : undefined)} disabled={disabled} onClick={onClick}>
        <Icon name={icon} size={14} />
        {label}
      </button>
    );
  };

  const chip = aiAccess ? AI_CHIP[aiAccess] : null;
  const chipTitle = withHint(connection ? `AI access for ${connection.name}. Open the assistant` : "Open the assistant", hintFor(map, "assistant.toggle"));

  return (
    <div className="editor-header" role="toolbar" aria-label="Query" ref={strip}>
      <Menu
        label="Connection"
        trigger={(p) => (
          <button type="button" {...p} className="button button-small button-quiet editor-header-connection" disabled={running}>
            {connection && <DbMark dialect={connection.dialect} open={openIds.has(connection.id)} size={14} label={null} />}
            <span className="editor-header-name">{connection ? connection.name : "Choose a Connection"}</span>
            {connection && stateWord && <span className="editor-header-state">{stateWord}</span>}
            <Icon name="chevronDown" size={14} />
          </button>
        )}
        items={connectionItems}
        compact
      />
      {production && <span className="production-label">PRODUCTION</span>}
      {connection?.readOnly && (
        <span className="chip editor-header-readonly" title={`${connection.name} is Read-only: it blocks every write`}>
          <Icon name="lock" size={14} />
          Read-only
        </span>
      )}
      {databases && (
        <Menu
          label="Database"
          trigger={(p) => (
            <button type="button" {...p} className="button button-small button-quiet editor-header-db" title={database ?? undefined} disabled={running}>
              <Icon name="database" size={14} />
              <span className="editor-header-name">{database ?? "Database"}</span>
              <Icon name="chevronDown" size={14} />
            </button>
          )}
          items={databaseItems}
          compact
        />
      )}
      <span className="editor-header-divider" aria-hidden="true" />
      {running ? (
        <button type="button" className="button button-small button-danger-fill editor-header-run" onClick={onCancel}>
          <Icon name="stop" size={14} />
          Cancel
        </button>
      ) : (
        <>
          <button
            type="button"
            className={`${writeHazard ? "button button-small button-prod" : "button button-small button-primary"} editor-header-run`}
            disabled={!canRun || !!blockedTip}
            title={blockedTip ?? undefined}
            // R8: the button shows PROD; its spoken name keeps the word.
            aria-label={writeHazard ? `Run on Production${runKey ? ` (${runKey})` : ""}` : undefined}
            onClick={onRun}
          >
            <Icon name="play" size={14} />
            {writeHazard ? "Run on PROD" : "Run"} {runKey && <Kbd keys={runKey} />}
          </button>
          {labelled("playAll", "Run all", hintFor(map, "query.runAll"), onRunAll, !canRun || !!runAllBlockedTip, runAllBlockedTip)}
        </>
      )}
      {labelled("explain", "Explain", hintFor(map, "query.explain"), onExplain)}
      {labelled("format", "Format", hintFor(map, "query.format"), onFormat)}
      <span className="spacer" />
      {chip &&
        (onToggleAssistant ? (
          <button
            type="button"
            className={`chip ${chip.tone}`}
            aria-pressed={assistantOpen}
            title={chipTitle}
            onClick={onToggleAssistant}
          >
            <Icon name="msg" size={14} />
            {chip.text}
          </button>
        ) : (
          <span className={`chip ${chip.tone}`} title={connection ? `AI access for ${connection.name}` : undefined}>
            <Icon name="msg" size={14} />
            {chip.text}
          </span>
        ))}
      <button type="button" className="icon-button" aria-label={withHint("Save query", hintFor(map, "query.save"))} title={withHint("Save query", hintFor(map, "query.save"))} onClick={onSave}>
        <Icon name="save" size={14} />
      </button>
      <button
        type="button"
        className={historyOpen ? "icon-button icon-button-on" : "icon-button"}
        aria-label="Query History"
        aria-pressed={historyOpen}
        title="Query History"
        onClick={onToggleHistory}
      >
        <Icon name="history" size={14} />
      </button>
    </div>
  );
}
