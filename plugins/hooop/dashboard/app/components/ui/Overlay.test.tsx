import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Modal, SlideOver, Drawer } from "./Overlay";

describe("Overlay", () => {
  it("renders nothing when closed", () => {
    render(
      <Modal open={false} onClose={() => {}} label="settings">
        body
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a labeled modal dialog when open", () => {
    render(
      <Modal open onClose={() => {}} label="Settings">
        <button>ok</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} label="m">
        <button>ok</button>
      </Modal>,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on backdrop press but not on panel press", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} label="m">
        <button>ok</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    // The backdrop is the dialog's parent (the flex container).
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("locks body scroll while open and restores after the close animation", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <Modal open onClose={() => {}} label="m">
          x
        </Modal>,
      );
      expect(document.body.style.overflow).toBe("hidden");

      rerender(
        <Modal open={false} onClose={() => {}} label="m">
          x
        </Modal>,
      );
      // The panel stays mounted (and scroll stays locked) while the exit
      // animation plays — it must not vanish instantly.
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(document.body.style.overflow).toBe("hidden");

      // Once the exit animation completes, it unmounts and restores scroll.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.body.style.overflow).not.toBe("hidden");
    } finally {
      vi.useRealTimers();
    }
  });

  it("portals into a custom container when given", () => {
    const host = document.createElement("div");
    host.id = "themed";
    document.body.appendChild(host);
    render(
      <Modal open onClose={() => {}} label="m" container={host}>
        <button>ok</button>
      </Modal>,
    );
    // The dialog lives inside the provided container, not directly under body.
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    host.remove();
  });

  it("SlideOver and Drawer carry their placement shadow", () => {
    const { unmount } = render(
      <SlideOver open onClose={() => {}} label="s">
        x
      </SlideOver>,
    );
    expect(screen.getByRole("dialog").className).toMatch(/shadow-slideover/);
    unmount();
    render(
      <Drawer open onClose={() => {}} label="d">
        x
      </Drawer>,
    );
    expect(screen.getByRole("dialog").className).toMatch(/shadow-drawer/);
  });
});
