"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, Eye, Hash, Image as ImageIcon, MessageCircle, Terminal, X } from "lucide-react";
import { useActiveSession } from "@/app/context/ActiveSessionProvider";
import { userPromptText, extractEventField } from "../active-session/eventText";
import { isPeerClient, peerCapability, myDisplayName, useMounted } from "../lib/participant";
import {
  readImages,
  toSendImages,
  toChatImages,
  previewUrl,
  MAX_ATTACHMENTS,
  type AttachedImage,
} from "../lib/imageAttach";
import { cn } from "../ui/cn";
import { useCommands } from "@/app/context/CommandsProvider";
import { useComposerInsert } from "@/app/context/ComposerInsertProvider";
import { useComposerAutocomplete } from "./useComposerAutocomplete";
import { AutocompletePopover } from "./AutocompletePopover";

// Center-pane composer (Phase 3). Matches the mockup's field (avatar + input +
// image attach + round accent send) and hint bar, wired to the provider: plain
// text → send, `!cmd` → runBash, `>msg` → participant chat, and image
// attachments (button or paste) that ride along on send/chat. Typing broadcasts
// via presence. A spectate peer gets the read-only note. `/` (start of message)
// `#` (a file) and `@` (a peer, anywhere) open the autocomplete popover via
// useComposerAutocomplete.

// Where a composed line goes. Plain text → the model (`send`); `!cmd` → bash;
// `>msg` → participant chat; and the client-intercepted control commands,
// `/stop` (abort the in-flight turn), `/model <alias>` (switch the session
// model) and `/auto-mode [on|off]` (toggle unattended auto-approval). The
// control commands act on the session directly and are NEVER forwarded to the
// model — claude's built-in /model and /stop are TUI-only, so leaving them in
// the message path just echoes them to the agent as plain text and never
// actually stops/switches. `/auto-mode` is a hooop toggle with no claude
// equivalent, so forwarding it would be a silent no-op that LOOKS like it
// changed a security-relevant setting — hence a malformed argument routes to
// `auto-mode-invalid` (an inline error) rather than falling through to `send`.
// Pure so the routing is unit-testable without standing up the whole composer.
export type ComposerRoute =
  | { kind: "bash"; command: string }
  | { kind: "chat"; text: string }
  | { kind: "stop" }
  | { kind: "model"; model: string }
  // `on: "toggle"` for a bare `/auto-mode` (flip current state); the caller
  // resolves it against the live session state at submit time.
  | { kind: "auto-mode"; on: boolean | "toggle" }
  | { kind: "auto-mode-invalid" }
  | { kind: "send"; text: string };

export function classifyComposerInput(raw: string, hasImages: boolean): ComposerRoute {
  // Bash is text-only; an attachment forces the send/chat path.
  if (raw.startsWith("!") && !hasImages) return { kind: "bash", command: raw.slice(1).trim() };
  if (raw.startsWith(">")) return { kind: "chat", text: raw.slice(1).trim() };
  if (!hasImages) {
    if (/^\/stop$/.test(raw)) return { kind: "stop" };
    const model = /^\/model\s+(\S[\s\S]*)$/.exec(raw);
    if (model) return { kind: "model", model: model[1].trim() };
    // Match `/auto-mode` broadly (any/no argument) so a mistyped arg is caught
    // here and reported, never forwarded to the model as chat.
    const auto = /^\/auto-mode\b\s*(.*)$/i.exec(raw);
    if (auto) {
      const arg = auto[1].trim().toLowerCase();
      if (arg === "") return { kind: "auto-mode", on: "toggle" };
      if (arg === "on") return { kind: "auto-mode", on: true };
      if (arg === "off") return { kind: "auto-mode", on: false };
      return { kind: "auto-mode-invalid" };
    }
  }
  return { kind: "send", text: raw };
}

// Resolve an `/auto-mode` route's target state against the live session state:
// an explicit on/off passes through; a bare `/auto-mode` ("toggle") flips the
// current value. Pure so the flip logic is unit-testable without the component.
export function resolveAutoMode(on: boolean | "toggle", current: boolean): boolean {
  return on === "toggle" ? !current : on;
}

