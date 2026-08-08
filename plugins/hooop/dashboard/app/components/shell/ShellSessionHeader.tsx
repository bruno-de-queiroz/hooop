"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, BellOff, Check, ChevronDown, Maximize2, Minimize2, MoreHorizontal, Share2, X, Zap } from "lucide-react";
import type { SessionInfo } from "@/lib/types/session";
import type { SessionMeta } from "@/app/context/hooks/useSessionMeta";
import type { PresenceParticipant } from "@/app/context/hooks/usePresence";
import { useSessions } from "@/app/context/SessionsProvider";
import { useSharingLive } from "@/app/context/hooks/useSharingLive";
import { ConfirmDeleteSessionModal } from "./ConfirmDeleteSessionModal";
import { useCenterFullscreen } from "./ShellChrome";
import { useFilesUI } from "@/app/context/FilesUIProvider";
import { MobileViewItems } from "./MobileViewItems";
import { cwdBasename, sessionDisplayLabel } from "../lib/format";
import { isHostClient, isPeerClient, canAdmitPeers, canDecidePermissions, useMounted } from "../lib/participant";
import { useActiveSession } from "@/app/context/ActiveSessionProvider";
import { useNotifications } from "@/app/context/NotificationsProvider";
import { cn } from "../ui/cn";

// Center-pane header (Phase 3): lifecycle dot, session name (click to rename),
// host-only session switcher, presence stack + typing, cwd chip, live pill, and
// share / ⋯ actions. Reads sessions from the provider; rename/remove/share are
// handed down from the provider via props.

// Presence stack shows at most this many avatars before collapsing the rest
// into a "+N" overflow avatar (click either to open the full roster popover).
const PRESENCE_AVATAR_LIMIT = 2;
// Must match the popover's `w-56` class below — used to clamp it on-screen
// without waiting a render (see the layout effect that sets peersPanelShift).
const PEERS_PANEL_WIDTH = 224;
const VIEWPORT_EDGE_MARGIN = 12;

function lifecycleDot(lc: string | null): { cls: string; title: string } {
  switch (lc) {
    case "alive": return { cls: "bg-wrap", title: "alive" };
    case "error": return { cls: "bg-fail", title: "error" };
    case "dormant":
    case "ended": return { cls: "bg-ink-hush", title: lc };
    default: return { cls: "bg-ink-hush", title: lc ?? "—" };
  }
}

