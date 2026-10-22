import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { ModelInfo } from "../api/types";
import { modelInfo, modelList } from "../test/settingsRoutes";
import ContextMeter, { formatTokens } from "./ContextMeter";
import ModelPicker from "./ModelPicker";
import appCss from "../styles/app.css?raw";

const sonnet = modelInfo({
  id: "claude-sonnet-5-5",
  name: "Claude Sonnet 5.5",
  contextWindow: 1_000_000,
  thinking: "anthropicEffort",
  thinkingOff: "disabled",
  caching: "breakpoints",
  tier: "mid",
  picks: { thinking: "medium", caching: true },
});
const opus = modelInfo({
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  thinking: "anthropicEffort",
  thinkingOff: "notAllowed",
  caching: "breakpoints",
  tier: "largest",
  picks: { thinking: "high", caching: false },
});
const haiku = modelInfo({
  id: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  contextWindow: 200_000,
  thinking: "anthropicBudget",
  thinkingOff: "omit",
  caching: "breakpoints",
  tier: "fastest",
  picks: { thinking: "off", caching: true },
});
const llama = modelInfo({
  id: "llama-3.3-70b-versatile",
  name: "llama-3.3-70b-versatile",
  contextWindow: 131_072,
  thinking: "none",
  thinkingOff: "omit",
  caching: "none",
  tier: null,
  picks: { thinking: "off", caching: false },
});

function open(models: ModelInfo[], current = models[0].id, providerName = "Anthropic") {
  const onPick = vi.fn();
  render(
    <ModelPicker
      list={modelList(models, null, current)}
      onPick={onPick}
      providerName={providerName}
      used={18_412}
      parts={[
        { label: "schema", tokens: 9_140 },
        { label: "current statement", tokens: 2_442 },
      ]}
      exact={false}
    />,
  );
  return { onPick, user: userEvent.setup() };
}

async function menu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Model:/ }));
  return screen.getByRole("dialog", { name: "Model" });
}

test("picker_lists_models_with_windows", async () => {
  const { user, onPick } = open([sonnet, opus, haiku]);
  const pill = screen.getByRole("button", { name: /^Model:/ });
  expect(pill.textContent).toContain("Sonnet 5.5");
  expect(pill.textContent).toContain("Medium");
  expect(pill.querySelector('[data-icon="bolt"]')).toBeTruthy();
  const box = await menu(user);
  expect(within(box).getByText("Anthropic model")).toBeTruthy();
  expect(within(box).getByText("Context window")).toBeTruthy();
  const rows = within(box).getAllByRole("option");
  expect(rows.map((r) => r.textContent)).toEqual([
    "Claude Sonnet 5.5" + "Balanced" + "1M",
    "Claude Opus 5.5" + "Most capable, slowest" + "1M",
    "Claude Haiku 5.5" + "Fastest, for short questions" + "200K",
  ]);
  expect(rows[0].getAttribute("aria-selected")).toBe("true");
  expect(rows[0].querySelector('[data-icon="check"]')).toBeTruthy();
  expect(rows[1].querySelector('[data-icon="check"]')).toBeNull();
  expect(within(box).getByText("18.4K of 1M")).toBeTruthy();
  expect(within(box).getByText("In use now: schema 9.1K, current statement 2.4K.")).toBeTruthy();

  await user.click(rows[2]);
  expect(onPick).toHaveBeenCalledWith("claude-haiku-5-5", { thinking: "off", caching: true });
  expect(screen.queryByRole("dialog", { name: "Model" })).toBeNull();
});

test("thinking_hidden_without_support", async () => {
  const { user } = open([llama], llama.id, "Groq");
  const pill = screen.getByRole("button", { name: /^Model:/ });
  expect(pill.textContent).not.toContain("Off");
  expect(pill.querySelector('[data-icon="bolt"]')).toBeNull();
  const box = await menu(user);
  expect(within(box).getByText("Groq model")).toBeTruthy();
  expect(within(box).queryByText("Thinking")).toBeNull();
  expect(within(box).queryByRole("radiogroup")).toBeNull();
});

