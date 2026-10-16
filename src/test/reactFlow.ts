import { vi } from "vitest";

/** React Flow measures the DOM; jsdom has no layout, so give it sizes (React Flow's testing guide). */
export function mockReactFlowDom() {
  class ResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb([{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserver);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22: number;
      constructor(t?: string) {
        this.m22 = t ? Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 1) : 1;
      }
    },
  );
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { get: () => 600, configurable: true },
    offsetWidth: { get: () => 800, configurable: true },
  });
}
