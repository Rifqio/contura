import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { AnswerRecord, LogLine, ProcessStep, SqlBlock } from "../api/types";
import { sentRecord } from "../test/aiStream";
import AnswerLog from "./AnswerLog";
import { setPlatformForTests } from "../platform";

const LOG: LogLine[] = [
  { atMs: 0, level: "info", source: "question", fields: [["chars", "62"]] },
  { atMs: 2, level: "info", source: "access", fields: [["level", "schemaQuery"], ["rows", "blocked"]] },
  { atMs: 9, level: "info", source: "tables", fields: [["picked", "2"], ["of", "6"]] },
  { atMs: 214, level: "info", source: "request", fields: [["provider", "groq"], ["bytes", "2314"], ["cache", "false"]] },
  { atMs: 900, level: "warn", source: "retry", fields: [["status", "429"], ["wait", "1s"]] },
  { atMs: 1102, level: "debug", source: "thinking", fields: [["chars", "412"]] },
  { atMs: 1806, level: "error", source: "http", fields: [["kind", "rateLimited"], ["status", "429"]] },
  { atMs: 1912, level: "info", source: "database", fields: [["ran", "nothing"]] },
];

const STEPS: ProcessStep[] = [
  {
    step: "access",
    atMs: 2,
    value: "schema, query text",
    rule: "Read from the saved Connection: AI access is Schema and query text.",
    evidence: [
      ["schema", "allowed", "AI access level"],
      ["sample rows", "blocked", "AI access level"],
    ],
    byModel: false,
  },
  { step: "schema", atMs: 6, value: "read, 6 tables", rule: "Read from the catalog.", evidence: [], byModel: false },
  {
    step: "tables",
    atMs: 9,
    value: "2 of 6 picked",
    rule: "Named in the question, open in a tab, or one key away.",
    evidence: [
      ["invoices", "name match", "full card"],
      ["customers", "name match", "full card"],
      ["payments", "left out", "not sent"],
      ["plans", "left out", "not sent"],
    ],
    byModel: false,
    leftOut: 2,
  },
  { step: "cleaning", atMs: 11, value: "1 value masked", rule: "Values are masked.", evidence: [["line 7", "date literal", "'[date]'"]], byModel: false },
  { step: "request", atMs: 214, value: "2,314 B, no tools", rule: "Sent over https to api.groq.com.", evidence: [], byModel: false },
  { step: "thinking", atMs: 1102, value: "412 chars, by the model", rule: "Shared by the provider, as written.", evidence: [], byModel: true },
  { step: "answer", atMs: 1806, value: "1 SQL block, by the model", rule: "214 characters, 486 output tokens.", evidence: [], byModel: true },
  { step: "sqlCheck", atMs: 1900, value: "1 read, 0 writes, no flags", rule: "Each statement split and classified.", evidence: [], byModel: false },
];

const RECORD: AnswerRecord = {
  sent: sentRecord(),
  usage: { input: 500, output: 486, cacheRead: 0, cacheWrite: 0 },
  millis: 1900,
  stop: "end",
  mark: null,
  error: null,
  sqlBlocks: [],
  notes: [],
  thinking: "The user wants invoices joined to customers.",
  log: LOG,
  steps: STEPS,
  actions: [],
  context: null,
  commandError: null,
};

function renderLog(over: Partial<AnswerRecord> = {}, props: Partial<React.ComponentProps<typeof AnswerLog>> = {}) {
  const onBack = vi.fn();
  render(
    <AnswerLog
      question="Who were our 8 biggest customers?"
      answer="Here it is."
      record={{ ...RECORD, ...over }}
      connection="Shop"
      providerName="Groq"
      onBack={onBack}
      {...props}
    />,
  );
  return { onBack };
}

const rows = () => Array.from(document.querySelectorAll(".lrow"));

test("opens_on_log_tab", async () => {
  const user = userEvent.setup();
  const { onBack } = renderLog();
  expect(screen.getByText("Answer log")).toBeTruthy();
  expect(document.querySelector(".alog-time")!.textContent).toBe("1.9s");
  expect(screen.getByText("For: Who were our 8 biggest customers?")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Log" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tab", { name: "Steps" }).getAttribute("aria-selected")).toBe("false");
  expect(screen.getByRole("log", { name: "Answer log" })).toBeTruthy();
  expect(rows()).toHaveLength(8);
  expect(rows()[3].textContent).toBe("00.214INFOrequestprovider=groq bytes=2314 cache=false");
  // One mark per line in the volume strip, coloured by level.
  expect(document.querySelectorAll(".lvol .vb")).toHaveLength(8);
  expect(document.querySelectorAll(".lvol .vb.error")).toHaveLength(1);
  expect(screen.getByText("8 of 8 lines · 1 error · click a line for its fields")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Back to the answer" }));
  expect(onBack).toHaveBeenCalled();
});

test("level_chips_count_debug_as_info", async () => {
  const user = userEvent.setup();
  renderLog();
  const chip = (name: RegExp) => screen.getByRole("button", { name });
  expect(chip(/^All 8$/)).toBeTruthy();
  expect(chip(/^Info 6$/)).toBeTruthy();
  expect(chip(/^Warn 1$/)).toBeTruthy();
  expect(chip(/^Error 1$/)).toBeTruthy();
  await user.click(chip(/^Info 6$/));
  expect(rows()).toHaveLength(6);
  expect(screen.getByText("6 of 8 lines · 1 error · click a line for its fields")).toBeTruthy();
  await user.click(chip(/^Warn 1$/));
  expect(rows().map((r) => r.classList.contains("warn"))).toEqual([true]);
});

test("empty_level_says_so", async () => {
  const user = userEvent.setup();
  renderLog({ log: LOG.filter((l) => l.level !== "error") });
  await user.click(screen.getByRole("button", { name: /^Error 0$/ }));
  expect(screen.getByText("No lines at this level.")).toBeTruthy();
});

