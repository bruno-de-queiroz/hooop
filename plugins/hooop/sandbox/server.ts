/**
 * Sandbox HTTP API.
 *
 * AUTH MODEL: bearer token in `X-Sandbox-Token` (or `X-Hook-Token` for /ingest).
 * NO same-origin / referer / CSRF check — this API is designed to be reached
 * over a Unix Domain Socket only. Do NOT bind it to a TCP port. The whole
 * security model assumes that holding the UDS file descriptor is itself a
 * privileged operation; any TCP exposure breaks it (no Origin header, no
 * SameSite cookie protection, no rate-limit-by-IP). If you really need
 * remote access, put a TLS-terminating reverse proxy between you and a
 * client that connects to the UDS — never expose the UDS as TCP.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, unlinkSync, chmodSync, chownSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { URL } from "node:url";

import {
  sandboxTokenMatches,
  hookTokenMatches,
  sandboxToken,
  hookToken,
  SANDBOX_TOKEN_HEADER,
  HOOK_TOKEN_HEADER,
} from "./auth";

import {
  startNewConversation,
  startSkillSession,
  isValidSkillName,
  writeUserTurn,
  popPendingAuthor,
  TASK_NOTIFICATION_KIND,
  markTurnFinished,
  markSessionActive,
  isControllable,
  endSession,
  renameSession,
  getActiveSession,
  wakeSession,
  getPendingRequests,
  interruptSession,
  setSessionModel,
  setSessionAutoMode,
  setSessionBurnAfterUse,
  destroySession,
  burnRestoredSessions,
  respondToPermission,
  createPermissionRequest,
  listPlanReviewComments,
  addPlanReviewComment,
  addPlanReviewReply,
  editPlanReviewComment,
  removePlanReviewComment,
  awaitPermissionDecision,
  peekPermissionDecision,
  activeSessionsBus,
  bootActiveSessions,
  startIdleSweeper,
  rememberPreviewSpec,
  reconcileOrphanEvents,
  type TurnImage,
  shutdownActiveSessions,
  listActiveSessions,
  expandSessionIds,
} from "./lib/active-sessions";
import {
  listSessions,
  startSessionsWatcher,
  stopSessionsWatcher,
  sessionsBus,
} from "./lib/sessions";
import {
  ingestEventLine,
  startIngestor,
  eventBus,
} from "./lib/ingestor";
import { listSkills, startSkillsWatcher, stopSkillsWatcher, syncProjectSkillWatchers, skillsBus } from "./lib/skills";
import { startFileWatcher, stopFileWatcher, syncFileWatchers, filesBus } from "./lib/file-watch";
import {
  bootShares,
  createShare,
  revokeShare,
  revokeAllShares,
  setSharePeerName,
  markShareJoined,
  listShares,
  getShare,
  validateShareById,
  capabilityAllows,
  type ShareCapability,
} from "./lib/shares";
import {
  bootHostDevices,
  createEnrollCode,
  redeemEnrollCode,
  listHostDevices,
  revokeHostDevice,
  revokeAllHostDevices,
  validateHostDevice,
  HostDeviceCapError,
} from "./lib/host-devices";
import {
  vapidPublicKey,
  addSubscription,
  removeSubscription,
  setParticipantActive,
  setMute,
  listMutes,
  ownerKeyFor,
  startPushNotifier,
  setCanonicalResolver,
  PushOwnershipError,
} from "./lib/push";
import { peerBashAllowed } from "./lib/peer-policy";
import {
  PreviewError,
  emitPreviewEvent,
  getPreview,
  listPreviews,
  previewLogs,
  previewsAvailable,
  reapPreviewsForSessions,
  rebuildPreview,
  refreshAll,
  restartPreview,
  startPreview,
  setPreviewShared,
  shutdownPreviews,
  stopPreview,
} from "./lib/previews";
import { PREVIEW_LIMITS, validatePreviewSpec } from "@shared/preview-spec";
import { driveQueue, type DriveResult } from "./lib/preview-drive";
import { validateImageBase64 } from "./lib/image-guard";
import {
  createJoinTicket,
  joinStatus,
  getJoinTicket,
  admitJoin,
  denyJoin,
  claimJoin,
  listPendingJoins,
  dropJoinsForShare,
} from "./lib/peer-joins";
import { listSlashCommands } from "./lib/commands";
import { listAgentRuns, getAgentDetail } from "./lib/agents";
import { search, type SearchType } from "./lib/search";
import { listMcps } from "./lib/mcps";
import { getStack } from "./lib/stack";
import { getIdentity } from "./lib/identity";
import { getSessionModel, resolveDisplayModel } from "./lib/session-model";
import { getSessionSummary, closeSummaryDb } from "./lib/session-summary";
import { listFiles, readImageWithinCwd, CwdPolicyError } from "./lib/files";
import { wrapWithLandlock } from "./lib/landlock-policy";
import { buildFileTree, buildFileSubtree, buildFilePreview, TREE_MAX_TOTAL_NODES } from "./lib/git";
import { listEvents, getEvent } from "./lib/events-query";
import { clampInt } from "@shared/clamp";
import { backupEventsDb, checkpointDb, closeDb } from "./lib/db";
import { mutatingLimiter } from "./rate-limit";
import { log } from "@shared/logger";
import { registerShutdown } from "@shared/shutdown";
import { markCleanShutdown, consumeUncleanShutdown } from "./lib/shutdown-marker";
import { CONTROL_SOCKET, HOOK_SOCKET } from "./lib/paths";
import { assertAsAgentAvailable, killChildAsAgent, spawnAsAgent } from "./lib/as-agent";

// Both socket paths live in lib/paths so active-sessions can inject the hook
// one into the claude child's env. See the note there.
const SOCKET_PATH = CONTROL_SOCKET;
const HOOK_SOCKET_PATH = HOOK_SOCKET;

const MAX_BYTES_DEFAULT = 32 * 1024;
const MAX_BYTES_MESSAGE = 100 * 1024 + 1024;
// A user turn may carry base64 images (vision). The message route allows a
// larger body than plain text, bounded per-image and per-count below.
const MAX_BYTES_TURN = 16 * 1024 * 1024;
const MAX_IMAGES_PER_TURN = 8;
const MAX_IMAGE_B64_BYTES = 4 * 1024 * 1024; // ~3MB decoded per image (full → model)
// Thumbnails (≤512px) are persisted into the turn's event and broadcast to
// every peer, so the whole set is bounded to keep event entries small.
const MAX_EVENT_THUMBS_B64_BYTES = 512 * 1024;
const ALLOWED_IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES_INGEST = 64 * 1024;
const MAX_BYTES_ARGS = 16 * 1024;

const ALLOWED_HOOKS = new Set([
  "SessionStart",
  "SessionEnd",
  "Stop",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "SubagentStop",
  "PreCompact",
  "ToolUseConfirmation",
  // Dashboard-driven `!cmd` shortcut. Bypasses the model — bash runs
  // directly in the session's cwd and the result is appended to the
  // event log as a synthesized hook frame.
  "BashShortcut",
  // Tool-permission asks captured from claude's stream-json
  // `control_request` frames. Emitted when the model wants approval to
  // run a non-allowlisted tool; the dashboard renders an interactive
  // card. PermissionResponse records the user's decision so the
  // transcript shows the resolution.
  "PermissionRequest",
  "PermissionResponse",
  // Live-preview lifecycle. In the transcript (and therefore in search and the
  // notification classifier) so "the app is up at <url>" is part of the shared
  // record every participant sees, not a UI-only side effect.
  "PreviewStarted",
  "PreviewFailed",
  "PreviewShared",
  "PreviewRebuilt",
  "PreviewStopped",
]);

/** Number of preview runner containers declared in compose. */
const PREVIEW_SLOT_COUNT = PREVIEW_LIMITS.slots;

const REQUEST_ID_HEADER = "x-request-id";

// ---------- HTTP helpers ----------

function reqId(req: IncomingMessage): string | undefined {
  const v = req.headers[REQUEST_ID_HEADER];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

function json(res: ServerResponse, status: number, body: unknown, rid?: string) {
  const payload = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  };
  if (rid) headers[REQUEST_ID_HEADER] = rid;
  res.writeHead(status, headers);
  res.end(payload);
}

function err(res: ServerResponse, status: number, message: string, rid?: string) {
  json(res, status, { error: message, ...(rid ? { requestId: rid } : {}) }, rid);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      received += c.length;
      if (received > maxBytes) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const ct = (req.headers["content-type"] ?? "").toString().toLowerCase();
  if (!ct.includes("application/json")) {
    throw Object.assign(new Error("expected application/json"), { status: 415 });
  }
  const text = await readBody(req, maxBytes);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

function getHeader(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === "string" ? v : null;
}

const PARTICIPANT_HEADER = "x-hooop-participant";

/**
 * Is this participant string the HOST, and is that claim still good?
 *
 * Two spellings, one identity:
 *   - "host"            — the local operator, authenticated by HOSTNAME (the
 *                         dashboard only mints the install cookie on the
 *                         localhost allowlist). Nothing for us to re-check:
 *                         the trust boundary is "already on this machine".
 *   - "host:<deviceId>" — the SAME person on one of their own enrolled devices,
 *                         reaching us over the public tunnel. This one we DO
 *                         re-check, against the durable device registry, for
 *                         exactly the reason we re-check shares: it is a
 *                         revocable bearer grant that arrived from the
 *                         internet, so the dashboard's signature check is the
 *                         first gate and this is the authoritative one.
 *
 * Anything else (a peer, an unknown shape, an absent header) is not the host.
 *
 * The deviceId is deliberately NOT surfaced to callers as a distinct identity.
 * An enrolled device IS the host — same participantId, same attribution, same
 * powers — because the whole point of enrolling it was to stop being a
 * second-class guest on your own session. The device only exists as a separate
 * thing in one place: the list the host revokes from.
 */
/**
 * Stamp "this device was seen" for any request that arrives as one, whatever the
 * route does next.
 *
 * Tying last-seen to the participant GUARDS was wrong, and visibly so: most read
 * routes never consult the participant at all, and several dashboard routes don't
 * even forward it. A phone sitting in a session, loading the transcript and the
 * file tree, therefore touched nothing — so the host's device list said "not used
 * yet" about a device that was demonstrably in use, which is worse than showing
 * nothing.
 *
 * Non-authoritative on purpose: it stamps a live device, ignores everything else,
 * and never rejects. Authorization is still decided by the guards below.
 */
function touchHostDevice(req: IncomingMessage): void {
  const raw = getHeader(req, PARTICIPANT_HEADER);
  if (!raw || !raw.startsWith("host:")) return;
  const deviceId = raw.slice("host:".length);
  if (deviceId) validateHostDevice(deviceId);
}

/**
 * Revive a session in the background because somebody is about to arrive on it.
 * Never throws and never blocks the caller: a session that refuses to wake (it
 * expired, or it is mid-teardown) still gets its share link, and the ordinary
 * lazy revive on the next turn remains the fallback.
 */
function wakeIfDormant(sessionId: string, why: string): void {
  // No slot means nothing to wake: this sandbox is not driving that session, so
  // there is no child to respawn and wakeSession would only throw. Those revive the
  // way they always have, on their first turn. Deliberately narrower than the
  // landing hint, which still points at them because the dashboard opens them fine.
  const meta = getActiveSession(sessionId);
  if (!meta || meta.status === "alive" || meta.status === "expired") return;
  void wakeSession(meta.sessionId)
    .then(() => log.info("sandbox", "woke a dormant session", { sessionId: meta.sessionId, why }))
    .catch((e: unknown) => log.warn("sandbox", "could not wake a dormant session", {
      sessionId: meta.sessionId, why, err: String(e),
    }));
}

function isHostParticipant(raw: string | null): boolean {
  if (raw === "host") return true;
  if (!raw || !raw.startsWith("host:")) return false;
  const deviceId = raw.slice("host:".length);
  if (!deviceId) return false;
  return validateHostDevice(deviceId).ok;
}

/**
 * Authoritative peer-context guard for co-drive actions. The dashboard forwards
 * `x-hooop-participant` (already authenticated by the dashboard's signed-token
 * gate); this is the independent SECOND check that a compromised dashboard
 * cannot bypass — it re-validates the share against the sandbox's own durable
 * registry (revocation + session scope) and the capability for this action.
 *
 * Host ("host", or "host:<deviceId>" re-validated against the device registry)
 * → allowed, author "host". Peer → validated; returns the share's peerName as
 * the author for attribution.
 *
 * An ABSENT header is rejected, not treated as host. It used to mean host,
 * which made the identity of every guarded route depend on a header the
 * dashboard proxy happens to add rather than on anything the sandbox checks:
 * omit it and you were the host. Every dashboard route already forwards it
 * (proxy.ts sets it after authenticating the install cookie, and strips any
 * inbound value), so requiring it costs nothing and removes a default that
 * silently grants full authority to whatever a future caller forgets to send.
 */
function checkParticipant(
  req: IncomingMessage,
  requestedSessionId: string,
  action: "turn" | "bash" | "permission" | "admit",
): { ok: true; author: string; isPeer: boolean; shareId: string | null; capability: ShareCapability | null } | { ok: false; status: number; reason: string } {
  const raw = getHeader(req, PARTICIPANT_HEADER);
  if (isHostParticipant(raw)) return { ok: true, author: "host", isPeer: false, shareId: null, capability: null };
  if (!raw) return { ok: false, status: 403, reason: "missing participant" };
  // A `host:<id>` that got here failed validation above — say so rather than
  // falling through to the catch-all "invalid participant", which would read as
  // a malformed header when the real story is a revoked or expired device.
  if (raw.startsWith("host:")) return { ok: false, status: 403, reason: "device revoked or expired" };
  if (raw.startsWith("peer:")) {
    const shareId = raw.slice("peer:".length);
    // Liveness only here (not revoked/expired); session scope is checked
    // below with alias-awareness.
    const v = validateShareById(shareId, {});
    if (!v.ok || !v.record) {
      return { ok: false, status: 403, reason: "share revoked or expired" };
    }
    // Session-equivalence: a share is bound to the session id it was created
    // under, but `claude --resume` swaps the canonical id mid-life. Resolve
    // BOTH the requested id and the share's bound id through the registry
    // (which follows aliases) and compare the resulting canonical ids, so a
    // resumed session still matches its share.
    const reqCanonical = getActiveSession(requestedSessionId)?.sessionId ?? requestedSessionId;
    const shareCanonical = getActiveSession(v.record.sessionId)?.sessionId ?? v.record.sessionId;
    if (reqCanonical !== shareCanonical) {
      return { ok: false, status: 403, reason: "out of session scope" };
    }
    if (!capabilityAllows(v.record.capability, action)) {
      return { ok: false, status: 403, reason: `share capability '${v.record.capability}' does not permit ${action}` };
    }
    return { ok: true, author: v.record.peerName ?? "peer", isPeer: true, shareId, capability: v.record.capability };
  }
  // Unknown participant format — treat as unauthorized.
  return { ok: false, status: 403, reason: "invalid participant" };
}

/**
 * Host-only guard for spawn routes that have no session/share to scope against
 * (session create, skill run). Defense-in-depth: the dashboard already gates
 * these with isHost(), but the proxy still forwards the authenticated
 * `x-hooop-participant`, so if that route guard ever regresses a peer-forwarded
 * request is rejected HERE too — a compromised/buggy dashboard can't spawn work
 * as a peer. Host (including a validated `host:<deviceId>`) → allowed; a peer,
 * a dead device, an unknown format, or an ABSENT
 * header → 403. Writes the error response and returns false so callers can
 * `if (!requireHost(req, res)) return;`.
 *
 * The absent case used to be allowed as "an internal call". There are no
 * internal HTTP self-calls — the only in-container clients are the two hook
 * scripts (which use hook-token routes, not these) and the root healthcheck
 * (GET /health, auth "none") — so that carve-out granted host authority to
 * anyone who could reach the socket and say nothing.
 */
function requireHost(req: IncomingMessage, res: ServerResponse): boolean {
  if (isHostParticipant(getHeader(req, PARTICIPANT_HEADER))) return true;
  err(res, 403, "host-only action");
  return false;
}

function boundedString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

// ---------- Router ----------

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<void> | void;

/**
 * Which socket a request arrived on.
 *
 *   "control" — /var/run/hooop/sandbox.sock, the shared volume the DASHBOARD
 *               container reaches. Carries every state-mutating route.
 *   "hook"    — a container-local socket the in-container hook scripts reach.
 *               Carries only /permission-ask, /permission-wait and /ingest.
 *
 * The point of the separation is that the hook scripts are children of the
 * model's own claude process, so anything they can reach, a compromised model
 * can reach. Confining them to their own listener means the control plane
 * stops being one stolen token away — a request that arrives on the hook
 * socket cannot even NAME a control route, whatever credential it presents.
 */
export type ListenerKind = "control" | "hook";

interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  // "none" is reserved for Docker healthchecks reaching the UDS without the
  // token. It MUST stay narrow (no info leak beyond "process is alive").
  auth: "sandbox" | "hook" | "none";
}

