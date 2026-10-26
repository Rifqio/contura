// Packs the cloud icon sets into src-tauri/icons-pack/icons.bin (step 6+, C1b; v2: Plan C).
//
//   node scripts/pack-icons.mjs <source folder> [out file] [--previous <pack>] [--sheet <file.html>]
//
// The source folder holds each official pack, downloaded and extracted by hand into a new
// empty folder outside the repo (Ruling P7: the downloads are untrusted data; this script
// only reads files from it and never runs anything in it). Expected layout, with the
// download each one comes from (see docs/research/2026-10-18-icon-licences.md):
//
//   aws/           AWS Architecture Icons package zip (aws.amazon.com/architecture/icons)
//   azure/         Azure_Public_Service_Icons_V24.zip (learn.microsoft.com/azure/architecture/icons)
//   gcp-core/      core-products-icons.zip     (cloud.google.com/icons)
//   gcp-legacy/    google-cloud-legacy-icons.zip
//   gcp-category/  category-icons.zip
//   k8s/icons/svg/ github.com/kubernetes/community icons/svg at one commit
//   lucide/        the lucide-static npm tarball
//   simple/        the simple-icons npm tarball
//
// A missing folder leaves that set out. Each icon's root <svg> start tag is rewritten to fit
// one 24 by 24 frame (icon-frame.mjs, Plan C Decision 3); everything else is copied byte for
// byte: never recoloured, cropped, rotated or redrawn. An SVG that fails the safety check
// (svg-check.mjs, Rulings P7, P9 and P10: an allow list), before or after framing, or that
// the framer refuses, is left out and counted.
//
// Names (Decision 7): a general (Lucide) name may not start with a provider prefix; the first
// set in pack order keeps a name; every name of the previous pack must still resolve, through
// RENAMED (an alias of the new name) or DROPPED (listed with its reason), or the build fails.
//
// Format (all integers little endian):
//   "CTRICON1"                magic, 8 bytes
//   u32                       length of the compressed index
//   index                     raw deflate of UTF-8 JSON:
//                             { version: 2, sets: [{ id, title, licence, source, note, notice, style, changes }],
//                               icons: [[name, setIndex, title, offset, length, licence | null,
//                                        aliasOf | null, inkAt | null, hex?], ...] }
//   blobs                     each icon raw-deflated on its own; offset counts from the
//                             first byte after the index, so the Core inflates one icon
//                             per call. Aliases share their target's blob and inkAt.
//
// `inkAt` is the UTF-8 byte offset of the root tag's `>` in the inflated icon, where the Core
// inserts ` color="#rrggbb"` for outline and mono sets (Decision 4). `hex` is a brand logo's own
// colour, `#` and six lower-case hex digits from Simple Icons' data (CC0); only logo rows have
// it, every other row stops at inkAt. The front end inks a logo in it where it reads on the
// theme (owner ruling 26 Oct). Version 1 had no style, changes, aliasOf or inkAt, and its
// licence column was optional.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { BRANDS } from "./icon-brands.mjs";
import { frameRoot, rootTag } from "./icon-frame.mjs";
import { unsafeReason } from "./svg-check.mjs";

const MAX_PACK_BYTES = 4 * 1024 * 1024;
/** The Core refuses an unpacked index of this size or more (icons.rs MAX_INDEX_BYTES). */
const MAX_INDEX_BYTES = 1024 * 1024;
/** The theme inks the Core may insert at inkAt (light, dark: --c-text in tokens.css). */
const INK_LIGHT = "#1f1f1f";
const INK_DARK = "#f8f8f2";
const MAGIC = "CTRICON1";

/**
 * Margin on each side of the frame, as a fraction of it (Decision 2), tuned on the contact sheet
 * so each set reads the size of Lucide's `database` (about 19.5 by 21.5 of 24 with its stroke).
 */
