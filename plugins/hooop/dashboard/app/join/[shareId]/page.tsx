"use client";

import { useEffect, useRef, useState } from "react";
import { stashPeerName } from "@/app/components/lib/participant";
import { Loader2, Check, X } from "lucide-react";
import { Button, Field, Input } from "@/app/components/ui";
import { HooopMark } from "@/app/components/shell/HooopLogo";

/**
 * Share-link landing page. The peer token rides in the URL FRAGMENT
 * (`#k=<token>`) so it never reaches the server/logs/Referer.
 *
 * The peer names THEMSELVES here first: the nickname is collected before we
 * redeem, so the host's admit prompt shows who is asking to join (and that
 * name becomes the peer's attribution + presence identity). After they submit,
 * we redeem into a PENDING join, poll while the host decides, then claim the
 * peer cookie and enter the session.
 */
type Phase = "name" | "redeeming" | "waiting" | "admitted" | "error";

const POLL_MS = 2000;

function tokenFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("k");
}

export default function JoinPage() {
  const [phase, setPhase] = useState<Phase>("name");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  // Whether the URL fragment carries a token — resolved AFTER mount so the
  // server-rendered and first client render agree (no hydration mismatch).
  const [missingToken, setMissingToken] = useState(false);
  const cancelledRef = useRef(false);
  const startedRef = useRef(false);

  useEffect(() => { setMissingToken(!tokenFromHash()); }, []);

  const spinning = phase === "redeeming" || phase === "waiting" || phase === "admitted";

  async function start() {
    const token = tokenFromHash();
    if (!token) {
      setPhase("error");
      setMessage("This share link is missing its access token.");
      return;
    }
    const nickname = name.trim();
    if (!nickname) return; // required — the host needs to know who's entering
    if (startedRef.current) return;
    startedRef.current = true;
    // Strip the token from the visible URL immediately; keep it in memory.
    try { window.history.replaceState(null, "", window.location.pathname); } catch { /* ignore */ }

    const genericErr = "This share link is invalid, expired, or has been revoked.";
    const fail = (msg: string) => { if (!cancelledRef.current) { setPhase("error"); setMessage(msg); } };

    function enterSession(sessionId?: string, peerName?: string | null) {
      // Stash the peer's OWN chosen name for presence (myDisplayName reads it).
      stashPeerName(peerName || nickname);
      window.location.replace(sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/");
    }

    setPhase("redeeming");
    setMessage("Requesting access…");

    // 1. Redeem → creates a pending join carrying the peer's nickname.
    let ticketId: string, sessionId: string | undefined, peerName: string | null | undefined;
    try {
      const res = await fetch("/api/share/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: nickname }),
      });
      if (!res.ok) return fail(res.status === 401 ? genericErr : "Could not request access. Ask for a fresh link.");
      const data = (await res.json()) as { ticketId?: string; sessionId?: string; peerName?: string | null };
      if (!data.ticketId) return fail(genericErr);
      ticketId = data.ticketId;
      sessionId = data.sessionId;
      peerName = data.peerName;
    } catch {
      return fail("Network error while requesting access. Check your connection and retry.");
    }
    if (cancelledRef.current) return;

    setPhase("waiting");
    setMessage("Waiting for the host to let you in…");

    // 2. Poll until the host admits, or the request stops being valid. Denial
    // revokes the whole share (hostile by design), so the peer sees the same
    // neutral "no longer valid" message as an expiry — we don't disclose which.
    while (!cancelledRef.current) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (cancelledRef.current) return;
      let status: string;
      try {
        const r = await fetch(`/api/share/join-status?ticket=${encodeURIComponent(ticketId)}`);
        status = ((await r.json()) as { status?: string }).status ?? "expired";
      } catch {
        continue; // transient — keep polling
      }
      if (status === "admitted") break;
      if (status === "denied" || status === "expired") {
        return fail("This link is no longer valid. Ask the host for a fresh one.");
      }
    }
    if (cancelledRef.current) return;

    // 3. Claim → issues the peer cookie, then enter the session.
    setPhase("admitted");
    setMessage("Admitted — connecting…");
    try {
      const res = await fetch("/api/share/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ticketId }),
      });
      if (!res.ok) return fail("Could not complete the join. Ask the host for a fresh link.");
      const data = (await res.json()) as { sessionId?: string; peerName?: string | null };
      enterSession(data.sessionId ?? sessionId, data.peerName ?? peerName);
    } catch {
      return fail("Network error while connecting. Check your connection and retry.");
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-bg text-ink-soft p-6">
      {/* hooop logotype — brand mark + wordmark, mirrors the leave screen */}
      <div className="flex items-center gap-1.5 mb-8">
        <HooopMark size={22} />
        <span className="font-display text-[20px] font-bold tracking-tight text-ink">hooop</span>
      </div>

      <div className="w-full max-w-sm rounded-card bg-window border border-divider p-6 shadow-overlay">
        {phase === "name" ? (
          <>
            <h2 className="font-display text-[16px] font-semibold text-ink">Join the session</h2>
            <p className="mt-1 text-xs text-ink-mute leading-relaxed">
              Pick a name so the host knows who’s asking to join. The host has to admit you first.
            </p>
            <div className="mt-4">
              <Field label="Your name">
                <Input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void start(); }}
                  maxLength={80}
                  placeholder="how you’ll appear to the host"
                  disabled={missingToken}
                />
              </Field>
            </div>
            <Button
              variant="accent"
              onClick={() => void start()}
              disabled={!name.trim() || missingToken}
              className="w-full mt-4 py-2.5 font-semibold"
            >
              Request to join
            </Button>
            {missingToken ? (
              <p className="mt-3 text-center text-[11px] text-fail">
                This share link is missing its access token.
              </p>
            ) : (
              <p className="mt-3 text-center text-[10px] text-ink-hush">
                The host must approve before you can enter.
              </p>
            )}
          </>
        ) : phase === "redeeming" ? (
          <div className="flex flex-col items-center text-center py-4">
            <Loader2 className="w-7 h-7 animate-spin text-sdk" aria-hidden />
            <p className="mt-3 text-[13px] text-ink">{message}</p>
          </div>
        ) : phase === "waiting" ? (
          <div className="flex flex-col items-center text-center py-4">
            <Loader2 className="w-7 h-7 animate-spin text-accent" aria-hidden />
            <p className="mt-3 text-[13px] text-ink">Waiting for the host to let you in…</p>
            <p className="mt-1 text-[11px] text-ink-mute">Keep this tab open.</p>
          </div>
        ) : phase === "admitted" ? (
          <div className="flex flex-col items-center text-center py-4">
            <span className="w-9 h-9 rounded-full flex items-center justify-center bg-wrap/20 text-wrap">
              <Check className="w-5 h-5" aria-hidden />
            </span>
            <p className="mt-3 text-[13px] text-ink">You’re in — opening the session…</p>
          </div>
        ) : (
          <div className="flex flex-col items-center text-center py-4" role="alert">
            <span className="w-9 h-9 rounded-full flex items-center justify-center bg-fail/[.18] text-fail">
              <X className="w-5 h-5" aria-hidden />
            </span>
            <p className="mt-3 text-[13px] text-ink">Couldn’t join</p>
            <p className="mt-1 text-[11px] text-ink-mute leading-relaxed">{message}</p>
          </div>
        )}
      </div>
    </main>
  );
}
