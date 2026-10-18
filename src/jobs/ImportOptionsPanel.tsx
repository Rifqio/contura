import type { Delimiter, EmptyAs, FileSummary, Format, ImportOptions, OnError } from "../api/types";
import Segmented from "../components/Segmented";
import Select from "../components/Select";
import Switch from "../components/Switch";
import { fileHint } from "./importModel";

const FORMATS: { value: Format; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "xlsx", label: "Excel" },
  { value: "sql", label: "SQL" },
];

const DELIMITERS: { value: Delimiter; label: string }[] = [
  { value: "comma", label: "Comma" },
  { value: "semicolon", label: "Semicolon" },
  { value: "tab", label: "Tab" },
];

const ON_ERROR: { value: OnError; label: string }[] = [
  { value: "stop", label: "Stop and roll everything back" },
  { value: "skip", label: "Skip the row and list it after" },
];

const EMPTY_AS: { value: EmptyAs; label: string }[] = [
  { value: "null", label: "NULL" },
  { value: "emptyText", label: "Empty text" },
];

/** "Commit every N rows": the spec's one step. */
export const COMMIT_EVERY = 10_000;

interface Props {
  path: string;
  summary: FileSummary | null;
  format: Format | null;
  options: ImportOptions;
  /** The file is being read. */
  busy: boolean;
  onBrowse(): void;
  onFormat(format: Format): void;
  onOptions(options: ImportOptions): void;
}

/** The left panel of the Import tab: the file and how to read and write it. */
export default function ImportOptionsPanel({ path, summary, format, options, busy, onBrowse, onFormat, onOptions }: Props) {
  const set = (patch: Partial<ImportOptions>) => onOptions({ ...options, ...patch });
  const data = format !== null && format !== "sql";
  return (
    <aside className="import-options" aria-label="Import options">
      <div className="field">
        <span>File</span>
        <div className="file-row">
          <input className="input mono" aria-label="File" readOnly value={path} placeholder="Choose a file" />
          <button type="button" className="button" onClick={onBrowse} disabled={busy}>
            Browse...
          </button>
        </div>
        {summary && <p className="field-help import-hint">{fileHint(summary)}</p>}
      </div>
      {format && (
        <div className="field">
          <span>Format</span>
          <Select label="Format" value={format} options={FORMATS} onChange={onFormat} />
        </div>
      )}
      {data && format === "csv" && (
        <div className="field">
          <span>Delimiter</span>
          <Select
            label="Delimiter"
            value={options.delimiter ?? summary?.delimiter ?? "comma"}
            options={DELIMITERS}
            onChange={(delimiter) => set({ delimiter })}
          />
          {summary && <p className="field-help">Encoding {summary.encoding}</p>}
        </div>
      )}
      {data && format === "xlsx" && summary && summary.sheets.length > 0 && (
        <div className="field">
          <span>Sheet</span>
          <Select
            label="Sheet"
            value={options.sheet ?? summary.sheets[0]}
            options={summary.sheets.map((s) => ({ value: s, label: s }))}
            onChange={(sheet) => set({ sheet })}
          />
        </div>
      )}
      {data && (
        <>
          {format !== "json" && <Switch label="First row has the names" checked={options.header} onChange={(header) => set({ header })} />}
          <div className="field">
            <span>An empty cell means</span>
            <Segmented label="An empty cell means" value={options.emptyAs} options={EMPTY_AS} onChange={(emptyAs) => set({ emptyAs })} />
          </div>
          <div className="field">
            <span>If a row fails</span>
            <Select label="If a row fails" value={options.onError} options={ON_ERROR} onChange={(onError) => set({ onError })} />
          </div>
          <div className="field">
            <span>Commit</span>
            <Select
              label="Commit"
              value={options.commit.kind}
              options={[
                { value: "once", label: "Once, at the end" },
                { value: "every", label: `Every ${COMMIT_EVERY.toLocaleString("en-US")} rows` },
              ]}
              onChange={(kind) => set({ commit: kind === "once" ? { kind: "once" } : { kind: "every", rows: COMMIT_EVERY } })}
            />
          </div>
        </>
      )}
    </aside>
  );
}
