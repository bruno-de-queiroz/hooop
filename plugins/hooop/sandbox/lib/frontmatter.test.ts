import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fm-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe("parseFrontmatter", () => {
  it("parses a standard --- block", () => {
    const path = fixture("a.md", "---\nname: alpha\ndescription: does a thing\n---\nbody text");
    expect(parseFrontmatter(path)).toEqual({ name: "alpha", description: "does a thing" });
  });

  it("strips surrounding quotes from values", () => {
    const path = fixture("b.md", `---\nname: "quoted"\ndescription: 'apostrophed'\n---\n`);
    expect(parseFrontmatter(path)).toEqual({ name: "quoted", description: "apostrophed" });
  });

  it("returns an empty object when there is no frontmatter block", () => {
    const path = fixture("c.md", "no frontmatter here\nsome other content");
    expect(parseFrontmatter(path)).toEqual({});
  });

  it("returns an empty object for unreadable files", () => {
    expect(parseFrontmatter(join(dir, "does-not-exist.md"))).toEqual({});
  });

  it("returns only the recognised key:value lines, ignoring junk", () => {
    const path = fixture("d.md", "---\nname: x\nnot a key\n---\n");
    const out = parseFrontmatter(path);
    expect(out.name).toBe("x");
  });
});
