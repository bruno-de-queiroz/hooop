import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusDot } from "./StatusDot";

describe("StatusDot", () => {
  it("colors by state", () => {
    render(<StatusDot state="wrap" />);
    expect(screen.getByRole("status").className).toMatch(/bg-wrap/);
  });

  it("only pulses (motion-safe) when asked", () => {
    const { rerender } = render(<StatusDot state="live" />);
    expect(screen.getByRole("status").className).not.toMatch(/animate-pulse/);
    rerender(<StatusDot state="live" pulse />);
    expect(screen.getByRole("status").className).toMatch(/motion-safe:animate-pulse/);
  });
});
