import { sessionSecretsText, useSecretStoreKind } from "../../app/useSecretStoreKind";
import { useEffect, useRef, useState } from "react";
import { clearQueryHistory, dataFolderInfo, errorText, formatBytes, openDataFolder } from "../../api/client";
import type { ConnectionConfig, DataFolderInfo } from "../../api/types";
import Dialog from "../../components/Dialog";
import Icon from "../../components/Icon";
import Select from "../../components/Select";
import { computerNoun, dataBesideProgram, keyringText, programText, thisComputer } from "../../platform";
import { usePrefs } from "../../prefs/usePrefs";
import { Card, type DataState, Row, StateText, defineRows } from "./layout";

const ROW = defineRows({
  location: { label: "Location", terms: "data folder path open folder portable Contura.exe program" },
  contents: { label: "Contents", terms: "Connections Groups Saved Queries Query History size" },
  keep: { label: "Keep history for", terms: "Clear Query History days Forever" },
  passwords: { label: "Passwords", terms: "OS keyring Windows Credential Manager Secret Service copy" },
});
export const DATA_FOLDER_ROWS = Object.values(ROW);

const KEEP: { value: string; label: string }[] = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "365 days" },
  { value: "forever", label: "Forever" },
];

const n = (x: number) => x.toLocaleString("en-US");

/** "9 Connections, 3 Groups, 24 Saved Queries, 4.2 MB of Query History". */
export function contentsText(info: DataFolderInfo): string {
  const many = (count: number, one: string, more: string) => `${n(count)} ${count === 1 ? one : more}`;
  return [
    many(info.connections, "Connection", "Connections"),
    many(info.groups, "Group", "Groups"),
    many(info.savedQueries, "Saved Query", "Saved Queries"),
    `${formatBytes(info.historyBytes, "windows")} of Query History`,
  ].join(", ");
}

/** What the folder holds, read from the Core: loading, the counts, or why it could not be read. */
type Read = { s: "loading" } | { s: "ready"; info: DataFolderInfo } | { s: "error"; text: string };

function PasswordsText() {
  const session = sessionSecretsText(useSecretStoreKind(), "passwords");
  return <>{session ?? `Passwords stay in ${keyringText()} on ${thisComputer()}, so a copied folder asks for each one once.`}</>;
}

/**
 * Settings, Data folder: where everything lives, what it holds and how long history stays (D11). No Move.
 * `connections` is the app's list: the counts are read again when a Connection is added or removed.
 */
export default function DataFolderSection({ connections }: { connections?: readonly ConnectionConfig[] }) {
  const { prefs, update } = usePrefs();
  const [read, setRead] = useState<Read>({ s: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  /** A shorter period waiting for its confirm (R44): saving it deletes older history at once. */
  const [shorter, setShorter] = useState<number | null>(null);
  const reads = useRef(0);

  const load = () => {
    const seq = ++reads.current;
    setRead((r) => (r.s === "ready" ? r : { s: "loading" }));
    return dataFolderInfo().then(
      (info) => seq === reads.current && setRead({ s: "ready", info }),
      (e) => seq === reads.current && setRead({ s: "error", text: `Could not read the data folder: ${errorText(e)}` }),
    );
  };
  // A Connection added or removed while Settings is open changes the counts: read them again.
  const connectionIds = connections?.map((c) => c.id).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [connectionIds]);

  const info = read.s === "ready" ? read.info : null;
  const contents: DataState =
    read.s === "ready" ? { s: "ready", text: contentsText(read.info) } : read.s === "error" ? read : { s: "loading", text: "Counting..." };
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
    <Card>
      <Row
        {...ROW.location}
        hint={`${
          dataBesideProgram()
            ? `Contura is portable. Connections, Groups, Saved Queries, Query History and these settings live in one folder next to ${programText()}.`
            : "Connections, Groups, Saved Queries, Query History and these settings live in this folder."
        } Copy the folder to take everything to another ${computerNoun()}.`}
        below={
          <span className="folder-path mono" title={info?.path ?? undefined}>
            {read.s === "ready" ? (read.info.path ?? "No data folder found") : read.s === "loading" ? "Reading..." : "Unknown"}
          </span>
        }
      >
        <button type="button" className="button" disabled={!info?.path} onClick={() => void openDataFolder().catch((e) => setError(errorText(e)))}>
          <Icon name="folder" size={14} />
          Open folder
        </button>
      </Row>
      <Row {...ROW.contents}>
        <StateText state={contents} />
        {read.s === "error" && (
          <button type="button" className="button" onClick={() => void load()}>
            Try again
          </button>
        )}
      </Row>
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
      <Row {...ROW.passwords} hint={<PasswordsText />}>
        {null}
      </Row>
      {error && (
        <p className="field-error scard-note" role="alert">
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
    </Card>
  );
}