export const PAD = {
  // Service tiles are solid squares that fill the artboard; 19 of 24 reads as tall as `database`.
  aws: 2.5 / 24,
  // Filled colour drawings that touch the 18 by 18 artboard; at 20 they read larger than `database`.
  azure: 2.5 / 24,
  // The 512 artboard already keeps about a tenth of margin; drawings land at about 19 of 24.
  gcp: 0.5 / 24,
  // A solid heptagon filling the artboard; 2 of 24 read heavy, 3 of 24 read small.
  k8s: 2.5 / 24,
  // The reference: Lucide's 24 grid keeps its own 2 units of padding.
  lucide: 0,
  // Logos fill the 24 artboard edge to edge; at 19 of 24 a solid logo matches `database`.
  simple: 2.5 / 24,
};
/** Lucide's root stroke width (Decision 1). */
export const STROKE = "1.5";
/** Prefixes a general (unprefixed) icon may not take (Decision 7). */
export const RESERVED = ["aws", "azure", "gcp", "k8s", "brand", "oci", "net"];
/** Old name -> new name: the old name stays as an alias of the new one. */
export const RENAMED = {};
/** Old name -> one-line reason: only for an icon upstream removed with no replacement. */
export const DROPPED = {};
/** What the pack changed in each set's icons, shown in Icon credits (Decision 11). */
const FITTED = "Fitted into a 24 by 24 frame with even margins; never redrawn or recoloured.";
export const CHANGES = {
  aws: FITTED,
  azure: FITTED,
  gcp: FITTED,
  k8s: FITTED,
  lucide: "Fitted into a 24 by 24 frame and drawn at stroke 1.5 in the theme's text colour.",
  simple:
    "Fitted into a 24 by 24 frame and drawn in its brand colour; a logo too pale for the light theme gets a hairline outline in the text colour, and one too dark for the dark theme is drawn in the text colour.",
};
/** outline: Lucide strokes in currentColor; mono: logos filled in currentColor; colour: never inked. */
const STYLES = { aws: "colour", azure: "colour", gcp: "colour", k8s: "colour", lucide: "outline", simple: "mono" };

const SETS = [
  {
    id: "aws",
    title: "AWS Architecture Icons",
    licence: "AWS terms: for creating architecture diagrams",
    source: "https://aws.amazon.com/architecture/icons/",
    note: "Release 07312026. Amazon, AWS and the service icons are trademarks of Amazon.com, Inc. or its affiliates.",
  },
  {
    id: "azure",
    title: "Azure architecture icons",
    licence: "Microsoft icon terms: for architectural diagrams, training materials or documentation",
    source: "https://learn.microsoft.com/azure/architecture/icons/",
    note: "Azure Public Service Icons V24. Microsoft reserves all other rights. Do not crop, flip, rotate or distort.",
  },
  {
    id: "gcp",
    title: "Google Cloud icons",
    licence: "Google: for building your own architecture diagrams",
    source: "https://cloud.google.com/icons",
    note: "Core product, legacy console and category icons. Google Cloud and the product icons are trademarks of Google LLC.",
  },
  {
    id: "k8s",
    title: "Kubernetes icons",
    licence: "CC-BY-4.0 (offered as Apache-2.0 or CC-BY-4.0)",
    source: "https://github.com/kubernetes/community/tree/main/icons",
    note: "By the Kubernetes Authors. The Kubernetes logo is a registered trademark of The Linux Foundation.",
  },
  {
    id: "lucide",
    title: "Lucide",
    licence: "ISC; icons from Feather also MIT",
    source: "https://lucide.dev/license",
    note: "Copyright (c) Lucide Icons and Contributors; Feather icons copyright (c) 2013-present Cole Bemis.",
  },
  {
    id: "simple",
    title: "Simple Icons",
    licence: "CC0-1.0",
    source: "https://simpleicons.org",
    note: "Brand logos are trademarks of their owners and follow each brand's own rules.",
  },
];

/** Lower case words joined by `-`: `Cloud_Storage (Classic)` -> `cloud-storage-classic`. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `AIHypercomputer` -> `AI Hypercomputer`, `CloudSQL` -> `Cloud SQL`. */
function splitCamel(text) {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__MACOSX" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".svg")) out.push(path);
  }
  return out.sort();
}

