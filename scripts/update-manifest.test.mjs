// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildManifest, updateFiles } from "./update-manifest.mjs";

const script = new URL("./update-manifest.mjs", import.meta.url).pathname;
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dist() {
  const d = mkdtempSync(join(tmpdir(), "contura-manifest-"));
  dirs.push(d);
  return d;
}

test("the manifest has the shape the app reads", () => {
  const m = buildManifest({
    version: "1.0.1",
    notes: "Fixes.",
    pubDate: "2026-11-01T10:00:00.000Z",
    files: { "linux-x86_64-appimage": { name: "Contura_1.0.1_amd64.AppImage", signature: "c2ln\n", sha256: "ab" } },
  });
  expect(m).toEqual({
    version: "1.0.1",
    notes: "Fixes.",
    pub_date: "2026-11-01T10:00:00.000Z",
    platforms: {
      "linux-x86_64-appimage": {
        url: "https://github.com/Rifqio/contura/releases/download/v1.0.1/Contura_1.0.1_amd64.AppImage",
        signature: "c2ln",
        sha256: "ab",
      },
    },
  });
  expect(updateFiles("1.0.1")).toEqual({
    "windows-x86_64-portable": "Contura_1.0.1_x64_portable.exe",
    "linux-x86_64-appimage": "Contura_1.0.1_amd64.AppImage",
  });
});

test("only signed files are listed, with their sha256 and the release notes", () => {
  const d = dist();
  writeFileSync(join(d, "Contura_1.0.1_x64_portable.exe"), "exe");
  writeFileSync(join(d, "Contura_1.0.1_x64_portable.exe.sig"), "c2lnLWV4ZQ==");
  writeFileSync(join(d, "Contura_1.0.1_amd64.AppImage"), "appimage");
  writeFileSync(join(d, "notes.md"), "Faster grids.\n");
  const r = spawnSync("node", [script, d, "1.0.1", join(d, "notes.md")], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Contura_1.0.1_amd64.AppImage has no signature");
  const m = JSON.parse(readFileSync(join(d, "latest.json"), "utf8"));
  expect(m.version).toBe("1.0.1");
  expect(m.notes).toBe("Faster grids.");
  expect(Object.keys(m.platforms)).toEqual(["windows-x86_64-portable"]);
  expect(m.platforms["windows-x86_64-portable"]).toEqual({
    url: "https://github.com/Rifqio/contura/releases/download/v1.0.1/Contura_1.0.1_x64_portable.exe",
    signature: "c2lnLWV4ZQ==",
    sha256: createHash("sha256").update("exe").digest("hex"),
  });
});

test("nothing signed writes nothing", () => {
  const d = dist();
  writeFileSync(join(d, "Contura_1.0.1_amd64.AppImage"), "appimage");
  const r = spawnSync("node", [script, d, "1.0.1"], { encoding: "utf8" });
  expect(r.status).toBe(3);
  expect(existsSync(join(d, "latest.json"))).toBe(false);
});
