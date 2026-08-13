"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Check, X, Smartphone } from "lucide-react";
import { Button, Field, Input } from "@/app/components/ui";
import { HooopMark } from "@/app/components/shell/HooopLogo";

/**
 * Device-enrollment landing page — the host's own phone or tablet arriving to
 * become the host, not a guest.
 *
 * Deliberately the mirror image of /join:
 *   - /join asks the visitor to name THEMSELVES, because the host is about to
 *     decide whether to let a stranger in.
 *   - /enroll asks them to name the DEVICE, because there is nobody to vet. The
 *     code in the fragment was minted two minutes ago by somebody holding host
 *     authority, so the vetting already happened at the laptop. The label is
 *     purely so the revoke list reads "Pixel 8" instead of a uuid.
 *
 * The code rides in the URL FRAGMENT (`#c=<code>`) so it never reaches the
 * server, its logs, or a Referer header — same rule as the share link's token.
 */
type Phase = "label" | "enrolling" | "done" | "error";

function codeFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("c");
}

/** A label the host will recognise in the revoke list without typing anything.
 *  Crude on purpose: it only has to beat "Device". */
function guessLabel(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux machine";
  return "";
}

export default function EnrollPage() {
  const [phase, setPhase] = useState<Phase>("label");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState("");
  // Resolved AFTER mount so the server-rendered and first client render agree
  // (the fragment and the UA are invisible to the server) — no hydration
  // mismatch. Same pattern as the join page.
  const [missingCode, setMissingCode] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    setMissingCode(!codeFromHash());
    setLabel((cur) => cur || guessLabel());
  }, []);

  async function start() {
    const code = codeFromHash();
    if (!code) {
      setPhase("error");
      setMessage("This enrollment link is missing its code.");
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    // Strip the code from the visible URL at once; keep it in memory. It is
    // single-use, so a leftover in the address bar is mostly untidy rather than
    // dangerous — but "mostly" is not a standard worth holding a credential to.
    try { window.history.replaceState(null, "", window.location.pathname); } catch { /* ignore */ }

    setPhase("enrolling");
    try {
      const res = await fetch("/api/host-device/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, label: label.trim() || null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setPhase("error");
        setMessage(body.error ?? "This enrollment code is invalid, expired, or already used.");
        startedRef.current = false; // let them retry with a fresh code
        return;
      }
      setPhase("done");
      // Full reload rather than a client route: the enrollment response set the
      // device cookie, and the shell's identity is decided by middleware on a
      // real request. A soft navigation would render the shell as nobody.
      window.location.replace("/");
    } catch {
      setPhase("error");
      setMessage("Network error while enrolling. Check your connection and try again.");
      startedRef.current = false;
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-bg text-ink-soft p-6">
      <div className="flex items-center gap-1.5 mb-8">
        <HooopMark size={22} />
        <span className="font-display text-[20px] font-bold tracking-tight text-ink">hooop</span>
      </div>

      <div className="w-full max-w-sm rounded-card bg-window border border-divider p-6 shadow-overlay">
        {phase === "label" ? (
          <>
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-full flex items-center justify-center bg-accent/[.16] text-accent">
                <Smartphone className="w-4 h-4" aria-hidden />
              </span>
              <h2 className="font-display text-[16px] font-semibold text-ink">Add this device</h2>
            </div>
            <p className="mt-2 text-xs text-ink-mute leading-relaxed">
              This device will act as <span className="text-ink">you</span>, not as a guest. Same
              sessions, same name on your messages, nothing to admit.
            </p>
            <div className="mt-4">
              <Field label="Device name">
                <Input
                  autoFocus
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void start(); }}
                  maxLength={60}
                  placeholder="so you can spot it in the list"
                  disabled={missingCode}
                />
              </Field>
            </div>
            <Button
              variant="accent"
              onClick={() => void start()}
              disabled={missingCode}
              className="w-full mt-4 py-2.5 font-semibold"
            >
              Add this device
            </Button>
            {missingCode ? (
              <p className="mt-3 text-center text-[11px] text-fail">
                This enrollment link is missing its code.
              </p>
            ) : (
              <p className="mt-3 text-center text-[10px] text-ink-hush">
                You can revoke it from the dashboard at any time.
              </p>
            )}
          </>
        ) : phase === "enrolling" ? (
          <div className="flex flex-col items-center text-center py-4">
            <Loader2 className="w-7 h-7 animate-spin text-accent" aria-hidden />
            <p className="mt-3 text-[13px] text-ink">Adding this device…</p>
          </div>
        ) : phase === "done" ? (
          <div className="flex flex-col items-center text-center py-4">
            <span className="w-9 h-9 rounded-full flex items-center justify-center bg-wrap/20 text-wrap">
              <Check className="w-5 h-5" aria-hidden />
            </span>
            <p className="mt-3 text-[13px] text-ink">Added — opening hooop…</p>
          </div>
        ) : (
          <div className="flex flex-col items-center text-center py-4" role="alert">
            <span className="w-9 h-9 rounded-full flex items-center justify-center bg-fail/[.18] text-fail">
              <X className="w-5 h-5" aria-hidden />
            </span>
            <p className="mt-3 text-[13px] text-ink">Couldn’t add this device</p>
            <p className="mt-1 text-[11px] text-ink-mute leading-relaxed">{message}</p>
          </div>
        )}
      </div>
    </main>
  );
}
