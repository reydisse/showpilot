import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfidenceSlide } from "./ConfidenceSlide";
import { DEFAULT_CONFIDENCE_LAYOUT } from "@/lib/confidence-layout";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const base = { text: "Amazing grace", notes: "", presentationName: "", isScripture: false, nextText: "How sweet the sound" };
describe("confidence display", () => {
  it("separates reference and version from verse text even when an older Bridge reports lyrics", () => {
    const { container } = render(<ConfidenceSlide slide={{ ...base, text: "John 3:16\nKJV\nFor God so loved the world" }} />);
    expect(container.querySelector("[data-confidence-slide]")?.getAttribute("data-confidence-slide")).toBe("scripture");
    expect(container.querySelector("[data-confidence-reference]")?.textContent).toBe("John 3:16 KJV");
    expect(container.querySelector("[data-confidence-current]")?.textContent).toBe("For God so loved the world");
  });
  it("retains the next region across empty previews and applies independent color with matching weight", () => {
    const layout = { ...DEFAULT_CONFIDENCE_LAYOUT, lyrics: { ...DEFAULT_CONFIDENCE_LAYOUT.lyrics, nextColor: "#ffcc00", nextSize: 1.2 } };
    const { container, rerender } = render(<ConfidenceSlide slide={base} layout={layout} />);
    const current = container.querySelector<HTMLElement>("[data-confidence-current]");
    const next = container.querySelector<HTMLElement>("[data-confidence-next]");
    expect(next?.style.fontWeight).toBe(current?.style.fontWeight);
    expect(next?.style.color).toBe("rgb(255, 204, 0)");
    rerender(<ConfidenceSlide slide={{ ...base, text: base.nextText, nextText: "" }} layout={layout} />);
    expect(container.querySelector("[data-confidence-next]")).toBe(next);
    expect(container.querySelector("[data-confidence-current]")).toBe(current);
  });
  it("hides references without putting them back into the verse", () => {
    const layout = { ...DEFAULT_CONFIDENCE_LAYOUT, scripture: { ...DEFAULT_CONFIDENCE_LAYOUT.scripture, showReference: false } };
    const { container } = render(<ConfidenceSlide slide={{ ...base, text: "John 3:16 KJV For God so loved the world" }} layout={layout} />);
    expect(container.querySelector("[data-confidence-reference]")).toBeNull();
    expect(container.querySelector("[data-confidence-current]")?.textContent).toBe("For God so loved the world");
  });
});
