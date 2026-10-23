// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import { expect, test } from "vitest";

const script = new URL("./measure-memory.sh", import.meta.url).pathname;
const linux = process.platform === "linux";

test.skipIf(!linux)("unknown_pid_exits_2", () => {
  const r = spawnSync("bash", [script, "--pid", "999999"], { encoding: "utf8" });
  expect(r.status).toBe(2);
});

test.skipIf(!linux)("counts_the_process_and_its_children", async () => {
  const parent = spawn("bash", ["-c", "sleep 20 & sleep 20 & wait"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const r = spawnSync("bash", [script, "--pid", String(parent.pid), "--samples", "2", "--interval", "0.1"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^sample 1: private [\d.]+ MB \(of it in swap [\d.]+ MB\), total [\d.]+ MB, processes 3$/);
    expect(lines[2]).toMatch(/^min: private [\d.]+ MB, total [\d.]+ MB$/);
  } finally {
    spawnSync("pkill", ["-P", String(parent.pid)]);
    parent.kill();
  }
});
