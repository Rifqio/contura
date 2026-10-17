import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { GROUP_COLORS, type ConnectionConfig, type Group } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import GroupForm from "./GroupForm";
import { GroupImagesProvider } from "./GroupBadge";
import { squarePng } from "./groupImage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./groupImage", async (original) => ({
  ...(await original<typeof import("./groupImage")>()),
  squarePng: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

const orbit: Group = { id: "g1", name: "Orbit Freight", color: "indigo", hasImage: false };
const conn = (over: Partial<ConnectionConfig>): ConnectionConfig => ({
  id: "c1",
  name: "freight-prod",
  dialect: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: "g1",
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
  ...over,
});
const three = [
  conn({ production: true }),
  conn({ id: "c2", name: "shop-staging" }),
  conn({ id: "c3", name: "freight-reporting", readOnly: true }),
];

function setup(group: Group | undefined, over: Partial<Parameters<typeof GroupForm>[0]> = {}, cache = new Map<string, string>()) {
  const handlers = { onSaved: vi.fn(), onDeleted: vi.fn(), onCancel: vi.fn() };
  const set = vi.fn();
  render(
    <GroupImagesProvider value={{ images: cache, set }}>
      <GroupForm group={group} connections={group ? three : []} {...handlers} {...over} />
    </GroupImagesProvider>,
  );
  return { ...handlers, set };
}

const swatches = () => screen.getAllByRole("radio").filter((r) => !r.classList.contains("swatch-none"));

test("new_and_edit_share_one_form", () => {
  const { unmount } = render(<GroupForm connections={[]} onSaved={() => {}} onDeleted={() => {}} onCancel={() => {}} />);
  expect(screen.getByRole("heading", { name: "New Group" })).toBeTruthy();
  expect(screen.getByLabelText("Name")).toBeTruthy();
  expect(screen.getByRole("radiogroup", { name: "Colour" })).toBeTruthy();
  expect(screen.getByText("Preview")).toBeTruthy();
  expect(screen.getByText("No Connections yet")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Create Group/ }).textContent).toContain("Enter");
  expect(screen.queryByRole("button", { name: /Delete Group/ })).toBeNull();
  unmount();
  setup(orbit);
  expect(screen.getByRole("heading", { name: "Edit Group" })).toBeTruthy();
  expect(document.querySelector(".dialog-subtitle")!.textContent).toBe("Orbit Freight");
  expect(screen.getByLabelText("Name")).toBeTruthy();
  expect(screen.getByRole("radiogroup", { name: "Colour" })).toBeTruthy();
  expect(screen.getByText("3 Connections")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Save/ }).textContent).toContain("Ctrl+S");
  const names = Array.from(document.querySelectorAll(".dialog-footer button")).map((b) => b.textContent);
  expect(names[0]).toBe("Delete Group...");
});

test("swatches_carry_the_initial_and_no_colour_is_the_ringed_square", () => {
  setup(orbit);
  expect(swatches().map((r) => r.getAttribute("data-colour"))).toEqual(GROUP_COLORS);
  expect(swatches().every((r) => r.textContent === "O")).toBe(true);
  expect(swatches()[1].getAttribute("aria-checked")).toBe("true");
  expect(swatches()[0].getAttribute("title")).toBe("cyan");
  const none = screen.getByRole("radio", { name: "No colour" });
  expect(none.querySelector(".group-badge-empty")).toBeTruthy();
  expect(none.textContent).toBe("No colour");
});

test("initial_follows_the_name", async () => {
  setup(undefined);
  await userEvent.type(screen.getByLabelText("Name"), "pinecone Labs");
  expect(swatches().every((r) => r.textContent === "P")).toBe(true);
  const preview = document.querySelector(".group-preview") as HTMLElement;
  expect(within(preview).getAllByText("P")).toHaveLength(2);
  expect(preview.textContent).toContain("pinecone Labs");
});

test("arrow_keys_move_between_swatches", async () => {
  setup(orbit);
  swatches()[1].focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(swatches()[2].getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(swatches()[2]);
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(swatches()[0].getAttribute("aria-checked")).toBe("true");
  await userEvent.keyboard("{ArrowLeft}");
  expect(swatches()[7].getAttribute("aria-checked")).toBe("true");
});

test("image_flow_crops_and_sends_png", async () => {
  vi.mocked(squarePng).mockResolvedValue(new Uint8Array([1, 2, 3]));
  routeInvoke({
    save_group: () => orbit,
    set_group_image: () => ({ ...orbit, hasImage: true }),
  });
  const { onSaved, set } = setup(orbit);
  const file = new File([new Uint8Array(10)], "orbit-logo.png", { type: "image/png" });
  await userEvent.upload(screen.getByLabelText("Choose image"), file);
  expect(await screen.findByText("orbit-logo.png")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Change\.\.\./ })).toBeTruthy();
  expect(callsTo("set_group_image")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(callsTo("set_group_image")).toEqual([{ id: "g1", png: "AQID" }]);
  expect(set).toHaveBeenCalledWith("g1", "data:image/png;base64,AQID");
});

