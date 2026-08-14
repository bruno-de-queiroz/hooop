"use client";
import { useState } from "react";
import { ShieldAlert, Loader2, Zap } from "lucide-react";
import type { PendingPermissionRequest } from "@/app/context/hooks/usePendingRequests";
import { usePendingRequests } from "@/app/context/hooks/usePendingRequests";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { useActiveSession } from "@/app/context/ActiveSessionProvider";
import { isPeerClient, canDecidePermissions, useMounted } from "../lib/participant";

// Shell permission box (Phase 3). A generic tool-permission ask for the CURRENT
// session renders as the mockup's inline card — a shield-alert avatar + a
// live-tinted panel — pinned above the composer so a paused agent is never
// scrolled off. Scoped to the selected session (usePendingRequests): a card
// only ever shows in the session that raised it. ExitPlanMode (plan review) and
// AskUserQuestion route to their own surfaces; peers never decide generic tool
// asks, so this renders nothing for them.

// color-mix against the live cue has no Tailwind utility, so the tinted panel
// chrome is inline. --divider is already rgba.
const liveAvatar = {
  background: "color-mix(in oklab, rgb(var(--live)) 18%, rgb(var(--elevated)))",
  color: "rgb(var(--live))",
};
const livePanel = {
  background: "rgb(var(--elevated))",
  border: "1px solid color-mix(in oklab, rgb(var(--live)) 45%, var(--divider))",
};
const liveHead = { background: "color-mix(in oklab, rgb(var(--live)) 12%, transparent)" };

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function PermCard({
  request,
  error,
  autoModeOn,
  onDecide,
  onEnableAuto,
}: {
  request: PendingPermissionRequest;
  error: string | null;
  /** Auto mode already engaged for this session → hide the "Auto" button. */
  autoModeOn: boolean;
  onDecide: (decision: "allow" | "deny", scope?: "once" | "always") => Promise<void>;
  /** Allow this request AND turn on auto mode for the session. Undefined when
   * the viewer can't decide (peers who only spectate never see the button). */
  onEnableAuto?: () => Promise<void>;
}) {
  // Open by default for a CRITICAL ask. Seen live: the host was asked to approve a
  // guest's `rm -rf` with the command itself behind a "show input" click. On the one
  // class of ask that is host-only precisely because it is dangerous, what is being
  // approved has to be on screen without asking for it.
  const [showInput, setShowInput] = useState(!!request.critical);
  const [submitting, setSubmitting] = useState<"allow" | "deny" | "always" | "auto" | null>(null);

  const inputString = typeof request.input === "string" ? request.input : prettyJson(request.input);
  // Peer-driven ask → the host can grant session-scoped "allow all from $peer".
  const peer = request.author && request.author !== "host" ? request.author : null;

  async function go(decision: "allow" | "deny", scope: "once" | "always" = "once") {
    if (submitting != null) return;
    setSubmitting(scope === "always" ? "always" : decision);
    try {
      await onDecide(decision, scope);
    } finally {
      setSubmitting(null);
    }
  }

  async function goAuto() {
    if (submitting != null || !onEnableAuto) return;
    setSubmitting("auto");
    try {
      await onEnableAuto();
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex items-start gap-2.5">
      <span className="avatar w-7 h-7 shrink-0 mt-0.5" style={liveAvatar}>
        <ShieldAlert className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1 max-w-[40rem] rounded-2xl overflow-hidden" style={livePanel}>
        <div className="px-3.5 py-2.5 flex items-center gap-2" style={liveHead}>
          <span className="text-[12px] font-semibold text-ink">Permission required</span>
          <span className="ml-auto chip text-[9px] px-1.5 py-0.5 uppercase tracking-wide text-live">
            {request.toolName}
          </span>
        </div>
        <div className="px-3.5 py-3">
          <p className="text-[12.5px] text-ink-soft">
            Claude wants to run <span className="font-mono text-ink">{request.toolName}</span>
            {peer && (
              <span className="text-ink-faint">
                {" · "}driven by <span className="text-ink-soft">{peer}</span>
              </span>
            )}
          </p>

          {inputString && (
            <>
              <button
                type="button"
                onClick={() => setShowInput((v) => !v)}
                className="font-mono text-[10px] text-ink-faint hover:text-ink-mute mt-2"
              >
                {showInput ? "hide input" : "show input"}
              </button>
              {showInput && (
                <pre className="font-mono text-[11.5px] text-ink-soft mt-1.5 px-3 py-2 rounded-lg overflow-x-auto bg-sunken border border-divider whitespace-pre-wrap break-words">
                  {inputString}
                </pre>
              )}
            </>
          )}

          {request.decisionReason && (
            <p className="mt-1 font-mono text-[10px] text-ink-faint">{request.decisionReason}</p>
          )}
          {error && <p className="mt-1 font-mono text-[10px] text-fail">{error}</p>}

          <div className="flex items-center gap-1.5 mt-3">
            {/* "Allow all from $peer" and "Auto" are hidden on a CRITICAL ask, and
               not because they would be unsafe — the critical set is excluded from
               every unattended approval, so both are honoured correctly. They just
               read as "stop asking me about this", and the next `rm -rf` will ask
               again. An affordance that promises quiet and delivers a prompt is
               worse on this card than on any other, because this is the card where
               the host is deciding carefully. */}
            {peer && !request.critical && (
              <button
                type="button"
                onClick={() => go("allow", "always")}
                disabled={submitting != null}
                title={`Auto-approve future tool requests from ${peer} for this session (git still asks)`}
                className="pill-btn text-[11px] px-3 py-1.5 text-wrap disabled:opacity-40"
              >
                {submitting === "always" ? "trusting…" : `Allow all from ${peer}`}
              </button>
            )}
            <button
              type="button"
              onClick={() => go("deny")}
              disabled={submitting != null}
              className="pill-btn text-[11px] px-3 py-1.5 ml-auto text-fail disabled:opacity-40"
            >
              {submitting === "deny" ? "denying…" : "Deny"}
            </button>
            <button
              type="button"
              onClick={() => go("allow")}
              disabled={submitting != null}
              className="accent-btn text-[11px] px-3 py-1.5 disabled:opacity-40"
            >
              {submitting === "allow" ? "allowing…" : "Allow once"}
            </button>
            {onEnableAuto && !autoModeOn && !request.critical && (
              <button
                type="button"
                onClick={goAuto}
                disabled={submitting != null}
                title="Allow this and stop asking for routine tools — git and destructive commands still ask."
                // Inline color: .pill-btn hard-sets `color` (unlayered), which
                // outranks the layered `text-live` utility — apply the amber
                // accent inline so it actually shows.
                style={{ color: "rgb(var(--live))" }}
                className="pill-btn text-[11px] px-3 py-1.5 inline-flex items-center gap-1 disabled:opacity-40"
              >
                <Zap className="w-3 h-3" />
                {submitting === "auto" ? "enabling…" : "Auto"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only permission bubble for a peer who can't decide (drive / spectate).
 * Same chrome as PermCard so the paused agent reads consistently, but instead
 * of Allow/Deny it explains that the host must approve. `full` peers get the
 * real PermCard; the sandbox is authoritative either way.
 */
function PeerWaitCard({ request }: { request: PendingPermissionRequest }) {
  const peer = request.author && request.author !== "host" ? request.author : null;
  return (
    <div className="flex items-start gap-2.5">
      <span className="avatar w-7 h-7 shrink-0 mt-0.5" style={liveAvatar}>
        <ShieldAlert className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1 max-w-[40rem] rounded-2xl overflow-hidden" style={livePanel}>
        <div className="px-3.5 py-2.5 flex items-center gap-2" style={liveHead}>
          <span className="text-[12px] font-semibold text-ink">Permission required</span>
          <span className="ml-auto chip text-[9px] px-1.5 py-0.5 uppercase tracking-wide text-live">
            {request.toolName}
          </span>
        </div>
        <div className="px-3.5 py-3">
          <p className="text-[12.5px] text-ink-soft">
            Claude wants to run <span className="font-mono text-ink">{request.toolName}</span>
            {peer && (
              <span className="text-ink-faint">
                {" · "}driven by <span className="text-ink-soft">{peer}</span>
              </span>
            )}
          </p>
          {/* A drive/spectate peer waits on everything, so "waiting" is the whole
             story. A FULL peer decides the ask above this one and not this one, so
             say which kind it is — otherwise the buttons simply vanished. */}
          {request.critical && (
            <p className="mt-2 text-[11px] text-ink-faint leading-relaxed">
              This one is the host&rsquo;s call: destructive commands, git, secrets and anything
              outside this session&rsquo;s folder always go to them, whatever your access.
            </p>
          )}
          <div className="mt-3 flex items-center gap-2 text-[11.5px] text-live">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span>Waiting for the host to approve…</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ShellPermissions() {
  const { selectedId } = useSelectedSession();
  const { pending, decide, error } = usePendingRequests(selectedId);
  const { meta, setAutoMode } = useActiveSession();
  const autoModeOn = meta.autoMode;
  // Before the early return — hooks can't run conditionally. Mount-gated because
  // the server always reads as host; calling isPeerClient() during render would
  // mismatch on hydration for a peer.
  const mounted = useMounted();

  // Who may decide: host or a full-access peer get Allow/Deny; drive & spectate
  // peers see a read-only "waiting for the host" bubble (the sandbox re-checks —
  // it's authoritative). Mount-gated so the server (always host) hydrates cleanly.
  const canDecideByCapability = !mounted || canDecidePermissions();
  // ...except a CRITICAL ask, which is the host's alone whatever the share says.
  // Per REQUEST rather than per viewer, because a full peer legitimately decides
  // the routine ones sitting right next to it — `git push` waits for the host
  // while the Write above it does not. The sandbox refuses a peer's decision on
  // these regardless; this is what stops us drawing a button that would 403.
  const viewerIsPeer = mounted && isPeerClient();
  const canDecide = (r: PendingPermissionRequest) =>
    canDecideByCapability && !(viewerIsPeer && r.critical);

  // Generic tool asks only — ExitPlanMode → plan review, AskUserQuestion → ask stack.
  const visible = pending.filter(
    (r) => r.toolName !== "AskUserQuestion" && r.toolName !== "ExitPlanMode",
  );
  if (visible.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Permission requests"
      className="px-5 pt-1 pb-2 shrink-0 flex flex-col gap-3 overflow-y-auto max-h-[45vh]"
    >
      {visible.map((request) =>
        canDecide(request) ? (
          <PermCard
            key={request.requestId}
            request={request}
            error={error}
            autoModeOn={autoModeOn}
            onDecide={(decision, scope) => decide(request.requestId, decision, scope)}
            onEnableAuto={async () => {
              // Allow the current ask, then flip the session into auto mode so
              // subsequent routine tools stop prompting.
              await decide(request.requestId, "allow", "once");
              await setAutoMode(true);
            }}
          />
        ) : (
          <PeerWaitCard key={request.requestId} request={request} />
        ),
      )}
    </div>
  );
}
