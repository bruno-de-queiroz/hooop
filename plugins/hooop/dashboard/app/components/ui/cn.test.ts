import { describe, it, expect } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins truthy class values", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("supports conditional object syntax", () => {
    expect(cn("base", { on: true, off: false })).toBe("base on");
  });

  it("resolves conflicting tailwind atoms last-wins", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("bg-elevated", "bg-elevated-2")).toBe("bg-elevated-2");
  });

  it("keeps non-conflicting tailwind atoms", () => {
    expect(cn("px-2 py-1", "text-ink")).toBe("px-2 py-1 text-ink");
  });
});
