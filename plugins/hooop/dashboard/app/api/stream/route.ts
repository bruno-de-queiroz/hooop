import { client } from "@/lib/sandbox-client";
import { presenceBus, listPresence } from "@/lib/presence";
import { isHost } from "@/lib/peer-auth";
import { errorResponse } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events live stream. Pure proxy of the sandbox's event channel:
 * subscribes to the long-lived buses populated by sandbox-client's SSE
 * connection to /events/stream and forwards them to the browser.
 *
 * Host-only. This is an unfiltered firehose of every session's events; the
 * only legitimate consumer is the front process's WebSocket bridge (server.mjs),
 * which connects as the host over loopback and re-broadcasts per-peer-scoped
 * frames on /api/ws. A peer must never read this directly — that would leak
 * other sessions' activity — so refuse anyone who isn't the host.
 */
export async function GET(request: Request) {
  if (!isHost(request)) {
    return errorResponse("forbidden: live event stream is host-only", 403);
  }
  // instrumentation-node.ts is supposed to call client.boot() at server
  // startup, but Next 14 standalone bundles instrumentation in a separate
  // module graph from route handlers — the client singleton it boots there
  // isn't the one route handlers see. Booting from /api/stream is
  // belt-and-braces: idempotent (state.started guard) so it costs nothing
  // when instrumentation did fire, and load-bearing when it didn't.
  client.boot();
  const encoder = new TextEncoder();
  let eventListener: ((e: unknown) => void) | null = null;
  let sessionListener: (() => void) | null = null;
  let activeStatusListener: ((e: unknown) => void) | null = null;
  let activeErrorListener: ((e: unknown) => void) | null = null;
  let skillsListener: (() => void) | null = null;
  let filesListener: ((p: unknown) => void) | null = null;
  let presenceListener: ((p: unknown) => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => {
        try { controller.enqueue(encoder.encode(data)); } catch { /* closed */ }
      };

      send(`retry: 5000\n\n`);
      send(`: hooop event stream open\n\n`);

      eventListener = (e) => send(`event: event\ndata: ${JSON.stringify(e)}\n\n`);
      client.eventBus.on("event", eventListener);

      sessionListener = () => send(`event: sessions\ndata: ${JSON.stringify({ changed: true })}\n\n`);
      client.sessionsBus.on("change", sessionListener);

      // session-status carries alive/dormant/ended transitions AND alias
      // swaps (`{ sessionId: newId, aliasFrom: oldId, status: "alive" }` when
      // claude --resume mints a new internal id mid-conversation). Without
      // forwarding this, ActiveSessionPanel's alias filter never widens to
      // include the post-resume id, so events under it land in the SSE
      // pipeline but get discarded by the browser's session_id mismatch
      // check — transcript stays empty even though events.db is collecting
      // them fine. No implicit `sessions` ping: the sandbox emits a
      // separate sessionsBus.change immediately after the alias swap, so
      // the sidebar still refreshes — just once, debounced — instead of
      // racing two pings into the same RAF.
      activeStatusListener = (payload) => {
        send(`event: session-status\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      client.activeSessionsBus.on("change", activeStatusListener);

      activeErrorListener = (payload) => send(`event: session-error\ndata: ${JSON.stringify(payload)}\n\n`);
      client.activeSessionsBus.on("error", activeErrorListener);

      // skills-changed: the sandbox's recursive fs.watch on the skill trees
      // fires this (debounced) when a SKILL.md is created/edited/removed. The
      // browser treats it as a refetch edge for /api/skills + /api/commands.
      skillsListener = () => send(`event: skills\ndata: ${JSON.stringify({ changed: true })}\n\n`);
      client.skillsBus.on("change", skillsListener);

      // files-changed: the sandbox's per-cwd fs.watch fires this (debounced)
      // when a session's working directory changes on disk. Carries
      // {sessionId, cwd} (unlike skills' content-free ping) so server.mjs's
      // WS bridge can scope it to the owning peer.
      filesListener = (payload) => send(`event: files\ndata: ${JSON.stringify(payload)}\n\n`);
      client.filesBus.on("change", filesListener);

      // Presence is dashboard-local (who's viewing/typing a shared session).
      // Emit the changed session id; the browser refetches/filters by selection.
      presenceListener = (payload) => {
        const sessionId = (payload as { sessionId?: string })?.sessionId;
        send(`event: presence\ndata: ${JSON.stringify({ sessionId, participants: sessionId ? listPresence(sessionId) : [] })}\n\n`);
      };
      presenceBus().on("change", presenceListener);

      heartbeat = setInterval(() => send(`: heartbeat\n\n`), 20_000);
    },
    cancel() {
      if (eventListener) client.eventBus.off("event", eventListener);
      if (sessionListener) client.sessionsBus.off("change", sessionListener);
      if (activeStatusListener) client.activeSessionsBus.off("change", activeStatusListener);
      if (activeErrorListener) client.activeSessionsBus.off("error", activeErrorListener);
      if (skillsListener) client.skillsBus.off("change", skillsListener);
      if (filesListener) client.filesBus.off("change", filesListener);
      if (presenceListener) presenceBus().off("change", presenceListener);
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