test("search_filters_rows", async () => {
  const user = userEvent.setup();
  renderLog();
  const box = screen.getByRole("textbox", { name: "Search the log" });
  expect(box.getAttribute("placeholder")).toBe("Search the log, for example status=429");
  await user.type(box, "status=429");
  expect(rows().map((r) => r.querySelector(".ls")!.textContent)).toEqual(["retry", "http"]);
  await user.clear(box);
  await user.type(box, "datab");
  expect(rows().map((r) => r.querySelector(".ls")!.textContent)).toEqual(["database"]);
});

test("first_error_open", async () => {
  const user = userEvent.setup();
  renderLog();
  const error = rows()[6];
  expect(error.classList.contains("error")).toBe(true);
  expect(error.getAttribute("aria-expanded")).toBe("true");
  const json = document.querySelectorAll(".ljson");
  expect(json).toHaveLength(1);
  expect(json[0].textContent).toBe('"kind": "rateLimited""status": 429');
  // Other rows open on a click; numbers and booleans are not quoted.
  await user.click(rows()[3]);
  expect(rows()[3].getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelectorAll(".ljson")[0].textContent).toBe('"provider": "groq""bytes": 2314"cache": false');
});

test("wrap_toggle", async () => {
  const user = userEvent.setup();
  renderLog();
  await user.click(screen.getByRole("button", { name: "Wrap long lines" }));
  expect(screen.getByRole("log", { name: "Answer log" }).classList.contains("wrap")).toBe(true);
  expect(screen.getByRole("button", { name: "Do not wrap long lines" }).getAttribute("aria-pressed")).toBe("true");
});

test("copy_record_is_plain_lines", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  renderLog();
  await user.click(screen.getByRole("button", { name: "Copy record" }));
  const text = writeText.mock.calls[0][0] as string;
  expect(text.split("\n")).toHaveLength(8);
  expect(text.split("\n")[6]).toBe("01.806 ERROR http kind=rateLimited status=429");
  await user.click(screen.getByRole("button", { name: "Copy the log" }));
  expect(writeText.mock.calls[1][0]).toBe(text);
});

test("steps_cells_and_rows", async () => {
  const user = userEvent.setup();
  renderLog();
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  const cells = Array.from(document.querySelectorAll(".cell3")).map((c) => c.textContent);
  expect(cells).toEqual(["Sent2,314 Bapi.groq.com", "Not sentRows, values2 tables, the key", "Ran on ShopNothingNo tools offered"]);
  const prows = Array.from(document.querySelectorAll(".prow"));
  expect(prows.map((r) => r.querySelector(".lb")!.textContent)).toEqual([
    "Access",
    "Schema",
    "Tables",
    "Cleaning",
    "Request",
    "Thinking",
    "Answer",
    "SQL check",
  ]);
  expect(prows.map((r) => r.querySelector(".tm")!.textContent)).toEqual(["2ms", "6ms", "9ms", "11ms", "0.2s", "1.1s", "1.8s", "1.9s"]);
  expect(prows[5].querySelector(".v")!.classList.contains("model")).toBe(true);
  expect(prows[6].querySelector(".v")!.classList.contains("model")).toBe(true);
  expect(prows[4].querySelector(".v")!.classList.contains("model")).toBe(false);
  expect(screen.getByText("Nothing ran on the database")).toBeTruthy();
});

