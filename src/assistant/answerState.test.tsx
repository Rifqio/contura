import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { setPlatformForTests } from "../platform";
import type { AiError, AiSettings } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import { modelInfo } from "../test/settingsRoutes";
import answerState, { aiErrorOf, answerEnd, modelToUse, waitText } from "./answerState";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

afterEach(() => {
  vi.useRealTimers();
});

const ai = (message: AiError) => ({ kind: "ai", message });

/** Groq with gpt-oss-20b current, a 120b largest and a fast 8b. */
const current = modelInfo({ tier: "mid" });
const models = [
  current,
  modelInfo({ id: "openai/gpt-oss-120b", name: "openai/gpt-oss-120b", tier: "largest", contextWindow: 262_144 }),
  modelInfo({ id: "llama-3.1-8b-instant", name: "llama-3.1-8b-instant", tier: "fastest", contextWindow: 131_072 }),
];
const groq = { providerName: "Groq", provider: "groq" as const, model: current, models, connectionName: "Shop" };

const card = () => screen.getByRole("alert");
const buttons = () => Array.from(card().querySelectorAll("button")).map((b) => b.textContent);
const text = (t: string) => expect(screen.getByText(t)).toBeTruthy();

test("aiErrorOf knows the provider error kinds", () => {
  const overloaded = { kind: "overloaded", provider: "groq" };
  expect(aiErrorOf({ kind: "ai", message: overloaded })).toEqual(overloaded);
  const creds = { kind: "urlHasCredentials", host: "x.example" };
  expect(aiErrorOf({ kind: "ai", message: creds })).toEqual(creds);
  expect(aiErrorOf({ kind: "ai", message: { kind: "busy" } })).toEqual({ kind: "busy" });
  expect(aiErrorOf({ kind: "ai", message: { kind: "internal" } })).toEqual({ kind: "internal" });
  expect(aiErrorOf({ kind: "ai", message: { kind: "nothingToContinue" } })).toEqual({ kind: "nothingToContinue" });
  expect(aiErrorOf({ kind: "ai", message: { kind: "nope" } })).toBeNull();
  expect(aiErrorOf({ kind: "ai", message: { kind: "notAvailable", provider: "groq" } })).toBeNull();
});

test("rate_limited_card", () => {
  render(answerState(ai({ kind: "rateLimited", retryAfterSecs: 20 }), { ...groq, onRetry: vi.fn() }));
  text("Groq is limiting requests.");
  text("Retrying in 20s. Contura retries on its own when the wait is over. Nothing was answered yet.");
  text("20s");
  expect(buttons()).toEqual(["Retry now", "Stop"]);
});

