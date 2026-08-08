import { useEffect } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useImagePanZoom, type ImagePanZoom } from "./useImagePanZoom";

// jsdom has no layout, so getBoundingClientRect returns zeroes and the pan clamp
// would collapse to (0,0) for every input. A fixed 400×300 box is stubbed so the
// clamp's arithmetic is actually exercised.
const BOX = { width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) };

let api: ImagePanZoom;

function Probe({ resetKey }: { resetKey: string }) {
  const hook = useImagePanZoom(resetKey);
  useEffect(() => {
    api = hook;
  });
  return <div ref={hook.viewportRef} data-testid="viewport" />;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(BOX as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** jsdom implements no PointerEvent constructor, and the hook's window listeners
 * only read clientX/clientY — dispatch is keyed on the event's `type`, so a
 * MouseEvent named "pointermove" reaches a "pointermove" listener identically. */
function pointer(type: string, init: MouseEventInit = {}): Event {
  return new MouseEvent(type, init);
}

/** Drag from (x0,y0) to (x1,y1) the way the component does: pointerdown on the
 * element, then move/up on `window`. */
async function drag(x0: number, y0: number, x1: number, y1: number) {
  await act(async () => {
    api.onPointerDown({
      button: 0,
      clientX: x0,
      clientY: y0,
      preventDefault() {},
    } as unknown as React.PointerEvent);
  });
  await act(async () => {
    window.dispatchEvent(pointer("pointermove", { clientX: x1, clientY: y1 }));
  });
  await act(async () => {
    window.dispatchEvent(pointer("pointerup"));
  });
}

describe("useImagePanZoom", () => {
  it("starts fit at 1× with no offset", () => {
    render(<Probe resetKey="a.png" />);
    expect(api.scale).toBe(1);
    expect(api.offset).toEqual({ x: 0, y: 0 });
    expect(api.isFit).toBe(true);
  });

  it("zooms in and out in steps, clamped at both ends", async () => {
    render(<Probe resetKey="a.png" />);
    await act(async () => api.zoomIn());
    expect(api.scale).toBeCloseTo(1.4, 5);
    await act(async () => api.zoomOut());
    expect(api.scale).toBeCloseTo(1, 5);

    // Never below fit, however many times it's asked.
    for (let i = 0; i < 10; i++) await act(async () => api.zoomOut());
    expect(api.scale).toBe(1);

    // Never above the ceiling.
    for (let i = 0; i < 30; i++) await act(async () => api.zoomIn());
    expect(api.scale).toBe(8);
  });

  it("ignores a pan at rest — there is nothing outside the frame to reveal", async () => {
    render(<Probe resetKey="a.png" />);
    await drag(100, 100, 180, 140);
    expect(api.offset).toEqual({ x: 0, y: 0 });
    expect(api.panning).toBe(false);
  });

  it("pans by the pointer delta once zoomed", async () => {
    render(<Probe resetKey="a.png" />);
    await act(async () => api.zoomIn()); // 1.4× → 400*0.4/2 = 80px of travel
    await drag(100, 100, 150, 120);
    expect(api.offset.x).toBeCloseTo(50, 5);
    expect(api.offset.y).toBeCloseTo(20, 5);
  });

  it("clamps the pan so the image can't be dragged out of view", async () => {
    render(<Probe resetKey="a.png" />);
    await act(async () => api.zoomIn()); // maxX = 400*(1.4-1)/2 = 80, maxY = 60
    await drag(0, 0, 5000, 5000);
    expect(api.offset.x).toBeCloseTo(80, 5);
    expect(api.offset.y).toBeCloseTo(60, 5);

    await drag(0, 0, -5000, -5000);
    expect(api.offset.x).toBeCloseTo(-80, 5);
    expect(api.offset.y).toBeCloseTo(-60, 5);
  });

  it("pulls a panned image back into frame when zooming out", async () => {
    render(<Probe resetKey="a.png" />);
    await act(async () => api.zoomIn());
    await act(async () => api.zoomIn()); // ~1.96× → maxX ≈ 192
    await drag(0, 0, 5000, 0);
    expect(api.offset.x).toBeGreaterThan(80);

    // Back to 1×: the allowance is zero, so the offset must be zero too rather
    // than leaving the image parked off-centre.
    await act(async () => api.reset());
    expect(api.offset).toEqual({ x: 0, y: 0 });
    expect(api.isFit).toBe(true);
  });

  // The bug useResizableDock documents: a re-render mid-drag drops element
  // pointer capture, so a release tracked on the element is missed and the
  // gesture sticks. Listening on `window` is what prevents it — this asserts the
  // release is seen even though every move re-rendered the component.
  it("ends the gesture on a window pointerup, despite re-rendering on every move", async () => {
    render(<Probe resetKey="a.png" />);
    await act(async () => api.zoomIn());
    await act(async () => {
      api.onPointerDown({ button: 0, clientX: 10, clientY: 10, preventDefault() {} } as unknown as React.PointerEvent);
    });
    expect(api.panning).toBe(true);
    for (const x of [20, 30, 40, 50]) {
      await act(async () => {
        window.dispatchEvent(pointer("pointermove", { clientX: x, clientY: 10 }));
      });
    }
    await act(async () => {
      window.dispatchEvent(pointer("pointerup"));
    });
    expect(api.panning).toBe(false);

    // And a stray move afterwards must not still be moving the image.
    const settled = { ...api.offset };
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", { clientX: 400, clientY: 400 }));
    });
    expect(api.offset).toEqual(settled);
  });

  it("treats pointercancel as an end, so a lost pointer can't wedge the drag", async () => {
    render(<Probe resetKey="a.png" />);
    await act(async () => api.zoomIn());
    await act(async () => {
      api.onPointerDown({ button: 0, clientX: 10, clientY: 10, preventDefault() {} } as unknown as React.PointerEvent);
    });
    await act(async () => {
      window.dispatchEvent(pointer("pointercancel"));
    });
    expect(api.panning).toBe(false);
  });

  it("restores body userSelect/cursor after the gesture", async () => {
    render(<Probe resetKey="a.png" />);
    await act(async () => api.zoomIn());
    await act(async () => {
      api.onPointerDown({ button: 0, clientX: 10, clientY: 10, preventDefault() {} } as unknown as React.PointerEvent);
    });
    expect(document.body.style.cursor).toBe("grabbing");
    await act(async () => {
      window.dispatchEvent(pointer("pointerup"));
    });
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("zooms on wheel, anchoring the point under the cursor", async () => {
    render(<Probe resetKey="a.png" />);
    // Cursor at the box centre (200,150): the anchor maths yields no offset.
    await act(async () => {
      api.onWheel({ deltaY: -300, clientX: 200, clientY: 150, preventDefault() {} } as unknown as React.WheelEvent);
    });
    expect(api.scale).toBeGreaterThan(1);
    expect(api.offset.x).toBeCloseTo(0, 5);

    // Off-centre cursor must shift the offset to keep that point in place.
    await act(async () => api.reset());
    await act(async () => {
      api.onWheel({ deltaY: -300, clientX: 380, clientY: 150, preventDefault() {} } as unknown as React.WheelEvent);
    });
    expect(api.offset.x).not.toBeCloseTo(0, 2);
  });

  it("resets to fit when the key changes (another image opened)", async () => {
    const { rerender } = render(<Probe resetKey="a.png" />);
    await act(async () => api.zoomIn());
    await drag(0, 0, 40, 40);
    expect(api.scale).toBeGreaterThan(1);
    expect(api.offset.x).not.toBe(0);

    await act(async () => {
      rerender(<Probe resetKey="b.png" />);
    });
    expect(api.scale).toBe(1);
    expect(api.offset).toEqual({ x: 0, y: 0 });
  });

  it("ignores a non-primary button", async () => {
    render(<Probe resetKey="a.png" />);
    await act(async () => api.zoomIn());
    await act(async () => {
      api.onPointerDown({ button: 2, clientX: 10, clientY: 10, preventDefault() {} } as unknown as React.PointerEvent);
    });
    expect(api.panning).toBe(false);
  });
});
