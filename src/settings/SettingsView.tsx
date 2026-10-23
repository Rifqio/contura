import { useEffect, useRef, useState } from "react";
import type { ConnectionConfig, GroupId } from "../api/types";
import { keysFor } from "../commands/keymap";
import { COMMANDS, type CommandId } from "../commands/registry";
import { useKeymap } from "../commands/useCommandKeys";
import Icon, { type IconName } from "../components/Icon";
import Kbd from "../components/Kbd";
import { thisComputer } from "../platform";
import type { AiPage, SettingsSection } from "../shell/tabs";
import AboutSection, { ABOUT_ROWS } from "./sections/AboutSection";
import AiSection, { AI_PAGE_ROWS, AI_PAGES, aiPageOfRow } from "./sections/AiSection";
import AppearanceSection, { APPEARANCE_ROWS } from "./sections/AppearanceSection";
import DataFolderSection, { DATA_FOLDER_ROWS } from "./sections/DataFolderSection";
import EditorSection, { EDITOR_ROWS } from "./sections/EditorSection";
import GeneralSection, { GENERAL_ROWS } from "./sections/GeneralSection";
import KeymapSection, { KEYMAP_ROWS } from "./sections/KeymapSection";
import UpdatesSection, { UPDATES_ROWS } from "./sections/UpdatesSection";
import { FlashContext, PageHead, type RowKey, matches } from "./sections/layout";

const AI_LABEL: Record<AiPage, string> = { provider: "Provider", behaviour: "Behaviour", privacy: "Privacy", tools: "Tools" };

const AI_DESC: Record<AiPage, () => string> = {
  provider: () => "Which model answers, and how Contura reaches it.",
  behaviour: () => "How the assistant answers and where it offers help.",
  privacy: () => `What leaves ${thisComputer()}, and what is kept.`,
  tools: () => "What the assistant may do on its own while it answers.",
};

interface SectionDef {
  key: SettingsSection;
  label: string;
  icon: IconName;
  desc: () => string;
  rows: readonly RowKey[];
}

const SECTIONS: SectionDef[] = [
  { key: "general", label: "General", icon: "settings", desc: () => "What Contura does when it starts.", rows: GENERAL_ROWS },
  { key: "appearance", label: "Appearance", icon: "paint", desc: () => "Theme, data grids and the window.", rows: APPEARANCE_ROWS },
  { key: "editor", label: "Editor", icon: "code", desc: () => "The SQL and DBML editors.", rows: EDITOR_ROWS },
  {
    key: "keymap",
    label: "Keymap",
    icon: "keyboard",
    desc: () => `All ${COMMANDS.length} commands. Change one in its row; when the keys are taken, you choose before anything changes.`,
    rows: KEYMAP_ROWS,
  },
  { key: "ai", label: "AI assistant", icon: "msg", desc: () => "", rows: [] },
  { key: "dataFolder", label: "Data folder", icon: "folder", desc: () => "Connections, Query History and these settings are kept here.", rows: DATA_FOLDER_ROWS },
  { key: "updates", label: "Updates", icon: "refresh", desc: () => "Signed releases from GitHub.", rows: UPDATES_ROWS },
  { key: "about", label: "About Contura", icon: "info", desc: () => "Version and licences. Contura is MIT licensed.", rows: ABOUT_ROWS },
];

/** Every page as search reads it: its place in the nav, its trail and its rows. */
type PageDef = { section: SettingsSection; aiPage?: AiPage; trail: string; rows: readonly RowKey[] };
const PAGES: PageDef[] = SECTIONS.flatMap((s): PageDef[] =>
  s.key === "ai"
    ? AI_PAGES.map((p) => ({ section: s.key, aiPage: p, trail: `AI assistant, ${AI_LABEL[p]}`, rows: AI_PAGE_ROWS[p] }))
    : [{ section: s.key, trail: s.label, rows: s.rows }],
);

type Result =
  | { kind: "row"; key: string; label: string; trail: string; section: SettingsSection; aiPage?: AiPage; row: string }
  | { kind: "command"; key: string; label: string; keys: string; id: CommandId };

/** The page's top padding (app.css .settings-page), kept above a row gone to. */
const PAGE_PADDING = 20;
/** How long a jump waits for its row to draw (the AI settings load first) before saying it is not shown. */
const ROW_WAIT_MS = 2000;

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex="0"]';

