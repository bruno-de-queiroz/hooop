import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CodeBlock } from "./CodeBlock";

describe("CodeBlock", () => {
  it("renders the language chrome and highlighted code", () => {
    const { container } = render(<CodeBlock code={"const x = 1;"} lang="ts" />);
    expect(container.querySelector(".hooop-code-lang")?.textContent).toBe("ts");
    expect(container.querySelector("pre.hljs")).toBeTruthy();
    expect(container.querySelector("code")?.textContent).toContain("const");
  });

  it("omits the language chrome when no lang is given", () => {
    const { container } = render(<CodeBlock code={"plain"} />);
    expect(container.querySelector(".hooop-code-lang")).toBeNull();
  });

  it("does not throw on an unknown language", () => {
    expect(() => render(<CodeBlock code={"x"} lang="not-a-lang" />)).not.toThrow();
  });
});
