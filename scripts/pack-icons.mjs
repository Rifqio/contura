// Packs the cloud icon sets into src-tauri/icons-pack/icons.bin (step 6+, C1b).
//
//   node scripts/pack-icons.mjs <source folder> [out file]
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
// A missing folder leaves that set out. Icons are copied byte for byte: never recoloured,
// cropped, rotated or rewritten. An SVG that fails the safety check (svg-check.mjs,
// Rulings P7, P9 and P10: an allow list) is left out and counted.
//
// Format (all integers little endian):
//   "CTRICON1"                magic, 8 bytes
//   u32                       length of the compressed index
//   index                     raw deflate of UTF-8 JSON:
//                             { version: 1, sets: [{ id, title, licence, source, note, notice }],
//                               icons: [[name, setIndex, title, offset, length, licence?], ...] }
//   blobs                     each icon raw-deflated on its own; offset counts from the
//                             first byte after the index, so the Core inflates one icon
//                             per call. Aliases share their target's blob.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { unsafeReason } from "./svg-check.mjs";

const MAX_PACK_BYTES = 4 * 1024 * 1024;

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

// Simple Icons holds over 3,000 brands, about 2 MB packed, which does not fit the 4 MB pack
// beside the cloud sets. These are the software, data and infrastructure brands an
// architecture diagram draws; a slug Simple Icons has removed is skipped.
const BRANDS = new Set([
  "mysql", "postgresql", "sqlite", "mariadb", "mongodb", "redis", "elasticsearch", "opensearch",
  "apachecassandra", "cockroachlabs", "neo4j", "influxdb", "clickhouse", "snowflake", "databricks",
  "apachekafka", "rabbitmq", "apachepulsar", "natsdotio", "apachespark", "apacheflink",
  "apacheairflow", "apachehadoop", "duckdb", "supabase", "firebase", "planetscale", "neon",
  "prisma", "timescale", "couchbase", "trino", "presto", "docker", "kubernetes", "helm",
  "terraform", "ansible", "pulumi", "vault", "hashicorp", "consul", "nomad", "packer", "vagrant",
  "nginx", "apache", "apachetomcat", "caddy", "traefikproxy", "envoyproxy", "istio", "linkerd",
  "cloudflare", "fastly", "akamai", "vercel", "netlify", "digitalocean", "vultr", "hetzner", "ovh",
  "alibabacloud", "openstack", "github", "gitlab", "bitbucket", "git", "jenkins", "circleci",
  "travisci", "githubactions", "argo", "spinnaker", "tekton", "jfrog", "sonatype", "npm", "pnpm",
  "yarn", "pypi", "gradle", "prometheus", "grafana", "datadog", "newrelic", "sentry", "splunk",
  "elastic", "kibana", "logstash", "fluentd", "fluentbit", "jaeger", "opentelemetry", "pagerduty",
  "opsgenie", "statuspage", "nodedotjs", "deno", "bun", "python", "go", "rust", "openjdk",
  "kotlin", "scala", "dotnet", "php", "ruby", "swift", "typescript", "javascript", "elixir",
  "erlang", "haskell", "clojure", "cplusplus", "c", "lua", "perl", "r", "dart", "flutter", "react",
  "vuedotjs", "angular", "svelte", "nextdotjs", "nuxt", "remix", "astro", "vite", "webpack",
  "express", "nestjs", "fastify", "django", "flask", "fastapi", "rubyonrails", "laravel", "spring",
  "springboot", "quarkus", "graphql", "apollographql", "swagger", "openapiinitiative", "postman",
  "insomnia", "kong", "auth0", "okta", "keycloak", "stripe", "paypal", "mailgun", "mailchimp",
  "discord", "zoom", "jira", "confluence", "notion", "trello", "asana", "linear", "figma",
  "anthropic", "huggingface", "tensorflow", "pytorch", "langchain", "ollama", "jupyter", "pandas",
  "numpy", "apachesuperset", "metabase", "looker", "redash", "airbyte", "mixpanel",
  "googleanalytics", "algolia", "meilisearch", "minio", "ceph", "cloudinary", "contentful",
  "strapi", "sanity", "wordpress", "shopify", "sap", "hubspot", "zapier", "n8n", "linux", "ubuntu",
  "debian", "redhat", "centos", "alpinelinux", "macos", "apple", "android", "ios", "raspberrypi",
  "arduino", "celery", "temporal", "camunda", "wireguard", "openvpn", "tailscale", "letsencrypt",
  "1password", "bitwarden",
]);

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
  simple(root, stats) {
    const data = JSON.parse(readFileSync(join(root, "package", "data", "simple-icons.json"), "utf8"));
    const icons = [];
    for (const entry of data) {
      if (!entry.slug || !BRANDS.has(entry.slug)) continue;
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
      icons.push({ file, name: `brand-${slug(entry.slug)}`, title: entry.title, licence });
    }
    return { icons, aliases: [] };
  },
};

