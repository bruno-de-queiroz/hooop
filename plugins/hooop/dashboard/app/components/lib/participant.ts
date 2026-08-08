"use client";

import { useEffect, useState } from "react";

/**
 * Client-side view of "who am I" for the shared-session UI. The layout emits a
 * non-secret `<meta name="x-hooop-participant">` (host | peer | none) which
 * middleware resolved server-side. The peer's chosen display name is stashed in
 * sessionStorage by the /join redemption flow.
 *
 * HYDRATION: every reader below is browser-only (a `<meta>` read via `document`,
 * or sessionStorage). During SSR they can't see either, so they answer with the
 * defaults ("host" / "Host") no matter who is actually viewing. A component that
 * calls them DURING RENDER therefore renders one thing on the server and another
 * on the client — a hydration mismatch (React #418/#423/#425). Observed live:
 * the composer avatar rendered "H" server-side vs "B" client-side
 * (sessionStorage hooop_host_name="Bruno"), which broke hydration for the whole
 * session view. Render-path callers must gate on `useMounted()` (below).
 */

const PEER_NAME_KEY = "hooop_peer_name";

/**
 * False on the server AND on the first client render, true afterwards. Gate any
 * render-time use of the browser-only readers here on it, so the first client
 * render matches the server and the real value lands on the next paint:
 *
 *   const mounted = useMounted();
 *   const me = initials(mounted ? myDisplayName() : "Host");
 *
 * Deliberately a mount FLAG rather than a `useState`+`useEffect` snapshot of the
 * value: the readers are re-read on every render, so a late `stashHostName()`
 * (identity resolves after mount) still surfaces on the next render. Snapshotting
 * once at mount would freeze the name at its pre-identity default.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return mounted;
}

export function participantKind(): "host" | "peer" | "none" {
  if (typeof document === "undefined") return "host";
  const meta = document.querySelector("meta[name='x-hooop-participant']");
  // The layout always injects this meta. If it's ABSENT (a non-layout render,
  // e.g. a unit test, or a degraded page) default to "host" — host-only
  // actions are enforced server-side regardless, so this only affects which
  // controls a local/owner UI shows. An EXPLICIT "peer"/"none" is honored.
  if (!meta) return "host";
  const v = meta.getAttribute("content");
  return v === "host" || v === "peer" || v === "none" ? v : "host";
}

export function isHostClient(): boolean {
  return participantKind() === "host";
}

export function isPeerClient(): boolean {
  return participantKind() === "peer";
}

/** The session a peer is locked to (from the layout-injected meta), or null. */
export function peerSessionId(): string | null {
  if (typeof document === "undefined") return null;
  const v = document.querySelector("meta[name='x-hooop-peer-session']")?.getAttribute("content");
  return v && v.length > 0 ? v : null;
}

/** The peer's share capability from the layout-injected meta, or null (host /
 * no meta). One of "full" | "drive" | "spectate". */
export function peerCapability(): "full" | "drive" | "spectate" | null {
  if (typeof document === "undefined") return null;
  const v = document.querySelector("meta[name='x-hooop-peer-capability']")?.getAttribute("content");
  return v === "full" || v === "drive" || v === "spectate" ? v : null;
}

/** Short display label for a share capability, for the collapsed left rail's
 * peer avatar tooltip — deliberately terse (unlike the fuller wording in the
 * admission toast / share modal / shared-session panel, which each have room
 * for a hint sentence too). */
export const CAPABILITY_LABEL: Record<"full" | "drive" | "spectate", string> = {
  full: "Full co-drive",
  drive: "Drive",
  spectate: "Spectate",
};

/** May this viewer approve/reject a plan? The host always can; a peer only with
 * a "full" share. Mirrors the sandbox capability gate (which is authoritative —
 * this only decides whether to SHOW the decision controls). */
export function canDecidePlans(): boolean {
  if (participantKind() !== "peer") return true; // host / owner UI
  return peerCapability() === "full";
}

/** May this viewer allow/deny a generic tool-permission ask? The host always
 * can; a peer only with a "full" share (drive/spectate wait for the host to
 * decide). Mirrors the sandbox capability gate (authoritative — this only
 * decides whether to SHOW the decision controls vs. a "waiting" note). */
