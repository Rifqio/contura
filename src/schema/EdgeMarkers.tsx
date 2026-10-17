/**
 * The two ends of a Foreign Key edge, drawn as in the design: a crow's foot with a bar for the
 * many side and a double bar for the one side. Edges refer to them by id (`markerStart`, `markerEnd`).
 * Strokes come from `.edge-marker` in app.css, so the theme colours them.
 */
export const MANY_MARKER = "crow-many";
export const ONE_MARKER = "bar-one";

export default function EdgeMarkers() {
  return (
    <svg className="edge-markers" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <marker
          id={MANY_MARKER}
          viewBox="0 0 14 14"
          refX="14"
          refY="7"
          markerWidth="14"
          markerHeight="14"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path className="edge-marker" d="M4 7L14 1M4 7H14M4 7L14 13M2 2V12" />
        </marker>
        <marker
          id={ONE_MARKER}
          viewBox="0 0 14 14"
          refX="14"
          refY="7"
          markerWidth="14"
          markerHeight="14"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path className="edge-marker" d="M6 2V12M9.5 2V12" />
        </marker>
      </defs>
    </svg>
  );
}
