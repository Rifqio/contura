import { expect, test } from "vitest";
import type { SchemaModel, SmColumn, SmTable } from "../api/types";
import { tableKey } from "../lang/protocol";
import appCss from "../styles/app.css?raw";
import { autoLayout, CARD_FOOTER, CARD_HEADER, CARD_ROW, CARD_WIDTH, cardHeight } from "./layout";

const column = (name: string): SmColumn => ({
  name,
  typeName: "integer",
  pk: false,
  increment: false,
  notNull: false,
  unique: false,
  default: null,
  note: null,
});

const table = (name: string, columns: number): SmTable => ({
  schema: "public",
  name,
  alias: null,
  note: null,
  columns: Array.from({ length: columns }, (_, i) => column(`c${i}`)),
  indexes: [],
});

function fixture(): SchemaModel {
  const tables = Array.from({ length: 12 }, (_, i) => table(`t${i}`, 2 + ((i * 3) % 8)));
  const refs = [
    [1, 0], [2, 0], [3, 0], [4, 1], [5, 1], [6, 2], [7, 3], [8, 3], [9, 4], [10, 5], [11, 5], [11, 9],
  ].map(([a, b]) => ({
    name: null,
    from: { schema: "public", table: `t${a}`, columns: ["c0"] },
    to: { schema: "public", table: `t${b}`, columns: ["c0"] },
    onDelete: null,
    onUpdate: null,
  }));
  return { dialect: "postgres", tables, refs, enums: [], skipped: [] };
}

test("card_size_constants_are_the_brief_values", () => {
  expect([CARD_WIDTH, CARD_HEADER, CARD_ROW, CARD_FOOTER]).toEqual([216, 32, 24, 8]);
  expect(cardHeight(3)).toBe(32 + 24 * 3 + 8);
});

test("no_two_cards_overlap", async () => {
  const model = fixture();
  const layout = await autoLayout(model, { version: 1, tables: {} });
  const rects = model.tables.map((t) => {
    const p = layout.tables[tableKey(t)];
    return { name: t.name, x: p.x, y: p.y, w: CARD_WIDTH, h: cardHeight(t.columns.length) };
  });
  expect(rects).toHaveLength(12);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.name} and ${b.name} overlap`).toBe(true);
    }
  }
});

test("css_matches_layout_constants", () => {
  const block = (selector: string) => {
    const m = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(appCss);
    expect(m, `${selector} rule`).not.toBeNull();
    return m![1];
  };
  expect(block(".table-card")).toMatch(/\bwidth:\s*216px/);
  expect(block(".table-card-header")).toMatch(/\bheight:\s*32px/);
  expect(block(".table-card-column")).toMatch(/\bheight:\s*24px/);
});
