import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { log } from "@shared/logger";
import { openSseConnection } from "./sse";

import type {
  ActiveSessionMeta,
  AgentRun,
  SearchType,
  SearchResponse,
  McpsResponse,
  StackResponse,
  IdentityResponse,
  EventsQuery,
  EventRowFull,
  FileEntry,
  FilesQuery,
  FilesResponse,
  FileTreeResponse,
  FilePreviewResponse,
  FileRawResponse,
  HostDeviceRecord,
  PreviewLog,
  PreviewRecord,
  PreviewsResponse,
  SessionInfo,
  SessionSummary,
  ShareRecord,
  Skill,
  SlashCommand,
} from "@/lib/sandbox-types";

export interface SandboxError extends Error {
  status?: number;
}

/** A shared inline comment on a plan review (see the sandbox store). */
export interface PlanReviewComment {
  id: string;
  author: string | null;
  quote: string;
  offset: number;
  length: number;
  body: string;
  replies: { id: string; author: string | null; body: string; at: number }[];
  at: number;
}

/** A base64 image attached to a user turn (vision). `data` is the full image
 * sent to the model; `thumb` is an optional ≤512px JPEG persisted in the event
 * stream and shown in the transcript (kept small for the peer broadcast). */
export interface TurnImage {
  media_type: string;
  data: string;
  thumb?: string;
}

export interface SandboxClient {
  boot(): void;
  /**
   * Stop the SSE reconnect loop and abort the active long-lived connection.
   * Idempotent. Wired from instrumentation-node.ts SIGTERM so the dashboard
   * releases its sandbox connection cleanly when the container stops.
   */
  shutdown(): void;