/** Focus into what a jump reached, so it never falls to the body when the result button goes. */
function focusIn(el: Element) {
  const control = el.querySelector<HTMLElement>(FOCUSABLE);
  if (control) return control.focus();
  el.setAttribute("tabindex", "-1");
  (el as HTMLElement).focus();
}

interface Props {
  /** The section the nav marks and the page shows. */
  section: SettingsSection;
  /** The AI page shown when `section` is "ai" and no `row` picks one. */
  aiPage?: AiPage;
  onSection: (s: SettingsSection, aiPage?: AiPage) => void;
  /** Changes with every request to show `section`, so asking again goes back to its top (or its row). */
  sectionRequest?: number;
  /** A row or block of the section to go to (`data-row`), such as the AI settings' tools. */
  row?: string;
  /** The open Group, so its AI settings can differ from the global ones; null when none is open. */
  groupId: GroupId | null;
  groupName: string | null;
  connections: ConnectionConfig[];
  onConnectionSaved?: (saved: ConnectionConfig) => void;
  /** Opens the first start guide (Settings > General). */
  onShowGuide?: () => void;
}

/**
 * The Settings tab (D5): search and nav on the left, one section per nav item on the right, in one
 * column. AI assistant is four pages. Every change applies and is saved at once (D6).
 */