/** Each set's candidates: [{ name, title, file }] and aliases [[alias, target]]. */
const COLLECT = {
  aws(root) {
    const icons = [];
    for (const file of walk(root)) {
      const base = file.split(/[\\/]/).pop().replace(/\.svg$/i, "");
      let m;
      if ((m = /^Arch_(.+)_64$/.exec(base)) && /[\\/]64[\\/]/.test(file)) {
        icons.push({ rank: 0, raw: m[1] });
      } else if ((m = /^Res_(.+)_48$/.exec(base))) {
        icons.push({ rank: 1, raw: m[1] });
      } else if ((m = /^(.+)_32(_Dark)?$/.exec(base)) && /Architecture-Group-Icons/.test(file)) {
        icons.push({ rank: 2, raw: `Group_${m[1]}${m[2] ?? ""}` });
      } else continue;
      const last = icons[icons.length - 1];
      last.file = file;
      last.title = last.raw.replace(/[_-]+/g, " ");
      last.name = `aws-${slug(last.raw.replace(/^(Amazon|AWS)-/, "").replace(/_(Amazon|AWS)-/, "_"))}`;
    }
    return {
      icons: icons.sort((a, b) => a.rank - b.rank),
      aliases: [
        ["aws-s3", "aws-simple-storage-service"],
        ["aws-sqs", "aws-simple-queue-service"],
        ["aws-sns", "aws-simple-notification-service"],
        ["aws-ses", "aws-simple-email-service"],
        ["aws-iam", "aws-identity-and-access-management"],
        ["aws-ebs", "aws-elastic-block-store"],
        ["aws-ecs", "aws-elastic-container-service"],
        ["aws-eks", "aws-elastic-kubernetes-service"],
        ["aws-ecr", "aws-elastic-container-registry"],
        ["aws-elb", "aws-elastic-load-balancing"],
        ["aws-vpc", "aws-virtual-private-cloud"],
        ["aws-msk", "aws-managed-streaming-for-apache-kafka"],
        ["aws-kms", "aws-key-management-service"],
        ["aws-apigateway", "aws-api-gateway"],
      ],
    };
  },
  azure(root) {
    const icons = [];
    for (const file of walk(root)) {
      const base = file.split(/[\\/]/).pop().replace(/\.svg$/i, "");
      const m = /^\d+-icon-service-(.+)$/.exec(base);
      if (!m) continue;
      icons.push({ file, title: m[1].replace(/-/g, " "), name: `azure-${slug(m[1].replace(/^Azure-/, ""))}` });
    }
    return {
      icons,
      aliases: [
        ["azure-sql", "azure-sql-database"],
        ["azure-vm", "azure-virtual-machine"],
        ["azure-aks", "azure-kubernetes-services"],
        ["azure-storage", "azure-storage-accounts"],
        ["azure-functions", "azure-function-apps"],
        ["azure-cosmosdb", "azure-cosmos-db"],
      ],
    };
  },
  gcp(root) {
    const icons = [];
    const legacy = new Map();
    const legacyDir = join(root, "..", "gcp-legacy");
    if (existsSync(legacyDir)) {
      for (const file of walk(legacyDir)) {
        const base = file.split(/[\\/]/).pop().replace(/\.svg$/i, "");
        const name = `gcp-${slug(base)}`;
        legacy.set(name.replace(/-/g, ""), name);
        icons.push({ rank: 1, file, name, title: base.replace(/_/g, " ") });
      }
    }
    for (const file of walk(root)) {
      const base = file.split(/[\\/]/).pop().replace(/\.svg$/i, "");
      const m = /^(.+?)-512-color(-rgb)?$/.exec(base);
      if (!m) continue;
      const words = splitCamel(m[1].replace(/_/g, " "));
      const own = `gcp-${slug(words)}`;
      // The current core icon takes its legacy twin's name, so `gcp-bigquery` stays put.
      const name = legacy.get(own.replace(/-/g, "")) ?? own;
      icons.push({ rank: 0, file, name, title: words });
    }
    const categoryDir = join(root, "..", "gcp-category");
    if (existsSync(categoryDir)) {
      for (const file of walk(categoryDir)) {
        const base = file.split(/[\\/]/).pop().replace(/\.svg$/i, "");
        const m = /^(.+?)-512-color(-rgb)?$/.exec(base);
        if (!m) continue;
        const words = splitCamel(m[1].replace(/_/g, " "));
        icons.push({ rank: 2, file, name: `gcp-category-${slug(words)}`, title: `${words} category` });
      }
    }
    return { icons: icons.sort((a, b) => a.rank - b.rank), aliases: [] };
  },
  k8s(root) {
    const icons = [];
    const svg = join(root, "icons", "svg");
    // Control plane parts come only with their label drawn in.
    for (const folder of [
      "resources/unlabeled",
      "infrastructure_components/unlabeled",
      "control_plane_components/labeled",
    ]) {
      const dir = join(svg, folder);
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const base = file.split(/[\\/]/).pop().replace(/\.svg$/i, "");
        icons.push({ file, name: `k8s-${slug(base)}`, title: `Kubernetes ${base}` });
      }
    }
    return {
      icons,
      aliases: [
        ["k8s-deployment", "k8s-deploy"],
        ["k8s-service", "k8s-svc"],
        ["k8s-ingress", "k8s-ing"],
        ["k8s-configmap", "k8s-cm"],
        ["k8s-statefulset", "k8s-sts"],
        ["k8s-daemonset", "k8s-ds"],
        ["k8s-replicaset", "k8s-rs"],
        ["k8s-namespace", "k8s-ns"],
        ["k8s-volume", "k8s-vol"],
        ["k8s-persistentvolume", "k8s-pv"],
        ["k8s-persistentvolumeclaim", "k8s-pvc"],
        ["k8s-serviceaccount", "k8s-sa"],
        ["k8s-storageclass", "k8s-sc"],
        ["k8s-endpoints", "k8s-ep"],
        ["k8s-apiserver", "k8s-api"],
        ["k8s-scheduler", "k8s-sched"],
      ],
    };
  },
  lucide(root) {
    const dir = join(root, "package", "icons");
    const icons = walk(dir).map((file) => {
      const base = file.split(/[\\/]/).pop().replace(/\.svg$/i, "");
      return { file, name: slug(base), title: base.replace(/-/g, " ") };
    });
    // The direction spec names `queue` as a general icon; Lucide has none by that name.
    return { icons, aliases: [["queue", "list-end"]] };
  },
  simple(root, stats, brands) {
    const data = JSON.parse(readFileSync(join(root, "package", "data", "simple-icons.json"), "utf8"));
    const icons = [];
    for (const entry of data) {
      if (!entry.slug || !brands.has(entry.slug)) continue;
      // An icon with a licence of its own ships only when that licence allows bundling it
      // unchanged with credit; non-commercial, copyleft and custom terms are left out.
      const own = entry.license?.type;
      let licence;
      if (own && own !== "CC0-1.0" && own !== "Unlicense") {
        if (!/^(MIT|Apache-2\.0|BSD-[23]-Clause|CC-BY-[0-9.]+|CC-BY-SA-[0-9.]+)$/.test(own)) {
          stats.ownLicence.push(`${entry.slug} (${own})`);
          continue;
        }
        licence = `${own}, from ${entry.license.url ?? entry.source}`;
      }
      const file = join(root, "package", "icons", `${entry.slug}.svg`);
      if (!existsSync(file)) continue;
      // The front end hands the colour to the Core as the logo's ink, so only a plain six digit colour is kept.
      if (typeof entry.hex !== "string" || !/^[0-9a-fA-F]{6}$/.test(entry.hex)) {
        stats.noColour.push(entry.slug);
        continue;
      }
      icons.push({ file, name: `brand-${slug(entry.slug)}`, title: entry.title, licence, hex: `#${entry.hex.toLowerCase()}` });
    }
    return { icons, aliases: [] };
  },
};