const routes: Route[] = [];

/**
 * Whether `route` is served by the listener a request arrived on.
 *
 * This turns the existing `auth` tag into a structural property rather than an
 * advisory one: a route is reachable on exactly one socket ("none" — just
 * /health — on both, so the root healthcheck works either way). Enforced in
 * dispatch BEFORE authorize, and by falling through to 404 rather than 403, so
 * the wrong socket cannot even be used to probe which routes exist.
 */
function servedBy(route: Route, kind: ListenerKind): boolean {
  if (route.auth === "none") return true;
  return kind === "hook" ? route.auth === "hook" : route.auth === "sandbox";
}

/**
 * The route table's (method, path, auth) triples — a test seam so the
 * one-route-one-listener invariant can be asserted wholesale instead of
 * route-by-route. Without it, a future route that forgets its auth tag
 * silently defaults to "sandbox" and nothing notices.
 */
export function routeTable(): ReadonlyArray<{ method: string; path: string; auth: Route["auth"] }> {
  return routes.map((r) => ({ method: r.method, path: r.path, auth: r.auth }));
}

// Per MDN: chars that need escaping inside a RegExp character class.
const REGEX_META = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
  return s.replace(REGEX_META, "\\$&");
}

function add(method: string, path: string, handler: RouteHandler, auth: Route["auth"] = "sandbox") {
  const paramNames: string[] = [];
  // Escape regex metacharacters in literal segments BEFORE substituting
  // :param patterns. Otherwise a future path like `/foo.json` would match
  // `/fooxjson`, or a path containing `+`/`?`/`*` would behave unpredictably.
  const pattern = new RegExp(
    "^" + escapeRegex(path).replace(/:([a-zA-Z]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    }) + "$"
  );
  routes.push({ method, path, pattern, paramNames, handler, auth });
}

// ---------- Routes ----------

// Liveness only; no auth. Returns nothing that would leak state. Used by the
// Docker HEALTHCHECK and any service-discovery probe.
add("GET", "/health", (_req, res) => {
  json(res, 200, { ok: true });
}, "none");

add("GET", "/sessions", (_req, res) => {
  startSessionsWatcher();
  startIngestor();
  json(res, 200, listSessions());
});

add("POST", "/sessions", async (req, res) => {
  if (!requireHost(req, res)) return;
  let body: { gitRepo?: unknown; label?: unknown; name?: unknown; model?: unknown; idleTtlMs?: unknown; burnAfterUse?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }

  const gitRepo = boundedString(body.gitRepo, 2048);
  const label = boundedString(body.label, 200);
  const name = boundedString(body.name, 200);
  const model = boundedString(body.model, 128);

  // Optional git URL to clone into the workspace on start (cloned dir becomes
  // the session cwd, under WORKSPACE_DIR which cwd-policy already permits).
  // Accept only well-formed remote URLs; reject flag-like / whitespace input.
  if (gitRepo) {
    const ok = /^(https?|ssh|git):\/\/\S+$/.test(gitRepo) || /^[\w.-]+@[\w.-]+:\S+$/.test(gitRepo);
    if (!ok || gitRepo.startsWith("-") || /\s/.test(gitRepo)) {
      return err(res, 400, "gitRepo must be a valid git URL (https://, ssh://, git://, or user@host:path)");
    }
  }

  // Reject model values that could be misinterpreted as flags. The claude
  // CLI accepts arbitrary strings here (aliases like opus/sonnet/haiku or
  // full IDs), so we only block the structural footgun.
  if (model && (model.startsWith("-") || /\s/.test(model))) {
    return err(res, 400, "model must not start with '-' or contain whitespace");
  }

  // idleTtlMs is this session's own idle-dormancy window in ms: undefined/null
  // means "use the install-wide default", and 0 means "never go dormant".
  // A FINITE window is capped at 24h so a unit mix-up (seconds handed in as ms,
  // or a stray extra digit) is rejected outright instead of quietly parking a
  // session for a month. The cap is deliberately NOT a slot-starvation defense:
  // 0 already opts out of dormancy completely, and holding one of the three
  // controllable slots open indefinitely is the host's call to make.
  // Number.isInteger already implies finite, so it carries the NaN/Infinity
  // rejection on its own.
  let idleTtlMs: number | null | undefined;
  if (body.idleTtlMs !== undefined && body.idleTtlMs !== null) {
    if (
      typeof body.idleTtlMs !== "number" ||
      !Number.isInteger(body.idleTtlMs) ||
      body.idleTtlMs < 0 ||
      body.idleTtlMs > 86_400_000
    ) {
      return err(res, 400, "idleTtlMs must be a finite integer between 0 and 86400000 (24h)");
    }
    idleTtlMs = body.idleTtlMs;
  }

  let burnAfterUse: boolean | undefined;
  if (body.burnAfterUse !== undefined) {
    if (typeof body.burnAfterUse !== "boolean") {
      return err(res, 400, "burnAfterUse must be a boolean");
    }
    burnAfterUse = body.burnAfterUse;
  }

  try {
    const { sessionId, meta } = await startNewConversation({
      gitRepo: gitRepo ?? undefined,
      label: label ?? undefined,
      name: name ?? undefined,
      model: model ?? undefined,
      idleTtlMs,
      burnAfterUse,
      via: "new-conversation",
    });
    json(res, 200, { sessionId, meta });
  } catch (e: any) {
    if (e?.name === "TooManyControllableSessionsError") {
      res.setHeader("Retry-After", "5");
      return err(res, 429, e.message);
    }
    err(res, 500, e?.message ?? "spawn failed");
  }
});

add("PATCH", "/sessions/:id", async (req, res, params) => {
  let body: { name?: unknown };
  try { body = await readJson(req, 4 * 1024); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const name = boundedString(body.name, 200);
  if (name == null) return err(res, 400, "missing required field: name");
  const meta = renameSession(params.id, name);
  if (!meta) return err(res, 404, "session not found");
  json(res, 200, { ok: true, meta });
});

add("DELETE", "/sessions/:id", async (_req, res, params) => {
  try {
    // Full teardown (expand aliases -> delete -> revoke shares/joins -> reap
    // previews) now lives in active-sessions.ts's destroySession, so this route
    // and the idle sweeper's burn-after-use path can't drift apart. Response
    // shape is unchanged.
    const result = await destroySession(params.id);
    json(res, 200, { ok: true, ...result });
  } catch (e: any) {
    err(res, 500, e?.message ?? "delete failed");
  }
});

add("POST", "/sessions/:id/end", async (_req, res, params) => {
  try {
    // For a burn session, being ended IS being destroyed — so hand the whole
    // teardown to destroySession INSTEAD of ending first and destroying after.
    // Order is the reason: endSession deletes the slot's alias entries, and
    // `claude --resume` re-keys a session mid-life, so a share or preview minted
    // under a prior id is only still reachable while those aliases exist.
    // destroySession expands them itself, before the teardown that clears them;
    // destroying afterwards would silently leave an aliased share revoked-never
    // and an aliased preview running. It also runs endSession internally (via
    // deleteSession) and reaps previews, so nothing below is skipped.
    // The burn check must read the flag BEFORE any of that, while the slot is
    // still in the registry.
    if (getActiveSession(params.id)?.burnAfterUse === true) {
      await destroySession(params.id);
      return json(res, 200, { ok: true });
    }
    const sessionIds = expandSessionIds(params.id);
    await endSession(params.id);
    // Ending the conversation ends its preview. (The IDLE sweeper deliberately
    // does not: it only demotes alive→dormant, and a dormant session can be
    // resumed — killing a running app because the agent went quiet for a while
    // would be surprising and destructive.)
    await reapPreviewsForSessions(sessionIds);
    json(res, 200, { ok: true });
  } catch (e: any) {
    err(res, 500, e?.message ?? "end failed");
  }
});

add("POST", "/sessions/:id/message", async (req, res, params) => {
  if (!isControllable(params.id)) return err(res, 409, "session not controllable");
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: { text?: unknown; images?: unknown };
  try { body = await readJson(req, MAX_BYTES_TURN); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const text = typeof body.text === "string" ? body.text : "";
  if (text.length > 100_000) return err(res, 413, "text too long (>100kb)");
  // Optional base64 image attachments (vision). Validated strictly: known media
  // types only, bounded count + size — this is untrusted peer-supplied data.
  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES_PER_TURN) return err(res, 413, `too many images (max ${MAX_IMAGES_PER_TURN})`);
  const images: TurnImage[] = [];      // full-res → the model
  const thumbnails: TurnImage[] = [];  // ≤512px → persisted in the event
  let thumbBytes = 0;
  for (const it of rawImages) {
    const o = it && typeof it === "object" ? (it as { media_type?: unknown; data?: unknown; thumb?: unknown }) : {};
    if (typeof o.media_type !== "string" || !ALLOWED_IMAGE_MEDIA.has(o.media_type)) return err(res, 400, "unsupported image media_type");
    if (typeof o.data !== "string" || o.data.length === 0) return err(res, 400, "empty image data");
    if (o.data.length > MAX_IMAGE_B64_BYTES) return err(res, 413, "image too large");
    // The bytes are untrusted (any turn-capable peer). Verify they're valid
    // base64 AND actually the declared image type AND not a decompression bomb.
    const full = validateImageBase64(o.data, o.media_type, 8192);
    if (!full.ok) return err(res, 400, full.reason ?? "invalid image");
    images.push({ media_type: o.media_type, data: o.data });
    // Thumbnail is a JPEG the client downscaled; fall back to the full data if
    // absent. This is what gets broadcast + rendered by every peer, so hold it
    // to a tighter dimension cap.
    const thumb = typeof o.thumb === "string" && o.thumb ? o.thumb : o.data;
    const thumbType = typeof o.thumb === "string" && o.thumb ? "image/jpeg" : o.media_type;
    const thumbCheck = validateImageBase64(thumb, thumbType, 1024);
    if (!thumbCheck.ok) return err(res, 400, `thumbnail rejected: ${thumbCheck.reason}`);
    thumbBytes += thumb.length;
    thumbnails.push({ media_type: thumbType, data: thumb });
  }
  if (thumbBytes > MAX_EVENT_THUMBS_B64_BYTES) {
    return err(res, 413, `image thumbnails too large for the transcript (max ${Math.floor(MAX_EVENT_THUMBS_B64_BYTES / 1024)}KB total) — attach fewer or smaller images`);
  }
  if (!text && images.length === 0) return err(res, 400, "missing text or images");
  try {
    const result = await writeUserTurn(
      params.id, text, guard.author, guard.shareId,
      images.length ? { images, thumbnails } : undefined,
    );
    json(res, 200, { ok: true, sessionId: result.sessionId });
  } catch (e: any) {
    err(res, 500, e?.message ?? "write failed");
  }
});

// Interrupt the model's current turn (`/stop`). Any turn-capable participant
// may stop a run they can drive; spectate is rejected at the gate.
add("POST", "/sessions/:id/interrupt", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  const istatus = getActiveSession(params.id)?.status;
  if (istatus === "provisioning" || istatus === "error") return err(res, 409, "session not ready");
  // A caller may say WHY, for a stop nobody typed — the dashboard does this when
  // the last viewer takes control of a preview the agent was driving. Optional:
  // the composer's own /stop sends no body and stays a plain command.
  let reason: string | null = null;
  try {
    const body = await readJson(req, 4096) as { reason?: unknown };
    if (typeof body?.reason === "string") reason = body.reason.slice(0, 200);
  } catch { /* no body, or not JSON: a plain stop */ }
  try {
    await interruptSession(params.id, guard.author, reason);
    json(res, 200, { ok: true });
  } catch (e: any) {
    err(res, 500, e?.message ?? "interrupt failed");
  }
});

// Participant-to-participant chat: a message (optionally with images) that is
// persisted + broadcast to everyone in the session but NEVER written to the
// model's stdin. `>`-prefixed in the composer. Images here are already ≤512
// thumbnails (there's no model to send a full-res copy to). Any turn-capable
// participant may chat; spectate is read-only.
add("POST", "/sessions/:id/chat", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  const cstatus = getActiveSession(params.id)?.status;
  if (cstatus === "provisioning" || cstatus === "error") return err(res, 409, "session not ready");
  let body: { text?: unknown; images?: unknown };
  try { body = await readJson(req, MAX_BYTES_TURN); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const text = typeof body.text === "string" ? body.text.slice(0, 10_000) : "";
  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES_PER_TURN) return err(res, 413, `too many images (max ${MAX_IMAGES_PER_TURN})`);
  const images: TurnImage[] = [];
  let imgBytes = 0;
  for (const it of rawImages) {
    const o = it && typeof it === "object" ? (it as { media_type?: unknown; data?: unknown }) : {};
    if (typeof o.media_type !== "string" || !ALLOWED_IMAGE_MEDIA.has(o.media_type)) return err(res, 400, "unsupported image media_type");
    if (typeof o.data !== "string" || o.data.length === 0) return err(res, 400, "empty image data");
    const check = validateImageBase64(o.data, o.media_type, 1024);
    if (!check.ok) return err(res, 400, check.reason ?? "invalid image");
    imgBytes += o.data.length;
    images.push({ media_type: o.media_type, data: o.data });
  }
  if (imgBytes > MAX_EVENT_THUMBS_B64_BYTES) {
    return err(res, 413, `chat images too large (max ${Math.floor(MAX_EVENT_THUMBS_B64_BYTES / 1024)}KB total) — attach fewer or smaller images`);
  }
  if (!text.trim() && images.length === 0) return err(res, 400, "empty chat message");
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "Chat",
      ctx: { session_id: canonicalId, prompt: text, author: guard.author, images: images.length ? images : undefined },
    }));
    json(res, 200, { ok: true });
    // A chat is a side conversation — NEVER sent to the model — so it must not
    // SPAWN the agent. Waking claude (--resume) with no turn to run makes it exit
    // immediately (non-zero in print mode), flipping the session
    // dormant→alive→ended in a flicker — so markSessionActive deliberately does
    // NOT spawn claude. It DOES promote the (decoupled) session lifecycle to
    // "alive" so the dashboard surfaces the session in its Active group
    // (lifecycle = "recently in use", not "a child is running"); the next real
    // model turn lazily revives the child.
    markSessionActive(canonicalId);
  } catch (e: any) {
    err(res, 500, e?.message ?? "chat failed");
  }
});

