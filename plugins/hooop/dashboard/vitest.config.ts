import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    include: ["**/*.{test,spec}.{ts,tsx}"],
    // e2e/** is Playwright's territory — keep vitest out, otherwise it tries
    // to import Playwright's `test` and `expect` which don't exist in jsdom.
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
  },
});
