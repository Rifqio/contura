// With 2,000 participants every remount and every render during a swap pays
// each participant's own work, so a participant renders again only when its data changes, and works out its icon's
// hairline (its fill in its colour, the logo's contrast on it) only when its icon, colour, kind or theme changes.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { DetailContext } from "../diagram/detail";
import type { KindNodeData } from "./kindNodes";
import { participantIconOutline, seqColourVars } from "./seqColour";
import { SeqParticipant } from "./seqNodes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./icons", async (load) => {
  const real = await load<typeof import("./icons")>();
  return { ...real, useIcon: () => ({ url: "data:image/svg+xml;base64,PHN2Zy8+", missing: false, failed: false }), useIconTheme: () => "light" };
});
vi.mock("./seqColour", async (load) => {
  const real = await load<typeof import("./seqColour")>();
  return { ...real, participantIconOutline: vi.fn(real.participantIconOutline), seqColourVars: vi.fn(real.seqColourVars) };
});

afterEach(() => {
  cleanup();
  vi.mocked(participantIconOutline).mockClear();
  vi.mocked(seqColourVars).mockClear();
});

const FULL = { detail: "full" as const, fast: false };

function Host({ d }: { d: KindNodeData }) {
  const [n, setN] = useState(0);
  return (
    <DetailContext.Provider value={FULL}>
      <button onClick={() => setN(n + 1)}>again {n}</button>
      <SeqParticipant d={d} />
    </DetailContext.Provider>
  );
}

test("a_participant_works_out_its_icon_once", () => {
  const d: KindNodeData = { name: "Api", kind: "participant", look: "modern", iconName: "server", seqColour: "info", seq: true };
  const r = render(<Host d={d} />);
  expect(r.container.querySelectorAll("img")).toHaveLength(2);
  expect(participantIconOutline).toHaveBeenCalledTimes(1);
  // Its parent renders again: it does not.
  act(() => fireEvent.click(screen.getByText(/again/)));
  expect(screen.getByText("again 1")).toBeTruthy();
  expect(participantIconOutline).toHaveBeenCalledTimes(1);
  // New data with the same icon, colour and kind (a graph built again): its words change, its hairline is kept.
  r.rerender(<Host d={{ ...d, name: "Api 2" }} />);
  expect(r.container.textContent).toContain("Api 2");
  expect(participantIconOutline).toHaveBeenCalledTimes(1);
  // Another colour: worked out again.
  r.rerender(<Host d={{ ...d, seqColour: "warning" }} />);
  expect(participantIconOutline).toHaveBeenCalledTimes(2);
});

test("the_lanes_are_made_once_a_drawing", async () => {
  // The lanes node renders again for a move or a selection with the same drawing: no lane or bar is made again.
  const { SeqLanes } = await import("./seqNodes");
  const { ReactFlowProvider } = await import("@xyflow/react");
  const data = {
    lanes: [
      { name: "A", who: "participant" as const, x: 60, top: 40, bottom: 400, colour: "info" as const },
      { name: "B", who: "participant" as const, x: 260, top: 40, bottom: 400 },
    ],
    bars: [{ name: "A", who: "participant" as const, x: 54, y: 100, h: 60, colour: "info" as const }],
    x: 0,
    y: 0,
    w: 320,
    h: 420,
  };
  const props = (selected: boolean) => ({ id: "\u0000lanes", data, selected, type: "seqLanes" }) as unknown as Parameters<typeof SeqLanes>[0];
  const r = render(
    <ReactFlowProvider>
      <SeqLanes {...props(false)} />
    </ReactFlowProvider>,
  );
  const before = [...r.container.querySelectorAll("[data-part]")];
  expect(before).toHaveLength(3);
  expect(seqColourVars).toHaveBeenCalledTimes(3);
  r.rerender(
    <ReactFlowProvider>
      <SeqLanes {...props(true)} />
    </ReactFlowProvider>,
  );
  expect([...r.container.querySelectorAll("[data-part]")]).toEqual(before);
  expect(seqColourVars).toHaveBeenCalledTimes(3);
  // A new drawing: made again.
  r.rerender(
    <ReactFlowProvider>
      <SeqLanes {...({ ...props(true), data: { ...data, lanes: [...data.lanes] } } as Parameters<typeof SeqLanes>[0])} />
    </ReactFlowProvider>,
  );
  expect(seqColourVars).toHaveBeenCalledTimes(6);
});
