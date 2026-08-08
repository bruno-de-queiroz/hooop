import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Chip } from "./Chip";

describe("Chip", () => {
  it("defaults to the neutral tone", () => {
    render(<Chip>hooop</Chip>);
    expect(screen.getByText("hooop").className).toMatch(/text-ink-faint/);
  });

  it("tints foreground for a cue tone without a solid fill", () => {
    render(<Chip tone="sdk">SDK</Chip>);
    const cls = screen.getByText("SDK").className;
    expect(cls).toMatch(/text-sdk/);
    expect(cls).toMatch(/bg-sdk\/15/);
  });
});
