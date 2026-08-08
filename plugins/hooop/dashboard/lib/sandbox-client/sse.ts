import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { log } from "@shared/logger";
import type { SseLoopState } from "./http";

const SANDBOX_TOKEN_HEADER = "x-sandbox-token";

function dispatchSseEvent(
  type: string | null,
  data: unknown,
  eventBus: EventEmitter,
  sessionsBus: EventEmitter,
  activeSessionsBus: EventEmitter,
  skillsBus: EventEmitter,
  filesBus: EventEmitter,
) {
  switch (type) {
    case "event":
      eventBus.emit("event", data);
      return;
    case "sessions":
      sessionsBus.emit("change");
      return;
    case "skills":
      skillsBus.emit("change");
      return;
    case "files":
      filesBus.emit("change", data);
      return;
    case "session-status":
      activeSessionsBus.emit("change", data);
      return;
    case "session-error":
      activeSessionsBus.emit("error", data);
      return;
  }
}

export interface SseBuses {
  eventBus: EventEmitter;
  sessionsBus: EventEmitter;
  activeSessionsBus: EventEmitter;
  skillsBus: EventEmitter;
  filesBus: EventEmitter;
}

export interface SseConnectionDeps {
  socketPath: string;
  readToken(): string | null;
  invalidateToken(): void;
  sandboxError(message: string, status?: number): Error & { status?: number };
  state: SseLoopState;
  buses: SseBuses;
}

export function openSseConnection(deps: SseConnectionDeps): Promise<void> {
  const { socketPath, readToken, invalidateToken, sandboxError, state, buses } = deps;

  return new Promise((resolve, reject) => {
    const token = readToken();
    if (!token) { reject(sandboxError("no token", 503)); return; }

    const req = httpRequest(
      {
        socketPath,
        method: "GET",
        path: "/events/stream",
        headers: { [SANDBOX_TOKEN_HEADER]: token, accept: "text/event-stream" },
      },
      (res) => {
        if (res.statusCode === 401) {
          invalidateToken();
          res.resume();
          reject(sandboxError("unauthorized", 401));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(sandboxError(`stream returned ${res.statusCode}`, res.statusCode));
          return;
        }
        res.setEncoding("utf-8");

        // SSE per spec: each event ends at a blank line. Multiple data:
        // lines within an event are concatenated with "\n" before
        // dispatching. event:/data: only take effect on the blank-line
        // boundary; we accumulate fields and flush there.
        let buffer = "";
        let currentEvent: string | null = null;
        const dataLines: string[] = [];

        const flushEvent = () => {
          if (dataLines.length === 0) {
            currentEvent = null;
            return;
          }
          const data = dataLines.join("\n");
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            // Concern B: non-JSON frames are dropped with a warning;
            // subscribers always receive objects, never raw strings.
            const dataPreview = data.slice(0, 120);
            log.warn("sandbox-client", "dropped non-JSON SSE frame", { dataPreview });
            currentEvent = null;
            dataLines.length = 0;
            return;
          }
          dispatchSseEvent(
            currentEvent,
            parsed,
            buses.eventBus,
            buses.sessionsBus,
            buses.activeSessionsBus,
            buses.skillsBus,
            buses.filesBus,
          );
          currentEvent = null;
          dataLines.length = 0;
        };

        res.on("data", (chunk: string) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const rawLine = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const line = rawLine.replace(/\r$/, "");

            if (line === "") {
              flushEvent();
              continue;
            }
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).replace(/^ /, ""));
              continue;
            }
          }
        });
        let settled = false;
        const settle = () => { if (!settled) { settled = true; resolve(); } };
        res.on("end", settle);
        res.on("close", settle);
        res.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
      }
    );
    req.on("error", reject);
    // Track the request synchronously so shutdown() can destroy it during
    // the connect/handshake window — BEFORE the response callback fires.
    state.activeSseReq = req;
    req.end();
  });
}
