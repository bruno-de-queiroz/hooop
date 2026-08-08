/**
 * SSE-lifecycle integration tests for the dashboard sandbox-client.
 *
 * Exercises the long-lived /events/stream consumer end-to-end:
 *   - 401 → invalidate cached token → re-read file → reconnect with fresh token
 *   - mid-stream disconnect → reconnect after backoff, no event loss on the
 *     reconnect boundary (next event still reaches the bus)
 *   - shutdown() while connected → request destroyed, loop exits, no further
 *     reconnect attempts
 *
 * The stub speaks raw SSE over a Unix domain socket so we exercise the real
 * http parser + sse parser, not a mock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { unlinkSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHttpClient, type SandboxClient } from "./sandbox-client";

type SseHandler = (req: { token: string }, res: ServerResponse) => void;

interface SseStub {
  server: Server;
  socketPath: string;
  tokenFile: string;
  setHandler(h: SseHandler): void;
  /** Number of GET /events/stream requests observed. */
  requestCount(): number;
  writeTokenFile(value: string): void;
  close(): Promise<void>;
}

async function startSseStub(): Promise<SseStub> {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-sse-"));
  const socketPath = join(dir, "sandbox.sock");
  const tokenFile = join(dir, "sandbox.token");
  writeFileSync(tokenFile, "test-token-".padEnd(64, "x"));

  let handler: SseHandler = (_req, res) => { res.writeHead(503); res.end(); };
  let count = 0;

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    if (req.method === "GET" && path === "/events/stream") {
      count += 1;
      const token = (req.headers["x-sandbox-token"] as string) ?? "";
      handler({ token }, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not stubbed" }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

  return {
    server,
    socketPath,
    tokenFile,
    setHandler: (h) => { handler = h; },
    requestCount: () => count,
    writeTokenFile: (v) => writeFileSync(tokenFile, v),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          if (existsSync(socketPath)) try { unlinkSync(socketPath); } catch { /* ignore */ }
          resolve();
        });
      }),
  };
}

function writeSseFrame(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function eventOn<T = unknown>(bus: { on: (e: string, h: (v: T) => void) => void; off: (e: string, h: (v: T) => void) => void }, name: string, timeoutMs = 1500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      bus.off(name, h);
      reject(new Error(`timeout waiting for ${name}`));
    }, timeoutMs);
    const h = (v: T) => {
      clearTimeout(t);
      bus.off(name, h);
      resolve(v);
    };
    bus.on(name, h);
  });
}

let stub: SseStub;
let client: SandboxClient;

beforeEach(async () => {
  stub = await startSseStub();
  process.env.HOOOP_SANDBOX_TOKEN_FILE = stub.tokenFile;
  client = createHttpClient(stub.socketPath);
});

afterEach(async () => {
  client.shutdown();
  // Give the loop a tick to settle.
  await new Promise((r) => setTimeout(r, 30));
  await stub.close();
  delete process.env.HOOOP_SANDBOX_TOKEN_FILE;
});

describe("sandbox-client SSE lifecycle", () => {
  it("recovers from a 401 by re-reading the token file and reconnecting", async () => {
    const STALE = "test-token-".padEnd(64, "x"); // matches stub's initial file
    const FRESH = "fresh-token-".padEnd(64, "y");

    stub.setHandler(({ token }, res) => {
      if (token === STALE) {
        // First connect with the cached stale token: 401.
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "stale" }));
        // After the failing attempt, swap the token on disk so the retry
        // (which calls invalidateToken + readToken) picks up FRESH.
        setTimeout(() => stub.writeTokenFile(FRESH), 5);
        return;
      }
      if (token === FRESH) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        writeSseFrame(res, "event", { id: 1, hello: "world" });
        return;
      }
      res.writeHead(403); res.end();
    });

    client.boot();
    const received = await eventOn<{ id: number }>(client.eventBus, "event", 3000);
    expect(received).toMatchObject({ id: 1, hello: "world" });
    // At least 2 GET /events/stream attempts: the 401 and the successful retry.
    expect(stub.requestCount()).toBeGreaterThanOrEqual(2);
  });

  it("reconnects after the server drops the stream mid-flight", async () => {
    let attempt = 0;
    stub.setHandler((_req, res) => {
      attempt += 1;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
      });
      if (attempt === 1) {
        writeSseFrame(res, "event", { id: 1, phase: "first" });
        // Drop the connection so the client's reconnect-backoff loop fires.
        setTimeout(() => res.end(), 10);
      } else {
        writeSseFrame(res, "event", { id: 2, phase: "second" });
      }
    });

    client.boot();
    const first = await eventOn<{ phase: string }>(client.eventBus, "event", 2000);
    expect(first).toMatchObject({ id: 1, phase: "first" });

    const second = await eventOn<{ phase: string }>(client.eventBus, "event", 3000);
    expect(second).toMatchObject({ id: 2, phase: "second" });
    expect(stub.requestCount()).toBeGreaterThanOrEqual(2);
  });

  it("shutdown() while connected stops the reconnect loop", async () => {
    stub.setHandler((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
      });
      writeSseFrame(res, "event", { id: 1 });
      // Keep the connection open — only client.shutdown() should close it.
    });

    client.boot();
    await eventOn<{ id: number }>(client.eventBus, "event", 2000);
    const before = stub.requestCount();

    client.shutdown();

    // Wait well past the maximum backoff (5s reconnect cap) — well, more
    // pragmatically wait through one backoff cycle (~300ms) and verify no
    // new request showed up.
    await new Promise((r) => setTimeout(r, 500));
    expect(stub.requestCount()).toBe(before);
  });
});
