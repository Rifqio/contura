// The quiet gutter bar on lines changed since the last save.
import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";

/**
 * 1-based numbers of the lines in `current` that differ from `saved`: everything
 * between the longest common prefix and suffix of lines. Cheap and good enough
 * for a gutter hint.
 */
export function changedLines(saved: string, current: string): number[] {
  const a = saved.split("\n");
  const b = current.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return Array.from({ length: endB - start }, (_, i) => start + i + 1);
}

export const setSaved = StateEffect.define<string>();

const savedField = StateField.define<string>({
  create: () => "",
  update: (v, tr) => tr.effects.find((e) => e.is(setSaved))?.value ?? v,
});

class ChangedMarker extends GutterMarker {
  elementClass = "cm-changed-marker";
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-changed-bar";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
}
const marker = new ChangedMarker();

/** Gutter marks for changed lines; set the saved text with the `setSaved` effect. */
export function changedLinesGutter(saved: string) {
  return [
    savedField.init(() => saved),
    gutter({
      class: "cm-changed-gutter",
      markers: (view) => {
        const doc = view.state.doc;
        const lines = changedLines(view.state.field(savedField), doc.toString());
        return RangeSet.of(lines.map((n) => marker.range(doc.line(n).from)));
      },
    }),
  ];
}