test("rate_limit_counts_down_and_retries", () => {
  vi.useFakeTimers();
  const onRetry = vi.fn();
  render(answerState(ai({ kind: "rateLimited", retryAfterSecs: 20 }), { ...groq, onRetry }));
  text("20s");
  act(() => vi.advanceTimersByTime(1000));
  text("19s");
  text("Retrying in 19s. Contura retries on its own when the wait is over. Nothing was answered yet.");
  expect(onRetry).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(19_000));
  expect(onRetry).toHaveBeenCalledTimes(1);
  text("Retrying now. Contura retries on its own when the wait is over. Nothing was answered yet.");
  act(() => vi.advanceTimersByTime(5000));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("rate_limit_without_a_wait_waits_10s", () => {
  vi.useFakeTimers();
  const onRetry = vi.fn();
  render(answerState(ai({ kind: "rateLimited", retryAfterSecs: null }), { ...groq, onRetry }));
  text("10s");
  act(() => vi.advanceTimersByTime(10_000));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("overloaded_card_offers_the_fastest_model", () => {
  const onUseModel = vi.fn();
  const onRetry = vi.fn();
  render(answerState(ai({ kind: "overloaded", provider: "groq" }), { ...groq, onRetry, onUseModel, tries: 2 }));
  text("Groq is busy right now.");
  text("Their servers are overloaded, so nothing was charged. Try again in a moment, or use a faster model.");
  text("Try 2");
  expect(buttons()).toEqual(["Retry", "Use llama-3.1-8b-instant"]);
  screen.getByRole("button", { name: "Use llama-3.1-8b-instant" }).click();
  expect(onUseModel).toHaveBeenCalledWith("llama-3.1-8b-instant");
  screen.getByRole("button", { name: "Retry" }).click();
  expect(onRetry).toHaveBeenCalled();
});

test("overloaded_card_hides_use_when_the_fastest_is_current", () => {
  const fast = models[2];
  render(answerState(ai({ kind: "overloaded", provider: "groq" }), { ...groq, model: fast, onRetry: vi.fn(), onUseModel: vi.fn() }));
  expect(buttons()).toEqual(["Retry"]);
});

test("timeout_cards_name_the_phase", () => {
  const cases: [string, string, string][] = [
    ["first byte", "No reply from Groq for 60s.", "The request left this computer but nothing came back. Nothing ran on Shop."],
    ["idle", "Groq stopped sending for 30s.", "The request left this computer but nothing came back. Nothing ran on Shop."],
    ["answer", "The answer took longer than 5 minutes.", "The request left this computer but nothing came back. Nothing ran on Shop."],
    ["connect", "Could not connect to api.groq.com in 10s.", "Nothing was sent."],
  ];
  for (const [phase, title, body] of cases) {
    const { unmount } = render(answerState(ai({ kind: "timeout", phase }), { ...groq, host: "api.groq.com", onRetry: vi.fn() }));
    text(title);
    text(body);
    expect(buttons()).toEqual(["Retry"]);
    unmount();
  }
});

test("offline_card", () => {
  render(answerState(ai({ kind: "offline" }), { ...groq, onSendNow: vi.fn(), onCancelQueued: vi.fn() }));
  text("No internet connection.");
  text("Your question is kept and goes out as soon as this computer is back online.");
  expect(buttons()).toEqual(["Send now", "Cancel"]);
});

test("offline_card_does_not_listen_for_online", () => {
  const onSendNow = vi.fn();
  const onCancelQueued = vi.fn();
  render(answerState(ai({ kind: "offline" }), { ...groq, onSendNow, onCancelQueued }));
  // The panel or the inline box queues the question; the card only offers its buttons.
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  expect(onSendNow).not.toHaveBeenCalled();
  screen.getByRole("button", { name: "Cancel" }).click();
  expect(onCancelQueued).toHaveBeenCalled();
});

test("bad_key_card", () => {
  const onOpenSettings = vi.fn();
  render(answerState(ai({ kind: "badKey" }), { ...groq, onOpenSettings, onRetry: vi.fn() }));
  text("Groq refused the API key.");
  text("The key in the OS keyring (the Secret Service) was revoked or mistyped. Fix it in Settings, then retry.");
  expect(buttons()).toEqual(["Open Settings", "Retry"]);
  screen.getByRole("button", { name: "Open Settings" }).click();
  expect(onOpenSettings).toHaveBeenCalled();
});

test("try_n_on_bad_key", () => {
  const { unmount } = render(answerState(ai({ kind: "badKey" }), { ...groq, tries: 1, onRetry: vi.fn() }));
  expect(screen.queryByText("Try 1")).toBeNull();
  unmount();
  render(answerState(ai({ kind: "badKey" }), { ...groq, tries: 3, onRetry: vi.fn() }));
  text("Try 3");
});

test("try_n_on_rate_limited", () => {
  render(answerState(ai({ kind: "rateLimited", retryAfterSecs: 5 }), { ...groq, tries: 2, onRetry: vi.fn() }));
  text("Try 2");
});

test("out_of_credit_card_opens_the_console", () => {
  routeInvoke({ open_url: () => undefined });
  render(answerState(ai({ kind: "outOfCredit", provider: "groq" }), { ...groq, onRetry: vi.fn() }));
  text("Your Groq account is out of credit.");
  text("Add credit in the Groq console, then retry. Contura never sees billing details.");
  expect(buttons()).toEqual(["Open the Groq console", "Retry"]);
  screen.getByRole("button", { name: "Open the Groq console" }).click();
  expect(callsTo("open_url")).toEqual([{ url: "https://console.groq.com/keys" }]);
});

test("out_of_credit_without_a_console_address_keeps_retry", () => {
  render(answerState(ai({ kind: "outOfCredit", provider: "custom" }), { onRetry: vi.fn() }));
  expect(buttons()).toEqual(["Retry"]);
});

test("model_retired_card", () => {
  const onUseModel = vi.fn();
  const onPickModel = vi.fn();
  render(answerState(ai({ kind: "modelRetired", model: "qwen/qwen3.8-27b" }), { ...groq, onUseModel, onPickModel }));
  text("qwen/qwen3.8-27b is no longer offered.");
  text("Groq retired this model. Pick another one: the thread stays as it is.");
  expect(buttons()).toEqual(["Use openai/gpt-oss-20b", "Pick a model"]);
  screen.getByRole("button", { name: "Use openai/gpt-oss-20b" }).click();
  expect(onUseModel).toHaveBeenCalledWith("openai/gpt-oss-20b");
  screen.getByRole("button", { name: "Pick a model" }).click();
  expect(onPickModel).toHaveBeenCalled();
});

test("too_big_card", () => {
  const onUseModel = vi.fn();
  const onPickTables = vi.fn();
  render(
    answerState(ai({ kind: "tooBig", needed: 1_300_000, window: 131_072, model: "openai/gpt-oss-20b" }), {
      ...groq,
      tables: 214,
      onUseModel,
      onPickTables,
    }),
  );
  text("This question needs 1.3M tokens. openai/gpt-oss-20b holds 131K.");
  text("The schema of 214 tables does not fit. Ask about fewer tables, or switch to a model with a larger window.");
  expect(buttons()).toEqual(["Use openai/gpt-oss-120b, 262K", "Pick tables"]);
  screen.getByRole("button", { name: "Use openai/gpt-oss-120b, 262K" }).click();
  expect(onUseModel).toHaveBeenCalledWith("openai/gpt-oss-120b");
  screen.getByRole("button", { name: "Pick tables" }).click();
  expect(onPickTables).toHaveBeenCalled();
});

test("too_big_hides_use_when_none_is_larger", () => {
  render(
    answerState(ai({ kind: "tooBig", needed: 1_300_000, window: 262_144, model: "openai/gpt-oss-120b" }), {
      ...groq,
      onUseModel: vi.fn(),
      onPickTables: vi.fn(),
    }),
  );
  expect(buttons()).toEqual(["Pick tables"]);
});

test("context_full_card", () => {
  const onNewChat = vi.fn();
  render(answerState(ai({ kind: "contextFull", used: 126_000, window: 131_072, model: "openai/gpt-oss-20b" }), { ...groq, onNewChat }));
  text("This thread fills 96% of openai/gpt-oss-20b's 131K window.");
  expect(buttons()).toEqual(["New chat"]);
  screen.getByRole("button", { name: "New chat" }).click();
  expect(onNewChat).toHaveBeenCalled();
});

test("context_full_card_with_no_messages_to_fold", () => {
  const on = { onNewChat: vi.fn(), onCompactNow: vi.fn(), onTurnOnAutoCompact: vi.fn() };
  render(answerState(ai({ kind: "contextFull", used: 192_000, window: 200_000, model: "openai/gpt-oss-20b", messages: 0 }), { ...groq, ...on }));
  text("This thread fills 96% of openai/gpt-oss-20b's 200K window.");
  text("Auto-compact is off, so nothing was sent. New chat starts empty with the same context.");
  expect(screen.queryByText(/Compact now turns/)).toBeNull();
  expect(buttons()).toEqual(["New chat", "Turn on auto-compact"]);
});

test("context_full_card_texts_and_actions", () => {
  const on = { onNewChat: vi.fn(), onCompactNow: vi.fn(), onTurnOnAutoCompact: vi.fn() };
  render(
    answerState(ai({ kind: "contextFull", used: 192_000, window: 200_000, model: "openai/gpt-oss-20b", messages: 14 }), {
      ...groq,
      ...on,
    }),
  );
  text("This thread fills 96% of openai/gpt-oss-20b's 200K window.");
  text(
    "Auto-compact is off, so nothing was sent. Compact now turns the 14 older messages into a summary written by the model. New chat starts empty with the same context.",
  );
  expect(buttons()).toEqual(["Compact now", "New chat", "Turn on auto-compact"]);
  expect(screen.getByRole("button", { name: "Compact now" }).className).toContain("button-primary");
  screen.getByRole("button", { name: "Compact now" }).click();
  screen.getByRole("button", { name: "New chat" }).click();
  screen.getByRole("button", { name: "Turn on auto-compact" }).click();
  expect(on.onCompactNow).toHaveBeenCalledTimes(1);
  expect(on.onNewChat).toHaveBeenCalledTimes(1);
  expect(on.onTurnOnAutoCompact).toHaveBeenCalledTimes(1);
});

test("context_full_card_while_compacting_disables_both_compact_actions", () => {
  render(
    answerState(ai({ kind: "contextFull", used: 192_000, window: 200_000, model: "openai/gpt-oss-20b", messages: 14 }), {
      ...groq,
      onNewChat: vi.fn(),
      onCompactNow: vi.fn(),
      onTurnOnAutoCompact: vi.fn(),
      compacting: true,
    }),
  );
  expect((screen.getByRole("button", { name: "Compact now" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Turn on auto-compact" }) as HTMLButtonElement).disabled).toBe(true);
});

test("too_large_card", () => {
  render(answerState(ai({ kind: "tooLarge" }), groq));
  text("This Ask is over the size openai/gpt-oss-20b accepts, even after trimming.");
});

test("key_host_changed_card", () => {
  const onConfirmKeyHost = vi.fn();
  const onOpenSettings = vi.fn();
  render(answerState(ai({ kind: "keyHostChanged", host: "api.example.com" }), { ...groq, onConfirmKeyHost, onOpenSettings }));
  text("The base URL now points to api.example.com. Save the key again to send it there.");
  expect(buttons()).toEqual(["Send the saved key to api.example.com", "Open Settings"]);
  screen.getByRole("button", { name: "Send the saved key to api.example.com" }).click();
  expect(onConfirmKeyHost).toHaveBeenCalledWith("api.example.com");
});

test("cards_say_only_the_outline_step_was_sent", () => {
  const cases: [AiError, string][] = [
    [{ kind: "timeout", phase: "connect" }, "Only the outline step was sent."],
    [{ kind: "tls", host: "api.groq.com" }, "A proxy or antivirus may be inspecting https. Only the outline step was sent."],
    [
      { kind: "urlHasCredentials", host: "x.example" },
      "Remove them from the base URL and save the key in the key field instead. Only the outline step was sent.",
    ],
  ];
  for (const [error, body] of cases) {
    const { unmount } = render(answerState(ai(error), { ...groq, host: "api.groq.com", outlineSent: true, onRetry: vi.fn(), onOpenSettings: vi.fn() }));
    text(body);
    expect(screen.queryByText(/Nothing was sent/)).toBeNull();
    unmount();
  }
});

test("tls_card", () => {
  render(answerState(ai({ kind: "tls", host: "api.groq.com" }), { ...groq, onOpenSettings: vi.fn() }));
  text("Could not check the certificate of api.groq.com.");
  text("A proxy or antivirus may be inspecting https. Nothing was sent.");
  expect(buttons()).toEqual(["Open Settings"]);
});

test("busy_card_stops_only_where_it_can", () => {
  const onStop = vi.fn();
  const { unmount } = render(answerState(ai({ kind: "busy" }), { ...groq, onStop }));
  text("An answer is still being written. Stop it first.");
  screen.getByRole("button", { name: "Stop it" }).click();
  expect(onStop).toHaveBeenCalled();
  unmount();
  render(answerState(ai({ kind: "busy" }), groq));
  expect(buttons()).toEqual([]);
});

test("nothing_to_continue_card", () => {
  const onNewChat = vi.fn();
  const onAskAgain = vi.fn();
  render(answerState(ai({ kind: "nothingToContinue" }), { ...groq, onNewChat, onAskAgain, onRetry: vi.fn() }));
  text("Nothing to continue.");
  expect(screen.queryByText("Something went wrong before the question was sent.")).toBeNull();
  expect(buttons()).toEqual(["New chat", "Ask again"]);
  screen.getByRole("button", { name: "New chat" }).click();
  screen.getByRole("button", { name: "Ask again" }).click();
  expect(onNewChat).toHaveBeenCalledTimes(1);
  expect(onAskAgain).toHaveBeenCalledTimes(1);
});

test("credentials_card", () => {
  const onOpenSettings = vi.fn();
  render(answerState(ai({ kind: "urlHasCredentials", host: "x.example" }), { onOpenSettings }));
  text("The base URL for x.example has a user name and password.");
  screen.getByRole("button", { name: "Open Settings" }).click();
  expect(onOpenSettings).toHaveBeenCalled();
});

test("network_card_never_claims_nothing_was_sent", () => {
  const network = ai({ kind: "network", host: "api.groq.com" });
  const { unmount } = render(answerState(network));
  text("Could not reach api.groq.com.");
  text("Check your internet connection or proxy settings.");
  expect(screen.queryByText(/Nothing left this (PC|computer)/)).toBeNull();
  unmount();
  render(answerState(network, { partial: true }));
  text("Check your internet connection or proxy settings. The part that arrived is kept.");
});

test("show_log_sits_on_the_right_when_given", () => {
  const onShowLog = vi.fn();
  const { unmount } = render(answerState(ai({ kind: "badKey" }), { ...groq, onShowLog, onOpenSettings: vi.fn(), onRetry: vi.fn() }));
  expect(buttons()).toEqual(["Open Settings", "Retry", "Show log"]);
  screen.getByRole("button", { name: "Show log" }).click();
  expect(onShowLog).toHaveBeenCalled();
  unmount();
  render(answerState(ai({ kind: "badKey" }), groq));
  expect(screen.queryByRole("button", { name: "Show log" })).toBeNull();
});

test("length_card_has_continue", () => {
  const onContinue = vi.fn();
  render(answerEnd("length", { output: 4096, onContinue }));
  expect(buttons()).toEqual(["Continue"]);
  screen.getByRole("button", { name: "Continue" }).click();
  expect(onContinue).toHaveBeenCalledTimes(1);
});

test("answer_states", () => {
  const onRetry = vi.fn();
  const r1 = render(answerEnd("dropped", { sqlMissing: true, onRetry }));
  text("The connection dropped mid answer.");
  text("The part above is kept and marked. The SQL never arrived, so there is nothing to insert.");
  expect(buttons()).toEqual(["Retry the answer"]);
  r1.unmount();
  const r2 = render(answerEnd("dropped", { sqlMissing: false }));
  text("The part above is kept and marked.");
  expect(buttons()).toEqual([]);
  r2.unmount();
  const r3 = render(answerEnd("length", { output: 4096 }));
  text("The answer reached its length limit.");
  text("It stopped at 4,096 output tokens.");
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  r3.unmount();
  const r4 = render(answerEnd("refusal", { onEdit: vi.fn() }));
  text("The model declined to answer this.");
  text("Rephrase the question, or ask about the schema instead of the data.");
  expect(buttons()).toEqual(["Edit the question"]);
  r4.unmount();
  render(answerEnd("stopped", { millis: 800, onRetry }));
  text("Stopped.");
  text("You stopped the answer after 0.8s. The part above is kept.");
  expect(buttons()).toEqual(["Retry"]);
});

test("wait_text_is_compact", () => {
  expect(waitText(38)).toBe("38s");
  expect(waitText(60)).toBe("1m");
  expect(waitText(700)).toBe("12m");
  expect(waitText(3600)).toBe("1h");
  expect(waitText(5400)).toBe("2h");
});

test("rate_limit_with_a_zero_wait_counts_one_second", () => {
  vi.useFakeTimers();
  const onRetry = vi.fn();
  const { container } = render(answerState(ai({ kind: "rateLimited", retryAfterSecs: 0 }), { ...groq, onRetry }));
  expect((container.querySelector(".errc-fill") as HTMLElement).style.width).toBe("100%");
  text("1s");
  act(() => vi.advanceTimersByTime(1000));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect((container.querySelector(".errc-fill") as HTMLElement).style.width).toBe("0%");
});

test("rate_limit_counts_minutes_in_compact_units", () => {
  render(answerState(ai({ kind: "rateLimited", retryAfterSecs: 300 }), { ...groq, onRetry: vi.fn() }));
  text("Retrying in 5m. Contura retries on its own when the wait is over. Nothing was answered yet.");
});

test("a_long_rate_limit_wait_is_not_retried_on_its_own", () => {
  vi.useFakeTimers();
  const onRetry = vi.fn();
  const { container } = render(answerState(ai({ kind: "rateLimited", retryAfterSecs: 3600 }), { ...groq, onRetry }));
  text("Groq asks to wait 1h. Retry when the wait is over. Nothing was answered yet.");
  expect(container.querySelector(".errc-count")).toBeNull();
  act(() => vi.advanceTimersByTime(3_700_000));
  expect(onRetry).not.toHaveBeenCalled();
  expect(buttons()).toEqual(["Retry"]);
  screen.getByRole("button", { name: "Retry" }).click();
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("send_the_saved_key_is_disabled_while_it_runs", () => {
  render(answerState(ai({ kind: "keyHostChanged", host: "api.example.com" }), { ...groq, onConfirmKeyHost: vi.fn(), confirmingKeyHost: true }));
  expect((screen.getByRole("button", { name: "Send the saved key to api.example.com" }) as HTMLButtonElement).disabled).toBe(true);
});

test("insecure_url_card_opens_settings", () => {
  render(answerState(ai({ kind: "insecureUrl", host: "api.example.com" }), { ...groq, onOpenSettings: vi.fn(), onRetry: vi.fn() }));
  expect(buttons()).toEqual(["Open Settings"]);
});

test("model_to_use_falls_back_to_the_saved_picks_or_defaults", () => {
  expect(modelToUse("openai/gpt-oss-120b", models, null)).toEqual({ id: "openai/gpt-oss-120b", picks: models[1].picks });
  const settings = {
    defaultThinking: "low",
    promptCaching: false,
    modelPrefs: { "saved/model": { thinking: "high", caching: true } },
  } as unknown as AiSettings;
  expect(modelToUse("saved/model", [], settings)).toEqual({ id: "saved/model", picks: { thinking: "high", caching: true } });
  expect(modelToUse("other/model", [], settings)).toEqual({ id: "other/model", picks: { thinking: "low", caching: false } });
});

test("error_card_after_sample_read", () => {
  const read = { ...groq, host: "api.groq.com", onRetry: vi.fn() };
  render(answerState(ai({ kind: "timeout", phase: "idle" }), { ...read, rowsRead: 2 }));
  text("The request left this computer but nothing came back. Contura read sample rows from 2 tables, read only. Nothing else ran on Shop.");
});

test("error_card_after_one_table_read", () => {
  render(answerState(ai({ kind: "timeout", phase: "idle" }), { ...groq, rowsRead: 1 }));
  text("The request left this computer but nothing came back. Contura read sample rows from 1 table, read only. Nothing else ran on Shop.");
});

test("error_card_without_rows_keeps_today", () => {
  render(answerState(ai({ kind: "timeout", phase: "idle" }), { ...groq, rowsRead: null }));
  text("The request left this computer but nothing came back. Nothing ran on Shop.");
});

test("tool_rejected_and_bad_input_texts", () => {
  const onRetry = vi.fn();
  render(answerState(ai({ kind: "toolRejected", name: "run_sql" }), { ...groq, onRetry }));
  text("The assistant asked for a tool Contura does not offer. Nothing was changed.");
  expect(buttons()).toEqual(["Retry"]);
  act(() => card().querySelector("button")!.click());
  expect(onRetry).toHaveBeenCalledTimes(1);
  document.body.innerHTML = "";
  render(answerState(ai({ kind: "badToolInput" }), { ...groq, onRetry }));
  text("The assistant's changes could not be read. Nothing was changed.");
  expect(buttons()).toEqual(["Retry"]);
});

test("bad_file_name_has_no_retry", () => {
  document.body.innerHTML = "";
  expect(aiErrorOf(ai({ kind: "badFileName" }))).toEqual({ kind: "badFileName" });
  render(answerState(ai({ kind: "badFileName" }), { ...groq, onRetry: vi.fn() }));
  text("This diagram's file name holds a character the assistant cannot send. Rename the file and ask again.");
  expect(buttons()).toEqual([]);
});

test("attachment_gone_says_attach_again", () => {
  document.body.innerHTML = "";
  expect(aiErrorOf(ai({ kind: "attachmentGone" }))).toEqual({ kind: "attachmentGone" });
  render(answerState(ai({ kind: "attachmentGone" }), { ...groq, onRetry: vi.fn() }));
  text("The attached file is no longer held. Attach it again.");
  expect(buttons()).toEqual([]);
});

test("diagram_held_shows_the_cores_sentence", () => {
  document.body.innerHTML = "";
  const message = 'The node "Orders" links to table shop.orders of prod, whose AI access is Never, so this Ask was not sent. Remove the link or change that Connection\'s AI access.';
  expect(aiErrorOf(ai({ kind: "diagramHeld", message }))).toEqual({ kind: "diagramHeld", message });
  render(answerState(ai({ kind: "diagramHeld", message }), { ...groq, onRetry: vi.fn() }));
  text(message);
  expect(screen.getByText("AI access")).toBeTruthy();
  // Asking again sends the same board: no Retry until the frame or the access changes.
  expect(buttons()).toEqual([]);
});

test("file_changed_card_texts", () => {
  document.body.innerHTML = "";
  render(answerState(ai({ kind: "fileChanged", file: "fulfilment", line: 9, nowReads: "Pack order" }), groq));
  text("fulfilment changed on disk while I worked");
  text("Another program changed the file after you asked (line 9 now reads Pack order, a git pull perhaps). These changes were made against the old text, so none of them were applied.");
  document.body.innerHTML = "";
  render(answerState(ai({ kind: "fileChanged", file: "fulfilment", line: null, nowReads: null }), groq));
  text("Another program changed the file after you asked. These changes were made against the old text, so none of them were applied.");
});

// ---- Parity with board 11.6 ----

const kicker = () => card().querySelector(".errc-kick")?.textContent;

test("parity_P11_24_stop_ends_the_countdown_and_leaves_retry_to_the_user", () => {
  vi.useFakeTimers();
  const onRetry = vi.fn();
  render(answerState(ai({ kind: "rateLimited", retryAfterSecs: 20 }), { ...groq, onRetry }));
  text("Retrying in 20s. Contura retries on its own when the wait is over. Nothing was answered yet.");
  act(() => screen.getByRole("button", { name: "Stop" }).click());
  text("Groq asks to wait 20s. Retry when the wait is over. Nothing was answered yet.");
  expect(document.querySelector(".errc-count")).toBeNull();
  expect(buttons()).toEqual(["Retry"]);
  act(() => vi.advanceTimersByTime(30_000));
  expect(onRetry).not.toHaveBeenCalled();
});

test("parity_P11_24_a_second_rate_limit_does_not_retry_on_its_own", () => {
  vi.useFakeTimers();
  const onRetry = vi.fn();
  render(answerState(ai({ kind: "rateLimited", retryAfterSecs: 20 }), { ...groq, onRetry, tries: 2 }));
  text("Groq asks to wait 20s. Retry when the wait is over. Nothing was answered yet.");
  expect(document.querySelector(".errc-count")).toBeNull();
  act(() => vi.advanceTimersByTime(30_000));
  expect(onRetry).not.toHaveBeenCalled();
  expect(buttons()).toEqual(["Retry"]);
});

test("parity_P11_25_a_keyless_provider_is_asked_for_a_key", () => {
  const onOpenSettings = vi.fn();
  render(answerState(ai({ kind: "badKey" }), { providerName: "Custom", provider: "custom", keySaved: false, onOpenSettings, onRetry: vi.fn() }));
  expect(kicker()).toBe("Key refused");
  // The ruling's sentence, as the card's title and body.
  expect(`${card().querySelector(".errc-title")?.textContent} ${card().querySelector(".errc-body")?.textContent}`).toBe(
    "The provider refused the request: it may need an API key. Add one in AI settings.",
  );
  expect(card().textContent).not.toMatch(/Credential Manager|revoked/);
  expect(buttons()[0]).toBe("Open Settings");
  screen.getByRole("button", { name: "Open Settings" }).click();
  expect(onOpenSettings).toHaveBeenCalled();
});

test("parity_P11_25_bad_key_names_the_windows_keyring_on_windows", () => {
  try {
    setPlatformForTests("windows");
    render(answerState(ai({ kind: "badKey" }), { ...groq, keySaved: true, onOpenSettings: vi.fn() }));
    text("The key in the OS keyring (Windows Credential Manager) was revoked or mistyped. Fix it in Settings, then retry.");
  } finally {
    setPlatformForTests(null);
  }
});

test("parity_P11_26_a_500_has_the_provider_error_shape", () => {
  const onRetry = vi.fn();
  render(answerState(ai({ kind: "provider", status: 500, message: "Internal error" }), { providerName: "Custom", onRetry, onShowLog: vi.fn() }));
  expect(kicker()).toBe("Provider error");
  expect(card().querySelector(".errc-title")?.textContent).toBe("Custom returned an error.");
  expect(card().querySelector(".errc-body")?.textContent).toBe("It answered with status 500: Internal error.");
  expect(buttons()).toEqual(["Retry", "Show log"]);
});

test("parity_P11_27_every_error_card_has_a_kicker", () => {
  const cases: [AiError, string][] = [
    [{ kind: "rateLimited", retryAfterSecs: 20 }, "Rate limited"],
    [{ kind: "overloaded", provider: "groq" }, "Provider busy"],
    [{ kind: "timeout", phase: "first byte" }, "No reply"],
    [{ kind: "offline" }, "No internet"],
    [{ kind: "badKey" }, "Key refused"],
    [{ kind: "outOfCredit", provider: "groq" }, "Out of credit"],
    [{ kind: "modelRetired", model: "fx-404" }, "Model retired"],
    [{ kind: "tooBig", needed: 300_000, window: 131_072, model: "openai/gpt-oss-20b" }, "Too big for the window"],
    [{ kind: "contextFull", used: 120_000, window: 131_072, model: "openai/gpt-oss-20b", messages: 4 }, "Thread fills the window"],
    [{ kind: "provider", status: 500, message: "Internal error" }, "Provider error"],
    [{ kind: "network", host: "api.groq.com" }, "No connection"],
    [{ kind: "badResponse" }, "Provider error"],
    [{ kind: "cancelled" }, "Stopped by you"],
    [{ kind: "urlHasCredentials", host: "x.example" }, "Base URL problem"],
  ];
  for (const [error, label] of cases) {
    const { unmount } = render(answerState(ai(error), { ...groq, onRetry: vi.fn() }));
    expect({ kind: error.kind, label: kicker() }).toEqual({ kind: error.kind, label });
    unmount();
  }
  const ends: [Parameters<typeof answerEnd>[0], string][] = [
    ["dropped", "Cut off mid answer"],
    ["length", "Output limit"],
    ["refusal", "Model declined"],
    ["stopped", "Stopped by you"],
  ];
  for (const [kind, label] of ends) {
    const { unmount } = render(answerEnd(kind, {}));
    expect({ kind, label: kicker() }).toEqual({ kind, label });
    unmount();
  }
});

test("parity_P11_28_length_card_names_the_output_tokens", () => {
  const { unmount } = render(answerEnd("length", { output: 4096, onContinue: vi.fn() }));
  text("It stopped at 4,096 output tokens. Continue asks the model to carry on from the last word.");
  expect(buttons()).toEqual(["Continue"]);
  unmount();
  render(answerEnd("length", {}));
  text("It stopped at the model's output limit.");
});

test("parity_P11_38_timeout_and_offline_cards_name_the_machine_for_the_platform", () => {
  const timeout = () => render(answerState(ai({ kind: "timeout", phase: "first byte" }), { ...groq, host: "api.groq.com", onRetry: vi.fn() }));
  const offline = () => render(answerState(ai({ kind: "offline" }), { ...groq, onSendNow: vi.fn(), onCancelQueued: vi.fn() }));
  try {
    setPlatformForTests("linux");
    let r = timeout();
    text("The request left this computer but nothing came back. Nothing ran on Shop.");
    r.unmount();
    r = offline();
    text("Your question is kept and goes out as soon as this computer is back online.");
    r.unmount();
    setPlatformForTests("windows");
    r = timeout();
    text("The request left this PC but nothing came back. Nothing ran on Shop.");
    r.unmount();
    offline();
    text("Your question is kept and goes out as soon as this PC is back online.");
  } finally {
    setPlatformForTests(null);
  }
});

test("setup_names_the_keyring_when_it_is_used", async () => {
  routeInvoke({ secret_store_kind: () => "keyring" });
  render(answerState(ai({ kind: "notConfigured" })));
  await act(async () => {});
  expect(screen.getByText(/The key is kept in the OS keyring \(the Secret Service\)\./)).toBeTruthy();
});

test("setup_says_the_key_is_kept_for_the_session_without_a_keyring", async () => {
  routeInvoke({ secret_store_kind: () => "missing" });
  render(answerState(ai({ kind: "notConfigured" })));
  expect(await screen.findByText(/Without a keyring service the key is kept only until Contura closes\./)).toBeTruthy();
  expect(screen.queryByText(/The key is kept in the OS keyring/)).toBeNull();
});
