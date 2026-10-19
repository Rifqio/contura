// Icon search order, shared by completion after `icon:` and the icon picker: provider prefix first (spec 6+ section 2).

/** Icon names start with one of these and a dash (`aws-s3`); the rest are general icons (`users`). */
export const ICON_PROVIDERS = ["aws", "azure", "gcp", "k8s"];

/** The provider an icon name starts with, or null for a general or brand icon. */
export function providerOf(icon: string): string | null {
  const dash = icon.indexOf("-");
  return dash > 0 && ICON_PROVIDERS.includes(icon.slice(0, dash)) ? icon.slice(0, dash) : null;
}

/**
 * Icons ranked by where the typed text matches: at the start of the name, then after the provider prefix, then
 * anywhere after it. Within a rank, provider icons come before general ones, then by name. When the typed text is
 * the start of a provider prefix (`a`, `aw`, `aws-`), every provider icon comes before every general one.
 */
export function rankIcons(icons: readonly string[], typed: string, limit = 200): string[] {
  const q = typed.toLowerCase();
  const providerTyped = q !== "" && ICON_PROVIDERS.some((p) => `${p}-`.startsWith(q));
  const ranked: { name: string; rank: number; general: number }[] = [];
  for (const name of icons) {
    const lower = name.toLowerCase();
    const provider = providerOf(lower);
    const rest = provider ? lower.slice(provider.length + 1) : lower;
    const rank = lower.startsWith(q) ? 0 : rest.startsWith(q) ? 1 : rest.includes(q) ? 2 : -1;
    if (rank >= 0) ranked.push({ name, rank, general: provider ? 0 : 1 });
  }
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  ranked.sort((a, b) => (providerTyped ? a.general - b.general || a.rank - b.rank : a.rank - b.rank || a.general - b.general) || byName(a, b));
  return ranked.slice(0, limit).map((r) => r.name);
}
