"use client";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button, IconButton } from "../ui";
import { Modal } from "../ui/Overlay";

// Shared delete-confirmation dialog for a session — replaces the old
// `window.confirm(...)` prompts (native confirm blocks the render thread,
// can't be styled, and reads inconsistently across browsers). Built on the
// Modal primitive so it gets the dialog role, focus trap, and Esc/click-out
// for free; both the rail row's ✕ and the header's "Delete session" menu
// item render this instead of calling confirm() directly.

export function ConfirmDeleteSessionModal({
  open,
  sessionName,
  onConfirm,
  onClose,
  busy = false,
}: {
  open: boolean;
  sessionName: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} label="Delete session?" className="max-w-sm">
      <div className="flex items-center gap-2 px-5 h-14 shrink-0 border-b border-divider">
        <AlertTriangle className="w-4 h-4 text-fail" />
        <span className="font-sans text-[14px] font-semibold text-ink">Delete session?</span>
        <IconButton label="Close" size="sm" className="ml-auto" onClick={onClose} disabled={busy}>
          <X className="w-4 h-4" />
        </IconButton>
      </div>

      <div className="px-5 py-4 flex flex-col gap-2">
        <p className="text-[13px] text-ink-soft">
          Are you sure you want to delete &quot;{sessionName}&quot;?
        </p>
        <p className="text-[11px] text-ink-faint">
          The workspace for this session will also be permanently deleted.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-divider">
        <Button variant="pill" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="pill"
          size="sm"
          onClick={onConfirm}
          disabled={busy}
          className="border border-fail/40 bg-transparent text-fail hover:bg-fail/10 hover:text-fail"
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Delete
        </Button>
      </div>
    </Modal>
  );
}