test("evidence_table_opens", async () => {
  const user = userEvent.setup();
  renderLog();
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  const tables = screen.getByRole("button", { name: /^Tables/ });
  expect(tables.getAttribute("aria-expanded")).toBe("false");
  await user.click(tables);
  expect(tables.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Named in the question, open in a tab, or one key away.")).toBeTruthy();
  const ev = document.querySelector(".ev")!;
  expect(Array.from(ev.querySelectorAll(".eh")).map((e) => e.textContent)).toEqual(["Table", "Rule", "Evidence"]);
  expect(ev.textContent).toContain("paymentsleft outnot sent");
  // The Thinking row opens the thinking as returned.
  await user.click(screen.getByRole("button", { name: /^Thinking/ }));
  expect(screen.getByText("The user wants invoices joined to customers.")).toBeTruthy();
});

test("diagram_zones_and_bytes", async () => {
  const user = userEvent.setup();
  renderLog();
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  const zones = Array.from(document.querySelectorAll(".zone .zt")).map((z) => z.textContent);
  expect(zones).toEqual(["On this computer", "Groq, openai/gpt-oss-20b", "Back on this computer"]);
  expect(screen.getByText("2,314 B leave your computer")).toBeTruthy();
  expect(screen.getByText("11 B back")).toBeTruthy();
  expect(screen.getByText("No tools: the model has no path to Shop.")).toBeTruthy();
  expect(screen.getByText("Tables, 2 of 6")).toBeTruthy();
  expect(screen.getByText("Not shared")).toBeTruthy();
  expect(screen.getAllByText("catalog only, no rows").length).toBeGreaterThan(0);
  // A box's details show under the diagram, and Open in Steps opens its row.
  await user.click(screen.getByRole("button", { name: /^Cleaning/ }));
  const details = screen.getByRole("region", { name: "Cleaning" });
  expect(within(details).getByText("Values are masked.")).toBeTruthy();
  await user.click(within(details).getByRole("button", { name: "Open in Steps" }));
  expect(screen.getByRole("tab", { name: "Steps" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: /^Cleaning/ }).getAttribute("aria-expanded")).toBe("true");
});

test("diagram_fills_from_the_top_while_live", async () => {
  const user = userEvent.setup();
  renderLog({ steps: STEPS.slice(0, 2), sent: null, millis: null }, { live: true });
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(document.querySelector(".dbox.pending")).toBeTruthy();
  expect(screen.queryByText(/leave your computer/)).toBeNull();
});

test("show_exactly_when_not_kept", async () => {
  const user = userEvent.setup();
  renderLog();
  await user.click(screen.getByRole("button", { name: "Show exactly what was sent" }));
  expect(screen.getByText("The exact text was not kept. Turn on Keep the exact text sent in AI settings.")).toBeTruthy();
});

test("show_exactly_when_kept", async () => {
  const user = userEvent.setup();
  renderLog({ sent: sentRecord({ exact: "Question:\nWho?" }) });
  await user.click(screen.getByRole("button", { name: "Show exactly what was sent" }));
  expect(screen.getByRole("region", { name: "Exactly what was sent" }).textContent).toContain("Question:\nWho?");
});

// ---- Final fix wave ----

test("a_search_with_no_match_says_so", async () => {
  const user = userEvent.setup();
  renderLog();
  await user.type(screen.getByRole("textbox", { name: "Search the log" }), "nothing-like-this");
  expect(screen.getByText("No lines match.")).toBeTruthy();
  expect(screen.queryByText("No lines at this level.")).toBeNull();
});

test("diagram_shows_what_you_did_with_the_sql", async () => {
  const user = userEvent.setup();
  renderLog({ actions: [{ kind: "insertedCommented", at: 5 }] });
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  const back = Array.from(document.querySelectorAll(".zone")).pop()!;
  expect(within(back as HTMLElement).getByText("You: Inserted commented out")).toBeTruthy();
});

test("diagram_says_nothing_left_when_the_connection_failed", async () => {
  const user = userEvent.setup();
  renderLog({ error: { kind: "offline" }, mark: "failed", stop: null, steps: STEPS.slice(0, 5) });
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(screen.queryByText(/leave your computer/)).toBeNull();
  expect(screen.getByText("Not sent, no connection")).toBeTruthy();
});

// ---- 11c ----

test("markup_in_a_field_stays_text", async () => {
  const user = userEvent.setup();
  const markup = '<img src=x onerror="alert(1)"><b>bold</b>';
  renderLog({ log: [{ atMs: 5, level: "info", source: "<i>src</i>", fields: [["<b>k</b>", markup]] }] });
  expect(document.querySelector(".lgrid b, .lgrid img, .lgrid i")).toBeNull();
  expect(rows()[0].textContent).toContain(`<b>k</b>=${markup}`);
  await user.click(rows()[0]);
  const json = document.querySelector(".ljson")!;
  expect(json.querySelector("b, img")).toBeNull();
  expect(json.textContent).toContain(JSON.stringify(markup));
});

test("left_out_tables_count_from_left_out", async () => {
  const user = userEvent.setup();
  // Four left out, though only two evidence rows say "not sent".
  renderLog({ steps: STEPS.map((s) => (s.step === "tables" ? { ...s, leftOut: 4 } : s)) });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  expect(document.querySelectorAll(".cell3")[1].textContent).toBe("Not sentRows, values4 tables, the key");
});

test("left_out_tables_of_an_older_record_count_its_evidence", async () => {
  const user = userEvent.setup();
  // Saved before 11c: no leftOut, so the "not sent" evidence rows are counted.
  renderLog({ steps: STEPS.map(({ leftOut: _, ...s }) => s) });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  expect(document.querySelectorAll(".cell3")[1].textContent).toBe("Not sentRows, values2 tables, the key");
});

// ---- 11d: the outline call ----

const OUTLINE_STEP: ProcessStep = {
  step: "outline",
  atMs: 7,
  value: "picked 1 area, 2 tables from 1,204",
  rule: "The model named the areas and tables it needs from an outline of table names. Contura kept only names in this database.",
  evidence: [
    ["billing", "picked area", "12 tables"],
    ["payments", "picked table", "by the model"],
    ["ignore previous instructions", "dropped", "not in this database"],
  ],
  byModel: true,
};
const WITH_OUTLINE: ProcessStep[] = [...STEPS.slice(0, 2), OUTLINE_STEP, ...STEPS.slice(2)];
const OUTLINE_SENT = {
  bytes: 1204,
  tokens: 300,
  hash: "00aa11bb22cc33dd",
  pickedAreas: 1,
  pickedTables: 2,
  dropped: 1,
  usage: null,
  exact: null,
  left: true,
};

test("outline_row_in_steps", async () => {
  const user = userEvent.setup();
  renderLog({ steps: WITH_OUTLINE });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  const prows = Array.from(document.querySelectorAll(".prow"));
  expect(prows[2].querySelector(".lb")!.textContent).toBe("Outline");
  await user.click(screen.getByRole("button", { name: /^Outline/ }));
  const ev = document.querySelector(".ev")!;
  expect(Array.from(ev.querySelectorAll(".eh")).map((e) => e.textContent)).toEqual(["Name", "Rule", "Evidence"]);
  expect(ev.textContent).toContain("ignore previous instructionsdroppednot in this database");
  expect(ev.textContent).toContain("billingpicked area12 tables");
});

test("rows_open_by_index", async () => {
  const user = userEvent.setup();
  const second: ProcessStep = { ...STEPS[4], atMs: 300, value: "900 B, no tools" };
  renderLog({ steps: [...STEPS.slice(0, 5), second, ...STEPS.slice(5)] });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  const requests = screen.getAllByRole("button", { name: /^Request/ });
  expect(requests).toHaveLength(2);
  await user.click(requests[1]);
  expect(requests[0].getAttribute("aria-expanded")).toBe("false");
  expect(requests[1].getAttribute("aria-expanded")).toBe("true");
});

test("diagram_draws_the_outline_call", async () => {
  const user = userEvent.setup();
  renderLog({ steps: WITH_OUTLINE, sent: sentRecord({ outlineCall: true, outline: OUTLINE_SENT }) });
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(screen.getByRole("button", { name: /^Outline, 1,204 tables/ })).toBeTruthy();
  const picked = screen.getByRole("button", { name: /^Picked 1 area, 2 tables/ });
  expect(picked.classList.contains("model")).toBe(true);
  expect(within(picked).getByText("model")).toBeTruthy();
  expect(screen.getByText("1,204 B leave your computer")).toBeTruthy();
  expect(screen.getByText("2,314 B leave your computer")).toBeTruthy();
  // Board 11.7: the outline call is its own crossing, zone to zone.
  const zones = Array.from(document.querySelectorAll(".zone"));
  expect(zones.map((z) => z.querySelector(".zt")!.textContent)).toEqual([
    "On this computer",
    "Groq, openai/gpt-oss-20b",
    "On this computer",
    "Groq, openai/gpt-oss-20b",
    "Back on this computer",
  ]);
  expect(within(zones[0] as HTMLElement).getByRole("button", { name: /^Outline, 1,204 tables/ })).toBeTruthy();
  expect(within(zones[1] as HTMLElement).getByRole("button", { name: /^Picked 1 area, 2 tables/ })).toBeTruthy();
  expect(within(zones[2] as HTMLElement).getByRole("button", { name: /^Tables, 2 of 6/ })).toBeTruthy();
  const crossings = Array.from(document.querySelectorAll(".dcross"));
  expect(crossings[0].textContent).toContain("1,204 B leave your computer");
  expect(crossings[0].textContent).toContain("outline call");
  expect(crossings[1].textContent).toContain("2,314 B leave your computer");
  await user.click(picked);
  const details = screen.getByRole("region", { name: "Outline" });
  await user.click(within(details).getByRole("button", { name: "Open in Steps" }));
  expect(screen.getByRole("tab", { name: "Steps" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: /^Outline/ }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: /^Tables/ }).getAttribute("aria-expanded")).toBe("false");
});

