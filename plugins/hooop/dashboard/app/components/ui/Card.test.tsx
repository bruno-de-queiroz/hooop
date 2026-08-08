import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card } from "./Card";

describe("Card", () => {
  it("defaults to an elevated, padded surface", () => {
    render(<Card>hi</Card>);
    const cls = screen.getByText("hi").className;
    expect(cls).toMatch(/bg-elevated/);
    expect(cls).toMatch(/p-4/);
  });

  it("renders a sunken well without padding when asked", () => {
    render(
      <Card surface="sunken" padded={false}>
        well
      </Card>,
    );
    const cls = screen.getByText("well").className;
    expect(cls).toMatch(/bg-sunken/);
    expect(cls).not.toMatch(/\bp-4\b/);
  });
});
