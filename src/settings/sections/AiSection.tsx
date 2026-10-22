import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  aiClearAll,
  aiKnownModels,
  aiModels,
  aiSettings,
  aiTest,
  clearAiThreads,
  errorText,
  isCommandError,
  saveAiSettings,
} from "../../api/client";
import type {
  AiAccess,
  AiError,
  AiProviderKind,
  AiSettings,
  AiSettingsView,
  ConnectionConfig,
  GroupId,
  KeyChange,
  ModelInfo,
  ModelList,
  ThinkingLevel,
} from "../../api/types";
import { threadsCleared } from "../../assistant/threadsCleared";
import { hintFor } from "../../commands/keymap";
import { useKeymap } from "../../commands/useCommandKeys";
import Dialog from "../../components/Dialog";
import Icon from "../../components/Icon";
import Kbd from "../../components/Kbd";
import Select from "../../components/Select";
import { agoText } from "../../format/units";
import { usePrefs } from "../../prefs/usePrefs";
import AccessTable from "../ai/AccessTable";
import { AI_ACCESS_OPTIONS, formatWindow, PROVIDER_ORDER, PROVIDERS, providerDefaults } from "../ai/providers";
import { Row, type RowKey, Section, SwitchRow, useRowShown } from "./layout";

const ROW = {
  group: { label: "Use different settings for", terms: "Group" },
  provider: { label: "Provider", terms: "OpenAI Anthropic Groq DeepSeek Custom" },
  preset: { label: "Preset", terms: "OpenRouter Together" },
  baseUrl: { label: "Base URL", terms: "proxy endpoint Ollama LM Studio" },
  model: { label: "Model" },
  contextWindow: { label: "Context window", terms: "tokens" },
  key: { label: "API key", terms: "test Credential Manager" },
  caching: { label: "Use prompt caching when the model supports it" },
  thinking: { label: "Default thinking level" },
  shareThinking: { label: "Ask models to share their thinking when they support it" },
  newConnections: { label: "New Connections", terms: "default AI access" },
  inline: { label: "Inline suggestions" },
  inlineAsk: { label: "Inline Ask", terms: "select SQL cells" },
  errorAsk: { label: "Ask on errors", terms: "failed queries" },
  access: { label: "What AI can see, per Connection", terms: "AI access" },
  keepExactText: { label: "Keep the exact text sent with each answer", terms: "Privacy" },
  pickTables: { label: "Let the assistant pick tables in large databases", terms: "Privacy pick tables outline tools" },
  tools: { label: "Tools the assistant can use", terms: "pick tables outline tools Run SQL read rows" },
  clearAi: { label: "Clear AI history", terms: "Privacy Clear all AI data threads AI Context" },
} satisfies Record<string, RowKey>;
export const AI_ROWS: readonly RowKey[] = Object.values(ROW);

const NONE = "none";
const THINKING_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
const TYPE_A_NAME = "__type";

type TestState = { s: "idle" } | { s: "testing"; host: string } | { s: "ok"; text: string } | { s: "bad"; title: string; body: string };

/** The model list's age: "Fetched just now", "Fetched 2m ago". */
export function fetchedText(atMs: number, nowMs: number): string {
  const ago = agoText(nowMs - atMs);
  return ago === "now" ? "Fetched just now" : `Fetched ${ago}`;
}

/** Models fetched from the provider, for the Group, provider, base URL and key in `key`. */
type Fetched = { key: string; ok: true; list: ModelList } | { key: string; ok: false; reason?: string };

/** "32,768"; empty when unset. */
const windowText = (tokens: number | null | undefined) => (tokens ? tokens.toLocaleString("en-US") : "");

