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

test("the_flow_editor_language_completes_through_the_shared_client", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { CompletionContext } = await import("@codemirror/autocomplete");
  const { flowEditorLanguage } = await import("./appLang");
  const text = 'diagram dfd "A"\nRefunds [';
  const state = EditorState.create({ doc: text, extensions: flowEditorLanguage("app-lang-test") });
  const source = state.languageDataAt<(c: InstanceType<typeof CompletionContext>) => unknown>("autocomplete", text.length)[0];
  const r = (await source(new CompletionContext(state, text.length, false))) as { options: { label: string }[] } | null;
  expect(r?.options.map((o) => o.label).slice(0, 3)).toEqual(["entity", "process", "store"]);
});