  startNewConversation(opts: {
    // Optional git URL to clone into the sandbox workspace on start; the session
    // cwd becomes that clone (or the default workspace when omitted). Replaces
    // the old free-text cwd — the dashboard no longer picks a folder directly.
    gitRepo?: string | null;
    label?: string;
    name?: string | null;
    model?: string | null;
    runId?: string | null;
    via?: "new-conversation" | "skill";
    // Per-session idle-dormancy window, set once at creation. null = use the
    // install-wide default; 0 = never go dormant; positive ms = this
    // session's own window. Sandbox re-validates + clamps independently.
    idleTtlMs?: number | null;
    // Arm burn-after-use at creation: instead of going dormant, the session
    // destroys itself (transcript, workspace, events, share links, previews).
    // Can only be cancelled later, never enabled later — see
    // setSessionBurnAfterUse.
    burnAfterUse?: boolean;
  }, participant?: string): Promise<{ sessionId: string; meta: ActiveSessionMeta }>;
  listSessions(): Promise<SessionInfo[]>;
  writeUserTurn(sessionId: string, text: string, participant?: string, images?: TurnImage[]): Promise<{ sessionId: string }>;
  /** Participant-to-participant chat — persisted + broadcast, never sent to the
   * model. `images` are ≤512 thumbnails (base64). */
  sendChat(sessionId: string, text: string, images?: TurnImage[], participant?: string): Promise<{ ok: boolean }>;
  /** Interrupt the model's in-flight turn (`/stop`). */
  interruptSession(sessionId: string, participant?: string): Promise<{ ok: boolean }>;
  /** Switch the session's model (`/model <alias>`); restarts the child on the
   * new model, aborting any in-flight turn. */
  setSessionModel(sessionId: string, model: string, participant?: string): Promise<{ ok: boolean; sessionId: string; model: string | null }>;
  /** Toggle unattended auto-approval (auto mode). Effective on the next tool ask
   * (no child restart). Host / full-peer only — the sandbox enforces it. */
  setSessionAutoMode(sessionId: string, auto: boolean, participant?: string): Promise<{ ok: boolean; sessionId: string; autoMode: boolean }>;
  /** Cancel a session's burn-after-use flag. It can only ever be armed at
   * creation, never enabled later — this endpoint only ever turns it off.
   * Host / full-peer only; the sandbox enforces it. */
  setSessionBurnAfterUse(sessionId: string, burn: boolean, participant?: string): Promise<{ ok: boolean; sessionId: string; burnAfterUse: boolean }>;
  /**
   * Direct bash execution in the session's cwd. Bypasses the model and
   * synthesizes a `BashShortcut` event so the transcript still shows it.
   */
  // The bash shortcut now streams: the sandbox emits a "running" BashShortcut
  // snapshot and returns immediately, then streams throttled snapshots + a
  // final "done" snapshot over SSE (all keyed by runId). The response no longer
  // carries the result — the transcript assembles it from the events.
  runBashShortcut(sessionId: string, command: string, participant?: string): Promise<{
    ok: boolean;
    runId: string;
    eventId: number | null;
  }>;
  /**
   * Open permission asks the model emitted via `control_request` and is
   * still waiting on. The dashboard hydrates its card stack from this on
   * page reload (SSE only delivers live).
   */
  listPendingRequests(sessionId: string): Promise<{
    requests: Array<{
      requestId: string;
      toolUseId: string | null;
      toolName: string;
      input: unknown;
      decisionReason: string | null;
      receivedAt: number;
      /** "host" or a peer's name — who drove the turn this ask came from. */
      author?: string | null;
    }>;
  }>;
  /** Answer a pending permission ask. `scope:"always"` additionally grants the
   * driving peer session-scoped auto-approve ("allow all from $peer"). `feedback`
   * is relayed to the model as the decision reason — used by a plan rejection so
   * the agent revises against the host's notes. */
  respondToPermission(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    participant?: string,
    scope?: "once" | "always",
    feedback?: string,
  ): Promise<{ ok: boolean }>;
  /** Shared plan-review comments (host + peers). */
  listPlanComments(sessionId: string, requestId: string, participant?: string): Promise<{ comments: PlanReviewComment[]; you: string | null }>;
  addPlanComment(sessionId: string, input: { requestId: string; quote: string; offset: number; length: number; body: string }, participant?: string): Promise<{ comment: PlanReviewComment }>;
  addPlanReply(sessionId: string, input: { requestId: string; commentId: string; body: string }, participant?: string): Promise<{ ok: boolean }>;
  editPlanComment(sessionId: string, input: { requestId: string; commentId: string; body: string }, participant?: string): Promise<{ ok: boolean }>;
  removePlanComment(sessionId: string, input: { requestId: string; commentId: string }, participant?: string): Promise<{ ok: boolean }>;
  // ── Live previews ────────────────────────────────────────────────────────
  /** Previews for one session (with the global slot count). Any participant
   * in scope may read, including spectate — a preview is session content. */
  listPreviews(sessionId: string, participant?: string): Promise<PreviewsResponse>;
  /** Every preview across every session (host-only). The operator's inventory of
   *  the install-wide slots. */
  listAllPreviews(): Promise<PreviewsResponse>;
  /** Start a preview from the dashboard. The sandbox validates the spec and
   *  enforces the capability check (host or full peer). */
  startPreview(
    sessionId: string,
    spec: Record<string, unknown>,
    participant?: string,
  ): Promise<{ ok: boolean; preview: PreviewRecord }>;
  /** Per-step output. `step` omitted returns every step; -1 is the run command. */
  previewLogs(sessionId: string, previewId: string, step?: number, participant?: string): Promise<{ logs: PreviewLog[] }>;
  /** Stop / restart / rebuild. Needs "permission" capability; the sandbox
   * re-validates. Rebuild re-runs every setup step, restart only respawns. */
  previewAction(
    sessionId: string,
    previewId: string,
    action: "stop" | "restart" | "rebuild",
    participant?: string,
  ): Promise<{ ok: boolean; preview?: PreviewRecord }>;
  /** Record the tunnel URL a preview is now reachable at, or null to un-share.
   * The DASHBOARD produces the URL (it owns cloudflared) and tells the sandbox,
   * so no sandbox→dashboard call is ever needed. */
  setPreviewShared(sessionId: string, previewId: string, url: string | null, participant?: string): Promise<{ ok: boolean; preview: PreviewRecord }>;

  endSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<{ deleted: boolean }>;
  renameSession(sessionId: string, name: string): Promise<ActiveSessionMeta | null>;
  getSessionModel(sessionId: string): Promise<{ model: string | null }>;
  getSessionSummary(sessionId: string): Promise<{ summary: SessionSummary | null }>;

  listEvents(query: EventsQuery): Promise<import("@/lib/sandbox-types").EventRow[]>;
  getEvent(id: number, opts?: { session?: string }): Promise<EventRowFull | null>;

  listFiles(query: FilesQuery): Promise<FileEntry[]>;
  /** Git-decorated recursive file tree for the Files navigator, scoped to
   * cwd. `path` (cwd-relative) fetches the on-demand subtree for a `lazy`
   * node instead of the whole-cwd tree — see git.ts's `buildFileSubtree`.
   * `max` caps that subtree's node count (the sandbox clamps it to its own
   * per-response cap), so a caller expanding many lazy directories can
   * bound their SUM rather than each one individually. */
  getFileTree(cwd: string, path?: string, max?: number): Promise<FileTreeResponse>;
  /** Single-file preview: git status + diff + capped content, `path` rel to cwd. */
  getFilePreview(cwd: string, path: string): Promise<FilePreviewResponse>;
  /** Whole-image bytes for the preview dock, base64'd for this hop. Separate
   * from getFilePreview on purpose: that response is refetched on every write
   * under the cwd, so image bytes must not ride in it. */
  getFileRaw(cwd: string, path: string): Promise<FileRawResponse>;

  isValidSkillName(name: string): boolean;
  /** Launch a skill as a REGULAR session; returns the new session's id. The
   * dashboard snaps to it (the old detached-run { runId } contract is gone). */
  startSkillRun(skill: string, args?: string, participant?: string): Promise<{ sessionId: string }>;

  listSkills(opts?: { cwd?: string }): Promise<Skill[]>;
  listSlashCommands(opts?: { cwd?: string }): Promise<SlashCommand[]>;
  listMcps(): Promise<McpsResponse>;
  getStack(): Promise<StackResponse>;
  getIdentity(): Promise<IdentityResponse>;

  listAgentRuns(limit?: number): Promise<AgentRun[]>;
  getAgentDetail(id: number): Promise<AgentRun | null>;

  search(q: string, type: SearchType, limit: number, session?: string): Promise<SearchResponse>;

  // ── Session sharing (peer co-drive) ──────────────────────────────────────
  /** Register a share grant. The sandbox stores metadata only; the dashboard
   * signs the peer token. Returns the grant record. */
  createShare(opts: {
    sessionId: string;
    publicHost: string;
    capability?: "full" | "drive" | "spectate";
    expiresInMs?: number | null;
    peerName?: string | null;
  }, participant?: string): Promise<ShareRecord>;
  /** Revoke a share. Host (any session) or a full-capability peer (only their
   * own session); the sandbox re-validates capability + scope. */
  revokeShare(shareId: string, participant?: string): Promise<{ ok: boolean }>;
  /** List active shares. Host sees all; a full peer sees only their session's. */
  listShares(participant?: string): Promise<{ shares: ShareRecord[] }>;
  /** Authoritative revocation/scope check (used to gate peer-context calls). */
  validateShare(shareId: string, opts: { host?: string; sessionId?: string }): Promise<ShareRecord | null>;

  // Web notifications. The sandbox owns the VAPID keypair and the subscription
  // registry (the dashboard holds no secrets), so these are pure pass-throughs;
  // it re-validates the peer's share on every one.
  /** Public VAPID key a browser needs to mint a subscription. Not a secret. */
  pushKey(participant?: string): Promise<{ publicKey: string }>;
  /** Register this browser's subscription. Scope comes from the share, so a
   * peer can only ever subscribe to the session they're in. */
  pushSubscribe(
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    participant?: string,
  ): Promise<{ ok: boolean; id?: string }>;
  pushUnsubscribe(endpoint: string, participant?: string): Promise<{ ok: boolean }>;
  /** Relay a presence beat so the sender can skip notifying a participant about
   * the session already on their screen. Fed from the presence heartbeat.
   * `viewerId` names the SCREEN, so one person watching from two devices doesn't
   * have the quiet one cancel the one they're actually looking at. */
  pushPresence(sessionId: string, active: boolean, participant?: string, viewerId?: string | null): Promise<{ ok: boolean }>;
  /** This viewer's mutes: a global flag plus the sessions they've silenced. */
  pushMutes(participant?: string): Promise<{ global: boolean; sessions: string[] }>;
  /** Mute/unmute one session, or everything when sessionId is null. */
  setPushMute(sessionId: string | null, muted: boolean, participant?: string): Promise<{ ok: boolean }>;

