import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolCard } from "./ToolCard";

describe("ToolCard", () => {
  it("renders the tool name and status", () => {
    render(
      <ToolCard name="Read(file.ts)" status={<span>done</span>}>
        result preview
      </ToolCard>,
    );
    expect(screen.getByText("Read(file.ts)")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("result preview")).toBeInTheDocument();
  });

  it("omits the body when no children are given", () => {
    const { container } = render(<ToolCard name="Bash(ls)" />);
    // Only the header row is present.
    expect(container.querySelectorAll("div").length).toBe(2); // wrapper + header
  });
});
