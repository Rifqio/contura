import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import tokensCss from "../styles/tokens.css?raw";
import type { IconEntry } from "../api/types";
import { ICON_BG, ICON_CACHE_SIZE, ICON_INK, contrastRatio, iconCacheSize, iconNames, iconOutline, iconUrl, inkFor, loadIcon, resetIcons, sendIconNames, setIconTheme, useIcon } from "./icons";

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
      { name: "brand-postgresql", set: "simple", title: "PostgreSQL", licence: null, aliasOf: null, hex: "#4169e1" },
      { name: "brand-ink", set: "simple", title: "Ink", licence: null, aliasOf: null, hex: "#000000" },
      { name: "brand-paper", set: "simple", title: "Paper", licence: null, aliasOf: null, hex: "#ffffff" },
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
  // The index is read once, for the logos' colours, not once per icon.
  expect(callsTo("icon_index")).toHaveLength(1);
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

test("the_inks_are_the_theme_text_colours", () => {
  const found = [...tokensCss.matchAll(/--c-text:\s*(#[0-9a-f]{6});/gi)].map((m) => m[1].toLowerCase());
  // The light block comes first, then the dark block (and the system-dark copy of it).
  expect(found[0]).toBe(ICON_INK.light);
  expect(found[1]).toBe(ICON_INK.dark);
  expect(ICON_INK).toEqual({ light: "#1f1f1f", dark: "#f8f8f2" });
});

const inkOf = (i: number) => callsTo("icon")[i].ink;
const decodedSrc = (img: HTMLElement) => decodeURIComponent((img.getAttribute("src") ?? "").split(",")[1]);

test("a_theme_switch_redraws_icons_in_the_new_ink", async () => {
  routeInvoke({ icon: ({ name, ink }) => `<svg xmlns="http://www.w3.org/2000/svg"><title>${name}</title><g stroke="${ink}"/></svg>` });
  render(<Tile name="database" />);
  const img = await screen.findByRole("img");
  expect(inkOf(0)).toBe("#1f1f1f");
  expect(decodedSrc(img)).toContain('stroke="#1f1f1f"');
  act(() => setIconTheme("dark"));
  await waitFor(() => expect(decodedSrc(screen.getByRole("img"))).toContain('stroke="#f8f8f2"'));
  expect(inkOf(1)).toBe("#f8f8f2");
  // Back to light: the dark copies were dropped, so the light ink is fetched again once.
  act(() => setIconTheme("light"));
  await waitFor(() => expect(decodedSrc(screen.getByRole("img"))).toContain('stroke="#1f1f1f"'));
  expect(callsTo("icon")).toHaveLength(3);
  for (let i = 0; i < 300; i++) await loadIcon(`distinct-${i}`);
  expect(iconCacheSize()).toBeLessThanOrEqual(ICON_CACHE_SIZE);
});

test("a_theme_switch_keeps_the_old_image_until_the_new_ink_arrives", async () => {
  render(<Tile name="database" />);
  const first = (await screen.findByRole("img")).getAttribute("src");
  let release: (v: string) => void = () => {};
  routeInvoke({ icon: () => new Promise<string>((r) => (release = r)) });
  act(() => setIconTheme("dark"));
  // Nothing blinks: the old image stays while the dark one loads.
  expect(screen.getByRole("img").getAttribute("src")).toBe(first);
  await waitFor(() => expect(callsTo("icon")).toHaveLength(2));
  expect(screen.getByRole("img").getAttribute("src")).toBe(first);
  await act(async () => release(svg("database-dark")));
  await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).not.toBe(first));
});

test("a_theme_switch_drops_the_other_themes_icons", async () => {
  await loadIcon("a");
  await loadIcon("b");
  expect(iconCacheSize()).toBe(2);
  act(() => setIconTheme("dark"));
  expect(iconCacheSize()).toBe(0);
  await loadIcon("a");
  expect(iconCacheSize()).toBe(1);
  // A publish load for the other theme is kept until the screen theme changes, and asks once.
  await loadIcon("a", "light");
  await loadIcon("a", "light");
  expect(callsTo("icon")).toHaveLength(4);
});

test("the_icon_names_go_to_the_worker_once_per_engine", async () => {
  const sent: string[][] = [];
  const client = { setFlowIcons: (names: string[]) => sent.push(names) };
  await Promise.all([sendIconNames(client), sendIconNames(client)]);
  await sendIconNames(client);
  expect(sent).toEqual([["aws-s3", "database", "brand-postgresql", "brand-ink", "brand-paper"]]);
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
  expect(await iconNames()).toEqual(["aws-s3", "database", "brand-postgresql", "brand-ink", "brand-paper"]);
  expect(await iconNames()).toEqual(["aws-s3", "database", "brand-postgresql", "brand-ink", "brand-paper"]);
  expect(callsTo("icon_index")).toHaveLength(1);
});

const entry = (name: string, hex?: string): IconEntry => ({ name, set: hex ? "simple" : "lucide", title: name, licence: null, aliasOf: null, hex });

test("contrast_ratio_matches_wcag", () => {
  expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
  expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
  expect(contrastRatio("#4169e1", "#4169e1")).toBe(1);
  // WCAG's own example: #777777 on white is about 4.48.
  expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
});

test("brand_colour_when_it_reads", async () => {
  const pg = entry("brand-postgresql", "#4169e1");
  expect(contrastRatio("#4169e1", ICON_BG.light)).toBeGreaterThanOrEqual(1.5);
  expect(contrastRatio("#4169e1", ICON_BG.dark)).toBeGreaterThanOrEqual(1.5);
  expect(inkFor(pg, "light")).toEqual({ ink: "#4169e1", outline: false });
  expect(inkFor(pg, "dark")).toEqual({ ink: "#4169e1", outline: false });
  // The loader asks the Core for the logo in its colour; the cache key stays theme and name.
  await loadIcon("brand-postgresql");
  expect(callsTo("icon")[0]).toEqual({ name: "brand-postgresql", ink: "#4169e1" });
  expect(iconUrl("brand-postgresql", "light")).not.toBeNull();
  await loadIcon("brand-postgresql");
  expect(callsTo("icon")).toHaveLength(1);
});

test("logos_keep_their_colour_down_to_1_5", () => {
  // Greys either side of 1.5:1 on each canvas, found by the ratio, not guessed.
  const greys = Array.from({ length: 256 }, (_, i) => `#${i.toString(16).padStart(2, "0").repeat(3)}`);
  for (const t of ["light", "dark"] as const) {
    const above = greys.filter((g) => contrastRatio(g, ICON_BG[t]) >= 1.5 && contrastRatio(g, ICON_BG[t]) < 1.6);
    const below = greys.filter((g) => contrastRatio(g, ICON_BG[t]) < 1.5 && contrastRatio(g, ICON_BG[t]) > 1.4);
    expect(above.length).toBeGreaterThan(0);
    expect(below.length).toBeGreaterThan(0);
    for (const g of above) expect(inkFor(entry("brand-grey", g), t)).toEqual({ ink: g, outline: false });
    for (const g of below)
      expect(inkFor(entry("brand-grey", g), t)).toEqual(t === "light" ? { ink: g, outline: true } : { ink: "#f8f8f2", outline: false });
  }
});

test("pale_logos_keep_their_colour_with_a_hairline_on_light", () => {
  for (const hex of ["#f7df1e", "#fff000", "#ffffff"]) {
    expect(contrastRatio(hex, ICON_BG.light)).toBeLessThan(1.5);
    expect(inkFor(entry("brand-pale", hex), "light")).toEqual({ ink: hex, outline: true });
    // On dark they read, so they are drawn as they are.
    expect(inkFor(entry("brand-pale", hex), "dark")).toEqual({ ink: hex, outline: false });
  }
});

test("faint_brand_colour_falls_back_on_dark", async () => {
  expect(inkFor(entry("brand-ink", "#000000"), "dark")).toEqual({ ink: "#f8f8f2", outline: false });
  expect(inkFor(entry("brand-ink", "#000000"), "light")).toEqual({ ink: "#000000", outline: false });
  for (const t of ["light", "dark"] as const) {
    expect(inkFor(entry("database"), t)).toEqual({ ink: ICON_INK[t], outline: false });
    expect(inkFor(undefined, t)).toEqual({ ink: ICON_INK[t], outline: false });
  }
  setIconTheme("dark");
  await loadIcon("brand-ink");
  expect(callsTo("icon")[0]).toEqual({ name: "brand-ink", ink: "#f8f8f2" });
});

function Outline({ name }: { name: string }) {
  const { url, outline } = useIcon(name);
  return <span data-testid="outline">{`${url ? "url" : "none"} ${outline}`}</span>;
}

test("a_pale_logo_is_outlined_on_light_only", async () => {
  render(<Outline name="brand-paper" />);
  await waitFor(() => expect(screen.getByTestId("outline").textContent).toBe("url true"));
  expect(callsTo("icon")[0]).toEqual({ name: "brand-paper", ink: "#ffffff" });
  expect(iconOutline("brand-paper", "light")).toBe(true);
  act(() => setIconTheme("dark"));
  await waitFor(() => expect(screen.getByTestId("outline").textContent).toBe("url false"));
  expect(iconOutline("brand-paper", "dark")).toBe(false);
  // Other icons are never outlined.
  expect(iconOutline("database", "light")).toBe(false);
  expect(iconOutline("brand-postgresql", "light")).toBe(false);
});

test("the_icon_backgrounds_are_the_tokens", () => {
  // A loaded icon draws bare, straight on the canvas (fnode-tile-bare, icon-picker-tile is-bare).
  const found = [...tokensCss.matchAll(/--c-bg-canvas:\s*(#[0-9a-f]{6});/gi)].map((m) => m[1].toLowerCase());
  expect(found[0]).toBe(ICON_BG.light);
  expect(found[1]).toBe(ICON_BG.dark);
  expect(ICON_BG).toEqual({ light: "#f8f4e3", dark: "#21222c" });
});
