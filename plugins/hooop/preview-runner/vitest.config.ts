import { defineConfig } from "vitest/config";
import path from "node:path";

const SHARED = path.resolve(__dirname, "../shared");
const SANDBOX = path.resolve(__dirname, "../sandbox");

export default defineConfig({
  resolve: {
    alias: {
      "@shared": SHARED,
      // The Landlock policy lives in sandbox/lib and is shared with this image
      // by COPY rather than by duplication — see the Dockerfile.
      "@sandbox": SANDBOX,
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
