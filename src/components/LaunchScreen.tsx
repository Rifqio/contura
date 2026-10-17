import { useEffect, useState } from "react";
import Icon from "./Icon";
import TitleBar from "./TitleBar";

/** Loading the Groups, the Connections and the last Group. */
const STEPS = 3;
/** D24: nothing shows for a quick start; a slow one says what it is doing after this long. */
const SHOW_AFTER_MS = 300;
const DETAIL_AFTER_MS = 2000;

interface Props {
  /** How many of the three startup reads are done. */
  step: 0 | 1 | 2 | 3;
  /** `Date.now()` when loading began. */
  startedAt: number;
}

/** The bare window while the app starts: one line after 300 ms, then what it reads and a progress bar after 2 s (D24, PR36, HE5). */
export default function LaunchScreen({ step, startedAt }: Props) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  // Frames 10d and 10e: the bare title bar (glyph and window buttons, so the window can be moved
  // and closed while it loads), the line in the middle and an empty status bar.
  return (
    <div className="app app-launch">
      <TitleBar>{null}</TitleBar>
      <div className="launch" role="status">
        {elapsed >= SHOW_AFTER_MS && (
          <div className="launch-box">
            <Icon name="contura" size={20} />
            <span className="launch-title">Loading your Groups and Connections...</span>
            {elapsed >= DETAIL_AFTER_MS && (
              <>
                <span className="launch-detail">
                  Reading Connections from the data folder, {step} of {STEPS}
                </span>
                <div
                  className="launch-bar"
                  role="progressbar"
                  aria-label="Loading"
                  aria-valuemin={0}
                  aria-valuemax={STEPS}
                  aria-valuenow={step}
                >
                  <i style={{ width: `${(step / STEPS) * 100}%` }} />
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="app-status" aria-hidden="true" />
    </div>
  );
}
