"use client";
import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import { canInsertReferences, useMounted } from "@/app/components/lib/participant";

// Lets components outside the composer (the Files navigator + file-preview dock)
// drop an `@reference` into the live chat composer. ShellComposer registers its
// splice implementation on mount; callers use `insertReference(...)`. The impl
// is held in a ref so registering it never re-renders consumers.

type Inserter = (ref: string) => void;

interface ComposerInsertValue {
  /** ShellComposer registers (or clears, with null) its insert-at-cursor fn. */
  registerInserter: (fn: Inserter | null) => void;
  /** Insert an `@reference` (e.g. "@src/foo.py" or "@src/foo.py:42") at the caret. */
  insertReference: (ref: string) => void;
  /** Whether this viewer may add references at all. False for spectate-only
   * peers — a reference is an input action. Consumers use this to HIDE the
   * insert affordances (the "+" in the tree, the "@" in the preview header, the
   * line-click gutter); `insertReference` is also a hard no-op when false. */
  canInsert: boolean;
}

const Ctx = createContext<ComposerInsertValue | null>(null);

export function ComposerInsertProvider({ children }: { children: React.ReactNode }) {
  const inserter = useRef<Inserter | null>(null);
  // Default to allowed until mounted (the capability meta is browser-only, so a
  // render-time read during SSR/first paint would mismatch — same gate the
  // composer uses for its spectate note). Post-mount this resolves to the real
  // capability: spectate peers get `false`.
  const mounted = useMounted();
  const canInsert = !mounted || canInsertReferences();

  const registerInserter = useCallback((fn: Inserter | null) => {
    inserter.current = fn;
  }, []);
  const insertReference = useCallback((ref: string) => {
    if (!canInsert) return; // spectators can't add references anywhere
    inserter.current?.(ref);
  }, [canInsert]);
  const value = useMemo<ComposerInsertValue>(
    () => ({ registerInserter, insertReference, canInsert }),
    [registerInserter, insertReference, canInsert],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Insert `@references` into the composer. Safe no-op if no composer is mounted. */
export function useComposerInsert(): ComposerInsertValue {
  const c = useContext(Ctx);
  // Tolerate absence (e.g. tests rendering a component in isolation): a no-op
  // keeps callers simple and never throws in an unexpected tree.
  return c ?? { registerInserter: () => {}, insertReference: () => {}, canInsert: true };
}
