import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerShutdown, type ShutdownOptions } from "./shutdown";

function makeLogger() {
  return { warn: vi.fn<(mod: string, msg: string, ctx?: Record<string, unknown>) => void>() };
}

// Let all pending microtasks (promise .then callbacks) settle.
// Chaining several resolved promises flushes the queue depth-first.
const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("registerShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drainer resolves before graceMs — no force-exit", async () => {
    const { __handler } = registerShutdown({
      graceMs: 1_000,
      logger: makeLogger(),
      drainer: async () => { /* resolves immediately */ },
    });

    __handler("SIGTERM");
    await flushMicrotasks();

    // Advance past graceMs; timer should have been cleared.
    vi.advanceTimersByTime(2_000);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("drainer hangs — force-exit fires after graceMs", async () => {
    const { __handler } = registerShutdown({
      graceMs: 500,
      logger: makeLogger(),
      drainer: () => new Promise(() => { /* never resolves */ }),
    });

    __handler("SIGTERM");
    await flushMicrotasks();

    vi.advanceTimersByTime(499);
    expect(process.exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("drainer rejects — warn logged, force-exit still fires at graceMs", async () => {
    const logger = makeLogger();
    const { __handler } = registerShutdown({
      graceMs: 500,
      logger,
      drainer: async () => { throw new Error("drain boom"); },
    });

    __handler("SIGTERM");
    await flushMicrotasks();

    expect(logger.warn).toHaveBeenCalledWith(
      "shutdown",
      "drainer rejected",
      expect.objectContaining({ err: expect.stringContaining("drain boom") }),
    );

    vi.advanceTimersByTime(500);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("re-entrancy: second signal does not invoke drainer again", async () => {
    const drainer = vi.fn(async () => { /* never resolves */ });
    const { __handler } = registerShutdown({ drainer, graceMs: 1_000, logger: makeLogger() });

    __handler("SIGTERM");
    __handler("SIGTERM"); // second call — should be ignored
    __handler("SIGINT");  // different signal — still ignored
    await flushMicrotasks();

    expect(drainer).toHaveBeenCalledTimes(1);
  });
});
