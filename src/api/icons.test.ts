import { invoke } from "@tauri-apps/api/core";
import { expect, test, vi } from "vitest";
import { icon, iconIndex, iconSets } from "./client";
import type { IconEntry, IconSet } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

test("iconIndex_asks_for_the_names", async () => {
  const entries: IconEntry[] = [{ name: "aws-s3", set: "aws", title: "Amazon Simple Storage Service", licence: null, aliasOf: null }];
  vi.mocked(invoke).mockResolvedValueOnce(entries);
  expect(await iconIndex()).toEqual(entries);
  expect(invoke).toHaveBeenLastCalledWith("icon_index");
});

test("iconSets_asks_for_the_credits", async () => {
  const sets: IconSet[] = [
    { id: "lucide", title: "Lucide", licence: "ISC", source: "https://lucide.dev/license", note: "", notice: "", style: "outline", changes: "" },
  ];
  vi.mocked(invoke).mockResolvedValueOnce(sets);
  expect(await iconSets()).toEqual(sets);
  expect(invoke).toHaveBeenLastCalledWith("icon_sets");
});

test("icon_sends_the_name_and_ink", async () => {
  vi.mocked(invoke).mockResolvedValueOnce("<svg/>");
  expect(await icon("k8s-pod")).toBe("<svg/>");
  expect(invoke).toHaveBeenLastCalledWith("icon", { name: "k8s-pod", ink: null });
  vi.mocked(invoke).mockResolvedValueOnce("<svg/>");
  await icon("database", "#f8f8f2");
  expect(invoke).toHaveBeenLastCalledWith("icon", { name: "database", ink: "#f8f8f2" });
});
