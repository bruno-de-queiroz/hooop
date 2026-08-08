import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button, IconButton } from "./Button";

describe("Button", () => {
  it("defaults to type=button so it never submits a form implicitly", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "button");
  });

  it("applies the accent variant fill", () => {
    render(<Button variant="accent">Send</Button>);
    expect(screen.getByRole("button", { name: "Send" }).className).toMatch(/bg-accent/);
  });

  it("merges a conflicting override via cn (last-wins)", () => {
    render(
      <Button variant="pill" className="bg-elevated-2">
        X
      </Button>,
    );
    const cls = screen.getByRole("button").className;
    expect(cls).toMatch(/bg-elevated-2/);
    expect(cls).not.toMatch(/bg-elevated(?!-2)/);
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Tap</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("IconButton", () => {
  it("exposes its label as aria-label", () => {
    render(<IconButton label="Close">×</IconButton>);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