// The licence text each set asks to travel with its copies, shown in Icon credits.
const NOTICES = {
  k8s: () =>
    "The Kubernetes Icons Set by the Kubernetes Authors, fitted into a 24 by 24 frame with the drawing unchanged, under the Creative Commons " +
    "Attribution 4.0 International licence (https://creativecommons.org/licenses/by/4.0/).",
  lucide: (root) => readFileSync(join(root, "package", "LICENSE"), "utf8"),
  simple: () =>
    "Simple Icons is released under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). " +
    "CC0 waives no trademark rights: each logo belongs to its brand and is shown only to name that " +
    "product. Icons with a licence of their own carry it beside their name.",
};

const FOLDERS = { aws: "aws", azure: "azure", gcp: "gcp-core", k8s: "k8s", lucide: "lucide", simple: "simple" };
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function newStats() {
  return {
    bytes: 0,
    packed: 0,
    aliases: 0,
    badName: [],
    reserved: [],
    duplicate: [],
    unsafe: {},
    unframed: {},
    ownLicence: [],
    noColour: [],
    missedAliases: [],
    renamed: [],
    dropped: [],
    warnings: [],
  };
}

/** A Buffer view of the same bytes, so a plain Uint8Array works too. */
const asBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

/** The pack's magic, version, sets and rows; reads version 1 and 2. */
export function readPackIndex(bytes) {
  const pack = asBuffer(bytes);
  if (pack.length < 12 || pack.toString("ascii", 0, 8) !== MAGIC) throw new Error("not an icon pack");
  const length = pack.readUInt32LE(8);
  if (12 + length > pack.length) throw new Error("the icon pack's index runs past its end");
  const index = JSON.parse(inflateRawSync(pack.subarray(12, 12 + length)).toString("utf8"));
  if (index.version !== 1 && index.version !== 2) throw new Error(`icon pack version ${index.version} is not known`);
  return { version: index.version, sets: index.sets, icons: index.icons };
}