// Mobile-only ⋯ items: on phones the right rail is hidden, so Details/Files
// open as a full-screen overlay from here. Hidden at lg+ where the rail shows.
export function ShellSessionHeader({
  session,
  meta,
  selectedId,
  participants,
  onSelect,
  onRename,
  onShare,
  onDelete,
  onLeave,
}: {
  session: SessionInfo | null;
  meta: SessionMeta;
  selectedId: string | null;
  participants: PresenceParticipant[];
  onSelect: (id: string) => void;
  onRename: (name: string) => Promise<void>;
  onShare: () => void;
  onDelete: () => Promise<void>;
  /** Peer-only: leave the shared session (drops access, needs a fresh admit to
   * return). Undefined for the host, who deletes rather than leaves. */
  onLeave?: () => Promise<void>;
}) {
  const { sessions } = useSessions();
  const { openMobile } = useFilesUI();
  // Mount-gated: the server always reads as host, so default to host until
  // mounted to keep hydration stable (see participant.ts).
  const mounted = useMounted();
  const isHost = mounted ? isHostClient() : true;
  const isPeer = mounted && isPeerClient();
  // Host OR a full-capability peer (co-host) may open the Share dialog to
  // mint/manage links. Defaults to true pre-mount (server renders as host).
  const canShare = mounted ? canAdmitPeers() : true;
  // Only the host or a full-access peer may turn auto mode off — same capability
  // that decides tool permissions. Other peers see a static (read-only) pill.
  const canToggleAuto = mounted ? canDecidePermissions() : true;
  const { setAutoMode } = useActiveSession();
  // Per-session notification muting. `isMuted` folds in the global mute, so ask
  // for the two separately: the bell needs to distinguish "you muted this one"
  // from "everything is muted elsewhere" to explain itself.
  const { state: pushState, globalMuted, isMuted, setSessionMuted } = useNotifications();
  const notificationsOn = pushState === "on";
  const sessionMuted = isMuted(session?.sessionId ?? session?.id);
  // For a peer, name the host from the presence roster ("shared by X").
  const hostName = participants.find((p) => p.kind === "host")?.name ?? null;
  const { fullscreen, toggle: toggleFullscreen } = useCenterFullscreen();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [peersOpen, setPeersOpen] = useState(false);
  // Horizontal nudge applied to the peers popover so it stays on-screen — the
  // presence stack sits mid-header, not at an edge, so a fixed left-0 anchor
  // runs off the right side of narrow (phone-width) viewports.
  const [peersPanelShift, setPeersPanelShift] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The ⋯ menu lives in the right-side actions cluster, OUTSIDE wrapRef, so it
  // needs its own ref: without it a `mousedown` on a menu item counts as an
  // "outside" click and tears the menu down before the item's `click` fires —
  // i.e. Delete session silently no-ops for real (mousedown-first) clicks.
  const menuRef = useRef<HTMLDivElement>(null);
  // Presence stack also lives outside wrapRef — same reasoning, its own ref.
  const peersRef = useRef<HTMLDivElement>(null);

  const label = session ? sessionDisplayLabel(session) : "session";
  const lc = meta.lifecycle ?? session?.lifecycle ?? null;
  const dot = lifecycleDot(lc);
  // The "live" pill means broadcasting (tunnel up + a share exists), NOT the
  // session's own lifecycle — see useSharingLive.
  const live = useSharingLive();

  useEffect(() => {
    if (!switcherOpen && !menuOpen && !peersOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      const inWrap = wrapRef.current?.contains(target);
      const inMenu = menuRef.current?.contains(target);
      const inPeers = peersRef.current?.contains(target);
      if (!inWrap && !inMenu && !inPeers) {
        setSwitcherOpen(false);
        setMenuOpen(false);
        setPeersOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [switcherOpen, menuOpen, peersOpen]);

  // Clamp the peers popover to stay within the viewport. Runs before paint so
  // there's no visible jump: measure the trigger's position at the popover's
  // default (unshifted) left-0 anchor, then nudge it left just enough to clear
  // the right edge — and never past the left edge either. No reset-on-close
  // branch needed: the panel unmounts when closed, and reopening always
  // recomputes the shift fresh before the next paint.
  useLayoutEffect(() => {
    if (!peersOpen) return;
    const trigger = peersRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const unshiftedRight = rect.left + PEERS_PANEL_WIDTH;
    let shift = 0;
    if (unshiftedRight > window.innerWidth - VIEWPORT_EDGE_MARGIN) {
      shift = window.innerWidth - VIEWPORT_EDGE_MARGIN - unshiftedRight;
    }
    if (rect.left + shift < VIEWPORT_EDGE_MARGIN) {
      shift = VIEWPORT_EDGE_MARGIN - rect.left;
    }
    setPeersPanelShift(shift);
  }, [peersOpen]);

  const alives = sessions.filter((s) => (s.lifecycle ?? "alive") === "alive" && s.sessionId);
  const inactives = sessions.filter(
    (s) => s.sessionId && ["dormant", "ended"].includes(s.lifecycle ?? "alive"),
  );

  function commitRename() {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== label) void onRename(name);
  }

  return (
    <div className="px-3 sm:px-5 h-14 shrink-0 flex items-center gap-2 sm:gap-3 border-b border-divider">
      {/* Peers get nothing before the presence stack on phones — the session
        * name/switcher are host-oriented chrome that just eats space there.
        * Same "phone" cutoff (< md) as the cwd chip below. */}
      <div
        ref={wrapRef}
        className={cn("relative flex items-center gap-1.5 min-w-0", isPeer && "max-md:hidden")}
      >
        <span className={cn("w-2 h-2 rounded-full shrink-0", dot.cls)} title={dot.title} />
        {renaming ? (
          <input
            autoFocus
            aria-label="Rename session"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setRenaming(false);
            }}
            className="field text-[15px] font-semibold px-2 py-0.5 max-w-[16rem]"
          />
        ) : (
          <button
            className="truncate text-[15px] font-semibold text-ink"
            title="Rename"
            onClick={() => {
              if (!session) return;
              setDraft(label);
              setRenaming(true);
            }}
          >
            {label}
          </button>
        )}
        {isHost && session && (
          <button
            className="icon-btn w-6 h-6"
            title="Switch session"
            onClick={() => {
              setSwitcherOpen((v) => !v);
              setMenuOpen(false);
              setPeersOpen(false);
            }}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        )}
        {switcherOpen && (
          <div className="absolute left-0 top-full mt-1.5 z-30 w-64 rounded-xl p-1.5 bg-elevated border border-divider shadow-card">
            <div className="section-title px-2 pt-1 pb-1">Active</div>
            {alives.length === 0 && <div className="px-2 py-1 text-[11px] text-ink-faint">none</div>}
            {alives.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => {
                  onSelect(s.sessionId!);
                  setSwitcherOpen(false);
                }}
                className={cn(
                  "list-row w-full text-left flex items-center gap-2 px-2 py-1.5",
                  s.sessionId === selectedId && "is-active",
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", s.turnActive ? "bg-live" : "bg-wrap")} />
                <span className="flex-1 truncate text-[12.5px] text-ink-soft">
                  {sessionDisplayLabel(s)}
                </span>
                {s.sessionId === selectedId && <Check className="w-3.5 h-3.5 shrink-0 text-accent" />}
              </button>
            ))}
            {inactives.length > 0 && <div className="section-title px-2 pt-2 pb-1">Inactive</div>}
            {inactives.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => {
                  onSelect(s.sessionId!);
                  setSwitcherOpen(false);
                }}
                className="list-row w-full text-left flex items-center gap-2 px-2 py-1.5"
              >
                <span className="flex-1 truncate text-[12.5px] italic text-ink-mute">
                  {sessionDisplayLabel(s)}
                </span>
                <span className="font-mono text-[10px] text-ink-faint shrink-0">
                  {s.lifecycle ?? "dormant"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {isPeer && (
        <span
          className="chip text-[10px] px-2 py-0.5 ml-0.5 shrink-0 max-md:hidden"
          style={{
            background: "color-mix(in oklab, rgb(var(--sdk)) 16%, transparent)",
            color: "rgb(var(--sdk))",
          }}
        >
          shared{hostName ? ` by ${hostName}` : ""}
        </span>
      )}

      {/* presence: click the stack (an avatar or the +N overflow) to see the
        * full roster in a popover — mirrors the switcher/⋯ menu pattern above. */}
      {participants.length > 0 && (
        <div ref={peersRef} className="relative flex items-center gap-1.5 pl-1 shrink-0">
          <button
            type="button"
            className="flex -space-x-2"
            title="View participants"
            aria-label="View participants"
            aria-haspopup="true"
            aria-expanded={peersOpen}
            onClick={() => {
              setPeersOpen((v) => !v);
              setSwitcherOpen(false);
              setMenuOpen(false);
            }}
          >
            {participants.slice(0, PRESENCE_AVATAR_LIMIT).map((p) => (
              <span
                key={p.participantId}
                className={cn(
                  "avatar w-6 h-6 text-[9px] ring-2 ring-center transition-opacity",
                  p.kind === "peer" && "avatar-sdk",
                  // Dimmed = backgrounded/idle but still connected (NOT left).
                  p.away && "opacity-40",
                )}
                title={p.away ? `${p.name} (away)` : p.name}
              >
                {p.name.slice(0, 2).toUpperCase()}
              </span>
            ))}
            {participants.length > PRESENCE_AVATAR_LIMIT && (
              <span
                className="avatar w-6 h-6 text-[9px] ring-2 ring-center"
                title={`+${participants.length - PRESENCE_AVATAR_LIMIT} more`}
              >
                +{participants.length - PRESENCE_AVATAR_LIMIT}
              </span>
            )}
          </button>
          {peersOpen && (
            <div
              className="absolute left-0 top-full mt-1.5 z-30 w-56 rounded-xl p-1.5 bg-elevated border border-divider shadow-card"
              style={peersPanelShift ? { transform: `translateX(${peersPanelShift}px)` } : undefined}
            >
              <div className="section-title px-2 pt-1 pb-1">
                Participants ({participants.length})
              </div>
              <div className="max-h-64 overflow-y-auto">
                {participants.map((p) => (
                  <div key={p.participantId} className="list-row w-full flex items-center gap-2 px-2 py-1.5">
                    <span
                      className={cn(
                        "avatar w-6 h-6 text-[9px] ring-2 ring-center shrink-0 transition-opacity",
                        p.kind === "peer" && "avatar-sdk",
                        p.away && "opacity-40",
                      )}
                    >
                      {p.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="flex-1 truncate text-[12.5px] text-ink-soft">
                      {p.name}
                      {p.away ? " (away)" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {meta.cwd && (
        // `!hidden` (important) because the unlayered `.chip { display:inline-flex }`
        // component rule outranks Tailwind's layered `hidden` — a plain `hidden`
        // here is silently ignored. Hidden below md to declutter the phone header.
        // Shows only the leaf dir name — the full path is a sandbox-internal
        // session workdir (SESSIONS_ROOT/<sessionId>/...) that's meaningless
        // (and needlessly revealing) to show verbatim; still available via title.
        <span
          className="chip font-mono text-[10px] px-2 py-1 text-ink-faint max-md:!hidden ml-1 max-w-[18rem] truncate"
          title={meta.cwd}
        >
          {cwdBasename(meta.cwd)}
        </span>
      )}

      <div className="ml-auto shrink-0 flex items-center gap-1 sm:gap-1.5">
        {meta.autoMode && (
          // Unattended auto-approval is on. A privileged viewer gets an inline ✕
          // to turn it off; others see a static indicator (the sandbox refuses
          // their toggle anyway). Amber "live" cue so it reads as an active state.
          <span
            className="pill-btn text-[10px] uppercase tracking-wide px-2 sm:px-2.5 py-1.5 inline-flex items-center gap-1"
            // Inline color: .pill-btn hard-sets `color` as an unlayered component
            // rule, which outranks the layered `text-live` utility — so the amber
            // accent only sticks when applied inline.
            style={{ color: "rgb(var(--live))" }}
            title="Auto mode: routine tools run without asking. git and destructive commands still require approval."
          >
            <Zap className="w-3 h-3 shrink-0" />
            {/* Label is dropped on narrow (mobile) headers to save width — the
              * icon + amber cue carry the meaning; text returns at sm+. */}
            <span className="hidden sm:inline">Auto mode</span>
            {canToggleAuto && (
              <button
                type="button"
                className="ml-0.5 -mr-0.5 rounded hover:bg-elevated p-0.5"
                title="Turn off auto mode"
                aria-label="Turn off auto mode"
                onClick={() => void setAutoMode(false)}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </span>
        )}
        {live && (
          <span className="pill-btn text-[10px] uppercase tracking-wide px-2 sm:px-2.5 py-1.5 text-wrap">
            <span className="w-1.5 h-1.5 rounded-full bg-wrap motion-safe:animate-pulse" /> live
          </span>
        )}
        {/* Mute this session's notifications. Only shown once this browser is
          * actually enrolled — a bell that silences nothing is just confusing.
          * Enrolling lives in Settings, because the permission prompt has to be
          * a deliberate act rather than something you trip over in a header. */}
        {notificationsOn && session && (
          <button
            type="button"
            className="icon-btn w-8 h-8"
            aria-pressed={sessionMuted}
            title={
              globalMuted
                ? "All notifications are muted in Settings"
                : sessionMuted
                  ? "Notifications muted for this session — click to unmute"
                  : "Mute notifications for this session"
            }
            aria-label={sessionMuted ? "Unmute notifications for this session" : "Mute notifications for this session"}
            // The global mute already covers this session, so toggling the
            // per-session flag underneath it would change nothing visible.
            disabled={globalMuted}
            onClick={() => {
              const id = session.sessionId ?? session.id;
              if (id) void setSessionMuted(id, !sessionMuted);
            }}
          >
            {sessionMuted || globalMuted ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
          </button>
        )}
        {canShare && session && (
          <button className="icon-btn w-8 h-8" title="Share" onClick={onShare}>
            <Share2 className="w-4 h-4" />
          </button>
        )}
        {/* Expand/restore the main frame (collapse the desktop rails). A no-op
          * on phones — the rails are already hidden there — so hide it below lg.
          * `!hidden` (important) is required: the unlayered `.icon-btn`
          * `display:inline-flex` outranks Tailwind's layered `hidden`, so a plain
          * `hidden` would be silently ignored and the button would still show. */}
        <button
          className="icon-btn w-8 h-8 max-lg:!hidden"
          title={fullscreen ? "Restore rails" : "Expand chat"}
          aria-label={fullscreen ? "Restore rails" : "Expand chat"}
          aria-pressed={fullscreen}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
        {isHost && session && (
          <div ref={menuRef} className="relative">
            <button
              className="icon-btn w-8 h-8"
              title="More"
              onClick={() => {
                setMenuOpen((v) => !v);
                setSwitcherOpen(false);
                setPeersOpen(false);
              }}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1.5 z-30 w-40 rounded-xl p-1.5 bg-elevated border border-divider shadow-card">
                <MobileViewItems
                  onPick={(v) => {
                    setMenuOpen(false);
                    openMobile(v);
                  }}
                />
                <button
                  className="list-row w-full text-left px-2 py-1.5 text-[12px] text-fail"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmDelete(true);
                  }}
                >
                  Delete session
                </button>
              </div>
            )}
          </div>
        )}
        {/* Peer counterpart: a guest can LEAVE (relinquish access) but never
          * delete/rename — those are host-only and refused server-side. */}
        {isPeer && onLeave && (
          <div ref={menuRef} className="relative">
            <button
              className="icon-btn w-8 h-8"
              title="More"
              onClick={() => {
                setMenuOpen((v) => !v);
                setSwitcherOpen(false);
                setPeersOpen(false);
              }}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1.5 z-30 w-40 rounded-xl p-1.5 bg-elevated border border-divider shadow-card">
                <MobileViewItems
                  onPick={(v) => {
                    setMenuOpen(false);
                    openMobile(v);
                  }}
                />
                <button
                  className="list-row w-full text-left px-2 py-1.5 text-[12px] text-fail"
                  onClick={() => {
                    setMenuOpen(false);
                    if (confirm("Leave this session? You'll need the host to admit you again to return.")) void onLeave();
                  }}
                >
                  Leave session
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDeleteSessionModal
        open={confirmDelete}
        sessionName={label}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void onDelete();
        }}
      />
    </div>
  );
}
