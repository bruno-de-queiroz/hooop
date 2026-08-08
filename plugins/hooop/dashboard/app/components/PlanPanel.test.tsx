import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import PlanPanel from "./PlanPanel";

// usePlanComments polls the shared store; stub fetch so it's an inert no-op
// (returns no comments) and the tests focus on the panel's own behavior.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ comments: [], you: "host" }) })));
  // jsdom's Range doesn't implement geometry; the comment-highlight overlay
  // calls getClientRects/getBoundingClientRect. Stub them to empty geometry so
  // rendering a commented plan doesn't throw (the pins just resolve to null).
  if (typeof Range !== "undefined") {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }
});

function setup(overrides: Partial<React.ComponentProps<typeof PlanPanel>> = {}) {
  const onApprove = vi.fn(async () => {});
  const onReject = vi.fn(async () => {});
  const onClose = vi.fn();
  render(
    <PlanPanel
      sessionId="s1"
      requestId="r1"
      plan={"# Plan\n\nStep one does the thing."}
      sessionLabel="weather-skill"
      onApprove={onApprove}
      onReject={onReject}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onApprove, onReject, onClose };
}

describe("PlanPanel", () => {
  it("renders the plan markdown under a Plan review header", () => {
    setup();
    expect(screen.getByText("Plan review")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/Step one does the thing/)).toBeInTheDocument();
  });

  it("Approve calls onApprove", async () => {
    const { onApprove } = setup();
    await act(async () => {
      fireEvent.click(screen.getByText("Approve"));
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("Request changes is disabled until there is feedback, then posts the note", async () => {
    const { onReject } = setup();
    const btn = screen.getByRole("button", { name: "Request changes" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    const note = screen.getByPlaceholderText(/add an overall note/i);
    await act(async () => {
      fireEvent.change(note, { target: { value: "Tighten step one." } });
    });
    expect((screen.getByRole("button", { name: "Request changes" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    });
    expect(onReject).toHaveBeenCalledWith("Tighten step one.");
  });

  it("blocks Approve while the plan has open comments — they must go back via Request changes", async () => {
    // A shared comment is present: approve is meant to send the plan as-written,
    // so it must be disabled until the annotation is sent back or cleared.
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        comments: [{ id: "c1", author: "Sören", body: "add a docstring", quote: "thing", offset: 5, length: 5 }],
        you: "host",
      }),
    })));
    const { onApprove } = setup();
    // Let the comments poll resolve into state.
    await act(async () => { await Promise.resolve(); });

    const approveBtn = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);
    expect(screen.getByText(/open comment/i)).toBeInTheDocument();
    // Request changes stays available — that's how the comment gets sent.
    expect((screen.getByRole("button", { name: "Request changes" }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { fireEvent.click(approveBtn); });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("blocks Approve while an unsent overall note remains — it would be dropped too", async () => {
    // No comments, but a typed-yet-unsent overall note: approve drops it just
    // like a comment, so it must go back via Request changes or be cleared.
    const { onApprove } = setup();
    const note = screen.getByPlaceholderText(/add an overall note/i);
    await act(async () => {
      fireEvent.change(note, { target: { value: "Reconsider step two." } });
    });

    const approveBtn = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);
    expect(screen.getByText(/unsent note/i)).toBeInTheDocument();
    // Request changes is the escape hatch — it serializes the note to the model.
    expect((screen.getByRole("button", { name: "Request changes" }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { fireEvent.click(approveBtn); });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("surfaces an error message", () => {
    setup({ error: "HTTP 500" });
    expect(screen.getByText("HTTP 500")).toBeInTheDocument();
  });

  it("hides the decision controls when the viewer can't decide (drive peer)", () => {
    setup({ canDecide: false });
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    expect(screen.queryByText("Request changes")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/add an overall note/i)).not.toBeInTheDocument();
    // …but the plan is still shown so the peer can read and comment on it.
    expect(screen.getByText(/Step one does the thing/)).toBeInTheDocument();
    expect(screen.getByText(/host approves or rejects/i)).toBeInTheDocument();
  });

  it("close button calls onClose", async () => {
    const { onClose } = setup();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Close"));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
