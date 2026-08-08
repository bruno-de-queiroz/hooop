import { defineConfig } from "vitest/config";
import path from "node:path";

const SHARED = path.resolve(__dirname, "../shared");

export default defineConfig({
  resolve: {
    alias: {
      "@shared": SHARED,
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["**/*.test.ts", "../shared/**/*.test.ts"],
    exclude: ["node_modules/**", "../shared/node_modules/**"],
  },
});
