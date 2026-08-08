"use client";
import { useEffect, useState } from "react";
import { Settings, User, X } from "lucide-react";
import { stashHostName } from "../lib/participant";
import { Avatar, IconButton, SectionTitle } from "../ui";
import { Modal } from "../ui/Overlay";
import { cn } from "../ui/cn";

// Desktop-shell identity footer (Phase 3). Same /api/identity fetch as the
// legacy IdentityStrip — CRUCIALLY it keeps the `stashHostName` side effect, so
// peers keep seeing the host's first name in presence instead of "Host". The
// profile detail moves onto the shared Modal. A Settings gear sits alongside;
// the sheet it opens is owned by DesktopShell (passed as `onOpenSettings`).

interface Identity {
  authenticated: boolean;
  fullName?: string | null;
  displayName?: string | null;
  role?: string | null;
  company?: string | null;
  emailAddress?: string | null;
  organizationName?: string | null;
  seatTier?: string | null;
  profileMarkdown?: string | null;
  profileSource?: string | null;
}

function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function IdentityFooter({ onOpenSettings, collapsed = false }: { onOpenSettings: () => void; collapsed?: boolean }) {
  const [id, setId] = useState<Identity | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/identity")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Identity | null) => {
        setId(data);
        const full = data?.fullName || data?.displayName || "";
        if (data?.authenticated && full) stashHostName(full);
      })
      .catch(() => setId({ authenticated: false }));
  }, []);

  const primary = id?.fullName || id?.displayName || id?.emailAddress || "anonymous";
  const secondary = id?.role || id?.organizationName || id?.seatTier || "";

  return (
    <div
      className={cn(
        "border-t border-divider shrink-0",
        collapsed ? "py-2.5 flex flex-col items-center gap-1.5" : "p-2.5 flex items-center gap-2",
      )}
    >
      {!id ? (
        !collapsed && <div className="flex-1" />
      ) : !id.authenticated ? (
        collapsed ? (
          <span className="text-live" title="not authenticated">
            <User className="w-4 h-4" />
          </span>
        ) : (
          <div className="flex flex-1 items-center gap-2 px-2 text-[11px] text-live">
            <User className="w-3.5 h-3.5" />
            <span>not authenticated</span>
          </div>
        )
      ) : (
        <button
          onClick={() => setOpen(true)}
          title={id.profileMarkdown ? "View profile" : id.emailAddress ?? ""}
          className={cn(
            "text-left rounded-[11px] hover:bg-elevated transition-colors",
            collapsed ? "p-0.5 rounded-full" : "flex flex-1 min-w-0 items-center gap-2.5 px-2 py-1.5",
          )}
        >
          <Avatar initials={initials(primary)} className="shrink-0 text-[11px] text-ink" />
          {!collapsed && (
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[12px] font-semibold text-ink">{primary}</span>
              {secondary && (
                <span className="block truncate text-[10px] font-mono uppercase tracking-wide text-ink-faint">
                  {secondary}
                </span>
              )}
            </span>
          )}
        </button>
      )}

      <IconButton label="Settings" size="sm" className="shrink-0" onClick={onOpenSettings}>
        <Settings className="w-4 h-4" />
      </IconButton>

      {id?.authenticated && (
        <Modal open={open} onClose={() => setOpen(false)} label="Profile" className="max-w-2xl">
          <div className="flex items-center gap-3 p-4 border-b border-divider shrink-0">
            <Avatar size="lg" initials={initials(primary)} className="text-ink" />
            <div className="flex-1 min-w-0">
              <div className="font-sans font-semibold text-ink truncate">{primary}</div>
              {secondary && <div className="text-xs text-ink-mute truncate">{secondary}</div>}
            </div>
            <IconButton label="Close" size="sm" onClick={() => setOpen(false)}>
              <X className="w-4 h-4" />
            </IconButton>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="px-4 pt-3 pb-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[11px]">
              {id.emailAddress && (
                <>
                  <Label>email</Label>
                  <Value mono>{id.emailAddress}</Value>
                </>
              )}
              {id.role && (
                <>
                  <Label>role</Label>
                  <Value>{id.role}</Value>
                </>
              )}
              {id.company && (
                <>
                  <Label>company</Label>
                  <Value>{id.company}</Value>
                </>
              )}
              {id.organizationName && id.organizationName !== id.company && (
                <>
                  <Label>org</Label>
                  <Value>{id.organizationName}</Value>
                </>
              )}
              {id.seatTier && (
                <>
                  <Label>seat</Label>
                  <Value>{id.seatTier}</Value>
                </>
              )}
            </div>

            {id.profileMarkdown ? (
              <div className="px-4 pb-4">
                <div className="mt-2 mb-1 flex items-center justify-between">
                  <SectionTitle>Profile</SectionTitle>
                  {id.profileSource && (
                    <span
                      className="font-mono text-[10px] text-ink-faint truncate max-w-[40ch]"
                      title={id.profileSource}
                    >
                      {id.profileSource.split("/").slice(-3).join("/")}
                    </span>
                  )}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-ink-soft bg-sunken border border-divider rounded-control p-3 max-h-80 overflow-y-auto">
                  {id.profileMarkdown}
                </pre>
              </div>
            ) : (
              <div className="px-4 pb-4">
                <div className="text-[11px] text-ink-mute bg-sunken border border-divider rounded-control p-3">
                  No <span className="font-mono text-ink-soft">profile.md</span> yet. Run{" "}
                  <span className="font-mono text-ink">/hooop:setup</span> to capture your role and
                  stack, or hand-write one at{" "}
                  <span className="font-mono text-ink-soft">~/.claude/hooop/profile.md</span>.
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <SectionTitle className="text-[10px] pt-0.5">{children}</SectionTitle>;
}
function Value({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span className={cn("text-ink-soft truncate", mono && "font-mono")}>{children}</span>
  );
}
