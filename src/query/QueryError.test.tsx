import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import { mockEditorDom } from "../test/editor";
import QueryError from "./QueryError";

beforeAll(mockEditorDom);

const base = {
  statementIndex: 2,
  line: 8,
  column: 6,
  dialect: "mysql" as const,
  message: "Table 'shop.shipment' doesn't exist",
  notRun: [] as { from: number; to: number; text: string }[],
  names: [] as string[],
  lost: false,
  onGoTo: () => {},
  onCopy: () => {},
  onReconnect: () => {},
};

test("server_message_is_shown_as_sent", () => {
  render(<QueryError {...base} />);
  expect(screen.getByText("Statement 2 failed")).toBeTruthy();
  expect(screen.getByText("Line 8, Col 6")).toBeTruthy();
  expect(screen.getByText("MySQL said")).toBeTruthy();
  const msg = document.querySelector(".query-error-message");
  expect(msg?.textContent).toBe("Table 'shop.shipment' doesn't exist");
  expect(msg?.tagName).toBe("CODE");
});

test("did_you_mean_only_with_a_near_name", () => {
  const { unmount } = render(<QueryError {...base} names={["shipments", "carriers"]} />);
  expect(document.querySelector(".query-error-near")?.textContent).toBe("There is no table named shipment in shop. Did you mean shipments?");
  unmount();
  render(<QueryError {...base} names={["customers"]} />);
  expect(screen.queryByText(/Did you mean/)).toBeNull();
});

test("statements_after_the_failure_are_listed_as_not_run", () => {
  const { unmount } = render(<QueryError {...base} />);
  expect(screen.queryByText(/Not run/)).toBeNull();
  unmount();
  render(<QueryError {...base} notRun={[{ from: 30, to: 40, text: "SELECT 3" }]} />);
  expect(screen.getByText("Not run, because statement 2 failed")).toBeTruthy();
  expect(document.querySelector(".sql-block")?.textContent).toContain("SELECT 3");
});

test("copy_error_copies_number_line_and_message", async () => {
  const onCopy = vi.fn();
  const onGoTo = vi.fn();
  render(<QueryError {...base} onCopy={onCopy} onGoTo={onGoTo} />);
  await userEvent.click(screen.getByRole("button", { name: "Copy error" }));
  expect(onCopy).toHaveBeenCalledWith("Statement 2, line 8: Table 'shop.shipment' doesn't exist");
  await userEvent.click(screen.getByRole("button", { name: "Go to line 8" }));
  expect(onGoTo).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Ask AI" })).toBeNull();
});

test("connection_lost_variant", async () => {
  const onReconnect = vi.fn();
  render(
    <QueryError
      {...base}
      lost
      connectionName="KFC Postgres"
      earlierResult={1}
      notRun={[{ from: 30, to: 40, text: "SELECT 3" }]}
      onReconnect={onReconnect}
    />,
  );
  expect(screen.getByText("Lost the connection to KFC Postgres")).toBeTruthy();
  expect(
    screen.getByText("KFC Postgres is closed now. Statements 2 and 3 did not run. Statement 1 ran and its rows are in Result 1."),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /Reconnect and run statement 2/ }));
  expect(onReconnect).toHaveBeenCalled();
  expect(screen.queryByText("MySQL said")).toBeNull();
});

/** Frame 2: normal title text with a red icon, one red box with PostgreSQL said and the SQLSTATE, icons on the actions. */
test("frame_2_layout", () => {
  render(
    <QueryError
      {...base}
      dialect="postgres"
      message='relation "shipment" does not exist'
      names={["shipments", "shipment_events"]}
      tableNames={["shipments", "shipment_events"]}
      scope="shop.public"
      notRun={[{ from: 300, to: 360, text: "SELECT count(*) FROM shipments" }]}
      lineOf={() => 12}
      onAsk={() => {}}
    />,
  );
  const head = document.querySelector(".query-error-head")!;
  expect(head.querySelector(".query-error-icon")).toBeTruthy();
  const box = document.querySelector(".query-error-said")!;
  expect(box.querySelector(".query-error-source")?.textContent).toBe("PostgreSQL said");
  // R40: PostgreSQL's message carries no code, so there is no chip.
  expect(box.querySelector(".query-error-code")).toBeNull();
  expect(box.querySelector(".query-error-message")?.textContent).toBe('relation "shipment" does not exist');
  expect(box.querySelector(".query-error-quoted")?.textContent).toBe('"shipment"');
  const near = document.querySelector(".query-error-near")!;
  expect(near.textContent).toBe("There is no table named shipment in shop.public. Did you mean shipments?");
  expect(near.querySelector("svg")).toBeTruthy();
  expect(document.querySelector(".query-error-notrun .sql-block-gutter")?.textContent).toBe("12");
  for (const name of ["Go to line 8", "Ask AI", "Copy error"]) expect(screen.getByRole("button", { name }).querySelector("svg")).toBeTruthy();
});

/** R40: a MySQL message that carries its SQLSTATE shows it, without the transport wrapping. */
test("mysql_sqlstate_from_the_message_shows_as_the_chip", () => {
  render(<QueryError {...base} message="Server error: `ERROR 1146 (42S02): Table 'shop.shipment' doesn't exist'" names={["shipments"]} />);
  expect(document.querySelector(".query-error-source")?.textContent).toBe("MySQL said");
  expect(document.querySelector(".query-error-code")?.textContent).toBe("42S02");
  expect(document.querySelector(".query-error-message")?.textContent).toBe("Table 'shop.shipment' doesn't exist");
});
