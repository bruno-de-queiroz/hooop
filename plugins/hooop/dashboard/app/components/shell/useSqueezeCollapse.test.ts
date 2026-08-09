import { describe, it, expect } from "vitest";
import {
  squeezeDecision,
  LEFT_RAIL_RECLAIM,
  SQUEEZE_AT,
  RESTORE_AT,
  type SqueezeState,
} from "./useSqueezeCollapse";

const state = (over: Partial<SqueezeState> = {}): SqueezeState => ({
  collapsed: false,
  autoCollapsed: false,
  userExpanded: false,
  ...over,
});

describe("squeezeDecision", () => {
  it("collapses an expanded rail once the pane is too narrow to lay out the header", () => {
    expect(squeezeDecision(SQUEEZE_AT - 1, state())).toBe("collapse");
    expect(squeezeDecision(200, state())).toBe("collapse");
  });

  it("leaves a comfortable pane alone", () => {
    expect(squeezeDecision(SQUEEZE_AT, state())).toBeNull();
    expect(squeezeDecision(1200, state())).toBeNull();
  });

  it("restores only a rail it collapsed itself", () => {
    expect(squeezeDecision(RESTORE_AT + 1, state({ collapsed: true, autoCollapsed: true }))).toBe("restore");
    // Collapsed by hand — reopening it would be overriding a deliberate choice.
    expect(squeezeDecision(RESTORE_AT + 1, state({ collapsed: true, autoCollapsed: false }))).toBeNull();
    expect(squeezeDecision(2000, state({ collapsed: true, autoCollapsed: false }))).toBeNull();
  });

  it("does not restore until well clear of the collapse threshold", () => {
    expect(squeezeDecision(RESTORE_AT, state({ collapsed: true, autoCollapsed: true }))).toBeNull();
    expect(squeezeDecision(600, state({ collapsed: true, autoCollapsed: true }))).toBeNull();
  });

  it("stands down after a manual expand, so the expand button isn't undone", () => {
    expect(squeezeDecision(200, state({ userExpanded: true }))).toBeNull();
  });

  it("ignores an unmeasured or hidden pane", () => {
    // The desktop tree stays mounted behind a CSS `hidden` on mobile.
    expect(squeezeDecision(0, state())).toBeNull();
    expect(squeezeDecision(-1, state())).toBeNull();
  });

  it("cannot oscillate: neither transition lands past the opposite threshold", () => {
    // Collapsing at the widest triggering width must not immediately qualify to
    // restore, and restoring at the narrowest qualifying width must not
    // immediately qualify to collapse. This is the whole reason for the gap.
    const widestCollapse = SQUEEZE_AT - 1;
    const afterCollapse = widestCollapse + LEFT_RAIL_RECLAIM;
    expect(squeezeDecision(afterCollapse, state({ collapsed: true, autoCollapsed: true }))).toBeNull();

    const narrowestRestore = RESTORE_AT + 1;
    const afterRestore = narrowestRestore - LEFT_RAIL_RECLAIM;
    expect(squeezeDecision(afterRestore, state())).toBeNull();
  });
});
