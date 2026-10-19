import { type ReactNode, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Icon from "./Icon";

/** Item 14: the Contura mark (the logo masters' small-size cut): two stacked discs and the teal one between. */
export function ConturaLogo({ size = 22 }: { size?: number }) {
  return (
    <svg className="contura-logo" width={size} height={size} viewBox="0 0 256 256" role="img" aria-label="Contura">
      <path className="contura-logo-stack" d="M52 40A60 12 0 0 1 172 40V80A60 12 0 0 1 52 80Z" />
      <path className="contura-logo-stack" d="M52 172A60 12 0 0 0 172 172V212A60 12 0 0 1 52 212Z" />
      <path className="contura-logo-teal" d="M84 104A60 12 0 0 0 204 104V148A60 12 0 0 1 84 148Z" />
    </svg>
  );
}

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
      <span className="title-bar-glyph" data-tauri-drag-region>
        <ConturaLogo />
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
