import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Bubble } from "./Bubble";

describe("Bubble", () => {
  it("styles the host bubble green and right-aligned", () => {
    render(<Bubble author="host">hi</Bubble>);
    const cls = screen.getByText("hi").className;
    expect(cls).toMatch(/bg-host-bubble/);
    expect(cls).toMatch(/self-end/);
  });

  it("defaults to the assistant bubble on the left", () => {
    render(<Bubble>reply</Bubble>);
    const cls = screen.getByText("reply").className;
    expect(cls).toMatch(/bg-elevated/);
    expect(cls).toMatch(/self-start/);
  });

  it("widens for code/tool-bearing messages", () => {
    render(
      <Bubble wide author="assistant">
        code
      </Bubble>,
    );
    expect(screen.getByText("code").className).toMatch(/w-\[48rem\]/);
  });
});
