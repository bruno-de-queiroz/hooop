import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Panel } from "./Panel";

describe("Panel", () => {
  it("renders header title, count, icon, and actions", () => {
    render(
      <Panel>
        <Panel.Header
          icon={<svg data-testid="icon" />}
          title="Skills"
          count={14}
          actions={<button>refresh</button>}
        />
        <Panel.Body>body content</Panel.Body>
      </Panel>,
    );
    expect(screen.getByRole("heading", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByText("(14)")).toBeInTheDocument();
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "refresh" })).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("omits the count when not provided", () => {
    render(
      <Panel>
        <Panel.Header title="Events" />
      </Panel>,
    );
    expect(screen.queryByText(/\(\d+\)/)).toBeNull();
  });
});
