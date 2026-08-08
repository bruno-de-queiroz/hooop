import { readFileSync } from "node:fs";

export function parseFrontmatter(filePath: string): Record<string, string> {
  try {
    const text = readFileSync(filePath, "utf-8");
    const match = text.match(/^---\s*([\s\S]*?)\s*---/);
    if (!match) return {};
    const fm = match[1];
    const result: Record<string, string> = {};
    const lines = fm.split("\n");
    for (const line of lines) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) {
        const key = m[1];
        const value = m[2].trim().replace(/^['"]|['"]$/g, "");
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}
