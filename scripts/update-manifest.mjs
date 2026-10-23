// Writes latest.json, the release manifest Contura's update check reads (ADR 0026).
//
//   node scripts/update-manifest.mjs <dist dir> <version> [notes file]
//
// For each update file in <dist dir> that has a `.sig` beside it (made by
// `npx tauri signer sign`), the manifest names its download URL on the v<version> release,
// its signature (the .sig file's text) and its SHA-256. Without a signed file it writes nothing
// and exits 3: an unsigned release must not be offered as an update.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPO = "Rifqio/contura";

/** The update file of each platform key the app asks for, by version. */
export function updateFiles(version) {
  return {
    "windows-x86_64-portable": `Contura_${version}_x64_portable.exe`,
    "linux-x86_64-appimage": `Contura_${version}_amd64.AppImage`,
  };
}

/**
 * The manifest for `version`. `files` maps a platform key to { name, signature, sha256 }.
 * `notes` is the release notes text, `pubDate` an ISO time.
 */
export function buildManifest({ version, notes, pubDate, files }) {
  const platforms = {};
  for (const [key, f] of Object.entries(files)) {
    platforms[key] = {
      url: `https://github.com/${REPO}/releases/download/v${version}/${f.name}`,
      signature: f.signature.trim(),
      sha256: f.sha256,
    };
  }
  return { version, notes, pub_date: pubDate, platforms };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main([dist, version, notesFile]) {
  if (!dist || !version) {
    console.error("usage: update-manifest.mjs <dist dir> <version> [notes file]");
    return 2;
  }
  const files = {};
  for (const [key, name] of Object.entries(updateFiles(version))) {
    const path = join(dist, name);
    if (!existsSync(path)) {
      console.log(`${name} is not in ${dist}: no ${key} entry.`);
      continue;
    }
    if (!existsSync(`${path}.sig`)) {
      console.log(`${name} has no signature: no ${key} entry.`);
      continue;
    }
    files[key] = { name, signature: readFileSync(`${path}.sig`, "utf8"), sha256: sha256(path) };
  }
  if (Object.keys(files).length === 0) {
    console.log("No signed update file: latest.json is not written.");
    return 3;
  }
  const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : `Contura ${version}.`;
  const manifest = buildManifest({ version, notes, pubDate: new Date().toISOString(), files });
  writeFileSync(join(dist, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json: ${Object.keys(files).join(", ")}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
