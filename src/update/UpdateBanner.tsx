import { chooseChecks, useUpdates } from "./updateStore";

export const PROMPT_TEXT = "Check GitHub for new versions of Contura? Contura asks github.com once a day; nothing else is sent.";

/**
 * The first-start prompt (ADR 0026): one quiet banner, not a dialog. Update checks stay off
 * until Turn on; Not now is remembered and the banner does not come back. Settings > Updates
 * has the switch either way.
 */
export default function UpdateBanner() {
  const { status, promptHidden } = useUpdates();
  if (!status || status.checks !== null || promptHidden) return null;
  return (
    <div className="update-banner" role="region" aria-label="Update checks">
      <p>{PROMPT_TEXT}</p>
      <span className="spacer" />
      <button type="button" className="button button-small button-primary" onClick={() => void chooseChecks(true)}>
        Turn on
      </button>
      <button type="button" className="button button-small button-ghost" onClick={() => void chooseChecks(false)}>
        Not now
      </button>
    </div>
  );
}
