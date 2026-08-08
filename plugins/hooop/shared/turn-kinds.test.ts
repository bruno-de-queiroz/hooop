import { describe, it, expect } from "vitest";
import { AGENT_DIRECTIVE_KIND, TASK_NOTIFICATION_KIND, isHiddenTurnKind } from "./turn-kinds";

describe("isHiddenTurnKind", () => {
  it("hides agent-directive and task-notification turns", () => {
    expect(isHiddenTurnKind(AGENT_DIRECTIVE_KIND)).toBe(true);
    expect(isHiddenTurnKind(TASK_NOTIFICATION_KIND)).toBe(true);
  });

  it("does not hide ordinary chat, command, or lifecycle-notice kinds", () => {
    expect(isHiddenTurnKind(null)).toBe(false);
    expect(isHiddenTurnKind(undefined)).toBe(false);
    expect(isHiddenTurnKind("command")).toBe(false);
    expect(isHiddenTurnKind("plan-approval")).toBe(false);
    expect(isHiddenTurnKind("question-answer")).toBe(false);
  });
});
