"use client";
import { useMemo, useState } from "react";
import { ClipboardList, Flame, Moon, Plus, Search, X } from "lucide-react";
import type { SessionInfo } from "@/lib/types/session";
import { useSessions } from "@/app/context/SessionsProvider";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { useUnseenSessions } from "@/app/context/hooks/useUnseenSessions";
import { ConfirmDeleteSessionModal } from "./ConfirmDeleteSessionModal";
import { NeedsReviewRail } from "./NeedsReviewRail";
import { usePlanReview } from "./ShellChrome";
import { sessionDisplayLabel, cwdBasename, relTime } from "../lib/format";
import { Avatar, Chip, IconButton, SectionTitle, StatusDot } from "../ui";
import { cn } from "../ui/cn";

// Desktop-shell sessions rail (Phase 3). Same visibility rules as the legacy
// SessionsPanel — alive rows plus whatever is currently selected (so a dormant/
// ended session you're still reading stays reachable) — but remodeled per the
// mockup: a local filter, Active/Dormant groups, and richer rows (avatar, live
// dot, cwd preview, relative time).
//
// NOTE: the mockup's cross-session "Needs review" block is intentionally NOT
// built here. Pending plans are only exposed per-session (usePendingRequests);
// surfacing them across sessions needs a new aggregate endpoint, which is a
// feature, not a reskin. Tracked separately.

// Data placement follows the mockup: an ACTIVE group (live sessions) and a
// DORMANT group (resumable — dormant or ended). The provider already returns
// all of these (the legacy resume-list reads the same source); we just group
// them here instead of the legacy panel's "alive + only-the-selected-dormant"
// filter. `expired` rows are dropped (unrecoverable).
const RESUMABLE = new Set(["dormant", "ended"]);

// claude-mem's observer plugin spawns its own background sessions under
// ~/.claude-mem/observer-sessions (bookkeeping for its memory index, not user
// work). They clutter the rail and are never something the operator drives, so
// hide any session whose cwd lives inside a .claude-mem directory. Matches the
// path segment rather than a hardcoded home so it holds regardless of the user.
function isClaudeMemSession(s: SessionInfo): boolean {
  const cwd = s.cwd ?? "";
  return cwd.includes("/.claude-mem/") || cwd.endsWith("/.claude-mem");
}

export function isVisible(s: SessionInfo): boolean {
  if (!s.sessionId) return false;
  if (s.lifecycle === "expired") return false;
  if (isClaudeMemSession(s)) return false;
  const lc = s.lifecycle ?? "alive";
  return lc === "alive" || RESUMABLE.has(lc);
}

/** "quiet-morning-fog" → "qm"; single word → first two chars. */
export function sessionInitials(label: string): string {
  const parts = label.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toLowerCase();
  return (parts[0][0] + parts[1][0]).toLowerCase();
}

export function SessionsRail() {
  const { sessions, deleteSession } = useSessions();
  const { selectedId, setSelected } = useSelectedSession();
  const isUnseen = useUnseenSessions(sessions, selectedId);
  const { plans } = usePlanReview();
  const planIds = new Set(plans.map((p) => p.sessionId));
  const hasPlan = (s: SessionInfo) =>
    (s.sessionId != null && planIds.has(s.sessionId)) ||
    (s.aliases ?? []).some((a) => planIds.has(a));
  const [filter, setFilter] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const { active, dormant } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const visible = sessions.filter(isVisible);
    const matched = q
      ? visible.filter((s) => {
          const label = sessionDisplayLabel(s).toLowerCase();
          return label.includes(q) || (s.cwd ?? "").toLowerCase().includes(q);
        })
      : visible;
    // Sort by creation date, newest first. The sandbox guarantees startedAt on
    // every controllable/dormant row; id is a deterministic tiebreaker.
    const sorted = [...matched].sort(
      (a, b) =>
        (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const isAlive = (s: SessionInfo) => (s.lifecycle ?? "alive") === "alive";
    return {
      active: sorted.filter(isAlive),
      dormant: sorted.filter((s) => !isAlive(s)),
    };
  }, [sessions, filter]);

  function onDelete(sessionId: string, name: string) {
    setPendingDelete({ id: sessionId, name });
  }

  return (
    // suppressHydrationWarning: password-manager extensions (Proton Pass, etc.)
    // tag input containers with data-protonpass-form before hydration, which
    // would otherwise trip a dev-only mismatch on this wrapper.
    <div className="flex-1 min-h-0 flex flex-col" suppressHydrationWarning>
      <div className="px-3 pt-4 pb-3 shrink-0">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-mute pointer-events-none" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="search sessions or events…"
            aria-label="Search sessions"
            className="field w-full text-[12px] pl-9 pr-3 py-2"
          />
        </div>
      </div>

      {/* Pending plans across sessions — mockup places this between the search
        * and the session list. Self-hides when there's nothing to review. */}
      <NeedsReviewRail />

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        <div className="flex items-center gap-2 px-2 pt-1 pb-1.5">
          <SectionTitle>Active</SectionTitle>
          <Chip>{active.length}</Chip>
          <IconButton
            label="New session"
            size="sm"
            className="ml-auto"
            onClick={() => setSelected(null)}
          >
            <Plus className="w-4 h-4" />
          </IconButton>
        </div>

        {active.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-ink-faint">
            No active sessions. + to start one.
          </p>
        )}

        {active.map((s) => (
          <Row
            key={s.sessionId}
            s={s}
            selected={s.sessionId === selectedId}
            unseen={isUnseen(s)}
            hasPlan={hasPlan(s)}
            deleting={deleting === s.sessionId}
            onSelect={setSelected}
            onDelete={onDelete}
          />
        ))}

        {dormant.length > 0 && (
          <>
            <div className="flex items-center gap-2 px-2 pt-4 pb-1.5">
              <SectionTitle>Dormant</SectionTitle>
            </div>
            {dormant.map((s) => (
              <Row
                key={s.sessionId}
                s={s}
                selected={s.sessionId === selectedId}
                unseen={isUnseen(s)}
                hasPlan={hasPlan(s)}
                deleting={deleting === s.sessionId}
                onSelect={setSelected}
                onDelete={onDelete}
                dormant
              />
            ))}
          </>
        )}
      </div>

      <ConfirmDeleteSessionModal
        open={!!pendingDelete}
        sessionName={pendingDelete?.name ?? ""}
        busy={!!deleting}
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          const p = pendingDelete;
          setPendingDelete(null);
          if (!p) return;
          setDeleting(p.id);
          try {
            await deleteSession(p.id);
          } finally {
            setDeleting(null);
          }
        }}
      />
    </div>
  );
}

