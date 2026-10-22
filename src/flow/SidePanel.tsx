// The diagram tab's side panel (board 11.5): Editor and Assistant on a sliding switch, hidden to a 44 px rail.
// Both panes stay mounted whichever tab shows (the inactive one is `hidden`), and so does the panel while it is
// hidden, so the editor keeps its text and its undo history. The controls carry aria-labels only, no hover text.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import Icon from "../components/Icon";

export type SideTab = "editor" | "assistant";

export interface SidePanelProps {
  tab: SideTab;
  hidden: boolean;
  /** Changes waiting for review; the Assistant tab and the rail show the count. */
  pending: number;
  /** The assistant holds the text read-only: the Editor tab shows a lock. */
  locked?: boolean;
  /** An Ask is running: the Assistant tab shows the working dot. */
  working?: boolean;
  onTab(tab: SideTab): void;
  onHide(): void;
  /** Shows the panel, on `tab` when given (the rail's Editor and Assistant), else on the tab it had. */
  onShow(tab?: SideTab): void;
  editor: ReactNode;
  assistant: ReactNode;
}

const TABS: SideTab[] = ["editor", "assistant"];

export default function SidePanel({ tab, hidden, pending, locked = false, working = false, onTab, onHide, onShow, editor, assistant }: SidePanelProps) {
  const badgeId = useId();
  const ids = useId();
  const tabId = (t: SideTab) => `${ids}-tab-${t}`;
  const paneId = (t: SideTab) => `${ids}-pane-${t}`;
  const tabRefs = useRef<Partial<Record<SideTab, HTMLButtonElement | null>>>({});
  // The tablist's keyboard (WAI-ARIA tabs): Left and Right move to the other tab, which shows at once.
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = TABS.indexOf(tab);
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    onTab(next);
    tabRefs.current[next]?.focus();
  };
  const showRef = useRef<HTMLButtonElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const was = useRef(hidden);
  // The control that was used is gone once the panel swaps with the rail, so focus goes to its counterpart
  // (Ctrl+B keeps working from there).
  useEffect(() => {
    if (was.current === hidden) return;
    was.current = hidden;
    (hidden ? showRef : tabRef).current?.focus();
  }, [hidden]);

  return (
    <>
      {hidden && (
        <nav className="srail" aria-label="Side panel, hidden">
          <button ref={showRef} type="button" className="btn ib" aria-label="Show the side panel" aria-expanded="false" onClick={() => onShow()}>
            <Icon name="sidebar" />
          </button>
          <span className="rdiv" aria-hidden="true" />
          <button type="button" className="btn ib" aria-label="Show the Editor" onClick={() => onShow("editor")}>
            <Icon name="code" />
          </button>
          <button type="button" className="btn ib" aria-label="Show the Assistant" aria-describedby={pending > 0 ? badgeId : undefined} onClick={() => onShow("assistant")}>
            <Icon name="msg" />
            {pending > 0 && (
              <span id={badgeId} className="rbadge">
                {pending.toLocaleString("en-US")}
              </span>
            )}
          </button>
        </nav>
      )}
      <section className="schema-island flow-pane-text flow-side" aria-label="Side panel" hidden={hidden}>
        <div className="flow-side-head">
          <div role="tablist" aria-label="Side panel view" className={`pswitch${tab === "assistant" ? " right" : ""}`}>
            <span className="pthumb" aria-hidden="true" />
            {TABS.map((t) => (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[t] = el;
                  if (t === tab) tabRef.current = el;
                }}
                id={tabId(t)}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls={paneId(t)}
                tabIndex={tab === t ? 0 : -1}
                className={`btn ptab${tab === t ? " on" : ""}`}
                onClick={() => onTab(t)}
                onKeyDown={onTabKey}
              >
                <Icon name={t === "editor" ? "code" : "msg"} />
                <span>{t === "editor" ? "Editor" : "Assistant"}</span>
                {t === "editor" && locked && (
                  <span className="plock">
                    <Icon name="lock" size={14} />
                    <span className="visually-hidden">Read-only</span>
                  </span>
                )}
                {t === "assistant" && pending > 0 && <span className="pcount">{pending.toLocaleString("en-US")}</span>}
                {t === "assistant" && working && (
                  <span className="pdot">
                    <span className="visually-hidden">Working</span>
                  </span>
                )}
              </button>
            ))}
          </div>
          <button type="button" className="btn ib pcol" aria-label="Hide the side panel" aria-expanded="true" onClick={onHide}>
            <Icon name="sidebar" />
          </button>
        </div>
        <div className="flow-side-pane" id={paneId("editor")} role="tabpanel" aria-labelledby={tabId("editor")} hidden={tab !== "editor"}>
          {editor}
        </div>
        <div className="flow-side-pane" id={paneId("assistant")} role="tabpanel" aria-labelledby={tabId("assistant")} hidden={tab !== "assistant"}>
          {assistant}
        </div>
      </section>
    </>
  );
}