/**
 * Builds the pack from the source folder. Reads one file at a time and keeps only its deflated
 * copy, so memory grows with the pack, not with the sources.
 */
export function buildPack(src, opts = {}) {
  const brands = new Set(opts.brands ?? BRANDS);
  const maxBytes = opts.maxBytes ?? MAX_PACK_BYTES;
  const maxIndexBytes = opts.maxIndexBytes ?? MAX_INDEX_BYTES;
  const renamed = opts.renamed ?? RENAMED;
  const dropped = opts.dropped ?? DROPPED;

  const sets = [];
  const entries = [];
  const byName = new Map();
  const samples = new Map();
  const blobs = [];
  let blobOffset = 0;
  const report = {};

  for (const set of SETS) {
    const root = join(src, FOLDERS[set.id]);
    if (!existsSync(root)) {
      report[set.id] = { left: "folder missing" };
      continue;
    }
    const stats = newStats();
    const style = STYLES[set.id];
    const setIndex = sets.length;
    sets.push({ ...set, notice: NOTICES[set.id]?.(root) ?? "", style, changes: CHANGES[set.id] });
    const { icons, aliases } = COLLECT[set.id](root, stats, brands);
    for (const icon of icons) {
      if (!NAME.test(icon.name)) {
        stats.badName.push(icon.name);
        continue;
      }
      if (set.id === "lucide" && reserved(icon.name)) {
        stats.reserved.push(icon.name);
        continue;
      }
      if (byName.has(icon.name)) {
        stats.duplicate.push(icon.name);
        continue;
      }
      const file = relative(src, icon.file);
      const bytes = readFileSync(icon.file);
      const why = unsafeReason(bytes);
      if (why) {
        (stats.unsafe[why] ??= []).push(file);
        continue;
      }
      const text = UTF8.decode(bytes);
      const framed = frameRoot(text, {
        pad: PAD[set.id],
        stroke: set.id === "lucide" ? STROKE : undefined,
        ink: style === "colour" ? undefined : style,
      });
      if ("refused" in framed) {
        (stats.unframed[framed.refused] ??= []).push(framed.head === undefined ? file : `${file} ${JSON.stringify(framed.head)}`);
        continue;
      }
      const out = Buffer.from(framed.svg, "utf8");
      const whyFramed = unsafeReason(out);
      if (whyFramed) {
        (stats.unsafe[`framed: ${whyFramed}`] ??= []).push(file);
        continue;
      }
      // The Core serves the icon with ` color="<ink>"` at inkAt; that text must pass too.
      const whyInked =
        framed.inkAt === null
          ? null
          : [INK_LIGHT, INK_DARK].map((ink) => unsafeReason(inked(out, framed.inkAt, ink))).find(Boolean);
      if (whyInked) {
        (stats.unsafe[`inked: ${whyInked}`] ??= []).push(file);
        continue;
      }
      const packed = deflateRawSync(out, { level: 9 });
      const entry = [icon.name, setIndex, icon.title.trim(), blobOffset, packed.length, icon.licence ?? null, null, framed.inkAt];
      if (icon.hex) entry.push(icon.hex);
      blobs.push(packed);
      blobOffset += packed.length;
      stats.bytes += packed.length;
      byName.set(icon.name, entry);
      // The drawing after the root tag is what framing promises not to touch (icon_drawing_unchanged).
      const drawing = text.slice(rootTag(text).end);
      samples.set(icon.name, { drawingSha256: createHash("sha256").update(drawing, "utf8").digest("hex"), file });
      entries.push(entry);
      stats.packed++;
    }
    for (const [alias, target] of aliases) {
      const hit = byName.get(target);
      if (!hit || byName.has(alias) || hit[1] !== setIndex) {
        if (!byName.has(alias)) stats.missedAliases.push(`${alias} -> ${target}`);
        continue;
      }
      const entry = aliasRow(alias, hit);
      byName.set(alias, entry);
      samples.set(alias, samples.get(target));
      entries.push(entry);
      stats.aliases++;
    }
    report[set.id] = stats;
  }

  for (const [old, next] of Object.entries(renamed)) {
    if (byName.has(old)) {
      report[sets[byName.get(old)[1]].id].warnings.push(`renamed ${old} -> ${next}, but ${old} is still in the pack`);
      continue;
    }
    const hit = byName.get(next);
    if (!hit) throw new Error(`renamed to a name not in the pack: ${old} -> ${next}`);
    if (!NAME.test(old)) throw new Error(`renamed name not allowed: ${old} (bad name)`);
    if (sets[hit[1]].id === "lucide" && reserved(old)) throw new Error(`renamed name not allowed: ${old} (reserved prefix)`);
    const entry = aliasRow(old, hit);
    byName.set(old, entry);
    samples.set(old, samples.get(next));
    entries.push(entry);
    report[sets[hit[1]].id].renamed.push(`${old} -> ${next}`);
  }

  for (const [name, why] of Object.entries(dropped)) {
    const hit = byName.get(name);
    if (hit) report[sets[hit[1]].id].warnings.push(`dropped ${name} (${why}), but ${name} is still in the pack`);
  }

  if (opts.previous) {
    const before = readPackIndex(opts.previous);
    const gone = [];
    for (const row of before.icons) {
      const name = row[0];
      if (byName.has(name)) continue;
      if (Object.hasOwn(dropped, name)) {
        const id = before.sets[row[1]]?.id ?? "unknown";
        ((report[id] ??= newStats()).dropped ??= []).push(`${name} (${dropped[name]})`);
      } else gone.push(name);
    }
    if (gone.length) throw new Error(`names gone from the previous pack: ${gone.join(", ")}`);
  }

  const indexJson = Buffer.from(JSON.stringify({ version: 2, sets, icons: entries }), "utf8");
  if (indexJson.length >= maxIndexBytes) {
    throw new Error(`the index is ${indexJson.length} bytes unpacked, over the ${maxIndexBytes} byte cap`);
  }
  const index = deflateRawSync(indexJson, { level: 9 });
  const head = Buffer.alloc(12);
  head.write(MAGIC, 0, "ascii");
  head.writeUInt32LE(index.length, 8);
  const pack = Buffer.concat([head, index, ...blobs]);
  if (pack.length >= maxBytes) throw new Error(`the pack is ${pack.length} bytes, over the ${maxBytes} byte cap`);
  return { pack, report, samples, indexBytes: indexJson.length };
}