/** Why a model fetch was refused before anything was sent, when the user has to act on it. */
function refusedText(e: unknown): string | undefined {
  const ai = (e as { kind?: unknown; message?: { kind?: unknown } } | null) ?? null;
  return ai?.kind === "ai" && ai.message?.kind === "keyHostChanged" ? errorText(e) : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function testFailure(e: AiError, consoleName: string, baseUrl: string): TestState {
  switch (e.kind) {
    case "notConfigured":
      return { s: "bad", title: "No provider is set up.", body: "Choose a provider above, then test again." };
    case "badKey":
      return {
        s: "bad",
        title: "The key was rejected (401 Unauthorized).",
        body: `It may be revoked or mistyped. Copy a new key from ${consoleName} and paste it above.`,
      };
    case "rateLimited":
      return { s: "bad", title: "Rate limited (429).", body: "The key works, but the free tier is busy. Try again in a minute." };
    case "network":
      return {
        s: "bad",
        title: `Could not reach ${e.host || hostOf(baseUrl)}.`,
        body: "Check the base URL, and for a local server check that it is running.",
      };
    default:
      return { s: "bad", title: errorText({ kind: "ai", message: e }), body: "" };
  }
}

interface Props {
  /** The open Group, whose settings may differ from the global ones; null when none is open. */
  groupId: GroupId | null;
  groupName: string | null;
  connections: ConnectionConfig[];
  onConnectionSaved: (saved: ConnectionConfig) => void;
}

/** The current model's facts as chips (board 11.4). */
function ModelFacts({ info, fetchedAt, now }: { info: ModelInfo | null; fetchedAt: number | null; now: number }) {
  if (!info && fetchedAt === null) return null;
  return (
    <span className="mfacts">
      {info && (
        <span className="mfact acc">
          <Icon name="layers" size={14} />
          <b>{formatWindow(info.contextWindow)}</b> token context window
        </span>
      )}
      {info?.sharesThinking && (
        <span className="mfact">
          <Icon name="check" size={14} />
          Shares its thinking
        </span>
      )}
      {info && info.caching !== "none" && (
        <span className="mfact">
          <Icon name="check" size={14} />
          Prompt caching
        </span>
      )}
      {fetchedAt !== null && (
        <span className="mfact">
          <Icon name="history" size={14} />
          {fetchedText(fetchedAt, now)}
        </span>
      )}
    </span>
  );
}

interface PrivacyProps {
  /** The Keep the exact text switch; null leaves it out (a Group's own settings). */
  keepExactText: { checked: boolean; onChange: (keepExactText: boolean) => void } | null;
  /** The Pick tables switch; null leaves it out with the other global switches. */
  pickTables: { checked: boolean; onChange: (pickTables: boolean) => void } | null;
  groupId: GroupId | null;
  groupName: string | null;
}

/** Keep the exact text, then the clear actions; those are not settings, so a Group's own settings keep them. */
function PrivacyBlock({ keepExactText, pickTables, groupId, groupName }: PrivacyProps) {
  const switchShown = useRowShown(ROW.keepExactText);
  const pickShown = useRowShown(ROW.pickTables);
  const clearShown = useRowShown(ROW.clearAi);
  const [asking, setAsking] = useState<"history" | "all" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  if (!(keepExactText && switchShown) && !(pickTables && pickShown) && !clearShown) return null;
  // The history is kept per place: the Group this window shows, or Ungrouped.
  const place = groupId === null ? "ungrouped" : `group:${groupId}`;
  const placeName = groupName ?? (groupId === null ? "Ungrouped" : "this Group");

  async function clear(what: "history" | "all") {
    setAsking(null);
    setResult(null);
    try {
      if (what === "history") await clearAiThreads(place);
      else await aiClearAll();
      // An open Assistant panel drops the threads at once.
      threadsCleared(what === "history" ? place : null);
      setResult({ ok: true, text: what === "history" ? `Cleared the AI history of ${placeName}.` : "Cleared all AI data." });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    }
  }

  return (
    <div className="ssub">
      <h3>Privacy</h3>
      {keepExactText && (
        <SwitchRow
          {...ROW.keepExactText}
          checked={keepExactText.checked}
          onChange={keepExactText.onChange}
          hint={String.raw`The text can contain your schema and SQL. data\ is portable and not encrypted.`}
        />
      )}
      {pickTables && (
        <SwitchRow
          {...ROW.pickTables}
          checked={pickTables.checked}
          onChange={pickTables.onChange}
          hint="Sends an outline of table names, one extra step per Ask."
        />
      )}
      {clearShown && (
        <div className="privacy-actions srow-wide">
          <button type="button" className="button" onClick={() => setAsking("history")}>
            Clear AI history...
          </button>
          <button type="button" className="button button-danger-text" onClick={() => setAsking("all")}>
            Clear all AI data...
          </button>
          {result && (
            <span className={result.ok ? "muted" : "field-error"} role={result.ok ? "status" : "alert"}>
              {result.text}
            </span>
          )}
        </div>
      )}
      {asking && (
        <Dialog title={asking === "history" ? "Clear AI history" : "Clear all AI data"} size="confirm" onClose={() => setAsking(null)}>
          <div className="dialog-body">
            <p>
              {asking === "history"
                ? `Clear the AI history of ${placeName}? Every thread in this place is removed.`
                : "Clear all AI data? Every thread and every AI Context is removed. Connections and settings stay."}
            </p>
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" data-autofocus onClick={() => setAsking(null)}>
              Cancel
              <Kbd keys="Esc" />
            </button>
            <button type="button" className="button button-danger-fill" onClick={() => void clear(asking)}>
              Clear
            </button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}

/** What the assistant may ask Contura to do (board 11.4): Pick tables is a step, Run SQL is never offered. */
function ToolsBlock() {
  const id = useId();
  if (!useRowShown(ROW.tools)) return null;
  return (
    <div className="ssub">
      <h3 id={id}>{ROW.tools.label}</h3>
      <p className="muted">
        A tool is an action a model may ask Contura to take. Contura checks and runs it, never the model, and every use shows here and in Show log.
      </p>
      <table className="tools-table" aria-labelledby={id}>
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col">What it can do</th>
            <th scope="col">Where</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <span className="tool-name">Pick tables</span>
              <span className="tool-sub">a step, not a tool</span>
            </td>
            <td>The model names the tables it needs from an outline of table names. Contura sends only those.</td>
            <td>Ask, large databases</td>
            <td>Follows the privacy switch</td>
          </tr>
          <tr className="off">
            <td>
              <span className="tool-name">Run SQL or read rows</span>
              <span className="tool-sub">not available</span>
            </td>
            <td>No model can run anything on a database. Answers are text: only Run in the editor touches a database.</td>
            <td>Nowhere</td>
            <td>
              <span className="tool-never">
                <Icon name="lock" size={14} />
                Never
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function AccessBlock({ connections, onConnectionSaved }: Pick<Props, "connections" | "onConnectionSaved">) {
  const id = useId();
  if (!useRowShown(ROW.access)) return null;
  return (
    <div className="ssub">
      <h3 id={id}>{ROW.access.label}</h3>
      <p className="muted">Each Connection decides what may leave this PC. The same choice is on each Connection's form.</p>
      <AccessTable connections={connections} onSaved={onConnectionSaved} labelledBy={id} />
    </div>
  );
}

/**
 * Settings, AI assistant (D7, ST4). Each change is saved at once; the API key alone waits for
 * its own Save (D6), so a half-typed key is never used, and survives a Group change (R23).
 */
export default function AiSection({ groupId, groupName, connections, onConnectionSaved }: Props) {
  const { prefs, update } = usePrefs();
  const { map } = useKeymap();
  const askKey = hintFor(map, "editor.ask");

  const [view, setView] = useState<AiSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [override, setOverride] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [typingModel, setTypingModel] = useState(false);
  const [modelText, setModelText] = useState("");
  // A saved key never comes back here: only a key being typed.
  const [typedKey, setTypedKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestState>({ s: "idle" });
  const [status, setStatus] = useState<string | null>(null);
  const [askingRemove, setAskingRemove] = useState(false);
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [fetchAgain, setFetchAgain] = useState(0);
  // Bumped by each key save, so the list is fetched again with the new key.
  const [keySaves, setKeySaves] = useState(0);
  const [known, setKnown] = useState<{ key: string; list: ModelList } | null>(null);
  const [windowValue, setWindowValue] = useState("");
  const [now, setNow] = useState(() => Date.now());

  /** Saves run one after another, in the order they were made. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const loads = useRef(0);
  // The Group whose settings are on screen, and the Group open now: a save belongs to the Group it
  // was made for, so a change made while another Group's settings load never writes into it.
  const loadedFor = useRef<GroupId | null | undefined>(undefined);
  const groupNow = useRef(groupId);
  groupNow.current = groupId;

  const apply = useCallback((v: AiSettingsView) => {
    const s = v.settings;
    setView(v);
    setSettings(s);
    setOverride(v.groupOverride);
    setBaseUrl(s.baseUrl);
    setModelText(s.model);
    setWindowValue(windowText(s.contextWindow));
    setTypingModel(s.provider !== null && s.model !== "" && !providerDefaults(s.provider, s.preset).models.includes(s.model));
  }, []);

  useEffect(() => {
    const seq = ++loads.current;
    setLoadError(null);
    // A test result belongs to the Group it ran for; so do the settings shown, until the new ones load.
    setTest({ s: "idle" });
    loadedFor.current = undefined;
    setView(null);
    setSettings(null);
    aiSettings(groupId)
      .then((v) => {
        if (seq !== loads.current) return;
        loadedFor.current = groupId;
        apply(v);
      })
      .catch((e) => seq === loads.current && setLoadError(errorText(e)));
  }, [groupId, apply]);

  // With a saved key the provider's own list replaces the built-in one; it is fetched again when
  // the Group, provider, preset, base URL or key changes, after the saves on their way.
  const fetchKey =
    settings?.provider && view?.keySaved ? [groupId, settings.provider, settings.preset, settings.baseUrl, keySaves].join("\n") : null;
  useEffect(() => {
    if (fetchKey === null) return;
    let live = true;
    void queue.current
      .then(() => aiModels(groupId))
      .then(
        (list) => {
          if (!live) return;
          if (list.models.length === 0) setFetched({ key: fetchKey, ok: false });
          else {
            setFetched({ key: fetchKey, ok: true, list });
            setNow(Date.now());
          }
        },
        (e) => live && setFetched({ key: fetchKey, ok: false, reason: refusedText(e) }),
      );
    return () => {
      live = false;
    };
  }, [fetchKey, groupId, fetchAgain]);

  // What each model accepts, known without the network; read again when the model or its saved
  // window changes, so a typed name gets its record too, and after each fetch, which it includes.
  const knownKey = settings?.provider ? [groupId, settings.provider, settings.preset, settings.baseUrl].join("\n") : null;
  const knownModel = settings?.model;
  const knownWindow = settings?.contextWindow;
  useEffect(() => {
    if (knownKey === null) return;
    let live = true;
    void queue.current
      .then(() => aiKnownModels(groupId))
      .then(
        (list) => live && setKnown({ key: knownKey, list }),
        () => live && setKnown(null),
      );
    return () => {
      live = false;
    };
  }, [knownKey, knownModel, knownWindow, fetched, groupId]);

  const fetchedNow = fetched && fetched.key === fetchKey ? fetched : null;
  const fetchedList = fetchedNow?.ok ? fetchedNow.list : null;
  const fetchedModels = useMemo(() => (fetchedList ? fetchedList.models.map((m) => m.id) : null), [fetchedList]);
  const knownList = known && known.key === knownKey ? known.list : null;
  // A failed fetch says so in the hint; an older listing's age would contradict it.
  const fetchedAt = fetchedList ? fetchedList.fetchedAt : fetchedNow ? null : (knownList?.fetchedAt ?? null);
  useEffect(() => {
    if (fetchedAt === null) return;
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, [fetchedAt]);

  // A model typed earlier that the provider lists goes back to the list.
  useEffect(() => {
    if (fetchedModels && settings && modelText === settings.model && fetchedModels.includes(settings.model)) setTypingModel(false);
  }, [fetchedModels, settings, modelText]);

  function run(job: () => Promise<void>): Promise<void> {
    setStatus(null);
    const next = queue.current.then(job);
    queue.current = next.catch(() => {});
    return next.catch((e) => setStatus(errorText(e)));
  }

  /** The saved key's state belongs to the provider, so it is read again after the provider or key changes. */
  async function refreshKey() {
    const v = await aiSettings(groupId);
    if (groupNow.current !== groupId) return;
    setView((old) => (old ? { ...old, keySaved: v.keySaved, keyLast4: v.keyLast4 } : v));
  }

  function save(next: AiSettings, opts: { override?: boolean; key?: KeyChange; refresh?: boolean } = {}) {
    if (loadedFor.current !== groupId) return Promise.resolve();
    setSettings(next);
    const ov = groupId !== null && (opts.override ?? override);
    return run(async () => {
      await saveAiSettings(groupId, next, ov, opts.key ?? { t: "keep" });
      if (opts.refresh) await refreshKey();
    });
  }

  if (loadError) {
    return (
      <Section id="ai" title="AI assistant" rows={AI_ROWS}>
        <p className="error-text" role="alert">
          {loadError}
        </p>
      </Section>
    );
  }
  if (!view || !settings) {
    return (
      <Section id="ai" title="AI assistant" rows={AI_ROWS}>
        <p className="muted">Loading AI settings...</p>
      </Section>
    );
  }

  const s = settings;
  const info = s.provider ? PROVIDERS[s.provider] : null;
  const models = fetchedModels ?? (s.provider ? providerDefaults(s.provider, s.preset).models : []);
  const modelOptions = s.model !== "" && !models.includes(s.model) ? [s.model, ...models] : models;
  // The known record is read after every change that shapes it, so it leads.
  const modelInfo = knownList?.models.find((m) => m.id === s.model) ?? fetchedList?.models.find((m) => m.id === s.model) ?? null;
  const fetchFailure = fetchedNow && !fetchedNow.ok ? (fetchedNow.reason ?? "Could not fetch the model list. Showing the built-in one.") : null;
  const modelsHint =
    fetchFailure || modelInfo || fetchedAt !== null ? (
      <>
        {fetchFailure && <span className="srow-note-line">{fetchFailure}</span>}
        <ModelFacts info={modelInfo} fetchedAt={fetchedAt} now={now} />
      </>
    ) : undefined;
  // Custom servers, and models nothing is known about, say their own window.
  const askWindow = s.provider === "custom" || modelInfo?.known === false;
  // Read again whenever the provider changes, so it is the current provider's key.
  const keySaved = view.keySaved;
  // A Group's own settings: the global-only rows are left out.
  const groupOwn = groupId !== null && override;
  const typing = typedKey !== "";

  function pickProvider(v: AiProviderKind | typeof NONE) {
    setTest({ s: "idle" });
    setTypingModel(false);
    if (v === NONE) {
      void save({ ...s, provider: null, preset: null }, { refresh: true });
      return;
    }
    const preset = v === "openai" ? "OpenAI" : null;
    const d = providerDefaults(v, preset);
    setBaseUrl(d.url);
    setModelText(d.models[0] ?? "");
    void save({ ...s, provider: v, preset, baseUrl: d.url, model: d.models[0] ?? "" }, { refresh: true });
  }

  function pickPreset(name: string) {
    const d = providerDefaults("openai", name);
    setBaseUrl(d.url);
    setModelText(d.models[0] ?? "");
    setTypingModel(false);
    setTest({ s: "idle" });
    // Each preset has its own key (OpenRouter's is AI/openrouter), so its state is read again.
    void save({ ...s, preset: name, baseUrl: d.url, model: d.models[0] ?? "" }, { refresh: true });
  }

  function commitBaseUrl() {
    const url = baseUrl.trim();
    if (url !== s.baseUrl) void save({ ...s, baseUrl: url });
  }

  function commitWindow() {
    const digits = windowValue.replace(/\D/g, "");
    const tokens = digits === "" || Number(digits) === 0 ? null : Number(digits);
    setWindowValue(windowText(tokens));
    if (tokens !== (s.contextWindow ?? null)) void save({ ...s, contextWindow: tokens });
  }

  function commitModel() {
    const m = modelText.trim();
    if (m !== s.model) void save({ ...s, model: m });
  }

  async function toggleOverride(next: boolean) {
    setOverride(next);
    if (next) {
      void save(s, { override: true });
      return;
    }
    // Off: the global settings come back and are written as they are, so the Group's never reach them.
    try {
      const global = await aiSettings(null);
      if (groupNow.current !== groupId) return;
      apply({ ...global, groupOverride: false });
      void save(global.settings, { override: false, refresh: true });
    } catch (e) {
      setOverride(true);
      setStatus(errorText(e));
    }
  }

  function saveKey() {
    // A pasted key often brings a trailing space or newline.
    const value = typedKey.trim();
    if (loadedFor.current !== groupId) return;
    void run(async () => {
      await saveAiSettings(groupId, s, groupId !== null && override, { t: "set", value });
      await refreshKey();
      setTypedKey((k) => (k.trim() === value ? "" : k));
      setShowKey(false);
      setKeySaves((n) => n + 1);
    });
  }

  function removeKey() {
    setAskingRemove(false);
    if (loadedFor.current !== groupId) return;
    void run(async () => {
      await saveAiSettings(groupId, s, groupId !== null && override, { t: "clear" });
      await refreshKey();
    });
  }

  async function onTest() {
    if (!info) return;
    setTest({ s: "testing", host: hostOf(s.baseUrl) });
    try {
      // Settings are already saved; wait for any save still on its way.
      await queue.current;
      const r = await aiTest(groupId);
      setTest({ s: "ok", text: `Connected to ${info.name}. ${r.model} replied in ${r.millis}ms. Only the test prompt was sent.` });
    } catch (err) {
      if (isCommandError(err) && err.kind === "ai") setTest(testFailure(err.message, info.console, s.baseUrl));
      else {
        setTest({ s: "idle" });
        setStatus(errorText(err));
      }
    }
  }

  const providerOptions = [
    { value: NONE as AiProviderKind | typeof NONE, label: "None" },
    ...PROVIDER_ORDER.map((k) => ({ value: k as AiProviderKind | typeof NONE, label: PROVIDERS[k].name, hint: PROVIDERS[k].badge })),
  ];

  return (
    <Section id="ai" title="AI assistant" rows={AI_ROWS}>
      {groupName !== null && (
        <SwitchRow
          {...ROW.group}
          shownLabel={`Use different settings for ${groupName}`}
          checked={override}
          onChange={(v) => void toggleOverride(v)}
          hint={override ? `Changes here apply to ${groupName} only.` : "Changes here apply to every Group without its own settings."}
        />
      )}
      <Row {...ROW.provider}>
        <Select label="Provider" value={s.provider ?? NONE} options={providerOptions} onChange={pickProvider} className="srow-grow" />
      </Row>
      {info?.presets && (
        <Row {...ROW.preset}>
          <Select
            label="Preset"
            value={s.preset ?? "OpenAI"}
            options={Object.keys(info.presets).map((n) => ({ value: n, label: n }))}
            onChange={pickPreset}
            className="srow-grow"
          />
        </Row>
      )}
      {info && (
        <Row
          {...ROW.baseUrl}
          hint={s.provider === "custom" ? "Ollama uses port 11434, LM Studio uses 1234." : "Filled from the provider. Change it for a proxy."}
        >
          {({ hintId }) => (
            <input
              className="input mono srow-grow"
              aria-label="Base URL"
              aria-describedby={hintId}
              value={baseUrl}
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={commitBaseUrl}
              onKeyDown={(e) => e.key === "Enter" && commitBaseUrl()}
            />
          )}
        </Row>
      )}
      <Row {...ROW.model} hint={modelsHint}>
        {typingModel ? (
          <>
            <input
              className="input mono srow-grow"
              aria-label="Model"
              value={modelText}
              placeholder="Type the model name"
              spellCheck={false}
              onChange={(e) => setModelText(e.target.value)}
              onBlur={commitModel}
              onKeyDown={(e) => e.key === "Enter" && commitModel()}
            />
            <button
              type="button"
              className="button"
              onClick={() => {
                setTypingModel(false);
                setModelText(models[0] ?? "");
                void save({ ...s, model: models[0] ?? "" });
              }}
            >
              Pick from the list
            </button>
          </>
        ) : (
          <Select
            label="Model"
            mono
            disabled={!s.provider}
            value={s.model}
            options={[...modelOptions.map((m) => ({ value: m, label: m })), { value: TYPE_A_NAME, label: "Type a name..." }]}
            onChange={(m) => {
              if (m === TYPE_A_NAME) {
                setTypingModel(true);
                setModelText("");
              } else void save({ ...s, model: m });
            }}
            className="srow-grow"
          />
        )}
        {fetchKey !== null && (
          <button
            type="button"
            className="icon-button"
            aria-label="Fetch the model list again"
            title="Fetch the model list again"
            onClick={() => setFetchAgain((n) => n + 1)}
          >
            <Icon name="refresh" size={14} />
          </button>
        )}
      </Row>
      {askWindow && (
        <Row {...ROW.contextWindow} hint="Tokens the model accepts. Left empty, Contura uses 8,000.">
          {({ hintId }) => (
            <input
              className="input mono window-input"
              aria-label="Context window"
              aria-describedby={hintId}
              inputMode="numeric"
              placeholder="8,000"
              value={windowValue}
              spellCheck={false}
              onChange={(e) => setWindowValue(e.target.value)}
              onBlur={commitWindow}
              // Enter leaves the field, and leaving it commits once.
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          )}
        </Row>
      )}
      <Row {...ROW.key} hint="Kept in Windows Credential Manager, never in the data folder.">
        {({ hintId }) => (
          <>
            <span className="keyfield srow-grow">
              {keySaved && !typing && <span className="keyfield-saved mono">••••••••{view.keyLast4 ?? ""}</span>}
              <input
                className="mono"
                aria-label="API key"
                aria-describedby={hintId}
                type={showKey ? "text" : "password"}
                value={typedKey}
                placeholder={keySaved ? "" : (info?.keyHint ?? "")}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTypedKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && typedKey.trim() !== "" && saveKey()}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={showKey ? "Hide the API key" : "Show the API key"}
                aria-pressed={showKey}
                onClick={() => setShowKey((v) => !v)}
              >
                <Icon name="eye" size={14} />
              </button>
              {keySaved && !typing && (
                <button type="button" className="icon-button" aria-label="Remove the saved API key" title="Remove the saved API key" onClick={() => setAskingRemove(true)}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </span>
            <button type="button" className="button button-primary" disabled={typedKey.trim() === ""} onClick={saveKey}>
              Save
            </button>
            <button
              type="button"
              className="button"
              disabled={!info || typing || test.s === "testing"}
              title={typing ? "Save the key first" : undefined}
              onClick={() => void onTest()}
            >
              Test
            </button>
          </>
        )}
      </Row>
      {test.s !== "idle" && (
        <div role="status" aria-live="polite" className="srow-wide">
          {test.s === "testing" && (
            <span className="result">
              <span className="spin" />
              <span>Sending "Reply with OK" to {test.host}...</span>
            </span>
          )}
          {test.s === "ok" && (
            <span className="result ok">
              <Icon name="check" />
              <span>{test.text}</span>
            </span>
          )}
          {test.s === "bad" && (
            <span className="result bad">
              <Icon name="error" />
              <span>
                <b>{test.title}</b> {test.body}
              </span>
            </span>
          )}
        </div>
      )}
      <SwitchRow
        {...ROW.caching}
        checked={s.promptCaching}
        onChange={(promptCaching) => void save({ ...s, promptCaching })}
        hint="The default for new models. You can change it per model in the model menu of the Ask panel."
      />
      <Row {...ROW.thinking} hint="Each model remembers the level you last picked for it.">
        {({ hintId }) => (
          <Select<ThinkingLevel>
            label="Default thinking level"
            describedBy={hintId}
            value={s.defaultThinking}
            options={THINKING_OPTIONS}
            onChange={(defaultThinking) => void save({ ...s, defaultThinking })}
          />
        )}
      </Row>
      {/* Share thinking and Keep the exact text are global: a Group's own settings leave them out. */}
      {!groupOwn && (
        <SwitchRow
          {...ROW.shareThinking}
          checked={s.shareThinking}
          onChange={(shareThinking) => void save({ ...s, shareThinking })}
          hint="Shown in Show log as the provider returned it. Never sent back."
        />
      )}
      <Row {...ROW.newConnections} hint="Default AI access. Production Connections always start at Never send anything.">
        {({ hintId }) => (
          <Select<AiAccess>
            label="New Connections"
            describedBy={hintId}
            value={s.newConnectionAccess}
            options={AI_ACCESS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(newConnectionAccess) => void save({ ...s, newConnectionAccess })}
            className="srow-grow"
          />
        )}
      </Row>
      <SwitchRow
        {...ROW.inline}
        checked={prefs.inlineSuggestions}
        onChange={(inlineSuggestions) => update({ inlineSuggestions })}
        hint="Suggests the rest of a statement where you are typing. Uses the Connection's AI access. Arrives with step 11."
      />
      <SwitchRow
        {...ROW.inlineAsk}
        checked={s.inlineAsk}
        onChange={(inlineAsk) => void save({ ...s, inlineAsk })}
        hint={
          <>
            Shows Ask when you select SQL, cells, a column or a table card{askKey ? ". " : "."}
            {askKey && <Kbd keys={askKey} />}
          </>
        }
      />
      <SwitchRow {...ROW.errorAsk} checked={s.errorAsk} onChange={(errorAsk) => void save({ ...s, errorAsk })} hint="Shows Ask AI on failed queries." />
      {status && (
        <p className="field-error srow-wide" role="alert">
          {status}
        </p>
      )}
      {groupOwn && (
        <p className="muted srow-wide">Privacy and thinking settings are the same for every Group. Change them without a Group open.</p>
      )}
      <ToolsBlock />
      <PrivacyBlock
        keepExactText={groupOwn ? null : { checked: s.keepExactText, onChange: (keepExactText) => void save({ ...s, keepExactText }) }}
        pickTables={groupOwn ? null : { checked: s.pickTables ?? true, onChange: (pickTables) => void save({ ...s, pickTables }) }}
        groupId={groupId}
        groupName={groupName}
      />

      <AccessBlock connections={connections} onConnectionSaved={onConnectionSaved} />
      {askingRemove && (
        <Dialog title="Remove the API key?" size="confirm" onClose={() => setAskingRemove(false)}>
          <div className="dialog-body">
            <p>Contura forgets the key for {info?.name ?? "this provider"}. You can paste it again later.</p>
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" data-autofocus onClick={() => setAskingRemove(false)}>
              Cancel
              <Kbd keys="Esc" />
            </button>
            <button type="button" className="button button-danger-fill" onClick={removeKey}>
              Remove
            </button>
          </footer>
        </Dialog>
      )}
    </Section>
  );
}
