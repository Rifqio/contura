import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { aiSettings, aiTest, errorText, saveAiSettings } from "../api/client";
import type { AiProviderKind, AiSettings, AiSettingsView, DialectKind, KeyChange, ThemeChoice } from "../api/types";
import type { InstallKind } from "../api/updates";
import { useSecretStoreKind } from "../app/useSecretStoreKind";
import { hintFor } from "../commands/keymap";
import type { CommandId } from "../commands/registry";
import { useKeymap } from "../commands/useCommandKeys";
import Kbd from "../components/Kbd";
import { providerDefaults } from "../settings/ai/providers";
import { saveChecks, updateState, useUpdates } from "../update/updateStore";
import { Glyph, type GlyphName } from "./Glyph";

/** Board "First start guide" (approved 2026-10-23): Welcome, four steps, then Done. */
const LAST = 5;

export type GuideDb = DialectKind | "later";
export type GuideAi = "none" | "anthropic" | "openai" | "groq" | "deepseek" | "local";

/** How the guide closed: `dialect` is the Connection form to open next, if any. */
export interface GuideResult {
  skipped: boolean;
  dialect: DialectKind | null;
  /** A choice that could not be saved, as a sentence. */
  error: string | null;
}

const DBS: { id: DialectKind; name: string; hint: string; glyph: GlyphName }[] = [
  { id: "mysql", name: "MySQL", hint: "MySQL 8.0 and newer", glyph: "db" },
  { id: "postgres", name: "PostgreSQL", hint: "PostgreSQL 13 and newer", glyph: "db" },
  { id: "sqlite", name: "SQLite", hint: "Built in, a .sqlite or .db file", glyph: "file" },
];

const PROVIDERS: { id: GuideAi; name: string; tag: string }[] = [
  { id: "none", name: "Not now", tag: "" },
  { id: "anthropic", name: "Anthropic", tag: "Claude" },
  { id: "openai", name: "OpenAI-compatible", tag: "any /v1 API" },
  { id: "groq", name: "Groq", tag: "" },
  { id: "deepseek", name: "DeepSeek", tag: "" },
  { id: "local", name: "Local model", tag: "Ollama, LM Studio" },
];

/** The six keys on Done, read from the keymap so a rebind shows. */
const KEYS: { id: CommandId; text: string }[] = [
  { id: "connection.new", text: "New Connection" },
  { id: "query.new", text: "New query" },
  { id: "query.run", text: "Run the current statement" },
  { id: "editor.ask", text: "Ask AI in the editor" },
  { id: "home.open", text: "Home" },
  { id: "settings.open", text: "Settings" },
];

/** Said when the guide closes, and where Settings > General offers it again. */
export const GUIDE_AGAIN = "The guide opens again from Settings, General, First start guide, Show it again.";

export const LOCAL_DEFAULT = "http://127.0.0.1:11434";
export const KEYRING_FOUND = "Passwords are kept in the system keyring, never in files.";
export const KEYRING_MISSING =
  "No system keyring answered, so passwords are kept for this session only. Install GNOME Keyring or KeePassXC and restart Contura to keep them.";

/** Step 4's line under the switch, by how this copy was installed. */
export function updateHowText(install: InstallKind | undefined): string {
  if (install === "package") return "Installed with apt: Contura tells you a new version is out, and you install the new .deb yourself.";
  if (install === "appImage") return "A new version replaces this AppImage in one click, and Contura restarts.";
  return "A new version replaces this exe in one click, and Contura restarts. Your data folder stays.";
}

/** The local server's address as the OpenAI-compatible base URL: `http://` when no scheme is given, `/v1` when no path is. */
export function localBaseUrl(address: string): string {
  let a = address.trim().replace(/\/+$/, "");
  if (a !== "" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) a = `http://${a}`;
  try {
    const u = new URL(a);
    return u.pathname === "/" || u.pathname === "" ? `${a}/v1` : a;
  } catch {
    return a;
  }
}