add("POST", "/sessions/:id/bash", async (req, res, params) => {
  // Dashboard `!cmd` shortcut: execute bash directly in the session's cwd,
  // bypass the model entirely, and synthesize a BashShortcut event so the
  // transcript shows it like any other tool call. No claude turn, no token
  // cost. Trust boundary is still the container — the agent user already
  // has shell, this just gives the dashboard composer a fast lane to it.
  const meta = getActiveSession(params.id);
  if (!meta) return err(res, 404, "unknown session");
  if (meta.status === "expired") return err(res, 409, "session expired");
  // A session still cloning (provisioning) or failed (error) has no usable
  // workspace yet — refuse the bash fast-lane until it's live.
  if (meta.status === "provisioning") return err(res, 409, "session still provisioning");
  if (meta.status === "error") return err(res, 409, "session failed to start");

  const guard = checkParticipant(req, meta.sessionId, "bash");
  if (!guard.ok) return err(res, guard.status, guard.reason);

  let body: { command?: unknown };
  try { body = await readJson(req, MAX_BYTES_MESSAGE); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.command !== "string" || body.command.trim().length === 0) {
    return err(res, 400, "missing required field: command");
  }
  // Peer hardening: the `!bash` fast lane bypasses the model + permission gate,
  // so a guest could otherwise read host secrets/tokens or push. Apply the peer
  // command policy here (the host is unrestricted).
  if (guard.isPeer) {
    const policy = peerBashAllowed(body.command);
    if (!policy.ok) return err(res, 403, policy.reason ?? "command not allowed for guests");
  }
  if (body.command.length > 16 * 1024) {
    return err(res, 413, "command too long (>16kb)");
  }

  const command = body.command;
  const cwd = meta.cwd;
  const startedAt = Date.now();
  const STDOUT_CAP = 1 * 1024 * 1024; // 1 MB
  const STDERR_CAP = 256 * 1024;       // 256 KB
  // Generous safety cap so genuinely long processes finish (was 30s, which made
  // long commands time out with a bare error). Still bounded so a hung/runaway
  // command can't linger forever — the kill surfaces as timed_out on the final
  // snapshot, not a request error.
  const HARD_CAP_MS = 10 * 60_000;

  // A `!bash` runs directly in the cwd and BYPASSES the model entirely, so it
  // must not SPAWN the agent. Waking claude (--resume) with no turn to run makes
  // it exit immediately (non-zero in print mode), flipping the session
  // dormant→alive→ended in a flicker — so markSessionActive deliberately does
  // NOT spawn claude. It DOES promote the (decoupled) session lifecycle to
  // "alive" so the dashboard surfaces the session in its Active group: lifecycle
  // means "recently in use", not "a child process is running", and the next real
  // model turn lazily revives the child. Events below are keyed to `stableSid`
  // (a snapshot) so co-driving peers receive them regardless.
  const stableSid = meta.sessionId;
  markSessionActive(stableSid);

  const { randomUUID } = await import("node:crypto");
  const runId = randomUUID();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLen = 0;
  let stderrLen = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;

  // Emit one self-contained BashShortcut snapshot. `run_id` groups every
  // snapshot for this command into ONE live card in the transcript; `status`
  // flips running→done. Each snapshot carries the full output-so-far (capped),
  // so a dropped SSE frame can't leave the card stale — the latest snapshot is
  // complete on its own. Emitted under stableSid so co-driving peers get every
  // update despite a wake-triggered alias swap.
  const emitSnapshot = (
    status: "running" | "done",
    fin?: { exitCode: number | null; signal: NodeJS.Signals | null },
  ): number | null => {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        hook: "BashShortcut",
        ctx: {
          session_id: stableSid,
          author: guard.author,
          tool_name: "BashShortcut",
          tool_input: command,
          tool_response: {
            run_id: runId,
            status,
            exit_code: fin ? fin.exitCode : null,
            signal: fin ? fin.signal : null,
            duration_ms: Date.now() - startedAt,
            timed_out: timedOut,
            stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
            stderr: Buffer.concat(stderrChunks).toString("utf-8"),
            stdout_truncated: stdoutTruncated,
            stderr_truncated: stderrTruncated,
          },
        },
      });
      const r = ingestEventLine(line);
      if (!r.ok) log.warn("bash-shortcut", "snapshot ingest failed", { reason: r.reason });
      return r.ok ? (r.id ?? null) : null;
    } catch (e: any) {
      log.warn("bash-shortcut", "snapshot emit threw", { err: String(e?.message ?? e) });
      return null;
    }
  };

  // Show the running card immediately and RESPOND NOW — the command runs in the
  // background and streams updates over SSE. A long-running process therefore
  // no longer blocks (or times out) the request.
  const startEventId = emitSnapshot("running");
  json(res, 200, { ok: true, runId, eventId: startEventId });

  // Confine the fast-lane shell to the session's own cwd via Landlock, so
  // `!cd ../` / `!cat ~/.claude/...` can't read outside this session. Falls
  // back to an unwrapped shell where Landlock/the helper is unavailable.
  //
  // "dev" rather than "tight": this is an interactive shell where people type
  // `!git status`, and "tight" grants no /dev — which makes /dev/null
  // unopenable and every git invocation exit 128. See devRwRoots().
  let landlocked: ReturnType<typeof wrapWithLandlock>;
  try {
    landlocked = wrapWithLandlock("dev", cwd, "bash", ["-lc", command]);
  } catch (e: any) {
    // Expected case: a cwd we can't express in the allow-list (see
    // LandlockPolicyError). Anything else reaching here is a bug, but the
    // response to both is the same and deliberately fail-CLOSED — we never
    // fall back to an unconfined shell just because confinement threw. The
    // 200 above already went out, so this reports via the transcript card.
    if (e?.name !== "LandlockPolicyError") {
      log.warn("bash-shortcut", "landlock wrap threw unexpectedly; refusing to run", { err: String(e?.message ?? e) });
    }
    stderrChunks.push(Buffer.from(`hooop: refusing to run unconfined: ${String(e?.message ?? e)}\n`));
    emitSnapshot("done", { exitCode: 126, signal: null });
    markSessionActive(stableSid);
    return;
  }
  // As the model's uid, not the server's: this shell runs in the session
  // workdir, so anything it creates has to be owned by the same user claude's
  // own tools write as — otherwise the tree ends up mixed-ownership and `git`
  // in it starts refusing to operate on "dubious ownership".
  // Same env hygiene the claude child gets (lib/active-sessions.ts): this shell
  // is the model's too, so it has no business being told where the control plane
  // lives or how to re-enter its own uid. Spreading process.env would hand it
  // HOOOP_SANDBOX_SOCKET=/var/run/hooop/sandbox.sock verbatim from the image ENV.
  // DAC already refuses the connect(), so this is defence in depth — but it is
  // the asymmetry that would quietly become the whole exposure if a directory
  // mode ever regressed.
  const shellEnv = { ...process.env, ...landlocked.env };
  shellEnv.HOOOP_SANDBOX_SOCKET = HOOK_SOCKET_PATH;
  delete shellEnv.HOOOP_SANDBOX_TOKEN_FILE;
  delete shellEnv.HOOOP_AS_AGENT;

  const child = spawnAsAgent(landlocked.file, landlocked.args, { cwd, env: shellEnv });

  const collect = (chunk: Buffer, chunks: Buffer[], len: number, cap: number): { len: number; truncated: boolean } => {
    if (len >= cap) return { len, truncated: true };
    const room = cap - len;
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      return { len: cap, truncated: true };
    }
    chunks.push(chunk);
    return { len: len + chunk.length, truncated: false };
  };
  let dirty = false;
  child.stdout.on("data", (c: Buffer) => {
    const r = collect(c, stdoutChunks, stdoutLen, STDOUT_CAP);
    stdoutLen = r.len; stdoutTruncated ||= r.truncated; dirty = true;
  });
  child.stderr.on("data", (c: Buffer) => {
    const r = collect(c, stderrChunks, stderrLen, STDERR_CAP);
    stderrLen = r.len; stderrTruncated ||= r.truncated; dirty = true;
  });

  // Throttled live updates: at most one snapshot per FLUSH_MS, and only when
  // output actually changed — bounds event volume for chatty processes.
  const FLUSH_MS = 500;
  const flushTimer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    emitSnapshot("running");
    markSessionActive(stableSid); // keep the session reading as active while it runs
  }, FLUSH_MS);

  const timer = setTimeout(() => {
    timedOut = true;
    killChildAsAgent(child, "SIGKILL");
  }, HARD_CAP_MS);

  const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    clearTimeout(timer);
    clearInterval(flushTimer);
    emitSnapshot("done", { exitCode, signal });
    markSessionActive(stableSid);
  };
  child.once("close", (code, signal) => finish(code, signal));
  child.once("error", () => finish(null, null));
});

add("GET", "/sessions/:id/pending-requests", (_req, res, params) => {
  // Lets the dashboard re-hydrate the permission-card stack after a
  // page reload — SSE only delivers live, so without this an in-flight
  // ask would be invisible to a freshly-mounted client.
  // Strip the internal shareId: clients display `author` and act by
  // requestId; the trust grant is resolved sandbox-side.
  const requests = getPendingRequests(params.id).map(({ shareId, ...pub }) => pub);
  json(res, 200, { requests });
});

add("POST", "/sessions/:id/permission", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  // Base gate is "turn": a spectate peer (no turn capability) is rejected here.
  // Per-tool authority is then refined below once we know what's being decided.
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: { requestId?: unknown; decision?: unknown; scope?: unknown; feedback?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.requestId !== "string" || body.requestId.length === 0) {
    return err(res, 400, "missing required field: requestId");
  }
  // What is being decided determines who may decide it:
  //   - AskUserQuestion → answering a question is input, not a gate decision;
  //     any turn-capable participant (host, full or drive peer) may answer.
  //   - ExitPlanMode (plan review) → approve/reject needs "permission" capability
  //     (host or a full peer), matching the share model.
  //   - everything else (Write/Edit/git push/…) → needs "permission" capability:
  //     the host or a full-access peer may allow/deny; drive/spectate cannot
  //     (their dashboard shows a read-only "waiting for the host" bubble).
  if (guard.isPeer) {
    const target = getPendingRequests(params.id).find((r) => r.requestId === body.requestId);
    const toolName = target?.toolName ?? null;
    // CRITICAL asks are the host's alone, whatever the share says.
    //
    // The gate already refuses to auto-approve one in every unattended mode
    // (approved plan, trusted peer, auto mode) and escalates it "to a dashboard
    // prompt (host-only decision)" — but that parenthesis was a comment, not code.
    // A full-capability peer could answer any escalated ask, including one raised
    // by their OWN turn: drive a turn, have the model reach for `rm -rf` or a
    // `git push`, then approve it yourself. That is not co-driving, it is the
    // guardrail approving itself, and it made the critical set decorative for
    // exactly the participant it exists to contain.
    //
    // Checked BEFORE the capability refinements below so no tool-specific carve-out
    // can route around it, and before `decision` is even parsed so a peer learns
    // nothing about what they are not allowed to answer.
    //
    // The host on an enrolled device counts as the host here — which is what makes
    // this a workable rule rather than a wall. Before devices, "only the host may
    // approve" meant a paired session stalled the moment the operator stepped away
    // from their laptop; now the prompt reaches their phone.
    if (target?.critical) {
      return err(
        res,
        403,
        "that one is the host's call — destructive commands, git, secrets and anything outside this session's folder need the host to approve, even from a full-access share",
      );
    }
    if (toolName === "AskUserQuestion") {
      // turn capability already confirmed by the base gate — allow.
    } else if (toolName === "ExitPlanMode") {
      if (!capabilityAllows(guard.capability ?? "spectate", "permission")) {
        return err(res, 403, "your share can view the plan and comment, but only the host or a full-access peer can approve or reject it");
      }
    } else if (!capabilityAllows(guard.capability ?? "spectate", "permission")) {
      return err(res, 403, "your share can't approve tool use — only the host or a full-access peer can");
    }
  }
  if (body.decision !== "allow" && body.decision !== "deny") {
    return err(res, 400, "decision must be 'allow' or 'deny'");
  }
  // Host feedback (e.g. a plan rejection note) is relayed to the model as the
  // decision reason so it can revise. Bounded to keep the hook payload small.
  const feedback = typeof body.feedback === "string" && body.feedback.trim()
    ? body.feedback.slice(0, 4096)
    : null;
  // scope:"always" → grant the driving peer session-scoped auto-approve. The
  // critical set is still excluded from auto-approve at request-creation time, so
  // the host keeps those guardrails even after granting trust.
  //
  // HOST ONLY, and the flag is ignored rather than refused for a peer: their
  // allow/deny stands, the standing grant does not. Trust is keyed on the share
  // that DROVE the turn, not on whoever answers, so a full peer answering their
  // own ask with scope:"always" was granting trust to themselves — which is not an
  // escalation (they could approve each ask by hand) but it does remove the host's
  // sight of their routine asks, one click, self-served. Deciding is shared;
  // deciding to stop being asked is not.
  const trustPeer = body.scope === "always" && body.decision === "allow" && !guard.isPeer;
  try {
    const result = await respondToPermission(params.id, body.requestId, body.decision, feedback, trustPeer, guard.author);
    if (!result.ok) {
      return err(res, 404, result.reason);
    }
    json(res, 200, { ok: true });
  } catch (e: any) {
    err(res, 500, e?.message ?? "permission response failed");
  }
});

// ---------- Shared plan-review comments (host + peers) ----------
// Collaborative inline comments on a plan review, keyed by the plan's requestId.
// Everyone in the session may add comments/replies (checkParticipant "turn"
// lets peers through); edit/remove are author-scoped in the store. The dashboard
// polls the GET while the review panel is open, so every peer sees them live.
add("GET", "/sessions/:id/plan-comments", (req, res, params, url) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  const requestId = url?.searchParams.get("requestId");
  if (!requestId) return err(res, 400, "missing requestId");
  // `you` lets the client show edit/remove only on the caller's own comments.
  json(res, 200, { comments: listPlanReviewComments(requestId), you: guard.author });
});

add("POST", "/sessions/:id/plan-comments", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: any;
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const requestId = typeof body.requestId === "string" ? body.requestId : null;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!requestId || !text) return err(res, 400, "missing requestId or body");
  const comment = addPlanReviewComment({
    requestId,
    author: guard.author,
    quote: typeof body.quote === "string" ? body.quote : "",
    offset: typeof body.offset === "number" ? body.offset : 0,
    length: typeof body.length === "number" ? body.length : 0,
    body: text,
  });
  json(res, 200, { comment });
});

add("POST", "/sessions/:id/plan-comments/reply", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: any;
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (typeof body.requestId !== "string" || typeof body.commentId !== "string" || !text) {
    return err(res, 400, "missing requestId, commentId or body");
  }
  const ok = addPlanReviewReply({ requestId: body.requestId, commentId: body.commentId, author: guard.author, body: text });
  if (!ok) return err(res, 404, "comment not found");
  json(res, 200, { ok: true });
});

// edit + remove are author-scoped (store returns "forbidden" for a non-author).
for (const action of ["edit", "remove"] as const) {
  add("POST", `/sessions/:id/plan-comments/${action}`, async (req, res, params) => {
    const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
    const guard = checkParticipant(req, canonicalId, "turn");
    if (!guard.ok) return err(res, guard.status, guard.reason);
    let body: any;
    try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
    if (typeof body.requestId !== "string" || typeof body.commentId !== "string") {
      return err(res, 400, "missing requestId or commentId");
    }
    const result = action === "edit"
      ? editPlanReviewComment(body.requestId, body.commentId, guard.author, typeof body.body === "string" ? body.body : "")
      : removePlanReviewComment(body.requestId, body.commentId, guard.author);
    if (result === "notfound") return err(res, 404, "comment not found");
    if (result === "forbidden") return err(res, 403, "only the comment's author can modify it");
    json(res, 200, { ok: true });
  });
}

