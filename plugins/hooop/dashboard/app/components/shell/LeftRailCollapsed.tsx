"use client";
import { Moon, Plus } from "lucide-react";
import type { SessionInfo } from "@/lib/types/session";
import { useSessions } from "@/app/context/SessionsProvider";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { useUnseenSessions } from "@/app/context/hooks/useUnseenSessions";
import { NeedsReviewRail } from "./NeedsReviewRail";
import { IdentityFooter } from "./IdentityFooter";
import { usePlanReview } from "./ShellChrome";
import { isVisible, sessionInitials } from "./SessionsRail";
import { sessionDisplayLabel } from "../lib/format";
import { CAPABILITY_LABEL, myDisplayName, peerCapability, useMounted } from "../lib/participant";
import { Avatar } from "../ui";
import { cn } from "../ui/cn";

// Collapsed left rail (mockup's rail-mini for the sessions side). A narrow strip
// that keeps the sessions rail's essentials reachable without expanding: start a
// new session, switch between active sessions (avatars), review pending plans,
// and the identity avatar + settings. Everything is horizontally centered in the
// w-12 strip. The mid-edge handle on the Rail itself does expand/collapse.
//
// The session list + settings above are host-only — a peer has no session list
// to collapse (they're locked to one session), just their name and share
// capability, shown via CollapsedPeerPanel below.

function CollapsedSessions() {
  const { sessions } = useSessions();
  const { selectedId, setSelected } = useSelectedSession();
  const isUnseen = useUnseenSessions(sessions, selectedId);

  // Same active/dormant split as the expanded rail (SessionsRail) — collapsing
  // the rail hid a resumable session outright before, since this used to filter
  // to "alive" only, with no dormant group at all.
  const visible = [...sessions.filter(isVisible)].sort(
    (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
  );
  const isAlive = (s: SessionInfo) => (s.lifecycle ?? "alive") === "alive";
  const active = visible.filter(isAlive);
  const dormant = visible.filter((s) => !isAlive(s));

  const isSelected = (s: SessionInfo) =>
    s.sessionId === selectedId || (s.aliases ?? []).includes(selectedId ?? "");

  const dot = (s: SessionInfo, dormantRow: boolean) => {
    const sid = s.sessionId!;
    const selected = isSelected(s);
    const label = sessionDisplayLabel(s);
    return (
      <button
        key={sid}
        type="button"
        onClick={() => setSelected(sid)}
        title={dormantRow ? `${label} · resume · ${s.lifecycle ?? "dormant"}` : label}
        aria-label={label}
        className="relative shrink-0 rounded-full"
      >
        {dormantRow ? (
          <Avatar size="md" className={cn("opacity-70", selected && "ring-2 ring-accent/50")}>
            <Moon className="w-3.5 h-3.5" />
          </Avatar>
        ) : (
          <Avatar
            size="md"
            initials={sessionInitials(label)}
            className={cn("text-[11px]", selected ? "bg-accent/20 text-accent ring-2 ring-accent/50" : "text-ink")}
          />
        )}
        {/* One attention marker, mirroring the expanded row: a pulsing dot
          * while a turn runs, else a solid dot for unseen messages. Dormant
          * sessions have neither — a stopped session can't be mid-turn or have
          * fresh unseen output. */}
        {!dormantRow && s.turnActive && (
          <span
            className="absolute -right-0.5 -top-0.5 w-2 h-2 rounded-full bg-live ring-2 ring-rail motion-safe:animate-pulse"
            aria-label="running"
          />
        )}
        {!dormantRow && !s.turnActive && isUnseen(s) && (
          <span
            className="absolute -right-0.5 -top-0.5 w-2 h-2 rounded-full bg-live ring-2 ring-rail"
            aria-label="unseen messages"
          />
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-col items-center gap-1 w-full">
      {active.map((s) => dot(s, false))}
      {dormant.length > 0 && (
        <>
          {active.length > 0 && <div className="h-px w-6 bg-divider my-0.5 shrink-0" aria-hidden />}
          {dormant.map((s) => dot(s, true))}
        </>
      )}
    </div>
  );
}

/** Collapsed left rail for a peer: no session list (a guest is locked to one
 * session), but still an identity to show — mirrors GuestFooter's expanded
 * name + capability, not just an empty strip. */
function CollapsedPeerPanel() {
  const mounted = useMounted();
  const name = mounted ? myDisplayName() : "Guest";
  const cap = mounted ? peerCapability() : null;
  return (
    <div className="w-12 h-full flex flex-col items-center justify-end pb-2.5 gap-1.5 border-t border-divider">
      <span
        className="avatar w-8 h-8 text-[11px] shrink-0"
        style={{
          background: "color-mix(in oklab, rgb(var(--sdk)) 30%, rgb(var(--elevated)))",
          color: "rgb(var(--sdk))",
        }}
        title={cap ? `${name} · ${CAPABILITY_LABEL[cap]}` : name}
      >
        {peerInitials(name)}
      </span>
      {cap && (
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: "rgb(var(--sdk))" }}
          title={CAPABILITY_LABEL[cap]}
          aria-label={CAPABILITY_LABEL[cap]}
        />
      )}
    </div>
  );
}

function peerInitials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function LeftRailCollapsed({
  isPeer,
  onNew,
  onOpenSettings,
}: {
  isPeer: boolean;
  onNew: () => void;
  onOpenSettings: () => void;
}) {
  const { plans } = usePlanReview();
  if (isPeer) return <CollapsedPeerPanel />;
  return (
    <div className="w-12 h-full flex flex-col items-center">
      <div className="pt-3 pb-1.5 shrink-0">
        <button className="icon-btn w-9 h-9" title="New session" aria-label="New session" onClick={onNew}>
          <Plus className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 w-full overflow-y-auto flex flex-col items-center gap-1.5 px-2 py-1">
        {/* Plans to review sit above the sessions (mirrors the expanded rail,
          * where Needs-review is between the search and the session list). */}
        <NeedsReviewRail collapsed />
        {plans.length > 0 && <div className="h-px w-6 bg-divider my-0.5 shrink-0" aria-hidden />}
        <CollapsedSessions />
      </div>
      <IdentityFooter collapsed onOpenSettings={onOpenSettings} />
    </div>
  );
}