test("off_hidden_when_not_allowed", async () => {
  const { user, onPick } = open([opus, sonnet]);
  const box = await menu(user);
  const levels = within(box).getByRole("radiogroup", { name: "Thinking level" });
  expect(within(levels).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Low", "Medium", "High"]);
  expect(within(box).getByText("for Opus 5.5")).toBeTruthy();
  expect(within(levels).getByRole("radio", { name: "High" }).getAttribute("aria-checked")).toBe("true");
  await user.click(within(levels).getByRole("radio", { name: "Low" }));
  expect(onPick).toHaveBeenCalledWith("claude-opus-5-5", { thinking: "low", caching: false });
});

test("caching_switch_only_for_breakpoints", async () => {
  const automatic = modelInfo();
  const first = open([sonnet]);
  let box = await menu(first.user);
  const sw = within(box).getByRole("switch", { name: "Prompt caching" });
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(within(box).getByText("Keeps the schema warm between questions, so follow-ups cost less and start faster.")).toBeTruthy();
  await first.user.click(sw);
  expect(first.onPick).toHaveBeenCalledWith("claude-sonnet-5-5", { thinking: "medium", caching: false });
  document.body.innerHTML = "";

  const second = open([automatic], automatic.id, "Groq");
  box = await menu(second.user);
  expect(within(box).queryByRole("switch", { name: "Prompt caching" })).toBeNull();
});

test("thinking_note_texts", async () => {
  const first = open([haiku]);
  let box = await menu(first.user);
  expect(within(box).getByText("Answers start at once. Best for short questions.")).toBeTruthy();
  const pill = screen.getByRole("button", { name: /^Model:/ });
  expect(pill.querySelector(".mpill-think.off")?.textContent).toBe("Off");
  document.body.innerHTML = "";

  const second = open([sonnet]);
  box = await menu(second.user);
  expect(within(box).getByText("Higher levels think longer and cost more. Remembered for Sonnet 5.5.")).toBeTruthy();
});

test("meter_colors_at_75_and_90", () => {
  const fill = (used: number) => {
    const { container, unmount } = render(<ContextMeter used={used} window={1_000_000} parts={[]} exact />);
    const cls = container.querySelector(".meter-fill")?.className ?? "";
    unmount();
    return cls;
  };
  expect(fill(740_000)).toBe("meter-fill");
  expect(fill(750_000)).toBe("meter-fill warn");
  expect(fill(899_000)).toBe("meter-fill warn");
  expect(fill(900_000)).toBe("meter-fill bad");

  render(<ContextMeter used={18_412} window={1_000_000} parts={[]} exact />);
  expect(screen.getByText("Context")).toBeTruthy();
  expect(screen.getByText("18.4K / 1M")).toBeTruthy();
  expect(screen.getByTitle("18,412 of 1,000,000 tokens in use")).toBeTruthy();
  expect(screen.getByRole("meter", { name: "Context window in use" }).getAttribute("aria-valuenow")).toBe("1.8");
});

test("format_tokens_is_compact", () => {
  expect(formatTokens(412)).toBe("412");
  expect(formatTokens(18_412)).toBe("18.4K");
  expect(formatTokens(9_000)).toBe("9K");
  expect(formatTokens(131_072)).toBe("131.1K");
  expect(formatTokens(999_960)).toBe("1M");
  expect(formatTokens(1_250_000)).toBe("1.3M");
});

/** The body of the app.css rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const text = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = text.indexOf(`\n${selector} {`);
  if (at < 0) return "";
  const open = text.indexOf("{", at);
  return text.slice(open + 1, text.indexOf("}", open));
}

test("pill_shrinks_and_ellipsizes_a_long_name", () => {
  const scout = modelInfo({ id: "meta-llama/llama-4-scout-17b-16e-instruct", name: "meta-llama/llama-4-scout-17b-16e-instruct" });
  render(<ModelPicker list={modelList([scout], null, scout.id)} onPick={vi.fn()} />);
  const pill = screen.getByRole("button", { name: "Model: meta-llama/llama-4-scout-17b-16e-instruct" });
  expect(pill.getAttribute("title")).toBe("Model: meta-llama/llama-4-scout-17b-16e-instruct");
  expect(pill.querySelector(".mpill-name")?.textContent).toBe("meta-llama/llama-4-scout-17b-16e-instruct");
  expect(pill.closest(".mpick")).toBeTruthy();
  const mpick = ruleBody(".mpick");
  expect(mpick).toMatch(/flex:\s*0 1 auto/);
  expect(mpick).toMatch(/min-width:\s*0/);
  expect(mpick).toMatch(/max-width:\s*200px/);
  const mpill = ruleBody(".mpill");
  expect(mpill).toMatch(/min-width:\s*0/);
  expect(mpill).toMatch(/max-width:\s*100%/);
  const name = ruleBody(".mpill-name");
  expect(name).toMatch(/overflow:\s*hidden/);
  expect(name).toMatch(/text-overflow:\s*ellipsis/);
  expect(name).toMatch(/min-width:\s*0/);
});

test("menu_scrolls_when_tall", () => {
  const menu = ruleBody(".mmenu");
  expect(menu).toMatch(/max-height:\s*min\(70vh, 560px\)/);
  expect(menu).toMatch(/overflow-y:\s*auto/);
  expect(ruleBody(".mrow")).toMatch(/min-height:\s*44px/);
});

test("rows_carry_a_note_from_the_tier", async () => {
  const user = userEvent.setup();
  open([sonnet, opus, haiku, llama]);
  await user.click(screen.getByRole("button", { name: /^Model:/ }));
  const box = screen.getByRole("dialog", { name: "Model" });
  expect(within(box).getByRole("option", { name: /Claude Sonnet 5\.5/ }).textContent).toContain("Balanced");
  expect(within(box).getByRole("option", { name: /Claude Opus 5\.5/ }).textContent).toContain("Most capable, slowest");
  expect(within(box).getByRole("option", { name: /Claude Haiku 5\.5/ }).textContent).toContain("Fastest, for short questions");
  expect(within(box).getByRole("option", { name: /llama-3\.3-70b-versatile/ }).querySelector(".mrow-note")).toBeNull();
});

test("meter_tone_uses_the_unrounded_share", () => {
  const fill = (used: number) => {
    const { container, unmount } = render(<ContextMeter used={used} window={1_000_000} parts={[]} exact />);
    const cls = container.querySelector(".meter-fill")?.className ?? "";
    unmount();
    return cls;
  };
  // 74.96% shows as 75.0 but is not amber yet; 89.96% is amber, not red.
  expect(fill(749_600)).toBe("meter-fill");
  expect(fill(899_600)).toBe("meter-fill warn");
});