function Row({
  s,
  selected,
  unseen,
  hasPlan,
  deleting,
  dormant,
  onSelect,
  onDelete,
}: {
  s: SessionInfo;
  selected: boolean;
  unseen: boolean;
  hasPlan: boolean;
  deleting: boolean;
  dormant?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const sid = s.sessionId!;
  const label = sessionDisplayLabel(s);
  const isSkill = !!s.skill;
  // Dormant rows advertise how to bring them back (mockup: "resume · dormant");
  // active rows show the working directory.
  const preview = dormant
    ? `resume · ${s.lifecycle ?? "dormant"}`
    : s.cwd
      ? cwdBasename(s.cwd)
      : "";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(sid)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(sid);
        }
      }}
      title={s.cwd ? `${label} · ${s.cwd}` : label}
      className={cn(
        "group w-full text-left flex items-center gap-2.5 px-2 py-2 mb-0.5 rounded-[11px] cursor-pointer transition-colors",
        selected ? "bg-accent/[0.14]" : "hover:bg-elevated",
      )}
    >
      {/* A self-deleting session gets the flame AS its avatar, in the rose cue
        * (.avatar-fail) the design system already uses for destructive state.
        * It takes precedence over the dormant moon deliberately: a burn session
        * only ever reads "dormant" in the narrow window after a sandbox restart,
        * before the next boot destroys it, and "this is about to delete itself"
        * outranks "this is asleep". The preview line still says `resume ·
        * dormant`, so that state isn't lost. */}
      {s.burnAfterUse ? (
        <Avatar
          size="md"
          className="avatar-fail shrink-0"
          title="Burns after use: deletes itself instead of going dormant"
          aria-label="burns after use"
        >
          <Flame className="w-3.5 h-3.5" />
        </Avatar>
      ) : dormant ? (
        <Avatar size="md" className="shrink-0 opacity-70">
          <Moon className="w-3.5 h-3.5" />
        </Avatar>
      ) : (
        <Avatar
          size="md"
          initials={sessionInitials(label)}
          className={cn("shrink-0 text-[11px]", selected && "bg-accent/20 text-accent")}
        />
      )}

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "truncate text-[12.5px]",
              dormant ? "italic font-medium text-ink-mute" : "font-semibold text-ink",
            )}
          >
            {label}
          </span>
          {isSkill && <Chip tone="direct">skill</Chip>}
          {/* Plan-to-review indicator (mockup): clipboard in the live cue. */}
          {hasPlan && (
            <ClipboardList className="w-3 h-3 shrink-0 text-live" aria-label="plan to review" />
          )}
          {/* No flame beside the label: it's the row's avatar now (see above),
            * which reads at a glance down the whole list instead of competing
            * with the plan indicator and the attention dot for the same strip. */}
          {/* One attention dot: a pulsing dot while a turn is running, else a
            * solid amber dot when the session has unseen messages. */}
          {s.turnActive ? (
            <StatusDot state="live" size="sm" pulse aria-label="running" />
          ) : (
            unseen && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-live shrink-0"
                title="unseen messages"
                aria-label="unseen messages"
              />
            )
          )}
        </span>
        {preview && <span className="block truncate text-[11px] text-ink-faint">{preview}</span>}
      </span>

      <span className="flex items-center gap-1 shrink-0 self-start mt-0.5">
        <span className="font-mono text-[10px] text-ink-hush tabular-nums group-hover:hidden">
          {relTime(s.mtime)}
        </span>
        <button
          type="button"
          aria-label="Delete session"
          disabled={deleting}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(sid, label);
          }}
          className="hidden group-hover:block text-ink-hush hover:text-fail disabled:opacity-30 transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </span>
    </div>
  );
}
