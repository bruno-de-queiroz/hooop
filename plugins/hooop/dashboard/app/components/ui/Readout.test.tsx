import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Readout } from "./Readout";
import { SectionTitle } from "./SectionTitle";

describe("Readout", () => {
  it("uses tabular monospace figures", () => {
    render(<Readout>1m 41s</Readout>);
    const cls = screen.getByText("1m 41s").className;
    expect(cls).toMatch(/font-mono/);
    expect(cls).toMatch(/tabular-nums/);
  });

  it("tints by tone", () => {
    render(<Readout tone="accent">128k</Readout>);
    expect(screen.getByText("128k").className).toMatch(/text-accent/);
  });
});

describe("SectionTitle", () => {
  it("renders an uppercase-tracked heading", () => {
    render(<SectionTitle>Sub-agents</SectionTitle>);
    const el = screen.getByRole("heading", { name: "Sub-agents" });
    expect(el.className).toMatch(/uppercase/);
    expect(el.className).toMatch(/text-ink-faint/);
  });
});
