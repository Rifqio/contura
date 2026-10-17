// Export colours come from the light tokens, whatever the window theme (plan ruling R7).
export interface ExportPalette {
  surface: string;
  text: string;
  subtle: string;
  stroke: string;
  fill: string;
  type: string;
  border: string;
}

/** Reads the tokens from a hidden `.theme-light` element, so a dark window still exports Alucard colours. */
export function exportPalette(): ExportPalette {
  const probe = document.createElement("div");
  probe.className = "theme-light";
  probe.hidden = true;
  document.body.appendChild(probe);
  try {
    const css = getComputedStyle(probe);
    const read = (name: string) => css.getPropertyValue(name).trim();
    return {
      surface: read("--c-bg-surface"),
      text: read("--c-text"),
      subtle: read("--c-text-subtle"),
      stroke: read("--c-node-table-stroke"),
      fill: read("--c-node-table-fill"),
      type: read("--c-syn-type"),
      border: read("--c-border"),
    };
  } finally {
    probe.remove();
  }
}
