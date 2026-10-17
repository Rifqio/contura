import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Selection } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import DefinitionView from "./DefinitionView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const closeDay: Selection = {
  connectionId: "c1",
  kind: "procedure",
  path: { database: "shop", schema: null, name: "close_day" },
};

test("shows_the_loading_line_then_the_definition", async () => {
  let finish: (text: string) => void = () => {};
  routeInvoke({ object_definition: () => new Promise<string>((resolve) => (finish = resolve)) });
  render(<DefinitionView selection={closeDay} onClose={() => {}} onNotOpen={() => {}} />);
  expect(screen.getByText("Loading the definition…")).toBeTruthy();
  finish("CREATE PROCEDURE close_day() BEGIN END");
  expect(await screen.findByText("CREATE PROCEDURE close_day() BEGIN END")).toBeTruthy();
  expect(screen.queryByText("Loading the definition…")).toBeNull();
  expect(callsTo("object_definition")).toEqual([
    { id: "c1", kind: "procedure", path: { database: "shop", schema: null, name: "close_day" } },
  ]);
});

test("a_not_open_error_calls_on_not_open_and_shows_the_error", async () => {
  routeInvoke({
    object_definition: () => {
      throw { kind: "notFound", message: "connection not open" };
    },
  });
  const onNotOpen = vi.fn();
  render(<DefinitionView selection={closeDay} onClose={() => {}} onNotOpen={onNotOpen} />);
  expect((await screen.findByRole("alert")).textContent).toBe("This Connection is not open. Open it again to continue.");
  expect(onNotOpen).toHaveBeenCalledTimes(1);
});
