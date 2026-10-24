import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ModelDoc } from "../schema/SchemaBuilder";
import type { WorkTab } from "../shell/tabs";
import { useWorkspaceTabs } from "./useWorkspaceTabs";

const query = (id: string): WorkTab => ({
  kind: "query",
  doc: { id, name: id, text: "", connectionId: null, database: null, savedId: null, savedText: null },
});
const model = { path: null, dbml: "", savedDbml: "", layout: {}, dialect: "postgres", source: "blank", connectionId: null } as unknown as ModelDoc;

describe("useWorkspaceTabs", () => {
  it("close_key_activates_the_right_neighbour_else_the_left", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => {
      result.current.setTabs([query("a"), query("b"), query("c")]);
      result.current.setActiveKey("query:b");
    });
    act(() => result.current.closeKey("query:b"));
    expect(result.current.tabs.map((t) => (t.kind === "query" ? t.doc.id : ""))).toEqual(["a", "c"]);
    expect(result.current.activeKey).toBe("query:c");
    act(() => result.current.closeKey("query:c"));
    expect(result.current.activeKey).toBe("query:a");
    act(() => result.current.showHome());
    act(() => result.current.closeKey("query:a"));
    expect(result.current.activeKey).toBe("home");
    act(() => result.current.closeKey("home"));
    expect(result.current.windowTabs).toEqual([]);
    expect(result.current.allTabs).toEqual([]);
    expect(result.current.activeKey).toBeNull();
  });

  it("show_home_adds_one_home_tab_and_if_idle_keeps_the_active_tab", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => {
      result.current.setTabs([query("a")]);
      result.current.setActiveKey("query:a");
    });
    act(() => result.current.showHome(true));
    expect(result.current.windowTabs).toEqual([{ kind: "home" }]);
    expect(result.current.activeKey).toBe("query:a");
    act(() => result.current.showHome());
    expect(result.current.windowTabs).toEqual([{ kind: "home" }]);
    expect(result.current.activeKey).toBe("home");
    act(() => result.current.setActiveKey(null));
    act(() => result.current.showHome(true));
    expect(result.current.activeKey).toBe("home");
  });

  it("show_place_returns_to_the_last_place_tab", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.showPlace());
    expect(result.current.activeKey).toBeNull();
    act(() => {
      result.current.setTabs([query("a"), query("b")]);
      result.current.setActiveKey("query:b");
    });
    expect(result.current.lastPlaceKey.current).toBe("query:b");
    act(() => result.current.showHome());
    expect(result.current.activeKey).toBe("home");
    act(() => result.current.showPlace());
    expect(result.current.activeKey).toBe("query:b");
    act(() => result.current.setActiveKey("home"));
    result.current.lastPlaceKey.current = null;
    act(() => result.current.showPlace());
    expect(result.current.activeKey).toBe("query:a");
  });

  it("a_closed_schema_tab_takes_its_close_with_it", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openSchemaTab({ kind: "schema", id: "m1", doc: model }));
    expect(result.current.activeKey).toBe("schema:m1");
    const ref = result.current.schemaClose("m1");
    expect(result.current.schemaClose("m1")).toBe(ref);
    const close = () => Promise.resolve(true);
    ref.current = close;
    expect(result.current.schemaCloseFor("m1")).toBe(close);
    act(() => result.current.closeKey("schema:m1"));
    expect(result.current.schemaCloseFor("m1")).toBeNull();
    expect(result.current.schemaClose("m1")).not.toBe(ref);
  });
});
