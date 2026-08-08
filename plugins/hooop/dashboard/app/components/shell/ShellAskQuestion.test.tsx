import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PendingPermissionRequest } from "@/app/context/hooks/usePendingRequests";
import { AskQuestionCard } from "./ShellAskQuestion";

// Covers the three AskUserQuestion answer shapes in the shell: single-select,
// multi-select, and the freeform "Other" open field.

function req(input: unknown): PendingPermissionRequest {
  return {
    requestId: "r1",
    toolName: "AskUserQuestion",
    input,
    decisionReason: null,
    author: null,
  } as PendingPermissionRequest;
}

describe("AskQuestionCard", () => {
  it("single-select: choosing one option, then another, replaces it", () => {
    const onAnswer = vi.fn();
    const questions = [{ question: "Greeting?", options: [{ label: "Hello" }, { label: "Hi" }] }];
    render(
      <AskQuestionCard req={req({ questions })} questions={questions} locked={false} busy={false} onAnswer={onAnswer} />,
    );
    fireEvent.click(screen.getByText("Hello"));
    fireEvent.click(screen.getByText("Hi")); // replaces (radio)
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    const answer = onAnswer.mock.calls[0][0] as string;
    expect(answer).toContain("Greeting? → Hi");
    expect(answer).not.toContain("Hello");
  });

  it("multi-select: keeps every chosen option in the answer", () => {
    const onAnswer = vi.fn();
    const questions = [
      { question: "Files?", multiSelect: true, options: [{ label: "a.txt" }, { label: "b.txt" }, { label: "c.txt" }] },
    ];
    render(
      <AskQuestionCard req={req({ questions })} questions={questions} locked={false} busy={false} onAnswer={onAnswer} />,
    );
    fireEvent.click(screen.getByText("a.txt"));
    fireEvent.click(screen.getByText("c.txt"));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    const answer = onAnswer.mock.calls[0][0] as string;
    expect(answer).toContain("a.txt");
    expect(answer).toContain("c.txt");
    expect(answer).not.toContain("b.txt");
  });

  it("open field: an 'Other' freeform answer is included", () => {
    const onAnswer = vi.fn();
    const questions = [{ question: "Which?", options: [{ label: "Preset" }] }];
    render(
      <AskQuestionCard req={req({ questions })} questions={questions} locked={false} busy={false} onAnswer={onAnswer} />,
    );
    fireEvent.click(screen.getByText("Other…"));
    fireEvent.change(screen.getByPlaceholderText("type your answer…"), {
      target: { value: "something custom" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onAnswer.mock.calls[0][0]).toContain("something custom");
  });

  it("spectate lock: read-only, no submit", () => {
    const onAnswer = vi.fn();
    const questions = [{ question: "Q?", options: [{ label: "A" }] }];
    render(
      <AskQuestionCard req={req({ questions })} questions={questions} locked busy={false} onAnswer={onAnswer} />,
    );
    expect(screen.getByText(/only the host or a driver can answer/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
  });
});
