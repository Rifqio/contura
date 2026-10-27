// The Shelf's one search (Decision 4): the query is trimmed and lower-cased; rank 0 is a name that starts with it, 1 a
// word that starts with it, 2 anywhere; ties keep catalog order. Haystacks are built once, on first use.
import type { DiagramKind } from "../../../lang/flow/model";
import { KIND_HEAD } from "../chips";
import { KIND_WORDS, SHELF_KINDS } from "./kinds";
import { BOARD_TEMPLATES, type BoardTemplate, SINGLE_TEMPLATES, type SingleTemplate, type TemplateFilter } from "./templates";

/** 0 when `hay` starts with `query`, 1 when a word of it does, 2 when it holds it, -1 otherwise. `hay` is lower case and starts with the item's name. */
export function matchRank(hay: string, query: string): number {
  if (hay.startsWith(query)) return 0;
  let at = hay.indexOf(query);
  if (at < 0) return -1;
  while (at >= 0) {
    if (/[^a-z0-9]/.test(hay[at - 1] ?? " ")) return 1;
    at = hay.indexOf(query, at + 1);
  }
  return 2;
}

interface Entry {
  hay: string;
  kind?: DiagramKind;
  board?: BoardTemplate;
  single?: SingleTemplate;
}

let index: { kinds: Entry[]; boards: Entry[]; singles: Entry[] } | null = null;
let builds = 0;

export const frameTitle = (frame: string) => /^diagram \w+ "([^"]*)"/.exec(frame)?.[1] ?? "";

function build() {
  if (index) return index;
  builds++;
  index = {
    kinds: SHELF_KINDS.map((kind) => ({ kind, hay: [KIND_HEAD[kind].name, KIND_HEAD[kind].line, kind, KIND_WORDS[kind]].join(" ").toLowerCase() })),
    boards: BOARD_TEMPLATES.map((board) => ({ board, hay: [board.name, board.line, ...board.frames.map(frameTitle)].join(" ").toLowerCase() })),
    singles: SINGLE_TEMPLATES.map((single) => ({ single, hay: [single.name, KIND_HEAD[single.kind].name, KIND_WORDS[single.kind]].join(" ").toLowerCase() })),
  };
  return index;
}

/** How many times the index was built: one, however many searches run. */
export function indexBuilds(): number {
  return builds;
}

/** The entries that match, best rank first, catalog order within a rank. */
function pick(entries: readonly Entry[], raw: string): Entry[] {
  const q = raw.trim().toLowerCase();
  if (!q) return entries.slice();
  const hits: { e: Entry; rank: number; at: number }[] = [];
  entries.forEach((e, at) => {
    const rank = matchRank(e.hay, q);
    if (rank >= 0) hits.push({ e, rank, at });
  });
  hits.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return hits.map((h) => h.e);
}

/** The kinds that match, in the Shelf's order when nothing is typed. */
export function searchKinds(query: string): DiagramKind[] {
  return pick(build().kinds, query).map((e) => e.kind!);
}

/** The templates that match. "boards" keeps only boards; a kind filter keeps only that kind's singles; "all" keeps both. */
export function searchTemplates(query: string, filter: TemplateFilter): { boards: BoardTemplate[]; singles: SingleTemplate[] } {
  const ix = build();
  const boards = filter === "all" || filter === "boards" ? pick(ix.boards, query).map((e) => e.board!) : [];
  const singles =
    filter !== "boards"
      ? pick(ix.singles, query)
          .map((e) => e.single!)
          .filter((s) => filter === "all" || s.kind === filter)
      : [];
  return { boards, singles };
}

