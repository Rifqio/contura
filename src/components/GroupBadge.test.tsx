import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import type { GroupColor } from "../api/types";
import GroupBadge, { GroupImagesProvider } from "./GroupBadge";

test("a slot colour draws the initial on its group colour", () => {
  const { container } = render(<GroupBadge name="Kfc" color="indigo" />);
  const badge = container.querySelector(".group-badge") as HTMLElement;
  expect(badge.textContent).toBe("K");
  expect(badge.getAttribute("aria-hidden")).toBe("true");
  expect(badge.style.getPropertyValue("--group")).toBe("var(--c-group-indigo)");
  expect(badge.classList.contains("group-badge-empty")).toBe(false);
});

test("the larger size is marked for the Home cards", () => {
  const { container } = render(<GroupBadge name="Kfc" color="teal" size={20} />);
  expect(container.querySelector(".group-badge-20")).toBeTruthy();
});

test("unknown_colour_draws_the_empty_square", () => {
  const { container } = render(<GroupBadge name="Kfc" color={"red" as GroupColor} />);
  const badge = container.querySelector(".group-badge") as HTMLElement;
  expect(badge.classList.contains("group-badge-empty")).toBe(true);
  expect(badge.textContent).toBe("");
});

test("no colour draws the empty square", () => {
  const { container } = render(<GroupBadge name="Ungrouped" color={null} />);
  const badge = container.querySelector(".group-badge") as HTMLElement;
  expect(badge.classList.contains("group-badge-empty")).toBe(true);
  expect(badge.textContent).toBe("");
});

test("image_replaces_the_letter_square", () => {
  const url = "data:image/png;base64,AAAA";
  const { container } = render(<GroupBadge name="Kfc" color="indigo" image={url} />);
  const badge = container.querySelector(".group-badge") as HTMLElement;
  const img = badge.querySelector("img") as HTMLImageElement;
  expect(img.getAttribute("src")).toBe(url);
  expect(img.getAttribute("alt")).toBe("");
  expect(img.getAttribute("aria-hidden")).toBe("true");
  expect(badge.textContent).toBe("");
  const big = render(<GroupBadge name="Kfc" color="indigo" size={20} image={url} />);
  expect(big.container.querySelector(".group-badge-20 img")).toBeTruthy();
});

test("the_cache_supplies_the_image_by_group_id", () => {
  const url = "data:image/png;base64,BBBB";
  const { container } = render(
    <GroupImagesProvider value={{ images: new Map([["g1", url]]), set: () => {} }}>
      <GroupBadge id="g1" name="Kfc" color="indigo" />
    </GroupImagesProvider>,
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe(url);
});
