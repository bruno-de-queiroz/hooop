/**
 * Next.js server instrumentation hook (Next 14 `experimental.instrumentationHook`).
 *
 * Runs once per server process for each runtime (nodejs, edge). We only want
 * to start the ingestor in the nodejs runtime — it uses node:net, node:fs,
 * better-sqlite3, etc. Lazy-importing a separate file keeps those imports out
 * of the edge bundle entirely (the edge bundler never sees instrumentation-node.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
