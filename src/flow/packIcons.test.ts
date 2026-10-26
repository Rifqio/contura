// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import {
  brandInk,
  buildPack,
  contactSheet,
  readPackIndex,
} from "../../scripts/pack-icons.mjs";
import { inkFor } from "./icons";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The app's tsconfig has no Node types, so the few Node calls this test makes are typed here.
interface NodeBuiltins {
  "node:fs": {
    mkdtempSync(prefix: string): string;
    mkdirSync(dir: string, opts: { recursive: true }): void;
    writeFileSync(file: string, text: string): void;
    rmSync(file: string, opts?: { recursive: true; force: true }): void;
  };
  "node:os": { tmpdir(): string };
  "node:path": {
    join(...parts: string[]): string;
    dirname(file: string): string;
  };
  "node:zlib": {
    inflateRawSync(bytes: Uint8Array): Uint8Array;
    deflateRawSync(bytes: Uint8Array): Uint8Array;
  };
}
const builtin = <K extends keyof NodeBuiltins>(id: K) =>
  (
    globalThis as unknown as {
      process: { getBuiltinModule(id: K): NodeBuiltins[K] };
    }
  ).process.getBuiltinModule(id);
const fs = builtin("node:fs");
const os = builtin("node:os");
const path = builtin("node:path");
const { inflateRawSync, deflateRawSync } = builtin("node:zlib");

