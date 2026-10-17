import { type ReactNode, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Icon from "./Icon";

/**
 * The window's title bar, drawn by the app (native decorations are off): the
 * app glyph, the given switcher and tabs, then Minimize, Maximize (Restore
 * while maximized) and Close. The strip, the glyph and the empty parts of the
 * tab strip are bare drag regions; buttons and tabs inside them do not drag.
 */
export default function TitleBar({ children }: { children: ReactNode }) {
  // Looked up when used: outside the Tauri window (tests, a plain browser) there is none.
  const win = () => getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    Promise.resolve()
      .then(async () => {
        const w = getCurrentWindow();
        const check = () =>
          w
            .isMaximized()
            .then((m) => alive && setMaximized(m))
            .catch(() => {});
        await check();
        return w.onResized(() => void check());
      })
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const sizeLabel = maximized ? "Restore" : "Maximize";
  return (
    <header className="title-bar" data-tauri-drag-region>
      <span className="title-bar-glyph" data-tauri-drag-region aria-hidden="true">
        <Icon name="contura" />
      </span>
      {children}
      <div className="window-buttons">
        <button type="button" className="window-button" aria-label="Minimize" title="Minimize" onClick={() => void win().minimize()}>
          <Icon name="windowMinimize" />
        </button>
        <button
          type="button"
          className="window-button"
          aria-label={sizeLabel}
          title={sizeLabel}
          onClick={() => void win().toggleMaximize()}
        >
          <Icon name={maximized ? "windowRestore" : "windowMaximize"} />
        </button>
        {/* close() raises the close request, so the Pending Edits ask in App still runs. */}
        <button
          type="button"
          className="window-button window-button-close"
          aria-label="Close"
          title="Close"
          onClick={() => void win().close()}
        >
          <Icon name="close" />
        </button>
      </div>
    </header>
  );
}
