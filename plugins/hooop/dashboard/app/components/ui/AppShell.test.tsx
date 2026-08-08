import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppShell, TitleBar, Rail, CenterPane, StatusBar } from "./AppShell";

describe("AppShell", () => {
  it("composes the window regions", () => {
    render(
      <AppShell>
        <TitleBar>title</TitleBar>
        <Rail side="left">left</Rail>
        <CenterPane>center</CenterPane>
        <StatusBar>status</StatusBar>
      </AppShell>,
    );
    expect(screen.getByText("title")).toBeInTheDocument();
    expect(screen.getByText("left")).toBeInTheDocument();
    expect(screen.getByText("center")).toBeInTheDocument();
    expect(screen.getByText("status")).toBeInTheDocument();
  });

  it("shows a collapse handle that toggles the rail", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <Rail side="right" collapsible collapsed={false} onToggle={onToggle}>
        skills
      </Rail>,
    );
    const handle = screen.getByRole("button", { name: "Collapse panel" });
    expect(handle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("skills")).toBeInTheDocument();
    fireEvent.click(handle);
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(
      <Rail side="right" collapsible collapsed onToggle={onToggle}>
        skills
      </Rail>,
    );
    expect(screen.getByRole("button", { name: "Expand panel" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // Collapsed rail hides its content.
    expect(screen.queryByText("skills")).toBeNull();
  });
});
