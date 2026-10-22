import { useEffect, useRef, useState } from "react";
import type { ConnectionConfig, GroupId } from "../api/types";
import Icon, { type IconName } from "../components/Icon";
import type { SettingsSection } from "../shell/tabs";
import AboutSection, { ABOUT_ROWS } from "./sections/AboutSection";
import AiSection, { AI_ROWS } from "./sections/AiSection";
import AppearanceSection, { APPEARANCE_ROWS } from "./sections/AppearanceSection";
import DataFolderSection, { DATA_FOLDER_ROWS } from "./sections/DataFolderSection";
import EditorSection, { EDITOR_ROWS } from "./sections/EditorSection";
import KeymapSection, { KEYMAP_ROWS } from "./sections/KeymapSection";
import { type RowKey, SearchContext, sectionShown } from "./sections/layout";

const SECTIONS: { key: SettingsSection; label: string; icon: IconName; rows: readonly RowKey[] }[] = [
  { key: "appearance", label: "Appearance", icon: "paint", rows: APPEARANCE_ROWS },
  { key: "editor", label: "Editor", icon: "code", rows: EDITOR_ROWS },
  { key: "keymap", label: "Keymap", icon: "keyboard", rows: KEYMAP_ROWS },
  { key: "ai", label: "AI assistant", icon: "msg", rows: AI_ROWS },
  { key: "dataFolder", label: "Data folder", icon: "folder", rows: DATA_FOLDER_ROWS },
  { key: "about", label: "About Contura", icon: "info", rows: ABOUT_ROWS },
];

/** The page's top padding (app.css .settings-page), kept above a section scrolled to. */
const PAGE_PADDING = 20;

interface Props {
  /** The section the nav marks and the page scrolls to. */
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  /** Changes with every request to show `section`, so asking again scrolls back to it. */
  sectionRequest?: number;
  /** A block of the section to scroll to instead (`data-row`), such as the AI settings' tools table. */
  row?: string;
  /** The open Group, so its AI settings can differ from the global ones; null when none is open. */
  groupId: GroupId | null;
  groupName: string | null;
  connections: ConnectionConfig[];
  onConnectionSaved?: (saved: ConnectionConfig) => void;
}

/**
 * The Settings tab (D5, frame l): search and nav on the left, one scrolling page in two
 * columns on the right. Every change applies and is saved at once (D6).
 */
export default function SettingsView({ section, onSection, sectionRequest = 0, row, groupId, groupName, connections, onConnectionSaved }: Props) {
  const [query, setQuery] = useState("");
  const [jumps, setJumps] = useState(0);
  const page = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = page.current;
    if (!box) return;
    // Only the page moves: scrollIntoView would also scroll the clipped boxes around the tab.
    const scrollTo = (el: Element) => {
      const offset = el.getBoundingClientRect().top - box.getBoundingClientRect().top - PAGE_PADDING;
      box.scrollTop = Math.max(0, box.scrollTop + offset);
    };
    const rowEl = () => (row ? box.querySelector(`[data-section="${section}"] [data-row="${row}"]`) : null);
    const target = rowEl() ?? box.querySelector(`[data-section="${section}"]`);
    if (target) scrollTo(target);
    if (!row || rowEl()) return;
    // The block may draw once its section has loaded (the AI settings' tools table): go there when it does.
    const seen = new MutationObserver(() => {
      const el = rowEl();
      if (!el) return;
      seen.disconnect();
      scrollTo(el);
    });
    seen.observe(box, { childList: true, subtree: true });
    return () => seen.disconnect();
  }, [section, sectionRequest, row, jumps]);

  const nothing = query.trim() !== "" && !SECTIONS.some((s) => sectionShown(query, s.label, s.rows));

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
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <nav className="snav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={s.key === section ? "on" : undefined}
              aria-current={s.key === section ? "page" : undefined}
              onClick={() => {
                // A search may hide the section; show everything again, then go there.
                setQuery("");
                setJumps((n) => n + 1);
                onSection(s.key);
              }}
            >
              <Icon name={s.icon} size={14} />
              {s.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="settings-scroll" ref={page}>
        <div className="settings-page">
          <header className="settings-head">
            <h1>Settings</h1>
            <p>Changes apply right away and are saved in the data folder.</p>
          </header>
          <SearchContext.Provider value={query}>
            {nothing && <p className="muted">No settings match "{query.trim()}".</p>}
            <div className="settings-cols">
              <div className="settings-col">
                <AppearanceSection />
                <EditorSection />
                <KeymapSection />
              </div>
              <div className="settings-col">
                <AiSection groupId={groupId} groupName={groupName} connections={connections} onConnectionSaved={onConnectionSaved ?? (() => {})} />
                <DataFolderSection connections={connections} />
              </div>
            </div>
            <AboutSection />
          </SearchContext.Provider>
        </div>
      </div>
    </div>
  );
}
