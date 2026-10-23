import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { ThemeChoice } from "../api/types";
import type { InstallKind, UpdateStatus } from "../api/updates";
import { callsTo } from "../test/invoke";
import { Providers, settingsRoutes } from "../test/settingsRoutes";
import guideCss from "../styles/guide.css?raw";
import { useTheme } from "../theme/useTheme";
import { loadUpdates, resetUpdatesForTests } from "../update/updateStore";
import FirstStartGuide, { GUIDE_AGAIN, KEYRING_FOUND, KEYRING_MISSING, type GuideResult, followText, localBaseUrl, updateHowText } from "./FirstStartGuide";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

function status(install: InstallKind = "portable"): UpdateStatus {
  return {
    checks: null,
    currentVersion: "1.0.0",
    lastCheckMs: null,
    lastResult: null,
    offer: null,
    install,
    canInstall: false,
    ready: false,
    releasesUrl: "https://github.com/Rifqio/contura/releases",
  };
}

/** The Core as the guide sees it; `secrets` is what secret_store_kind answers. */
interface CoreOpts {
  install?: InstallKind;
  secrets?: string;
  /** The saved update checks choice. */
  checks?: boolean | null;
  /** The update check never answers (offline, a slow proxy). */
  hangCheck?: boolean;
  /** The AI test never answers. */
  hangAi?: boolean;
  /** Saving the update choice fails. */
  failSave?: boolean;
  theme?: ThemeChoice;
}

function core(opts: CoreOpts = {}) {
  let s = { ...status(opts.install), checks: opts.checks ?? null };
  return settingsRoutes(
    {
      update_status: () => s,
      set_update_checks: (a) => {
        if (opts.failSave) throw new Error("the data folder is read-only");
        return (s = { ...s, checks: a.on as boolean });
      },
      check_for_update: () => (opts.hangCheck ? new Promise(() => {}) : s),
      secret_store_kind: () => opts.secrets ?? "keyring",
      ...(opts.hangAi ? { ai_test: () => new Promise(() => {}) } : {}),
    },
    { prefs: { theme: opts.theme ?? "dark" } },
  );
}

/** The guide with the real theme hook, as App mounts it. */
function Harness({ onClose }: { onClose(r: GuideResult): void }) {
  const theme = useTheme();
  return <FirstStartGuide theme={theme.choice} effective={theme.effective} onTheme={theme.choose} onClose={onClose} />;
}

async function open(opts: CoreOpts = {}) {
  core(opts);
  await act(() => loadUpdates());
  const onClose = vi.fn<(r: GuideResult) => void>();
  const view = render(
    <Providers>
      <Harness onClose={onClose} />
    </Providers>,
  );
  // The AI settings snapshot is a local read; let it land.
  await waitFor(() => expect(callsTo("ai_settings").length).toBeGreaterThan(0));
  return Object.assign(onClose, { view });
}

const dialog = () => screen.getByRole("dialog");
const next = () => userEvent.click(screen.getByRole("button", { name: /^(Get started|Next)$/ }));
async function goTo(step: number) {
  for (let i = 0; i < step; i++) await next();
}
/** What left the computer: only these commands reach a provider or GitHub. */
const egress = () => [...callsTo("ai_test"), ...callsTo("ai_models"), ...callsTo("check_for_update")];

beforeEach(() => {
  resetUpdatesForTests();
  document.documentElement.removeAttribute("data-theme");
});

