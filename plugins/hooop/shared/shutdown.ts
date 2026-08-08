/**
 * Graceful-shutdown helper for the sandbox process.
 *
 * Registers signal handlers and races the caller's drain callback against a
 * force-exit timer. Keeps this logic in one place so server.ts stays focused
 * on routing. A near-duplicate lives in dashboard/shutdown.ts; the two can
 * merge into a shared package once a third caller exists.
 */

export interface ShutdownOptions {
  drainer: (signal: NodeJS.Signals) => Promise<void>;
  graceMs: number;
  logger: { warn: (mod: string, msg: string, ctx?: Record<string, unknown>) => void };
  signals?: NodeJS.Signals[];
}

/**
 * Register graceful-shutdown signal handlers.
 *
 * Returns the inner handler so tests can invoke it directly without emitting
 * a real OS signal (the `__handler` prefix is the convention used by loggers
 * in this codebase for test-only exports).
 */
export function registerShutdown(opts: ShutdownOptions): { __handler: (signal: NodeJS.Signals) => void } {
  const { drainer, graceMs, logger } = opts;
  const signals: NodeJS.Signals[] = opts.signals ?? ["SIGTERM", "SIGINT"];

  let triggered = false;

  const handler = (signal: NodeJS.Signals) => {
    if (triggered) return;
    triggered = true;

    const timer = setTimeout(() => {
      logger.warn("shutdown", "force-exiting after graceMs ms", { graceMs, signal });
      process.exit(0);
    }, graceMs);
    timer.unref();

    drainer(signal).then(
      () => { clearTimeout(timer); },
      (err: unknown) => {
        logger.warn("shutdown", "drainer rejected", { err: String(err), signal });
        // timer still runs; force-exit will fire at graceMs
      },
    );
  };

  for (const signal of signals) {
    process.on(signal, () => handler(signal));
  }

  return { __handler: handler };
}