  // Host-admits-each-join gate.
  /** Register a pending join for a redeemed share. `name` is the peer's chosen
   * nickname (overrides any host-suggested default); `peerIp`/`peerCountry` are
   * the joiner's best-effort public IP + 2-letter country, shown to the decider
   * in the admit prompt (info only). */
  createJoinTicket(shareId: string, name?: string | null, peerIp?: string | null, peerCountry?: string | null): Promise<{ ticketId: string; secret: string }>;
  /** Poll a ticket's admission status. */
  joinStatus(ticketId: string): Promise<{ status: "pending" | "admitted" | "denied" | "expired" }>;
  /** Admit a pending join. Host or a full-capability peer (scoped to their own
   * session); the sandbox re-validates the caller's capability + scope. */
  admitJoin(ticketId: string, participant?: string): Promise<{ ok: boolean }>;
  /** Deny a pending join (revokes the share sandbox-side). Same gate as admit. */
  denyJoin(ticketId: string, participant?: string): Promise<{ ok: boolean }>;
  /** Claim an admitted ticket (one-time); returns the grant to issue a cookie. */
  claimJoin(ticketId: string, secret: string): Promise<{ shareId: string; sessionId: string; peerName: string | null } | null>;
  /** List pending joins for the Admit/Deny UI. Host sees all; a full peer sees
   * only their own session's. Each carries the share capability. */
  listPendingJoins(participant?: string): Promise<{ joins: Array<{ ticketId: string; shareId: string; sessionId: string; peerName: string | null; peerIp?: string | null; peerCountry?: string | null; createdAt: number; capability?: "full" | "drive" | "spectate" | null }> }>;
  /** Record that a peer left a session (emits a `PeerLeft` transcript divider).
   * `name` is a cosmetic label for the marker. */
  peerLeave(sessionId: string, name?: string | null, shareId?: string | null): Promise<{ ok: boolean }>;

  // Host devices — the host's own second screen over the tunnel. Mirror image of
  // the share flow: enrolled BY the host from the machine, so a single-use code
  // replaces the admit gate, and what it yields is the host rather than a guest.
  /** Mint a single-use enrollment code bound to the current tunnel host.
   * Host-only (the sandbox re-checks). The code is a bearer secret: it goes
   * straight into the QR the host is looking at and is never logged. */
  createHostEnrollCode(
    publicHost: string,
    label?: string | null,
    ttlMs?: number | null,
    participant?: string,
    /** Wake hint only: the session the host minted this from, so a dormant one is
     *  running by the time the device arrives. Grants nothing. */
    sessionId?: string | null,
  ): Promise<{ code: string; expiresAt: number; deviceTtlMs: number }>;
  /** Redeem a code into a device grant. Null when the code is unknown, expired,
   * already used, or minted for a different host — the caller must not tell
   * those apart out loud. */
  redeemHostEnrollCode(
    code: string,
    publicHost: string,
    label?: string | null,
  ): Promise<{ deviceId: string; label: string; publicHost: string; expiresAt: number | null } | null>;
  /** Enrolled devices, for the host's revoke list. Host-only. */
  listHostDevices(participant?: string): Promise<{ devices: HostDeviceRecord[] }>;
  /** Revoke one device. Takes effect on that device's very next request. */
  revokeHostDevice(deviceId: string, participant?: string): Promise<{ ok: boolean }>;

  eventBus: EventEmitter;
  sessionsBus: EventEmitter;
  activeSessionsBus: EventEmitter;
  skillsBus: EventEmitter;
  filesBus: EventEmitter;
}

