"use client";
import { Bell } from "lucide-react";
import { SectionTitle } from "../../ui";
import { cn } from "../../ui/cn";
import { useNotifications } from "@/app/context/NotificationsProvider";

/**
 * Settings → Notifications. Two controls: enrol this browser, and mute
 * everything.
 *
 * Enrolment lives here rather than in the session header because the browser's
 * permission prompt must come from a deliberate user gesture — asking on load,
 * or from a control someone might hit by accident, is how a browser ends up
 * permanently blocking the origin with no way back.
 *
 * Peers see this too: a peer co-driving from a phone is the case notifications
 * exist for, since a backgrounded mobile tab is suspended and the in-page
 * unseen dot never runs.
 */
export function SettingsNotifications() {
  const { state, enable, disable, globalMuted, setGlobalMuted, error } = useNotifications();

  const busy = state === "busy";
  const enrolled = state === "on";

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle className="flex items-center gap-1.5">
        <Bell className="w-3.5 h-3.5" />
        Notifications
      </SectionTitle>

      {state === "unsupported" ? (
        <p className="text-[12px] text-ink-mute">
          This browser can&apos;t receive notifications. They need a secure origin and
          service-worker support — on iOS, add hooop to your Home Screen first.
        </p>
      ) : state === "denied" ? (
        <p className="text-[12px] text-ink-mute">
          Notifications are blocked for this site. Re-allow them in your browser&apos;s site
          settings, then reload.
        </p>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            aria-pressed={enrolled}
            onClick={() => void (enrolled ? disable() : enable())}
            className={cn(
              "sunken flex items-center justify-between gap-3 px-3 py-2.5 text-left",
              busy && "opacity-60",
            )}
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] text-ink">
                {enrolled ? "Notifications are on" : "Turn on notifications"}
              </span>
              <span className="text-[11px] text-ink-mute">
                {enrolled
                  ? "This device is subscribed. Turning it off only affects this browser."
                  : "Get told when the agent needs you, finishes, or someone messages."}
              </span>
            </span>
            <span className={cn("pill-btn text-[10px] uppercase tracking-wide px-2 py-1", enrolled && "text-wrap")}>
              {busy ? "…" : enrolled ? "On" : "Off"}
            </span>
          </button>

          {enrolled && (
            <label className="sunken flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer">
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] text-ink">Mute everything</span>
                <span className="text-[11px] text-ink-mute">
                  Silences every session without unsubscribing this device.
                </span>
              </span>
              <input
                type="checkbox"
                checked={globalMuted}
                onChange={(e) => void setGlobalMuted(e.target.checked)}
                className="shrink-0"
              />
            </label>
          )}
        </>
      )}

      {error && <p className="text-[11px] text-fail">{error}</p>}
    </section>
  );
}
