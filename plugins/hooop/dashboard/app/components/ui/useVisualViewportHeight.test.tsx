import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useVisualViewportHeight } from "./useVisualViewportHeight";

// A minimal fake of window.visualViewport we can drive in tests: mutate
// `height` then dispatch the event the hook listens for.
function makeFakeViewport(height: number) {
  const listeners: Record<string, Set<() => void>> = { resize: new Set(), scroll: new Set() };
  return {
    height,
    addEventListener: (type: string, fn: () => void) => listeners[type]?.add(fn),
    removeEventListener: (type: string, fn: () => void) => listeners[type]?.delete(fn),
    emit: (type: "resize" | "scroll") => listeners[type].forEach((fn) => fn()),
    listenerCount: (type: "resize" | "scroll") => listeners[type].size,
  };
}

function setInnerHeight(px: number) {
  Object.defineProperty(window, "innerHeight", { value: px, configurable: true });
}

describe("useVisualViewportHeight", () => {
  const originalVV = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const originalIH = Object.getOwnPropertyDescriptor(window, "innerHeight");

  afterEach(() => {
    if (originalVV) Object.defineProperty(window, "visualViewport", originalVV);
    if (originalIH) Object.defineProperty(window, "innerHeight", originalIH);
    document.documentElement.style.removeProperty("--app-height");
    document.documentElement.style.height = "";
    document.body.style.height = "";
    document.body.style.overflow = "";
    document.body.style.overscrollBehavior = "";
  });

  it("pins the shell to the visual viewport when the keyboard opens (real gap)", () => {
    // Layout viewport stays 800 (iOS Safari) while the keyboard shrinks the
    // visual viewport to 520 → gap 280 > threshold.
    setInnerHeight(800);
    const vp = makeFakeViewport(520);
    Object.defineProperty(window, "visualViewport", { value: vp, configurable: true });

    renderHook(() => useVisualViewportHeight());
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("520px");
    // Document height is capped so no background shows below the shorter shell.
    expect(document.documentElement.style.height).toBe("520px");
    expect(document.body.style.height).toBe("520px");
  });

  it("stays inert when there is no keyboard gap (e.g. Chromium resizes-content)", () => {
    // Layout viewport already shrank with the keyboard, so innerHeight ≈ vv.height.
    setInnerHeight(800);
    const vp = makeFakeViewport(800);
    Object.defineProperty(window, "visualViewport", { value: vp, configurable: true });

    renderHook(() => useVisualViewportHeight());
    // No override — CSS 100dvh drives height.
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
    expect(document.body.style.height).toBe("");
  });

  it("clears the override again when the keyboard closes", () => {
    setInnerHeight(800);
    const vp = makeFakeViewport(520); // keyboard open
    Object.defineProperty(window, "visualViewport", { value: vp, configurable: true });

    renderHook(() => useVisualViewportHeight());
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("520px");

    // Keyboard closes → visual viewport grows back to the layout height.
    vp.height = 800;
    vp.emit("resize");
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
    expect(document.body.style.height).toBe("");
  });

  it("locks body scroll while mounted and restores everything on unmount", () => {
    setInnerHeight(800);
    const vp = makeFakeViewport(520);
    Object.defineProperty(window, "visualViewport", { value: vp, configurable: true });

    const { unmount } = renderHook(() => useVisualViewportHeight());
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("none");

    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(document.body.style.height).toBe("");
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
    expect(vp.listenerCount("resize")).toBe(0);
    expect(vp.listenerCount("scroll")).toBe(0);
  });

  it("does not set --app-height when visualViewport is unavailable (CSS 100dvh stands)", () => {
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
    setInnerHeight(640);

    renderHook(() => useVisualViewportHeight());
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
  });
});
