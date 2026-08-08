"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePendingPermissions } from "@/app/context/hooks/usePendingPermissions";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { useSessions } from "@/app/context/SessionsProvider";
import { useFilesUI } from "@/app/context/FilesUIProvider";
import type { PlanPanelProps } from "../PlanPanel";
import { sessionDisplayLabel } from "../lib/format";
import { canDecidePlans, canCommentOnPlans } from "../lib/participant";

// Shared shell-chrome state that spans the rails, the center header, and
// overlays — kept in context so those distant components stay in sync.
//
//  · CenterFullscreen — "expand the main frame": collapse both rails so the
//    center chat pane goes full-width (mockup's session-header maximize-2). Not
//    a window-level fullscreen.
//  · PlanReview — pending plans surface in the left rail's "Needs review"
//    section (mockup); clicking one opens the shared PlanPanel slide-over,
//    which this provider renders. A plan for the current session auto-opens.

// ── Center fullscreen ────────────────────────────────────────────────────────
interface CenterFullscreenValue {
  fullscreen: boolean;
  toggle: () => void;
}
export const CenterFullscreenContext = createContext<CenterFullscreenValue>({
  fullscreen: false,
  toggle: () => {},
});
export const useCenterFullscreen = () => useContext(CenterFullscreenContext);

// ── Plan review ──────────────────────────────────────────────────────────────
export interface PlanEntry {
  sessionId: string;
  requestId: string;
  title: string;
  label: string;
}
interface PlanReviewValue {
  plans: PlanEntry[];
  open: (requestId: string) => void;
}
const PlanReviewContext = createContext<PlanReviewValue | null>(null);
export function usePlanReview(): PlanReviewValue {
  const c = useContext(PlanReviewContext);
  if (!c) throw new Error("usePlanReview must be used within PlanReviewProvider");
  return c;
}

// The currently-open plan's fully-wired panel props, or null when none is open.
// The panel used to render as a fixed overlay from this provider; it now docks
// as a sibling column inside the shell's flex row (ShellPlanDock reads this).
const PlanPanelContext = createContext<PlanPanelProps | null>(null);
export function usePlanReviewPanel(): PlanPanelProps | null {
  return useContext(PlanPanelContext);
}

function planText(input: unknown): string {
  if (input && typeof input === "object" && "plan" in input) {
    const p = (input as { plan?: unknown }).plan;
    if (typeof p === "string") return p;
  }
  return "";
}

/** A short title for a plan: its first markdown heading, else its first line. */
function planTitle(plan: string): string {
  const lines = plan.split("\n").map((l) => l.trim());
  const heading = lines.find((l) => /^#{1,6}\s+/.test(l));
  const raw = (heading ?? lines.find((l) => l.length > 0) ?? "").replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "");
  const t = raw.trim();
  if (!t) return "Untitled plan";
  return t.length > 48 ? t.slice(0, 47) + "…" : t;
}