const lucide = (name: string, inner = "") =>
  `<!-- @license lucide-static v1.61.0 - ISC -->\n<svg\n  class="lucide lucide-${name}"\n  xmlns="http://www.w3.org/2000/svg"\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  stroke="currentColor"\n  stroke-width="2"\n  stroke-linecap="round"\n  stroke-linejoin="round"\n>\n  <ellipse cx="12" cy="5" rx="9" ry="3"${inner} />\n</svg>\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function put(root: string, file: string, text: string) {
  const at = path.join(root, file);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, text);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-icons-"));
  dirs.push(root);
  for (const name of ["database", "aws-thing", "list-end"])
    put(root, `lucide/package/icons/${name}.svg`, lucide(name));
  put(root, "lucide/package/LICENSE", "ISC License\n");
  put(
    root,
    "simple/package/data/simple-icons.json",
    JSON.stringify([{ title: "PostgreSQL", slug: "postgresql", hex: "4169E1" }]),
  );
  put(
    root,
    "simple/package/icons/postgresql.svg",
    `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>PostgreSQL</title><path d="M0 0h24v24H0z"/></svg>`,
  );
  put(
    root,
    "aws/x/64/Arch_Amazon-Test_64.svg",
    `<svg width="80px" height="80px" viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><g><rect width="80" height="80" fill="#ED7100"/></g></svg>`,
  );
  return root;
}

const opts = { brands: ["postgresql"] };
type Row = [
  string,
  number,
  string,
  number,
  number,
  string | null,
  string | null,
  number | null,
  string?,
];
const rows = (pack: Uint8Array) => readPackIndex(pack).icons as Row[];
const row = (pack: Uint8Array, name: string) =>
  rows(pack).find((r) => r[0] === name);

test("a_pack_reads_back_with_framed_icons_and_ink_offsets", () => {
  const { pack } = buildPack(fixture(), opts);
  const index = readPackIndex(pack);
  expect(index.version).toBe(2);
  const blobs = pack.subarray(
    12 + new DataView(pack.buffer, pack.byteOffset).getUint32(8, true),
  );
  const inflate = (r: Row) => inflateRawSync(blobs.subarray(r[3], r[3] + r[4]));
  const db = row(pack, "database")!;
  expect(db[7]).not.toBeNull();
  expect(String.fromCharCode(inflate(db)[db[7]!])).toBe(">");
  expect(row(pack, "aws-test")![7]).toBeNull();
  const style = (id: string) =>
    (index.sets as { id: string; style: string }[]).find((s) => s.id === id)
      ?.style;
  expect([style("lucide"), style("simple"), style("aws")]).toEqual([
    "outline",
    "mono",
    "colour",
  ]);
  for (const r of rows(pack))
    expect(new TextDecoder().decode(inflate(r))).toContain(
      'width="24" height="24"',
    );
});

test("a_general_icon_may_not_take_a_provider_prefix", () => {
  const { pack, report } = buildPack(fixture(), opts);
  expect(row(pack, "aws-thing")).toBeUndefined();
  expect(report.lucide.reserved).toEqual(["aws-thing"]);
});

test("a_name_from_the_previous_pack_that_disappears_fails_the_build", () => {
  const root = fixture();
  const first = buildPack(root, opts).pack;
  fs.rmSync(path.join(root, "lucide/package/icons/database.svg"));
  expect(() => buildPack(root, { ...opts, previous: first })).toThrow(
    "names gone from the previous pack: database",
  );
});

test("a_renamed_icon_keeps_its_old_name_as_an_alias", () => {
  const root = fixture();
  const first = buildPack(root, opts).pack;
  fs.rmSync(path.join(root, "lucide/package/icons/database.svg"));
  const { pack } = buildPack(root, {
    ...opts,
    previous: first,
    renamed: { database: "list-end" },
  });
  const db = row(pack, "database")!;
  expect(db[6]).toBe("list-end");
  expect(db[3]).toBe(row(pack, "list-end")![3]);
});

test("a_dropped_icon_is_listed_not_silent", () => {
  const root = fixture();
  const first = buildPack(root, opts).pack;
  fs.rmSync(path.join(root, "lucide/package/icons/database.svg"));
  const { report } = buildPack(root, {
    ...opts,
    previous: first,
    dropped: { database: "removed upstream" },
  });
  expect(report.lucide.dropped).toEqual(["database (removed upstream)"]);
});

test("an_icon_the_framer_refuses_is_left_out_and_counted", () => {
  const root = fixture();
  put(
    root,
    "lucide/package/icons/thick.svg",
    lucide("thick", ' stroke-width="3"'),
  );
  const { pack, report } = buildPack(root, opts);
  expect(row(pack, "thick")).toBeUndefined();
  expect(report.lucide.unframed["stroke width inside"]).toHaveLength(1);
});

test("the_pack_cap_refuses_and_names_the_size", () => {
  expect(() => buildPack(fixture(), { ...opts, maxBytes: 200 })).toThrow(
    /over the 200 byte cap/,
  );
});

test("the_contact_sheet_puts_the_yardstick_first_in_every_row", () => {
  const html = contactSheet(buildPack(fixture(), opts).pack);
  const rowsOf = html.split("<tr").slice(1);
  expect(rowsOf.length).toBeGreaterThanOrEqual(3);
  for (const tr of rowsOf) expect(tr).toMatch(/<img[^>]*title="database"/);
  // Each theme's canvas, the logo in its colour where it reads.
  expect(html).toContain("background:#f8f4e3");
  expect(html).toContain("background:#21222c");
  const pg = /title="brand-postgresql"[^>]*src="data:image\/svg\+xml;base64,([^"]+)"/g;
  const inks = [...html.matchAll(pg)].map((m) => /color="([^"]+)"/.exec(atob(m[1]))?.[1]);
  expect(inks).toEqual([brandInk("#4169e1", "light").ink, brandInk("#4169e1", "dark").ink]);
  expect(html).not.toMatch(/<script/i);
});

const indexLength = (pack: Uint8Array) =>
  new DataView(pack.buffer, pack.byteOffset).getUint32(8, true);
const unpackedIndexBytes = (pack: Uint8Array) =>
  inflateRawSync(pack.subarray(12, 12 + indexLength(pack))).length;
const blobOf = (pack: Uint8Array, r: Row) => {
  const blobs = pack.subarray(12 + indexLength(pack));
  return new TextDecoder().decode(
    inflateRawSync(blobs.subarray(r[3], r[3] + r[4])),
  );
};

test("oci_and_net_are_reserved_too", () => {
  const root = fixture();
  for (const name of ["oci-thing", "net-thing", "network"])
    put(root, `lucide/package/icons/${name}.svg`, lucide(name));
  const { pack, report } = buildPack(root, opts);
  expect(report.lucide.reserved).toEqual([
    "aws-thing",
    "net-thing",
    "oci-thing",
  ]);
  expect(row(pack, "network")).toBeDefined();
});

test("the_first_icon_in_pack_order_keeps_a_clashing_name", () => {
  // Every set but Lucide has its own prefix and Lucide may not take one, so a clash is
  // within a set: AWS's 64 px service icon ranks before its 48 px resource icon.
  const root = fixture();
  put(
    root,
    "aws/y/Res_Amazon-Test_48.svg",
    `<svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect width="48" height="48" fill="#7AA116"/></svg>`,
  );
  const { pack, report } = buildPack(root, opts);
  expect(report.aws.duplicate).toEqual(["aws-test"]);
  expect(blobOf(pack, row(pack, "aws-test")!)).toContain("#ED7100");
});

/** Builds with frameRoot wrapped by `wrap`, from a fresh module graph. */
async function buildWithFramer(
  wrap: (out: { svg: string; inkAt: number | null }) => {
    svg: string;
    inkAt: number | null;
  },
  root: string,
) {
  vi.resetModules();
  vi.doMock("../../scripts/icon-frame.mjs", async () => {
    const real = await vi.importActual<
      typeof import("../../scripts/icon-frame.mjs")
    >("../../scripts/icon-frame.mjs");
    return {
      ...real,
      frameRoot: (text: string, rule: Parameters<typeof real.frameRoot>[1]) => {
        const out = real.frameRoot(text, rule);
        return "refused" in out || !text.includes("lucide-database")
          ? out
          : wrap(out);
      },
    };
  });
  try {
    const fresh = await import("../../scripts/pack-icons.mjs");
    return fresh.buildPack(root, opts);
  } finally {
    vi.doUnmock("../../scripts/icon-frame.mjs");
    vi.resetModules();
  }
}

test("an_icon_unsafe_after_framing_is_left_out_and_counted", async () => {
  const { pack, report } = await buildWithFramer(
    (out) => ({
      ...out,
      svg: out.svg.replace("<ellipse", "<script/><ellipse"),
    }),
    fixture(),
  );
  expect(row(pack, "database")).toBeUndefined();
  expect(report.lucide.unsafe["framed: element not allowed"]).toHaveLength(1);
});

test("an_icon_unsafe_once_inked_is_left_out_and_counted", async () => {
  // The framed bytes are safe, but an ink offset inside the class value breaks the tag.
  const { pack, report } = await buildWithFramer(
    (out) => ({
      ...out,
      inkAt: new TextEncoder().encode(
        out.svg.slice(0, out.svg.indexOf('class="') + 7),
      ).length,
    }),
    fixture(),
  );
  expect(row(pack, "database")).toBeUndefined();
  expect(Object.keys(report.lucide.unsafe)).toEqual(["inked: bad markup"]);
  expect(report.lucide.unsafe["inked: bad markup"]).toHaveLength(1);
});

/** A version 1 pack as the step 6+ script wrote it: no style, changes, aliasOf or inkAt. */
function v1Pack(names: string[]) {
  const index = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      sets: [
        {
          id: "lucide",
          title: "Lucide",
          licence: "ISC",
          source: "",
          note: "",
          notice: "",
        },
      ],
      icons: names.map((name) => [name, 0, name, 0, 1]),
    }),
  );
  const packed = deflateRawSync(index);
  const out = new Uint8Array(12 + packed.length + 1);
  out.set(new TextEncoder().encode("CTRICON1"));
  new DataView(out.buffer).setUint32(8, packed.length, true);
  out.set(packed, 12);
  return out;
}

test("a_version_1_pack_is_read_and_gates_the_build", () => {
  const old = v1Pack(["database", "gone-icon"]);
  const index = readPackIndex(old);
  expect(index.version).toBe(1);
  expect(index.icons.map((r) => r[0])).toEqual(["database", "gone-icon"]);
  const root = fixture();
  expect(() => buildPack(root, { ...opts, previous: old })).toThrow(
    "names gone from the previous pack: gone-icon",
  );
  expect(() =>
    buildPack(root, { ...opts, previous: v1Pack(["database", "queue"]) }),
  ).not.toThrow();
});

test("two_builds_are_byte_identical", () => {
  const root = fixture();
  expect(buildPack(root, opts).pack).toEqual(buildPack(root, opts).pack);
});

test("the_pack_cap_refuses_at_the_limit_and_passes_one_byte_under", () => {
  const root = fixture();
  const size = buildPack(root, opts).pack.length;
  expect(() => buildPack(root, { ...opts, maxBytes: size })).toThrow(
    `the pack is ${size} bytes, over the ${size} byte cap`,
  );
  expect(buildPack(root, { ...opts, maxBytes: size + 1 }).pack.length).toBe(
    size,
  );
});

test("the_index_cap_refuses_at_the_limit_and_passes_one_byte_under", () => {
  const root = fixture();
  const size = unpackedIndexBytes(buildPack(root, opts).pack);
  expect(() => buildPack(root, { ...opts, maxIndexBytes: size })).toThrow(
    `the index is ${size} bytes unpacked, over the ${size} byte cap`,
  );
  expect(() =>
    buildPack(root, { ...opts, maxIndexBytes: size + 1 }),
  ).not.toThrow();
});

test("a_logo_with_its_own_cc_by_sa_licence_carries_it_on_its_row", () => {
  const root = fixture();
  put(
    root,
    "simple/package/data/simple-icons.json",
    JSON.stringify([
      { title: "PostgreSQL", slug: "postgresql", hex: "4169E1" },
      {
        title: "Rust",
        slug: "rust",
        hex: "000000",
        license: { type: "CC-BY-SA-4.0", url: "https://example.org/rust-logo" },
      },
    ]),
  );
  put(
    root,
    "simple/package/icons/rust.svg",
    `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Rust</title><path d="M0 0h24v24H0z"/></svg>`,
  );
  const { pack } = buildPack(root, { brands: ["postgresql", "rust"] });
  expect(row(pack, "brand-rust")![5]).toBe(
    "CC-BY-SA-4.0, from https://example.org/rust-logo",
  );
  expect(row(pack, "brand-postgresql")![5]).toBeNull();
});

test("stale_renamed_and_dropped_entries_are_warned", () => {
  const { report } = buildPack(fixture(), {
    ...opts,
    renamed: { database: "list-end" },
    dropped: { "list-end": "removed upstream" },
  });
  expect(report.lucide.warnings).toEqual([
    "renamed database -> list-end, but database is still in the pack",
    "dropped list-end (removed upstream), but list-end is still in the pack",
  ]);
});

test("a_renamed_name_follows_the_name_rules", () => {
  const root = fixture();
  expect(() =>
    buildPack(root, { ...opts, renamed: { "Bad Name": "list-end" } }),
  ).toThrow("renamed name not allowed: Bad Name (bad name)");
  expect(() =>
    buildPack(root, { ...opts, renamed: { "oci-db": "list-end" } }),
  ).toThrow("renamed name not allowed: oci-db (reserved prefix)");
});

test("a_logo_carries_its_brand_colour_and_nothing_else_does", () => {
  const root = fixture();
  put(
    root,
    "simple/package/data/simple-icons.json",
    JSON.stringify([
      { title: "PostgreSQL", slug: "postgresql", hex: "4169E1" },
      { title: "No colour", slug: "nocolour" },
      { title: "Odd colour", slug: "oddcolour", hex: "41\"69E" },
    ]),
  );
  for (const slug of ["nocolour", "oddcolour"])
    put(
      root,
      `simple/package/icons/${slug}.svg`,
      `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>${slug}</title><path d="M0 0h24v24H0z"/></svg>`,
    );
  const { pack, report } = buildPack(root, {
    brands: ["postgresql", "nocolour", "oddcolour"],
  });
  expect(row(pack, "brand-postgresql")![8]).toBe("#4169e1");
  // A logo without a plain six digit colour is left out and listed.
  expect(row(pack, "brand-nocolour")).toBeUndefined();
  expect(row(pack, "brand-oddcolour")).toBeUndefined();
  expect(report.simple.noColour).toEqual(["nocolour", "oddcolour"]);
  // Every other row stops at inkAt.
  for (const r of rows(pack))
    if (!r[0].startsWith("brand-")) expect(r).toHaveLength(8);
});

test("a_renamed_logo_keeps_its_colour", () => {
  const root = fixture();
  const first = buildPack(root, opts).pack;
  const { pack } = buildPack(root, {
    ...opts,
    previous: first,
    renamed: { "brand-postgres": "brand-postgresql" },
  });
  expect(row(pack, "brand-postgres")![8]).toBe("#4169e1");
});

test("the_contact_sheet_inks_logos_as_the_app_does", () => {
  for (const hex of ["#4169e1", "#000000", "#ffffff", "#f7df1e", "#fff000", "#336791", "#7f7f7f", "#21222c", "#c0c0c0", "#3a3a3a"])
    for (const theme of ["light", "dark"] as const)
      expect(brandInk(hex, theme), `${hex} ${theme}`).toEqual(
        inkFor({ name: "brand-x", set: "simple", title: "X", licence: null, aliasOf: null, hex }, theme),
      );
});

test("the_contact_sheet_outlines_a_pale_logo_on_light_only", () => {
  const root = fixture();
  put(
    root,
    "simple/package/data/simple-icons.json",
    JSON.stringify([{ title: "Paper", slug: "paper", hex: "FFFFFF" }]),
  );
  put(
    root,
    "simple/package/icons/paper.svg",
    `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Paper</title><path d="M0 0h24v24H0z"/></svg>`,
  );
  const html = contactSheet(buildPack(root, { brands: ["paper"] }).pack);
  const paper = [...html.matchAll(/<img [^>]*title="brand-paper"[^>]*>/g)].map((m) => m[0]);
  expect(paper).toHaveLength(2);
  expect(paper[0]).toContain("filter:drop-shadow(0 0 0.3px #1f1f1f)");
  expect(paper[1]).not.toContain("filter");
  // Both keep the logo's own colour.
  for (const img of paper) expect(atob(/base64,([^"]+)"/.exec(img)![1])).toContain('color="#ffffff"');
});