add("GET", "/sessions/:id/model", (_req, res, params) => {
  // Show the VERSIONED id claude actually ran (e.g. "claude-opus-4-8") rather
  // than the bare `--model` alias the user typed (e.g. "opus"). We still fall
  // back to the alias when the transcript has no resolved id yet or the alias
  // just switched to a different family that hasn't run — see resolveDisplayModel.
  const active = getActiveSession(params.id);
  const configured = active?.model ?? null;
  // Two sources for the resolved id, in this order:
  //
  //   1. the transcript, which carries a per-MESSAGE model and so also catches a
  //      mid-session change (e.g. claude falling back to another model). Only
  //      readable where DAC is not enforced — see getSessionModel.
  //   2. lastStats.model — seeded at spawn with the model we handed claude on
  //      --model, then overwritten by the system/init frame this server parsed
  //      off claude's own stdout. Persisted in the checkpoint, so it is always
  //      available to us from the moment the child starts, at the cost of being
  //      per-SPAWN rather than per-message — a `/model` switch or a wake
  //      re-spawns, so it refreshes.
  //
  // Since the uid split (14a5cf5) 2 is the live path on Linux, and 1 is what
  // still serves a session this server never spawned (an external `claude` in
  // the sidebar has no slot, hence no lastStats).
  //
  // `configured` is NOT a third source: it is the user's intent and is null for
  // an unpinned session, which is exactly why 2 is seeded at spawn rather than
  // left for the init frame.
  const resolved = getSessionModel(params.id).model ?? active?.lastStats?.model ?? null;
  json(res, 200, { model: resolveDisplayModel(configured, resolved) });
});

// Switch the session's model (`/model <alias>`), effective immediately — the
// child is restarted on the new `--model`, aborting any in-flight turn. Any
// turn-capable participant may switch; spectate is rejected at the gate.
add("POST", "/sessions/:id/model", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  let body: { model?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const model = boundedString(body.model, 128);
  if (!model) return err(res, 400, "missing required field: model");
  // Same flag-injection guard as new-session: the CLI accepts arbitrary model
  // strings, so we only block the structural footgun.
  if (model.startsWith("-") || /\s/.test(model)) {
    return err(res, 400, "model must not start with '-' or contain whitespace");
  }
  try {
    const result = setSessionModel(params.id, model, guard.author);
    json(res, 200, { ok: true, ...result });
  } catch (e: any) {
    err(res, 500, e?.message ?? "model switch failed");
  }
});

// Toggle unattended auto-approval (auto mode), effective on the next tool ask —
// no child restart. Auto mode disables prompting for routine tools, so it needs
// "permission" capability: the host or a full-access peer, matching who may
// allow/deny a tool. drive/spectate peers are rejected.
add("POST", "/sessions/:id/auto-mode", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  if (guard.isPeer && !capabilityAllows(guard.capability ?? "spectate", "permission")) {
    return err(res, 403, "only the host or a full-access peer can change auto mode");
  }
  let body: { auto?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.auto !== "boolean") return err(res, 400, "missing required field: auto (boolean)");
  try {
    const result = setSessionAutoMode(params.id, body.auto, guard.author);
    json(res, 200, { ok: true, ...result });
  } catch (e: any) {
    err(res, 500, e?.message ?? "auto-mode toggle failed");
  }
});

// CANCEL burn-after-use. Deliberately one-way: burn is armed when the session
// is created (POST /sessions, host-only) and this route can only turn it off.
//
// Accepting `burn: true` here would have been a privilege hole. The capability
// check below is the auto-mode one, which admits a full-access PEER — fine for a
// reversible convenience toggle, wrong for arming self-destruction on someone
// else's session. A co-driver invited to pair on code could have set a session
// to delete its own transcript, workspace, events and shares on the next idle
// timeout, taking the audit trail of who armed it along with everything else.
// Every other destructive lifecycle action here (DELETE, /end) is host-only.
// So: cancelling keeps the auto-mode gate (host or full peer, drive/spectate
// rejected), and arming is not reachable from this route at all.
add("POST", "/sessions/:id/burn-after-use", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  if (guard.isPeer && !capabilityAllows(guard.capability ?? "spectate", "permission")) {
    return err(res, 403, "only the host or a full-access peer can change burn-after-use");
  }
  let body: { burn?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.burn !== "boolean") return err(res, 400, "missing required field: burn (boolean)");
  if (body.burn) {
    return err(res, 400, "burn-after-use can only be armed when the session is created");
  }
  try {
    const result = setSessionBurnAfterUse(params.id, body.burn, guard.author);
    json(res, 200, { ok: true, ...result });
  } catch (e: any) {
    err(res, 500, e?.message ?? "burn-after-use toggle failed");
  }
});

// ---------- Live previews ----------

//
// Reads are open to every participant in the session, INCLUDING spectate: a
// preview's existence, spec and logs are session content they can already read
// in the transcript, and the "notify" capability sets the same precedent (see
// pushCaller). Acting on one — stop/restart/rebuild/share — needs "permission",
// matching who may approve a tool or a plan.
//
// Sharing itself is not here: the dashboard owns cloudflared, so it starts the
// tunnel and then POSTs the resulting URL to /share below. Adding a
// sandbox→dashboard call would invert the one-way arrow the whole architecture
// rests on.

/** Resolve + capability-check a preview in one step. */
function previewGuard(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  previewId: string,
  action: "view" | "act",
): { preview: NonNullable<ReturnType<typeof getPreview>>; author: string } | null {
  const canonicalId = getActiveSession(sessionId)?.sessionId ?? sessionId;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) {
    // A spectate share fails the "turn" gate, but viewing a preview is a read.
    // Fall back to the same liveness+scope check the push routes use.
    const who = pushCaller(req);
    if (action !== "view" || !who.ok) {
      err(res, guard.status, guard.reason);
      return null;
    }
    if (who.ownerKind === "peer") {
      const peerCanonical = getActiveSession(who.sessionId)?.sessionId ?? who.sessionId;
      if (peerCanonical !== canonicalId) { err(res, 403, "out of session scope"); return null; }
    }
    const found = getPreview(previewId);
    if (!found || found.sessionId !== canonicalId) { err(res, 404, "unknown preview"); return null; }
    return { preview: found, author: who.displayName ?? "peer" };
  }
  if (action === "act" && guard.isPeer && !capabilityAllows(guard.capability ?? "spectate", "permission")) {
    err(res, 403, "your share can view this preview, but only the host or a full-access peer can stop, restart, rebuild or share it");
    return null;
  }
  const found = getPreview(previewId);
  if (!found || found.sessionId !== canonicalId) { err(res, 404, "unknown preview"); return null; }
  return { preview: found, author: guard.author };
}

add("GET", "/sessions/:id/previews", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) {
    // Same spectate carve-out as previewGuard: reading the preview list is a
    // read, and a spectator can already see the transcript that announced it.
    const who = pushCaller(req);
    if (!who.ok) return err(res, guard.status, guard.reason);
    if (who.ownerKind === "peer") {
      const peerCanonical = getActiveSession(who.sessionId)?.sessionId ?? who.sessionId;
      if (peerCanonical !== canonicalId) return err(res, 403, "out of session scope");
    }
  }
  await refreshAll();
  const ids = new Set(expandSessionIds(params.id));
  const meta = getActiveSession(params.id);
  json(res, 200, {
    available: previewsAvailable(),
    slots: { total: PREVIEW_SLOT_COUNT, used: listPreviews().length },
    previews: listPreviews().filter((p) => ids.has(p.sessionId)),
    // What this session last ran, so the panel can prefill a restart instead of
    // making the human retype it — and why it stopped, so it only claims "we
    // stopped this for you" when that is actually true. Rides on the response the
    // panel already polls rather than needing a channel of its own.
    lastSpec: meta?.lastPreviewSpec ?? null,
    lastStoppedReason: meta?.lastPreviewStoppedReason ?? null,
  });
});

/**
 * Start a preview for this session, from the DASHBOARD.
 *
 * Until now a preview could only be created by the model calling start_preview,
 * routed through the permission gate — so the operator could watch a preview but
 * never begin one without asking the agent to do it for them. This is the same
 * `startPreview` the gate calls, with the same spec validation; the difference is
 * only who asked.
 *
 * Gated like the other preview ACTIONS (restart/rebuild/stop/share) rather than
 * like a read: the "turn" capability, so the host and a full peer may start one
 * and a spectate share may not. Starting a container that runs arbitrary
 * commands from the workspace is not a viewing operation.
 */
add("POST", "/sessions/:id/previews", async (req, res, params) => {
  const canonicalId = getActiveSession(params.id)?.sessionId ?? params.id;
  const guard = checkParticipant(req, canonicalId, "turn");
  if (!guard.ok) return err(res, guard.status, guard.reason);

  const session = getActiveSession(params.id);
  if (!session) return err(res, 404, "unknown session");

  let body: unknown;
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const parsed = validatePreviewSpec(body);
  if (!parsed.ok) return err(res, 400, parsed.reason);

  try {
    const rec = await startPreview({
      sessionId: canonicalId,
      sessionIds: expandSessionIds(params.id),
      cwd: session.cwd,
      spec: parsed.spec,
    });
    // Remember it for a later one-click restart, and clear any idle note.
    rememberPreviewSpec(canonicalId, parsed.spec, null);
    // Starting an app IS activity on this session, and the idle sweeps run off
    // `lastSeenAt`. Without this, starting a preview on a session whose last turn
    // was hours ago hands it straight back to the sweeper — observed live: the
    // preview was released within a minute of being created.
    markSessionActive(canonicalId);
    // The record is returned immediately in "starting"; the dashboard follows
    // the rest over the event stream exactly as it does for an agent-started
    // preview, so there is nothing to wait for here.
    emitPreviewEvent("PreviewStarted", rec, guard.author);
    json(res, 200, { ok: true, preview: rec });
  } catch (e: any) {
    return err(res, e?.status ?? 500, e?.message ?? "could not start the preview");
  }
});

/**
 * Every preview, across sessions. Host-only.
 *
 * This exists for the dashboard's FRONT process, which serves preview traffic
 * on the published slot ports and therefore has to answer "which preview is on
 * slot 2 right now, and which session and share back it?" before it can
 * authorize a request. It is not a peer-facing route — a peer reads its own
 * session's previews through /sessions/:id/previews.
 */
add("GET", "/previews", async (req, res) => {
  if (!requireHost(req, res)) return;
  await refreshAll();
  json(res, 200, {
    available: previewsAvailable(),
    slots: { total: PREVIEW_SLOT_COUNT, used: listPreviews().length },
    previews: listPreviews(),
  });
});

/**
 * The dashboard collecting the next page action the model asked for. Host-only.
 *
 * A long poll, not a timer: a click should land as fast as a person could make
 * it, and the alternative — polling every few hundred ms forever — spends CPU on
 * the overwhelmingly common case of nobody driving anything.
 *
 * The direction matters more than the mechanism. The sandbox never calls the
 * dashboard (see the header of lib/preview-drive.ts); this is the dashboard
 * asking, exactly as auto-share does, so the arrow still only points one way.
 */
add("GET", "/previews/drive-next", async (req, res, _params, url) => {
  if (!requireHost(req, res)) return;
  const asked = parseInt(url.searchParams.get("waitMs") ?? "", 10);
  // Bounded well under any proxy or socket idle timeout: an empty answer costs
  // one round trip, a hung request costs the feature.
  const waitMs = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), 30_000) : 25_000;
  json(res, 200, { action: await driveQueue.take(waitMs) });
});

/**
 * The dashboard reporting what the watching pages did. Host-only.
 *
 * An unknown id is not an error: the model's call may already have been settled
 * by its own deadline, and a 4xx here would make the dashboard's relay loop look
 * broken when it is behaving correctly.
 */
add("POST", "/previews/drive-result", async (req, res) => {
  if (!requireHost(req, res)) return;
  let body: { id?: unknown; result?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return err(res, 400, "id is required");
  const result = (body.result && typeof body.result === "object" ? body.result : { ok: false, error: "no result" }) as DriveResult;
  driveQueue.settle(id, result);
  json(res, 200, { ok: true });
});

add("GET", "/sessions/:id/previews/:pid/logs", async (req, res, params, url) => {
  const g = previewGuard(req, res, params.id, params.pid, "view");
  if (!g) return;
  const stepParam = url.searchParams.get("step");
  const step = stepParam === null ? undefined : parseInt(stepParam, 10);
  if (step !== undefined && !Number.isFinite(step)) return err(res, 400, "step must be an integer");
  try {
    json(res, 200, { logs: await previewLogs(params.pid, step) });
  } catch (e: any) {
    err(res, e instanceof PreviewError ? e.status : 500, e?.message ?? "could not read preview logs");
  }
});

for (const action of ["stop", "restart", "rebuild"] as const) {
  add("POST", `/sessions/:id/previews/:pid/${action}`, async (req, res, params) => {
    const g = previewGuard(req, res, params.id, params.pid, "act");
    if (!g) return;
    try {
      if (action === "stop") {
        await stopPreview(params.pid);
        // Keep the spec for a prefilled restart, but clear the idle note — this
        // stop was somebody's decision, not the sweeper's.
        rememberPreviewSpec(params.id, g.preview.spec, null);
        emitPreviewEvent("PreviewStopped", g.preview, g.author);
        return json(res, 200, { ok: true });
      }
      const rec = action === "restart" ? await restartPreview(params.pid) : await rebuildPreview(params.pid);
      // Same reasoning as start: somebody just acted on this session's app, so the
      // idle clock should not be measuring from whenever the last turn happened.
      markSessionActive(params.id);
      if (action === "rebuild") emitPreviewEvent("PreviewRebuilt", rec, g.author);
      json(res, 200, { ok: true, preview: rec });
    } catch (e: any) {
      err(res, e instanceof PreviewError ? e.status : 500, e?.message ?? `preview ${action} failed`);
    }
  });
}

/**
 * Record the tunnel URL the dashboard just produced (or null to un-share).
 *
 * Host or full peer only — this is the action that takes a preview from
 * host-local to reachable by everyone in the session.
 */
add("POST", "/sessions/:id/previews/:pid/share", async (req, res, params) => {
  const g = previewGuard(req, res, params.id, params.pid, "act");
  if (!g) return;
  let body: { url?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const url = body.url == null ? null : boundedString(body.url, 2048);
  if (body.url != null && (!url || !/^https:\/\//i.test(url))) {
    return err(res, 400, "url must be an https URL, or null to stop sharing");
  }
  try {
    const rec = await setPreviewShared(params.pid, url);
    emitPreviewEvent(url ? "PreviewShared" : "PreviewStopped", rec, g.author);
    json(res, 200, { ok: true, preview: rec });
  } catch (e: any) {
    err(res, e instanceof PreviewError ? e.status : 500, e?.message ?? "share failed");
  }
});

add("GET", "/sessions/:id/summary", (_req, res, params) => {
  // Returns claude-mem's structured summary for the session, or null when
  // claude-mem hasn't indexed it yet (new session) or isn't installed.
  // The dashboard sidebar dropdown renders this in place of the raw
  // event tail; structured fields read better than a stream of hook rows.
  json(res, 200, { summary: getSessionSummary(params.id) });
});

add("GET", "/files", async (_req, res, _params, url) => {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) return err(res, 400, "missing required query param: cwd");
  const q = url.searchParams.get("q") ?? undefined;
  const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 100, fallback: 20 });
  try {
    const entries = await listFiles({ cwd, q, limit });
    json(res, 200, { entries });
  } catch (e: any) {
    if (e instanceof CwdPolicyError) return err(res, 400, e.message);
    err(res, 500, e?.message ?? "files lookup failed");
  }
});

