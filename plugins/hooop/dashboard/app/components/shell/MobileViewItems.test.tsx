/**
 * @vitest-environment jsdom
 *
 * On a phone the right rail does not exist, so this menu is the ONLY way to
 * reach Details, Files and the preview. Browser was missing from it: the app the
 * agent had just built was reachable only by opening another section first and
 * noticing the tabs inside, or by the agent opening it for you — which is not a
 * way to find something.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MobileViewItems } from "./MobileViewItems";

const previewUI: { preview: { state: string } | null } = { preview: null };
vi.mock("@/app/context/PreviewUIProvider", () => ({
  usePreviewUI: () => previewUI,
}));

beforeEach(() => { previewUI.preview = null; });

/** The dot the rail uses for "there is an app running here". */
const dot = () => screen.queryByRole("status");

describe("reaching the rail's sections from a phone", () => {
  it("offers all three, Browser included", () => {
    render(<MobileViewItems onPick={vi.fn()} />);
    for (const label of ["Details", "Files", "Browser"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("opens the one that was tapped", () => {
    const onPick = vi.fn();
    render(<MobileViewItems onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /Browser/ }));
    expect(onPick).toHaveBeenCalledWith("browser");
  });

  it("shows a running app before you go looking for it", () => {
    previewUI.preview = { state: "running" };
    render(<MobileViewItems onPick={vi.fn()} />);
    expect(dot()).toBeInTheDocument();
  });

  it("shows nothing when there is no preview, rather than an idle dot", () => {
    render(<MobileViewItems onPick={vi.fn()} />);
    expect(dot()).toBeNull();
  });

  it("pulses only while the app is still starting", () => {
    previewUI.preview = { state: "starting" };
    const { rerender } = render(<MobileViewItems onPick={vi.fn()} />);
    const starting = dot()?.className ?? "";
    previewUI.preview = { state: "running" };
    rerender(<MobileViewItems onPick={vi.fn()} />);
    expect(starting).not.toBe(dot()?.className ?? "");
  });

  it("stays out of the way on a desktop, where the rail is the way in", () => {
    const { container } = render(<MobileViewItems onPick={vi.fn()} />);
    expect(container.firstElementChild).toHaveClass("lg:hidden");
  });
});