export function canDecidePermissions(): boolean {
  if (participantKind() !== "peer") return true; // host / owner UI
  return peerCapability() === "full";
}

/** May this viewer admit/deny pending peer joins? The host always can; a peer
 * only with a "full" share (drive/spectate cannot). Mirrors the sandbox gate
 * (authoritative — this only decides whether to SHOW the admission toast). */
export function canAdmitPeers(): boolean {
  if (participantKind() !== "peer") return true; // host / owner UI
  return peerCapability() === "full";
}

/** May this viewer add plan-review comments/replies? The host always can; a
 * peer needs turn capability (full or drive) — a spectate share is view-only.
 * Mirrors the sandbox gate (checkParticipant "turn", authoritative). */
export function canCommentOnPlans(): boolean {
  if (participantKind() !== "peer") return true; // host / owner UI
  const cap = peerCapability();
  return cap === "full" || cap === "drive";
}

/** May this viewer answer the agent's AskUserQuestion asks? The host always
 * can; a peer can unless they're spectate-only (answering is input, so it needs
 * turn capability). Mirrors the sandbox gate (authoritative). */
export function canAnswerQuestions(): boolean {
  if (participantKind() !== "peer") return true; // host / owner UI
  const cap = peerCapability();
  return cap === "full" || cap === "drive";
}

/** May this viewer add @file references (from the Files navigator, the preview
 * header, or a line click)? A reference is an input action — it's folded into
 * the outgoing message — so a peer needs turn capability (full or drive); a
 * spectate share is view-only and must not add references anywhere. Host always
 * can. This only decides whether to SHOW the affordances; the composer itself
 * is already read-only for spectators. */
export function canInsertReferences(): boolean {
  if (participantKind() !== "peer") return true; // host / owner UI
  const cap = peerCapability();
  return cap === "full" || cap === "drive";
}

/**
 * Remember the peer's chosen name, in BOTH stores.
 *
 * sessionStorage is per TAB, and only the tab that performed the join ever had
 * the name. Open the session in a second tab, let the browser restore it, or
 * follow the link again on a phone, and myDisplayName fell back to "Guest" —
 * which then labelled that person's own messages GUEST and, because the real
 * event comes back under their actual name, stopped their optimistic row from
 * ever reconciling with it.
 *
 * localStorage is per browser, which is the right lifetime for "who am I". The
 * session copy is kept and read first so a tab that joined as somebody else
 * stays that person.
 */
export function stashPeerName(name: string): void {
  try { sessionStorage.setItem(PEER_NAME_KEY, name); } catch { /* ignore */ }
  try { localStorage.setItem(PEER_NAME_KEY, name); } catch { /* ignore */ }
}

const HOST_NAME_KEY = "hooop_host_name";

/** First token of a full name ("Bruno Queiroz" → "Bruno"). */
function firstNameOf(full: string): string {
  return full.trim().split(/\s+/)[0] ?? "";
}

/** Stash the host's first name (from /api/identity) so presence advertises the
 * person, not the generic "Host", to peers. Called once the identity loads. */
export function stashHostName(fullName: string): void {
  const first = firstNameOf(fullName);
  try {
    if (first) sessionStorage.setItem(HOST_NAME_KEY, first);
  } catch { /* ignore */ }
}

/** Display name to advertise in presence. Host → their first name (once known,
 * else "Host"); peer → the name they picked at join. */
export function myDisplayName(): string {
  const kind = participantKind();
  if (kind === "host") {
    try {
      const n = sessionStorage.getItem(HOST_NAME_KEY);
      if (n && n.trim()) return n.trim();
    } catch { /* ignore */ }
    return "Host";
  }
  try {
    const n = sessionStorage.getItem(PEER_NAME_KEY);
    if (n && n.trim()) return n.trim();
  } catch { /* ignore */ }
  // This tab did not do the joining. Nothing about being a second tab makes
  // somebody anonymous, and "Guest" here is not merely an ugly label: it is a
  // different identity from the one the server attributes their turns to.
  try {
    const n = localStorage.getItem(PEER_NAME_KEY);
    if (n && n.trim()) return n.trim();
  } catch { /* ignore */ }
  return "Guest";
}
