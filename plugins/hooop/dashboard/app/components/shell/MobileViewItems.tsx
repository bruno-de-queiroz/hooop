"use client";
import { Folder, Globe, NotebookText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { RailView } from "@/app/context/FilesUIProvider";
import { usePreviewUI } from "@/app/context/PreviewUIProvider";
import { StatusDot } from "../ui/StatusDot";
import { previewCue } from "./preview/previewCue";

const ITEMS: Array<{ v: RailView; label: string; icon: LucideIcon }> = [
  { v: "details", label: "Details", icon: NotebookText },
  { v: "files", label: "Files", icon: Folder },
  { v: "browser", label: "Browser", icon: Globe },
];

/**
 * The way into the rail's sections on a phone, where the rail does not exist.
 *
 * Browser belongs here for the same reason the globe is permanent in the desktop
 * rail. Without it the preview was reachable on a phone only by opening Details
 * or Files first and then noticing the tabs inside — or by the agent opening it
 * for you, which is not a way to find something, it is a way to be shown it.
 *
 * Its own file so this is testable without standing up the whole session header,
 * which needs half a dozen providers to render at all.
 */
export function MobileViewItems({ onPick }: { onPick: (v: RailView) => void }) {
  const { preview } = usePreviewUI();
  return (
    <div className="lg:hidden">
      {ITEMS.map(({ v, label, icon: Icon }) => (
        <button
          key={v}
          className="list-row w-full text-left px-2 py-1.5 text-[12px] flex items-center gap-2"
          onClick={() => onPick(v)}
        >
          <Icon className="w-3.5 h-3.5 text-ink-mute" />
          {label}
          {/* The same cue the rail carries: whether there is an app running is
            * worth knowing before you decide whether to go and look. */}
          {v === "browser" && preview && (
            <StatusDot
              state={previewCue(preview.state)}
              size="sm"
              pulse={preview.state === "starting"}
              className="ml-auto"
            />
          )}
        </button>
      ))}
      <div className="my-1 border-t border-divider" />
    </div>
  );
}
