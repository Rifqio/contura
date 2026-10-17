import { useCallback, useEffect, useId, useRef, useState } from "react";
import { aiSettings, aiTest, errorText, isCommandError, saveAiSettings } from "../../api/client";
import type { AiAccess, AiError, AiProviderKind, AiSettings, AiSettingsView, ConnectionConfig, GroupId, KeyChange } from "../../api/types";
import { hintFor } from "../../commands/keymap";
import { useKeymap } from "../../commands/useCommandKeys";
import Dialog from "../../components/Dialog";
import Icon from "../../components/Icon";
import Kbd from "../../components/Kbd";
import Select from "../../components/Select";
import { usePrefs } from "../../prefs/usePrefs";
import AccessTable from "../ai/AccessTable";
import { AI_ACCESS_OPTIONS, PROVIDER_ORDER, PROVIDERS, providerDefaults } from "../ai/providers";
import { Row, type RowKey, Section, SwitchRow, useRowShown } from "./layout";

const ROW = {
  group: { label: "Use different settings for", terms: "Group" },
  provider: { label: "Provider", terms: "OpenAI Anthropic Groq DeepSeek Custom" },
  preset: { label: "Preset", terms: "OpenRouter Together" },
  baseUrl: { label: "Base URL", terms: "proxy endpoint Ollama LM Studio" },
  model: { label: "Model" },
  key: { label: "API key", terms: "test Credential Manager" },
  newConnections: { label: "New Connections", terms: "default AI access" },
  inline: { label: "Inline suggestions" },
  inlineAsk: { label: "Inline Ask", terms: "select SQL cells" },
  errorAsk: { label: "Ask on errors", terms: "failed queries" },
  access: { label: "What AI can see, per Connection", terms: "AI access" },
} satisfies Record<string, RowKey>;
export const AI_ROWS: readonly RowKey[] = Object.values(ROW);

const NONE = "none";
const TYPE_A_NAME = "__type";

type TestState = { s: "idle" } | { s: "testing"; host: string } | { s: "ok"; text: string } | { s: "bad"; title: string; body: string };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function testFailure(e: AiError, name: string, consoleName: string, baseUrl: string): TestState {
  switch (e.kind) {
    case "notConfigured":
      return { s: "bad", title: "No provider is set up.", body: "Choose a provider above, then test again." };
    case "notAvailable":
      return { s: "bad", title: `Testing ${PROVIDERS[e.provider]?.name ?? name} arrives in a later Contura version. Nothing was sent.`, body: "" };
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
  }
}

interface Props {
  /** The open Group, whose settings may differ from the global ones; null when none is open. */
  groupId: GroupId | null;
  groupName: string | null;
  connections: ConnectionConfig[];
  onConnectionSaved: (saved: ConnectionConfig) => void;
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
  const models = s.provider ? providerDefaults(s.provider, s.preset).models : [];
  // Read again whenever the provider changes, so it is the current provider's key.
  const keySaved = view.keySaved;
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
    void save({ ...s, preset: name, baseUrl: d.url, model: d.models[0] ?? "" });
  }

  function commitBaseUrl() {
    const url = baseUrl.trim();
    if (url !== s.baseUrl) void save({ ...s, baseUrl: url });
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
      if (isCommandError(err) && err.kind === "ai") setTest(testFailure(err.message, info.name, info.console, s.baseUrl));
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
      <Row {...ROW.model}>
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
            options={[...models.map((m) => ({ value: m, label: m })), { value: TYPE_A_NAME, label: "Type a name..." }]}
            onChange={(m) => {
              if (m === TYPE_A_NAME) {
                setTypingModel(true);
                setModelText("");
              } else void save({ ...s, model: m });
            }}
            className="srow-grow"
          />
        )}
      </Row>
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
