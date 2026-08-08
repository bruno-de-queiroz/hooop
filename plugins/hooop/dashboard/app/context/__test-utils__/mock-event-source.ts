import { vi } from "vitest";

// The live channel is now a WebSocket (`/api/ws`) carrying `{ type, data }`
// JSON frames (see app/components/useSSE.ts). This helper keeps its original
// exported names so existing tests are untouched, but mocks `WebSocket` and
// `fire(type, data)` delivers a framed message via `onmessage`.

export interface MockEventSourceInstance {
  url: string;
  readyState: number;
  fire(type: string, data: unknown): void;
}

const created: MockEventSourceInstance[] = [];

export class MockEventSource implements MockEventSourceInstance {
  static OPEN = 1;
  static CLOSED = 3;
  url: string;
  readyState = MockEventSource.OPEN;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  close: ReturnType<typeof vi.fn>;

  constructor(url: string) {
    this.url = url;
    this.close = vi.fn(() => {
      this.readyState = MockEventSource.CLOSED;
    });
    created.push(this);
  }

  fire(type: string, data: unknown): void {
    // The server frames every event as `{ type, data }`; the client parses and
    // dispatches `data` to handlers registered for `type`.
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}

export function installMockEventSource() {
  created.length = 0;
  vi.stubGlobal("WebSocket", MockEventSource as unknown as typeof WebSocket);
}

export function latestEventSource(): MockEventSourceInstance | null {
  return created[created.length - 1] ?? null;
}

export function clearEventSources() {
  created.length = 0;
}