/** The AI settings the guide's pick makes, over the stored ones (the same fields Settings > AI sets on a provider pick). */
export function aiSettingsFor(base: AiSettings, ai: GuideAi, address: string): AiSettings {
  if (ai === "none") return base;
  const provider: AiProviderKind = ai === "local" ? "custom" : ai;
  const preset = provider === "openai" ? "OpenAI" : null;
  const d = providerDefaults(provider, preset);
  const baseUrl = ai === "local" ? localBaseUrl(address) : d.url;
  return { ...base, provider, preset, baseUrl, model: d.models[0] ?? "" };
}

/** The guide's name for a stored provider, for Done when the pick is Not now. */
function providerName(kind: AiProviderKind | null): string | null {
  if (kind === null) return null;
  const id: GuideAi = kind === "custom" ? "local" : kind;
  return PROVIDERS.find((p) => p.id === id)?.name ?? null;
}

type Check = { s: "idle" } | { s: "checking" } | { s: "ok"; text: string } | { s: "bad"; text: string };

/** What a Check saved, so the end can put it back: the settings, and whether a key went with them. */
type Checked = { settings: AiSettings; keySet: boolean };

interface Props {
  /** The theme choice and the status bar's switch: a pick applies at once. */
  theme: ThemeChoice;
  /** The theme on screen, which tells what Follow the system shows now. */
  effective: "light" | "dark";
  onTheme(c: ThemeChoice): void;
  onClose(result: GuideResult): void;
}

/**
 * The first start guide: a fixed 640 by 560 dialog over the app. Skip and Esc keep every default;
 * the theme applies as it is picked; the AI choice and the update switch are saved when the guide
 * ends (a Check saves the AI choice first, since the test reads the saved settings, and the end puts
 * back what a Check saved when the final pick differs). Ending never waits for the network.
 */
