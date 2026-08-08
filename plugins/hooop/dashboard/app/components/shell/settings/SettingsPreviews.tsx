"use client";
import { useCallback, useEffect, useState } from "react";
import { Globe, Square } from "lucide-react";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { StatusDot } from "../../ui/StatusDot";
import type { PreviewRecord } from "@/lib/sandbox-types";

/**
 * Host-only inventory of every live preview, across every session, with a Stop
 * for each.
 *
 * Preview slots are an INSTALL-wide resource — three of them, shared by every
 * session — but every other preview surface is scoped to the session you happen
 * to be looking at. So a slot held by some other session was invisible: "all 3
 * preview slots are in use" named the holders in an error string and nowhere
 * else, and freeing one meant walking sessions until you found it. This is the
 * operator's view of the pool, and the one place a preview can be killed without
 * first navigating to whatever session owns it.
 */

/** Preview state → one of the DS's six fixed cue meanings. */
function cueFor(state: string): "live" | "wrap" | "fail" | "idle" {
  if (state === "failed") return "fail";
  if (state === "running" || state === "shared") return "wrap";
  if (state === "starting") return "live";
  return "idle";
}

export function SettingsPreviews() {
  const [previews, setPreviews] = useState<PreviewRecord[] | null>(null);
  const [slots, setSlots] = useState({ total: 3, used: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/previews");
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      setPreviews(data.previews ?? []);
      setSlots(data.slots ?? { total: 3, used: 0 });
      setError(null);
    } catch {
      setPreviews(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Stop goes through the OWNING session's route, because that is where the
  // capability check lives — the inventory is a host-only read, but killing a
  // preview is the same action the dock offers and answers to the same guard.
  const stop = useCallback(async (p: PreviewRecord) => {
    setBusy(p.previewId);
    setError(null);
    try {
      const r = await fetch(
        `/api/sessions/${encodeURIComponent(p.sessionId)}/previews/${encodeURIComponent(p.previewId)}/stop`,
        { method: "POST" },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body.error ?? "could not stop the preview");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      await load();
    }
  }, [load]);

  return (
    <section>
      <div className="section-title mb-2 flex items-center gap-2">
        <Globe className="w-3.5 h-3.5" /> Previews
        <span className="ml-auto font-normal normal-case text-ink-faint">
          {slots.used}/{slots.total} slots
        </span>
      </div>

      {loading ? (
        <p className="text-xs text-ink-faint">Loading…</p>
      ) : previews === null ? (
        <p className="text-xs text-ink-faint">Preview runners are not available in this install.</p>
      ) : previews.length === 0 ? (
        <p className="text-xs text-ink-faint">No previews are running.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {previews.map((p) => (
            <li key={p.previewId} className="flex items-center gap-2 rounded-control bg-sunken px-2.5 py-2">
              <StatusDot state={cueFor(p.state)} size="sm" pulse={p.state === "starting"} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-ink">{p.spec?.name ?? p.previewId}</div>
                {/* The session id is the point of this list: it is how you know
                  * WHICH conversation is holding the slot. */}
                <div className="truncate font-mono text-[10px] text-ink-faint">
                  slot {p.slot} · session {p.sessionId.slice(0, 8)}
                </div>
              </div>
              {p.state === "shared" && <Chip tone="wrap">shared</Chip>}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy === p.previewId}
                title="Stop this preview and free its slot"
                onClick={() => void stop(p)}
              >
                <Square className="w-3.5 h-3.5" />
                {busy === p.previewId ? "Stopping…" : "Stop"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[11px] text-fail">{error}</p>}
    </section>
  );
}
