import { render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import CardFrame from "./CardFrame";

const wrap = ({ children }: { children: ReactNode }) => <ReactFlowProvider>{children}</ReactFlowProvider>;

test("item_25_zones_show_only_where_they_resize_and_there_are_no_square_handles", () => {
  const props = { kind: "table" as const, title: "orders", rows: null, count: 0, selected: true, width: 216 };
  const { container, rerender } = render(<CardFrame {...props} />, { wrapper: wrap });
  expect(container.querySelectorAll(".rz-zone")).toHaveLength(0);
  expect(container.querySelector(".selbox")).toBeTruthy();
  rerender(<CardFrame {...props} onResize={() => {}} fullHeight={112} />);
  expect(container.querySelectorAll(".rz-zone")).toHaveLength(8);
  expect(container.querySelectorAll(".selbox i")).toHaveLength(0);
  // Not selected: no zones.
  rerender(<CardFrame {...props} selected={false} onResize={() => {}} fullHeight={112} />);
  expect(container.querySelectorAll(".rz-zone")).toHaveLength(0);
});

test("item_41_a_card_shorter_than_its_rows_scrolls_them", () => {
  const props = { kind: "table" as const, title: "orders", rows: <li>id</li>, count: 4, selected: false, width: 216, fullHeight: 136 };
  const { container, rerender } = render(<CardFrame {...props} height={100} />, { wrapper: wrap });
  const card = container.querySelector<HTMLElement>(".table-card")!;
  expect(card.style.height).toBe("100px");
  expect(card.classList.contains("table-card-scroll")).toBe(true);
  expect(card.querySelector("ul")!.classList.contains("nowheel")).toBe(true);
  // As tall as its rows (or taller): no height of its own, nothing scrolls.
  rerender(<CardFrame {...props} height={400} />);
  expect(container.querySelector<HTMLElement>(".table-card")!.style.height).toBe("");
  expect(container.querySelector(".table-card-scroll")).toBeNull();
});

test("branch_review_3_a_card_zoomed_out_mid_resize_drops_is_resizing_from_its_node", async () => {
  const { act, fireEvent } = await import("@testing-library/react");
  const { DetailContext } = await import("./detail");
  const props = { kind: "table" as const, title: "orders", rows: <li>id</li>, count: 1, selected: true, width: 216, fullHeight: 112, onResize: () => {} };
  const At = ({ detail }: { detail: "full" | "box" }) => (
    <div className="react-flow__node" data-id="t1">
      <DetailContext.Provider value={{ detail, fast: false }}>
        <CardFrame {...props} />
      </DetailContext.Provider>
    </div>
  );
  const { container, rerender } = render(<At detail="full" />, { wrapper: wrap });
  const node = container.querySelector<HTMLElement>(".react-flow__node")!;
  const se = container.querySelector<HTMLElement>('.rz-zone[data-dir="se"]')!;
  fireEvent.pointerDown(se, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(se, { clientX: -20, clientY: -10, pointerId: 1 });
  await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  expect(node.classList.contains("is-resizing")).toBe(true);
  // Zoomed out mid-drag: the card becomes its name box and its zones go.
  rerender(<At detail="box" />);
  expect(container.querySelector(".rz-zone")).toBeNull();
  expect(node.classList.contains("is-resizing")).toBe(false);
});
