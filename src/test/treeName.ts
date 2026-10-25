/** A tree row's accessible name: a table row's name ends with its row count (", about 18,402 rows", ", 3 rows"). */
const escaped = (s: string) => s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");

export const treeName = (name: string | RegExp): RegExp =>
  typeof name === "string" ? new RegExp("^" + escaped(name) + "(, (about )?[\\d,]+ rows?)?$") : name;