// Concern C: four related mutable closure variables are grouped into one
// state object so their relationship is explicit. Exported so sse.ts can
// reference the type without a circular dependency.
export interface SseLoopState {
  timer: NodeJS.Timeout | null;
  resolve: (() => void) | null;
  stopped: boolean;
  started: boolean;
  activeSseReq: ReturnType<typeof httpRequest> | null;
}

const SANDBOX_TOKEN_HEADER = "x-sandbox-token";
const REQUEST_ID_HEADER = "x-request-id";
const DEFAULT_TIMEOUT_MS = 30_000;

// Pure regex; same shape the sandbox enforces server-side. Keeps the input
// validation in the route layer cheap (no round-trip for an obvious reject).
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/;

function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

function sandboxError(message: string, status?: number): SandboxError {
  const e: SandboxError = new Error(message);
  if (status != null) e.status = status;
  return e;
}

/** Forward the resolved participant to the sandbox so it can re-validate the
 * share (revocation/scope) + capability and attribute the action. */
function participantOpts(participant?: string): { headers?: Record<string, string> } {
  return participant ? { headers: { "x-hooop-participant": participant } } : {};
}

interface RawResponse {
  status: number;
  body: string;
  requestId: string;
}

function rawHttpRequest(
  socketPath: string,
  method: string,
  path: string,
  body: string | null,
  token: string,
  opts: { timeoutMs?: number; requestId: string; headers?: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      ...(opts.headers ?? {}),
      [SANDBOX_TOKEN_HEADER]: token,
      [REQUEST_ID_HEADER]: opts.requestId,
    };
    if (body != null) {
      headers["content-type"] = "application/json; charset=utf-8";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const req = httpRequest(
      { socketPath, method, path, headers, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            requestId: opts.requestId,
          });
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy(sandboxError(`sandbox request timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms (rid=${opts.requestId})`, 504));
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

export function createHttpClient(socketPath: string): SandboxClient {
  const tokenFile = process.env.HOOOP_SANDBOX_TOKEN_FILE
    || "/var/run/hooop/sandbox.token";

  let cachedToken: string | null = null;

  function readToken(): string | null {
    if (cachedToken) return cachedToken;
    try {
      const t = readFileSync(tokenFile, "utf-8").trim();
      cachedToken = t || null;
      return cachedToken;
    } catch {
      return null;
    }
  }
  function invalidateToken() { cachedToken = null; }

  async function request<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
    const token = readToken();
    if (!token) throw sandboxError("sandbox token unavailable", 503);
    const payload = body == null ? null : JSON.stringify(body);
    const requestId = randomUUID();

    let res = await rawHttpRequest(socketPath, method, path, payload, token, { ...opts, requestId });
    if (res.status === 401) {
      invalidateToken();
      const fresh = readToken();
      if (fresh && fresh !== token) {
        res = await rawHttpRequest(socketPath, method, path, payload, fresh, { ...opts, requestId });
      }
    }
    if (res.status >= 400) {
      let msg: string = `sandbox ${res.status}`;
      try { const parsed = JSON.parse(res.body); if (parsed?.error) msg = parsed.error; } catch { /* ignore */ }
      throw sandboxError(`${msg} (rid=${requestId})`, res.status);
    }
    if (!res.body) return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw sandboxError(`invalid JSON from sandbox (rid=${requestId})`, 502);
    }
  }

  function encode(path: string, query?: Record<string, string | number | undefined>): string {
    if (!query) return path;
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v != null) sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `${path}?${qs}` : path;
  }

  // Locally-owned EventEmitters populated by a long-lived SSE subscription to
  // the sandbox's combined /events/stream feed. Routes subscribe to these
  // exactly as if the data lived in-process — they don't know there's a
  // network hop underneath.
  const localEventBus = new EventEmitter();
  const localSessionsBus = new EventEmitter();
  const localActiveSessionsBus = new EventEmitter();
  const localSkillsBus = new EventEmitter();
  const localFilesBus = new EventEmitter();
  for (const bus of [localEventBus, localSessionsBus, localActiveSessionsBus, localSkillsBus, localFilesBus]) {
    bus.setMaxListeners(100);
  }

  // Concern C: four related mutable closure variables are grouped into one
  // state object so their relationship is explicit. Behavior is unchanged.
  const state: SseLoopState = {
    timer: null,
    resolve: null,
    stopped: false,
    started: false,
    activeSseReq: null,
  };

  function ensureSse() {
    if (state.started) return;
    state.started = true;
    void runSseLoop();
  }

  function shutdown() {
    state.stopped = true;
    // Destroy any in-flight SSE request, whether it's still connecting or
    // already streaming. state.activeSseReq is assigned synchronously after
    // the httpRequest() call so this covers the connect/handshake window too.
    try { state.activeSseReq?.destroy(); } catch { /* ignore */ }
    // Cancel the reconnect-backoff sleep so the while-loop can break now.
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
      if (state.resolve) {
        const r = state.resolve;
        state.resolve = null;
        r();
      }
    }
  }

  async function runSseLoop() {
    let backoff = 250;
    while (!state.stopped) {
      try {
        await openSseConnection({
          socketPath,
          readToken,
          invalidateToken,
          sandboxError,
          state,
          buses: {
            eventBus: localEventBus,
            sessionsBus: localSessionsBus,
            activeSessionsBus: localActiveSessionsBus,
            skillsBus: localSkillsBus,
            filesBus: localFilesBus,
          },
        });
        backoff = 250;
      } catch (err: any) {
        if (state.stopped) break;
        if (err?.code !== "ECONNREFUSED" && err?.code !== "ENOENT") {
          log.error("sandbox-client", "sse loop error", { err });
        }
      }
      if (state.stopped) break;
      await new Promise<void>((resolve) => {
        state.resolve = resolve;
        state.timer = setTimeout(() => {
          state.timer = null;
          state.resolve = null;
          resolve();
        }, backoff);
      });
      backoff = Math.min(backoff * 2, 5000);
    }
  }

  return {
    boot() { ensureSse(); },
    shutdown,

    startNewConversation: (opts, participant) => request("POST", "/sessions", opts, participantOpts(participant)),
    listSessions: () => request("GET", "/sessions"),
    writeUserTurn: async (sessionId, text, participant, images) => {
      const res = await request<{ ok: boolean; sessionId: string }>(
        "POST",
        `/sessions/${encodeURIComponent(sessionId)}/message`,
        images && images.length ? { text, images } : { text },
        participantOpts(participant),
      );
      return { sessionId: res.sessionId };
    },
    interruptSession: (sessionId, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/interrupt`, {}, participantOpts(participant)),
    setSessionModel: (sessionId, model, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/model`, { model }, participantOpts(participant)),
    setSessionAutoMode: (sessionId, auto, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/auto-mode`, { auto }, participantOpts(participant)),
    setSessionBurnAfterUse: (sessionId, burn, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/burn-after-use`, { burn }, participantOpts(participant)),
    sendChat: (sessionId, text, images, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/chat`, images && images.length ? { text, images } : { text }, participantOpts(participant)),
    runBashShortcut: (sessionId, command, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/bash`, { command }, participantOpts(participant)),
    listPendingRequests: (sessionId) =>
      request("GET", `/sessions/${encodeURIComponent(sessionId)}/pending-requests`),
    respondToPermission: (sessionId, requestId, decision, participant, scope, feedback) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/permission`, { requestId, decision, ...(scope ? { scope } : {}), ...(feedback ? { feedback } : {}) }, participantOpts(participant)),
    listPlanComments: (sessionId, requestId, participant) =>
      request("GET", `/sessions/${encodeURIComponent(sessionId)}/plan-comments?requestId=${encodeURIComponent(requestId)}`, undefined, participantOpts(participant)),
    addPlanComment: (sessionId, input, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/plan-comments`, input, participantOpts(participant)),
    addPlanReply: (sessionId, input, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/plan-comments/reply`, input, participantOpts(participant)),
    editPlanComment: (sessionId, input, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/plan-comments/edit`, input, participantOpts(participant)),
    removePlanComment: (sessionId, input, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/plan-comments/remove`, input, participantOpts(participant)),
    listPreviews: (sessionId, participant) =>
      request("GET", `/sessions/${encodeURIComponent(sessionId)}/previews`, undefined, participantOpts(participant)),
    listAllPreviews: () => request("GET", "/previews", undefined, participantOpts("host")),
    startPreview: (sessionId, spec, participant) =>
      request("POST", `/sessions/${encodeURIComponent(sessionId)}/previews`, spec, participantOpts(participant)),
    previewLogs: (sessionId, previewId, step, participant) =>
      request(
        "GET",
        encode(`/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(previewId)}/logs`, { step }),
        undefined,
        participantOpts(participant),
      ),
    previewAction: (sessionId, previewId, action, participant) =>
      request(
        "POST",
        `/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(previewId)}/${action}`,
        {},
        participantOpts(participant),
      ),
    setPreviewShared: (sessionId, previewId, url, participant) =>
      request(
        "POST",
        `/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(previewId)}/share`,
        { url },
        participantOpts(participant),
      ),

    endSession: async (sessionId) => {
      await request("POST", `/sessions/${encodeURIComponent(sessionId)}/end`);
    },
    deleteSession: async (sessionId) => {
      const res = await request<{ ok: boolean; deleted: boolean }>(
        "DELETE",
        `/sessions/${encodeURIComponent(sessionId)}`
      );
      return { deleted: res.deleted };
    },
    renameSession: async (sessionId, name) => {
      const res = await request<{ ok: boolean; meta: ActiveSessionMeta }>(
        "PATCH",
        `/sessions/${encodeURIComponent(sessionId)}`,
        { name }
      );
      return res.meta;
    },
    getSessionModel: (sessionId) =>
      request("GET", `/sessions/${encodeURIComponent(sessionId)}/model`),
    getSessionSummary: (sessionId) =>
      request("GET", `/sessions/${encodeURIComponent(sessionId)}/summary`),

    listEvents: (q) => request("GET", encode("/events", {
      limit: q.limit, before: q.before, hook: q.hook, tool: q.tool, session: q.session,
    })),
    getEvent: async (id, opts) => {
      const path = opts?.session
        ? `/events/${id}?session=${encodeURIComponent(opts.session)}`
        : `/events/${id}`;
      try {
        return await request<EventRowFull>("GET", path);
      } catch (e: any) {
        if (e?.status === 404) return null;
        throw e;
      }
    },

    listFiles: async (q) => {
      const res = await request<FilesResponse>(
        "GET",
        encode("/files", { cwd: q.cwd, q: q.q, limit: q.limit }),
      );
      return res.entries;
    },
    getFileTree: (cwd, path, max) => request<FileTreeResponse>("GET", encode("/files/tree", { cwd, path, max })),
    getFilePreview: (cwd, path) => request<FilePreviewResponse>("GET", encode("/files/preview", { cwd, path })),
    getFileRaw: (cwd, path) => request<FileRawResponse>("GET", encode("/files/raw", { cwd, path })),

    isValidSkillName,
    startSkillRun: async (skill, args, participant) => {
      const res = await request<{ sessionId: string }>(
        "POST",
        `/skill/${encodeURIComponent(skill)}/run`,
        { args },
        participantOpts(participant),
      );
      return { sessionId: res.sessionId };
    },

    listSkills: (opts?: { cwd?: string }) =>
      request("GET", opts?.cwd ? `/skills?cwd=${encodeURIComponent(opts.cwd)}` : "/skills"),
    listSlashCommands: (opts?: { cwd?: string }) =>
      request("GET", opts?.cwd ? `/commands?cwd=${encodeURIComponent(opts.cwd)}` : "/commands"),
    listMcps: () => request("GET", "/mcps"),
    getStack: () => request("GET", "/stack"),
    getIdentity: () => request("GET", "/identity"),

    listAgentRuns: (limit) =>
      request("GET", encode("/agents", { limit })),
    getAgentDetail: async (id) => {
      try {
        return await request<AgentRun>("GET", `/agents/${id}`);
      } catch (e: any) {
        if (e?.status === 404) return null;
        throw e;
      }
    },

    search: (q, type, limit, session) =>
      request("POST", "/search", { q, type, limit, ...(session ? { session } : {}) }),

    createShare: (opts, participant) => request("POST", "/shares", opts, participantOpts(participant)),
    revokeShare: (shareId, participant) =>
      request("POST", `/shares/${encodeURIComponent(shareId)}/revoke`, {}, participantOpts(participant)),
    listShares: (participant) => request("GET", "/shares", undefined, participantOpts(participant)),

    pushKey: (participant) => request("GET", "/push/key", undefined, participantOpts(participant)),
    pushSubscribe: (sub, participant) =>
      request("POST", "/push/subscribe", sub, participantOpts(participant)),
    pushUnsubscribe: (endpoint, participant) =>
      request("POST", "/push/unsubscribe", { endpoint }, participantOpts(participant)),
    pushPresence: (sessionId, active, participant, viewerId) =>
      request("POST", "/push/presence", { sessionId, active, viewerId: viewerId ?? null }, participantOpts(participant)),
    pushMutes: (participant) => request("GET", "/push/mute", undefined, participantOpts(participant)),
    setPushMute: (sessionId, muted, participant) =>
      request("POST", "/push/mute", { sessionId, muted }, participantOpts(participant)),
    validateShare: async (shareId, opts) => {
      try {
        const qs = opts.host ? `?host=${encodeURIComponent(opts.host)}` : "";
        return await request<ShareRecord>("GET", `/shares/${encodeURIComponent(shareId)}${qs}`);
      } catch (e: any) {
        if (e?.status === 404) return null;
        throw e;
      }
    },

    createJoinTicket: (shareId, name, peerIp, peerCountry) => request("POST", "/join-request", { shareId, name: name ?? null, peerIp: peerIp ?? null, peerCountry: peerCountry ?? null }),
    joinStatus: (ticketId) => request("GET", `/join-status?ticket=${encodeURIComponent(ticketId)}`),
    admitJoin: (ticketId, participant) => request("POST", "/join-admit", { ticketId }, participantOpts(participant)),
    denyJoin: (ticketId, participant) => request("POST", "/join-deny", { ticketId }, participantOpts(participant)),
    claimJoin: async (ticketId, secret) => {
      try {
        return await request("POST", "/join-claim", { ticketId, secret });
      } catch (e: any) {
        if (e?.status === 403) return null;
        throw e;
      }
    },
    listPendingJoins: (participant) => request("GET", "/pending-joins", undefined, participantOpts(participant)),
    peerLeave: (sessionId, name, shareId) => request("POST", "/peer-leave", { sessionId, name: name ?? null, shareId: shareId ?? null }),

    createHostEnrollCode: (publicHost, label, ttlMs, participant, sessionId) =>
      request(
        "POST",
        "/host-devices/enroll-code",
        { publicHost, label: label ?? null, ttlMs: ttlMs ?? null, sessionId: sessionId ?? null },
        participantOpts(participant),
      ),
    redeemHostEnrollCode: async (code, publicHost, label) => {
      try {
        return await request("POST", "/host-devices/redeem", { code, publicHost, label: label ?? null });
      } catch (e: any) {
        // 403 covers every "no" the sandbox gives here (bad code, expired,
        // already used, wrong host, device cap reached). Collapsing them into
        // null keeps the route above from accidentally growing a message that
        // tells a guesser which of those it was.
        if (e?.status === 403) return null;
        throw e;
      }
    },
    listHostDevices: (participant) => request("GET", "/host-devices", undefined, participantOpts(participant)),
    revokeHostDevice: (deviceId, participant) =>
      request("POST", `/host-devices/${encodeURIComponent(deviceId)}/revoke`, undefined, participantOpts(participant)),

    eventBus: localEventBus,
    sessionsBus: localSessionsBus,
    activeSessionsBus: localActiveSessionsBus,
    skillsBus: localSkillsBus,
    filesBus: localFilesBus,
  };
}