export default function FirstStartGuide({ theme, effective, onTheme, onClose }: Props) {
  const [step, setStep] = useState(0);
  const [db, setDb] = useState<GuideDb>("postgres");
  const [ai, setAi] = useState<GuideAi>("none");
  const [key, setKey] = useState("");
  const [address, setAddress] = useState(LOCAL_DEFAULT);
  const [check, setCheck] = useState<Check>({ s: "idle" });
  const { status } = useUpdates();
  /** Null until the switch is used: it shows the saved setting. */
  const [updatesPick, setUpdatesPick] = useState<boolean | null>(null);
  const updates = updatesPick ?? status?.checks === true;
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const closed = useRef(false);
  /** Ending or leaving the AI step mid-Check would let the Check land after the end put settings back. */
  const checkingNow = check.s === "checking";
  // Read while rendering, so focus goes back to where it was when the guide closes.
  const [previous] = useState(() => document.activeElement as HTMLElement | null);
  /** The AI settings as they were when the guide opened (a local read, nothing is sent). */
  const snapshot = useRef<AiSettingsView | null>(null);
  const checked = useRef(new Map<GuideAi, Checked>());

  const dbRow = DBS.find((d) => d.id === db) ?? null;
  const aiRow = PROVIDERS.find((p) => p.id === ai)!;
  const cloud = ai !== "none" && ai !== "local";

  useEffect(() => {
    let live = true;
    aiSettings(null)
      .then((v) => {
        if (live) snapshot.current = v;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // While open, the window buttons stay above the cover; everything else behind it is out of reach.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("fsg-open");
    return () => {
      root.classList.remove("fsg-open");
      if (previous?.isConnected) previous.focus();
    };
  }, [previous]);

  // Each step: the first control of the step, or the main button when the step has none.
  useEffect(() => {
    const first = body.current?.querySelector<HTMLElement>("button, input");
    (first ?? primary.current)?.focus();
  }, [step]);

  async function saveAi(): Promise<Checked> {
    const base = snapshot.current?.settings ?? (await aiSettings(null)).settings;
    const keySet = cloud && key.trim() !== "";
    const change: KeyChange = keySet ? { t: "set", value: key.trim() } : { t: "keep" };
    const settings = aiSettingsFor(base, ai, address);
    await saveAiSettings(null, settings, false, change);
    return { settings, keySet };
  }

  /** Check key / Check: the AI settings' own test, on the saved settings. Only this sends anything. */
  async function runCheck() {
    if (ai === "none") return;
    const pick = ai;
    setCheck({ s: "checking" });
    try {
      checked.current.set(pick, await saveAi());
      const r = await aiTest(null);
      setCheck({ s: "ok", text: `${r.model} replied in ${r.millis.toLocaleString("en-US")}ms. Only the test prompt was sent.` });
    } catch (e) {
      setCheck({ s: "bad", text: errorText(e) });
    }
  }

  /**
   * The AI settings at the end. A key a Check stored for a provider that is not the final pick is cleared
   * (unless that provider was the one set up before, with its key). With Not now, the settings from before
   * the guide go back when a Check changed them; otherwise the final pick is saved.
   */
  async function settleAi(final: GuideAi): Promise<void> {
    const snap = snapshot.current;
    for (const [pick, c] of checked.current) {
      if (pick === final || !c.keySet) continue;
      const hadKey = !!snap?.keySaved && snap.settings.provider === c.settings.provider && snap.settings.preset === c.settings.preset;
      if (!hadKey) await saveAiSettings(null, c.settings, false, { t: "clear" });
    }
    if (final !== "none") {
      await saveAi();
      return;
    }
    if (checked.current.size === 0) return;
    const before = snap?.settings ?? { ...[...checked.current.values()][0].settings, provider: null, preset: null };
    await saveAiSettings(null, before, false, { t: "keep" });
  }

  function close(result: GuideResult) {
    if (closed.current) return;
    closed.current = true;
    onClose(result);
  }

  function skip() {
    // A Check may have saved a provider: Skip puts it back, in the background.
    if (checked.current.size > 0) void settleAi("none").catch(() => {});
    close({ skipped: true, dialect: null, error: null });
  }

  /**
   * The end: saves the update switch when it changed (or was never answered) and the AI choice, then closes;
   * `open` opens the chosen Connection form. A first update check runs in the background, never here.
   */
  async function finish(open: boolean) {
    if (busy) return;
    setBusy(true);
    const errors: string[] = [];
    const stored = updateState().status?.checks ?? null;
    if (stored === null || stored !== updates) {
      const failed = await saveChecks(updates);
      if (failed) errors.push(`The update setting was not saved: ${failed}`);
    }
    try {
      await settleAi(ai);
    } catch (e) {
      errors.push(`The AI setting was not saved: ${errorText(e)}`);
    }
    close({ skipped: false, dialect: open && dbRow ? dbRow.id : null, error: errors.length > 0 ? errors.join(" ") : null });
  }

  // Esc is Skip; on Done, where Skip is gone, it ends the guide without opening a form. Tab stays in the
  // dialog, and focus that lands outside it (a click on the window buttons) comes back.
  const esc = useRef<() => void>(skip);
  esc.current = step === LAST ? () => void finish(false) : skip;
  useEffect(() => {
    const focusables = () =>
      Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        esc.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const all = focusables();
      if (all.length === 0) return;
      const first = all[0];
      const last = all[all.length - 1];
      const inside = panel.current.contains(document.activeElement);
      const atStart = document.activeElement === first || document.activeElement === panel.current;
      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && atStart) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Node | null;
      if (panel.current && t && !panel.current.contains(t)) (focusables()[0] ?? panel.current).focus();
    };
    // Capture: the guide sees Esc and Tab before anything behind it.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus, true);
    };
  }, []);

  const next = () => (step === LAST ? void finish(true) : setStep(step + 1));
  const nextLabel = step === 0 ? "Get started" : step === LAST ? (dbRow ? `Add the ${dbRow.name} Connection` : "Open Contura") : "Next";
  const showProgress = step > 0 && step < LAST;
  const aiShown = ai === "none" ? providerName(snapshot.current?.settings.provider ?? null) : aiRow.name;

  return createPortal(
    <div className="fsg-cover">
      {/* The title bar strip: covered so nothing behind is reachable, but it still drags the window. */}
      <div className="fsg-cover-bar" data-tauri-drag-region />
      <div className="fsg-scrim">
        <div ref={panel} className="fsg" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
          <div className="fsg-progress" aria-hidden="true">
            {showProgress && [1, 2, 3, 4].map((i) => <span key={i} className={i === step ? "fsg-seg on" : i < step ? "fsg-seg done" : "fsg-seg"} />)}
          </div>
          <div className="fsg-body" ref={body}>
            {showProgress && <span className="fsg-eyebrow">{`Step ${step} of 4`}</span>}
            {step === 0 && <Welcome titleId={titleId} />}
            {step === 1 && <Look titleId={titleId} theme={theme} effective={effective} onTheme={onTheme} />}
            {step === 2 && <FirstConnection titleId={titleId} db={db} onDb={setDb} />}
            {step === 3 && (
              <Assistant
                titleId={titleId}
                ai={ai}
                name={aiRow.name}
                onAi={(v) => {
                  setAi(v);
                  // A key typed for one provider is never sent to another.
                  setKey("");
                  setCheck({ s: "idle" });
                }}
                cloud={cloud}
                keyText={key}
                onKey={(v) => {
                  setKey(v);
                  setCheck({ s: "idle" });
                }}
                address={address}
                onAddress={(v) => {
                  setAddress(v);
                  setCheck({ s: "idle" });
                }}
                check={check}
                onCheck={() => void runCheck()}
              />
            )}
            {step === 4 && <Updates titleId={titleId} on={updates} onToggle={() => setUpdatesPick(!updates)} />}
            {step === LAST && <Done titleId={titleId} theme={theme} effective={effective} db={dbRow?.name ?? null} ai={aiShown} updates={updates} />}
          </div>
          <div className="fsg-foot">
            {step < LAST && (
              <button type="button" className="button button-ghost fsg-quiet" disabled={checkingNow} onClick={skip}>
                Skip the guide
              </button>
            )}
            <span className="spacer" />
            {step > 0 && (
              <button type="button" className="button fsg-back" disabled={checkingNow} onClick={() => setStep(step - 1)}>
                <Glyph name="back" size={15} />
                Back
              </button>
            )}
            <button ref={primary} type="button" className="button button-primary" disabled={busy || checkingNow} onClick={next}>
              {nextLabel}
              <Glyph name="arrow" size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Logo() {
  return (
    <svg className="fsg-logo" width="64" height="64" viewBox="0 0 256 256" aria-hidden="true">
      <path className="contura-logo-stack" d="M52 43A60 14 0 0 1 172 43A60 14 0 0 1 52 43Z" />
      <path className="contura-logo-stack" d="M52 53A60 14 0 0 0 172 53V97A60 14 0 0 1 52 97Z" />
      <path className="contura-logo-stack" d="M52 165A60 14 0 0 0 172 165V209A60 14 0 0 1 52 209Z" />
      <path className="contura-logo-teal" d="M84 109A60 14 0 0 0 204 109V153A60 14 0 0 1 84 153Z" />
    </svg>
  );
}

function Head({ titleId, title, text }: { titleId: string; title: ReactNode; text: string }) {
  return (
    <div className="fsg-head">
      <h2 id={titleId} className="fsg-title">
        {title}
      </h2>
      <p className="fsg-p">{text}</p>
    </div>
  );
}

function Welcome({ titleId }: { titleId: string }) {
  return (
    <div className="fsg-welcome">
      <Logo />
      <h2 id={titleId} className="fsg-title">
        Welcome to Contura
      </h2>
      <p className="fsg-p fsg-lede">
        A light database client for MySQL, PostgreSQL and SQLite. Four quick choices and you are in. Each one can be changed later in Settings.
      </p>
      <div className="fsg-promises">
        <div className="fsg-card fsg-promise">
          <Glyph name="lock" size={20} className="fsg-accent" />
          <b>Yours alone</b>
          <span className="fsg-lab fsg-muted">
            No account, cloud or telemetry.
            <br />
            Everything stays on this computer.
          </span>
        </div>
        <div className="fsg-card fsg-promise">
          <Glyph name="shield" size={20} className="fsg-accent" />
          <b>Safe by default</b>
          <span className="fsg-lab fsg-muted">
            Nothing runs on its own.
            <br />
            Production asks before every write.
          </span>
        </div>
      </div>
    </div>
  );
}

function Look({ titleId, theme, effective, onTheme }: { titleId: string; theme: ThemeChoice; effective: "light" | "dark"; onTheme(c: ThemeChoice): void }) {
  return (
    <>
      <Head
        titleId={titleId}
        title="Pick a look"
        text="Code and data are set in JetBrains Mono in both. Switch any time with the moon or sun at the right end of the status bar."
      />
      <div className="fsg-grid2 fsg-looks">
        {(["dark", "light"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={theme === t ? "fsg-pick fsg-look on" : "fsg-pick fsg-look"}
            aria-pressed={theme === t}
            onClick={() => onTheme(t)}
          >
            <span className={`theme-${t} fsg-sample`} aria-hidden="true">
              <span>
                <span className="fsg-kw">SELECT</span> number, total
              </span>
              <span>
                <span className="fsg-kw">FROM</span> <span className="fsg-id">billing.invoices</span>
              </span>
              <span>
                <span className="fsg-kw">WHERE</span> status = <span className="fsg-str">'open'</span>
              </span>
              <span className="fsg-sample-bar" />
            </span>
            <span className="fsg-look-foot">
              <span className="fsg-radio" />
              <Glyph name={t === "dark" ? "moon" : "sun"} size={15} />
              <b>{t === "dark" ? "Dark" : "Light"}</b>
              {t === "dark" && <span className="fsg-lab fsg-end">Default</span>}
            </span>
          </button>
        ))}
      </div>
      {theme === "system" && <p className="fsg-lab fsg-muted fsg-flat">{followText(effective)}</p>}
    </>
  );
}

/** Said on Look and Done while the theme follows the system. */
export function followText(effective: "light" | "dark"): string {
  return `Following the system, which shows ${effective === "dark" ? "Dark" : "Light"} now.`;
}

function FirstConnection({ titleId, db, onDb }: { titleId: string; db: GuideDb; onDb(d: GuideDb): void }) {
  const kind = useSecretStoreKind();
  return (
    <>
      <Head titleId={titleId} title="Add your first Connection" text="Pick the database you use most. Its Connection form opens when the guide ends." />
      <div className="fsg-grid3">
        {DBS.map((d) => (
          <button key={d.id} type="button" className={db === d.id ? "fsg-pick fsg-db on" : "fsg-pick fsg-db"} aria-pressed={db === d.id} onClick={() => onDb(d.id)}>
            <span className="fsg-row">
              <span className="fsg-radio" />
              <Glyph name={d.glyph} size={20} className="fsg-accent" />
            </span>
            <b>{d.name}</b>
            <span className="fsg-lab">{d.hint}</span>
          </button>
        ))}
      </div>
      <button type="button" className={db === "later" ? "fsg-pick fsg-line on" : "fsg-pick fsg-line"} aria-pressed={db === "later"} onClick={() => onDb("later")}>
        <span className="fsg-radio" />
        <span>Not now. I will add one from Home.</span>
      </button>
      {db !== "later" && (
        <p className="fsg-lab fsg-muted fsg-flat">
          {db === "sqlite"
            ? "Next you pick the file. Contura can also make a new empty one."
            : "Next come the host, port, user and password. You can mark the Connection Production or Read-only there."}
        </p>
      )}
      {kind === "keyring" && (
        <div className="fsg-card fsg-note">
          <Glyph name="lock" size={17} className="fsg-ok" />
          <span className="fsg-lab fsg-muted">{KEYRING_FOUND}</span>
        </div>
      )}
      {(kind === "missing" || kind === "noAnswer") && (
        <div className="fsg-card fsg-note fsg-warn-card">
          <Glyph name="alert" size={17} className="fsg-warn" />
          <span className="fsg-lab fsg-muted">{KEYRING_MISSING}</span>
        </div>
      )}
    </>
  );
}

interface AssistantProps {
  titleId: string;
  ai: GuideAi;
  name: string;
  onAi(a: GuideAi): void;
  cloud: boolean;
  keyText: string;
  onKey(v: string): void;
  address: string;
  onAddress(v: string): void;
  check: Check;
  onCheck(): void;
}

function CheckLine({ check }: { check: Check }) {
  if (check.s === "idle") return null;
  if (check.s === "checking") return <span className="fsg-lab" role="status">Checking</span>;
  return (
    <span className={check.s === "ok" ? "fsg-lab fsg-ok" : "fsg-lab fsg-warn"} role={check.s === "ok" ? "status" : "alert"}>
      {check.text}
    </span>
  );
}

function Assistant({ titleId, ai, name, onAi, cloud, keyText, onKey, address, onAddress, check, onCheck }: AssistantProps) {
  const keyId = useId();
  const urlId = useId();
  const checking = check.s === "checking";
  return (
    <>
      <Head
        titleId={titleId}
        title={
          <>
            The AI assistant <span className="fsg-optional">(optional)</span>
          </>
        }
        text="Bring your own provider. Nothing leaves your computer until you set one up, and answers are put in the editor for you to read and run."
      />
      <div className="fsg-grid2 fsg-providers">
        {PROVIDERS.map((p) => (
          <button key={p.id} type="button" className={ai === p.id ? "fsg-pick fsg-line on" : "fsg-pick fsg-line"} aria-pressed={ai === p.id} onClick={() => onAi(p.id)}>
            <span className="fsg-radio" />
            <span>{p.name}</span>
            {p.tag && <span className="fsg-lab fsg-end">{p.tag}</span>}
          </button>
        ))}
      </div>
      {cloud && (
        <div className="fsg-field">
          <label htmlFor={keyId}>{`${name} API key`}</label>
          <div className="fsg-row">
            <input
              id={keyId}
              className="input mono fsg-input"
              type="password"
              placeholder="Paste your key"
              autoComplete="off"
              spellCheck={false}
              value={keyText}
              onChange={(e) => onKey(e.target.value)}
            />
            <button type="button" className="button fsg-check" disabled={checking || keyText.trim() === ""} onClick={onCheck}>
              Check key
            </button>
          </div>
          <span className="fsg-lab">Kept in the system keyring. You pick the model after the guide, in Settings, AI.</span>
          <CheckLine check={check} />
        </div>
      )}
      {ai === "local" && (
        <div className="fsg-field">
          <label htmlFor={urlId}>Address of your local model server</label>
          <div className="fsg-row">
            <input
              id={urlId}
              className="input mono fsg-input"
              type="text"
              spellCheck={false}
              value={address}
              onChange={(e) => onAddress(e.target.value)}
            />
            <button type="button" className="button fsg-check" disabled={checking || address.trim() === ""} onClick={onCheck}>
              Check
            </button>
          </div>
          <span className="fsg-lab">Ollama answers on port 11434 and LM Studio on 1234. Nothing goes beyond this computer.</span>
          <CheckLine check={check} />
        </div>
      )}
      <div className="fsg-card fsg-note fsg-top">
        <Glyph name="spark" size={17} className="fsg-accent" />
        <span className="fsg-lab fsg-muted">
          Each Connection decides what the assistant may see: nothing, the schema, your query, or sample rows. A Sends line under every answer shows exactly what went out.
        </span>
      </div>
    </>
  );
}

function Updates({ titleId, on, onToggle }: { titleId: string; on: boolean; onToggle(): void }) {
  const { status } = useUpdates();
  const how = updateHowText(status?.install);
  const howId = useId();
  return (
    <>
      <Head titleId={titleId} title="Stay up to date" text="Contura can look for a new version when it starts. It is off until you turn it on." />
      <button type="button" className="fsg-card fsg-switch" role="switch" aria-checked={on} aria-describedby={howId} onClick={onToggle}>
        <Glyph name="down" size={20} className="fsg-accent" />
        <span className="fsg-switch-text">
          <b>Check for updates when Contura starts</b>
          <span className="fsg-lab" id={howId}>
            {how}
          </span>
        </span>
        <span className={on ? "sw on" : "sw"} aria-hidden="true" />
      </button>
      <ul className="fsg-facts">
        <li>
          <Glyph name="check" size={16} className="fsg-ok" />
          <span className="fsg-p">It asks only github.com, where Contura is released.</span>
        </li>
        <li>
          <Glyph name="check" size={16} className="fsg-ok" />
          <span className="fsg-p">Every update is signed. A file without the right signature is thrown away.</span>
        </li>
        <li>
          <Glyph name="check" size={16} className="fsg-ok" />
          <span className="fsg-p">Nothing installs until you click Update, and it asks first if you have unsaved work.</span>
        </li>
      </ul>
      <span className="fsg-lab">Check now in Settings, Updates works whether this is on or off.</span>
    </>
  );
}

function themeName(t: ThemeChoice, effective: "light" | "dark"): string {
  if (t === "system") return `Follow the system, ${effective === "dark" ? "Dark" : "Light"} now`;
  return t === "dark" ? "Dark" : "Light";
}

interface DoneProps {
  titleId: string;
  theme: ThemeChoice;
  effective: "light" | "dark";
  db: string | null;
  ai: string | null;
  updates: boolean;
}

function Done({ titleId, theme, effective, db, ai, updates }: DoneProps) {
  const { map } = useKeymap();
  const rows = [
    { k: "Look", v: themeName(theme, effective) },
    { k: "Connection", v: db ? `${db}, its form opens next` : "Later, from Home" },
    { k: "AI assistant", v: ai ?? "Not set up" },
    { k: "Updates", v: updates ? "Checked at start" : "Off" },
  ];
  const keys = KEYS.flatMap((k) => {
    const hint = hintFor(map, k.id);
    return hint ? [{ ...k, hint }] : [];
  });
  return (
    <>
      <div className="fsg-done">
        <span className="fsg-done-mark">
          <Glyph name="check" size={22} className="fsg-ok" />
        </span>
        <h2 id={titleId} className="fsg-title">
          You are set
        </h2>
        <p className="fsg-p">Here is what you chose. Change any of it later in Settings.</p>
      </div>
      <dl className="fsg-card fsg-summary">
        {rows.map((r) => (
          <div key={r.k} className="fsg-summary-row">
            <dt className="fsg-lab">{r.k}</dt>
            <dd>{r.v}</dd>
          </div>
        ))}
      </dl>
      <div className="fsg-keys-box">
        <span className="fsg-lab fsg-strong">A few keys worth knowing</span>
        <div className="fsg-keys">
          {keys.map((k) => (
            <div key={k.id} className="fsg-key">
              <span>
                <Kbd keys={k.hint} />
              </span>
              <span className="fsg-p fsg-small">{k.text}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
