import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import IconCredits from "./IconCredits";
import { resetIcons } from "./icons";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const SETS = [
  {
    id: "aws",
    title: "AWS Architecture Icons",
    licence: "AWS terms: use these toolkits and assets to create architecture diagrams",
    source: "https://aws.amazon.com/architecture/icons/",
    note: "Release 07312026",
    notice: "",
    style: "colour",
    changes: "Fitted into a 24 by 24 frame with even margins; never redrawn or recoloured.",
  },
  {
    id: "lucide",
    title: "Lucide",
    licence: "ISC",
    source: "https://lucide.dev",
    note: "",
    notice: "ISC License\n\nCopyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 <b>as part of Feather</b>.",
    style: "outline",
    changes: "Fitted into a 24 by 24 frame and drawn at stroke 1.5 in the theme's text colour.",
  },
  { id: "simple", title: "Simple Icons", licence: "CC0-1.0", source: "https://simpleicons.org", note: "Brand logos are trademarks of their owners.", notice: "", style: "mono", changes: "Fitted into a 24 by 24 frame and drawn in its brand colour; a logo too pale for the light theme gets a hairline outline in the text colour, and one too dark for the dark theme is drawn in the text colour." },
  { id: "odd", title: "Odd set", licence: "MIT", source: "javascript:alert(1)", note: "", notice: "", style: "colour", changes: "Fitted." },
  { id: "plain", title: "Plain set", licence: "MIT", source: "http://example.com/icons", note: "", notice: "", style: "colour", changes: "Fitted." },
];

const SA_SIX = [
  ["brand-debian", "CC-BY-SA-3.0, from https://www.debian.org/logos"],
  ["brand-jenkins", "CC-BY-SA-3.0, from https://get.jenkins.io/art/"],
  ["brand-php", "CC-BY-SA-4.0, from https://php.net/download-logos.php"],
  ["brand-r", "CC-BY-SA-4.0, from https://www.r-project.org/logo/"],
  ["brand-ruby", "CC-BY-SA-2.5, from https://www.ruby-lang.org/en/about/logo/"],
  ["brand-rust", "CC-BY-SA-4.0, from https://www.rust-lang.org"],
] as const;

const ROUTES = {
  icon_sets: () => SETS,
  icon_index: () => [
    ...SA_SIX.map(([name, licence]) => ({ name, set: "simple", title: name, licence })),
    { name: "brand-git", set: "simple", title: "Git", licence: "CC-BY-3.0, from https://git-scm.com/community/logos" },
    { name: "aws-s3", set: "aws", title: "S3", licence: null },
  ],
};

beforeEach(() => {
  resetIcons();
  routeInvoke(ROUTES);
});
afterEach(cleanup);

test("icon_credits_lists_each_set_with_its_licence", async () => {
  const onClose = vi.fn();
  render(<IconCredits onClose={onClose} />);
  const dialog = screen.getByRole("dialog", { name: "Icon credits" });
  for (const s of SETS) {
    const set = await within(dialog).findByRole("region", { name: s.title });
    expect(within(set).getByText(s.licence)).toBeTruthy();
    expect(within(set).getByText(s.source)).toBeTruthy();
  }
  await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalled();
});

test("only_https_sources_are_links_and_licence_text_stays_plain", async () => {
  render(<IconCredits onClose={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "Icon credits" });
  const aws = await within(dialog).findByRole("region", { name: "AWS Architecture Icons" });
  const link = within(aws).getByRole("link", { name: SETS[0].source });
  expect(link.getAttribute("href")).toBe(SETS[0].source);
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  // A javascript: or plain http source is shown as text, never as a link.
  expect(within(within(dialog).getByRole("region", { name: "Odd set" })).queryByRole("link")).toBeNull();
  expect(within(within(dialog).getByRole("region", { name: "Plain set" })).queryByRole("link")).toBeNull();
  // Licence text is text: markup in it is shown, not run or drawn.
  const lucide = within(dialog).getByRole("region", { name: "Lucide" });
  expect(lucide.querySelector("b")).toBeNull();
  expect(lucide.textContent).toContain("<b>as part of Feather</b>");
  expect(dialog.querySelectorAll("a").length).toBe(3);
});

