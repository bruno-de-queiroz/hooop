# Bug: mobile on-screen keyboard covers the composer

## Summary
On mobile (reported on iOS), opening the on-screen keyboard covers the message
composer / latest messages — you can't see the input you're typing into.

## Root cause
`AppShell` (`plugins/hooop/dashboard/app/components/ui/AppShell.tsx`) sized the
whole app with `h-[100dvh]`. The `dvh` unit tracks the *dynamic* viewport
(browser address bar) but **not** the software keyboard: when the keyboard opens
on iOS/Android the layout viewport keeps its full height and only
`window.visualViewport` shrinks. So the `100dvh` shell stayed full-height and its
bottom-anchored composer (a `shrink-0` footer in the flex column) ended up behind
the keyboard.

## Fix (implemented)
Drive the shell's height from the live `visualViewport.height` instead of a fixed
`100dvh`:

- New hook `plugins/hooop/dashboard/app/components/ui/useVisualViewportHeight.ts`
  mirrors `window.visualViewport.height` into the `--app-height` CSS variable and
  updates it on the viewport `resize`/`scroll` events (keyboard show/hide). It
  also locks `body` scrolling while the shell is mounted so iOS can't scroll the
  taller-than-visual layout viewport and tuck the composer back under the
  keyboard. Body-scroll lock is scoped to the shell (set/restored in the hook),
  so other routes (`/join`, `/left`, `/ui-gallery`) are unaffected.
- `AppShell` calls the hook and uses `h-[var(--app-height,100dvh)]`. The `100dvh`
  fallback keeps the current behavior before JS runs / on browsers without
  `visualViewport`, so nothing regresses there. The existing flex layout
  (transcript `flex-1`, composer `shrink-0`) makes the transcript absorb the
  shrink while the composer stays visible just above the keyboard.

The composer already respects the home-indicator area via
`pb-[max(0.75rem,env(safe-area-inset-bottom))]` (`ShellComposer.tsx`); this fix
handles the keyboard, which safe-area insets don't cover.

## Tests (added)
`useVisualViewportHeight.test.tsx`:
- sets `--app-height` from `visualViewport.height` and follows a keyboard-open
  resize (800 → 520);
- locks body scroll while mounted and restores it (plus removes listeners and the
  CSS var) on unmount;
- falls back to `window.innerHeight` when `visualViewport` is unavailable.

Verified: full dashboard suite green (`npx vitest run` → 53 files / 449 tests) and
`npx tsc --noEmit` clean.

## Verification (manual, recommended)
Load the dashboard on a real iOS Safari / Android Chrome device (or the tunnel
URL), focus the composer, and confirm the input and latest messages stay visible
above the keyboard as it opens and closes. Emulator devtools don't reproduce the
`visualViewport` keyboard behavior faithfully — test on a device.

---

## Follow-up (mobile peer report): black gap, multiline breakage, drifting controls

A mobile peer (Android/Chromium) reported that the first fix left a **black gap**
between the layout and the keyboard, that a **multiline** draft grew while the row
stayed top/centered-aligned (breaking the layout), and asked that the **avatar and
action buttons stay pinned to the bottom** of the text box as it grows.

### Cause
The v1 hook sized the app to `visualViewport.height` and locked body scroll, but
`html`/`body` kept full *layout-viewport* height. On Chromium the layout viewport
doesn't shrink for the keyboard by default (`interactive-widget=resizes-visual`),
so the app box was shorter than `body` and `body`'s near-black background showed in
the gap. The composer row was also `items-center`, so its avatar and image/send
buttons drifted as the textarea grew.

### Fix (implemented)
1. **`app/layout.tsx` viewport** — added `interactiveWidget: "resizes-content"`.
   On Chromium the layout viewport (and `dvh`) now shrinks with the keyboard, so
   `100dvh` fits exactly above it — no gap, no JS.
2. **`useVisualViewportHeight.ts` — gap-guarded + black-bar-proof.** It now only
   overrides when `window.innerHeight - visualViewport.height` exceeds a threshold
   (~60px, i.e. a real keyboard on a browser that didn't resize the layout
   viewport — iOS Safari). When it does, it also caps `html`/`body` height to the
   visual-viewport height so no background shows below the shell (kills the gap on
   iOS). Otherwise it clears `--app-height` and lets CSS `100dvh` drive height —
   the normal Chromium path, where the gap is ~0, so the hook is inert there.
3. **`ShellComposer.tsx`** — composer input row changed from `items-center` to
   `items-end`, so the avatar and image/send buttons stay aligned to the bottom of
   the textarea as a multi-line draft grows upward.

### Tests
`useVisualViewportHeight.test.tsx` rewritten for the gap logic: pins to the visual
viewport + caps document height when a real gap is present (innerHeight 800 / vv
520); stays inert with no gap (≈800/≈800); clears the override when the keyboard
closes; restores all inline styles + removes listeners on unmount; does nothing
when `visualViewport` is absent (CSS `100dvh` stands). The `interactiveWidget`
value is type-checked against Next's `Viewport` type by `tsc`; the `items-end`
change is a deterministic CSS edit (no composer test harness exists to assert it
without full provider mocking).

Verified: full dashboard suite green (`npx vitest run` → 53 files / 463 tests) and
`npx tsc --noEmit` clean. Device testing still required for the keyboard behavior
itself (jsdom/emulators don't reproduce it): confirm on Android Chrome + iOS Safari
that there's no black gap, the composer sits on the keyboard, and the avatar/send
buttons stay bottom-aligned as the draft grows.
