import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Tab, TabGroup } from "./Tab";

describe("Tab", () => {
  it("reflects selection through aria-selected", () => {
    render(
      <TabGroup>
        <Tab active>View</Tab>
        <Tab>Raw</Tab>
      </TabGroup>,
    );
    const [view, raw] = screen.getAllByRole("tab");
    expect(view).toHaveAttribute("aria-selected", "true");
    expect(raw).toHaveAttribute("aria-selected", "false");
  });

  it("tints the active tab with accent by default, ink when neutral", () => {
    const { rerender } = render(<Tab active>A</Tab>);
    expect(screen.getByRole("tab").className).toMatch(/text-accent/);
    rerender(
      <Tab active tone="neutral">
        A
      </Tab>,
    );
    expect(screen.getByRole("tab").className).toMatch(/text-ink(?!-)/);
  });

  it("groups tabs in a tablist", () => {
    render(
      <TabGroup>
        <Tab>One</Tab>
      </TabGroup>,
    );
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });
});
