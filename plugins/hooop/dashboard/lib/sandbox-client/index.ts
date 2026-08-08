export type { SandboxClient, SandboxError, PlanReviewComment, TurnImage } from "./http";
export { createHttpClient } from "./http";

import { createHttpClient } from "./http";
import type { SandboxClient } from "./http";

function pickClient(): SandboxClient {
  // Next.js standalone builds bundle instrumentation and route handlers into
  // separate module graphs — a module-level `let _client` cache ends up
  // duplicated, with instrumentation owning one instance and the route
  // handlers owning another. The bus on instrumentation's client receives
  // SSE events; the bus on the route handler's client is what /api/stream
  // subscribes to. They never connect, and the event stream silently dies.
  //
  // Stashing the singleton on globalThis dodges this: there's exactly one
  // process-wide JS realm, so even when the module is loaded twice the
  // cache lookup hits the same slot.
  const g = globalThis as unknown as { __hooop_sandbox_client__?: SandboxClient };
  if (g.__hooop_sandbox_client__) return g.__hooop_sandbox_client__;

  const sock = process.env.HOOOP_SANDBOX_SOCKET;
  if (!sock) {
    throw new Error(
      "HOOOP_SANDBOX_SOCKET is not set; the dashboard cannot run without the sandbox runtime. " +
      "Did the agent-sandbox container fail to start, or is the shared socket volume missing?"
    );
  }
  g.__hooop_sandbox_client__ = createHttpClient(sock);
  return g.__hooop_sandbox_client__;
}

// Lazy: pickClient() runs the first time a route touches `client.foo()`, not
// at module import. That keeps unit tests that vi.mock the module unaffected
// (they replace the whole module before any method access) and lets tests
// that exercise createHttpClient directly avoid setting up the env var.
export const client: SandboxClient = new Proxy({} as SandboxClient, {
  get(_target, prop, receiver) {
    const c = pickClient();
    return Reflect.get(c as object, prop, receiver);
  },
});

export type {
  ActiveSessionMeta,
  SessionInfo,
  Skill,
  SlashCommand,
  AgentRun,
  SearchType,
  SearchResponse,
  McpsResponse,
  StackResponse,
  IdentityResponse,
  EventsQuery,
  EventRow,
  EventRowFull,
  FilesQuery,
  FileEntry,
  FilesResponse,
  SessionSummary,
} from "@/lib/sandbox-types";
