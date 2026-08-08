import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  it("renders initials when no child is given", () => {
    render(<Avatar initials="BQ" />);
    expect(screen.getByText("BQ")).toBeInTheDocument();
  });

  it("prefers an icon child over initials", () => {
    render(
      <Avatar initials="BQ">
        <svg data-testid="icon" />
      </Avatar>,
    );
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.queryByText("BQ")).toBeNull();
  });

  it("applies a cue ring", () => {
    const { container } = render(<Avatar initials="P" ring="peer" />);
    expect(container.firstChild).toHaveClass("ring-peer-bubble");
  });
});
