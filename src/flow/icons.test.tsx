import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import { ICON_CACHE_SIZE, iconNames, iconPlate, iconUrl, loadIcon, resetIcons, sendIconNames, useIcon } from "./icons";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const svg = (name: string) => `<svg xmlns="http://www.w3.org/2000/svg"><title>${name}</title></svg>`;

beforeEach(() => {
  resetIcons();
  routeInvoke({
    icon: ({ name }) => {
      if (name === "aws-dynamdb") throw { kind: "notFound", message: "aws-dynamdb is not an icon" };
      return svg(name as string);
    },
    icon_index: () => [
      { name: "aws-s3", set: "aws", title: "S3", licence: null },
      { name: "database", set: "lucide", title: "database", licence: null },
    ],
  });
});

function Tile({ name }: { name: string }) {
  const { url, missing } = useIcon(name);
  if (missing) return <span data-testid={`missing-${name}`} />;
  return url ? <img alt={name} src={url} /> : null;
}

test("loads_only_used_icons", async () => {
  // A diagram with three icons, one of them on two nodes.
  render(
    <>
      <Tile name="aws-s3" />
      <Tile name="k8s-pod" />
      <Tile name="database" />
      <Tile name="aws-s3" />
    </>,
  );
  await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(4));
  expect(callsTo("icon").map((a) => a.name)).toEqual(["aws-s3", "k8s-pod", "database"]);
  expect(callsTo("icon_index")).toHaveLength(0);
});

test("an_icon_is_an_image_url_never_markup", async () => {
  render(<Tile name="k8s-pod" />);
  const img = await screen.findByRole("img");
  const src = img.getAttribute("src") ?? "";
  expect(src.startsWith("data:image/svg+xml")).toBe(true);
  expect(decodeURIComponent(src.slice(src.indexOf(",") + 1))).toBe(svg("k8s-pod"));
  expect(document.querySelector("svg")).toBeNull();
});

test("an_unknown_icon_is_missing", async () => {
  render(<Tile name="aws-dynamdb" />);
  expect(await screen.findByTestId("missing-aws-dynamdb")).toBeTruthy();
});

test("a_missing_name_is_remembered_for_the_session", async () => {
  expect(await loadIcon("aws-dynamdb")).toBeNull();
  expect(await loadIcon("aws-dynamdb")).toBeNull();
  render(<Tile name="aws-dynamdb" />);
  expect(await screen.findByTestId("missing-aws-dynamdb")).toBeTruthy();
  expect(callsTo("icon")).toHaveLength(1);
});

function Status({ name }: { name: string | null }) {
  const { url, missing, failed } = useIcon(name);
  return <span data-testid="status">{`${url ? "url" : "none"} ${missing} ${failed}`}</span>;
}

test("another_error_is_not_missing_and_is_tried_again", async () => {
  routeInvoke({
    icon: () => {
      throw { kind: "file", message: "the icon pack is damaged: no header" };
    },
  });
  render(<Status name="aws-s3" />);
  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("none false true"));
  await expect(loadIcon("aws-s3")).rejects.toMatchObject({ kind: "file" });
  expect(callsTo("icon")).toHaveLength(2);
});

test("lru_evicts_the_oldest_at_201", async () => {
  expect(ICON_CACHE_SIZE).toBe(200);
  for (let i = 0; i < 200; i++) await loadIcon(`icon-${i}`);
  // Using icon-0 again makes icon-1 the oldest.
  await loadIcon("icon-0");
  expect(callsTo("icon")).toHaveLength(200);
  await loadIcon("icon-200");
  expect(iconUrl("icon-1")).toBeNull();
  expect(iconUrl("icon-0")).not.toBeNull();
  expect(iconUrl("icon-200")).not.toBeNull();
  await loadIcon("icon-1");
  expect(callsTo("icon")).toHaveLength(202);
});

test("the_light_plate_is_for_general_and_brand_icons_only", () => {
  // Lucide and brand logos draw black inside an <img>; provider icons bring their own coloured square (frame 6+.5).
  for (const n of ["users", "database", "brand-postgresql", "queue"]) expect(iconPlate(n), n).toBe(true);
  for (const n of ["aws-s3", "azure-sql", "gcp-bigquery", "gcp-category-compute", "k8s-pod"]) expect(iconPlate(n), n).toBe(false);
});

test("the_icon_names_go_to_the_worker_once_per_engine", async () => {
  const sent: string[][] = [];
  const client = { setFlowIcons: (names: string[]) => sent.push(names) };
  await Promise.all([sendIconNames(client), sendIconNames(client)]);
  await sendIconNames(client);
  expect(sent).toEqual([["aws-s3", "database"]]);
  expect(callsTo("icon_index")).toHaveLength(1);
  // A failed read is not kept: the next tab asks again.
  resetIcons();
  routeInvoke({ icon_index: () => Promise.reject({ kind: "file", message: "damaged" }) });
  const other = { setFlowIcons: (names: string[]) => sent.push(names) };
  expect(await sendIconNames(other)).toBe(false);
  routeInvoke({ icon_index: () => [{ name: "users", set: "lucide", title: "users", licence: null }] });
  expect(await sendIconNames(other)).toBe(true);
  expect(sent[sent.length - 1]).toEqual(["users"]);
});

test("a_null_name_loads_nothing", async () => {
  render(<Status name={null} />);
  expect(screen.getByTestId("status").textContent).toBe("none false false");
  await Promise.resolve();
  expect(callsTo("icon")).toHaveLength(0);
});

test("iconNames_reads_the_index_once", async () => {
  expect(await iconNames()).toEqual(["aws-s3", "database"]);
  expect(await iconNames()).toEqual(["aws-s3", "database"]);
  expect(callsTo("icon_index")).toHaveLength(1);
});