test("an_undecodable_file_shows_the_reason", async () => {
  vi.mocked(squarePng).mockRejectedValue(new Error("bad"));
  setup(orbit);
  await userEvent.upload(screen.getByLabelText("Choose image"), new File(["nope"], "x.png", { type: "image/png" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Contura could not read that image.");
  expect(screen.queryByText("x.png")).toBeNull();
});

test("a_file_over_1_mb_is_refused_before_reading", async () => {
  setup(orbit);
  const big = new File([new Uint8Array(1_048_577)], "big.png", { type: "image/png" });
  await userEvent.upload(screen.getByLabelText("Choose image"), big);
  expect((await screen.findByRole("alert")).textContent).toContain("Choose an image up to 1 MB.");
  expect(squarePng).not.toHaveBeenCalled();
});

test("remove_returns_to_the_letter_square", async () => {
  routeInvoke({ save_group: () => ({ ...orbit, hasImage: true }), clear_group_image: () => orbit });
  const url = "data:image/png;base64,AAAA";
  const { onSaved, set } = setup({ ...orbit, hasImage: true }, {}, new Map([["g1", url]]));
  expect(document.querySelector(".group-preview img")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /Remove/ }));
  expect(document.querySelector(".group-preview img")).toBeNull();
  expect(within(document.querySelector(".group-preview") as HTMLElement).getAllByText("O")).toHaveLength(2);
  await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(callsTo("clear_group_image")).toEqual([{ id: "g1" }]);
  expect(set).toHaveBeenCalledWith("g1", null);
});

test("delete_group_dialog_names_the_moves", async () => {
  routeInvoke({ delete_group: () => null });
  const { onDeleted } = setup(orbit);
  await userEvent.click(screen.getByRole("button", { name: /Delete Group\.\.\./ }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.className).toContain("dialog-size-confirm");
  expect(within(dialog).getByRole("heading", { name: "Delete Orbit Freight?" })).toBeTruthy();
  expect(dialog.textContent).toContain(
    "Its 3 Connections move to Ungrouped. Nothing in the databases changes, and Saved Queries and Query History stay.",
  );
  const items = within(dialog).getAllByRole("listitem");
  expect(items.map((i) => i.textContent)).toEqual(["freight-prodPRODProduction", "shop-staging", "freight-reportingRead-only"]);
  expect(callsTo("delete_group")).toHaveLength(0);
  const del = within(dialog).getByRole("button", { name: "Delete Group" });
  expect(del.className).toContain("button-danger-fill");
  expect(within(dialog).getByRole("button", { name: /^Cancel/ }).textContent).toContain("Esc");
  await userEvent.click(del);
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(callsTo("delete_group")).toEqual([{ id: "g1" }]);
});

test("cancel_in_the_delete_dialog_returns_to_the_form", async () => {
  setup(orbit);
  await userEvent.click(screen.getByRole("button", { name: /Delete Group\.\.\./ }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Cancel/ }));
  expect(screen.getByRole("heading", { name: "Edit Group" })).toBeTruthy();
});

test("a_blocked_delete_deletes_nothing", async () => {
  routeInvoke({ delete_group: () => null });
  const { onDeleted } = setup(orbit, { onBeforeDelete: async () => false });
  await userEvent.click(screen.getByRole("button", { name: /Delete Group\.\.\./ }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete Group" }));
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete Group" })).toBeTruthy());
  expect(callsTo("delete_group")).toHaveLength(0);
  expect(onDeleted).not.toHaveBeenCalled();
});

test("ctrl_s_saves_an_edit", async () => {
  routeInvoke({ save_group: () => orbit });
  const { onSaved } = setup(orbit);
  await userEvent.type(screen.getByLabelText("Name"), "{Control>}s{/Control}");
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

test("an_empty_name_says_what_to_do", async () => {
  setup(undefined);
  await userEvent.click(screen.getByRole("button", { name: /^Create Group/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("Give the Group a name");
});

test("a_failed_image_step_does_not_create_a_second_group_on_retry", async () => {
  vi.mocked(squarePng).mockResolvedValue(new Uint8Array([1, 2, 3]));
  let fail = true;
  routeInvoke({
    save_group: ({ input }) => ({ id: "g9", name: (input as { name: string }).name, color: "teal", hasImage: false }),
    set_group_image: () => {
      if (fail) throw { kind: "storage", message: "disk full" };
      return { id: "g9", name: "Pine", color: "teal", hasImage: true };
    },
  });
  const onChanged = vi.fn();
  const { onSaved } = setup(undefined, { onChanged });
  await userEvent.type(screen.getByLabelText("Name"), "Pine");
  await userEvent.upload(screen.getByLabelText("Choose image"), new File([new Uint8Array(10)], "p.png", { type: "image/png" }));
  await screen.findByText("p.png");
  await userEvent.click(screen.getByRole("button", { name: /^Create Group/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("disk full");
  expect(onChanged).toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: /^Create Group/ }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const inputs = callsTo("save_group").map((c) => (c.input as { id: string | null }).id);
  expect(inputs).toEqual([null, "g9"]);
});