export default function SettingsView({ section, aiPage, onSection, sectionRequest = 0, row, groupId, groupName, connections, onConnectionSaved, onShowGuide }: Props) {
  const { map } = useKeymap();
  const [query, setQuery] = useState("");
  /** The row a search result went to; highlighted until the next move. */
  const [picked, setPicked] = useState<string | null>(null);
  const [jumps, setJumps] = useState(0);
  /** A picked row the page does not draw now, such as Preset with another provider. */
  const [missing, setMissing] = useState<string | null>(null);
  /** The jump (by its `jumps` count) a pick asked to take focus; any later move drops it. */
  const focusFor = useRef<number | null>(null);
  const page = useRef<HTMLDivElement>(null);

  const ai = aiPageOfRow(row) ?? aiPage ?? "provider";
  const target = picked ?? row ?? null;
  const searching = query.trim() !== "";

  // A new request from outside (openSettings) drops the highlight of a search result picked earlier.
  useEffect(() => setPicked(null), [sectionRequest]);

  useEffect(() => {
    const box = page.current;
    // Only the pick's own jump may take focus: a nav or sub-page click is a new jump, typing clears it.
    let wantsFocus = focusFor.current === jumps;
    setMissing(null);
    if (!box || searching) return;
    /** Focus moves only while nothing else has it: the result button that went, or a page the user has not touched. */
    const takeFocus = (el: Element) => {
      if (!wantsFocus) return;
      wantsFocus = false;
      focusFor.current = null;
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      focusIn(el);
    };
    // Only the page moves: scrollIntoView would also scroll the clipped boxes around the tab.
    const scrollTo = (el: Element) => {
      const offset = el.getBoundingClientRect().top - box.getBoundingClientRect().top - PAGE_PADDING;
      box.scrollTop = Math.max(0, box.scrollTop + offset);
    };
    const land = (el: Element) => {
      scrollTo(el);
      takeFocus(el);
    };
    const heading = () => box.querySelector("h1");
    const rowEl = () => (target ? box.querySelector(`[data-row="${CSS.escape(target)}"]`) : null);
    const el = rowEl();
    if (el) land(el);
    else box.scrollTop = 0;
    if (!target || el) {
      const h = heading();
      if (h) takeFocus(h);
      return;
    }
    // The row may draw once its page has loaded (the AI settings): go there when it does, however late.
    const seen = new MutationObserver(() => {
      const found = rowEl();
      if (!found) return;
      seen.disconnect();
      window.clearTimeout(giveUp);
      setMissing(null);
      land(found);
    });
    seen.observe(box, { childList: true, subtree: true });
    // Some rows show only for a provider, a Group or an update: say so after a while, and keep watching.
    const giveUp = window.setTimeout(() => {
      setMissing(target);
      const h = heading();
      if (h) takeFocus(h);
    }, ROW_WAIT_MS);
    return () => {
      seen.disconnect();
      window.clearTimeout(giveUp);
    };
  }, [section, ai, sectionRequest, target, jumps, searching]);

  function go(s: SettingsSection, p?: AiPage, rowId?: string) {
    // Nav buttons stay; a result button goes with the search, so the jump takes focus.
    focusFor.current = rowId !== undefined ? jumps + 1 : null;
    setQuery("");
    setPicked(rowId ?? null);
    setJumps((n) => n + 1);
    onSection(s, p);
  }

  const results: Result[] = [];
  if (searching) {
    for (const p of PAGES) {
      for (const r of p.rows) {
        if (!matches(query, r.label, r.terms)) continue;
        const trail = r.card ? `${p.trail}, ${r.card}` : p.trail;
        results.push({ kind: "row", key: `${p.section}:${r.id}`, label: r.label, trail, section: p.section, aiPage: p.aiPage, row: r.id });
      }
    }
    for (const c of COMMANDS) {
      const keys = keysFor(map, c.id);
      if (matches(query, c.title, keys.join(" "))) results.push({ kind: "command", key: c.id, label: c.title, keys: keys[0] ?? "", id: c.id });
    }
  }

  const current = SECTIONS.find((s) => s.key === section) ?? SECTIONS[1];
  const title = section === "ai" ? `AI assistant: ${AI_LABEL[ai]}` : current.label;
  const desc = section === "ai" ? AI_DESC[ai]() : current.desc();

  function body() {
    switch (section) {
      case "general":
        return <GeneralSection onShowGuide={onShowGuide} />;
      case "editor":
        return <EditorSection />;
      case "keymap":
        return null;
      case "ai":
        return (
          <AiSection groupId={groupId} groupName={groupName} connections={connections} onConnectionSaved={onConnectionSaved ?? (() => {})} pages={[ai]} />
        );
      case "dataFolder":
        return <DataFolderSection connections={connections} />;
      case "updates":
        return <UpdatesSection />;
      case "about":
        return <AboutSection />;
      default:
        return <AppearanceSection />;
    }
  }

  const q = query.trim();
  return (
    <div className="settings-view">
      <div className="snav-panel">
        <label className="snav-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              focusFor.current = null;
              setQuery(e.target.value);
            }}
          />
        </label>
        <nav className="snav" aria-label="Settings sections">
          {SECTIONS.map((s) => {
            // While searching the results replace the page, so no item is marked current.
            const on = !searching && s.key === section;
            return (
              <div key={s.key} className="snav-item">
                <button
                  type="button"
                  className={on && s.key !== "ai" ? "on" : undefined}
                  aria-current={on && s.key !== "ai" ? "page" : undefined}
                  onClick={() => go(s.key)}
                >
                  <Icon name={s.icon} size={14} />
                  {s.label}
                  {s.key === "keymap" && (
                    <>
                      <span className="visually-hidden">, </span>
                      <span className="snav-count">{COMMANDS.length}</span>
                    </>
                  )}
                </button>
                {s.key === "ai" && section === "ai" && (
                  <div className="snav-subs">
                    {AI_PAGES.map((p) => {
                      const subOn = !searching && p === ai;
                      return (
                        <button
                          key={p}
                          type="button"
                          className={subOn ? "snav-sub on" : "snav-sub"}
                          aria-current={subOn ? "page" : undefined}
                          onClick={() => go("ai", p)}
                        >
                          {AI_LABEL[p]}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>
      <div className="settings-scroll" ref={page}>
        <div className="settings-page" data-section={searching ? undefined : section}>
          {searching ? (
            <>
              <PageHead
                title={results.length > 0 ? `${results.length.toLocaleString("en-US")} ${results.length === 1 ? "match" : "matches"} for "${q}"` : `Nothing matches "${q}"`}
                desc="Settings and shortcuts from every section. Pick one to go to it."
              />
              {results.length > 0 && (
                <div className="scard" role="list" aria-label="Search results">
                  {results.map((r) => (
                    <div key={r.key} role="listitem">
                      <button
                        type="button"
                        className="sresult"
                        onClick={() => (r.kind === "row" ? go(r.section, r.aiPage, r.row) : go("keymap", undefined, r.id))}
                      >
                        <span className="srow-text">
                          <span className="srow-label">{r.label}</span>
                          <span className="srow-hint">{r.kind === "row" ? r.trail : "Keymap"}</span>
                        </span>
                        {r.kind === "command" && r.keys && <Kbd keys={r.keys} />}
                        <Icon name="chevronRight" size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <FlashContext.Provider value={target}>
              {section === "keymap" ? <KeymapSection title={current.label} desc={desc} /> : <PageHead title={title} desc={desc} />}
              {missing !== null && (
                <p className="settings-note muted" role="status">
                  That setting is not shown now: it depends on the provider, the open Group, or a new version being found.
                </p>
              )}
              {body()}
            </FlashContext.Provider>
          )}
        </div>
      </div>
    </div>
  );
}
