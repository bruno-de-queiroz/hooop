"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Globe, Link2, Loader2, RefreshCw, RotateCw, Square, Hammer, TriangleAlert } from "lucide-react";
import { usePreviewUI } from "@/app/context/PreviewUIProvider";
import { canDecidePermissions } from "@/app/components/lib/participant";
import { Button } from "../../ui/Button";
import { Field, Input, Textarea } from "../../ui/Field";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";

/**
 * The docked live preview: the app itself in an iframe, what is running, and
 * the controls to change it.
 *
 * Two things about this panel are load-bearing rather than cosmetic.
 *
 * The IFRAME points at a different origin (a distinct port for the host, a
 * distinct tunnel hostname for a peer) and is reached only after redeeming a
 * grant. That separation is what stops agent-authored JS from reading the hooop
 * API, so the src is always the redemption URL the server minted — never a
 * hand-built one.
 *
 * The CONTROLS are the refresh story. hooop installs no file watcher and makes
 * no hot-reload promise, so Restart and Rebuild are how a human gets their
 * change on screen. They are primary, not buried in a menu. Refresh is a
 * separate, smaller thing: it only remounts the iframe (a plain browser
 * reload of whatever is already running), for when the page itself needs
 * reloading — a client error, stuck state, stale route — and the process
 * behind it does not.
 */