// Git-decorated recursive file tree for the dashboard's Files navigator. Scoped
// to the session cwd; the sandbox applies the same cwd policy as /files.
//
// Optional `path` (cwd-relative): fetches the on-demand subtree for a
// `lazy: true` node the top-level tree deliberately left unwalked (a
// DENYLIST'd or git-collapsed directory — see git.ts's `buildFileSubtree`)
// instead of the whole-cwd tree. Optional `max` (only meaningful with
// `path`) lowers that response's node budget to what the caller still has
// room for, since the cap is otherwise per-response and a navigator
// accumulates one per expanded directory.
add("GET", "/files/tree", async (_req, res, _params, url) => {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) return err(res, 400, "missing required query param: cwd");
  const path = url.searchParams.get("path");
  const max = clampInt(url.searchParams.get("max"), {
    min: 1,
    max: TREE_MAX_TOTAL_NODES,
    fallback: TREE_MAX_TOTAL_NODES,
  });
  try {
    json(res, 200, path ? await buildFileSubtree(cwd, path, max) : await buildFileTree(cwd));
  } catch (e: any) {
    if (e instanceof CwdPolicyError) return err(res, 400, e.message);
    err(res, 500, e?.message ?? "file tree build failed");
  }
});

// Single-file preview: git status + parsed diff (or an all-adds diff for new
// files) + capped/binary-guarded content. `path` is relative to `cwd`.
add("GET", "/files/preview", async (_req, res, _params, url) => {
  const cwd = url.searchParams.get("cwd");
  const path = url.searchParams.get("path");
  if (!cwd) return err(res, 400, "missing required query param: cwd");
  if (!path) return err(res, 400, "missing required query param: path");
  try {
    json(res, 200, await buildFilePreview(cwd, path));
  } catch (e: any) {
    if (e instanceof CwdPolicyError) return err(res, 400, e.message);
    err(res, 500, e?.message ?? "file preview failed");
  }
});

// Whole-image bytes for the preview dock, base64'd for the socket hop (the
// dashboard's client decodes every body as UTF-8, so raw bytes would corrupt).
// Deliberately NOT folded into /files/preview: that payload is refetched on
// every write under the cwd, and an image riding along would undo the work in
// 9bd0ae5. The dashboard serves this at a URL keyed by mtime so the browser
// caches it and an unrelated write costs nothing.
add("GET", "/files/raw", async (_req, res, _params, url) => {
  const cwd = url.searchParams.get("cwd");
  const path = url.searchParams.get("path");
  if (!cwd) return err(res, 400, "missing required query param: cwd");
  if (!path) return err(res, 400, "missing required query param: path");
  try {
    json(res, 200, await readImageWithinCwd({ cwd, path }));
  } catch (e: any) {
    // CwdPolicyError covers escape, not-an-image and over-cap alike — all of
    // them are "the client asked for something it may not render", not a fault.
    if (e instanceof CwdPolicyError) return err(res, 400, e.message);
    err(res, 500, e?.message ?? "file raw read failed");
  }
});

add("GET", "/events", (_req, res, _params, url) => {
  const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 1000, fallback: 200 });
  const beforeStr = url.searchParams.get("before");
  const before = beforeStr ? parseInt(beforeStr, 10) : undefined;
  const hook = url.searchParams.get("hook") ?? undefined;
  const tool = url.searchParams.get("tool") ?? undefined;
  const session = url.searchParams.get("session") ?? undefined;
  json(res, 200, listEvents({ limit, before, hook, tool, session }));
});

// /events/stream is a static path. The router scans in registration order
// and a /events/:id route would otherwise eat it, so this MUST be declared
// before the :id route below.
const MAX_SSE_CLIENTS = parseInt(process.env.HOOOP_MAX_SSE_CLIENTS ?? "", 10) || 50;
let sseClientCount = 0;

add("GET", "/events/stream", async (_req, res) => {
  if (sseClientCount >= MAX_SSE_CLIENTS) {
    res.setHeader("Retry-After", "10");
    return err(res, 503, "max sse clients");
  }
  sseClientCount += 1;
  startSessionsWatcher();
  startSkillsWatcher();
  startFileWatcher();
  startIngestor();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* connection closed */ }
  };

  res.write(`retry: 5000\n\n`);
  res.write(`: hooop sandbox event stream open\n\n`);

  const onEvent = (e: unknown) => send("event", e);
  const onSessions = () => send("sessions", { changed: true });
  const onSkills = () => send("skills", { changed: true });
  const onFiles = (p: unknown) => send("files", p);
  const onActiveChange = (p: unknown) => { send("sessions", { changed: true }); send("session-status", p); };
  const onActiveError = (p: unknown) => send("session-error", p);
  // Result-frame "turn" events update slot.meta.lastStats.totals
  // (cumulative tokens) but don't write to the session-watcher's
  // directory, so sessionsBus never sees them. Without this bridge the
  // dashboard's StatsStrip would never refresh after a completed turn.
  const onActiveTurn = () => send("sessions", { changed: true });

  eventBus.on("event", onEvent);
  sessionsBus.on("change", onSessions);
  skillsBus.on("change", onSkills);
  filesBus.on("change", onFiles);
  activeSessionsBus.on("change", onActiveChange);
  activeSessionsBus.on("error", onActiveError);
  activeSessionsBus.on("turn", onActiveTurn);

  const hb = setInterval(() => {
    try { res.write(`: heartbeat\n\n`); } catch { /* closed */ }
  }, 20_000);

  const cleanup = () => {
    eventBus.off("event", onEvent);
    sessionsBus.off("change", onSessions);
    skillsBus.off("change", onSkills);
    filesBus.off("change", onFiles);
    activeSessionsBus.off("change", onActiveChange);
    activeSessionsBus.off("error", onActiveError);
    activeSessionsBus.off("turn", onActiveTurn);
    clearInterval(hb);
    sseClientCount = Math.max(0, sseClientCount - 1);
  };
  res.on("close", cleanup);
});

add("GET", "/events/:id", (_req, res, params, url) => {
  const id = parseInt(params.id, 10);
  if (!Number.isFinite(id)) return err(res, 400, "invalid id");
  const row = getEvent(id);
  if (!row) return err(res, 404, "not found");
  // Optional session scope (the dashboard sends it for a peer): the event must
  // belong to the caller's session (alias-expanded), else it's treated as
  // absent — a peer must not read event bodies from other sessions. 404 (not
  // 403) so scope stays opaque and can't be used to probe event ids.
  const scope = url.searchParams.get("session");
  if (scope) {
    const allowed = new Set(expandSessionIds(scope));
    if (!row.session_id || !allowed.has(row.session_id)) return err(res, 404, "not found");
  }
  json(res, 200, row);
});

