"use client";
import { useFilesUI } from "@/app/context/FilesUIProvider";
import { ShellPlanDock } from "./ShellPlanDock";
import { ShellFilesDock } from "./files/ShellFilesDock";

// The single docked slot between the chat frame and the right rail: an open file
// wins over a plan review, and each self-hides when it has nothing to show.
//
// The live preview is deliberately NOT here. It is a rail SECTION (Details |
// Files | Browser), so it competes with the other rail sections rather than with
// the docked file — which means opening the browser no longer has to evict a file
// you were reading, and the two can be on screen together.
export function ShellRightDock() {
  const { file } = useFilesUI();
  if (file) return <ShellFilesDock />;
  return <ShellPlanDock />;
}
