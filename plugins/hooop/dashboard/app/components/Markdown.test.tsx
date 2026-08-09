import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders paragraphs as <p> text", () => {
    render(<Markdown source="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(screen.getByText("Hello world").tagName).toBe("P");
  });

  it("renders fenced code blocks with language label AND the code body", () => {
    const source = "```ts\nconst x = 1;\n```";
    const { container } = render(<Markdown source={source} />);
    const pre = container.querySelector("pre");
    const label = container.querySelector(".hooop-code-lang.uppercase");

    expect(pre).toBeInTheDocument();
    expect(label?.textContent).toBe("ts");
    // The code body must be present. highlight.js wraps tokens in spans, so
    // assert on the unwrapped text rather than DOM structure.
    expect(pre?.textContent?.replace(/\s+/g, " ").trim()).toBe("const x = 1;");
  });

  it("renders inline code with backticks as <code>", () => {
    render(<Markdown source="Use `const` for variables" />);
    const code = screen.getByText("const");
    expect(code.tagName).toBe("CODE");
    expect(code).toHaveClass("bg-sunken");
  });

  it("renders bold as <strong>", () => {
    render(<Markdown source="This is **bold** text" />);
    const strong = screen.getByText("bold");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders italic as <em>", () => {
    render(<Markdown source="This is *italic* text" />);
    const em = screen.getByText("italic");
    expect(em.tagName).toBe("EM");
  });

  it("renders italic with underscore as <em>", () => {
    render(<Markdown source="This is _italic_ text" />);
    const em = screen.getByText("italic");
    expect(em.tagName).toBe("EM");
  });

  it("renders h1 heading with size class", () => {
    const { container } = render(<Markdown source="# Heading 1" />);
    const h1 = container.querySelector(".text-\\[15px\\]");
    expect(h1).toBeInTheDocument();
    expect(h1?.textContent).toContain("Heading 1");
  });

  it("renders h2 heading with size class", () => {
    const { container } = render(<Markdown source="## Heading 2" />);
    const h2 = container.querySelector(".text-\\[14px\\]");
    expect(h2).toBeInTheDocument();
    expect(h2?.textContent).toContain("Heading 2");
  });

  it("renders h3 heading with size class", () => {
    const { container } = render(<Markdown source="### Heading 3" />);
    const h3 = container.querySelector(".text-\\[13px\\]");
    expect(h3).toBeInTheDocument();
    expect(h3?.textContent).toContain("Heading 3");
  });

  it("renders bullet lists as <ul><li>", () => {
    const source = "- item one\n- item two";
    const { container } = render(<Markdown source={source} />);
    const ul = container.querySelector("ul");
    const items = container.querySelectorAll("li");

    expect(ul).toBeInTheDocument();
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("item one");
    expect(items[1].textContent).toBe("item two");
  });

  it("renders ordered lists as <ol><li>", () => {
    const source = "1. first\n2. second";
    const { container } = render(<Markdown source={source} />);
    const ol = container.querySelector("ol");
    const items = container.querySelectorAll("li");

    expect(ol).toBeInTheDocument();
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("first");
    expect(items[1].textContent).toBe("second");
  });

  it("renders blockquotes as <blockquote>", () => {
    const source = "> This is quoted";
    const { container } = render(<Markdown source={source} />);
    const blockquote = container.querySelector("blockquote");

    expect(blockquote).toBeInTheDocument();
    expect(blockquote?.textContent).toContain("This is quoted");
  });

  it("does not render unsafe javascript: links", () => {
    const { container } = render(<Markdown source="[click me](javascript:alert(1))" />);
    const link = screen.queryByRole("link");

    expect(link).not.toBeInTheDocument();
    // The unsafe link is rendered as text without creating an anchor tag
    expect(container.textContent).toContain("click me");
  });

  it("renders safe http links", () => {
    render(<Markdown source="[example](https://example.com)" />);
    const link = screen.getByRole("link");

    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders safe mailto links", () => {
    render(<Markdown source="[email](mailto:test@example.com)" />);
    const link = screen.getByRole("link");

    expect(link).toHaveAttribute("href", "mailto:test@example.com");
  });

  it("does not inject raw HTML in paragraph text", () => {
    const { container } = render(<Markdown source="<img src=x onerror='alert(1)'/>" />);
    // The HTML should be escaped and rendered as text, not injected as DOM
    expect(screen.getByText(/<img/)).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });

  it("handles multiple inline styles in one paragraph", () => {
    render(<Markdown source="This is **bold** and *italic* and `code`" />);

    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });

  it("renders code blocks without language label if no lang specified", () => {
    const source = "```\nplain code\n```";
    const { container } = render(<Markdown source={source} />);
    const pre = container.querySelector("pre");

    expect(pre).toBeInTheDocument();
    // No language label div should exist
    const langLabels = container.querySelectorAll(".uppercase.tracking-wider");
    expect(langLabels.length).toBe(0);
  });

  it("does NOT escape out of a code fence even when the body contains </code><img onerror=...>", () => {
    const source = "```html\n</code><img src=x onerror=alert(1)><code>\n```";
    const { container } = render(<Markdown source={source} />);
    // No <img> should have been injected — highlight.js must escape this.
    expect(container.querySelector("img")).not.toBeInTheDocument();
    // The literal text should appear in the rendered code body.
    expect(container.textContent).toContain("onerror=alert(1)");
  });

  it("renders a GFM table with header and body cells", () => {
    const source = ["| Item | EUR |", "|------|-----|", "| Hotel | 440 |", "| Food | 60 |"].join(
      "\n",
    );
    const { container } = render(<Markdown source={source} />);
    const table = container.querySelector("table");
    const headers = container.querySelectorAll("th");
    const rows = container.querySelectorAll("tbody tr");

    expect(table).toBeInTheDocument();
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toBe("Item");
    expect(headers[1].textContent).toBe("EUR");
    expect(rows).toHaveLength(2);
    const firstRowCells = rows[0].querySelectorAll("td");
    expect(firstRowCells[0].textContent).toBe("Hotel");
    expect(firstRowCells[1].textContent).toBe("440");
  });

  it("applies column alignment from the separator row", () => {
    const source = ["| L | C | R |", "|:---|:---:|---:|", "| a | b | c |"].join("\n");
    const { container } = render(<Markdown source={source} />);
    const headers = container.querySelectorAll("th");

    expect(headers[0]).toHaveClass("text-left");
    expect(headers[1]).toHaveClass("text-center");
    expect(headers[2]).toHaveClass("text-right");
  });

  it("renders inline formatting inside table cells", () => {
    const source = ["| Name | Note |", "|------|------|", "| **bold** | `code` |"].join("\n");
    render(<Markdown source={source} />);

    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });

  it("handles escaped pipes inside table cells", () => {
    const source = ["| Expr | Meaning |", "|------|---------|", "| a \\| b | or |"].join("\n");
    const { container } = render(<Markdown source={source} />);
    const firstCell = container.querySelector("tbody td");

    expect(firstCell?.textContent).toBe("a | b");
  });

  it("does not treat a lone pipe line without a separator as a table", () => {
    const { container } = render(<Markdown source="a | b | c" />);
    expect(container.querySelector("table")).not.toBeInTheDocument();
    expect(container.querySelector("p")?.textContent).toContain("a | b | c");
  });

  // Corner cases the old hand-rolled parser could not handle; a real GFM parser
  // gets these right, which is the reason for the library.
  it("renders nested lists", () => {
    const source = ["- parent", "  - child one", "  - child two"].join("\n");
    const { container } = render(<Markdown source={source} />);
    const nested = container.querySelector("li ul");
    expect(nested).toBeInTheDocument();
    expect(nested?.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders GFM task lists as checkboxes", () => {
    const source = ["- [x] done", "- [ ] todo"].join("\n");
    const { container } = render(<Markdown source={source} />);
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it("renders GFM strikethrough as <del>", () => {
    render(<Markdown source="This is ~~gone~~ text" />);
    expect(screen.getByText("gone").tagName).toBe("DEL");
  });

  it("treats a single newline as a line break (chat authoring)", () => {
    const { container } = render(<Markdown source={"line one\nline two"} />);
    expect(container.querySelector("br")).toBeInTheDocument();
  });
});

describe("Markdown — #file mention chips", () => {
  it("chips a mention and leaves an issue reference alone", () => {
    const { container } = render(<Markdown source="see #src/a.ts about #123" fileChips />);
    const chips = [...container.querySelectorAll("span,button")].filter(
      (e) => e.textContent === "#src/a.ts",
    );
    expect(chips).toHaveLength(1);
    expect(container.textContent).toContain("#123");
  });

  it("renders chips as inert spans when no handler is given", () => {
    const { container } = render(<Markdown source="see #src/a.ts" fileChips />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders a clickable button and reports the parsed path and line", async () => {
    const seen: Array<{ path: string; line: number | null }> = [];
    render(<Markdown source="see #src/a.ts:42" fileChips onFileMention={(m) => seen.push(m)} />);
    const btn = screen.getByRole("button", { name: "#src/a.ts:42" });
    btn.click();
    expect(seen).toEqual([{ path: "src/a.ts", line: 42 }]);
  });

  it("reports a null line for a mention without a suffix", () => {
    const seen: Array<{ path: string; line: number | null }> = [];
    render(<Markdown source="see #README.md" fileChips onFileMention={(m) => seen.push(m)} />);
    screen.getByRole("button", { name: "#README.md" }).click();
    expect(seen).toEqual([{ path: "README.md", line: null }]);
  });

  it("does not chip inside a fenced code block", () => {
    const source = "```sh\n#setup\n```";
    render(<Markdown source={source} fileChips onFileMention={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Markdown — @peer mention chips", () => {
  const peers = [
    { handle: "sam", name: "Sam" },
    { handle: "bruno-de-queiroz", name: "Bruno de Queiroz" },
  ];

  it("chips a handle that is in the roster, showing the DISPLAY NAME", () => {
    // The message text carries "@sam" (that's what matching and notification
    // targeting read); the bubble should read "@Sam".
    const { container } = render(<Markdown source="ask @sam about it" fileChips peers={peers} />);
    const chip = [...container.querySelectorAll("span")].find((e) => e.textContent === "@Sam");
    expect(chip).toBeDefined();
    expect(container.textContent).toBe("ask @Sam about it");
  });

  it("shows a multi-word display name the handle could never carry", () => {
    const { container } = render(
      <Markdown source="ping @bruno-de-queiroz" fileChips peers={peers} />,
    );
    expect(container.textContent).toBe("ping @Bruno de Queiroz");
  });

  it("leaves an @token that is nobody as prose", () => {
    // The roster check is what keeps "@types/node" out of the chip treatment.
    const { container } = render(<Markdown source="install @types/node now" fileChips peers={peers} />);
    expect([...container.querySelectorAll("span")].some((e) => e.textContent === "@types")).toBe(false);
    expect(container.textContent).toContain("@types/node");
  });

  it("does not chip inside an email address", () => {
    const { container } = render(<Markdown source="mail sam@sam.dev" fileChips peers={peers} />);
    expect([...container.querySelectorAll("span")].some((e) => e.textContent === "@Sam")).toBe(false);
    expect(container.textContent).toContain("sam@sam.dev");
  });

  it("chips nothing when there is no roster", () => {
    const { container } = render(<Markdown source="ask @sam" fileChips />);
    expect(container.textContent).toBe("ask @sam");
  });

  it("marks a mention of the viewer differently from a mention of someone else", () => {
    const { container } = render(
      <Markdown source="@sam and @bruno-de-queiroz" fileChips peers={peers} mePeer="sam" />,
    );
    const mine = [...container.querySelectorAll("span")].find((e) => e.textContent === "@Sam");
    const other = [...container.querySelectorAll("span")].find((e) => e.textContent === "@Bruno de Queiroz");
    expect(mine?.getAttribute("style")).not.toBe(other?.getAttribute("style"));
    // The neutral chip inverts with the theme; only "mentions you" carries a
    // hue, so the two fills must come from different tokens.
    expect(mine?.getAttribute("style")).toContain("--accent-press");
    expect(other?.getAttribute("style")).toContain("--ink");
  });

  it("renders file and peer mentions together, in document order", () => {
    // The two patterns are scanned separately, so their hits have to be merged
    // back in order or the surrounding text fragments come out shuffled.
    const { container } = render(
      <Markdown source="hey @sam look at #src/a.ts please" fileChips peers={peers} />,
    );
    expect(container.textContent).toBe("hey @Sam look at #src/a.ts please");
  });

  it("puts a file mention before a peer mention back in the right order too", () => {
    const { container } = render(
      <Markdown source="#src/a.ts then @sam" fileChips peers={peers} />,
    );
    expect(container.textContent).toBe("#src/a.ts then @Sam");
  });

  it("does not chip a handle inside a fenced code block", () => {
    // Asserted on the CHIP, not on the text: highlight.js wraps code tokens in
    // spans of their own, so "is there a span saying @sam" is always true here.
    const { container } = render(<Markdown source={"```\n@sam\n```"} fileChips peers={peers} />);
    const chips = [...container.querySelectorAll("span")].filter(
      (e) => e.className.includes("align-baseline") && e.textContent?.startsWith("@"),
    );
    expect(chips).toHaveLength(0);
    expect(container.textContent).toContain("@sam");
  });
});
