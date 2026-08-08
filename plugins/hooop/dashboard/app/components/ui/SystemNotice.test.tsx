import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SystemNotice } from "./SystemNotice";

describe("SystemNotice", () => {
  it("renders its message centered and muted", () => {
    render(<SystemNotice>Session resumed</SystemNotice>);
    const el = screen.getByText("Session resumed").parentElement!;
    expect(el.className).toMatch(/justify-center/);
    expect(el.className).toMatch(/text-ink-faint/);
  });
});
