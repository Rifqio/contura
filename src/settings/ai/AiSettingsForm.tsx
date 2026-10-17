import { useCallback, useEffect, useId, useState } from "react";
import { aiSettings, aiTest, errorText, isCommandError, saveAiSettings } from "../../api/client";
import type {
  AiError,
  AiProviderKind,
  AiSettings,
  AiSettingsView,
  ConnectionConfig,
  GroupId,
  KeyChange,
} from "../../api/types";
import Icon from "../../components/Icon";
import AccessTable from "./AccessTable";
import { PROVIDER_ORDER, PROVIDERS, providerDefaults } from "./providers";

interface Props {
  /** The Group whose settings are shown; null when no Group is open. */
  groupId: GroupId | null;
  groupName: string | null;
  connections: ConnectionConfig[];
  onConnectionSaved: (saved: ConnectionConfig) => void;
  onCancel: () => void;
}

type TestState =
  | { s: "idle" }
  | { s: "testing"; host: string }
  | { s: "ok"; text: string }
  | { s: "bad"; title: string; body: string };

const TYPE_A_NAME = "__type";
const DEFAULT_TEMPERATURE = 0.2;

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
      return {
        s: "bad",
        title: "No provider is set up.",
        body: "Choose a provider above, then test again.",
      };
    case "notAvailable":
      return {
        s: "bad",
        title: `Testing ${PROVIDERS[e.provider]?.name ?? name} arrives in a later Contura version. Nothing was sent.`,
        body: "",
      };
    case "badKey":
      return {
        s: "bad",
        title: "The key was rejected (401 Unauthorized).",
        body: `It may be revoked or mistyped. Copy a new key from ${consoleName} and paste it above.`,
      };
    case "rateLimited":
      return {
        s: "bad",
        title: "Rate limited (429).",
        body: "The key works, but the free tier is busy. Try again in a minute.",
      };
    case "network":
      return {
        s: "bad",
        title: `Could not reach ${e.host || hostOf(baseUrl)}.`,
        body: "Check the base URL, and for a local server check that it is running.",
      };
  }
}

