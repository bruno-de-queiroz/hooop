"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useActiveSession } from "@/app/context/ActiveSessionProvider";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { useFilesUI } from "@/app/context/FilesUIProvider";
import { useSessions } from "@/app/context/SessionsProvider";
import { usePresence } from "@/app/context/hooks/usePresence";
import { Button } from "../ui";
import { ShellSessionHeader } from "./ShellSessionHeader";
import { ShellStatsStrip } from "./ShellStatsStrip";
import { ShellTranscript } from "./ShellTranscript";
import { ShellComposer } from "./ShellComposer";
import { ShellPermissions } from "./ShellPermissions";
import { ShellPlanReviewCard } from "./ShellPlanReviewCard";
import { ShellAskQuestion } from "./ShellAskQuestion";
import { ShellFilesReviewPill } from "./files/ShellFilesReviewPill";
import { ShellShareModal } from "./ShellShareModal";
import { ShellNewSession } from "./ShellNewSession";
import { myDisplayName, isPeerClient, useMounted } from "../lib/participant";

// Center pane (Phase 3): the active session rendered as a chat thread + composer
// (mockup's center). Reads everything from the providers — header, stats,
// transcript, and composer are all shell components. No selection → the "start a
// session" empty state (shell-native new-session form).

export function ShellCenterPane() {
  const active = useActiveSession();
  const { selectedId, setSelected } = useSelectedSession();
  const { sessions, deleteSession } = useSessions();
  const { participants, setTyping } = usePresence(selectedId);
  const [shareOpen, setShareOpen] = useState(false);
  // Peers reach the share dialog in peerMode (no tunnel control; only full peers
  // ever see the trigger). Mount-gated to keep hydration stable.
  const mounted = useMounted();
  const peerMode = mounted && isPeerClient();

  // Viewer identity for viewer-relative bubble color (my turns green, everyone
  // else blue). Mount-gated: the participant readers are browser-only, so the
  // first client render must match the server's host default (see participant.ts).
  const viewerKind: "host" | "peer" = peerMode ? "peer" : "host";
  const viewerName = mounted ? myDisplayName() : "Host";

  // OTHER participants currently composing → the `...` peer bubble in the
  // transcript (replaces the header "typing…" text). Exclude self by identity so
  // my own typing never shows as a bubble to me.
  const typingLabel = participants
    .filter((p) => p.typing && !(p.kind === viewerKind && p.name === viewerName))
    .map((p) => p.name)
    .join(", ");
  // Stable so the memoized transcript isn't re-rendered by every presence beat.
  const onLoadMore = useCallback(() => void active.loadMore(), [active]);

  // Clicking a `#file` chip in the transcript opens the navigator AND the
  // preview — the same three moves the "files to review" pill makes, and
  // deliberately NOT openMobile: like that pill, a chip has no browsed list
  // behind it, so forcing the full-screen tree open would leave it dangling
  // under the dock (see ShellFilesReviewPill's note).
  //
  // All three actions are stable (raw setters / useCallback in FilesUIProvider)
  // and selectedId only changes on a session switch, so this callback keeps its
  // identity and never defeats ShellTranscript's memo.
  const { setView, setRailCollapsed, openFile } = useFilesUI();
  const onOpenMention = useCallback(
    ({ path }: { path: string; line: number | null }) => {
      if (!selectedId) return;
      setView("files");
      setRailCollapsed(false);
      openFile({ sessionId: selectedId, path, name: path.split("/").pop() || path });
    },
    [selectedId, setView, setRailCollapsed, openFile],
  );

  // Peer "Leave session": relinquish access. The route emits the leave marker,
  // drops presence, and clears the peer cookie — so returning needs a fresh
  // admit. Navigate to the terminal /left closing view (replace, so Back can't
  // re-open the now-cookieless session). NOT `/` — with the peer cookie gone
  // that renders the HOST new-session onboarding. Host has no leave (they
  // delete instead), so this is only wired for peers.
  const onLeave = useCallback(async () => {
    try {
      await fetch("/api/share/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: myDisplayName() }),
      });
    } catch { /* leave anyway — the cookie clear is best-effort UX */ }
    window.location.replace("/left");
  }, []);

  // Gate on selection ONLY (matching the legacy panel). A freshly-created
  // session is selected by its `pending-<id>` before it lands in the fs-backed
  // session list, so `active.session` is briefly null — we must still render the
  // session view (header + "waiting for first turn" + composer) rather than
  // bounce back to the create form. The composer can already write to the
  // pending id; the real session resolves moments later.
  if (!selectedId) {
    // A peer is pinned to one shared session and has no create-session flow —
    // the host create form must NEVER render for them (that's the dormant-share
    // bug: a peer briefly losing their selection would otherwise see "Start a
    // session"). Selection should stay pinned upstream; this is the last-resort
    // guard for any transient null. Use `isPeerClient()` directly (not the
    // mount-gated `peerMode`): the branch is never taken server-side for a peer
    // (middleware forces `?session`), so there's no hydration divergence.
    if (isPeerClient()) {
      return (
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center p-8 text-center">
          <p className="text-[13px] text-ink">Reconnecting to the shared session…</p>
          <p className="mt-1 text-[11px] text-ink-mute">
            Keep this tab open — it’ll come back on its own.
          </p>
        </div>
      );
    }
    return (
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center p-8">
        <ShellNewSession onCreated={(sid) => setSelected(sid)} />
      </div>
    );
  }

  // Git-clone sessions appear immediately (before the clone finishes) so the
  // rail never blocks on network I/O. Look up the row's lifecycle: while
  // "provisioning" there's nothing to compose/read yet, and on clone failure
  // ("error") the composer/transcript would just show an empty, unusable
  // thread — both get a dedicated full-pane state instead of falling through.
  const row = sessions.find(
    (s) => s.sessionId === selectedId || (s.aliases ?? []).includes(selectedId),
  );

  if (row?.lifecycle === "provisioning") {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center p-8 text-center gap-2">
        <Loader2 className="w-5 h-5 animate-spin text-ink-mute" />
        <p className="text-[13px] text-ink">Cloning repository…</p>
        <p className="text-[11px] text-ink-mute">Setting up the workspace…</p>
        <CloneProgressFrame text={row.cloneProgress} />
      </div>
    );
  }

  if (row?.lifecycle === "error") {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center p-8 text-center gap-3">
        <p className="text-[13px] text-fail max-w-md">
          {row?.error ?? "This session failed to start."}
        </p>
        <Button
          variant="pill"
          size="sm"
          className="border border-fail/40 bg-transparent text-fail hover:bg-fail/10 hover:text-fail"
          onClick={() => void deleteSession(selectedId)}
        >
          Delete session
        </Button>
      </div>
    );
  }

  return (
    <div className="relative z-[1] flex flex-col min-h-0 flex-1">
      <ShellSessionHeader
        session={active.session}
        meta={active.meta}
        selectedId={selectedId}
        participants={participants}
        onSelect={setSelected}
        onRename={active.rename}
        onShare={() => setShareOpen(true)}
        onDelete={active.remove}
        onLeave={onLeave}
      />
      <ShellStatsStrip stats={active.stats} model={active.meta.model} />
      <ShellTranscript
        events={active.events}
        hasMore={active.hasMore}
        onLoadMore={onLoadMore}
        isWaiting={active.isWaiting}
        viewerKind={viewerKind}
        viewerName={viewerName}
        typingLabel={typingLabel}
        onOpenMention={onOpenMention}
      />
      <ShellPlanReviewCard />
      <ShellPermissions />
      <ShellAskQuestion />
      <ShellFilesReviewPill />
      <ShellComposer setTyping={setTyping} />

      <ShellShareModal open={shareOpen} sessionId={selectedId} onClose={() => setShareOpen(false)} peerMode={peerMode} />
    </div>
  );
}

// Live `git clone --progress` output for the provisioning state — without it
// a multi-minute clone of a large repo looks frozen behind a bare spinner.
// Auto-scrolls to the newest line as updates stream in via the session list.
function CloneProgressFrame({ text }: { text?: string }) {
  const bodyRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  if (!text) return null;
  return (
    <pre
      ref={bodyRef}
      className="mt-2 w-full max-w-lg h-40 overflow-y-auto rounded-lg border border-divider bg-sunken px-3 py-2 text-left font-mono text-[10.5px] leading-relaxed text-ink-mute whitespace-pre-wrap break-all"
    >
      {text}
    </pre>
  );
}
