import { expect, test } from "vitest";
import { completeDbml } from "./complete";
import { inspectDbml } from "./inspect";
import { parseDbml } from "./parse";
import { DBML_TEMPLATES } from "./templates";
import { DIALECT_TYPES } from "../dialectTypes";
import type { FromWorker } from "../protocol";
import { createHandler } from "../worker";

const BASE = "Table stores {\n  id integer [pk]\n  name varchar(80)\n}\nTable orders {\n  id bigint\n  store_id integer\n}\n";

test("type_completion_uses_model_dialect", () => {
  const text = "Table t {\n  at time\n}";
  const pos = text.indexOf("time") + 4;
  const pg = completeDbml(text, pos, null, "postgres");
  expect(pg.from).toBe(text.indexOf("time"));
  expect(pg.items.map((i) => i.label)).toContain("timestamptz");
  expect(pg.items.every((i) => i.kind === "type")).toBe(true);
  const my = completeDbml(text, pos, null, "mysql");
  expect(my.items.map((i) => i.label)).not.toContain("timestamptz");
});

test("ref_completion_lists_table_columns", () => {
  const model = parseDbml(BASE, "mysql").model;
  const text = `${BASE}Ref: orders.store_id > st`;
  const r = completeDbml(text, text.length, model, "mysql");
  expect(r.from).toBe(text.length - 2);
  expect(r.items.map((i) => i.label)).toEqual(["stores.id", "stores.name"]);
  expect(r.items[0]).toMatchObject({ kind: "column", detail: "integer", apply: "stores.id" });
});

test("settings_completion_inside_brackets", () => {
  const text = "Table t {\n  id integer [p";
  const r = completeDbml(text, text.length, null, "mysql");
  expect(r.items.map((i) => i.label)).toEqual(["pk"]);
});

test("templates_offered_at_top_level", () => {
  const text = "Ta";
  const r = completeDbml(text, 2, null, "mysql");
  expect(r.items).toEqual([expect.objectContaining({ label: "Table", kind: "template" })]);
});

test("missing_ref_column_suggests_nearest", () => {
  const good = parseDbml(BASE, "mysql").model;
  const text = `${BASE}Ref: orders.store_idd > stores.id\n`;
  const out = parseDbml(text, "mysql");
  const [d] = inspectDbml(text, out.diagnostics, good);
  expect(d.message).toBe("Unknown column orders.store_idd");
  expect(d.fixes[0].title).toBe("Did you mean store_id?");
  const [e] = d.fixes[0].edits;
  expect(text.slice(e.from, e.to)).toBe("store_idd");
  expect(e.insert).toBe("store_id");
});

test("missing_ref_table_suggests_nearest", () => {
  const good = parseDbml(BASE, "mysql").model;
  const text = `${BASE}Ref: orders.store_id > storez.id\n`;
  const out = parseDbml(text, "mysql");
  const [d] = inspectDbml(text, out.diagnostics, good);
  expect(d.message).toBe("Unknown table storez");
  expect(d.fixes.map((f) => f.title)).toEqual(["Did you mean stores?"]);
});

test("worker_adds_did_you_mean_from_last_valid", () => {
  const posted: FromWorker[] = [];
  const handle = createHandler((m) => posted.push(m), 0);
  handle({ type: "update", id: 1, docId: "d", text: BASE, dialect: "mysql" });
  handle({ type: "update", id: 2, docId: "d", text: `${BASE}Ref: orders.store_idd > stores.id\n`, dialect: "mysql" });
  const last = posted[1];
  expect(last.type === "result" && last.result.diagnostics[0].fixes[0].title).toBe("Did you mean store_id?");
});

test("templates_have_fields", () => {
  expect(DBML_TEMPLATES.map((t) => t.name)).toEqual(["Table", "Ref", "Enum"]);
  expect(DBML_TEMPLATES[0].body).toContain("${1:");
});

test("dialect_types_cover_three_dialects", () => {
  expect(DIALECT_TYPES.postgres).toContain("timestamptz");
  expect(DIALECT_TYPES.mysql).toContain("varchar(255)");
  expect(DIALECT_TYPES.sqlite).toEqual(["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"]);
});
