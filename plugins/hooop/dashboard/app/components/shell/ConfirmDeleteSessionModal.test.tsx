import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDeleteSessionModal } from "./ConfirmDeleteSessionModal";

describe("ConfirmDeleteSessionModal", () => {
  it("renders nothing when closed", () => {
    render(
      <ConfirmDeleteSessionModal
        open={false}
        sessionName="quiet-morning-fog"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the session name and warning when open", () => {
    render(
      <ConfirmDeleteSessionModal
        open
        sessionName="quiet-morning-fog"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Delete session?" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/quiet-morning-fog/)).toBeInTheDocument();
    expect(
      screen.getByText(/workspace for this session will also be permanently deleted/i),
    ).toBeInTheDocument();
  });

  it("calls onConfirm when Delete is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDeleteSessionModal
        open
        sessionName="quiet-morning-fog"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(
      <ConfirmDeleteSessionModal
        open
        sessionName="quiet-morning-fog"
        onConfirm={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables the action buttons while busy", () => {
    render(
      <ConfirmDeleteSessionModal
        open
        sessionName="quiet-morning-fog"
        onConfirm={() => {}}
        onClose={() => {}}
        busy
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete/ })).toBeDisabled();
  });
});