test("diagram_outline_pending_while_live", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <AnswerLog question="Q?" record={{ ...RECORD, steps: STEPS.slice(0, 2), sent: null, millis: null }} live onBack={() => {}} />,
  );
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  const pending = () => Array.from(document.querySelectorAll(".dbox.pending")).filter((b) => b.textContent === "Outline");
  expect(pending()).toHaveLength(1);
  rerender(<AnswerLog question="Q?" record={{ ...RECORD, steps: STEPS.slice(0, 3), sent: null, millis: null }} live onBack={() => {}} />);
  expect(pending()).toHaveLength(0);
});

// A connector sits between the Schema box and the box after it in one zone.
function linkedAfterSchema() {
  const schema = screen.getByRole("button", { name: /^Schema/ }).closest(".drow")!;
  const next = schema.nextElementSibling!;
  expect(next.classList.contains("vlink")).toBe(true);
  expect(next.nextElementSibling).toBeTruthy();
}

test("diagram_failed_outline_invents_no_pick", async () => {
  const user = userEvent.setup();
  const failed: ProcessStep = {
    ...OUTLINE_STEP,
    value: "could not pick, ranked instead",
    rule: "The outline step failed, so the tables were ranked by name and words.",
    evidence: [],
    byModel: false,
  };
  renderLog({ steps: [...STEPS.slice(0, 2), failed, ...STEPS.slice(2)] });
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(screen.getByRole("button", { name: /^Outline/ })).toBeTruthy();
  expect(screen.queryByText(/^Picked/)).toBeNull();
  expect(screen.queryByText("outline call")).toBeNull();
  linkedAfterSchema();
});

test("diagram_failed_outline_call_draws_the_failed_scene", async () => {
  const user = userEvent.setup();
  const failed: ProcessStep = {
    ...OUTLINE_STEP,
    value: "could not pick, ranked instead",
    rule: "The outline step failed, so the tables were ranked by name and words.",
    evidence: [],
    byModel: false,
  };
  const log: LogLine[] = [...LOG.slice(0, 2), { atMs: 8, level: "warn", source: "outline", fields: [["error", "rateLimited"]] }, ...LOG.slice(2)];
  renderLog({
    steps: [...STEPS.slice(0, 2), failed, ...STEPS.slice(2)],
    log,
    sent: sentRecord({ outlineCall: true, outline: { ...OUTLINE_SENT, pickedAreas: 0, pickedTables: 0, dropped: 0 } }),
  });
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  // Board 11.7, outline call failed: the bytes that left still cross, the provider box says it could not pick.
  const crossings = Array.from(document.querySelectorAll(".dcross"));
  expect(crossings[0].textContent).toContain("1,204 B leave your computer");
  expect(crossings[0].textContent).toContain("outline call");
  const box = screen.getByRole("button", { name: /^Could not pick/ });
  expect(within(box).getByText("Rate limited")).toBeTruthy();
  expect(box.classList.contains("bad")).toBe(true);
  expect(box.classList.contains("model")).toBe(false);
  expect(screen.queryByText(/^Picked/)).toBeNull();
  const zones = Array.from(document.querySelectorAll(".zone"));
  expect(zones.map((z) => z.querySelector(".zt")!.textContent)).toEqual([
    "On this computer",
    "Groq, openai/gpt-oss-20b",
    "On this computer",
    "Groq, openai/gpt-oss-20b",
    "Back on this computer",
  ]);
  expect(within(zones[1] as HTMLElement).getByRole("button", { name: /^Could not pick/ })).toBeTruthy();
  await user.click(box);
  expect(screen.getByRole("region", { name: "Outline" })).toBeTruthy();
});

test("diagram_when_only_the_outline_left", async () => {
  const user = userEvent.setup();
  // The answer request was too big to build: only the outline call went.
  renderLog({
    steps: WITH_OUTLINE.slice(0, 5),
    sent: sentRecord({ bytes: 0, tokens: 0, hash: "", kinds: ["outline"], outlineCall: true, outline: OUTLINE_SENT }),
    error: { kind: "tooBig", needed: 40000, window: 32000, model: "M" },
    mark: "failed",
    stop: null,
  });
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(screen.getByText("1,204 B leave your computer")).toBeTruthy();
  expect(screen.getAllByText(/leave your computer/)).toHaveLength(1);
  expect(screen.getByText("Not sent")).toBeTruthy();
});

test("diagram_without_outline_unchanged", async () => {
  const user = userEvent.setup();
  renderLog();
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(screen.queryByText(/^Outline/)).toBeNull();
  expect(screen.queryByText(/^Picked/)).toBeNull();
  expect(screen.getAllByText(/leave your computer/)).toHaveLength(1);
  linkedAfterSchema();
});

// ---- 11e: the summary or compaction call ----

