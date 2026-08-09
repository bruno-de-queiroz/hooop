"use client";
import { useMemo, useRef, useState } from "react";
import { useCommands, type AutocompleteEntry } from "@/app/context/CommandsProvider";
import { useFiles } from "@/app/context/useFiles";
import { canDecidePermissions, useMounted } from "../lib/participant";

export interface ComposerTrigger {
  type: "slash" | "file";
  /** Index into the text where the trigger character ("/" or "#") sits. */
  start: number;
  /** Text typed after the trigger character, up to the caret. */
  query: string;
}

/**
 * Resolves the active `/` or `#` trigger (if any) given the composer's
 * text and caret offset. `/` only fires when it's the very first
 * character and no space has been typed yet — a slash command is the
 * whole message, mirroring how `!bash` / `>chat` mode-detection already
 * works. `#` fires at the start of the current whitespace-delimited
 * word, anywhere in the text — an inline file mention.
 */
export function detectTrigger(text: string, cursor: number): ComposerTrigger | null {
  const before = text.slice(0, cursor);

  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { type: "slash", start: 0, query: slash[1] };

  const hash = /(?:^|\s)#(\S*)$/.exec(before);
  if (hash) {
    const start = before[hash.index] === "#" ? hash.index : hash.index + 1;
    return { type: "file", start, query: hash[1] };
  }

  return null;
}

/** Splices `insert + " "` into `text` at the trigger's token, replacing
 * everything from the trigger character through the caret. Pure so the
 * splice math is testable without rendering the stateful hook below. */
export function spliceTrigger(
  text: string,
  cursor: number,
  trigger: ComposerTrigger,
  insert: string,
): { text: string; cursor: number } {
  const insertion = `${insert} `;
  const nextText = text.slice(0, trigger.start) + insertion + text.slice(cursor);
  return { text: nextText, cursor: trigger.start + insertion.length };
}

/** Removes the trigger token (from `trigger.start` through the caret) entirely,
 * collapsing a double space at the seam. Used when a `#file` selection becomes
 * a chip instead of inline text, so no partial `#query` is left behind. Pure. */
export function removeTriggerToken(
  text: string,
  cursor: number,
  trigger: ComposerTrigger,
): { text: string; cursor: number } {
  const before = text.slice(0, trigger.start);
  let after = text.slice(cursor);
  if (/\s$/.test(before) && /^\s/.test(after)) after = after.replace(/^\s+/, "");
  return { text: before + after, cursor: before.length };
}

// A resolved autocomplete pick: `/command` splices inline ("text"); `#file`
// becomes a removable chip ("ref", with the partial token stripped from text).
export type AutocompleteSelectResult =
  | { kind: "text"; text: string; cursor: number }
  | { kind: "ref"; ref: string; text: string; cursor: number };

export type ComposerAutocompleteAction = "navigated" | "select" | "close" | null;

export interface UseComposerAutocompleteResult {
  open: boolean;
  entries: AutocompleteEntry[];
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  /** Call from the textarea's onChange with the new value + caret offset. */
  onTextChange: (text: string, cursor: number) => void;
  /**
   * Call from the textarea's onKeyDown BEFORE any other handling. A
   * non-null return means the key was consumed — the caller should
   * preventDefault and skip its own handling. `"select"` means the
   * caller should now call `select(text, cursor)` and apply the result.
   */
  onKeyDown: (e: { key: string; shiftKey?: boolean }) => ComposerAutocompleteAction;
  /**
   * Resolves the active (or given) entry at the trigger position. A `/command`
   * returns an inline `"text"` splice; a `#file` returns a `"ref"` (the mention
   * for a chip, with the partial `#query` stripped from the text). Null if
   * there's no active trigger or no entry to insert.
   */
  select: (text: string, cursor: number, entry?: AutocompleteEntry) => AutocompleteSelectResult | null;
  close: () => void;
}

export function useComposerAutocomplete(): UseComposerAutocompleteResult {
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const { entries: commandEntries } = useCommands();
  const { entries: fileEntries } = useFiles(trigger?.type === "file" ? trigger.query : null);

  // Hide commands the viewer can't actually run (e.g. `/auto-mode` for a
  // drive/spectate peer) — mirrors the header pill / permission bubble, which
  // don't render their auto-mode controls for those peers. The sandbox route
  // stays authoritative; this only removes a dead-end affordance. Mount-gated:
  // pre-mount the client renders as host (can decide), matching the server.
  const mounted = useMounted();
  const canPermission = !mounted || canDecidePermissions();

  const entries = useMemo<AutocompleteEntry[]>(() => {
    if (!trigger) return [];
    if (trigger.type === "file") return fileEntries;
    const q = trigger.query.toLowerCase();
    return commandEntries
      .filter((e) => e.requires !== "permission" || canPermission)
      .filter((e) => e.label.toLowerCase().includes(q))
      .slice(0, 20);
  }, [trigger, commandEntries, fileEntries, canPermission]);

  // A fresh trigger (new token, or the query within it changed) always
  // restarts the highlight at the top of the list. Adjusted during render
  // (comparing against the previous render's key) rather than in an effect,
  // so the reset is visible in the same render as the new entries.
  const triggerKey = trigger ? `${trigger.type}:${trigger.query}` : null;
  const prevTriggerKeyRef = useRef(triggerKey);
  if (prevTriggerKeyRef.current !== triggerKey) {
    prevTriggerKeyRef.current = triggerKey;
    if (activeIndex !== 0) setActiveIndex(0);
  }

  const clampedActiveIndex = Math.min(activeIndex, Math.max(entries.length - 1, 0));

  function close() {
    setTrigger(null);
    setActiveIndex(0);
  }

  function onTextChange(text: string, cursor: number) {
    setTrigger(detectTrigger(text, cursor));
  }

  function onKeyDown(e: { key: string; shiftKey?: boolean }): ComposerAutocompleteAction {
    if (!trigger || entries.length === 0) return null;
    switch (e.key) {
      case "ArrowDown":
        setActiveIndex((i) => Math.min(i + 1, entries.length - 1));
        return "navigated";
      case "ArrowUp":
        setActiveIndex((i) => Math.max(i - 1, 0));
        return "navigated";
      case "Escape":
        close();
        return "close";
      case "Tab":
        return "select";
      case "Enter":
        return e.shiftKey ? null : "select";
      default:
        return null;
    }
  }

  function select(
    text: string,
    cursor: number,
    entry?: AutocompleteEntry,
  ): AutocompleteSelectResult | null {
    if (!trigger) return null;
    const chosen = entry ?? entries[clampedActiveIndex];
    if (!chosen) return null;
    if (trigger.type === "file") {
      // A file mention becomes a chip: strip the partial `#query` from the text
      // and hand the mention back for the composer to add as a reference chip.
      const stripped = removeTriggerToken(text, cursor, trigger);
      close();
      return { kind: "ref", ref: chosen.insert, text: stripped.text, cursor: stripped.cursor };
    }
    const spliced = spliceTrigger(text, cursor, trigger, chosen.insert);
    close();
    return { kind: "text", text: spliced.text, cursor: spliced.cursor };
  }

  return {
    open: trigger !== null,
    entries,
    activeIndex: clampedActiveIndex,
    setActiveIndex,
    onTextChange,
    onKeyDown,
    select,
    close,
  };
}
