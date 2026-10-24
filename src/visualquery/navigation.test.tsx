import { render } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, SqlSchema, VisualQuery } from "../api/types";
import DiagramCanvas from "../diagram/DiagramCanvas";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import type { VisualTabDoc } from "../shell/tabs";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { emptyQuery } from "./model";
import VisualQueryTab from "./VisualQueryTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// What the canvas hands React Flow is its navigation model; jsdom cannot wheel, so the props are the proof.
const seen: Record<string, unknown>[] = [];
vi.mock("@xyflow/react", async (orig) => {
  const m = await orig<typeof import("@xyflow/react")>();
  const Real = m.ReactFlow;
  return {
    ...m,
    ReactFlow: (p: Record<string, unknown>) => {
      seen.push(p);
      return <Real {...(p as object)} />;
    },
  };
});

patientFile();
beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
beforeEach(() => {
  seen.length = 0;
  routeInvoke({ visual_query_sql: () => ({ query: { sql: "SELECT 1", parts: [], outputs: [], warnings: [] }, problems: [] }) });
});

const last = () => seen[seen.length - 1];
const kestrel: ConnectionConfig = {
  id: "c1", name: "k", dialect: "mysql", host: "h", port: 1, user: "u", database: "shop", ssl: { mode: "disable" },
  file: null, groupId: null, queryTimeoutSecs: null, aiAccess: "schema", production: false, readOnly: false,
};
const SCHEMA: SqlSchema = { searchPath: [], tables: [], fks: [] };

function Tab() {
  const client = new LangClient(() => fakeWorker());
  const lang = { client, schemas: new SchemaCache(client, () => Promise.resolve(SCHEMA)) };
  const [doc, setDoc] = useState<VisualTabDoc>({
    id: "v1", name: "q", connectionId: "c1", database: "shop", model: emptyQuery("shop", "mysql") as VisualQuery, savedId: null, savedJson: null,
  });
  return (
    <ToastProvider>
      <div style={{ width: 1200, height: 800 }}>
        <VisualQueryTab doc={doc} connection={kestrel} open group={null} visible lang={lang} rowEstimate={() => null} onChange={setDoc}
          onOpenInEditor={() => {}} onSaved={() => {}} onOpenConnection={() => {}} />
      </div>
    </ToastProvider>
  );
}

test("v2_the_visual_query_canvas_gets_the_flow_navigation_config", () => {
  render(<Tab />);
  const p = last();
  // Drag on empty canvas draws a box; only the middle button pans by drag; Space pans (React Flow's default key).
  expect(p.selectionOnDrag).toBe(true);
  expect(p.panOnDrag).toEqual([1]);
  expect(p.panActivationKeyCode).toBeUndefined();
  // The wheel pans; Ctrl+wheel and pinch still zoom (zoomOnScroll stays on, the Ctrl key switches it).
  expect(p.panOnScroll).toBe(true);
  expect(p.zoomOnScroll).not.toBe(false);
  expect(p.zoomOnPinch).not.toBe(false);
  expect(p.zoomActivationKeyCode).toBeUndefined();
  // No double-click zoom.
  expect(p.zoomOnDoubleClick).toBe(false);
  // Delete is the model's own (one undo step), never React Flow's.
  expect(p.deleteKeyCode).toBeNull();
});

test("v2_the_flow_canvas_keeps_its_config_and_other_canvases_keep_their_defaults", () => {
  const base = { nodes: [], edges: [], nodeTypes: {} };
  render(<DiagramCanvas {...base} boxSelect onPaneDoubleClick={() => {}} />);
  const flow = last();
  expect(flow).toMatchObject({ selectionOnDrag: true, panOnDrag: [1], panOnScroll: true, zoomOnDoubleClick: false });
  seen.length = 0;
  // A canvas without an add menu used to zoom on double-click; boxSelect canvases no longer do.
  render(<DiagramCanvas {...base} boxSelect />);
  expect(last().zoomOnDoubleClick).toBe(false);
  seen.length = 0;
  // Not a box-select canvas (schema model, lineage): unchanged.
  render(<DiagramCanvas {...base} />);
  const plain = last();
  expect(plain.zoomOnDoubleClick).toBe(true);
  expect(plain.selectionOnDrag).toBeUndefined();
  expect(plain.panOnScroll).toBeUndefined();
});
