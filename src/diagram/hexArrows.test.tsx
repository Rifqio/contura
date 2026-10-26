import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { buildFlowGraph } from "../flow/flowNodes";
import { parseFlow } from "../lang/flow/parse";
import { colourArrow, EdgeMarkers, hexArrowsIn } from "./edges";

test("a_custom_colour_line_gets_a_coloured_arrowhead_whose_marker_exists", () => {
  const doc = parseFlow(['diagram flow "Orders"', "A [step]", "B [step]", "C [step]", "A > B [color: teal]", "B > C [color: #008080]", "A > C [color: info]", "A > C: x"].join("\n")).doc!;
  const { edges } = buildFlowGraph(doc, { A: { x: 0, y: 0 }, B: { x: 200, y: 0 }, C: { x: 400, y: 0 } }, "modern");
  expect(colourArrow("#008080")).toBe("arrow-hex-008080");
  expect(edges[0].markerEnd).toBe("arrow-hex-008080");
  expect(edges[2].markerEnd).toBe("arrow-info");
  const hexes = hexArrowsIn(edges);
  expect(hexes).toEqual(["#008080"]);
  const { container } = render(<EdgeMarkers hexes={hexes} />);
  const marker = container.querySelector("marker#arrow-hex-008080");
  expect(marker).not.toBeNull();
  expect((marker!.querySelector("path") as SVGPathElement).style.fill).toBe("rgb(0, 128, 128)");
  expect(hexArrowsIn([])).toEqual([]);
});