/** A general (unprefixed) name that starts with a provider prefix and `-`. */
function reserved(name) {
  return RESERVED.some((prefix) => name.startsWith(`${prefix}-`));
}

/** The icon as the Core serves it in `ink`: ` color="<ink>"` inserted at the byte offset `at`. */
function inked(svg, at, ink) {
  return Buffer.concat([svg.subarray(0, at), Buffer.from(` color="${ink}"`, "utf8"), svg.subarray(at)]);
}

/** An alias row: the target's blob, licence, ink offset and colour, under another name. */
function aliasRow(alias, target) {
  return [alias, target[1], target[2], target[3], target[4], target[5], target[6] ?? target[0], target[7], ...target.slice(8)];
}

/** Each theme's text ink and the canvas an icon draws on (ICON_INK and ICON_BG in src/flow/icons.ts). */
const INKS = { light: [INK_LIGHT, "#f8f4e3"], dark: [INK_DARK, "#21222c"] };

/** WCAG 2.x relative luminance of `#rrggbb`. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * How a logo of colour `hex` draws on `theme`, as `inkFor` in src/flow/icons.ts chooses it (a test keeps them
 * equal): its colour down to 1.5:1 on the canvas; below that, on light its colour with a hairline, on dark the ink.
 */
export function brandInk(hex, theme) {
  const [ink, paper] = INKS[theme];
  const [a, b] = [luminance(hex), luminance(paper)];
  if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 1.5) return { ink: hex, outline: false };
  return theme === "light" ? { ink: hex, outline: true } : { ink, outline: false };
}