export default function AiSettingsForm({ groupId, groupName, connections, onConnectionSaved, onCancel }: Props) {
  const id = useId();
  const f = (field: string) => `${id}-${field}`;

  const [loaded, setLoaded] = useState<AiSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [provider, setProvider] = useState<AiProviderKind | null>(null);
  const [preset, setPreset] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [typingModel, setTypingModel] = useState(false);
  const [tempOn, setTempOn] = useState(false);
  const [temp, setTemp] = useState(DEFAULT_TEMPERATURE);
  const [maxTokens, setMaxTokens] = useState("");
  const [maxError, setMaxError] = useState<string | null>(null);
  const [inlineAsk, setInlineAsk] = useState(true);
  const [errorAsk, setErrorAsk] = useState(true);
  const [override, setOverride] = useState(false);

  // A saved key is never held here: only a key being typed, and what to do with the saved one.
  const [typedKey, setTypedKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyMode, setKeyMode] = useState<"saved" | "replace" | "remove">("saved");

  const [test, setTest] = useState<TestState>({ s: "idle" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = useCallback((v: AiSettingsView) => {
    const s = v.settings;
    const chosenPreset = s.provider === "openai" ? (s.preset ?? "OpenAI") : null;
    setLoaded(v);
    setProvider(s.provider);
    setPreset(chosenPreset);
    setBaseUrl(s.baseUrl);
    setModel(s.model);
    setTypingModel(
      s.provider !== null && s.model !== "" && !providerDefaults(s.provider, chosenPreset).models.includes(s.model),
    );
    setTempOn(s.temperature !== null);
    setTemp(s.temperature ?? DEFAULT_TEMPERATURE);
    setMaxTokens(s.maxTokens === null ? "" : String(s.maxTokens));
    setMaxError(null);
    setInlineAsk(s.inlineAsk);
    setErrorAsk(s.errorAsk);
    setOverride(v.groupOverride);
    setTypedKey("");
    setShowKey(false);
    setKeyMode("saved");
  }, []);

  useEffect(() => {
    let live = true;
    aiSettings(groupId)
      .then((v) => live && apply(v))
      .catch((e) => live && setLoadError(errorText(e)));
    return () => {
      live = false;
    };
  }, [groupId, apply]);

  if (loadError) {
    return (
      <p className="error-text" role="alert">
        {loadError}
      </p>
    );
  }
  if (!loaded) return <p className="muted">Loading AI settings…</p>;

  const info = provider ? PROVIDERS[provider] : null;
  const models = provider ? providerDefaults(provider, preset).models : [];
  // The saved key belongs to the provider it was saved for.
  const keyShown = loaded.keySaved && provider === loaded.settings.provider && keyMode === "saved";

  function pickProvider(next: AiProviderKind) {
    const nextPreset = next === "openai" ? "OpenAI" : null;
    const d = providerDefaults(next, nextPreset);
    setProvider(next);
    setPreset(nextPreset);
    setBaseUrl(d.url);
    setModel(d.models[0] ?? "");
    setTypingModel(false);
    setTypedKey("");
    setTest({ s: "idle" });
  }

  function pickPreset(name: string) {
    const d = providerDefaults("openai", name);
    setPreset(name);
    setBaseUrl(d.url);
    setModel(d.models[0] ?? "");
    setTypingModel(false);
  }

  async function toggleOverride(next: boolean) {
    setOverride(next);
    setStatus(null);
    if (next) return;
    // Saving without an override writes these values as the global ones, so load the global ones first.
    try {
      apply(await aiSettings(null));
    } catch (e) {
      setOverride(true);
      setStatus({ ok: false, text: errorText(e) });
    }
  }

  function keyChange(): KeyChange {
    if (typedKey !== "") return { t: "set", value: typedKey };
    if (loaded?.keySaved && keyMode === "remove" && provider === loaded.settings.provider) return { t: "clear" };
    return { t: "keep" };
  }

  function currentSettings(): AiSettings | null {
    const t = maxTokens.trim();
    if (t !== "" && (!/^\d+$/.test(t) || Number(t) < 1)) {
      setMaxError("Enter a whole number, or leave it empty.");
      return null;
    }
    setMaxError(null);
    return {
      provider,
      preset: provider === "openai" ? preset : null,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      temperature: tempOn ? temp : null,
      maxTokens: t === "" ? null : Number(t),
      inlineAsk,
      errorAsk,
    };
  }

  /** Saves the form, then reloads it from the Core so a typed key is dropped. */
  async function persist(): Promise<boolean> {
    const settings = currentSettings();
    if (!settings) return false;
    await saveAiSettings(groupId, settings, groupId !== null && override, keyChange());
    apply(await aiSettings(groupId));
    return true;
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      if (await persist()) setStatus({ ok: true, text: "Saved." });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    if (!provider || !info) return;
    setBusy(true);
    setStatus(null);
    setTest({ s: "testing", host: hostOf(baseUrl) });
    try {
      if (!(await persist())) {
        setTest({ s: "idle" });
        return;
      }
      const r = await aiTest(groupId);
      setTest({
        s: "ok",
        text: `Connected to ${info.name}. ${r.model} replied in ${r.millis} ms. Only the test prompt was sent.`,
      });
    } catch (err) {
      if (isCommandError(err) && err.kind === "ai") {
        setTest(testFailure(err.message, info.name, info.console, baseUrl));
      } else {
        setTest({ s: "idle" });
        setStatus({ ok: false, text: errorText(err) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="sform" onSubmit={onSave} noValidate aria-label="AI assistant settings">
      <section className="ssec" aria-labelledby={f("provider")}>
        <h2 id={f("provider")}>Provider</h2>
        <p>Contura talks to one provider at a time. Nothing is sent until you ask a question or press Test.</p>
        {groupName !== null && (
          <label className="checkbox">
            <input type="checkbox" checked={override} onChange={(e) => void toggleOverride(e.target.checked)} />
            Use different settings for {groupName}
          </label>
        )}
        <div className="provs" role="radiogroup" aria-label="Provider">
          {PROVIDER_ORDER.map((k) => (
            <label className="prov" key={k}>
              <input
                type="radio"
                name={f("prov")}
                value={k}
                checked={provider === k}
                onChange={() => pickProvider(k)}
              />
              <b>{PROVIDERS[k].name}</b>
              <span>{PROVIDERS[k].sub}</span>
              {PROVIDERS[k].badge && <span className="free">{PROVIDERS[k].badge}</span>}
            </label>
          ))}
        </div>
      </section>

      {provider && info && (
        <section className="ssec" aria-label="Provider details">
          <div className="fgrid">
            {info.presets && (
              <div className="field">
                <label htmlFor={f("preset")}>Preset</label>
                <select
                  id={f("preset")}
                  className="input"
                  value={preset ?? "OpenAI"}
                  onChange={(e) => pickPreset(e.target.value)}
                >
                  {Object.keys(info.presets).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <span className="field-hint">Fills the base URL and the model list.</span>
              </div>
            )}
            <div className={info.presets ? "field" : "field field-wide"}>
              <label htmlFor={f("url")}>Base URL</label>
              <input
                id={f("url")}
                className="input mono"
                value={baseUrl}
                spellCheck={false}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <span className="field-hint">
                {provider === "custom"
                  ? "Ollama uses port 11434, LM Studio uses 1234."
                  : "Filled from the provider. Change it for a proxy."}
              </span>
            </div>

            <div className="field field-wide">
              {keyShown ? (
                <>
                  <span className="fl">API key</span>
                  <div className="keybox">
                    <Icon name="lock" />
                    <span className="mono">••••••••{loaded.keyLast4 ?? ""}</span>
                    <span className="field-hint">
                      Saved in Windows Credential Manager as Contura/AI/
                      {provider}
                    </span>
                    <span className="spacer" />
                    <button type="button" className="button button-small" onClick={() => setKeyMode("replace")}>
                      Replace
                    </button>
                    <button
                      type="button"
                      className="button button-small button-danger-text"
                      onClick={() => setKeyMode("remove")}
                    >
                      Remove
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label htmlFor={f("key")}>API key</label>
                  <div className="inrow">
                    <input
                      id={f("key")}
                      className="input mono"
                      type={showKey ? "text" : "password"}
                      value={typedKey}
                      placeholder={info.keyHint}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setTypedKey(e.target.value)}
                    />
                    <button
                      type="button"
                      className="button"
                      aria-pressed={showKey}
                      onClick={() => setShowKey((s) => !s)}
                    >
                      <Icon name="eye" />
                      {showKey ? "Hide" : "Show"}
                    </button>
                    {loaded.keySaved && provider === loaded.settings.provider && (
                      <button
                        type="button"
                        className="button"
                        onClick={() => {
                          setTypedKey("");
                          setKeyMode("saved");
                        }}
                      >
                        Keep the saved key
                      </button>
                    )}
                  </div>
                  {keyMode === "remove" && <span className="field-hint">The saved key is removed when you save.</span>}
                  <span className="field-hint">
                    <Icon name="lock" /> Stored in Windows Credential Manager, like Connection passwords. It is never
                    written to <span className="mono-small">data\</span>.
                  </span>
                </>
              )}
            </div>

            <div className="field field-wide">
              <label htmlFor={f("model")}>Model</label>
              {typingModel ? (
                <div className="inrow">
                  <input
                    id={f("model")}
                    className="input mono"
                    value={model}
                    placeholder="Type the model name"
                    spellCheck={false}
                    onChange={(e) => setModel(e.target.value)}
                  />
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setTypingModel(false);
                      setModel(models[0] ?? "");
                    }}
                  >
                    Pick from the list
                  </button>
                </div>
              ) : (
                <select
                  id={f("model")}
                  className="input mono"
                  value={model}
                  onChange={(e) => {
                    if (e.target.value === TYPE_A_NAME) {
                      setTypingModel(true);
                      setModel("");
                    } else setModel(e.target.value);
                  }}
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value={TYPE_A_NAME}>Type a name…</option>
                </select>
              )}
            </div>
          </div>

          <details className="adv" open={tempOn || maxTokens !== ""}>
            <summary>Optional: temperature and max tokens</summary>
            <div className="fgrid">
              <div className="field">
                <span className="fl">Temperature</span>
                <label className="checkbox">
                  <input type="checkbox" checked={!tempOn} onChange={(e) => setTempOn(!e.target.checked)} />
                  Use the provider default
                </label>
                <div className="range-row">
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={temp}
                    disabled={!tempOn}
                    aria-label="Temperature"
                    onChange={(e) => setTemp(Number(e.target.value))}
                  />
                  <output>{temp.toFixed(1)}</output>
                </div>
                <span className="field-hint">Lower is steadier. 0.2 suits SQL.</span>
              </div>
              <div className="field">
                <label htmlFor={f("max")}>Max tokens</label>
                <input
                  id={f("max")}
                  className={maxError ? "input mono input-error" : "input mono"}
                  type="number"
                  min={1}
                  step={1}
                  placeholder="Provider default"
                  value={maxTokens}
                  aria-invalid={maxError !== null}
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
                {maxError ? (
                  <span className="field-error">{maxError}</span>
                ) : (
                  <span className="field-hint">Answers stop at this length. 1024 fits most SQL answers.</span>
                )}
              </div>
            </div>
          </details>

          <div className="test-row">
            <button type="button" className="button" disabled={busy} onClick={() => void onTest()}>
              <Icon name="plug" />
              Test
            </button>
            <div role="status" aria-live="polite">
              {test.s === "testing" && (
                <span className="result">
                  <span className="spin" />
                  <span>Sending "Reply with OK" to {test.host}…</span>
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
          </div>
        </section>
      )}

      <section className="ssec" aria-labelledby={f("where")}>
        <h2 id={f("where")}>Where it appears</h2>
        <label className="checkbox">
          <input type="checkbox" checked={inlineAsk} onChange={(e) => setInlineAsk(e.target.checked)} />
          Show Ask when I select SQL, cells, a column or a table card
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={errorAsk} onChange={(e) => setErrorAsk(e.target.checked)} />
          Show Ask AI on failed queries
        </label>
        <span className="field-hint">
          Inline Ask <span className="kbd">Ctrl I</span> · Assistant panel <span className="kbd">Ctrl Alt I</span>
        </span>
      </section>

      <section className="ssec" aria-labelledby={f("access")}>
        <h2 id={f("access")}>What AI can see, per Connection</h2>
        <p>
          Each Connection decides what may leave this PC. Each change is saved at once. The same choice is on each
          Connection's form.
        </p>
        <AccessTable connections={connections} onSaved={onConnectionSaved} />
      </section>

      <div className="sfoot">
        <span className="field-hint">Saving sends nothing.</span>
        {status && (
          <span className={status.ok ? "field-hint" : "field-error"} role="status">
            {status.text}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}