test("a_source_link_opens_in_the_system_browser_through_the_core", async () => {
  routeInvoke({ ...ROUTES, open_url: () => null });
  render(<IconCredits onClose={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "Icon credits" });
  const link = within(await within(dialog).findByRole("region", { name: "Lucide" })).getByRole("link", { name: "https://lucide.dev" });
  // The webview never opens a window of its own: no target, and the click goes to the Core, which checks it again.
  expect(link.getAttribute("target")).toBeNull();
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  await waitFor(() => expect(callsTo("open_url")).toEqual([{ url: "https://lucide.dev/" }]));
});

test("a_link_that_does_not_open_says_why", async () => {
  routeInvoke({ ...ROUTES, open_url: () => Promise.reject({ kind: "file", message: "Windows couldn't open the link (code 2)." }) });
  render(<IconCredits onClose={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "Icon credits" });
  const link = within(await within(dialog).findByRole("region", { name: "Lucide" })).getByRole("link", { name: "https://lucide.dev" });
  await userEvent.click(link);
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("Couldn't open the link.");
  expect(alert.textContent).toContain("Windows couldn't open the link (code 2).");
});

test("a_link_that_opens_clears_the_last_failure", async () => {
  let fail = true;
  routeInvoke({
    ...ROUTES,
    open_url: () => (fail ? Promise.reject({ kind: "file", message: "Windows couldn't open the link (code 2)." }) : null),
  });
  render(<IconCredits onClose={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "Icon credits" });
  const link = within(await within(dialog).findByRole("region", { name: "Lucide" })).getByRole("link", { name: "https://lucide.dev" });
  await userEvent.click(link);
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  fail = false;
  await userEvent.click(link);
  await waitFor(() => expect(callsTo("open_url")).toHaveLength(2));
  expect(within(dialog).queryByRole("alert")).toBeNull();
});

test("brand_logos_with_their_own_licence_are_named", async () => {
  render(<IconCredits onClose={() => {}} />);
  expect(await screen.findByText("brand-rust: CC-BY-SA-4.0, from https://www.rust-lang.org")).toBeTruthy();
  expect(await screen.findByText("brand-git: CC-BY-3.0, from https://git-scm.com/community/logos")).toBeTruthy();
});

test("each_set_says_how_it_was_changed", async () => {
  render(<IconCredits onClose={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "Icon credits" });
  for (const s of SETS.filter((x) => x.changes !== "Fitted.")) {
    const set = await within(dialog).findByRole("region", { name: s.title });
    expect(within(set).getByText(`Changed: ${s.changes}`)).toBeTruthy();
  }
});

test("the_six_cc_by_sa_logos_say_the_adapted_file_is_shared_under_the_same_licence", async () => {
  render(<IconCredits onClose={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "Icon credits" });
  const simple = await within(dialog).findByRole("region", { name: "Simple Icons" });
  for (const [name, licence] of SA_SIX) {
    const kind = licence.split(",")[0];
    expect(
      within(simple).getByText(
        `${name}: fitted into a 24 by 24 frame and drawn in its brand colour; a logo too pale for the light theme gets a hairline outline in the text colour, and one too dark for the dark theme is drawn in the text colour. This adapted file is shared under the same licence, ${kind}.`,
      ),
    ).toBeTruthy();
  }
  // A logo under another licence gets no such line.
  expect(within(simple).queryByText(/brand-git: Fitted/)).toBeNull();
});

test("unreadable_credits_say_so", async () => {
  routeInvoke({ icon_sets: () => Promise.reject({ kind: "file", message: "the icon pack is damaged" }), icon_index: () => [] });
  render(<IconCredits onClose={() => {}} />);
  expect(await screen.findByText("Couldn't read the icon credits.")).toBeTruthy();
});
