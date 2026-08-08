import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field, Input, Select, Textarea } from "./Field";

describe("Field", () => {
  it("associates the label with the control via a generated id", () => {
    render(
      <Field label="Session name">
        <Input placeholder="untitled" />
      </Field>,
    );
    const input = screen.getByLabelText("Session name");
    expect(input).toBe(screen.getByPlaceholderText("untitled"));
  });

  it("wires aria-describedby to the hint", () => {
    render(
      <Field label="Model" hint="Applies to the next turn">
        <Select>
          <option>opus</option>
        </Select>
      </Field>,
    );
    const select = screen.getByLabelText("Model");
    const describedBy = select.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent("Applies to the next turn");
  });

  it("shows an error with role=alert and hides the hint", () => {
    render(
      <Field label="Token" hint="from the launcher" error="Required">
        <Input />
      </Field>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
    expect(screen.queryByText("from the launcher")).toBeNull();
  });

  it("renders a resizable textarea", () => {
    render(<Textarea aria-label="notes" />);
    expect(screen.getByLabelText("notes").className).toMatch(/resize-y/);
  });
});
