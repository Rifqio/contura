import { useEffect } from "react";
import { formatBytes, openUrl } from "../../api/client";
import type { CheckResult, UpdateStatus } from "../../api/updates";
import Dialog from "../../components/Dialog";
import Icon from "../../components/Icon";
import { RESTART_ASK, cancelAsk, checkNow, chooseChecks, loadUpdates, resolveAndRestart, updateAndRestart, useUpdates } from "../../update/updateStore";
import { Row, type RowKey, Section, SwitchRow, useRowShown } from "./layout";

const ROW = {
  checks: { label: "Check for updates", terms: "update updates new version GitHub automatic daily privacy" },
  version: { label: "Current version", terms: "Contura version Check now last check update" },
  available: { label: "New version", terms: "update release notes Update and restart download" },
} satisfies Record<string, RowKey>;
export const UPDATES_ROWS: readonly RowKey[] = Object.values(ROW);

/** Exactly what a check sends; the README's privacy section says the same. */
export const UPDATES_PRIVACY =
  "Contura asks github.com for the latest release once a day: a GET of the release manifest, and, when you update, a GET of the new file. Nothing else is sent: no data, no Connections, no usage.";

function when(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function resultText(r: CheckResult | null): string {
  if (!r) return "";
  if (r.kind === "upToDate") return "Contura is up to date.";
  if (r.kind === "available") return `Contura ${r.version} is available.`;
  return r.message;
}

export function lastCheckText(s: UpdateStatus): string {
  if (s.lastCheckMs === null) return "Not checked yet.";
  return `Last checked ${when(s.lastCheckMs)}. ${resultText(s.lastResult)}`;
}

function Available({ status }: { status: UpdateStatus }) {
  const { phase } = useUpdates();
  const shown = useRowShown(ROW.available);
  const offer = status.offer;
  if (!offer || !shown) return null;
  const busy = phase.kind !== "idle";
  let action;
  if (status.canInstall) {
    action = (
      <button type="button" className="button button-primary" disabled={busy} onClick={() => void updateAndRestart()}>
        <Icon name="arrowUp" size={14} />
        {status.ready ? "Restart to update" : "Update and restart"}
      </button>
    );
  } else {
    action = (
      <button type="button" className="button" onClick={() => void openUrl(offer.releaseUrl).catch(() => {})}>
        <Icon name="external" size={14} />
        {status.install === "package" ? "Download the new .deb" : "Open the release page"}
      </button>
    );
  }
  return (
    <div className="update-offer" data-row="available">
      <h3>{`Contura ${offer.version}`}</h3>
      {offer.notes.trim() !== "" && <p className="update-notes">{offer.notes}</p>}
      <div className="update-actions">
        {action}
        {phase.kind === "downloading" && (
          <span className="update-progress" role="status">
            {phase.total ? `Downloading ${formatBytes(phase.done, "windows")} of ${formatBytes(phase.total, "windows")}` : `Downloading ${formatBytes(phase.done, "windows")}`}
          </span>
        )}
        {phase.kind === "restarting" && (
          <span className="update-progress" role="status">
            Restarting
          </span>
        )}
      </div>
      {phase.kind === "downloading" && phase.total ? (
        <progress className="update-bar" max={phase.total} value={phase.done} aria-label="Download progress" />
      ) : null}
      {status.canInstall && <p className="srow-note-line">The download is checked against its signature before anything is replaced. The data folder is not touched.</p>}
    </div>
  );
}

/** Settings > Updates (ADR 0026): the switch, Check now, the version, the last check, and a newer release. */
export default function UpdatesSection() {
  const { status, phase, error, ask } = useUpdates();
  // Opened before the App loaded the state (or in a test): read it here.
  useEffect(() => {
    if (!status) void loadUpdates();
  }, [status]);
  const offer = status?.offer;
  return (
    <Section id="updates" title="Updates" rows={UPDATES_ROWS}>
      <SwitchRow {...ROW.checks} checked={status?.checks === true} onChange={(on) => void chooseChecks(on)} hint={UPDATES_PRIVACY} />
      <Row {...ROW.version}>
        <span className="update-version">{status ? `Contura ${status.currentVersion}` : "Contura"}</span>
        <button type="button" className="button" disabled={!status || phase.kind !== "idle"} onClick={() => void checkNow()}>
          <Icon name="refresh" size={14} />
          {phase.kind === "checking" ? "Checking" : "Check now"}
        </button>
      </Row>
      {status && <p className="srow-note-line update-last">{lastCheckText(status)}</p>}
      {status && <Available status={status} />}
      {error && (
        <p className="field-error" role="alert">
          {error}
          {offer && (
            <>
              {" "}
              <button type="button" className="link-button" onClick={() => void openUrl(offer.releaseUrl).catch(() => {})}>
                Open the release page
              </button>
            </>
          )}
        </p>
      )}
      {ask && (
        <Dialog title={RESTART_ASK} size="confirm" onClose={cancelAsk}>
          <div className="dialog-body">
            <p>Contura restarts to update. These have changes that are not saved:</p>
            <ul className="update-ask-list">
              {ask.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" data-autofocus onClick={cancelAsk}>
              Cancel
            </button>
            <button type="button" className="button button-primary" onClick={() => void resolveAndRestart()}>
              Save or discard
            </button>
          </footer>
        </Dialog>
      )}
    </Section>
  );
}
