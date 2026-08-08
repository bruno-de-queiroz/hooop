/**
 * Public type surface of the sandbox API, as consumed by the dashboard.
 *
 * These mirror the shapes the sandbox returns over the wire. Phase 3 deleted
 * the dashboard's copies of the source modules; the dashboard now talks to the
 * sandbox over a Unix socket and only needs these structural types to validate
 * the JSON it gets back.
 */

export type { SessionInfo, SessionLifecycle } from "./types/session";

export type LifecycleStatus = "alive" | "dormant" | "ended" | "expired" | "error";

export interface ActiveSessionMeta {
  sessionId: string;
  runId: string | null;
  label: string;
  displayName: string | null;
  cwd: string;
  via: "skill" | "new-conversation" | "resumed";
  startedAt: number;
  lastSeenAt: number;
  status: LifecycleStatus;
  pid?: number;
  exitCode?: number | null;
  errorMessage?: string;
}

export interface Skill {
  name: string;
  description: string | null;
  path: string;
  source: "user" | "plugin";
  plugin?: string;
}

export interface SlashCommand {
  name: string;
  description: string | null;
  plugin: string;
  kind: "command" | "skill" | "builtin";
  /** Capability the viewer needs for this command to be usable. "permission" =
   * host / full-access peer only. Absent = usable by anyone who can compose.
   * Mirrors the sandbox's SlashCommand; the sandbox route stays authoritative. */
  requires?: "permission";
}

export interface AgentRun {
  id: number;
  sessionId: string | null;
  subagentType: string | null;
  model: string | null;
  prompt: string | null;
  description: string | null;
  startTs: string;
  endTs: string | null;
  durationMs: number | null;
  toolUseCount: number | null;
  result: string | null;
  parentAgentId: number | null;
  status: "running" | "completed" | "interrupted";
}

export type SearchType = "bm25" | "semantic" | "hybrid";

export interface SearchResult {
  id: number;
  ts: string;
  session_id: string | null;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
  score: number;
  rank: number;
  bm25_rank?: number;
  vec_distance?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  type: SearchType;
  total: number;
  meta: {
    bm25_used: boolean;
    semantic_used: boolean;
    semantic_unavailable?: string;
  };
}

export interface McpServer {
  name: string;
  scope: "user" | "project" | "plugin";
  type: string;
  target: string;
  envKeys: string[];
  project?: string;
  plugin?: string;
}

export interface McpsResponse {
  servers: McpServer[];
}

export interface InstalledPlugin {
  key: string;
  name: string;
  marketplace: string;
  version: string;
  installedAt: string;
}

export interface StackResponse {
  plugins: InstalledPlugin[];
  memory: { plugin: string; version: string } | null;
  installLog: { exists: boolean; lines: number; summary: Record<string, string> };
}

export interface IdentityResponse {
  authenticated: boolean;
  fullName?: string | null;
  displayName?: string | null;
  role?: string | null;
  company?: string | null;
  emailAddress?: string | null;
  organizationName?: string | null;
  organizationRole?: string | null;
  organizationType?: string | null;
  seatTier?: string | null;
  accountUuid?: string | null;
  profileMarkdown?: string | null;
  profileSource?: string | null;
}

export interface EventsQuery {
  limit?: number;
  before?: number;
  hook?: string;
  tool?: string;
  session?: string;
}

export interface EventRow {
  id: number;
  ts: string;
  session_id: string | null;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
  // Shared-session attribution: "host", a guest's name, or null/absent.
  author?: string | null;
  // ≤512px base64 image thumbnails attached to a user turn, or null/absent.
  images?: { media_type: string; data: string }[] | null;
  // Lifecycle marker for a non-chat turn — e.g. "plan-approval" / "plan-rejection"
  // for the host's plan-review decision. Lets the transcript re-style the turn
  // instead of showing it as an ordinary host bubble. Null/absent for normal turns.
  kind?: string | null;
  // Set ONLY for events that fired inside a subagent (claude's ctx.agent_id on
  // sidechain PreToolUse/PostToolUse/SubagentStop). The main transcript hides
  // these — subagent activity belongs in the Agents rail. Null/absent otherwise.
  agent_id?: string | null;
}

export interface EventRowFull extends EventRow {
  payload: unknown;
}