// Hook-driven permission gate.
//
// Flow: PreToolUse hook (`permission-gate.sh`) inside the sandbox container
// POSTs the hook context here, gets a requestId, then long-polls
// /permission-wait until the dashboard responds via the existing
// /sessions/:id/permission endpoint. The dashboard never talks to these two
// routes — they're hook-only (X-Hook-Token).
add("POST", "/permission-ask", async (req, res) => {
  let body: any;
  try { body = await readJson(req, MAX_BYTES_INGEST); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (!body || typeof body !== "object") return err(res, 400, "body must be JSON");
  const sessionId = typeof body.session_id === "string" ? body.session_id : null;
  const toolName = typeof body.tool_name === "string" ? body.tool_name : null;
  if (!sessionId || !toolName) return err(res, 400, "missing session_id or tool_name");
  const toolUseId = typeof body.tool_use_id === "string" ? body.tool_use_id : null;
  const { requestId } = createPermissionRequest({
    sessionId,
    toolName,
    input: body.tool_input ?? body.input ?? null,
    toolUseId,
    requestId: toolUseId, // use claude's tool_use_id as our stable key
  });
  // Answer inline when the policy already decided (a read inside the workdir, a
  // non-critical Bash, a plan-mode deny) so the hook can skip its
  // /permission-wait long-poll entirely. That halves the round trips on every
  // no-card decision, which is what pays for routing Read/Glob/Grep through the
  // sandbox instead of fast-allowing them in the hook. A request that genuinely
  // needs a human has no decision yet and falls through to the long-poll.
  const decided = peekPermissionDecision(requestId);
  json(res, 200, decided ? { requestId, ...decided } : { requestId });
}, "hook");

add("GET", "/permission-wait", async (req, res, _params, url) => {
  const requestId = url.searchParams.get("requestId");
  if (!requestId) return err(res, 400, "missing requestId");
  const rawTimeout = url.searchParams.get("timeout");
  const seconds = rawTimeout ? parseInt(rawTimeout, 10) : 30;
  const timeoutMs = (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : 30) * 1000;

  // Track client disconnects so we don't try to write a JSON response to a
  // closed socket. Curl in the hook script enforces a slightly-longer
  // max-time than our timeoutMs; if claude kills the hook for any reason
  // the socket closes mid-wait and Node would otherwise throw on res.end().
  let aborted = false;
  req.on("close", () => { aborted = true; });

  const result = await awaitPermissionDecision(requestId, timeoutMs);
  if (aborted || res.writableEnded) return;
  try { json(res, 200, result); } catch { /* socket closed between check and write */ }
}, "hook");

add("POST", "/ingest", async (req, res) => {
  startIngestor();
  const rid = reqId(req);
  let text: string;
  try { text = await readBody(req, MAX_BYTES_INGEST); } catch (e: any) { return err(res, e.status ?? 400, e.message, rid); }
  const trimmed = text.trim();
  if (!trimmed) return err(res, 400, "empty body", rid);
  let event: any;
  try { event = JSON.parse(trimmed); } catch { return err(res, 400, "invalid JSON body", rid); }
  if (!event || typeof event !== "object") return err(res, 400, "event must be a JSON object", rid);
  if (typeof event.hook !== "string" || !ALLOWED_HOOKS.has(event.hook)) {
    return err(res, 400, "unknown or missing hook name", rid);
  }
  // Attribution: stamp the sender on UserPromptSubmit so a shared session's
  // transcript can show "who sent this". The author was queued by
  // writeUserTurn (in stdin order); pop it here. Empty queue → null (a
  // replayed/compaction prompt or a turn not from the dashboard).
  let line = trimmed;
  if (event.hook === "UserPromptSubmit" && event.ctx && typeof event.ctx.session_id === "string") {
    // A background Task/Agent tool call's real result, injected directly by
    // the Claude Code harness as a `<task-notification>` block once the async
    // sub-agent finishes (see TASK_NOTIFICATION_KIND). It never goes through
    // writeUserTurn, so detect it from the raw, harness-authored prompt
    // content BEFORE touching the pendingAuthors queue at all — checking only
    // AFTER an unconditional pop is racy: writeUserTurn pushes to the queue
    // synchronously but the stdin write it queues can still be in flight when
    // this event's hook fires, and this event's own delivery is timed by the
    // CLI's own async-task scheduler, entirely independent of hooop. A
    // notification landing in that window would otherwise steal the author
    // queued for a still-pending real turn — corrupting attribution for every
    // turn after it, not just this one. Detecting up front and skipping the
    // pop entirely for a notification leaves that queue untouched for
    // whichever real turn is actually next in line.
    const isTaskNotification =
      event.ctx.author == null &&
      typeof event.ctx.prompt === "string" &&
      event.ctx.prompt.startsWith("<task-notification>");
    if (isTaskNotification) {
      event.ctx.kind = TASK_NOTIFICATION_KIND;
      line = JSON.stringify(event);
    } else if (event.ctx.author == null) {
      const { author, thumbnails, kind, promptOverride } = popPendingAuthor(event.ctx.session_id);
      if (author != null) event.ctx.author = author;
      // Persist ≤512 image thumbnails onto the turn's event so the transcript
      // (host + peers) can show what was attached. Kept small on purpose — the
      // full image goes only to the model, never into the broadcast event.
      if (thumbnails && thumbnails.length) event.ctx.images = thumbnails;
      // A lifecycle marker (e.g. "plan-approval", "command") queued by
      // writeUserTurn, so the transcript can re-style this turn rather than show
      // it as plain chat.
      if (kind != null) event.ctx.kind = kind;
      // Restore the original typed command text (e.g. "/plan add caching"). The
      // sandbox forwards a `/plan` turn's stripped task to the model, so claude
      // records the prompt WITHOUT the "/plan" prefix; overriding it here keeps
      // the transcript honest and lets the optimistic row reconcile (no dupe).
      if (promptOverride != null) event.ctx.prompt = promptOverride;
      if (author != null || (thumbnails && thumbnails.length) || kind != null || promptOverride != null) {
        line = JSON.stringify(event);
      }
    }
  }
  // Turn over → drop the "model is thinking" flag so every viewer's indicator
  // clears (late joiners read it off the session row). Stop is claude's
  // authoritative end-of-turn signal; SubagentStop is a nested agent finishing,
  // NOT the turn, so it must not clear.
  if (event.hook === "Stop" && event.ctx && typeof event.ctx.session_id === "string") {
    markTurnFinished(event.ctx.session_id);
  }
  const result = ingestEventLine(line);
  if (!result.ok) {
    return err(res, 500, result.reason, rid);
  }
  json(res, 200, { ok: true, ...(result.id !== undefined ? { id: result.id } : {}) });
}, "hook");

add("GET", "/skills", (_req, res, _params, url) => {
  startSkillsWatcher();
  const cwd = url.searchParams.get("cwd");
  json(res, 200, listSkills(cwd));
});
add("GET", "/commands", (_req, res, _params, url) => {
  const cwd = url.searchParams.get("cwd");
  json(res, 200, listSlashCommands(cwd));
});
add("GET", "/mcps", (_req, res) => json(res, 200, listMcps()));
add("GET", "/stack", (_req, res) => json(res, 200, getStack()));
add("GET", "/identity", (_req, res) => json(res, 200, getIdentity()));

// ── Session sharing (peer co-drive) ─────────────────────────────────────────
// The sandbox owns share grants (durable + authoritative). The dashboard
// proxies these routes; create/list/revoke are gated per-request via
// checkParticipant — host manages any session, a full-capability peer manages
// only their own (mint/list/revoke co-guest links), drive/spectate cannot. The
// gate is re-checked HERE (not just in the dashboard) so a compromised or buggy
// dashboard can't forge a peer past capability + session scope.
const VALID_CAPABILITIES = new Set<ShareCapability>(["full", "drive", "spectate"]);

add("POST", "/shares", async (req, res) => {
  let body: {
    sessionId?: unknown;
    publicHost?: unknown;
    capability?: unknown;
    expiresInMs?: unknown;
    peerName?: unknown;
  };
  try { body = await readJson(req, MAX_BYTES_MESSAGE); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
    return err(res, 400, "missing required field: sessionId");
  }
  if (typeof body.publicHost !== "string" || body.publicHost.trim().length === 0) {
    return err(res, 400, "missing required field: publicHost");
  }
  // Host mints for any session; a full-capability peer may mint links only for
  // the session they're in (same "admit"/manage gate). drive/spectate and
  // out-of-scope peers are rejected HERE — the authoritative check — so a
  // compromised dashboard can't forge a peer into minting. Checked before the
  // session-existence probe so a non-scoped peer can't enumerate sessions.
  const guard = checkParticipant(req, body.sessionId, "admit");
  if (!guard.ok) return err(res, guard.status, guard.reason);

  // The session must exist (and be controllable) to be shareable.
  const meta = getActiveSession(body.sessionId);
  if (!meta) return err(res, 404, "unknown session");
  if (meta.status === "expired") return err(res, 409, "session expired");

  let capability: ShareCapability = "full";
  if (body.capability !== undefined) {
    if (typeof body.capability !== "string" || !VALID_CAPABILITIES.has(body.capability as ShareCapability)) {
      return err(res, 400, "invalid capability");
    }
    capability = body.capability as ShareCapability;
  }
  let expiresInMs: number | null = null;
  if (body.expiresInMs !== undefined && body.expiresInMs !== null) {
    if (typeof body.expiresInMs !== "number" || !Number.isFinite(body.expiresInMs) || body.expiresInMs <= 0) {
      return err(res, 400, "invalid expiresInMs");
    }
    expiresInMs = body.expiresInMs;
  }
  const peerName = typeof body.peerName === "string" && body.peerName.trim().length > 0
    ? body.peerName.trim().slice(0, 80)
    : null;

  const record = createShare({
    sessionId: meta.sessionId,
    publicHost: body.publicHost,
    capability,
    expiresInMs,
    peerName,
  });
  // Handing somebody a way in should leave them something to walk into. A
  // dormant session used to stay dormant until the next turn, so a guest could
  // redeem the link, be admitted, and land in a session with no agent running —
  // looking, from their side, like a broken invitation.
  //
  // Fire-and-forget rather than awaited: reviving spawns a child, and the host is
  // waiting on a QR code, not on a process. It only has to be awake by the time
  // somebody actually opens the link, which is seconds away at best.
  wakeIfDormant(meta.sessionId, "share created");
  // The sandbox stores only grant metadata; the DASHBOARD signs the peer
  // token (it holds the HMAC secret). Return the record so the dashboard can
  // sign {shareId, sessionId, capability, host, exp}.
  json(res, 200, record);
});

add("POST", "/shares/:id/revoke", (req, res, params) => {
  // Host may revoke any share; a full peer may revoke shares only within the
  // session they're in (same "admit" capability gate). Resolve the TARGET
  // share's session first, then scope the caller against it — so a full peer can
  // eject another guest from their own session but never touch another session's
  // shares. drive/spectate and out-of-scope peers are rejected here.
  const target = getShare(params.id);
  if (!target) return err(res, 404, "unknown share");
  const guard = checkParticipant(req, target.sessionId, "admit");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  const result = revokeShare(params.id);
  if (!result.ok) return err(res, 404, "unknown share");
  dropJoinsForShare(params.id); // kill any pending/admitted joins on this share
  json(res, 200, { ok: true });
});

// Bulk revoke — clears EVERY share (and its joins) at once. The front process
// calls this when the tunnel goes down or stops (the tunnel host every share is
// bound to is gone, so the grants are dangling), and the shutdown drainer calls
// revokeAllShares() directly. Idempotent.
add("POST", "/shares/revoke-all", (_req, res) => {
  const { revoked } = revokeAllShares();
  for (const id of revoked) dropJoinsForShare(id);
  // Enrolled host devices die with the tunnel too, and they matter MORE than the
  // shares do: a dangling share is a stale guest grant, a dangling device is
  // stale host authority. Same call site, no way to remember one and forget the
  // other.
  const { revoked: devicesRevoked } = revokeAllHostDevices();
  json(res, 200, { ok: true, revoked: revoked.length, devicesRevoked: devicesRevoked.length });
});

add("GET", "/shares", (req, res) => {
  // Host sees every share; a full peer sees only their own session's shares (so
  // they can manage/revoke co-guests). drive/spectate get nothing to act on.
  const all = listShares();
  const raw = getHeader(req, PARTICIPANT_HEADER);
  if (isHostParticipant(raw)) return json(res, 200, { shares: all });
  // Absent → 403, not "host". Listing every share (ids included) to a caller
  // that identified itself as nobody is the same default that made the
  // mutating routes forgeable; see checkParticipant.
  if (!raw || !raw.startsWith("peer:")) return err(res, 403, "invalid participant");
  const shareId = raw.slice("peer:".length);
  const v = validateShareById(shareId, {});
  if (!v.ok || !v.record) return err(res, 403, "share revoked or expired");
  if (!capabilityAllows(v.record.capability, "admit")) {
    return err(res, 403, "your share can view the session but can't manage peers");
  }
  const peerCanonical = getActiveSession(v.record.sessionId)?.sessionId ?? v.record.sessionId;
  const scoped = all.filter(
    (s) => (getActiveSession(s.sessionId)?.sessionId ?? s.sessionId) === peerCanonical,
  );
  json(res, 200, { shares: scoped });
});

// Redemption lookup: the dashboard's /api/share/redeem calls this to confirm a
// share exists for (shareId, host) before setting the peer cookie. Returns only
// non-secret material; the raw token is verified by the dashboard's node layer
// against the published validation file (hash compare), not here.
add("GET", "/shares/:id", (_req, res, params, url) => {
  const r = getShare(params.id);
  // Identical 404 for "no such share" and "host mismatch" — don't confirm
  // a share exists for a host the caller guessed.
  const host = url.searchParams.get("host");
  if (!r || (host && r.publicHost !== host.toLowerCase())) {
    return err(res, 404, "unknown share");
  }
  json(res, 200, {
    shareId: r.shareId,
    sessionId: r.sessionId,
    capability: r.capability,
    publicHost: r.publicHost,
    peerName: r.peerName,
    expiresAt: r.expiresAt,
  });
});

// ── Host devices (the host's own second screen) ───────────────────────────────
// The mirror image of the peer flow. A peer arrives holding a link and waits to
// be admitted; a device is enrolled BY the host, from the machine, and redeems a
// single-use code that proves the host was standing there. So there is no admit
// gate here — the code IS the admission — and what comes out the other side is
// the host, not a guest with a nicer name.

/** Mint a single-use enrollment code for the current tunnel host. Host-only.
 *
 * An already-enrolled device passes requireHost and can therefore enroll another
 * one. That is deliberate, not an oversight: the chosen model is "full host,
 * revocable per device", and a credential that can already run arbitrary code in
 * the sandbox gains nothing from being unable to mint a second cookie. Revoking
 * is the control, not enrollment. */
add("POST", "/host-devices/enroll-code", async (req, res) => {
  if (!requireHost(req, res)) return;
  let body: { publicHost?: unknown; label?: unknown; ttlMs?: unknown; sessionId?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const publicHost = boundedString(body.publicHost, 253);
  if (!publicHost) return err(res, 400, "missing required field: publicHost");
  // Optional, and only ever a wake hint: the dialog the host minted this from is
  // per-session, so adding a device to a dormant session should leave that session
  // running by the time the device arrives. It grants nothing — a device is
  // install-wide and is never scoped to a session.
  const sessionId = boundedString(body.sessionId, 200);
  const label = typeof body.label === "string" ? body.label : null;
  const ttlMs = typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs) ? body.ttlMs : null;
  // Canonicalise before storing: `claude --resume` swaps a session's id mid-life,
  // and the caller may be holding an alias.
  const canonicalSessionId = sessionId
    ? getActiveSession(sessionId)?.sessionId ?? sessionId
    : null;
  let minted;
  try {
    minted = createEnrollCode({ publicHost, label, ttlMs, sessionId: canonicalSessionId });
  } catch (e) {
    // The one enrollment failure worth spelling out: the caller is the
    // authenticated host, so "you are at the cap" is safe to say and is the only
    // thing that tells them what to do about it.
    if (e instanceof HostDeviceCapError) return err(res, 409, e.message);
    throw e;
  }
  const { code, expiresAt, deviceTtlMs } = minted;
  // The code is a bearer credential for host authority. It goes in the response
  // body (straight into the QR the host is looking at) and NOWHERE else — not
  // the log line, not the event stream.
  log.info("host-devices", "enrollment code minted", { publicHost, expiresAt });
  if (sessionId) wakeIfDormant(sessionId, "device enrolling");
  json(res, 200, { code, expiresAt, deviceTtlMs });
});

/** Redeem a code into a device grant. Reachable WITHOUT host auth by
 * construction: the phone doing the redeeming has no credential yet, which is
 * the entire problem being solved. The code plus the host binding is the proof.
 * The dashboard route in front of this one is the rate limiter. */
add("POST", "/host-devices/redeem", async (req, res) => {
  let body: { code?: unknown; publicHost?: unknown; label?: unknown; supersede?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.code !== "string") return err(res, 400, "missing required field: code");
  // A device this browser is REPLACING. The dashboard reads it from the old
  // device cookie and verifies that signature first, so it cannot name somebody
  // else's grant; and it is only acted on after a successful redeem, which needs a
  // live single-use code that only the host can mint. Anyone able to reach this
  // line could already enrol a device with full host authority, so retiring one is
  // not an escalation — it stops one browser from occupying two slots and walking
  // the host into "revoke one first" about a phone they added once.
  const supersede = boundedString(body.supersede, 200);
  const publicHost = boundedString(body.publicHost, 253);
  if (!publicHost) return err(res, 400, "missing required field: publicHost");
  const label = typeof body.label === "string" ? body.label : null;
  const result = redeemEnrollCode(body.code, publicHost, label);
  if (!result.ok) return err(res, 403, result.reason);
  if (supersede && supersede !== result.device.deviceId) {
    const dropped = revokeHostDevice(supersede);
    if (dropped.ok) {
      log.info("host-devices", "superseded the browser's previous device", { supersede });
    }
  }
  // Where the device should LAND.
  //
  // Re-resolved rather than trusted from mint time, because a resume inside the
  // code's two-minute life swaps the canonical id, and sending the device to the
  // old one drops it on the session list.
  //
  // Falling back to what we stored, though, NOT to null, when the registry has
  // never heard of it. getActiveSession only knows the sessions this sandbox is
  // DRIVING, and the dashboard's list is broader: a session started from the CLI,
  // or restored from a checkpoint this registry no longer holds, shows in the rail
  // and opens perfectly well while having no slot here. Gating on the registry
  // handed those back null and landed the device on the "Start a session" form —
  // the exact complaint this field exists to fix, still reproducing for the
  // sessions most likely to be open when somebody reaches for their phone.
  const landOn = result.sessionId
    ? getActiveSession(result.sessionId)?.sessionId ?? result.sessionId
    : null;
  // Audit trail: enrolling a device is a grant of host authority, so it leaves a
  // marker in the transcript stream the same way admitting a peer does. No
  // session id — this is install-wide, not per-session.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "HostDeviceEnrolled",
      ctx: { device_id: result.device.deviceId, label: result.device.label, message: `Host device "${result.device.label}" was enrolled` },
    }));
  } catch { /* non-fatal */ }
  json(res, 200, {
    deviceId: result.device.deviceId,
    label: result.device.label,
    publicHost: result.device.publicHost,
    expiresAt: result.device.expiresAt,
    sessionId: landOn,
  });
});

/** The host's device list, for the revoke UI. Host-only. */
add("GET", "/host-devices", (req, res) => {
  if (!requireHost(req, res)) return;
  json(res, 200, { devices: listHostDevices() });
});

/** Liveness probe for one device: 200 while enrolled, 404 once revoked/expired.
 *
 * The exact counterpart of GET /shares/:id, and it exists for the same consumer:
 * the dashboard's front process, which holds the live WebSocket feeds and has no
 * participant identity of its own to present. It polls this so a revoked device's
 * event stream is cut within seconds rather than surviving on a signed token that
 * is still cryptographically valid.
 *
 * Returns metadata only, no secrets — there are none to return. */
add("GET", "/host-devices/:id", (_req, res, params) => {
  // validateHostDevice, not getHostDevice: this probe runs (every ~5s) only for
  // devices the front process is holding a LIVE FEED open for, which is the
  // truest "in use right now" signal there is. Stamping here means a device
  // sitting on the dashboard reads as seen even while it is only reading.
  const d = validateHostDevice(params.id).record ?? null;
  if (!d) return err(res, 404, "unknown device");
  json(res, 200, {
    deviceId: d.deviceId,
    label: d.label,
    publicHost: d.publicHost,
    expiresAt: d.expiresAt,
  });
});

/** Revoke one device. Host-only, and instant: the next request that device makes
 * fails isHostParticipant and it is a stranger again. */
add("POST", "/host-devices/:id/revoke", (req, res, params) => {
  if (!requireHost(req, res)) return;
  const result = revokeHostDevice(params.id);
  if (!result.ok) return err(res, 404, "unknown device");
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "HostDeviceRevoked",
      ctx: { device_id: params.id, message: "A host device was revoked" },
    }));
  } catch { /* non-fatal */ }
  json(res, 200, { ok: true });
});

// ── Host-admits-each-join gate ───────────────────────────────────────────────
// A redeemed link creates a PENDING ticket here; the peer waits until the host
// admits. The peer credential is only issued (dashboard-side) after a claim of
// an admitted ticket. Deny revokes the share. The sandbox is the authority.

/** Redemption creates a pending join ticket. Session + peerName are taken from
 * the sandbox's own share record (not trusted from the caller). */
add("POST", "/join-request", async (req, res) => {
  let body: { shareId?: unknown; name?: unknown; peerIp?: unknown; peerCountry?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.shareId !== "string" || body.shareId.length === 0) {
    return err(res, 400, "missing required field: shareId");
  }
  const share = getShare(body.shareId);
  if (!share) return err(res, 404, "unknown share");
  // The JOINING peer names themselves. Their chosen nickname becomes the
  // authoritative display name (attribution + admit prompt + presence),
  // falling back to any host-suggested default on the share. Persist it onto
  // the share so checkParticipant returns it for every peer-context call.
  const chosen = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : null;
  const peerName = chosen ?? share.peerName;
  if (chosen) setSharePeerName(share.shareId, chosen);
  // Best-effort joiner IP for the admit prompt (info only). The dashboard reads
  // it from the tunnel edge and pre-sanitizes; re-validate the shape here since
  // this is the trust boundary — reject anything that isn't a bare IP literal.
  const peerIp =
    typeof body.peerIp === "string" && body.peerIp.length <= 45 && /^[0-9a-f:.]+$/.test(body.peerIp)
      ? body.peerIp
      : null;
  // Two-letter country code (or "T1" for Tor); re-validated at this trust
  // boundary before it can reach the host's admit prompt.
  const peerCountry =
    typeof body.peerCountry === "string" && /^[A-Z0-9]{2}$/.test(body.peerCountry)
      ? body.peerCountry
      : null;
  const { ticketId, secret } = createJoinTicket({
    shareId: share.shareId,
    sessionId: share.sessionId,
    peerName,
    peerIp,
    peerCountry,
  });
  // A share that was already claimed once and is being redeemed again is a
  // RETURN (the peer closed the tab / left, then reopened the link) — surface
  // it as "rejoin" so the host's audit trail distinguishes it from a first join.
  const returning = share.joinedBefore;
  const verb = returning ? "rejoin" : "join";
  // Notify the host live (event stream → host dashboard) + leave an audit trail.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PeerJoinRequest",
      // `message` is what the dashboard transcript surfaces as the divider
      // label (deriveText → systemText), so name the peer there rather than
      // leaving a bare "[PeerJoinRequest]".
      ctx: { session_id: share.sessionId, peer_name: peerName, ticket_id: ticketId, rejoin: returning, message: `${peerName ?? "A guest"} asked to ${verb}` },
    }));
  } catch { /* non-fatal */ }
  json(res, 200, { ticketId, secret });
});

add("GET", "/join-status", (_req, res, _params, url) => {
  const ticketId = url.searchParams.get("ticket") ?? "";
  json(res, 200, { status: joinStatus(ticketId) });
});

