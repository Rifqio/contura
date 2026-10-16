import { expect, test, vi } from "vitest";
import { appLang } from "./appLang";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

test("the_app_has_one_language_client_for_its_lifetime", async () => {
  const a = appLang();
  expect(appLang()).toBe(a);
  // Still answering: nothing in the app disposes it.
  const r = await a.client.completeSql({ text: "SEL", pos: 3, dialect: "postgres", schemaKey: null, explicit: true });
  expect(r.items.map((i) => i.label)).toContain("SELECT");
});
