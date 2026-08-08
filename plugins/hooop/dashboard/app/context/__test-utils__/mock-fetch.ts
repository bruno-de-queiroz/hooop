import { vi } from "vitest";

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

export interface FetchScript {
  /** Last URL fetched (any method). */
  lastUrl(): string | null;
  /** All calls in order. */
  calls: FetchCall[];
  /** Override the response for a URL prefix on the NEXT match only. */
  once(matcher: (url: string, method: string) => boolean, response: MockResponse): void;
}

export interface MockResponse {
  status?: number;
  json?: unknown;
  /** Optional delay before resolving — used to assert pre-resolve state. */
  delayMs?: number;
}

type Handler = (url: string, method: string, body: unknown) => MockResponse | null;

export interface MockFetchSetup {
  routes: Handler[];
  fallback?: MockResponse;
}

export function buildMockFetch(setup: MockFetchSetup): FetchScript & { fn: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const onceQueue: Array<{ match: (url: string, method: string) => boolean; res: MockResponse }> = [];

  const fn = vi.fn(async (urlOrReq: string | Request, init?: RequestInit) => {
    const url = typeof urlOrReq === "string" ? urlOrReq : urlOrReq.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });

    // once-overrides take precedence.
    const onceIdx = onceQueue.findIndex((q) => q.match(url, method));
    if (onceIdx !== -1) {
      const [{ res }] = onceQueue.splice(onceIdx, 1);
      return await makeResponse(res);
    }

    for (const h of setup.routes) {
      const res = h(url, method, body);
      if (res) return await makeResponse(res);
    }

    return await makeResponse(setup.fallback ?? { status: 200, json: {} });
  });

  return {
    calls,
    lastUrl: () => calls.at(-1)?.url ?? null,
    once: (match, res) => {
      onceQueue.push({ match, res });
    },
    fn,
  };
}

async function makeResponse(res: MockResponse): Promise<Response> {
  if (res.delayMs) await new Promise((r) => setTimeout(r, res.delayMs));
  const status = res.status ?? 200;
  return new Response(JSON.stringify(res.json ?? null), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function installMockFetch(setup: MockFetchSetup): FetchScript {
  const built = buildMockFetch(setup);
  vi.stubGlobal("fetch", built.fn);
  return built;
}