const COMPACT_STEP: ProcessStep = {
  step: "compact",
  atMs: 12,
  value: "14 messages, 182K → 31K",
  rule: "The thread reached 85% of the model's window, so older messages became one summary written by the same model. Only text this thread already held was sent.",
  evidence: [["compact", "gpt-oss-20b", "900 B, 225 tokens"]],
  byModel: true,
};
const WITH_COMPACT: ProcessStep[] = [...STEPS.slice(0, 4), COMPACT_STEP, ...STEPS.slice(4)];
const SUMMARY_SENT = {
  kind: "compact" as const,
  topic: null,
  messages: 14,
  model: "openai/gpt-oss-20b",
  bytes: 900,
  tokens: 225,
  hash: "bb11cc22dd33ee44",
  millis: 700,
  usage: null,
  exact: null,
};

test("compact_row_in_steps", async () => {
  const user = userEvent.setup();
  renderLog({ steps: WITH_COMPACT });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  const prows = Array.from(document.querySelectorAll(".prow"));
  expect(prows[4].querySelector(".lb")!.textContent).toBe("Compact");
  expect(prows[4].textContent).toContain("14 messages, 182K → 31K");
  await user.click(screen.getByRole("button", { name: /^Compact/ }));
  expect(document.querySelector(".prule")!.textContent).toContain("older messages became one summary");
  expect(document.querySelector(".ev")!.textContent).toContain("compactgpt-oss-20b900 B, 225 tokens");
});

test("diagram_second_crossing_for_a_summary_call", async () => {
  const user = userEvent.setup();
  renderLog({ steps: WITH_COMPACT, sent: sentRecord({ summaryCall: true, summary: SUMMARY_SENT }) });
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  const zones = Array.from(document.querySelectorAll(".zone"));
  expect(zones.map((z) => z.querySelector(".zt")!.textContent)).toEqual([
    "On this computer",
    "Groq, openai/gpt-oss-20b",
    "On this computer",
    "Groq, openai/gpt-oss-20b",
    "Back on this computer",
  ]);
  const crossings = Array.from(document.querySelectorAll(".dcross"));
  expect(crossings[0].textContent).toContain("900 B leave your computer");
  expect(crossings[0].textContent).toContain("compaction call");
  expect(crossings[1].textContent).toContain("2,314 B leave your computer");
  const summary = within(zones[1] as HTMLElement).getByRole("button", { name: /^Compaction, 14 messages/ });
  expect(summary.classList.contains("model")).toBe(true);
  expect(within(zones[2] as HTMLElement).getByRole("button", { name: /^Compact, 14 messages/ })).toBeTruthy();
  await user.click(summary);
  const details = screen.getByRole("region", { name: "Compact" });
  await user.click(within(details).getByRole("button", { name: "Open in Steps" }));
  expect(screen.getByRole("button", { name: /^Compact/ }).getAttribute("aria-expanded")).toBe("true");
});

test("diagram_with_a_rules_compaction_has_no_second_crossing", async () => {
  const user = userEvent.setup();
  renderLog({ steps: WITH_COMPACT });
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(document.querySelectorAll(".dcross")).toHaveLength(2);
  expect(screen.getByRole("button", { name: /^Compact, 14 messages/ })).toBeTruthy();
});

// a sample read. No cell value appears anywhere in these fixtures.
const ROWS_RULE =
  "Read live by Contura in a read-only transaction: at most 5 rows per named table, cells cut at 200 characters, binaries as <binary>. Never stored.";
const ROWS_STEP: ProcessStep = {
  step: "rows",
  atMs: 100,
  value: "10 rows from 2 tables",
  rule: ROWS_RULE,
  evidence: [
    ["invoices", "open tab", "5 rows, 324 B"],
    ["customers", "name match", "5 rows, 319 B"],
    ["orders", "name match", "could not read"],
  ],
  byModel: false,
};
const WITH_ROWS: Partial<AnswerRecord> = {
  sent: sentRecord({ kinds: ["question", "names", "cards", "rows"], rows: { tables: 2, rows: 10, bytes: 643 } }),
  steps: [...STEPS.slice(0, 3), ROWS_STEP, ...STEPS.slice(3)],
  log: [
    ...LOG.slice(0, 3),
    { atMs: 100, level: "info", source: "rows", fields: [["tables", "2"], ["rows", "10"], ["bytes", "643"], ["readOnly", "true"], ["ms", "100"]] },
    ...LOG.slice(3, 7),
    { atMs: 1912, level: "info", source: "database", fields: [["ran", "sampleRead"], ["tables", "2"], ["rows", "10"], ["by", "contura"]] },
  ],
};

test("steps_rows_row", async () => {
  const user = userEvent.setup();
  renderLog(WITH_ROWS);
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  const row = screen.getByRole("button", { name: /^Rows/ });
  expect(row.textContent).toContain("10 rows from 2 tables");
  await user.click(row);
  screen.getByText(ROWS_RULE);
  const ev = document.querySelector(".ev")!;
  expect(Array.from(ev.querySelectorAll(".eh")).map((e) => e.textContent)).toEqual(["Table", "Rule", "Evidence"]);
  expect(ev.textContent).toContain("invoicesopen tab5 rows, 324 B");
  expect(ev.textContent).toContain("orders" + "name match" + "could not read");
});

test("ran_on_cell_with_sample_read", async () => {
  const user = userEvent.setup();
  renderLog(WITH_ROWS);
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  const cells = Array.from(document.querySelectorAll(".cell3")).map((c) => c.textContent);
  expect(cells[2]).toBe("Ran on ShopSample rows, read only2 SELECTs by Contura. No tools offered");
  expect(cells[1]).toBe("Not sentValues2 tables, the key");
  screen.getByText("Contura read sample rows: 2 read-only SELECTs. Nothing else ran on the database.");
  expect(screen.queryByText("Nothing ran on the database")).toBeNull();
});