export function ShellPreviewPanel({ immersive = false }: { immersive?: boolean } = {}) {
  const {
    preview, actionError,
    logs, logsLoading, loadLogs,
    act, share, unshare, viewerLink, publicReachable, publicTunnelGaveUp, lastSpec, lastStoppedReason,
    driving, takeControl,
  } = usePreviewUI();

  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // The public link is a SEPARATE URL from the framed one, on a different
  // hostname with its own grant — see the link route. Kept apart here so the
  // new-tab affordance can offer the shareable address while the iframe keeps
  // loading the one whose cookie actually survives being embedded.
  const [publicSrc, setPublicSrc] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Bumped to force the iframe to remount on the same src. Redemption is
  // idempotent (re-verifies the grant, re-sets the cookie), so navigating back
  // to the identical URL is a safe, ordinary reload — no new grant needed.
  const [reloadNonce, setReloadNonce] = useState(0);
  const reloadFrame = useCallback(() => setReloadNonce((n) => n + 1), []);
  const mayAct = canDecidePermissions();

  const state = preview?.state;
  const reachable = state === "running" || state === "shared";

  // Redeem a grant whenever the preview becomes reachable (or changes), so the
  // frame is authorized before it loads. Redeeming sets a host-bound cookie on
  // the preview origin; the frame then loads that origin normally.
  // Keyed on primitives only. The poll hands back a NEW preview object every
  // tick, so depending on the object would re-mint a grant and reload the
  // iframe every few seconds — throwing away whatever state the app was in.
  const previewId = preview?.previewId ?? null;
  const publicUrl = preview?.publicUrl ?? null;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!previewId || !reachable) {
        if (!cancelled) { setFrameSrc(null); setPublicSrc(null); }
        return;
      }
      const link = await viewerLink(previewId);
      if (cancelled) return;
      if (!link) {
        setLinkError("Could not get access to this preview.");
        setFrameSrc(null);
        setPublicSrc(null);
        return;
      }
      setLinkError(null);
      setFrameSrc(link.url);
      setPublicSrc(link.publicUrl);
    })();
    return () => { cancelled = true; };
  }, [previewId, publicUrl, reachable, viewerLink]);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); } finally { setBusy(null); }
  }, []);

  const openLogs = useCallback(async () => {
    setShowLogs((v) => !v);
    if (!showLogs) await loadLogs();
  }, [showLogs, loadLogs]);

  // No app running. The rail's globe is permanent, so this panel has to answer
  // the click rather than render nothing — an always-visible control that opens
  // an empty column reads as broken. Same chrome as the live dock (header +
  // close) so opening and closing behave identically either way.
  if (!preview) {
    return (
      <div data-testid="preview-panel" className="flex min-h-0 flex-1 flex-col">
        {/* Scrolls, and centres only when there is room to.
          *
          * This was a centred flex column with no scroll container: on a phone
          * the start-preview form is taller than the viewport, so the run/setup
          * fields and the button were simply unreachable — and centring pushed
          * the overflow off BOTH ends, so scrolling to them would not have
          * worked either. min-h-full on the inner keeps it centred when short
          * and lets it grow past the fold when it is not. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-6 text-center">
          <Globe className="w-5 h-5 text-ink-hush" />
          <p className="text-[12.5px] text-ink-mute">
            No application preview is running for this session.
          </p>
          {/* Only when the sweeper did it. Someone who stopped the preview
              themselves does not need it explained back to them. */}
          {lastStoppedReason === "idle" && (
            <p className="max-w-[22rem] text-[11.5px] text-ink-faint">
              It was stopped because this session went idle, which freed its slot
              for another session.
            </p>
          )}
          {/* Remount when the remembered spec changes so a spec that arrives on a
              later poll actually reaches the fields — but not on every poll, which
              would wipe whatever the user was typing. */}
            <StartPreviewForm key={lastSpec ? `${lastSpec.name}:${lastSpec.run}` : "new"} />
          </div>
        </div>
      </div>
    );
  }

  const spec = preview.spec;
  const stepLabel =
    preview.phase?.kind === "setup"
      ? `setup ${(preview.phase.index ?? 0) + 1}/${spec.setup?.length ?? 1}`
      : preview.phase?.kind === "run" ? "running" : "";

  return (
    <div data-testid="preview-panel" className="flex min-h-0 flex-1 flex-col">
      {/* On a phone the overlay supplies the only bar there is room for, and it
        * already names the section and offers the way out. A second one here
        * cost the app a fifth of the screen to repeat it. */}
      {!immersive && (
      <div className="shrink-0 flex items-center gap-2 border-b border-divider px-3 py-2">
        <Globe className="w-4 h-4 shrink-0 text-ink-mute" />
        <span className="truncate text-[12.5px] font-medium text-ink">{spec.name}</span>
        <StateBadge state={preview.state} detail={stepLabel} />
        {/* Prefer the PUBLIC link when shared: a new tab is where the host goes
            to grab the address they are handing to someone, and a loopback port
            is not that address. Falls back to the framed link when unshared. */}
        {(publicSrc ?? frameSrc) && (
          <a
            href={publicSrc ?? frameSrc ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            title={publicSrc ? "Open the shared URL in a new tab" : "Open in a new tab"}
            className="icon-btn w-8 h-8 ml-auto"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
      </div>
      )}

      {/* The app. Separate origin, so this is a real browsing context and not
          something the dashboard can reach into (nor vice versa). */}
      <div className="relative min-h-0 flex-1 bg-sunken">
        {frameSrc ? (
          <>
            <iframe
              key={`${frameSrc}:${reloadNonce}`}
              ref={frameRef}
              src={frameSrc}
              title={`Preview: ${spec.name}`}
              className="h-full w-full border-0 bg-window"
            />
            {driving && (
              <DrivingOverlay
                onTakeControl={() => {
                  takeControl();
                  // The overlay swallows the click, so it never reaches the page
                  // — which means clicking "take control" used to hide the
                  // overlay and nothing else: the copy stayed in the fan-out and
                  // the agent kept driving it. The frame is a separate origin, so
                  // asking it is the only way.
                  frameRef.current?.contentWindow?.postMessage(
                    { source: "hooop-preview-panel", type: "take-control" }, "*");
                }}
              />
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-ink-mute">
            {state === "starting" ? (
              <>
                <Loader2 className="w-4 h-4 motion-safe:animate-spin" />
                <span>{stepLabel ? `Running ${stepLabel}…` : "Starting…"}</span>
                <span className="text-xs">
                  {preview.phase?.command ? <code className="break-all">{preview.phase.command}</code> : null}
                </span>
              </>
            ) : state === "failed" ? (
              <>
                <TriangleAlert className="w-4 h-4 text-live" />
                <span className="font-medium text-ink">Preview failed</span>
                <span className="text-xs">{preview.failureReason}</span>
              </>
            ) : (
              <span>{linkError ?? "Not running."}</span>
            )}
          </div>
        )}
      </div>

      {/* What is actually running — so the person deciding whether to share it
          can see the commands, not just a name. Reference material, and the
          first thing to give up when the app itself is the point. */}
      <details className={cn("border-t border-divider px-3 py-2 text-xs", immersive && "hidden")}>
        <summary className="cursor-pointer select-none text-ink-mute">Spec</summary>
        <dl className="mt-2 space-y-1 text-ink-mute">
          {spec.workdir && <Row label="workdir" value={spec.workdir} />}
          {(spec.setup ?? []).map((s, i) => <Row key={i} label={`setup ${i + 1}`} value={s} />)}
          <Row label="run" value={spec.run} />
          {preview.publicUrl && <Row label="shared" value={preview.publicUrl} />}
        </dl>
      </details>

      {showLogs && (
        <div className="max-h-56 overflow-auto border-t border-divider bg-sunken px-3 py-2">
          {logsLoading ? (
            <div className="text-xs text-ink-mute">Loading…</div>
          ) : logs.length === 0 ? (
            <div className="text-xs text-ink-mute">No output captured.</div>
          ) : (
            logs.map((l) => (
              <div key={l.step} className="mb-2">
                <div
                  className={cn(
                    "font-mono text-[11px]",
                    l.exitCode && l.exitCode !== 0 ? "text-fail" : "text-ink-mute",
                  )}
                >
                  $ {l.command}
                  {l.exitCode !== null && l.exitCode !== 0 ? ` — exit ${l.exitCode}` : ""}
                </div>
                <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-ink">
                  {[l.stdout, l.stderr].filter(Boolean).join("\n").trimEnd() || "(no output)"}
                </pre>
              </div>
            ))
          )}
        </div>
      )}

      <footer
        className={cn(
          "flex items-center gap-1.5 border-t border-divider px-3 py-2",
          // Restart and Stop are not optional on a phone, so they are kept —
          // but wrapped they ate three rows of a small screen. One row that
          // scrolls sideways instead.
          immersive ? "shrink-0 overflow-x-auto whitespace-nowrap" : "flex-wrap",
        )}
      >
        {/* Hiding the panel header took the only way to open the app in a real
          * tab with it — which on a phone is the closest thing to fullscreen we
          * can offer. It comes back here rather than floating over the app. */}
        {immersive && (publicSrc ?? frameSrc) && (
          <a
            href={publicSrc ?? frameSrc ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            title="Open in a new tab"
            aria-label="Open in a new tab"
            className="icon-btn w-8 h-8 shrink-0"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
        {/* A plain browser reload of the frame — no grant, no process restart.
          * Not gated on mayAct: reloading your own view changes nothing for
          * anyone else, so a view-only peer can use it same as the host. */}
        <Action icon={RefreshCw} label="Refresh" disabled={!frameSrc}
          title={frameSrc ? "Reload this page" : "Nothing to reload"}
          onClick={reloadFrame} />
        <Action icon={RotateCw} label="Restart" busy={busy === "restart"} disabled={!mayAct}
          onClick={() => run("restart", () => act("restart"))} />
        <Action icon={Hammer} label="Rebuild" busy={busy === "rebuild"} disabled={!mayAct}
          onClick={() => run("rebuild", () => act("rebuild"))} />
        <Action icon={Square} label="Stop" busy={busy === "stop"} disabled={!mayAct}
          onClick={() => run("stop", () => act("stop"))} />
        {preview.publicUrl ? (
          <Action icon={Link2} label="Unshare" busy={busy === "share"} disabled={!mayAct}
            onClick={() => run("share", unshare)} />
        ) : (
          <Action icon={Link2} label="Share" busy={busy === "share"} disabled={!mayAct || !reachable}
            onClick={() => run("share", share)} />
        )}
        <button
          type="button"
          onClick={openLogs}
          className="rounded px-2 py-1 text-xs text-ink-mute hover:bg-elevated"
        >
          {showLogs ? "Hide logs" : "Logs"}
        </button>
        {!mayAct && (
          <span className="ml-auto text-[11px] text-ink-faint">view only</span>
        )}
        {actionError && (
          <span className="w-full text-[11px] text-fail">{actionError}</span>
        )}
        {/* Sharing mints a hostname before Cloudflare's edge is answering for it,
            which used to look like a broken link: the URL was handed over as
            ready and refused connections for the next half minute. Say which of
            the two it is rather than implying the optimistic one. */}
        {preview.publicUrl && publicReachable === false && !publicTunnelGaveUp && (
          <span className="flex w-full items-center gap-1.5 text-[11px] text-ink-faint">
            <Loader2 className="w-3 h-3 motion-safe:animate-spin" />
            The shared link is still coming up — it can take up to a minute to
            work outside this machine.
          </span>
        )}
        {/* We stopped waiting. Saying so is the whole point: the spinner above
            promised a link that was never arriving, and anyone who opened it got
            a blank window with nothing to explain why. */}
        {preview.publicUrl && publicTunnelGaveUp && (
          <span className="flex w-full items-start gap-1.5 text-[11px] text-fail">
            <TriangleAlert className="mt-px w-3 h-3 shrink-0" />
            <span>
              The shared link never came up, so it will not work for anyone else.
              This is usually a network or VPN problem reaching Cloudflare —
              Unshare and Share again to try a new link.
            </span>
          </span>
        )}
      </footer>
    </div>
  );
}

/**
 * The agent has the page.
 *
 * Two jobs, and the second is the one that matters. It SAYS the agent is
 * working in here, so a page moving on its own reads as the agent rather than
 * as a bug. And it CATCHES the clicks, so a human and the model cannot both act
 * on a stateful app at once and leave it in a state neither of them chose.
 *
 * Clicking it interrupts the turn — the model is mid-thought and needs telling,
 * or it narrates actions that never happened — and hands the page back. The
 * viewer's own next click is what detaches their copy from the fan-out, which is
 * the page's job (it can tell a real click from the model's) rather than ours.
 */
function DrivingOverlay({ onTakeControl }: { onTakeControl: () => void }) {
  return (
    <button
      type="button"
      data-testid="preview-driving-overlay"
      // Taking control does NOT stop the turn from here. Whether the agent
      // should stop depends on how many viewers are still following, which only
      // the server knows — and it has to cover the other way of taking over too,
      // clicking inside the frame, which this component never sees. So the
      // server interrupts when the last follower leaves, and one of five people
      // reaching in no longer halts the run for the other four.
      onClick={() => onTakeControl()}
      // Covers the frame exactly. `group` so the label can respond to hover
      // without a second state variable.
      //
      // A scrim, deliberately NOT a blur: the whole point is watching the agent
      // work, and blurring the thing you are meant to be watching defeats the
      // feature to decorate the state.
      className="group absolute inset-0 z-10 flex cursor-pointer items-start justify-center
                 bg-window/25 pt-6 transition-colors hover:bg-window/40"
    >
      <span
        className="flex items-center gap-2 rounded-full border border-divider bg-window/95 px-3 py-1.5
                   text-[12px] font-medium text-ink shadow-lg"
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-live opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-live" />
        </span>
        <span className="text-ink-mute group-hover:text-ink">The agent is using this page</span>
        <span className="text-ink-faint">·</span>
        <span>Click to take control</span>
      </span>
    </button>
  );
}

/**
 * Start a preview from the dashboard, without asking the agent to do it.
 *
 * A form rather than a bare button because a spec needs a command: there is no
 * safe way to guess what "run my app" means for an arbitrary workspace, and a
 * wrong guess costs a slot and surfaces as a failed preview. Collapsed to a
 * single button until you want it, so the empty state stays a sentence and a
 * choice rather than a form nobody asked for.
 *
 * `setup` is optional and one command per line — the common case is a single
 * install step, and a textarea beats inventing a repeater for it.
 */
function StartPreviewForm() {
  const { start, starting, actionError, lastSpec } = usePreviewUI();
  const [openForm, setOpenForm] = useState(false);
  // Prefilled from whatever this session ran last. Retyping a run command you
  // already gave us is busywork — and after the idle sweeper releases a preview,
  // restarting it should cost one click, not five fields.
  const [name, setName] = useState(lastSpec?.name ?? "");
  const [run, setRun] = useState(lastSpec?.run ?? "");
  const [setup, setSetup] = useState((lastSpec?.setup ?? []).join("\n"));
  const [workdir, setWorkdir] = useState(lastSpec?.workdir ?? "");
  const [port, setPort] = useState(lastSpec?.port?.fixed ? String(lastSpec.port.fixed) : "");

  if (!openForm) {
    return (
      <Button variant="pill" size="sm" onClick={() => setOpenForm(true)}>
        {lastSpec ? "Start it again" : "Start a preview"}
      </Button>
    );
  }

  const canSubmit = run.trim().length > 0 && !starting;
  const submit = async () => {
    if (!canSubmit) return;
    const ok = await start({
      // The command is the only thing worth typing; default the label off it so
      // the field can be left empty.
      name: name.trim() || run.trim().split(/\s+/)[0] || "preview",
      run: run.trim(),
      setup: setup.split("\n").map((l) => l.trim()).filter(Boolean),
      workdir: workdir.trim() || null,
      // Only sent when given: omitted means "assign a port and export $PORT",
      // which is right for anything that honours it.
      ...(port.trim() ? { port: { fixed: Number(port.trim()) } } : {}),
    });
    if (ok) setOpenForm(false);
  };

  return (
    <div className="w-full max-w-[22rem] text-left flex flex-col gap-3">
      <Field
        label="run command"
        hint="the long-lived command that serves the app"
        error={actionError ?? undefined}
      >
        <Input
          autoFocus
          value={run}
          onChange={(e) => setRun(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }}
          placeholder="npm run dev"
          className="font-mono"
        />
      </Field>

      {/* Scopes both of the commands: setup and run execute here. Empty runs in
        * the session root, which is right when the app IS the workspace and wrong
        * for the common `git clone` shape, where package.json sits one level down
        * — a mismatch that surfaces as `npm install` failing on ENOENT and reads
        * like a broken preview rather than a missing path. */}
      <Field label="folder" hint="optional — relative to the session, e.g. my-app">
        <Input
          value={workdir}
          onChange={(e) => setWorkdir(e.target.value)}
          placeholder="my-app"
          className="font-mono"
        />
      </Field>

      <Field label="setup" hint="optional — one command per line, run before the app">
        <Textarea
          rows={2}
          value={setup}
          onChange={(e) => setSetup(e.target.value)}
          placeholder="npm ci"
          className="font-mono resize-none"
        />
      </Field>

      {/* Only needed by an app that cannot be told. The runner assigns a port and
        * exports $PORT; one that ignores it binds a socket nothing watches and
        * fails as "the app did not respond on port <assigned>". */}
      <Field label="port" hint="optional — only if the app ignores $PORT">
        <Input
          inputMode="numeric"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="3000"
          className="font-mono"
        />
      </Field>

      <Field label="name" hint="optional — defaults to the first word of the command">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="web" />
      </Field>

      <div className="flex items-center gap-1.5">
        <Button variant="accent" size="sm" disabled={!canSubmit} onClick={() => void submit()}>
          {starting ? "Starting…" : "Start"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpenForm(false)}>Cancel</Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-all font-mono">{value}</dd>
    </div>
  );
}

function StateBadge({ state, detail }: { state: string; detail?: string }) {
  // Map onto the DS's six fixed cue meanings: failed => fail, up => wrap,
  // coming up => live. "shared" is a reachability fact, not a seventh state.
  const tone =
    state === "failed" ? "fail"
      : state === "shared" || state === "running" ? "wrap"
        : state === "starting" ? "live"
          : "neutral";
  return (
    <Chip tone={tone as "fail" | "wrap" | "live" | "neutral"} className="shrink-0 uppercase tracking-wide">
      {state}{detail && state === "starting" ? ` · ${detail}` : ""}
    </Chip>
  );
}

function Action({
  icon: Icon, label, onClick, busy, disabled, title,
}: {
  icon: typeof RotateCw; label: string; onClick: () => void; busy?: boolean; disabled?: boolean; title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title ?? (disabled ? "Only the host or a full-access peer can do this" : label)}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-1 text-xs",
        disabled
          ? "cursor-not-allowed text-ink-faint"
          : "text-ink-mute hover:bg-elevated",
      )}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 motion-safe:animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      {label}
    </button>
  );
}
