import { invoke } from "@tauri-apps/api/core";
import { expect, test, vi } from "vitest";
import {
  deleteDiagram,
  errorText,
  listDiagrams,
  readDiagram,
  renameDiagram,
  saveDiagramCopy,
  writeDiagram,
  writeDiagramLayout,
} from "./client";
import type { DiagramEntry } from "./types";

test("listDiagrams_asks_for_the_folder", async () => {
  const entries: DiagramEntry[] = [
    { name: "checkout", kind: "dfd", title: "Checkout", modifiedMs: 1 },
  ];
  vi.mocked(invoke).mockResolvedValueOnce(entries);
  expect(await listDiagrams()).toEqual(entries);
  expect(invoke).toHaveBeenLastCalledWith("list_diagrams");
});

test("readDiagram_sends_the_name", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    text: "diagram dfd",
    layout: null,
  });
  expect(await readDiagram("checkout")).toEqual({
    text: "diagram dfd",
    layout: null,
  });
  expect(invoke).toHaveBeenLastCalledWith("read_diagram", { name: "checkout" });
});

test("writeDiagramLayout_sends_only_the_name_and_layout", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await writeDiagramLayout("checkout", "{}");
  expect(invoke).toHaveBeenLastCalledWith("write_diagram_layout", { name: "checkout", layout: "{}" });
});

test("writeDiagram_sends_the_name_text_layout_and_overwrite", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await writeDiagram("checkout", "t", "{}", false);
  expect(invoke).toHaveBeenLastCalledWith("write_diagram", {
    name: "checkout",
    text: "t",
    layout: "{}",
    overwrite: false,
  });
});

test("deleteDiagram_and_renameDiagram_send_the_names", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  await deleteDiagram("checkout");
  expect(invoke).toHaveBeenLastCalledWith("delete_diagram", {
    name: "checkout",
  });
  await renameDiagram("checkout", "payment");
  expect(invoke).toHaveBeenLastCalledWith("rename_diagram", {
    from: "checkout",
    to: "payment",
  });
});

test("saveDiagramCopy_sends_the_text_layout_and_path", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await saveDiagramCopy("t", "{}", "C:\\out\\checkout.flow");
  expect(invoke).toHaveBeenLastCalledWith("save_diagram_copy", {
    text: "t",
    layout: "{}",
    path: "C:\\out\\checkout.flow",
  });
});

test("diagramExists_names_the_file", () => {
  expect(
    errorText({ kind: "diagramExists", message: { name: "checkout" } }),
  ).toBe("checkout.flow already exists.");
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));