test("ran_on_cell_with_one_select", async () => {
  // One table read, one that could not be: one SELECT ran.
  const user = userEvent.setup();
  const one: ProcessStep = {
    ...ROWS_STEP,
    value: "3 rows from 1 table",
    evidence: [
      ["invoices", "open tab", "3 rows, 90 B"],
      ["orders", "name match", "could not read"],
    ],
  };
  renderLog({ ...WITH_ROWS, sent: sentRecord({ kinds: ["rows"], rows: { tables: 1, rows: 3, bytes: 90 } }), steps: [...STEPS.slice(0, 3), one, ...STEPS.slice(3)] });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  expect(Array.from(document.querySelectorAll(".cell3")).map((c) => c.textContent)[2]).toBe(
    "Ran on ShopSample rows, read only1 SELECT by Contura. No tools offered",
  );
  screen.getByText("Contura read sample rows: 1 read-only SELECT. Nothing else ran on the database.");
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(document.body.textContent).toContain("1 SELECT, read only, by Contura");
});

// The budget left every table out: the SELECTs ran, though no rows went.
const ALL_LEFT_OUT: ProcessStep = {
  ...ROWS_STEP,
  value: "0 rows from 0 tables",
  evidence: [
    ["invoices", "open tab", "left out: over the budget"],
    ["customers", "name match", "left out: over the budget"],
    ["orders", "name match", "no rows"],
  ],
};

test("selects_counted_when_the_budget_left_every_table_out", async () => {
  const user = userEvent.setup();
  renderLog({ sent: sentRecord({ kinds: ["question", "names", "cards"] }), steps: [...STEPS.slice(0, 3), ALL_LEFT_OUT, ...STEPS.slice(3)] });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  expect(Array.from(document.querySelectorAll(".cell3")).map((c) => c.textContent)[2]).toBe(
    "Ran on ShopSample rows, read only3 SELECTs by Contura. No tools offered",
  );
  screen.getByText("Contura read sample rows: 3 read-only SELECTs. Nothing else ran on the database.");
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(document.body.textContent).toContain("3 SELECTs, read only, by Contura");
});

test("switch_on_with_no_named_table_ran_nothing", async () => {
  const user = userEvent.setup();
  const none: ProcessStep = { ...ROWS_STEP, value: "0 rows from 0 tables", evidence: [] };
  renderLog({ sent: sentRecord({ kinds: ["question", "names", "cards"] }), steps: [...STEPS.slice(0, 3), none, ...STEPS.slice(3)] });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  expect(Array.from(document.querySelectorAll(".cell3")).map((c) => c.textContent)[2]).toBe("Ran on ShopNothingNo tools offered");
  screen.getByText("Nothing ran on the database");
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  // No read box: no line to the database and no SELECT; the catalog store box stays.
  expect(document.body.textContent).not.toContain("read only, by Contura");
  expect(document.querySelector(".dread")).toBeNull();
  expect(document.querySelector(".dstore")!.textContent).toBe("Shop");
});

test("ran_on_cell_without", async () => {
  const user = userEvent.setup();
  renderLog();
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  expect(Array.from(document.querySelectorAll(".cell3")).map((c) => c.textContent)[2]).toBe("Ran on ShopNothingNo tools offered");
  screen.getByText("Nothing ran on the database");
});

test("diagram_rows_box", async () => {
  const user = userEvent.setup();
  renderLog(WITH_ROWS);
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  const box = screen.getByRole("button", { name: /^Rows, 2 of 3 tables/ });
  expect(box).toBeTruthy();
  expect(document.body.textContent).toContain("2 SELECTs, read only, by Contura");
  expect(Array.from(document.querySelectorAll(".dnote")).filter((n) => n.textContent === "catalog only, no rows")).toHaveLength(2);
  await user.click(box);
  const details = screen.getByRole("region", { name: "Rows" });
  expect(details.textContent).toContain(ROWS_RULE);
});

test("diagram_without_rows_has_no_rows_box", async () => {
  const user = userEvent.setup();
  renderLog();
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(screen.queryByRole("button", { name: /^Rows/ })).toBeNull();
  expect(document.body.textContent).not.toContain("read only, by Contura");
});

test("log_rows_source_filters", async () => {
  const user = userEvent.setup();
  renderLog(WITH_ROWS);
  const all = rows().length;
  expect(rows().some((r) => r.textContent === "00.100INFOrowstables=2 rows=10 bytes=643 readOnly=true ms=100")).toBe(true);
  await user.type(screen.getByLabelText("Search the log"), "readOnly");
  expect(rows()).toHaveLength(1);
  expect(all).toBe(9);
});

// A diagram Ask's log: Diagram and Tool check rows, no Access row, the one-tool Diagram tab.
const TOOL_INPUT = '{"file":"checkout","base_hash":"3f9a","changes":[{"op":"add_node","name":"Fraud check"}]}';
const DIAGRAM_STEPS: ProcessStep[] = [
  { step: "diagram", atMs: 1, value: "checkout.flow, 2,418 B", rule: "Diagrams are not database data: no AI access level applies.", evidence: [], byModel: false },
  { step: "cleaning", atMs: 2, value: "0 secrets", rule: "", evidence: [], byModel: false },
  { step: "request", atMs: 210, value: "2,911 B, one tool", rule: "", evidence: [], byModel: false },
  { step: "answer", atMs: 1700, value: "1 tool call, by the model", rule: "", evidence: [], byModel: true },
  {
    step: "toolCheck",
    atMs: 1710,
    value: "4 proposed, 1 dropped",
    rule: "Contura checks every change against the file before you see it.",
    evidence: [
      ["#1 add_node", "ok", "kept"],
      ["#2 add_flow", "ok", "kept"],
      ["#3 add_flow", "unknown_shape", "dropped"],
      ["#4 relabel_flow", "ok", "kept"],
    ],
    byModel: false,
  },
];
const DIAGRAM_RECORD: Partial<AnswerRecord> = {
  sent: sentRecord({ kinds: ["question", "diagram"], bytes: 2911 }),
  thinking: null,
  steps: DIAGRAM_STEPS,
  toolUse: {
    tool: "propose_diagram_changes",
    file: "checkout",
    input: TOOL_INPUT,
    proposal: { file: "checkout", baseHash: "3f9a", changes: [] },
    outcome: { accepted: 3, rejected: 0, auto: false, at: 5 },
  },
};

function renderDiagramLog(over: Partial<AnswerRecord> = {}) {
  return render(
    <AnswerLog variant="diagram" file="checkout" question="Add a fraud check" answer="I'll add it." record={{ ...RECORD, ...DIAGRAM_RECORD, ...over }} providerName="Groq" onBack={() => {}} />,
  );
}

