import { sessionSecretsText, useSecretStoreKind } from "../../app/useSecretStoreKind";
import { useEffect, useState } from "react";
import { clearQueryHistory, dataFolderInfo, errorText, formatBytes, openDataFolder } from "../../api/client";
import type { ConnectionConfig, DataFolderInfo } from "../../api/types";
import Dialog from "../../components/Dialog";
import Icon from "../../components/Icon";
import Select from "../../components/Select";
import { computerNoun, dataBesideProgram, keyringText, programText, thisComputer } from "../../platform";
import { usePrefs } from "../../prefs/usePrefs";
import { Row, type RowKey, Section, useRowShown } from "./layout";

const ROW = {
  location: { label: "Location", terms: "data folder path open folder portable Contura.exe program" },
  contents: { label: "Contents", terms: "Connections Groups Saved Queries Query History size" },
  keep: { label: "Keep history for", terms: "Clear Query History days Forever" },
  passwords: { label: "Passwords", terms: "OS keyring Windows Credential Manager Secret Service copy" },
} satisfies Record<string, RowKey>;
export const DATA_FOLDER_ROWS: readonly RowKey[] = Object.values(ROW);

const KEEP: { value: string; label: string }[] = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "365 days" },
  { value: "forever", label: "Forever" },
];

function Location({ info, onError }: { info: DataFolderInfo | null; onError: (e: string) => void }) {
  if (!useRowShown(ROW.location)) return null;
  return (
    <>
      <p className="muted">
        {dataBesideProgram()
          ? `Contura is portable. Connections, Groups, Saved Queries, Query History and these settings live in one folder next to ${programText()}.`
          : "Connections, Groups, Saved Queries, Query History and these settings live in the folder below."}{" "}
        {`Copy the folder to take everything to another ${computerNoun()}.`}
      </p>
      <div className="folder-row">
        <span className="folder-path mono" title={info?.path ?? undefined}>
          {info ? (info.path ?? "No data folder found") : ""}
        </span>
        <button type="button" className="button" disabled={!info?.path} onClick={() => void openDataFolder().catch((e) => onError(errorText(e)))}>
          <Icon name="folder" size={14} />
          Open folder
        </button>
      </div>
    </>
  );
}

function Contents({ info }: { info: DataFolderInfo | null }) {
  if (!useRowShown(ROW.contents)) return null;
  const counts: [string, string][] = [
    ["Connections", info ? info.connections.toLocaleString("en-US") : ""],
    ["Groups", info ? info.groups.toLocaleString("en-US") : ""],
    ["Saved Queries", info ? info.savedQueries.toLocaleString("en-US") : ""],
    ["Query History", info ? formatBytes(info.historyBytes, "windows") : ""],
  ];
  return (
    <ul className="dstat" aria-label="What the data folder holds">
      {counts.map(([label, value]) => (
        <li key={label}>
          <span>{label}</span>
          <b>{value}</b>
        </li>
      ))}
    </ul>
  );
}

function PasswordsNote() {
  const session = sessionSecretsText(useSecretStoreKind(), "passwords");
  if (!useRowShown(ROW.passwords)) return null;
  return <p className="srow-note-line">{session ?? `Passwords stay in ${keyringText()} on ${thisComputer()}, so a copied folder asks for each one once.`}</p>;
}

/**
 * Settings, Data folder: where everything lives, what it holds and how long history stays (D11). No Move.
 * `connections` is the app's list: the counts are read again when a Connection is added or removed.
 */
export default function DataFolderSection({ connections }: { connections?: readonly ConnectionConfig[] }) {
  const { prefs, update } = usePrefs();
  const [info, setInfo] = useState<DataFolderInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  /** A shorter period waiting for its confirm (R44): saving it deletes older history at once. */
  const [shorter, setShorter] = useState<number | null>(null);

  const load = () =>
    dataFolderInfo()
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
  // A Connection added or removed while Settings is open changes the counts: read them again.
  const connectionIds = connections?.map((c) => c.id).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [connectionIds]);

  const keep = prefs.historyKeepDays === null ? "forever" : String(prefs.historyKeepDays);
  const keepOptions = KEEP.some((o) => o.value === keep) ? KEEP : [...KEEP, { value: keep, label: `${keep} days` }];

  async function clear() {
    setAsking(false);
    setError(null);
    try {
      await clearQueryHistory(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Section id="dataFolder" title="Data folder" rows={DATA_FOLDER_ROWS}>
      <Location info={info} onError={setError} />
      <Contents info={info} />
      <Row {...ROW.keep}>
        <Select
          label="Keep history for"
          value={keep}
          options={keepOptions}
          onChange={(v) => {
            const next = v === "forever" ? null : Number(v);
            const now = prefs.historyKeepDays;
            // Shorter deletes history, so it asks first; longer (or Forever) deletes nothing and applies at once.
            if (next !== null && (now === null || next < now)) setShorter(next);
            else update({ historyKeepDays: next });
          }}
          className="keep-select"
        />
        <button type="button" className="button button-ghost button-danger-text" onClick={() => setAsking(true)}>
          <Icon name="trash" size={14} />
          Clear Query History...
        </button>
      </Row>
      <PasswordsNote />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {shorter !== null && (
        <Dialog title={`Delete Query History older than ${shorter} days?`} size="confirm" onClose={() => setShorter(null)}>
          <div className="dialog-body">
            <p>{`Query History older than ${shorter} days is deleted now, and from then on. This can't be undone. Saved Queries are kept.`}</p>
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" data-autofocus onClick={() => setShorter(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger-fill"
              onClick={() => {
                update({ historyKeepDays: shorter });
                setShorter(null);
              }}
            >
              Delete
            </button>
          </footer>
        </Dialog>
      )}
      {asking && (
        <Dialog title="Clear Query History" size="confirm" onClose={() => setAsking(false)}>
          <div className="dialog-body">
            <p>Clear the Query History of every Connection? Saved Queries are kept.</p>
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" data-autofocus onClick={() => setAsking(false)}>
              Keep it
            </button>
            <button type="button" className="button button-danger-fill" onClick={() => void clear()}>
              Clear
            </button>
          </footer>
        </Dialog>
      )}
    </Section>
  );
}