test("Welcome: the title names the dialog, Get started has focus, no progress bar yet", async () => {
  await open();
  expect(screen.getByRole("dialog", { name: "Welcome to Contura" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Get started" }));
  expect(screen.queryByText("Step 1 of 4")).toBeNull();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(screen.getByText("Yours alone")).toBeTruthy();
});

test("each step's title labels the dialog and its first control takes focus", async () => {
  await open();
  await next();
  expect(screen.getByRole("dialog", { name: "Pick a look" })).toBeTruthy();
  expect(screen.getByText("Step 1 of 4")).toBeTruthy();
  expect(document.activeElement?.textContent).toContain("Dark");
  await next();
  expect(screen.getByRole("dialog", { name: "Add your first Connection" })).toBeTruthy();
  expect(document.activeElement?.textContent).toContain("MySQL");
  await next();
  expect(screen.getByRole("dialog", { name: "The AI assistant (optional)" })).toBeTruthy();
  expect(document.activeElement?.textContent).toContain("Not now");
  await next();
  expect(screen.getByRole("dialog", { name: "Stay up to date" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("switch"));
  await next();
  expect(screen.getByRole("dialog", { name: "You are set" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add the PostgreSQL Connection" }));
  // Back walks the other way.
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "Stay up to date" })).toBeTruthy();
});

test("Tab and Shift+Tab stay inside the dialog", async () => {
  await open();
  const getStarted = screen.getByRole("button", { name: "Get started" });
  expect(document.activeElement).toBe(getStarted);
  // Get started is the last control: Tab wraps to Skip.
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Skip the guide" }));
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(getStarted);
});

test("Look: a pick applies the theme at once and saves it like the status bar switch", async () => {
  await open();
  await goTo(1);
  expect(screen.getByRole("button", { name: /Dark/, pressed: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /Light/ }));
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  expect(screen.getByRole("button", { name: /Light/, pressed: true })).toBeTruthy();
  await waitFor(() => expect(callsTo("save_ui_prefs").slice(-1)[0]?.prefs).toMatchObject({ theme: "light" as ThemeChoice }));
});

test("First Connection: the database cards, the next line, and the keyring line", async () => {
  await open();
  await goTo(2);
  expect(screen.getByText("MySQL 8.0 and newer")).toBeTruthy();
  expect(screen.getByText("PostgreSQL 13 and newer")).toBeTruthy();
  expect(screen.getByText("Built in, a .sqlite or .db file")).toBeTruthy();
  expect(screen.getByRole("button", { name: /PostgreSQL/, pressed: true })).toBeTruthy();
  expect(screen.getByText(/^Next come the host, port, user and password/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /SQLite/ }));
  expect(screen.getByText("Next you pick the file. Contura can also make a new empty one.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Not now. I will add one from Home." }));
  expect(screen.queryByText(/^Next (you|come)/)).toBeNull();
  expect(await screen.findByText(KEYRING_FOUND)).toBeTruthy();
  expect(screen.queryByText(KEYRING_MISSING)).toBeNull();
});

test.each(["missing", "noAnswer"])("First Connection: a %s keyring says passwords last this session only", async (kind) => {
  await open({ secrets: kind });
  await goTo(2);
  expect(await screen.findByText(KEYRING_MISSING)).toBeTruthy();
  expect(screen.queryByText(KEYRING_FOUND)).toBeNull();
});

test("AI: picks and a typed key send nothing; only Check key saves the key and runs the AI test", async () => {
  await open();
  await goTo(3);
  expect(screen.getByRole("button", { name: /Not now/, pressed: true })).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  for (const name of [/Anthropic/, /OpenAI-compatible/, /Groq/, /DeepSeek/, /Local model/, /Anthropic/]) {
    await userEvent.click(screen.getByRole("button", { name }));
  }
  const key = screen.getByLabelText("Anthropic API key");
  await userEvent.type(key, "sk-ant-test");
  expect(egress()).toEqual([]);
  expect(callsTo("save_ai_settings")).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Check key" }));
  expect(await screen.findByText("openai/gpt-oss-20b replied in 412ms. Only the test prompt was sent.")).toBeTruthy();
  const saved = callsTo("save_ai_settings");
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ groupId: null, overrideGroup: false, key: { t: "set", value: "sk-ant-test" } });
  expect(saved[0].settings).toMatchObject({ provider: "anthropic", baseUrl: "https://api.anthropic.com" });
  expect(callsTo("ai_test")).toEqual([{ groupId: null }]);
});

test("AI: Check key waits for a key", async () => {
  await open();
  await goTo(3);
  await userEvent.click(screen.getByRole("button", { name: /Groq/ }));
  expect((screen.getByRole("button", { name: "Check key" }) as HTMLButtonElement).disabled).toBe(true);
});

test("AI: a key typed for one provider is cleared when the pick changes", async () => {
  await open();
  await goTo(3);
  await userEvent.click(screen.getByRole("button", { name: /Anthropic/ }));
  await userEvent.type(screen.getByLabelText("Anthropic API key"), "sk-ant-test");
  await userEvent.click(screen.getByRole("button", { name: /Groq/ }));
  expect((screen.getByLabelText("Groq API key") as HTMLInputElement).value).toBe("");
  expect((screen.getByRole("button", { name: "Check key" }) as HTMLButtonElement).disabled).toBe(true);
});

test("AI: while a Check is out, the guide cannot be ended or left", async () => {
  await open({ hangAi: true });
  await goTo(3);
  await userEvent.click(screen.getByRole("button", { name: /Groq/ }));
  await userEvent.type(screen.getByLabelText("Groq API key"), "gsk-test");
  await userEvent.click(screen.getByRole("button", { name: "Check key" }));
  await screen.findByText("Checking");
  for (const name of [/Skip the guide/, /Back/, /Continue|Next/]) {
    expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
});

test("AI: Local model starts at 127.0.0.1:11434, Check saves it as the /v1 base URL without a key", async () => {
  await open();
  await goTo(3);
  await userEvent.click(screen.getByRole("button", { name: /Local model/ }));
  const address = screen.getByLabelText("Address of your local model server") as HTMLInputElement;
  expect(address.value).toBe("http://127.0.0.1:11434");
  expect(egress()).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  await screen.findByText(/replied in/);
  const saved = callsTo("save_ai_settings");
  expect(saved[0]).toMatchObject({ key: { t: "keep" } });
  expect(saved[0].settings).toMatchObject({ provider: "custom", baseUrl: "http://127.0.0.1:11434/v1" });
});

test("localBaseUrl adds /v1 only to a bare address", () => {
  expect(localBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434/v1");
  expect(localBaseUrl("http://localhost:1234/")).toBe("http://localhost:1234/v1");
  expect(localBaseUrl("http://localhost:1234/v1")).toBe("http://localhost:1234/v1");
  // No scheme: http:// goes first, then /v1.
  expect(localBaseUrl("localhost:11434")).toBe("http://localhost:11434/v1");
  expect(localBaseUrl("127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
  expect(localBaseUrl("192.168.1.20:8080/v1")).toBe("http://192.168.1.20:8080/v1");
});

test.each([
  ["portable", "A new version replaces this exe in one click, and Contura restarts. Your data folder stays."],
  ["appImage", "A new version replaces this AppImage in one click, and Contura restarts."],
  ["package", "Installed with apt: Contura tells you a new version is out, and you install the new .deb yourself."],
] as const)("Updates: a %s install is told how it updates", async (install, text) => {
  expect(updateHowText(install)).toBe(text);
  await open({ install });
  await goTo(4);
  expect(screen.getByText(text)).toBeTruthy();
  const sw = screen.getByRole("switch", { name: /Check for updates when Contura starts/ });
  expect(sw.getAttribute("aria-checked")).toBe("false");
});

test("Done: the summary, the six keys, and the button opens the chosen Connection form; the switch is saved", async () => {
  const onClose = await open();
  await goTo(4);
  await userEvent.click(screen.getByRole("switch"));
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  await next();
  const summary = within(dialog()).getByText("Look").closest("dl") as HTMLElement;
  expect(within(summary).getByText("Dark")).toBeTruthy();
  expect(within(summary).getByText("PostgreSQL, its form opens next")).toBeTruthy();
  expect(within(summary).getByText("Not set up")).toBeTruthy();
  expect(within(summary).getByText("Checked at start")).toBeTruthy();
  for (const [k, text] of [
    ["Ctrl+N", "New Connection"],
    ["Ctrl+T", "New query"],
    ["Ctrl+Enter", "Run the current statement"],
    ["Ctrl+I", "Ask AI in the editor"],
    ["Ctrl+Shift+H", "Home"],
    ["Ctrl+,", "Settings"],
  ]) {
    expect(screen.getByText(k).closest(".fsg-key")?.textContent).toContain(text);
  }
  expect(screen.queryByRole("button", { name: "Skip the guide" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Add the PostgreSQL Connection" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledWith({ skipped: false, dialect: "postgres", error: null }));
  expect(callsTo("set_update_checks")).toEqual([{ on: true }]);
  // Nothing about AI was saved: Not now.
  expect(callsTo("save_ai_settings")).toEqual([]);
});

test("Done: Not now ends with Open Contura and no form; a picked provider is saved without a test", async () => {
  const onClose = await open();
  await goTo(2);
  await userEvent.click(screen.getByRole("button", { name: "Not now. I will add one from Home." }));
  await next();
  await userEvent.click(screen.getByRole("button", { name: /Groq/ }));
  await goTo(2);
  expect(within(dialog()).getByText("Later, from Home")).toBeTruthy();
  expect(within(dialog()).getByText("Groq")).toBeTruthy();
  expect(within(dialog()).getByText("Off")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open Contura" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledWith({ skipped: false, dialect: null, error: null }));
  expect(callsTo("set_update_checks")).toEqual([{ on: false }]);
  expect(callsTo("save_ai_settings")[0]).toMatchObject({ key: { t: "keep" }, settings: { provider: "groq" } });
  expect(egress()).toEqual([]);
});

test("Skip keeps every default: nothing is saved and nothing is sent", async () => {
  const onClose = await open();
  await goTo(3);
  await userEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
  await userEvent.click(screen.getByRole("button", { name: "Skip the guide" }));
  expect(onClose).toHaveBeenCalledWith({ skipped: true, dialect: null, error: null });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(callsTo("set_update_checks")).toEqual([]);
  expect(callsTo("save_ai_settings")).toEqual([]);
  expect(egress()).toEqual([]);
});

test("Esc is Skip", async () => {
  const onClose = await open();
  await goTo(4);
  await userEvent.click(screen.getByRole("switch"));
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledWith({ skipped: true, dialect: null, error: null });
  expect(callsTo("set_update_checks")).toEqual([]);
});

test("the guide's copy has no dashes and never says cursor or caret, and its styles use tokens only", async () => {
  await open();
  const texts: string[] = [];
  for (let i = 0; i <= 5; i++) {
    texts.push(dialog().textContent ?? "");
    if (i < 5) await next();
  }
  for (const t of [...texts, GUIDE_AGAIN]) expect(t).not.toMatch(/[–—]|cursor|caret/i);
  expect(guideCss.length).toBeGreaterThan(1000);
  expect(guideCss.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![\w-])|rgb\(/gi) ?? []).toEqual([]);
});

test("Updates: a reopen starts from the saved setting, and an unchanged switch is not written", async () => {
  const onClose = await open({ checks: true });
  await goTo(4);
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  await goTo(1);
  expect(within(dialog()).getByText("Checked at start")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Add the PostgreSQL Connection" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(callsTo("set_update_checks")).toEqual([]);
});

test("Updates: turning checks off on a reopen is written", async () => {
  const onClose = await open({ checks: true });
  await goTo(4);
  await userEvent.click(screen.getByRole("switch"));
  await goTo(1);
  await userEvent.click(screen.getByRole("button", { name: "Add the PostgreSQL Connection" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(callsTo("set_update_checks")).toEqual([{ on: false }]);
});

test("ending never waits for the network: a check that never answers runs in the background", async () => {
  const onClose = await open({ hangCheck: true });
  await goTo(4);
  await userEvent.click(screen.getByRole("switch"));
  await goTo(1);
  await userEvent.click(screen.getByRole("button", { name: "Add the PostgreSQL Connection" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledWith({ skipped: false, dialect: "postgres", error: null }));
  expect(callsTo("set_update_checks")).toEqual([{ on: true }]);
  // The first check was started, and is still out.
  expect(callsTo("check_for_update")).toEqual([{ manual: false }]);
});

test("a failed update save is said plainly, not reported as ready", async () => {
  const onClose = await open({ failSave: true });
  await goTo(5);
  await userEvent.click(screen.getByRole("button", { name: "Add the PostgreSQL Connection" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onClose.mock.calls[0][0].error).toMatch(/^The update setting was not saved: /);
});

test("AI: Check, then Not now, puts AI back as it was and Done says so", async () => {
  const onClose = await open();
  await goTo(3);
  await userEvent.click(screen.getByRole("button", { name: /Anthropic/ }));
  await userEvent.type(screen.getByLabelText("Anthropic API key"), "sk-ant-test");
  await userEvent.click(screen.getByRole("button", { name: "Check key" }));
  await screen.findByText(/replied in/);
  // The result line never shows the key.
  expect(dialog().textContent).not.toContain("sk-ant-test");
  await userEvent.click(screen.getByRole("button", { name: /Not now/ }));
  await goTo(2);
  expect(within(dialog()).getByText("Not set up")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Add the PostgreSQL Connection" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  const saves = callsTo("save_ai_settings");
  expect(saves.map((c) => [(c.settings as { provider: string | null }).provider, (c.key as { t: string }).t])).toEqual([
    ["anthropic", "set"],
    ["anthropic", "clear"],
    [null, "keep"],
  ]);
});

test("AI: a typed key that was never checked is saved when the guide ends", async () => {
  const onClose = await open();
  await goTo(3);
  await userEvent.click(screen.getByRole("button", { name: /Groq/ }));
  await userEvent.type(screen.getByLabelText("Groq API key"), "gsk_test");
  await goTo(2);
  await userEvent.click(screen.getByRole("button", { name: "Add the PostgreSQL Connection" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(callsTo("save_ai_settings")).toEqual([expect.objectContaining({ key: { t: "set", value: "gsk_test" } })]);
  expect(egress()).toEqual([]);
});

test("Esc on Done ends the guide without a form, and keeps the choices", async () => {
  const onClose = await open();
  await goTo(4);
  await userEvent.click(screen.getByRole("switch"));
  await next();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(onClose).toHaveBeenCalledWith({ skipped: false, dialect: null, error: null }));
  expect(callsTo("set_update_checks")).toEqual([{ on: true }]);
});

test("theme following the system: Look and Done say which theme shows now", async () => {
  await open({ theme: "system" });
  await goTo(1);
  expect(screen.getByText(followText("light"))).toBeTruthy();
  await goTo(4);
  expect(within(dialog()).getByText("Follow the system, Light now")).toBeTruthy();
});

test("focus goes back where it was, and no key listener is left after the guide closes", async () => {
  core();
  await act(() => loadUpdates());
  const onClose = vi.fn<(r: GuideResult) => void>();
  function Opener() {
    const [shown, setShown] = useState(false);
    const theme = useTheme();
    return (
      <>
        <button type="button" onClick={() => setShown(true)}>
          Show the first start guide
        </button>
        {shown && (
          <FirstStartGuide
            theme={theme.choice}
            effective={theme.effective}
            onTheme={theme.choose}
            onClose={(r) => {
              onClose(r);
              setShown(false);
            }}
          />
        )}
      </>
    );
  }
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  render(
    <Providers>
      <Opener />
    </Providers>,
  );
  const opener = screen.getByRole("button", { name: "Show the first start guide" });
  await userEvent.click(opener);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(document.documentElement.classList.contains("fsg-open")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Skip the guide" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.documentElement.classList.contains("fsg-open")).toBe(false);
  const guideKeys = add.mock.calls.filter(([type, , capture]) => type === "keydown" && capture === true).map(([, fn]) => fn);
  expect(guideKeys.length).toBeGreaterThan(0);
  for (const fn of guideKeys) expect(remove.mock.calls.some(([type, f, capture]) => type === "keydown" && f === fn && capture === true)).toBe(true);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  add.mockRestore();
  remove.mockRestore();
});

test("nothing behind the guide keeps focus or hears Esc", async () => {
  const outsideKeys = vi.fn();
  document.addEventListener("keydown", outsideKeys);
  const onClose = await open();
  const behind = document.createElement("button");
  behind.textContent = "Home";
  document.body.prepend(behind);
  // Focus that reaches the app behind (a click in the title bar) comes back into the dialog.
  act(() => behind.focus());
  expect(dialog().contains(document.activeElement)).toBe(true);
  await userEvent.tab();
  expect(dialog().contains(document.activeElement)).toBe(true);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledWith({ skipped: true, dialect: null, error: null });
  expect(outsideKeys.mock.calls.filter(([e]) => (e as KeyboardEvent).key === "Escape")).toEqual([]);
  document.removeEventListener("keydown", outsideKeys);
  behind.remove();
});

test("the cover takes the whole window and only the window buttons sit above it", () => {
  const rule = (sel: string) => {
    const at = guideCss.indexOf(`${sel} {`);
    return at < 0 ? "" : guideCss.slice(at, guideCss.indexOf("}", at));
  };
  expect(rule(".fsg-cover")).toMatch(/position:\s*fixed;[\s\S]*inset:\s*0;[\s\S]*z-index:\s*300/);
  expect(rule(":root.fsg-open .window-buttons")).toMatch(/z-index:\s*301/);
});
