// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ER_BOARD_TEXT, erBoardLayoutFile } from "../src/lang/flow/fixtures/erBoard";
import { SEQ_BOARD_KEYS, seqBoardLayoutFile, seqBoardText } from "../src/lang/flow/fixtures/bigSequence";

const script = new URL("./write-limit-boards.mjs", import.meta.url).pathname;
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the_er_board_file_is_the_perf_fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "contura-limit-boards-"));
  dirs.push(dir);
  const out = join(dir, "boards");
  const r = spawnSync(process.execPath, [script, out], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const text = readFileSync(join(out, "er2000.flow"), "utf8");
  expect(text).toBe(ER_BOARD_TEXT);
  expect(readFileSync(join(out, "er2000.flow.layout.json"), "utf8")).toBe(erBoardLayoutFile());
  // 2,000 tables, every one placed.
  expect(text.match(/^t\d+ \{$/gm)).toHaveLength(2000);
  expect(Object.keys(JSON.parse(readFileSync(join(out, "er2000.flow.layout.json"), "utf8")).frames.Schema.nodes)).toHaveLength(2000);
});

test("the_sequence_board_file_is_the_perf_fixture", () => {
  // The sequence limit board for Task 10's live run, equal to sequence.perf.test.ts's.
  const dir = mkdtempSync(join(tmpdir(), "contura-limit-boards-"));
  dirs.push(dir);
  const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const text = readFileSync(join(dir, "seq2000.flow"), "utf8");
  expect(text).toBe(seqBoardText());
  const layout = readFileSync(join(dir, "seq2000.flow.layout.json"), "utf8");
  expect(layout).toBe(seqBoardLayoutFile());
  // 2,000 participants and 3,000 messages in the last of 41 frames, every frame placed.
  expect(text.match(/^participant Svc \d+ /gm)).toHaveLength(2000);
  expect(text.match(/^\s*Svc \d+ -?-> Svc \d+: /gm)).toHaveLength(3000);
  expect(Object.keys(JSON.parse(layout).frames)).toEqual(SEQ_BOARD_KEYS);
});

test("no_directory_is_a_usage_error", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(r.status).toBe(2);
});
