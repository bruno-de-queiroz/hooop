"use client";
import { useEffect, useRef } from "react";
import type { AutocompleteEntry } from "@/app/context/CommandsProvider";
import { Chip, type ChipProps } from "../ui/Chip";
import { cn } from "../ui/cn";

const KIND_TONE: Record<AutocompleteEntry["kind"], NonNullable<ChipProps["tone"]>> = {
  command: "accent",
  skill: "wrap",
  builtin: "neutral",
  file: "sdk",
  dir: "direct",
};

export function AutocompletePopover({
  entries,
  activeIndex,
  onHover,
  onSelect,
}: {
  entries: AutocompleteEntry[];
  activeIndex: number;
  onHover: (i: number) => void;
  onSelect: (entry: AutocompleteEntry) => void;
}) {
  // Keyboard nav moves activeIndex but the browser only auto-scrolls to elements
  // it focuses — and we keep focus in the textarea — so the highlighted row can
  // slide out of the scroll viewport. Nudge it back into view on every change.
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (entries.length === 0) return null;

  return (
    <div
      data-testid="autocomplete-popover"
      className="absolute bottom-full inset-x-0 mb-2 max-h-56 overflow-y-auto rounded-xl border border-divider bg-elevated shadow-overlay py-1"
    >
      {entries.map((entry, i) => {
        const active = i === activeIndex;
        return (
          <button
            key={entry.insert}
            type="button"
            ref={active ? activeRef : undefined}
            data-testid={active ? "autocomplete-item-active" : undefined}
            onMouseDown={(e) => {
              // Fires before the textarea's blur, unlike onClick — keeps
              // focus (and the caret position) in the textarea.
              e.preventDefault();
              onSelect(entry);
            }}
            onMouseEnter={() => onHover(i)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]",
              active ? "bg-accent/10 text-ink" : "text-ink-soft",
            )}
          >
            {/* The name is the thing being inserted — it must always read in full.
              * `shrink-0` keeps it at its natural width no matter how tight the
              * row gets; the description (which is disposable context) is what
              * yields space and gets ellipsed via `min-w-0` + `truncate`. */}
            <span className="truncate shrink-0 font-mono">{entry.insert}</span>
            {entry.description && (
              <span className="truncate min-w-0 flex-1 text-ink-mute text-[11px]">{entry.description}</span>
            )}
            <Chip tone={KIND_TONE[entry.kind]} className="ml-auto shrink-0">
              {entry.kind}
            </Chip>
          </button>
        );
      })}
    </div>
  );
}
