/** Wide and narrow glyphs, so a different face almost always gives a different width. */
const SAMPLE = "mmmmmmmmmmlli1|WW@#0Oo";
const FALLBACKS = ["monospace", "serif"] as const;

const known = new Map<string, boolean>();
let context: CanvasRenderingContext2D | null | undefined;

function canvas(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    try {
      context = document.createElement("canvas").getContext("2d");
    } catch {
      context = null;
    }
  }
  return context;
}

/**
 * Whether Windows has the font (PR34): text set in it, with a fallback behind it, measures
 * differently from the fallback alone. False when nothing can be measured.
 */
export function isInstalled(family: string): boolean {
  const hit = known.get(family);
  if (hit !== undefined) return hit;
  const ctx = canvas();
  let found = false;
  if (ctx) {
    for (const fallback of FALLBACKS) {
      ctx.font = `32px ${fallback}`;
      const plain = ctx.measureText(SAMPLE).width;
      ctx.font = `32px "${family}", ${fallback}`;
      if (ctx.measureText(SAMPLE).width !== plain) {
        found = true;
        break;
      }
    }
  }
  known.set(family, found);
  return found;
}