export interface FilesQuery {
  cwd: string;
  q?: string;
  limit?: number;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
}

export interface FilesResponse {
  entries: FileEntry[];
}

// ── Files navigator (git-decorated tree + per-file preview) ──────────────────
// These mirror the sandbox's lib/git.ts and the dashboard's
// app/components/shell/files/types.ts so a fetched response drops into the UI.

export type GitStatus = "added" | "changed" | "removed" | "ignored" | null;

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  status: GitStatus;
  children?: FileNode[];
  /** Directory's `children` is an intentionally-unwalked placeholder (huge
   * dependency/build dir, or git-collapsed ignored/untracked dir) — fetch
   * `GET /files/tree?cwd=&path=` to load it on demand, don't treat `[]` as
   * "genuinely empty". */
  lazy?: boolean;
}

export interface FileTreeResponse {
  repo: boolean;
  tree: FileNode[];
  truncated: boolean;
}

export type DiffSign = " " | "+" | "-";
export interface DiffLine {
  sign: DiffSign;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface FileDiff {
  kind: "modified" | "added" | "removed";
  adds: number;
  dels: number;
  hunks: DiffHunk[];
}

export interface FilePreviewResponse {
  status: GitStatus;
  isMarkdown: boolean;
  diff: FileDiff | null;
  content: string | null;
  truncated: boolean;
  sizeBytes: number;
  binary: boolean;
  diffTooLarge: boolean;
  /** Renderable image. The bytes are NOT here — fetch `/api/files/raw`, keyed by
   * `mtimeMs`, so this payload stays small enough to refetch on every write
   * under the cwd (see useFilePreview). */
  isImage: boolean;
  imageType: string | null;
  /** Recognised image over the preview cap: show the size, not a broken tile. */
  imageTooLarge: boolean;
  /** Cache key for the raw URL. */
  mtimeMs: number;
}

/** Whole-image bytes, base64 over the sandbox socket (its client decodes bodies
 * as UTF-8, so raw bytes cannot survive the hop). The dashboard's raw route
 * decodes this back to bytes — base64 never reaches the browser. */
export interface FileRawResponse {
  mediaType: string;
  base64: string;
  size: number;
}

/**
 * Per-session structured summary, sourced from claude-mem's session_summaries
 * table. Each field can independently be null when claude-mem hasn't yet
 * produced that piece. The whole record is null when claude-mem isn't
 * installed or hasn't indexed the session at all.
 */
export interface SessionSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  nextSteps: string | null;
  createdAt: string;
}

export type ShareCapability = "full" | "drive" | "spectate";

/** A peer co-drive grant. Mirrors sandbox/lib/shares.ts ShareRecord. */
export interface ShareRecord {
  shareId: string;
  sessionId: string;
  capability: ShareCapability;
  publicHost: string;
  peerName: string | null;
  createdAt: number;
  expiresAt: number | null;
  revoked: boolean;
}

// ── Live previews ───────────────────────────────────────────────────────────
// The spec and runtime vocabulary live in @shared/preview-spec (the sandbox and
// the preview runner use the same definitions); these are the dashboard-facing
// shapes the sandbox returns over the socket.

export type { PreviewSpec, PreviewState, PreviewPhase, PreviewLog } from "@shared/preview-spec";

/** One live preview. Mirrors sandbox/lib/previews.ts PreviewRecord. */
export interface PreviewRecord {
  previewId: string;
  sessionId: string;
  /** Which of the three runner containers is serving it. */
  slot: number;
  spec: import("@shared/preview-spec").PreviewSpec;
  /** Absolute cwd in the sandbox's path space (display only). */
  workdir: string;
  appPort: number | null;
  /** Fixed, published container port for this slot. */
  slotPort: number;
  state: import("@shared/preview-spec").PreviewState;
  phase: import("@shared/preview-spec").PreviewPhase;
  failedStep: number | null;
  failureReason: string | null;
  /** Tunnel URL once shared; null while the preview is host-local. */
  publicUrl: string | null;
  createdAt: number;
}

export interface PreviewsResponse {
  /** False when this install has no preview runners (pre-upgrade container). */
  available: boolean;
  slots: { total: number; used: number };
  previews: PreviewRecord[];
}