export function PlanReviewProvider({ children }: { children: React.ReactNode }) {
  const { pending, decide, errors } = usePendingPermissions();
  const { sessions } = useSessions();
  const { selectedId, setSelected } = useSelectedSession();
  const { closeFile } = useFilesUI();
  const canDecide = canDecidePlans();
  const canComment = canCommentOnPlans();
  const [openId, setOpenId] = useState<string | null>(null);
  // Plans closed without deciding — collapsed, won't auto-reopen.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const matches = (sid: string, sel: string | null) =>
    !!sel && (sid === sel || (sessions.find((s) => s.sessionId === sid)?.aliases ?? []).includes(sel));
  const labelFor = (sid: string) => {
    const s = sessions.find((x) => x.sessionId === sid || (x.aliases ?? []).includes(sid));
    return s ? sessionDisplayLabel(s) : sid.slice(0, 8);
  };

  const rawPlans = pending.filter((p) => p.request.toolName === "ExitPlanMode");
  const planIds = rawPlans.map((p) => p.request.requestId);
  const planKey = planIds.join("|");

  // Drop dismissed ids once their plan resolves.
  useEffect(() => {
    setDismissed((prev) => {
      const kept = new Set([...prev].filter((id) => planIds.includes(id)));
      return kept.size === prev.size ? prev : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  const plans = useMemo<PlanEntry[]>(
    () =>
      rawPlans.map((p) => ({
        sessionId: p.sessionId,
        requestId: p.request.requestId,
        title: planTitle(planText(p.request.input)),
        label: labelFor(p.sessionId),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planKey, sessions],
  );

  // Latest plans/selection read through refs so `open` stays identity-stable
  // (it's handed to distant buttons via context; recreating it each render would
  // churn their memoized subtrees).
  const rawPlansRef = useRef(rawPlans);
  rawPlansRef.current = rawPlans;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  // Is `sid` the session the user is currently viewing (directly or via alias)?
  const isForSelected = useCallback((sid: string) => {
    const sel = selectedRef.current;
    if (!sel) return false;
    if (sid === sel) return true;
    const s = sessionsRef.current.find((x) => x.sessionId === sid);
    return (s?.aliases ?? []).includes(sel);
  }, []);

  // Opening a plan from the left rail switches to its session first when it's
  // not the one on screen — the docked panel always shows the plan next to its
  // own conversation, never beside an unrelated session.
  const open = useCallback(
    (requestId: string) => {
      const p = rawPlansRef.current.find((x) => x.request.requestId === requestId);
      if (p && !isForSelected(p.sessionId)) setSelected(p.sessionId);
      // The docked slot is shared and the file preview takes precedence over the
      // plan, so explicitly reviewing a plan must close any open preview — else
      // the click would appear to do nothing (the file would stay on top).
      closeFile();
      setOpenId(requestId);
    },
    [isForSelected, setSelected, closeFile],
  );
  const value = useMemo<PlanReviewValue>(() => ({ plans, open }), [plans, open]);

  // The plan to actually display, derived (NOT via an effect) so it resolves in
  // the same render the selection changes in: the explicitly-opened plan when it
  // belongs to the session on screen, otherwise that session's own pending plan
  // (auto-surfaced) unless it was dismissed. Deriving synchronously is what keeps
  // a plan→plan switch a clean content swap — an effect would first null the
  // panel for one frame, making the dock collapse-then-reopen (a jarring width
  // animation between two plans).
  const openPlan = useMemo(() => {
    if (openId) {
      const cur = rawPlans.find((p) => p.request.requestId === openId);
      if (cur && matches(cur.sessionId, selectedId)) return cur;
    }
    return rawPlans.find((p) => !dismissed.has(p.request.requestId) && matches(p.sessionId, selectedId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, planKey, dismissed, selectedId, sessions]);

  // Fully-wired props for the docked panel (ShellPlanDock renders it). Null when
  // nothing is open so the dock collapses out of the flex row.
  const panelProps = useMemo<PlanPanelProps | null>(() => {
    // openPlan is already scoped to the selected session, so it's null whenever
    // the current session has no plan to show — the dock collapses out then.
    if (!openPlan) return null;
    const sid = openPlan.sessionId;
    const rid = openPlan.request.requestId;
    return {
      sessionId: sid,
      requestId: rid,
      plan: planText(openPlan.request.input),
      sessionLabel: labelFor(sid),
      canDecide,
      canComment,
      error: errors[rid] ?? null,
      onApprove: async () => {
        await decide(sid, rid, "allow");
        setOpenId(null);
      },
      onReject: async (feedback: string) => {
        await decide(sid, rid, "deny", "once", feedback);
        setOpenId(null);
      },
      onClose: () => {
        setDismissed((prev) => new Set(prev).add(rid));
        setOpenId(null);
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPlan, canDecide, canComment, errors, decide]);

  return (
    <PlanReviewContext.Provider value={value}>
      <PlanPanelContext.Provider value={panelProps}>{children}</PlanPanelContext.Provider>
    </PlanReviewContext.Provider>
  );
}