add("POST", "/join-admit", async (req, res) => {
  let body: { ticketId?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.ticketId !== "string") return err(res, 400, "missing required field: ticketId");
  // Authoritative admit gate (independent of the dashboard's own check): the
  // host may admit any join; a peer may admit only into the session they're in
  // and only with a "full" share. We scope against the TICKET's session (peek
  // it without consuming), so a full peer can bring another guest into their
  // own session but never touch a join for a different one. drive/spectate and
  // out-of-scope peers are rejected here even if the dashboard route regresses.
  const pending = getJoinTicket(body.ticketId);
  if (!pending) return err(res, 404, "unknown or already-resolved join");
  const guard = checkParticipant(req, pending.sessionId, "admit");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  const r = admitJoin(body.ticketId);
  if (!r.ok) return err(res, 404, "unknown or already-resolved join");
  // "rejoined" iff this share was already claimed once before (flag set at
  // claim). Read here, before this cycle's own claim flips it, so the FIRST
  // admit reads false → "joined" and every later one reads true → "rejoined".
  const returning = !!(r.ticket && getShare(r.ticket.shareId)?.joinedBefore);
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PeerJoinResolved",
      // Keep hook_type "PeerJoinResolved" (not a new hook): the host's admission
      // toast refetches on any `PeerJoin*` event to clear the resolved ticket,
      // and the transcript renders it via the default divider — so only the
      // human-facing `message` changes for a rejoin.
      // decided_by records WHO admitted (the host, or a full-capability peer's
      // name) — so a peer-driven admission is attributable, not silently
      // credited to the host. guard.author is "host" for the host.
      ctx: { session_id: r.ticket!.sessionId, peer_name: r.ticket!.peerName, ticket_id: body.ticketId, decision: "admit", decided_by: guard.author, rejoin: returning, message: `${r.ticket!.peerName ?? "A guest"} ${returning ? "rejoined" : "joined"}` },
    }));
  } catch { /* non-fatal */ }
  json(res, 200, { ok: true });
});

add("POST", "/join-deny", async (req, res) => {
  let body: { ticketId?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.ticketId !== "string") return err(res, 400, "missing required field: ticketId");
  // Same gate as admit: host anywhere, or a "full" peer within their own
  // session. Scope against the ticket's session before it's consumed.
  const pending = getJoinTicket(body.ticketId);
  if (!pending) return err(res, 404, "unknown or already-resolved join");
  const guard = checkParticipant(req, pending.sessionId, "admit");
  if (!guard.ok) return err(res, guard.status, guard.reason);
  const r = denyJoin(body.ticketId);
  if (!r.ok) return err(res, 404, "unknown or already-resolved join");
  // Deny is treated as hostile: revoke the whole share and drop its tickets.
  if (r.shareId) {
    revokeShare(r.shareId);
    dropJoinsForShare(r.shareId);
  }
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PeerJoinResolved",
      ctx: { ticket_id: body.ticketId, decision: "deny", decided_by: guard.author, peer_name: r.peerName ?? null, message: `${r.peerName ?? "A guest"}'s join was declined` },
    }));
  } catch { /* non-fatal */ }
  json(res, 200, { ok: true });
});

/** Claim an admitted ticket (one-time). Requires the redeeming browser's
 * secret. Returns the grant so the dashboard can issue the peer cookie. */
add("POST", "/join-claim", async (req, res) => {
  let body: { ticketId?: unknown; secret?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.ticketId !== "string" || typeof body.secret !== "string") {
    return err(res, 400, "missing required fields");
  }
  const grant = claimJoin(body.ticketId, body.secret);
  if (!grant) return err(res, 403, "not admitted");
  // The peer actually entered: mark the share so a future redemption of this
  // same link is recognized as a rejoin (see /join-admit + /join-request).
  markShareJoined(grant.shareId);
  json(res, 200, grant);
});

/**
 * Record that a peer LEFT a shared session. Symmetric with the join markers:
 * emits a `PeerLeft` divider into the transcript (audit + live host notice).
 *
 * A `PeerLeft` has exactly ONE source: the explicit "Leave session" action in
 * the dashboard (there is no inactivity watchdog — a backgrounded/gone peer just
 * dims and silently drops from the roster). The peer is identified by `shareId`
 * (the trusted, dashboard-authenticated identity); the display name is sourced
 * from the authoritative share record so the marker always shows the peer's real
 * name (not a stale/default heartbeat label), falling back to the forwarded name.
 */
add("POST", "/peer-leave", async (req, res) => {
  let body: { sessionId?: unknown; name?: unknown; shareId?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
    return err(res, 400, "missing required field: sessionId");
  }
  const forwardedName = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : null;
  const shareId = typeof body.shareId === "string" && body.shareId ? body.shareId : null;

  // Prefer the authoritative share name; fall back to whatever the dashboard
  // forwarded (the share may already be gone, e.g. explicit leave revoked it).
  const name = (shareId ? getShare(shareId)?.peerName ?? null : null) ?? forwardedName;
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PeerLeft",
      // Not a `PeerJoin*` hook (it isn't a pending join, so the host's admission
      // toast must ignore it); renders as a plain divider via the default path.
      ctx: { session_id: body.sessionId, peer_name: name, message: `${name ?? "A guest"} left` },
    }));
  } catch { /* non-fatal */ }
  json(res, 200, { ok: true });
});

add("GET", "/pending-joins", (req, res) => {
  // Each pending join carries its share capability so the admission UI can show
  // it without a second host-only /shares call (which a full peer can't make).
  const withCap = listPendingJoins().map((j) => ({
    ...j,
    capability: getShare(j.shareId)?.capability ?? null,
  }));
  const raw = getHeader(req, PARTICIPANT_HEADER);
  // Only an explicit host sees every pending join. There is no "internal,
  // header-less call" — see requireHost.
  if (isHostParticipant(raw)) return json(res, 200, { joins: withCap });
  if (!raw || !raw.startsWith("peer:")) return err(res, 403, "invalid participant");
  // A peer may see pending joins only for the session they're in, and only with
  // a "full" share (drive/spectate can't admit, so they get nothing to act on).
  const shareId = raw.slice("peer:".length);
  const v = validateShareById(shareId, {});
  if (!v.ok || !v.record) return err(res, 403, "share revoked or expired");
  if (!capabilityAllows(v.record.capability, "admit")) {
    return err(res, 403, "your share can view the session but can't admit peers");
  }
  const peerCanonical = getActiveSession(v.record.sessionId)?.sessionId ?? v.record.sessionId;
  const scoped = withCap.filter(
    (j) => (getActiveSession(j.sessionId)?.sessionId ?? j.sessionId) === peerCanonical,
  );
  json(res, 200, { joins: scoped });
});

// ---------- Web push ----------

/**
 * Resolve the caller for push purposes. Deliberately NOT checkParticipant: that
 * gates on an action that mutates the session, and every one of its actions is
 * refused to a spectator. Registering for notifications is pure output about
 * content the participant may already read, so it is gated on the "notify"
 * capability, which every share holds. Session scope still comes from the share,
 * so a peer can only ever subscribe to their own session.
 */
type PushCaller =
  | { ok: true; ownerKind: "host"; shareId: null; sessionId: null; displayName: string; capability: null; deviceId: string | null }
  | { ok: true; ownerKind: "peer"; shareId: string; sessionId: string; displayName: string | null; capability: ShareCapability; deviceId: null }
  | { ok: false; status: number; reason: string };

function pushCaller(req: IncomingMessage): PushCaller {
  const raw = getHeader(req, PARTICIPANT_HEADER);
  // An enrolled device subscribes AS the host, not as a fifth kind of owner:
  // ownerKey is "host", so a notification muted on the laptop is muted on the
  // phone, and both get the same host-level delivery rules. That is the point of
  // the whole feature — one identity, several screens.
  if (isHostParticipant(raw)) {
    // WHICH screen, though, is recorded on the subscription — so revoking a phone
    // takes its notifications with it. It does not scope delivery; a device hears
    // about everything the host does.
    const deviceId = raw!.startsWith("host:") ? raw!.slice("host:".length) : null;
    return { ok: true, ownerKind: "host", shareId: null, sessionId: null, displayName: "host", capability: null, deviceId };
  }
  if (!raw || !raw.startsWith("peer:")) return { ok: false, status: 403, reason: "invalid participant" };
  const shareId = raw.slice("peer:".length);
  // Authoritative revocation check, same as every other peer-context route.
  const v = validateShareById(shareId, {});
  if (!v.ok || !v.record) return { ok: false, status: 403, reason: "share revoked or expired" };
  if (!capabilityAllows(v.record.capability, "notify")) {
    return { ok: false, status: 403, reason: "your share cannot receive notifications" };
  }
  return {
    ok: true,
    ownerKind: "peer",
    shareId,
    sessionId: v.record.sessionId,
    displayName: v.record.peerName,
    capability: v.record.capability,
    deviceId: null,
  };
}

// The public VAPID half, which a browser needs to mint a subscription. Not a
// secret by design (the private half never leaves the sandbox).
add("GET", "/push/key", (req, res) => {
  const who = pushCaller(req);
  if (!who.ok) return err(res, who.status, who.reason);
  json(res, 200, { publicKey: vapidPublicKey() });
});

add("POST", "/push/subscribe", async (req, res) => {
  const who = pushCaller(req);
  if (!who.ok) return err(res, who.status, who.reason);
  let body: { endpoint?: unknown; keys?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const endpoint = boundedString(body.endpoint, 2048);
  if (!endpoint || !/^https:\/\//i.test(endpoint)) return err(res, 400, "invalid endpoint");
  const keys = body.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  const p256dh = boundedString(keys?.p256dh, 256);
  const auth = boundedString(keys?.auth, 256);
  if (!p256dh || !auth) return err(res, 400, "missing subscription keys");
  try {
    const rec = addSubscription({
      ownerKind: who.ownerKind,
      shareId: who.shareId,
      sessionId: who.sessionId,
      displayName: who.displayName,
      capability: who.capability,
      deviceId: who.deviceId,
      endpoint,
      keys: { p256dh, auth },
    });
    json(res, 200, { ok: true, id: rec.id });
  } catch (e) {
    if (e instanceof PushOwnershipError) return err(res, 403, e.message);
    throw e;
  }
});

/**
 * Presence relay: "this participant is here and foregrounded on session X", or
 * inactive. Forwarded by the dashboard from its existing presence heartbeat —
 * the same beat that dims an avatar — so the sender can skip telling someone
 * about what is already on their screen.
 *
 * Relayed rather than reported by the browser directly because presence lives
 * in the dashboard, and a second heartbeat from the same tab would be two
 * timers answering one question with timings that can disagree.
 */
add("POST", "/push/presence", async (req, res) => {
  const who = pushCaller(req);
  if (!who.ok) return err(res, who.status, who.reason);
  let body: { sessionId?: unknown; active?: unknown; viewerId?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const sessionId = boundedString(body.sessionId, 200);
  if (!sessionId) return err(res, 400, "invalid sessionId");
  // Which SCREEN this beat is about. One person now legitimately watches from
  // several (the host's laptop and their enrolled phone both beat as "host"), and
  // a single slot per person made the last beat the only truth — so pocketing the
  // phone cancelled the laptop and the phone then buzzed about what was on the
  // laptop's screen. Untrusted and harmless: the worst a lie does is cancel one of
  // your OWN screens, which is a thing you may already do.
  const viewerId = boundedString(body.viewerId, 64);
  // A peer can only be present on their own session; reject any other claim
  // rather than letting them suppress notifications for a session they can't see.
  if (who.ownerKind === "peer") {
    const peerCanonical = getActiveSession(who.sessionId)?.sessionId ?? who.sessionId;
    const askedCanonical = getActiveSession(sessionId)?.sessionId ?? sessionId;
    if (peerCanonical !== askedCanonical) return err(res, 403, "out of session scope");
  }
  // active === false (backgrounded tab) clears presence, so notifications
  // resume at once rather than waiting for the beat to age out.
  const active = body.active !== false;
  json(res, 200, setParticipantActive(ownerKeyFor(who.ownerKind, who.shareId), active ? sessionId : null, viewerId));
});

add("POST", "/push/unsubscribe", async (req, res) => {
  const who = pushCaller(req);
  if (!who.ok) return err(res, who.status, who.reason);
  let body: { endpoint?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const endpoint = boundedString(body.endpoint, 2048);
  if (!endpoint) return err(res, 400, "invalid endpoint");
  // Owner-scoped: an endpoint you don't own reports not-found rather than
  // being deleted out from under its actual owner.
  json(res, 200, removeSubscription(endpoint, ownerKeyFor(who.ownerKind, who.shareId)));
});

add("GET", "/push/mute", (req, res) => {
  const who = pushCaller(req);
  if (!who.ok) return err(res, who.status, who.reason);
  const rows = listMutes(ownerKeyFor(who.ownerKind, who.shareId));
  json(res, 200, {
    global: rows.some((m) => m.sessionId === null),
    sessions: rows.map((m) => m.sessionId).filter((s): s is string => typeof s === "string"),
  });
});

add("POST", "/push/mute", async (req, res) => {
  const who = pushCaller(req);
  if (!who.ok) return err(res, who.status, who.reason);
  let body: { sessionId?: unknown; muted?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  if (typeof body.muted !== "boolean") return err(res, 400, "missing required field: muted");
  const sessionId = body.sessionId == null ? null : boundedString(body.sessionId, 200);
  if (body.sessionId != null && !sessionId) return err(res, 400, "invalid sessionId");
  // A peer may only mute the session they're actually in — otherwise one peer
  // could write mute rows scoped to sessions they can't even see.
  if (who.ownerKind === "peer" && sessionId) {
    const peerCanonical = getActiveSession(who.sessionId)?.sessionId ?? who.sessionId;
    const askedCanonical = getActiveSession(sessionId)?.sessionId ?? sessionId;
    if (peerCanonical !== askedCanonical) return err(res, 403, "out of session scope");
  }
  setMute(ownerKeyFor(who.ownerKind, who.shareId), sessionId, body.muted);
  json(res, 200, { ok: true });
});

add("GET", "/agents", (_req, res, _params, url) => {
  const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 500, fallback: 50 });
  json(res, 200, listAgentRuns(limit));
});

add("GET", "/agents/:id", (_req, res, params) => {
  const n = parseInt(params.id, 10);
  if (!Number.isFinite(n)) return err(res, 400, "invalid id");
  const run = getAgentDetail(n);
  if (!run) return err(res, 404, "not found");
  json(res, 200, run);
});

add("POST", "/search", async (req, res) => {
  let body: { q?: unknown; type?: unknown; limit?: unknown; session?: unknown };
  try { body = await readJson(req, MAX_BYTES_DEFAULT); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const q = typeof body.q === "string" ? body.q : "";
  const rawType = body.type;
  const type: SearchType = rawType === "semantic" || rawType === "hybrid" ? rawType : "bm25";
  const limit = clampInt(body.limit ?? 50, { min: 1, max: 200, fallback: 50 });
  // Optional session scope (the dashboard sends it for a peer). Expand to the
  // full alias set so a peer sees every hit in their conversation across
  // `claude --resume` id swaps, and nothing outside it.
  const sessions = typeof body.session === "string" && body.session.length > 0
    ? expandSessionIds(body.session)
    : undefined;
  json(res, 200, await search(q, type, limit, sessions));
});

// ---------- JSON: skill run ----------
//
// Launches the skill as a REGULAR controllable session and returns 200 JSON
// { sessionId } once it's spawned and the first turn (`/<skill> <args>`) is
// queued. The dashboard snaps to that session; from there it's an ordinary
// session — /stop, /model, sharing, and the transcript all work. (This replaced
// the old detached `claude -p` run, which produced an uncontrollable session.)
//
// Host-only: peers cannot trigger skill sessions.
//
// Error codes:
//   400 — invalid skill name or malformed args body
//   404 — skill or command not registered on this sandbox
//   429 — too many concurrent controllable sessions
//   500 — spawn failed for an unexpected reason
//
// req.on("close") is intentionally absent here: the response is not
// long-lived, so there is nothing to clean up on client disconnect.

add("POST", "/skill/:name/run", async (req, res, params) => {
  if (!requireHost(req, res)) return;
  const skill = params.name;
  if (!isValidSkillName(skill)) return err(res, 400, "invalid skill name");

  let body: { args?: unknown };
  try { body = await readJson(req, MAX_BYTES_ARGS); } catch (e: any) { return err(res, e.status ?? 400, e.message); }
  const args = boundedString(body.args, 8 * 1024) ?? undefined;

  let sessionId: string;
  try {
    ({ sessionId } = await startSkillSession(skill, args, "host"));
  } catch (e: any) {
    const msg: string = e?.message ?? "failed to start skill session";
    if (e?.name === "TooManyControllableSessionsError") {
      res.setHeader("Retry-After", "5");
      return err(res, 429, msg);
    }
    if (msg.startsWith("unknown skill or command")) return err(res, 404, msg);
    if (msg.startsWith("invalid skill name")) return err(res, 400, msg);
    return err(res, 500, msg);
  }

  json(res, 200, { sessionId });
});

// ---------- Dispatcher ----------

function authorize(req: IncomingMessage, route: Route): boolean {
  if (route.auth === "none") return true;
  if (route.auth === "hook") {
    return hookTokenMatches(getHeader(req, HOOK_TOKEN_HEADER));
  }
  return sandboxTokenMatches(getHeader(req, SANDBOX_TOKEN_HEADER));
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function dispatch(req: IncomingMessage, res: ServerResponse, kind: ListenerKind) {
  const rawUrl = req.url || "/";
  const url = new URL(rawUrl, "http://sandbox.local");
  const rid = reqId(req);

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const m = url.pathname.match(route.pattern);
    if (!m) continue;

    // Wrong listener → keep scanning, and ultimately 404. `continue` rather
    // than an immediate 403 so a caller on the hook socket cannot distinguish
    // "control route exists but you can't have it" from "no such route".
    if (!servedBy(route, kind)) continue;

    if (!authorize(req, route)) {
      return err(res, 401, "unauthorized", rid);
    }

    // After authorization, before anything route-specific: an authenticated
    // request carrying a device identity is that device being seen, whether the
    // route it wants happens to care who is calling or not.
    touchHostDevice(req);

    // Sandbox-side rate limit for mutating routes — defence-in-depth if the
    // dashboard is compromised or if some other client picks up the sandbox
    // token. Keyed on the inbound token (sandbox or hook, whichever applies)
    // since "valid token holder" is the unit we want to throttle.
    if (!SAFE_METHODS.has(req.method ?? "")) {
      const tokenHeader = route.auth === "hook" ? HOOK_TOKEN_HEADER : SANDBOX_TOKEN_HEADER;
      const key = getHeader(req, tokenHeader) ?? "unknown";
      const rate = mutatingLimiter.check(key);
      if (!rate.ok) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(rate.resetSec),
        };
        if (rid) headers[REQUEST_ID_HEADER] = rid;
        res.writeHead(429, headers);
        res.end(JSON.stringify({ error: "rate limit exceeded", ...(rid ? { requestId: rid } : {}) }));
        return;
      }
    }

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });

    try {
      await route.handler(req, res, params, url);
    } catch (e: any) {
      if (!res.headersSent) err(res, 500, e?.message ?? "handler failed", rid);
      else { try { res.end(); } catch { /* ignore */ } }
    }
    return;
  }

  err(res, 404, "not found", rid);
}