/** The canvas's `icon-hairline` (flow-canvas.css), in `theme`'s text ink. */
const hairline = (theme) => `filter:${`drop-shadow(0 0 0.3px ${INKS[theme][0]}) `.repeat(3).trim()}`;
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * A contact sheet for tuning PAD: one row per set with its first `limit` icons at 24 px, inked light
 * and dark as the app asks the Core for them (a logo in its colour where it reads), on each theme's
 * canvas, Lucide's `database` first in every row as the yardstick.
 */
export function contactSheet(bytes, { limit = 40 } = {}) {
  const pack = asBuffer(bytes);
  const { sets, icons } = readPackIndex(pack);
  const blobs = pack.subarray(12 + pack.readUInt32LE(8));
  const img = (row, theme) => {
    let svg = inflateRawSync(blobs.subarray(row[3], row[3] + row[4]));
    const { ink, outline } = row[8] ? brandInk(row[8], theme) : { ink: INKS[theme][0], outline: false };
    if (row[7] !== null && row[7] !== undefined) svg = inked(svg, row[7], ink);
    const style = outline ? ` style="${hairline(theme)}"` : "";
    return `<img width="24" height="24" title="${escapeHtml(row[0])}" alt=""${style} src="data:image/svg+xml;base64,${svg.toString("base64")}">`;
  };
  const yardstick = icons.find((row) => row[0] === "database" && row[6] == null);
  const lines = sets.map((set, setIndex) => {
    const own = icons.filter((row) => row[1] === setIndex && row[6] == null && row !== yardstick).slice(0, limit);
    const shown = yardstick ? [yardstick, ...own] : own;
    const cells = Object.entries(INKS).map(
      ([theme, [, paper]]) => `<td style="background:${paper}">${shown.map((row) => img(row, theme)).join("")}</td>`,
    );
    return `<tr><th>${escapeHtml(set.id)} (pad ${escapeHtml(PAD[set.id] === undefined ? "?" : `${Number((PAD[set.id] * 24).toFixed(2))}/24`)})</th>${cells.join("")}</tr>`;
  });
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Icon contact sheet</title>` +
    `<style>body{font:13px system-ui,sans-serif;margin:16px}th{text-align:left;padding-right:12px}` +
    `td{padding:8px;line-height:0}img{margin:2px}</style></head><body><table>\n${lines.join("\n")}\n</table></body></html>\n`
  );
}

function printReport(report, packBytes, indexBytes) {
  for (const [id, stats] of Object.entries(report)) {
    if (stats.left) {
      console.log(`${id}: left out (${stats.left})`);
      continue;
    }
    const counted = (groups) =>
      Object.entries(groups)
        .map(([why, files]) => `${why} ${files.length}`)
        .join(", ") || "none";
    console.log(
      `${id}: ${stats.packed} icons (${stats.bytes} bytes), ${stats.aliases} aliases, ${stats.duplicate.length} duplicate names, ` +
        `${stats.reserved.length} reserved, unsafe: ${counted(stats.unsafe)}, unframed: ${counted(stats.unframed)}, ` +
        `own licence: ${stats.ownLicence.length}`,
    );
    for (const files of Object.values(stats.unsafe)) for (const f of files) console.log(`  unsafe ${f}`);
    for (const [why, files] of Object.entries(stats.unframed)) for (const f of files) console.log(`  unframed (${why}) ${f}`);
    const lists = [
      ["bad name", stats.badName],
      ["reserved prefix, left out", stats.reserved],
      ["duplicate name, left out", stats.duplicate],
      ["own licence, left out", stats.ownLicence],
      ["no brand colour, left out", stats.noColour],
      ["alias without a target", stats.missedAliases],
      ["renamed, kept as alias", stats.renamed],
      ["dropped from the previous pack", stats.dropped],
    ];
    for (const [label, list] of lists) if (list.length) console.log(`  ${label}: ${list.join(", ")}`);
    for (const warning of stats.warnings) console.log(`  warning: ${warning}`);
  }
  console.log(`index: ${indexBytes} bytes unpacked, ${MAX_INDEX_BYTES - indexBytes} bytes under the ${MAX_INDEX_BYTES} byte cap`);
  console.log(`headroom under the ${MAX_PACK_BYTES} byte cap: ${MAX_PACK_BYTES - packBytes} bytes`);
}

function main() {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--previous" || args[i] === "--sheet") {
      if (args[i + 1] === undefined) bad = true;
      flags[args[i].slice(2)] = args[++i];
    } else if (args[i].startsWith("--")) bad = true;
    else positional.push(args[i]);
  }
  const [srcArg, outArg] = positional;
  if (bad || !srcArg || positional.length > 2) {
    console.error("usage: node scripts/pack-icons.mjs <source folder> [out file] [--previous <pack>] [--sheet <file.html>]");
    process.exit(2);
  }
  const src = resolve(srcArg);
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(outArg ?? join(here, "..", "src-tauri", "icons-pack", "icons.bin"));
  const previousFile = flags.previous ? resolve(flags.previous) : existsSync(out) ? out : null;

  let built;
  try {
    built = buildPack(src, { previous: previousFile ? readFileSync(previousFile) : null });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { pack, report, samples, indexBytes } = built;
  printReport(report, pack.length, indexBytes);
  if (previousFile) console.log(`every name of ${previousFile} still resolves`);
  for (const sample of process.env.PACK_SAMPLES?.split(",") ?? []) {
    const hit = samples.get(sample);
    if (hit) console.log(`sample ${sample} drawing-sha256 ${hit.drawingSha256} ${hit.file}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  // Write beside, then rename: `out` is also the default previous pack, so a crash mid-write
  // must not leave it half written.
  writeFileSync(`${out}.tmp`, pack);
  renameSync(`${out}.tmp`, out);
  console.log(`${readPackIndex(pack).icons.length} names, ${pack.length} bytes -> ${out}`);
  if (flags.sheet) {
    const sheet = resolve(flags.sheet);
    writeFileSync(sheet, contactSheet(pack));
    console.log(`contact sheet -> ${sheet}`);
  }
}

/** True when this file is the script node was started with, not an import. */
function isEntryPoint() {
  try {
    return realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