function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Memoized: presence heartbeats re-render the center pane ~every 10s (plus on
// every SSE/typing change). With a stable `setTyping` (useCallback in
// usePresence) the composer's own local state is all that should drive its
// re-renders — not presence churn.
export const ShellComposer = memo(function ShellComposer({
  setTyping,
}: {
  setTyping: (t: boolean) => void;
}) {
  const active = useActiveSession();
  const [text, setText] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  // File references added from the Files navigator, shown as removable chips
  // (like image attachments) rather than spliced into the text — they're folded
  // back into the outgoing message on send. Each entry is a full mention, e.g.
  // "#src/app.py" or "#src/app.py:42". The sandbox rewrites these to claude's
  // own "@" syntax for the model only (see toClaudeFileRefs); the transcript
  // keeps the "#".
  const [refs, setRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Shell-style prompt history (newest-first): ArrowUp/ArrowDown recall past
  // user messages (and `!bash` shortcuts). histIdx is -1 when not browsing;
  // draftRef stashes the in-progress text so ArrowDown past the newest restores it.
  const histIdxRef = useRef(-1);
  const draftRef = useRef("");
  const autocomplete = useComposerAutocomplete();
  const { registerInserter } = useComposerInsert();
  const { entries: commandEntries } = useCommands();
  const commandLabels = useMemo(() => new Set(commandEntries.map((e) => e.label)), [commandEntries]);
  // A slash command owns the whole turn and is dispatched BARE — claude only
  // runs it when the leading "/" is at byte 0, so it can't ride alongside an
  // image content block. We still recognise the command when images are
  // attached: those images are simply hidden and HELD BACK (not sent with the
  // command), then reappear the moment the command text is cleared so the
  // normal image-submit path resumes. A line that merely mentions "/" mid-text,
  // or a leading "/" that isn't a known command, is just an ordinary turn.
  const leadingToken = /^\/(\S+)/.exec(text.trimStart())?.[1] ?? null;
  const isCommand = leadingToken != null && commandLabels.has(leadingToken);

  // Browser-only identity (meta tag / sessionStorage) — gate on mount so the
  // first client render matches the server's, which always sees "host"/"Host".
  // Without this the avatar hydrated as "H" (server) vs "B" (client) and took
  // the whole session view's hydration down with it.
  const mounted = useMounted();
  const spectator = mounted && isPeerClient() && peerCapability() === "spectate";
  const me = initials(mounted ? myDisplayName() : "Host");

  const history = useMemo<string[]>(() => {
    const out: string[] = [];
    const evs = active.events;
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      let t: string | null = null;
      if (ev.hook_type === "UserPromptSubmit") t = userPromptText(ev);
      else if (ev.hook_type === "BashShortcut") {
        const cmd = extractEventField(ev.text, "tool_input");
        if (cmd) t = `!${cmd}`;
      }
      if (!t) continue;
      if (out.length > 0 && out[out.length - 1] === t) continue; // drop consecutive dupes
      out.push(t);
    }
    return out;
  }, [active.events]);

  // Set the value, resize the textarea, and drop the caret at `caret` (default
  // end). Sets el.value directly (in sync with setText) so height + caret are
  // correct this frame; a programmatic value set does not fire onChange.
  function applyValue(t: string, caret: number = t.length) {
    setText(t);
    setTyping(t.trim().length > 0);
    const el = taRef.current;
    if (el) {
      el.value = t;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      el.selectionStart = el.selectionEnd = caret;
    }
  }

  // Add a `#mention` as a deduped reference chip.
  function addRef(mention: string) {
    const m = mention.startsWith("#") ? mention : `#${mention}`;
    setRefs((cur) => (cur.includes(m) ? cur : [...cur, m]));
  }

  // Apply an autocomplete pick: a `/command` splices inline, a `#file` becomes a
  // chip (the partial token was already stripped from `result.text`).
  function applySelect(result: ReturnType<typeof autocomplete.select>) {
    if (!result) return;
    if (result.kind === "ref") addRef(result.ref);
    applyValue(result.text, result.cursor);
  }

  // The Files navigator adds references as chips (not inline text): dedupe,
  // append, and focus the composer so the user can keep typing. They ride along
  // on the next send/chat turn (folded into the message text) — see submit().
  useEffect(() => {
    registerInserter((ref) => {
      addRef(ref);
      taRef.current?.focus();
    });
    return () => registerInserter(null);
  }, [registerInserter]);

  async function submit() {
    const raw = text.trim();
    const attached = images;
    const attachedRefs = refs;
    const hasImages = attached.length > 0;
    const hasRefs = attachedRefs.length > 0;
    if ((!raw && !hasImages && !hasRefs) || busy) return;
    // A slash command is dispatched bare, so any attached images are held back
    // rather than sent with it: route as an imageless turn and keep the images
    // on the composer (they reappear for the next ordinary turn). The router
    // therefore only ever sees hasImages=false for a command.
    const commandTurn = isCommand;
    const sendImages = hasImages && !commandTurn;
    const route = classifyComposerInput(raw, sendImages);
    // File-reference chips fold into the message text ONLY on the model/chat
    // paths. bash/stop/model and bare commands leave them untouched — they stay
    // as chips and ride the next ordinary turn.
    const useRefs = hasRefs && (route.kind === "send" || route.kind === "chat");
    const withRefs = (t: string) =>
      useRefs ? [t, attachedRefs.join(" ")].filter(Boolean).join(t ? " " : "") : t;
    setBusy(true);
    setTyping(false);
    histIdxRef.current = -1;
    draftRef.current = "";
    // Clear immediately — the send is a network round-trip; leaving the draft in
    // place until it resolves reads as lag. On failure we restore text (+ images
    // and refs for a turn that used them). A command turn preserves its held-back
    // images and refs.
    setText("");
    if (!commandTurn) setImages([]);
    if (useRefs) setRefs([]);
    if (taRef.current) taRef.current.style.height = "auto";
    try {
      switch (route.kind) {
        case "bash":
          await active.runBash(route.command);
          break;
        case "chat":
          await active.chat(withRefs(route.text), sendImages ? toChatImages(attached) : undefined);
          break;
        case "stop":
          await active.stop();
          break;
        case "model":
          await active.setModel(route.model);
          break;
        case "auto-mode":
          // Resolve a bare `/auto-mode` against the live state (flip it). The
          // server no-ops an unchanged value, so an explicit on/off that matches
          // current state is harmless.
          await active.setAutoMode(resolveAutoMode(route.on, active.meta.autoMode));
          break;
        case "auto-mode-invalid":
          // Malformed argument: surface inline, never forward to the model.
          active.reportError("Usage: /auto-mode on|off");
          break;
        case "send":
          await active.send(withRefs(route.text), sendImages ? toSendImages(attached) : undefined);
          break;
      }
    } catch {
      setText(raw);
      if (!commandTurn) setImages(attached);
      if (useRefs) setRefs(attachedRefs);
    } finally {
      setBusy(false);
    }
  }

  async function addFiles(files: File[]) {
    const added = await readImages(files, images.length);
    if (added.length) setImages((cur) => [...cur, ...added].slice(0, MAX_ATTACHMENTS));
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    void addFiles(Array.from(e.target.files ?? []));
    e.target.value = ""; // let the same file be re-picked
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // A command can't carry an image — ignore a pasted image while one is being
    // typed (let the default paste stand for any text content).
    if (isCommand) return;
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // The autocomplete popover gets first crack at every key while a `/` or
    // `#` trigger is active — otherwise ArrowUp/ArrowDown would fall through
    // to prompt-history recall below, and Enter would submit instead of
    // inserting the highlighted entry.
    const action = autocomplete.onKeyDown(e);
    if (action) {
      e.preventDefault();
      if (action === "select") {
        const el = taRef.current;
        const cursor = el?.selectionStart ?? text.length;
        applySelect(autocomplete.select(text, cursor));
      }
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && history.length > 0) {
      const el = taRef.current;
      if (!el) return;
      const cursor = el.selectionStart ?? el.value.length;

      if (e.key === "ArrowUp") {
        // Only hijack when the cursor is on the first line — otherwise the user
        // is navigating within a multi-line draft.
        if (el.value.slice(0, cursor).includes("\n")) return;
        const next = Math.min(history.length - 1, histIdxRef.current + 1);
        e.preventDefault();
        if (next !== histIdxRef.current) {
          if (histIdxRef.current === -1) draftRef.current = el.value;
          histIdxRef.current = next;
          applyValue(history[next]);
        }
        return;
      }

      // ArrowDown: only act while browsing history, and only from the last line.
      if (histIdxRef.current < 0) return;
      if (el.value.slice(cursor).includes("\n")) return;
      e.preventDefault();
      const next = histIdxRef.current - 1;
      if (next < 0) {
        histIdxRef.current = -1;
        const restored = draftRef.current;
        draftRef.current = "";
        applyValue(restored);
      } else {
        histIdxRef.current = next;
        applyValue(history[next]);
      }
    }
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    // A real edit exits history browsing.
    histIdxRef.current = -1;
    setText(e.target.value);
    setTyping(e.target.value.trim().length > 0);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    autocomplete.onTextChange(el.value, el.selectionStart ?? el.value.length);
  }

  if (spectator) {
    return (
      <div className="px-3 sm:px-5 pt-1 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-5">
        <div className="flex items-center gap-2 rounded-xl px-3.5 py-3 text-[12px] text-ink-mute bg-sunken border border-divider">
          <Eye className="w-4 h-4 shrink-0 text-sdk" />
          <span>Spectating — read only. Ask the host for drive access to participate.</span>
        </div>
      </div>
    );
  }

  const hasImages = images.length > 0;
  const hasRefs = refs.length > 0;
  // `>` chat wins (chat carries images); `!` bash only when nothing is attached.
  const mode = text.startsWith(">") ? "chat" : !hasImages && text.startsWith("!") ? "bash" : null;
  const canSend = (text.trim().length > 0 || hasImages || hasRefs) && !busy;

  return (
    <div className="px-3 sm:px-5 pt-1 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-5">
      {active.sendError && (
        <div className="mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] bg-fail/[0.14] border border-fail/30 text-fail">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="font-medium">{active.sendError}</span>
        </div>
      )}

      <div
        className={cn(
          "field relative flex flex-col gap-2 px-2 py-2",
          mode === "chat" && "is-chat",
          mode === "bash" && "is-bash",
        )}
      >
        {autocomplete.open && (
          <AutocompletePopover
            entries={autocomplete.entries}
            activeIndex={autocomplete.activeIndex}
            onHover={autocomplete.setActiveIndex}
            onSelect={(entry) => {
              const el = taRef.current;
              const cursor = el?.selectionStart ?? text.length;
              applySelect(autocomplete.select(text, cursor, entry));
            }}
          />
        )}
        {/* File-reference chips (from the Files navigator), above the input row.
          * Blue `sdk` accent to match the navigator. Like images, they're held
          * back and hidden while a slash command is typed, reappearing after. */}
        {hasRefs && !isCommand && (
          <div className="flex flex-wrap gap-1.5 px-1 pt-0.5">
            {refs.map((r) => (
              <span
                key={r}
                className="inline-flex items-center gap-1 rounded-md pl-1.5 pr-1 py-1 text-[11px] font-mono bg-sdk/[0.15] text-sdk border border-sdk/30 max-w-full"
              >
                <Hash className="w-3 h-3 shrink-0" />
                <span className="truncate">{r.replace(/^#/, "")}</span>
                <button
                  type="button"
                  onClick={() => setRefs((cur) => cur.filter((x) => x !== r))}
                  title="Remove reference"
                  aria-label={`Remove ${r}`}
                  className="shrink-0 rounded p-0.5 text-sdk/70 hover:text-fail transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* Attached thumbnails live inside the field, above the input row.
          * Hidden while a slash command is typed — the command is sent bare and
          * the images are held back, reappearing once the command is cleared. */}
        {hasImages && !isCommand && (
          <div className="flex flex-wrap gap-2 px-1 pt-0.5">
            {images.map((a) => (
              <div key={a.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewUrl(a)}
                  alt={a.name}
                  className="h-14 w-14 rounded-lg object-cover border border-divider"
                />
                <button
                  type="button"
                  onClick={() => setImages((cur) => cur.filter((i) => i.id !== a.id))}
                  title="Remove"
                  aria-label={`Remove ${a.name}`}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-elevated border border-divider flex items-center justify-center text-ink-mute hover:text-fail transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* items-end pins the avatar and action buttons to the bottom of the
          * textarea so they hold their on-screen position as a multi-line draft
          * grows upward (rather than drifting with a centered row). A single-line
          * draft still reads centered since every child shares the bottom edge. */}
        {/* suppressHydrationWarning: password-manager extensions (Proton Pass,
          * etc.) tag this input container with data-protonpass-form before
          * hydration, which would otherwise trip a dev-only mismatch here. */}
        <div className="flex items-end gap-2" suppressHydrationWarning>
          {/* Avatar doubles as the mode indicator: your initials normally, the
            * op glyph (tinted red/green) while typing a `!` bash or `>` chat.
            * Wrapped in a send-button-height (h-9) box, centered, so the row's
            * items-end pins it to the bottom line while its center still lines up
            * with the action buttons (the 28px avatar alone would sit low). */}
          <span className="flex h-9 items-center shrink-0">
            <span
              className={cn(
                "avatar w-7 h-7 text-[10px] transition-colors",
                mode === "bash" ? "avatar-fail" : mode === "chat" ? "avatar-wrap" : "text-ink",
              )}
            >
              {mode === "bash" ? (
                <Terminal className="w-3.5 h-3.5" />
              ) : mode === "chat" ? (
                <MessageCircle className="w-3.5 h-3.5" />
              ) : (
                me
              )}
            </span>
          </span>
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => {
              setTyping(false);
              autocomplete.close();
            }}
            placeholder={
              mode === "bash" ? "bash command…" : mode === "chat" ? "message to participants…" : "type a message…"
            }
            // self-center: a single-line draft centers vertically with the
            // avatar/buttons instead of sticking to the row's bottom edge (the
            // row is items-end for the multiline case). Once the textarea grows
            // past the control height it becomes the tallest item and fills the
            // row, so the controls still pin to the last line.
            className="flex-1 self-center bg-transparent border-0 outline-none resize-none text-[13px] text-ink placeholder:text-ink-hush leading-relaxed py-1"
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={onPickFiles}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={mode === "bash" || isCommand || images.length >= MAX_ATTACHMENTS}
            title={
              mode === "bash"
                ? "Images aren't supported for bash commands"
                : isCommand
                  ? hasImages
                    ? "Images are held while a command is typed"
                    : "Images aren't supported for slash commands"
                  : images.length >= MAX_ATTACHMENTS
                    ? `Up to ${MAX_ATTACHMENTS} images`
                    : "Attach image"
            }
            aria-label="Attach image"
            className="icon-btn w-8 h-8 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            title="Send"
            aria-label="Send"
            className={cn(
              "accent-btn w-9 h-9 rounded-full shrink-0",
              mode === "chat" && "is-chat",
              mode === "bash" && "is-bash",
              !canSend && "opacity-50",
            )}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </div>
      <p className="font-mono text-[10px] text-ink-faint mt-2 px-1 text-center lg:text-left">
        enter to send · shift+enter for newline · ↑↓ history ·{" "}
        <span className={cn(mode === "bash" && "text-fail font-semibold")}>! bash</span> ·{" "}
        <span className={cn(mode === "chat" && "text-wrap font-semibold")}>&gt; chat</span> ·{" "}
        {/* One highlight per affordance, keyed on WHICH trigger is live — a
          * single span keyed on "something is open" lit the file/command hint
          * while the user was typing an `@peer`. */}
        <span className={cn(autocomplete.triggerType === "slash" && "text-accent font-semibold")}>/ commands</span> ·{" "}
        <span className={cn(autocomplete.triggerType === "file" && "text-accent font-semibold")}># files</span> ·{" "}
        <span className={cn(autocomplete.triggerType === "peer" && "text-accent font-semibold")}>@ peers</span>
      </p>
    </div>
  );
});