// ---------- Bootstrap ----------

/**
 * `kind` defaults to "control" so existing callers (and tests) that spin up a
 * single server keep the full route table.
 */
export function createSandboxServer(kind: ListenerKind = "control") {
  return createServer((req, res) => { void dispatch(req, res, kind); });
}


// Exported for shutdown so SIGTERM can close cleanly. Set once in main().
let _running: import("node:http").Server | null = null;
let _runningHook: import("node:http").Server | null = null;

// Group that may connect to each listener. The two audiences have now diverged,
// which was the whole point of splitting the listeners: `hooopctl` (1101) gates
// the control plane and the model's `agent` uid is NOT in it, while `hook` stays
// on `hooop` (1100) because permission-gate.sh and emit-event.sh run as `agent`
// and must be able to connect.
//
// The directory modes are the real lock (0750 hooopd:hooopctl vs 0750 hooopd:hooop —
// see entrypoint.sh); these gids make the socket files agree with them.
const CONTROL_SOCKET_GID = parseInt(process.env.HOOOP_CONTROL_SOCKET_GID ?? "", 10) || 1101;
const HOOK_SOCKET_GID = parseInt(process.env.HOOOP_HOOK_SOCKET_GID ?? "", 10) || 1100;
let _backupTimer: NodeJS.Timeout | null = null;

const BACKUP_INTERVAL_MS = parseInt(process.env.HOOOP_BACKUP_INTERVAL_MS ?? "", 10) || 60 * 60 * 1000;

async function main() {
  // --- Crash + teardown safety. Installed FIRST so a failure anywhere in boot
  // below is still reported and still tears down cleanly. ------------------
  //
  // (a) Finalize both long-lived better-sqlite3 handles while the Node
  //     environment is still alive. Their prepared statements live for the whole
  //     process, so without this their C++ destructors ran during environment
  //     teardown, where `Statement::~Statement()` →
  //     `node::RemoveEnvironmentCleanupHook` asserts `(env) != nullptr` and node
  //     aborts. That abort killed this server 5 times in one afternoon, and
  //     because it happens on the way out it ALSO masked whatever triggered the
  //     exit and skipped the drain's final durability pass. `exit` (not just the
  //     signal path) is the right hook: it runs for the graceful drain, the
  //     shutdown force-exit timer, the fatal handlers below, and a natural
  //     loop-drain alike. Matches better-sqlite3's documented
  //     `process.on('exit', () => db.close())` guidance. Sync-only by contract —
  //     no awaits are possible here.
  process.on("exit", (code) => {
    closeDb();
    closeSummaryDb();
    if (code !== 0) log.warn("sandbox", "process exiting non-zero", { code });
  });

  // (b) Name the crash. Node's default for an unhandled rejection is to
  //     terminate, and nothing here used to log first — so five real crashes
  //     left behind only a native assertion trace with no JS cause, and the
  //     only visible symptom was every session reading as dormant after the
  //     restart. Log, then exit non-zero so the container's restart policy
  //     still recycles us (and `exit` above still closes the DBs).
  process.on("uncaughtException", (err) => {
    log.fatal("sandbox", "uncaught exception — exiting", {
      err: String(err), stack: (err as Error)?.stack ?? null,
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.fatal("sandbox", "unhandled rejection — exiting", {
      err: String(reason),
      stack: (reason as Error)?.stack ?? null,
    });
    process.exit(1);
  });

  // Group-writable by default, because the state dir now has two writers with
  // different uids: this server (hooopd) and emit-event.sh running as `agent` on
  // its fallback path. The dir is setgid `hooop`, so 002 is what keeps a file
  // created by one of them truncatable by the other. Without it the default 022
  // would hand every new events.jsonl/db an owner-only write bit and the other
  // writer would start failing with EACCES — quietly, since both writers swallow
  // their errors.
  process.umask(0o002);

  // Fail closed before anything can spawn a session: a split server without the
  // helper would run claude as its OWN uid, handing the model control-plane
  // access. Must precede bootActiveSessions(), which can revive sessions.
  assertAsAgentAvailable();

  // Eagerly mint tokens so the dashboard sees them at startup.
  sandboxToken();
  hookToken();
  bootActiveSessions();
  // Tell the user WHY their sessions are dormant when the last run died without
  // draining. The checkpoint restores everything as "dormant" either way, so
  // without this a crash is visually identical to sessions going idle on their
  // own — the "went dormant out of nothing" report. Emitted per restored session
  // (that is where the confusion is read), as an ordinary lifecycle row: an
  // unrecognized hook renders as a labeled divider in the transcript, so this
  // needs no dashboard change and can't be mistaken for something the model said.
  // Gated on there being restored sessions, so a first-ever boot stays silent.
  if (consumeUncleanShutdown()) {
    const restored = listActiveSessions();
    if (restored.length > 0) {
      log.warn("sandbox", "previous run did not drain cleanly; sessions restored from checkpoint", {
        sessions: restored.length,
      });
      for (const s of restored) {
        try {
          ingestEventLine(JSON.stringify({
            ts: new Date().toISOString(),
            hook: "SandboxRestart",
            ctx: {
              session_id: s.sessionId,
              message: "sandbox restarted unexpectedly — this session was resumed from its last checkpoint",
            },
          }));
        } catch { /* best-effort notice; never block boot */ }
      }
    }
  }
  startIdleSweeper();
  // A burn-flagged session restored from the checkpoint must not come back as
  // an ordinary dormant slot — destroy every one of them now, once at startup.
  // Never called from bootActiveSessions itself: that path also runs inside
  // the test suite (via listSessions/getActiveSession), and destroying
  // sessions is not something a test importing the registry should trigger.
  void burnRestoredSessions()
    .then((destroyed: string[]) => {
      if (destroyed.length > 0) {
        log.info("sandbox", "destroyed burn-after-use sessions restored from checkpoint", {
          count: destroyed.length,
        });
      }
    })
    .catch((e: unknown) => {
      log.warn("sandbox", "burnRestoredSessions failed", { err: String(e) });
    });
  bootShares();
  // Same per-run discard as shares, and for the same reason: a device grant is
  // bound to the tunnel hostname, which is new on every start.
  bootHostDevices();
  startSessionsWatcher();
  startSkillsWatcher();
  startIngestor();
  // Push must come up AFTER bootShares: it drops last run's peer subscriptions
  // on the same reasoning that clears the share registry, and it registers the
  // revocation listener that keeps the two in step from here on. The resolver is
  // injected rather than imported because active-sessions already reaches
  // shares.ts, so a direct import from push.ts would close a cycle.
  setCanonicalResolver((id) => getActiveSession(id)?.sessionId ?? id);
  startPushNotifier();
  // After the ingestor has drained events.jsonl, purge events for sessions that
  // no longer exist (deleted before delete-time purging, or stray pending-* ids)
  // so search / observability don't surface gone sessions.
  try { reconcileOrphanEvents(); } catch (err) { log.warn("boot", "orphan-events sweep skipped", { err: String(err) }); }

  // Keep the per-cwd project-skill watchers in sync with the live/dormant
  // session set: a session at any cwd should have its `<cwd>/.claude/skills`
  // watched so skills authored there refresh the dashboard live. Reconcile at
  // boot and whenever the session set changes (cheap set diff; no-op when the
  // cwd set is unchanged).
  const reconcileSkillWatchers = () => {
    try { syncProjectSkillWatchers(listActiveSessions().map((s) => s.cwd)); }
    catch { /* best-effort */ }
  };
  reconcileSkillWatchers();
  sessionsBus.on("change", reconcileSkillWatchers);

  // Same reconciliation for the file-tree live-refresh watcher: one per
  // active session cwd, kept in sync with the live/dormant session set.
  startFileWatcher();
  const reconcileFileWatchers = () => {
    try { syncFileWatchers(listActiveSessions().map((s) => s.cwd)); }
    catch { /* best-effort */ }
  };
  reconcileFileWatchers();
  sessionsBus.on("change", reconcileFileWatchers);

  // Two listeners, one route table. See ListenerKind: control routes are
  // reachable only on the shared-volume socket, the three hook routes only on
  // the container-local one, and /health on both (the Docker healthcheck runs
  // as root against the control socket).
  _running = await listenOnSocket(SOCKET_PATH, "control", CONTROL_SOCKET_GID);
  _runningHook = await listenOnSocket(HOOK_SOCKET_PATH, "hook", HOOK_SOCKET_GID);

  // Hourly atomic backup of events.db to events.db.bak. The backup uses
  // SQLite's online backup API so it's safe to run while writers are active.
  // unref() so a missed tick doesn't keep the event loop alive past
  // shutdown; the explicit clearInterval in the SIGTERM path is the real
  // teardown.
  _backupTimer = setInterval(() => {
    backupEventsDb()
      .then((path) => log.debug("backup", "wrote events.db.bak", { path }))
      .catch((err) => log.error("backup", "failed", { err: String(err) }));
  }, BACKUP_INTERVAL_MS);
  _backupTimer.unref();

  // Drain on shutdown:
  //   1) stop accepting new HTTP connections (server.close)
  //   2) terminate live claude subprocesses owned by active-sessions
  //   3) flush the SQLite events DB to disk
  //
  // Docker sends SIGTERM and waits up to stop_grace_period (default 10s)
  // before SIGKILL; we cap our drain at 8s to stay inside that.
  registerShutdown({
    graceMs: 8_000,
    logger: log,
    drainer: async (signal) => {
      log.info("sandbox", "shutdown signal", { signal });

      // Both listeners. server.close() only stops accepting new connections;
      // existing sockets (the dashboard's long-lived /events/stream, or a hook
      // parked in /permission-wait) keep the callback pending indefinitely.
      // closeAllConnections() — added in Node 18.2 — forcibly closes them so
      // the drain completes promptly. Without it, a partial restart (sandbox
      // only) would hang here until the 8s grace force-exits.
      for (const srv of [_running, _runningHook]) {
        if (!srv) continue;
        srv.closeAllConnections?.();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
      if (_backupTimer) { clearInterval(_backupTimer); _backupTimer = null; }
      try { stopSessionsWatcher(); } catch { /* ignore */ }
      try { stopSkillsWatcher(); } catch { /* ignore */ }
      try { stopFileWatcher(); } catch { /* ignore */ }
      // Clear all share grants on shutdown so `shares.json` can't carry dangling
      // links across a stop/start (the tunnel host they're bound to is gone).
      try { revokeAllShares(); } catch (e) {
        log.warn("sandbox", "revokeAllShares on shutdown failed", { err: String(e) });
      }
      // Same for enrolled host devices: `host-devices.json` must not carry host
      // authority across a stop/start. bootHostDevices() discards the file
      // anyway, so this is the belt to that braces.
      try { revokeAllHostDevices(); } catch (e) {
        log.warn("sandbox", "revokeAllHostDevices on shutdown failed", { err: String(e) });
      }
      try { await shutdownActiveSessions(); } catch (e) {
        log.warn("sandbox", "shutdownActiveSessions failed", { err: String(e) });
      }
      // Release every preview slot. Each runner wipes its own scratch and exits
      // so Docker recreates it clean — without this the slots would come back
      // still leased to sessions this process no longer knows about.
      try { await shutdownPreviews(); } catch (e) {
        log.warn("sandbox", "shutdownPreviews failed", { err: String(e) });
      }
      // Final durability pass: snapshot the DB and roll the WAL back into
      // the main file so the next start doesn't depend on the -wal sidecar.
      try { await backupEventsDb(); } catch (e) {
        log.warn("sandbox", "final backup failed (non-fatal)", { err: String(e) });
      }
      try { checkpointDb(); } catch { /* ignore */ }
      // Last thing before exiting: record that we got all the way here. Boot
      // reads this to tell an intentional restart from a crash, so it must be
      // written only after the drain has actually finished its work.
      markCleanShutdown();
      log.info("sandbox", "drained cleanly");
      process.exit(0);
    },
  });
}

export async function probeSocketAlive(socketPath: string, timeoutMs = 250): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

async function listenOnSocket(
  socketPath: string,
  kind: ListenerKind,
  gid: number,
): Promise<import("node:http").Server> {
  if (existsSync(socketPath)) {
    if (await probeSocketAlive(socketPath)) {
      log.fatal("sandbox", "another sandbox is already listening; refusing to clobber", { socket: socketPath });
      process.exit(1);
    }
    try { unlinkSync(socketPath); } catch { /* stale; ignore */ }
  }
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(socketPath), { recursive: true });

    const server = createSandboxServer(kind);
    server.once("error", reject);
    server.listen(socketPath, () => {
      // 0660 + a group that names who is allowed to talk to THIS listener:
      // the control socket uses `hooop` (gid 1100), which the dashboard image
      // adds its node user to; the hook socket uses the group the in-container
      // hook scripts run with. Falling back to 0660 root-only is useless, so
      // we don't.
      try {
        chmodSync(socketPath, 0o660);
        chownSync(socketPath, -1, gid);
      } catch { /* ignore — perms may not be settable in dev/test */ }
      log.info("sandbox", "listening", { socket: socketPath, kind });
      resolve(server);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    log.fatal("sandbox", "main crashed", { err: String(err) });
    process.exit(1);
  });
}