// The licence text each set asks to travel with its copies, shown in Icon credits.
const NOTICES = {
  k8s: () =>
    "The Kubernetes Icons Set by the Kubernetes Authors, used unchanged under the Creative Commons " +
    "Attribution 4.0 International licence (https://creativecommons.org/licenses/by/4.0/).",
  lucide: (root) => readFileSync(join(root, "package", "LICENSE"), "utf8"),
  simple: () =>
    "Simple Icons is released under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). " +
    "CC0 waives no trademark rights: each logo belongs to its brand and is shown only to name that " +
    "product. Icons with a licence of their own carry it beside their name.",
};

const FOLDERS = { aws: "aws", azure: "azure", gcp: "gcp-core", k8s: "k8s", lucide: "lucide", simple: "simple" };

function main() {
  const [srcArg, outArg] = process.argv.slice(2);
  if (!srcArg) {
    console.error("usage: node scripts/pack-icons.mjs <source folder> [out file]");
    process.exit(2);
  }
  const src = resolve(srcArg);
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(outArg ?? join(here, "..", "src-tauri", "icons-pack", "icons.bin"));

  const sets = [];
  const entries = [];
  const byName = new Map();
  const blobs = [];
  let blobOffset = 0;
  const report = {};

  for (const set of SETS) {
    const root = join(src, FOLDERS[set.id]);
    if (!existsSync(root)) {
      report[set.id] = { left: "folder missing" };
      continue;
    }
    const stats = { bytes: 0, packed: 0, aliases: 0, duplicate: 0, unsafe: {}, ownLicence: [], missedAliases: [] };
    const setIndex = sets.length;
    sets.push({ ...set, notice: NOTICES[set.id]?.(root) ?? "" });
    const { icons, aliases } = COLLECT[set.id](root, stats);
    for (const icon of icons) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(icon.name) || byName.has(icon.name)) {
        stats.duplicate++;
        continue;
      }
      const bytes = readFileSync(icon.file);
      const why = unsafeReason(bytes);
      if (why) {
        (stats.unsafe[why] ??= []).push(relative(src, icon.file));
        continue;
      }
      const packed = deflateRawSync(bytes, { level: 9 });
      const entry = [icon.name, setIndex, icon.title.trim(), blobOffset, packed.length];
      if (icon.licence) entry.push(icon.licence);
      blobs.push(packed);
      blobOffset += packed.length;
      stats.bytes += packed.length;
      byName.set(icon.name, { entry, sha256: createHash("sha256").update(bytes).digest("hex"), file: icon.file });
      entries.push(entry);
      stats.packed++;
    }
    for (const [alias, target] of aliases) {
      const hit = byName.get(target);
      if (!hit || byName.has(alias) || hit.entry[1] !== setIndex) {
        if (!byName.has(alias)) stats.missedAliases.push(`${alias} -> ${target}`);
        continue;
      }
      const entry = [alias, ...hit.entry.slice(1)];
      byName.set(alias, { ...hit, entry });
      entries.push(entry);
      stats.aliases++;
    }
    report[set.id] = stats;
  }

  const index = deflateRawSync(Buffer.from(JSON.stringify({ version: 1, sets, icons: entries }), "utf8"), {
    level: 9,
  });
  const head = Buffer.alloc(12);
  head.write("CTRICON1", 0, "ascii");
  head.writeUInt32LE(index.length, 8);
  const pack = Buffer.concat([head, index, ...blobs]);

  for (const [id, stats] of Object.entries(report)) {
    if (stats.left) {
      console.log(`${id}: left out (${stats.left})`);
      continue;
    }
    const unsafe = Object.entries(stats.unsafe)
      .map(([why, files]) => `${why} ${files.length}`)
      .join(", ");
    console.log(
      `${id}: ${stats.packed} icons (${stats.bytes} bytes), ${stats.aliases} aliases, ${stats.duplicate} duplicate names, ` +
        `unsafe: ${unsafe || "none"}, own licence: ${stats.ownLicence.length}`,
    );
    for (const files of Object.values(stats.unsafe)) for (const f of files) console.log(`  unsafe ${f}`);
    if (stats.ownLicence.length) console.log(`  own licence, left out: ${stats.ownLicence.join(", ")}`);
    if (stats.missedAliases.length) console.log(`  alias without a target: ${stats.missedAliases.join(", ")}`);
  }
  for (const sample of process.env.PACK_SAMPLES?.split(",") ?? []) {
    const hit = byName.get(sample);
    if (hit) console.log(`sample ${sample} sha256 ${hit.sha256} ${relative(src, hit.file)}`);
  }
  if (pack.length >= MAX_PACK_BYTES) {
    console.error(`the pack is ${pack.length} bytes, over 4 MB`);
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, pack);
  console.log(`${entries.length} names, ${statSync(out).size} bytes -> ${out}`);
}

main();
