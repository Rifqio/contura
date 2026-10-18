/** Words that are the same in the singular and the plural. */
const FIXED = new Set([
  "data",
  "metadata",
  "info",
  "information",
  "media",
  "news",
  "series",
  "species",
  "equipment",
  "feedback",
  "staff",
  "software",
]);

/** Plurals the endings below get wrong, to their singular. */
const IRREGULAR: Record<string, string> = {
  people: "person",
  children: "child",
  movies: "movie",
  cookies: "cookie",
  aliases: "alias",
  analyses: "analysis",
  statuses: "status",
  buses: "bus",
  gases: "gas",
  quizzes: "quiz",
};

const isUpper = (s: string) => s !== s.toLowerCase() && s === s.toUpperCase();

/** Words ending in "us" that are singular; any other "-us" word may be a plural (menus, gurus). */
const SINGULAR_US = new Set(["status", "bus", "campus", "bonus", "virus", "focus", "census", "corpus", "genus", "radius", "syllabus"]);

/**
 * One word's singular and plural; an added ending follows the case of the word's last letter. A
 * "-ses" or "-zes" plural drops its "s" (purchases, sizes); the few that do not are irregular.
 * Null when the endings cannot tell, as for "menus".
 */
function forms(word: string): { one: string; many: string } | null {
  const lower = word.toLowerCase();
  const cased = (ending: string) => (isUpper(word.slice(-1)) ? ending.toUpperCase() : ending);
  if (word === "" || FIXED.has(lower)) return { one: word, many: word };
  if (lower in IRREGULAR) {
    const one = IRREGULAR[lower];
    return { one: isUpper(word) ? one.toUpperCase() : word[0] + one.slice(1), many: word };
  }
  if (/[^aeiou]ies$/.test(lower)) return { one: word.slice(0, -3) + cased("y"), many: word };
  if (/(sses|shes|ches|xes)$/.test(lower)) return { one: word.slice(0, -2), many: word };
  if (/(ses|zes)$/.test(lower)) return { one: word.slice(0, -1), many: word };
  if (/us$/.test(lower)) return SINGULAR_US.has(lower) ? { one: word, many: word + cased("es") } : null;
  if (/(ss|sh|ch|x|z)$/.test(lower)) return { one: word, many: word + cased("es") };
  if (/is$/.test(lower)) return { one: word, many: word.slice(0, -2) + cased("es") };
  if (/s$/.test(lower)) return { one: word.slice(0, -1), many: word };
  if (/[^aeiou]y$/.test(lower)) return { one: word, many: word.slice(0, -1) + cased("ies") };
  return { one: word, many: word + cased("s") };
}

/**
 * The singular and plural of a table's name for running text ("every order",
 * "all 86 menu items"). Underscores become spaces and only the last word
 * changes. When the rules are unsure of the last word, both are the table name
 * as it is, which callers read as "every row of {table}".
 */
export function nounFor(table: string | { name: string }): { one: string; many: string } {
  const raw = typeof table === "string" ? table : table.name;
  const name = raw.replace(/_/g, " ");
  const cut = name.lastIndexOf(" ") + 1;
  const head = name.slice(0, cut);
  const f = forms(name.slice(cut));
  if (!f) return { one: raw, many: raw };
  return { one: head + f.one, many: head + f.many };
}