test("steps_has_diagram_and_tool_check_rows", async () => {
  const user = userEvent.setup();
  const { container } = renderDiagramLog();
  // It opens on Steps; the Log tab is there as for any answer.
  expect(screen.getByRole("tab", { name: "Steps" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tab", { name: "Log" })).toBeTruthy();
  const prows = Array.from(document.querySelectorAll(".prow"));
  expect(prows.map((r) => r.querySelector(".lb")!.textContent)).toEqual(["Diagram", "Cleaning", "Request", "Answer", "Tool check"]);
  expect(prows[0].querySelector(".v")!.textContent).toBe("checkout.flow, 2,418 B");
  expect(prows[2].querySelector(".v")!.textContent).toBe("2,911 B, one tool");
  // No database cells and no database line: a diagram Ask never touches one.
  expect(document.querySelector(".cell3")).toBeNull();
  expect(screen.queryByText(/database/)).toBeNull();
  expect(screen.getByText("You: accepted 3")).toBeTruthy();
  // The Diagram row says why no AI access applies.
  await user.click(screen.getByRole("button", { name: /^Diagram/ }));
  expect(screen.getByText("Diagrams are not database data: no AI access level applies.")).toBeTruthy();
  // Tool check: each change, its check and its result, a dropped one marked; then the stored tool input.
  await user.click(screen.getByRole("button", { name: /^Tool check/ }));
  expect(screen.getByText("Contura checks every change against the file before you see it.")).toBeTruthy();
  const ev = document.querySelector(".ev")!;
  expect(Array.from(ev.querySelectorAll(".eh")).map((e) => e.textContent)).toEqual(["Change", "Check", "Result"]);
  const dropped = Array.from(ev.querySelectorAll(".ev-row")).find((r) => r.textContent?.includes("unknown_shape"))!;
  expect(dropped.classList.contains("drop")).toBe(true);
  const stored = screen.getByRole("region", { name: "Stored tool input" });
  expect(within(stored).getByLabelText("Input the model sent").textContent).toBe(JSON.stringify(JSON.parse(TOOL_INPUT), null, 2));
  expect(within(stored).getByRole("button", { name: "Copy the tool input as stored" })).toBeTruthy();
  expect(container.querySelectorAll("[title]")).toHaveLength(0);
});

test("diagram_tab_one_tool_no_database", async () => {
  const user = userEvent.setup();
  const { container } = renderDiagramLog();
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  const zones = Array.from(document.querySelectorAll(".zone .zt")).map((z) => z.textContent);
  expect(zones).toEqual(["On this computer", "Groq, openai/gpt-oss-20b", "Back on this computer"]);
  const boxes = (zone: number) => Array.from(document.querySelectorAll(".zone")[zone].querySelectorAll(".dbox")).map((b) => b.querySelector(".dlab")!.textContent);
  expect(boxes(0)).toEqual(["Your question", "Diagram", "Cleaning"]);
  expect(boxes(1)).toEqual(["Answer", "Proposed 4 changes"]);
  expect(boxes(2)).toEqual(["Tool check", "You: accepted 3"]);
  expect(screen.getByText("checkout.flow, 2,418 B")).toBeTruthy();
  expect(screen.getByText("2,911 B leave your computer")).toBeTruthy();
  expect(document.querySelectorAll(".zone")[1].querySelectorAll(".dmodel")).toHaveLength(2);
  expect(screen.getByText("One tool: it can only suggest edits to checkout.")).toBeTruthy();
  // No database box and no "No tools" line.
  expect(document.querySelector(".dstore, .dbox.store")).toBeNull();
  expect(screen.queryByText(/No tools/)).toBeNull();
  expect(screen.queryByText(/database/i)).toBeNull();
  // Tool check opens its row in Steps.
  await user.click(screen.getByRole("button", { name: "Tool check, 4 proposed, 1 dropped. Open in Steps" }));
  expect(screen.getByRole("tab", { name: "Steps" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: /^Tool check/ }).getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelectorAll("[title]")).toHaveLength(0);
});

test("parity_P11_38_answer_log_names_the_machine_for_the_platform", async () => {
  const user = userEvent.setup();
  try {
    setPlatformForTests("windows");
    renderLog();
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    const zones = Array.from(document.querySelectorAll(".zone .zt")).map((z) => z.textContent);
    expect(zones).toEqual(["On this PC", "Groq, openai/gpt-oss-20b", "Back on this PC"]);
    expect(screen.getByText("2,314 B leave your PC")).toBeTruthy();
  } finally {
    setPlatformForTests(null);
  }
});

test("parity_P11_21_ran_on_names_the_connection_with_the_schema_under_it", async () => {
  const user = userEvent.setup();
  renderLog({}, { connection: "freight", database: "main" });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  const ran = document.querySelectorAll(".cell3")[2];
  expect(Array.from(ran.children).map((c) => c.textContent)).toEqual(["Ran on freight", "Nothing", "Database main. No tools offered"]);
});

test("parity_P11_21_ran_on_with_sample_reads_keeps_the_schema_in_the_detail_line", async () => {
  const user = userEvent.setup();
  renderLog(WITH_ROWS, { connection: "freight", database: "main" });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  expect(document.querySelectorAll(".cell3")[2].textContent).toBe("Ran on freightSample rows, read onlyDatabase main. 2 SELECTs by Contura. No tools offered");
});

test("parity_P11_22_sent_cell_counts_the_summary_and_outline_calls", async () => {
  const user = userEvent.setup();
  const summary = { ...SUMMARY_SENT, kind: "summary" as const, bytes: 66_001 };
  renderLog({ sent: sentRecord({ bytes: 1_493, summaryCall: true, summary }) });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  expect(document.querySelectorAll(".cell3")[0].textContent).toBe("Sent67,494 Bapi.groq.com");
});

test("parity_P11_22_sent_cell_counts_the_outline_call", async () => {
  const user = userEvent.setup();
  renderLog({ sent: sentRecord({ outlineCall: true, outline: OUTLINE_SENT }) });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  expect(document.querySelectorAll(".cell3")[0].textContent).toBe("Sent3,518 Bapi.groq.com");
});

// ---- Owner requests (27 Oct): the log shows the answer, the thinking and each checked statement ----
// As a Grafana Loki or Langfuse trace opens a line's body: no new storage, read from the props the log already has.

const ANSWER = "Join invoices to customers:\n\n```sql\nSELECT c.name FROM customers c;\n```";
const CHECKED: SqlBlock[] = [
  {
    fence: 0,
    label: "1 read, 2 writes",
    statements: [
      { text: "SELECT c.name FROM customers c", class: "read", flags: [] },
      { text: "DELETE FROM invoices", class: "write", flags: [{ kind: "noWhere", verb: "DELETE" }] },
      { text: "UPDATE plans SET seats = 1 WHERE id = 2", class: "write", flags: [] },
    ],
  },
];
const BODY_LOG: LogLine[] = [
  ...LOG,
  { atMs: 1806, level: "info", source: "answer", fields: [["chars", "214"], ["output", "486"]] },
  { atMs: 1900, level: "info", source: "sql_check", fields: [["reads", "1"], ["writes", "2"], ["flags", "1"]] },
];
const lineOf = (source: string) => rows().find((r) => r.querySelector(".ls")?.textContent === source) as HTMLElement;

function useClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

/** The three verdicts read as the chat's statement cards read them. */
function expectChecks() {
  const list = screen.getByRole("list", { name: "Checked statements" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(items[0].querySelector(".sql-block")?.textContent).toBe("SELECT c.name FROM customers c");
  expect(items[0].querySelector(".lcheck-verdict")?.textContent).toBe("Read");
  // A flagged write says both: it writes, and why it is flagged.
  expect(Array.from(items[1].querySelectorAll(".lcheck-verdict")).map((v) => v.textContent)).toEqual(["Write", "Flag"]);
  expect(items[1].textContent).toContain("DELETE without WHERE.");
  expect(items[2].querySelector(".lcheck-verdict")?.textContent).toBe("Write");
  // Highlighted in the editor's colours.
  expect(items[0].querySelector(".sql-block-text span[class]")).toBeTruthy();
}

test("the_log_answer_line_shows_the_whole_answer_with_copy", async () => {
  const user = userEvent.setup();
  const writeText = useClipboard();
  renderLog({ log: BODY_LOG }, { answer: ANSWER });
  expect(screen.queryByRole("region", { name: "The answer, as returned" })).toBeNull();
  await user.click(lineOf("answer"));
  const body = screen.getByRole("region", { name: "The answer, as returned" });
  expect(body.querySelector("pre")?.textContent).toBe(ANSWER);
  // Its fields still show above it.
  expect(lineOf("answer").parentElement!.querySelector(".ljson")?.textContent).toContain('"chars": 214');
  const copyButton = within(body).getByRole("button", { name: "Copy the answer" });
  expect(copyButton.getAttribute("title")).toBe("Copy the answer");
  await user.click(copyButton);
  expect(writeText).toHaveBeenCalledWith(ANSWER);
});

test("a_warn_answer_line_keeps_only_its_fields", async () => {
  // A cut-off answer logs a second, warn "answer" line (finish_reason): the body shows once, under the info line.
  const user = userEvent.setup();
  const warn: LogLine = { atMs: 1810, level: "warn", source: "answer", fields: [["finish_reason", "length"]] };
  renderLog({ log: [...BODY_LOG, warn] }, { answer: ANSWER });
  const warnRow = rows().find((r) => r.classList.contains("warn") && r.querySelector(".ls")?.textContent === "answer") as HTMLElement;
  await user.click(warnRow);
  expect(warnRow.getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByRole("region", { name: "The answer, as returned" })).toBeNull();
});

test("the_log_thinking_line_shows_the_reasoning_when_it_was_kept", async () => {
  const user = userEvent.setup();
  renderLog({ log: BODY_LOG });
  expect(screen.queryByRole("region", { name: "The thinking, as returned" })).toBeNull();
  await user.click(lineOf("thinking"));
  expect(screen.getByRole("region", { name: "The thinking, as returned" }).textContent).toContain("The user wants invoices joined to customers.");
});

test("the_log_thinking_line_without_kept_thinking_shows_only_its_fields", async () => {
  const user = userEvent.setup();
  renderLog({ log: BODY_LOG, thinking: null });
  await user.click(lineOf("thinking"));
  expect(lineOf("thinking").getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByRole("region", { name: "The thinking, as returned" })).toBeNull();
});

test("the_log_sql_check_line_lists_each_statement_with_its_verdict", async () => {
  const user = userEvent.setup();
  renderLog({ log: BODY_LOG, sqlBlocks: CHECKED });
  await user.click(lineOf("sql_check"));
  expectChecks();
});

test("the_sql_check_body_says_when_the_answer_had_no_sql", async () => {
  const user = userEvent.setup();
  renderLog({ log: BODY_LOG, sqlBlocks: [] });
  await user.click(lineOf("sql_check"));
  expect(screen.getByText("No SQL in this answer.")).toBeTruthy();
});

test("the_steps_answer_and_sql_check_rows_show_their_bodies", async () => {
  const user = userEvent.setup();
  const writeText = useClipboard();
  renderLog({ sqlBlocks: CHECKED }, { answer: ANSWER });
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  await user.click(screen.getByRole("button", { name: /^Answer/ }));
  const body = screen.getByRole("region", { name: "The answer, as returned" });
  expect(body.querySelector("pre")?.textContent).toBe(ANSWER);
  await user.click(within(body).getByRole("button", { name: "Copy the answer" }));
  expect(writeText).toHaveBeenCalledWith(ANSWER);
  await user.click(screen.getByRole("button", { name: /^SQL check/ }));
  expectChecks();
  // The Thinking row keeps the thinking as returned.
  await user.click(screen.getByRole("button", { name: /^Thinking/ }));
  expect(screen.getByText("The user wants invoices joined to customers.")).toBeTruthy();
});
