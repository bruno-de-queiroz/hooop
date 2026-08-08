/**
 * Let the model operate the preview the OPERATOR is watching.
 *
 * The model already has a headless browser (@playwright/mcp is baked into the
 * sandbox image), so it could always drive an app — invisibly, in a session
 * whose state diverges from the iframe on screen. Watching the agent use the
 * thing it just built is the missing half, and it only works if the actions land
 * in the operator's own page.
 *
 * hooop already proxies every preview response on its way to that page
 * (proxyToRunner), so this injects one script into the HTML as it passes. The
 * script opens a socket back here and executes actions in the live DOM.
 *
 * ── on WebMCP ───────────────────────────────────────────────────────────────
 * The shim below implements the PAGE-facing half of the W3C WebMCP draft
 * (`document.modelContext.registerTool`), so an app can declare `add_todo({text})`
 * and be driven by name instead of by selector.
 *
 * It does NOT use the browser's own WebMCP, because the consuming half does not
 * exist yet: the spec still reads "TODO: Spec and describe the
 * modelContext.getTools() and modelContext.executeTool() APIs", and there is no
 * CDP domain, extension API or Playwright binding. Registered tools are visible
 * only to the page, same-origin documents in its tree, and BUILT-IN browser
 * agents — which a `claude -p` subprocess in a container is not. The explainer
 * does sanction "author-provided agents ... embedded directly on a page", which
 * is exactly what this is.
 *
 * So we provide the standard shape and consume it ourselves. An app written
 * against this needs no change when browsers ship the consuming half. The draft
 * is moving (it was `navigator.modelContext`; `provideContext()` was removed in
 * March 2026, `unregisterTool` became an `AbortSignal` in April), which is the
 * other reason the shim lives in one file: it is expected to be updated.
 */

/** Reserved paths, served by us and never forwarded to the app. */
export const DRIVER_SCRIPT_PATH = "/__hooop/driver.js";
export const DRIVER_SOCKET_PATH = "/__hooop/driver-ws";

/**
 * Is this response one we can splice a <script> into?
 *
 * Deliberately narrow. Anything that is not a plain, self-described HTML
 * document is piped untouched — an app's JSON, assets and streamed responses
 * must come through byte-for-byte.
 */
export function isInjectableHtml(headers) {
  const type = String(headers["content-type"] || "");
  if (!/^text\/html\b/i.test(type)) return false;
  // A response already encoded upstream cannot be string-spliced. We ask for
  // identity on document requests (see stripAcceptEncoding), so seeing one here
  // means the app ignored that — leave it alone rather than corrupt it.
  const enc = String(headers["content-encoding"] || "").trim().toLowerCase();
  return enc === "" || enc === "identity";
}

/**
 * Does this request look like a document navigation?
 *
 * Only those get their `accept-encoding` downgraded, so the app keeps serving
 * compressed assets to everything else.
 */
export function isDocumentRequest(headers) {
  const dest = String(headers["sec-fetch-dest"] || "");
  if (dest) return dest === "document" || dest === "iframe";
  return /\btext\/html\b/i.test(String(headers.accept || ""));
}

/** Insert the script tag before </head>, or before </body>, or not at all. */
export function injectScript(html, tag) {
  const head = html.search(/<\/head\s*>/i);
  if (head >= 0) return html.slice(0, head) + tag + html.slice(head);
  const body = html.search(/<\/body\s*>/i);
  if (body >= 0) return html.slice(0, body) + tag + html.slice(body);
  // No recognisable document shell — a fragment, or something we do not
  // understand well enough to edit. Returning it unchanged is the safe answer:
  // a preview that works without the driver beats one we broke trying.
  return html;
}

/**
 * Blocking, deliberately — NOT `defer`.
 *
 * `defer` waits for the document to be parsed, so the driver ran after every
 * inline script the app has. That is fatal for the WebMCP half: an app declares
 * its tools with `if (document.modelContext) …`, which is the only correct way
 * to write it, and the API did not exist yet. The app registered nothing, said
 * nothing, and `list_page_tools` truthfully reported an empty list — so the one
 * path we tell the model to prefer could never work on a real app.
 *
 * The cost is one same-origin request before first paint on a preview page. The
 * shim has to be in place before any of the app's own code runs; there is no
 * version of this that is both late and correct.
 */
export const SCRIPT_TAG = `<script src="${DRIVER_SCRIPT_PATH}"></script>`;

// ── who is following ────────────────────────────────────────────────────────
//
// A preview is a web page, so every viewer loads their OWN copy with its own DOM
// and its own in-memory state. There is no shared session to drive, which means
// a fan-out synchronises *instructions*, not state: replay one click into two
// copies of a game and they can legitimately end up on different boards.
//
// The fix is not to pretend otherwise. Each viewer is either:
//
//   following — replaying the model's actions, in step because it started in
//               step and has done nothing else since;
//   detached  — somebody took control of that copy. It is theirs now, it stops
//               receiving the fan-out, and it stays out until it reloads.
//
// Acting independently *is* detaching, so the state where two peers believe they
// are watching the same thing while showing different things cannot arise. The
// price is that rejoining means reloading: two diverged client states cannot be
// reconciled, only restarted.

/**
 * How long a page that just navigated has to reconnect before the next action
 * runs without it.
 *
 * Sized for the slowest real follower, not the fastest: a peer reaches the
 * preview through a tunnel, so their document swap and socket reconnect can take
 * seconds where a local tab takes milliseconds. The cost of being generous is a
 * one-off stall when a tab really did close — the entry is cleared after the
 * first wait, so it is paid once, not per action.
 */
/**
 * How long a page has to acknowledge an action before it is treated as OFFLINE.
 *
 * Short on purpose. An action is a click in a page that is already loaded and
 * already connected — it is not a page load — so a page that cannot answer in a
 * second is not slow, it is gone: a closed laptop, a dropped connection, a tab
 * the browser has frozen. Waiting longer for it would hold up everybody who IS
 * there, on every single action.
 *
 * A page dropped this way is not an error and not a straggler to wait for: its
 * socket is closed, and if it is alive it reconnects on its own and rejoins.
 */
export const ACK_TIMEOUT_MS = 1_000;

/**
 * Actions that only LOOK at the page.
 *
 * The all-must-acknowledge rule exists because a write applied to some screens
 * and not others leaves people looking at different things. A read leaves
 * nothing behind, so the rule buys nothing and costs plenty: it made a snapshot
 * fail because an unrelated page was mid-navigation, and then told the model not
 * to try again — for the one kind of call that is always safe to repeat.
 */
export const READ_ONLY_ACTIONS = new Set(["snapshot", "list_tools"]);

/**
 * How long after an action the agent still counts as "using this page".
 *
 * Shared by both surfaces on purpose, and it must match the dashboard's
 * DRIVING_DECAY_MS: the panel keeps its "the agent is using this page" overlay
 * up for this long, and the page holds its out-of-step banner back for exactly
 * as long, so the two can never be on screen together.
 */
export const DRIVE_QUIET_MS = 10_000;

/**
 * The driver script, told which preview it is serving.
 *
 * The page records how far it has got in localStorage, and localStorage is
 * per-ORIGIN — but a slot's origin is a fixed port that the next preview to take
 * the slot inherits, possibly from another session. Keying the record by preview
 * is what stops one app's progress being read as another's.
 */
export function driverScriptFor(previewId) {
  return `window.__hooopPreviewId=${JSON.stringify(String(previewId ?? ""))};\n${DRIVER_SCRIPT}`;
}

export const RECONNECT_GRACE_BASE_MS = 5_000;
/**
 * The ceiling on that wait once latency is taken into account.
 *
 * Peers are not on one network. A viewer on the far side of a tunnel or a phone
 * connection can take many times longer to swap documents and reconnect than a
 * tab on the host's own machine, so a single fixed grace either abandons the
 * slow peer or makes everyone else wait for a worst case that usually does not
 * happen. The grace therefore scales with the slowest round trip we have
 * actually measured on this preview — and stops here, because past this point
 * the honest reading is "that page is gone", and the result says who was left
 * behind rather than the agent waiting forever.
 */
export const RECONNECT_GRACE_MAX_MS = 20_000;

/**
 * Track the pages watching each preview slot and run actions in the ones that
 * are still following.
 *
 * Sockets are held as opaque handles with a `send(string)` — the registry never
 * touches ws internals, which is what lets the interesting logic be tested
 * without a server (`server.mjs` cannot be imported).
 */
export function createDriverRegistry({ log = () => {}, onIdle = (/** @type {number} */ _slot) => {} } = {}) {
  /** slot -> Set of sockets. More than one: two tabs, two peers. */
  const bySlot = new Map();
  /** socket -> {slot, previewId, following}. */
  const state = new Map();
  /** requestId -> resolver for the action in flight on that socket. */
  const waits = new Map();
  /** slot -> callbacks run on every attach, each removing itself when done. */
  const attachWaits = new Map();
  /**
   * slot -> {at, expected}: a following page left, and we expect it back.
   *
   * Navigation is a normal part of driving — the agent clicks a link, the app
   * routes, the document is replaced — and it takes every follower's socket with
   * it for a moment. Without this, the action AFTER a navigation lands only in
   * whichever pages happened to have reconnected first, and the rest silently
   * miss it. That is the co-driving failure this whole design exists to avoid,
   * arriving through the back door.
   */
  const expectBack = new Map();
  /**
   * slot -> slowest round trip observed recently, in ms.
   *
   * Measured from real actions rather than pinged for: every drive already asks
   * every page a question and waits for the answer, so the fan-out is a latency
   * probe that costs nothing extra.
   */
  const slowestRtt = new Map();
  /** slot -> how many actions have been driven there. */
  const actionCount = new Map();
  /** slot -> when the last action went out, for "is the agent still working?". */
  const lastDriveAt = new Map();
  /** How much longer the agent counts as using this slot's pages. */
  function quietRemaining(slot) {
    if (slot === undefined) return 0;
    const at = lastDriveAt.get(slot);
    if (at === undefined) return 0;
    return Math.max(0, DRIVE_QUIET_MS - (Date.now() - at));
  }
  /**
   * slot -> the sequence number of the last action driven there.
   *
   * This is the whole lag mechanism, and it replaces a fingerprint of the page's
   * text. Actions are ORDERED, so how far behind a page is, is not something to
   * be inferred from what it looks like — it is a subtraction. Each action goes
   * out stamped with its number; a page records the number it has applied,
   * durably, BEFORE it acknowledges; on reconnect it says where it got to and the
   * difference is exact.
   *
   * What the old fingerprint got wrong, in both directions: any clock, relative
   * timestamp or animation made two perfectly synchronised viewers disagree
   * forever, and it could not see anything that was not text — a disabled
   * button, a checkbox, a canvas, an image swap. It was a guess about content
   * standing in for a fact about ordering.
   */
  const lastSeq = new Map();
  /**
   * A ring of the last few comings and goings, per slot.
   *
   * Purely diagnostic, and it earns its keep: "the click did not reach everyone"
   * has at least three causes that look identical from the outside — a page that
   * never dropped, one that dropped and came back too late, one that never came
   * back — and they need different fixes. Guessing between them from viewer
   * counts alone is how the last two attempts at this went.
   */
  const recent = [];
  function note(kind, slot, extra = {}) {
    recent.push({ t: Date.now(), kind, slot, ...extra });
    if (recent.length > 60) recent.shift();
  }
  let seq = 0;

  function census(slot) {
    const all = [...(bySlot.get(slot) ?? [])];
    const following = all.filter((ws) => state.get(ws)?.following);
    return { all, following, detached: all.length - following.length };
  }

  /**
   * Clear out sockets belonging to a preview that no longer holds this slot.
   *
   * A slot is a fixed port that the next preview inherits, possibly from another
   * session, and stopping a preview closes nobody's socket — the census plainly
   * shows the old viewers after an idle sweep. Driving one would run this
   * session's action inside another session's app and hand that app's snapshot
   * back to a model with no business reading it. The grant that opened the
   * socket was for a preview that no longer exists, so it has outlived its
   * authorisation.
   *
   * Run at ATTACH as well as before a drive: the first viewer of the new preview
   * is the earliest proof the slot has changed hands, and waiting for a drive
   * means that viewer's own hello is measured against the old preview's ordering
   * — it gets told it is three actions behind a run it was never part of.
   */
  function evictOthers(slot, previewId) {
    if (!previewId) return;
    let evicted = false;
    for (const ws of [...(bySlot.get(slot) ?? [])]) {
      if (state.get(ws)?.previewId === previewId) continue;
      note("evicted", slot, {});
      log(`preview driver from a previous preview evicted from slot ${slot}`);
      dropQuietly(ws);
      try { ws.close?.(); } catch { /* already gone */ }
      evicted = true;
    }
    // Every per-slot number describes the PREVIOUS app: its action ordering, its
    // latency, the pages it was waiting for.
    if (!evicted) return;
    lastSeq.delete(slot);
    slowestRtt.delete(slot);
    expectBack.delete(slot);
    lastDriveAt.delete(slot);
  }

  function attach(slot, previewId, ws) {
    evictOthers(slot, previewId);
    let set = bySlot.get(slot);
    if (!set) { set = new Set(); bySlot.set(slot, set); }
    set.add(ws);
    state.set(ws, { slot, previewId, following: true });
    note("attach", slot, { total: census(slot).all.length });
    notifyWaiters(slot);
    log(`preview driver attached on slot ${slot} (${census(slot).following.length} following)`);
  }

  /**
   * Re-check every parked waiter for this slot.
   *
   * Called on attach AND on hello, because the two carry different news: attach
   * says a page is here, hello says WHICH page. A wait for a named viewer can
   * only be satisfied by the second.
   */
  function notifyWaiters(slot) {
    const list = attachWaits.get(slot);
    if (list) for (const r of [...list]) r();
  }

  /** Forget a socket without expecting it back — see the offline rule above. */
  function dropQuietly(ws) {
    const entry = state.get(ws);
    if (!entry) return;
    state.delete(ws);
    const set = bySlot.get(entry.slot);
    if (set) { set.delete(ws); if (set.size === 0) bySlot.delete(entry.slot); }
  }

  function drop(ws) {
    const entry = state.get(ws);
    if (!entry) return;
    const wasFollowing = entry.following;
    state.delete(ws);
    const set = bySlot.get(entry.slot);
    if (set) { set.delete(ws); if (set.size === 0) bySlot.delete(entry.slot); }
    // Only a FOLLOWER is expected back: a detached page that closes is a person
    // closing a tab they had taken for themselves, and waiting for them would
    // stall every action behind somebody who has left.
    if (wasFollowing) {
      // WHO left, not how many. Counting could not tell a slow peer's return
      // from an unrelated tab opening, so on a session with mixed connection
      // speeds the wait was regularly satisfied by the wrong page while the one
      // we were actually waiting for was still loading.
      //
      // A page with no id yet (dropped before its hello) cannot be waited for by
      // name; it still counts, under a key of its own, so the wait does not
      // simply ignore it.
      const pending = expectBack.get(entry.slot) ?? { at: 0, vids: new Set() };
      pending.at = Date.now();
      pending.vids.add(entry.vid ?? `anon:${++seq}`);
      expectBack.set(entry.slot, pending);
      // Nothing is recorded about where they got to. The PAGE keeps that, and
      // tells us on its way back in — which is the only version that survives a
      // tab being closed, a laptop sleeping, or the server restarting.
    }
    note("drop", entry.slot, { wasFollowing, total: census(entry.slot).all.length });
    log(`preview driver left slot ${entry.slot}`);
  }

  /** A message from a page: either a reply to an action, or a change of stance. */
  function receive(ws, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello") {
      const self = state.get(ws);
      // A fresh document has no idea the agent is mid-run — and a navigation the
      // AGENT caused produces exactly that: the page reloads, says hello, is told
      // it missed actions, and raises its banner underneath the panel's "the
      // agent is using this page" overlay. Two messages, one of them unclickable.
      // Only the server still remembers, so it says so before anything else.
      const quiet = quietRemaining(self?.slot);
      if (quiet > 0) {
        try { ws.send(JSON.stringify({ type: "busy", ms: quiet })); } catch { /* gone */ }
      }
      if (self && typeof msg.vid === "string") {
        self.vid = msg.vid.slice(0, 64);
        const pending = expectBack.get(self.slot);
        // This is the page we were waiting for, back under its own name.
        if (pending) {
          pending.vids.delete(self.vid);
          if (pending.vids.size === 0) expectBack.delete(self.slot);
        }
        notifyWaiters(self.slot);
      }
      // How far behind this page is — a subtraction, not a guess.
      //
      // It reports the sequence number of the last action it actually applied,
      // read from its own storage, so this covers every way of falling behind at
      // once: a tab that was closed, a laptop that slept, a peer whose network
      // dropped, a viewer arriving in the middle of a run, and a page that was
      // mid-navigation when an action went out. None of those need distinguishing
      // any more, and none of them depend on what the page LOOKS like.
      // Not for a page whose viewer has taken control. Lag is a fault only while
      // you are trying to keep up; once the copy is theirs, being somewhere else
      // is what they asked for, and telling them they are behind is nagging them
      // about a decision they made.
      if (self && self.following) {
        const here = Number.isFinite(msg.seq) ? Math.max(0, Math.floor(msg.seq)) : 0;
        self.seq = Math.min(here, lastSeq.get(self.slot) ?? 0);
        const behind = (lastSeq.get(self.slot) ?? 0) - self.seq;
        // Only when there is something to say. A page that is up to date and was
        // never told otherwise does not need telling it is fine, and a protocol
        // that chatters on every reconnect makes the frames that matter harder to
        // see — in a log and in a test.
        if (behind > 0) {
          self.stale = true;
          try { ws.send(JSON.stringify({ type: "stale", missed: behind })); } catch { /* gone */ }
        } else if (self.stale) {
          freshen(ws);
        }
      }
      // Which page this viewer is actually on. Two people can both be following
      // and still be looking at different URLs of the same app — nobody took
      // control, they just opened different pages — and one instruction then
      // hits two unrelated DOMs. Recording it is what lets the answer say so.
      const entry = state.get(ws);
      if (entry && typeof msg.url === "string") entry.url = msg.url.slice(0, 500);
      return;
    }
    if (msg.type === "detach") {
      const entry = state.get(ws);
      // Sent on reconnect too, so a page that took control does not quietly
      // rejoin the fan-out with diverged state when its socket comes back.
      if (entry && entry.following) {
        entry.following = false;
        // Whatever it was behind by stops mattering the moment it stops trying
        // to keep up, so nothing downstream should go on reporting it.
        entry.stale = false;
        // Interrupt the turn only when the agent was ACTUALLY DRIVING this
        // preview and this was the last page still following it.
        //
        // Both halves matter. One of five watchers reaching in should not stop
        // the agent for the other four — it keeps working and they keep seeing
        // it work. But the driving check is the one that was missing, and its
        // absence was destructive: clicking inside a preview is how you USE an
        // app, and with a single viewer that ordinary click killed the model's
        // turn — even when the agent had never touched the page and was busy
        // doing something else entirely. Killing a turn also discards whatever
        // input was queued behind it, so messages other people had typed while
        // the model was working vanished with it.
        if (quietRemaining(entry.slot) > 0 && census(entry.slot).following.length === 0) {
          onIdle(entry.slot);
        }
        // Bounded: it is kept in the diagnostic ring and logged.
        const reason = typeof msg.reason === "string" ? msg.reason.slice(0, 120) : undefined;
        note("detach", entry.slot, { reason });
        log(`preview driver on slot ${entry.slot} took control (${reason || "no reason given"})`);
      }
      return;
    }
    const wait = waits.get(msg.id);
    if (!wait) return;                 // late reply to an action that timed out
    // ONLY from the page the action was sent to.
    //
    // The page runs code the agent wrote, on an origin that can open its own
    // socket here — the grant cookie rides along automatically. Matching a reply
    // by id alone let any connected page answer for every other one: fabricate
    // acknowledgements the fan-out counts as real, and hand back a snapshot
    // payload the model reads as the state of somebody else's screen. Ignoring
    // the mismatch (rather than erroring) leaves the true page's reply to arrive
    // normally.
    if (wait.ws !== ws) return;
    waits.delete(msg.id);
    wait.settle(msg);
  }

  /**
   * This page has caught up — take the banner down.
   *
   * Clearing the flag server-side was never enough: the banner lives in the
   * page, so a viewer who came back into step kept being told they were behind.
   * A warning that outlives its cause is worse than none, because the next real
   * one gets ignored.
   */
  function freshen(ws) {
    const entry = state.get(ws);
    if (!entry || !entry.stale) return;
    entry.stale = false;
    try { ws.send(JSON.stringify({ type: "fresh" })); } catch { /* gone */ }
  }

  /**
   * How many of THESE pages have not applied every action yet.
   *
   * Counted over the same list the action was sent to, not a fresh census. A
   * page that reconnected between the fan-out going out and the answer coming
   * back would otherwise be counted here but not in `following` — so a result
   * read "ran in 1 of 2 following pages … 2 viewers are behind", which is not
   * arithmetic anyone can follow.
   */
  function behindCount(slot, pages) {
    const at = lastSeq.get(slot) ?? 0;
    return pages.filter((ws) => (state.get(ws)?.seq ?? 0) < at).length;
  }

  /**
   * Wait, briefly, for someone to open this preview.
   *
   * There is deliberately NO headless fallback. Driving a browser nobody can see
   * would give the model a second session whose state diverges from the iframe,
   * and silently so. Asking a human to open the panel keeps one surface, always
   * watchable.
   */
  /** Wait until `enough(census)` holds for this slot, or `ms` elapses. */
  function waitFor(slot, enough, ms) {
    if (enough(census(slot))) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const list = attachWaits.get(slot) ?? [];
      const finish = (v) => {
        clearTimeout(timer);
        const cur = attachWaits.get(slot);
        if (cur) attachWaits.set(slot, cur.filter((f) => f !== onAttach));
        resolve(v);
      };
      const onAttach = () => { if (enough(census(slot))) finish(true); };
      const timer = setTimeout(() => finish(false), ms);
      timer.unref?.();
      list.push(onAttach);
      attachWaits.set(slot, list);
    });
  }

  function waitForViewer(slot, ms) {
    return waitFor(slot, (c) => c.following.length > 0, ms);
  }

  /**
   * Give pages that were mid-navigation a moment to come back.
   *
   * Bounded and one-shot: if they do not return inside the grace they are gone
   * (tab closed, browser quit) and the action should run for whoever is left
   * rather than stall behind somebody who is never coming back.
   */
  /**
   * How long to wait for this slot's pages, given how slow they have proven.
   *
   * Six round trips: enough for a document fetch, its script, and a WebSocket
   * upgrade on a link where each of those costs one trip, without turning a
   * 40ms LAN into a needless 20-second stall.
   */
  function graceFor(slot) {
    const rtt = slowestRtt.get(slot) ?? 0;
    return Math.min(Math.max(RECONNECT_GRACE_BASE_MS, rtt * 6), RECONNECT_GRACE_MAX_MS);
  }

  async function awaitReconnects(slot) {
    const pending = expectBack.get(slot);
    if (!pending) return 0;
    const remaining = pending.at + graceFor(slot) - Date.now();
    // Satisfied by NAME. A page that comes back and immediately says it took
    // control still counts as back — the reconnect happened; what it does next
    // is its own business — and that is handled by hello clearing the id
    // regardless of stance.
    const back = () => !expectBack.has(slot);
    if (remaining <= 0 || back()) {
      expectBack.delete(slot);
      return 0;
    }
    await waitFor(slot, back, remaining);
    const stragglers = expectBack.get(slot)?.vids.size ?? 0;
    expectBack.delete(slot);
    // How many never made it back. Returned rather than swallowed: a page that
    // misses an action is otherwise INVISIBLE in the result — the pages that did
    // run it answer happily and the fan-out reports a clean N-of-N, which is the
    // silent divergence this design exists to prevent, one level up.
    return stragglers;
  }

  // actionSeq, NOT seq: the module-level `seq` is the request-id counter, and a
  // parameter of that name shadowed it — every page in the fan-out was handed the
  // SAME request id, so one reply settled all of them and the other two timed out
  // as offline. Tests caught it; nothing about the code read as wrong.
  /** Distinct failure reasons, commonest first, with how many pages hit each. */
  function summarise(failures) {
    const counts = new Map();
    for (const f of failures) counts.set(f, (counts.get(f) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const shown = ranked.slice(0, 3)
      .map(([msg, n]) => (n > 1 ? `${msg} (${n} pages)` : msg));
    if (ranked.length > shown.length) shown.push(`and ${ranked.length - shown.length} other reasons`);
    return shown.join("; ");
  }

  function askOne(ws, action, params, timeoutMs, actionSeq) {
    const id = `d${++seq}`;
    const slot = state.get(ws)?.slot;
    const sentAt = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waits.delete(id);
        resolve({ ok: false, offline: true, error: `the page did not acknowledge within ${timeoutMs}ms` });
      }, timeoutMs);
      waits.set(id, { ws, settle: (msg) => {
        clearTimeout(timer);
        // Every action is also a latency sample. Kept per slot as the slowest
        // recent trip, because the wait after a navigation has to be sized for
        // the slowest peer in the session, not the average of them.
        const rtt = Date.now() - sentAt;
        const entry = state.get(ws);
        if (entry) entry.rtt = rtt;
        if (slot !== undefined) {
          const worst = [...(bySlot.get(slot) ?? [])]
            .map((s) => state.get(s)?.rtt ?? 0)
            .reduce((a, b) => Math.max(a, b), 0);
          slowestRtt.set(slot, worst);
        }
        resolve(msg);
      } });
      try { ws.send(JSON.stringify({ id, action, params, seq: actionSeq })); }
      catch (e) {
        clearTimeout(timer); waits.delete(id);
        resolve({ ok: false, error: `could not reach the page: ${e.message}` });
      }
    });
  }

  /**
   * Run one action in every following page.
   *
   * Resolves `{ok:false}` rather than throwing when nobody can be driven — the
   * model's tool has to be able to report "no viewer" as an ordinary answer, and
   * "they are all driving themselves" as a different one, because the remedy
   * differs: open the panel, versus stop taking control.
   */
  // previewId defaults to "" rather than being left bare: TypeScript infers this
  // signature from the JS, and a binding with no initializer is dropped from the
  // inferred type entirely — callers would be told the option does not exist.
  async function drive(slot, action, params, { timeoutMs = ACK_TIMEOUT_MS, waitForViewerMs = 0, previewId = "" } = {}) {
    // A slot is reused by whatever preview lands on it next, and a page from the
    // PREVIOUS occupant keeps its socket open — stopping a preview closes no
    // sockets, as the census plainly shows after an idle sweep. Driving one would
    // run this session's action inside another session's app and hand that app's
    // snapshot back to a model with no business reading it. The grant that opened
    // the socket was for a preview that no longer exists, so the socket has
    // outlived its authorisation. Evicting here rather than filtering keeps every
    // derived view — divergence, the census, followingPath — honest for free.
    evictOthers(slot, previewId);
    if (waitForViewerMs > 0) await waitForViewer(slot, waitForViewerMs);
    // Guarded rather than always awaited: with nothing pending this keeps the
    // whole fan-out synchronous, so the ordinary action costs no extra tick.
    const missed = expectBack.has(slot) ? await awaitReconnects(slot) : 0;
    const { all, following, detached } = census(slot);
    if (following.length === 0) {
      return all.length === 0
        ? { ok: false, reason: "no-viewer", error: "no viewer has this preview open" }
        : {
          ok: false,
          reason: "all-detached",
          error: `every viewer (${detached}) has taken control of their own copy; they rejoin by reloading`,
          viewers: { following: 0, detached, succeeded: 0 },
        };
    }

    const isRead = READ_ONLY_ACTIONS.has(action);
    // Reads are not part of the ordering. A snapshot changes nothing, so counting
    // it would leave every page permanently "one behind" for having been asked a
    // question, and the next real action would look like it had been missed.
    const seqNow = isRead
      ? (lastSeq.get(slot) ?? 0)
      : (lastSeq.set(slot, (lastSeq.get(slot) ?? 0) + 1), lastSeq.get(slot));
    lastDriveAt.set(slot, Date.now());
    note("drive", slot, { action, following: following.length, missed });
    const results = await Promise.all(
      following.map((ws) => askOne(ws, action, params, timeoutMs, isRead ? null : seqNow)));

    // No acknowledgement inside the window: treat that page as gone rather than
    // as a failure of the action. Closing its socket is the self-healing part —
    // a page that is actually alive sees the close, reconnects on its own, says
    // hello, and rejoins the fan-out; a page that is not simply stays gone.
    // A page that acknowledged has, by protocol, already recorded this action —
    // it writes its position to storage BEFORE replying. So the ack is the
    // confirmation and no extra round trip is needed to learn where it is.
    if (!isRead) {
      results.forEach((r, i) => {
        if (!r.ok) return;
        const entry = state.get(following[i]);
        if (entry) entry.seq = seqNow;
      });
    }
    const offline = [];
    results.forEach((r, i) => {
      if (!r.offline) return;
      const ws = following[i];
      offline.push(ws);
      note("offline", slot, {});
      dropQuietly(ws);
      try { ws.close?.(); } catch { /* already gone */ }
    });
    const urls = [...new Set(following.map((ws) => state.get(ws)?.url).filter(Boolean))];
    const viewers = {
      following: following.length,
      detached,
      succeeded: results.filter((r) => r.ok).length,
      // Counted separately from a failure: nothing went wrong with the action on
      // these pages, there was nobody there to run it.
      ...(offline.length ? { offline: offline.length } : {}),
      // Pages that are watching but have not applied every action — they were
      // away for one, or arrived part-way through the run. Exact, because each
      // page reports the last action number it actually applied.
      ...(behindCount(slot, following) ? { behind: behindCount(slot, following) } : {}),
      // Only when they disagree. One shared URL is the normal case and saying so
      // every time would bury the case that actually needs attention.
      ...(urls.length > 1 ? { urls } : {}),
      // Pages that were watching, went away with a navigation, and did not come
      // back inside the grace. They have missed this action, and whoever is in
      // front of them is now looking at a page the others do not have.
      //
      // Meaningless for a read: a snapshot changes nothing, so a page that was
      // not there to receive it has missed nothing and is no more out of step
      // than before. Reporting it anyway is how "list_tools ran in 2 of 2
      // following pages" ended up filed under NOT COMPLETED EVERYWHERE.
      ...(missed > 0 && !isRead ? { missed } : {}),
    };
    // The agent keeps going while at least one live, following page ran it.
    //
    // This was once all-or-nothing, for a good reason: "it worked" and "it
    // worked everywhere" must not be the same answer, or the pages that ran it
    // reply happily while somebody sits in front of a page nobody else has. But
    // failing the action turned out to be the wrong lever — one tab mid-
    // navigation halted the agent for the whole session, including the person
    // watching it work. The distinction is kept where it belongs, in what the
    // model is TOLD, not in whether the run survives.
    const first = results.find((r) => r.ok);
    const failures = results.filter((r) => !r.ok && !r.offline).map((r) => r.error).filter(Boolean);
    // ALL the distinct reasons, not whichever came back first.
    //
    // Pages fail differently and the difference is the diagnosis: "no element
    // matches" on two copies and "covered by <div#scrim>" on a third are two
    // separate problems with two separate fixes. Reporting one of them at random
    // sent the model looking for a missing element while the real answer — a
    // modal over the button — was in the reply it discarded.
    const why = summarise(failures);
    if (first) {
      // ONE live, following page is enough to keep going. Failing the whole
      // action because a second tab was mid-navigation stopped the agent dead
      // for everybody — including the person actually watching it work — and a
      // shortfall is information, not a reason to halt.
      //
      // What must never happen is the shortfall going unsaid: that is the silent
      // divergence this entire design exists to prevent. So the counts, the
      // reason the other pages refused, and who is now out of step all ride
      // along on a successful result, and describeDriveResult states them.
      return { ...first, viewers, ...(why ? { error: why } : {}) };
    }
    return {
      ok: false,
      // Nobody ran it, so nothing was applied anywhere — which makes this the
      // one shortfall that IS safe to fix and retry. Distinct from "partial",
      // which used to mean the opposite and blocked retries for good reason.
      reason: "nobody-ran",
      error: why || "no following page acknowledged this action",
      viewers,
    };
  }

  return {
    attach,
    drop,
    receive,
    drive,
    waitForViewer,
    /** The recent attach/drop/drive history, newest last. Diagnostic only. */
    recent: (slot) => recent.filter((r) => r.slot === slot),
    /**
     * Where the pages that are following this preview currently are.
     *
     * A viewer who opens the panel MID-RUN redeems a fresh grant and, without
     * this, lands on the app's root — so the agent navigates everyone to a page
     * and the person who just joined is looking at the front door, out of step
     * from their very first frame. Answering "where is everyone?" lets them land
     * where the others already are.
     *
     * Followers only: a detached page's URL is that person's own business, and
     * sending a new arrival there would spread one viewer's detour to everyone.
     */
    followingPath: (slot) => {
      const urls = census(slot).following
        .map((ws) => state.get(ws)?.url)
        .filter(Boolean);
      if (!urls.length) return null;
      // The majority page, so one straggler mid-navigation cannot redirect a
      // new arrival somewhere nobody else is.
      const counts = new Map();
      for (const u of urls) counts.set(u, (counts.get(u) ?? 0) + 1);
      const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      try {
        const parsed = new URL(best);
        return parsed.pathname + parsed.search;
      } catch { return null; }
    },
    /** For status: how many pages are watching this slot, and in what stance. */
    census: (slot) => {
      const c = census(slot);
      return { total: c.all.length, following: c.following.length, detached: c.detached };
    },
  };
}

/**
 * The injected driver, served verbatim at DRIVER_SCRIPT_PATH.
 *
 * Plain ES5-ish browser JS in a template string rather than a bundled module:
 * it is fetched by the app's page, not by Next, so nothing bundles it for us.
 */
export const DRIVER_SCRIPT = `/* hooop preview driver */
(function () {
  "use strict";
  if (window.__hooopDriver) return;

  // ── WebMCP page half (W3C draft shape) ────────────────────────────────────
  var tools = new Map();
  var existing = document.modelContext;
  var ctx = {
    registerTool: function (tool, options) {
      if (!tool || !tool.name || !tool.description) {
        throw new DOMException("name and description are required", "InvalidStateError");
      }
      if (tools.has(tool.name)) {
        throw new DOMException("tool already registered: " + tool.name, "InvalidStateError");
      }
      tools.set(tool.name, tool);
      // AbortSignal is how the April 2026 draft unregisters; a view that
      // unmounts must take its tools with it, or the agent is offered actions
      // the user cannot see.
      var signal = options && options.signal;
      if (signal) {
        if (signal.aborted) tools.delete(tool.name);
        else signal.addEventListener("abort", function () { tools.delete(tool.name); });
      }
      if (existing && typeof existing.registerTool === "function") {
        try { existing.registerTool(tool, options); } catch (e) { /* browser-native copy is a bonus */ }
      }
    },
    // Removed from the draft in April 2026 but kept: apps written against the
    // earlier shape are exactly the apps that exist right now.
    unregisterTool: function (name) { tools.delete(name); },
  };
  try {
    Object.defineProperty(document, "modelContext", { value: ctx, configurable: true });
  } catch (e) { document.modelContext = ctx; }
  // The same object under the name the draft used before March 2026. Feature
  // detection is the whole risk on this path: an app that checks the other
  // global registers nothing, silently, and list_page_tools then tells the model
  // — truthfully, and uselessly — that this app declares no tools.
  try {
    if (!navigator.modelContext) {
      Object.defineProperty(navigator, "modelContext", { value: ctx, configurable: true });
    }
  } catch (e) { /* a frozen navigator is not worth failing over */ }

  // ── visible feedback ──────────────────────────────────────────────────────
  // The whole point is that a human WATCHES this happen. An action with no
  // visual trace is indistinguishable from the page changing on its own.
  var style = document.createElement("style");
  style.textContent =
    ".__hooop-ring{position:fixed;z-index:2147483646;border:2px solid #e87db4;border-radius:6px;" +
    "box-shadow:0 0 0 4px rgba(232,125,180,.25);pointer-events:none;transition:all .12s ease-out}" +
    ".__hooop-dot{position:fixed;z-index:2147483647;width:14px;height:14px;border-radius:50%;" +
    "background:#e87db4;box-shadow:0 0 0 4px rgba(232,125,180,.3);pointer-events:none;" +
    "transform:translate(-50%,-50%);transition:all .18s ease-out}" +
    // Hooop's own chrome, standing in somebody else's page — so it is built from
    // the same parts as the ring, the dot and the notice: a dark translucent
    // pill and one hooop-pink mark. It was a solid amber slab, which is hooop's
    // --live token, the colour that means RUNNING and fine; using it to say
    // "this view is broken" inverted the one signal the palette already has.
    // Amber also reads as an error thrown by the app rather than a message from
    // hooop, and it collides with whatever the app's own design is doing.
    ".__hooop-stale{position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);" +
    "display:inline-flex;align-items:center;gap:8px;max-width:min(92vw,460px);" +
    "padding:9px 16px 9px 13px;border-radius:999px;cursor:pointer;" +
    "border:1px solid rgba(232,125,180,.5);background:rgba(12,13,15,.94);color:#f4f4f5;" +
    "font:500 12px/1.4 ui-sans-serif,system-ui,sans-serif;text-align:left;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.35);transition:background .12s ease-out,border-color .12s ease-out}" +
    ".__hooop-stale:hover{background:rgba(22,23,26,.98);border-color:rgba(232,125,180,.8)}" +
    ".__hooop-stale::before{content:'';flex:0 0 auto;width:7px;height:7px;border-radius:50%;" +
    "background:#e87db4;box-shadow:0 0 0 3px rgba(232,125,180,.22)}" +
    ".__hooop-notice{position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%);" +
    "max-width:min(92vw,420px);padding:8px 14px;border-radius:999px;pointer-events:none;" +
    "background:rgba(12,13,15,.92);color:#f4f4f5;font:500 12px/1.4 ui-sans-serif,system-ui,sans-serif;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.35)}";
  function styled() { if (!style.parentNode) (document.head || document.documentElement).appendChild(style); }
  function mark(el) {
    try {
      var r = el.getBoundingClientRect();
      var ring = document.createElement("div");
      ring.className = "__hooop-ring";
      ring.style.left = r.left + "px"; ring.style.top = r.top + "px";
      ring.style.width = r.width + "px"; ring.style.height = r.height + "px";
      var dot = document.createElement("div");
      dot.className = "__hooop-dot";
      dot.style.left = (r.left + r.width / 2) + "px";
      dot.style.top = (r.top + r.height / 2) + "px";
      styled();
      document.body.appendChild(ring); document.body.appendChild(dot);
      setTimeout(function () { ring.remove(); dot.remove(); }, 1200);
    } catch (e) { /* decoration must never break an action */ }
  }

  // ── actions ───────────────────────────────────────────────────────────────
  function find(sel) {
    var el = document.querySelector(sel);
    if (!el) throw new Error("no element matches " + sel);
    return el;
  }
  /**
   * What to CALL this element — never what somebody has typed into it.
   *
   * The value used to be part of this. A snapshot is sent to the model and into
   * the transcript, so logging into anything inside a preview put the contents of
   * those fields — passwords included — in front of the model and on the record.
   * The model needs to know a field exists and whether it is empty; it does not
   * need to be told the password.
   */
  function label(el) {
    var text = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
    if (!text) {
      var id = el.getAttribute("id");
      var tied = id ? document.querySelector("label[for='" + (window.CSS && CSS.escape ? CSS.escape(id) : id) + "']") : null;
      text = (tied && tied.textContent) || el.getAttribute("name") || (el.textContent || "");
    }
    return String(text).trim().slice(0, 80);
  }
  /** Whether a field has something in it — the part of a value that is safe. */
  function filled(el) {
    if (el.type === "checkbox" || el.type === "radio") return !!el.checked;
    return typeof el.value === "string" ? el.value.length > 0 : undefined;
  }
  function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    var name = el.getAttribute("name");
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    var parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
    return cssPath(parent) + " > " + el.tagName.toLowerCase() +
      (same.length > 1 ? ":nth-of-type(" + (same.indexOf(el) + 1) + ")" : "");
  }

  /**
   * Could a person have clicked this?
   *
   * Dispatching events straight at an element is not clicking it: a control that
   * is invisible, inert, or aria-disabled accepts the whole sequence and reports
   * success, and the model then describes something that did not happen. These
   * are refusals rather than warnings because each one means the click could not
   * have occurred — there is nothing for the model to weigh up.
   */
  function requireActionable(el, sel) {
    // A disabled control eats the click and changes nothing. Reporting that as
    // done is how a fan-out ends up "successful" on a page where the button was
    // greyed out and nothing moved.
    if (el.disabled) throw new Error("element is disabled: " + sel);
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") {
      throw new Error("element is aria-disabled: " + sel);
    }
    if (el.closest && el.closest("[inert]")) {
      throw new Error("element is inside an inert subtree, which cannot be interacted with: " + sel);
    }
    try {
      var cs = getComputedStyle(el);
      if (cs && (cs.visibility === "hidden" || cs.display === "none")) {
        throw new Error("element is not visible (" + cs.visibility + "/" + cs.display + "): " + sel);
      }
    } catch (e) {
      if (e && /not visible/.test(String(e.message))) throw e;
      // No computed style available: fall through to the geometry check.
    }
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      throw new Error("element has no size on screen, so it cannot be clicked: " + sel);
    }
  }

  /**
   * The point a real click would land on — and proof that it would land here.
   *
   * Events dispatched at an element bypass hit testing entirely, so a button
   * under a modal, behind a sticky header, or with pointer-events:none used to
   * "click" perfectly while a person could not have touched it. This asks the
   * browser what is actually on top at each candidate point and insists on
   * finding one where this element (or something inside it) answers.
   *
   * Ancestors do NOT count: if the topmost thing is the element's parent, the
   * element itself is not painted there — pointer-events:none is exactly that
   * case — and a real click would go to the parent instead.
   */
  function whereToClick(el, sel) {
    var r = el.getBoundingClientRect();
    var centre = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    // Only the part actually on screen can be hit-tested. An element scrolled
    // out of view is not covered by anything — it simply cannot be asked about,
    // and refusing would be wrong.
    var x0 = Math.max(r.left, 0), y0 = Math.max(r.top, 0);
    var x1 = Math.min(r.right, vw), y1 = Math.min(r.bottom, vh);
    if (!(x1 > x0 && y1 > y0)) return centre;

    var candidates = [
      { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
      { x: x0 + (x1 - x0) * 0.25, y: y0 + (y1 - y0) * 0.25 },
      { x: x0 + (x1 - x0) * 0.75, y: y0 + (y1 - y0) * 0.25 },
      { x: x0 + (x1 - x0) * 0.25, y: y0 + (y1 - y0) * 0.75 },
      { x: x0 + (x1 - x0) * 0.75, y: y0 + (y1 - y0) * 0.75 },
    ];
    var blocker = null;
    for (var i = 0; i < candidates.length; i++) {
      var top;
      // Not every host implements it. Where we cannot ask, we do not refuse.
      try { top = document.elementFromPoint(candidates[i].x, candidates[i].y); }
      catch (e) { return centre; }
      if (top === undefined) return centre;
      if (top && (top === el || el.contains(top))) return candidates[i];
      if (top && !blocker) blocker = top;
    }
    throw new Error("element is covered by " + describe(blocker) + " and cannot be clicked: " + sel);
  }
  function describe(el) {
    if (!el) return "nothing (the point is outside the document)";
    var id = el.id ? "#" + el.id : "";
    var cls = el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return "<" + el.tagName.toLowerCase() + id + cls + ">";
  }

  /**
   * How long to wait for the app to react before saying it did not.
   *
   * A lower bound, deliberately short: it is added to every click before the
   * acknowledgement, and the acknowledgement has a one-second budget shared with
   * the network. Frameworks land their synchronous updates well inside this;
   * anything slower is reported as "no change within Xms", which is what we
   * actually observed rather than a claim about the app.
   */
  var EFFECT_SETTLE_MS = 150;

  /**
   * Did the app do anything?
   *
   * This is the check an acknowledgement cannot make, and the reason it matters:
   * a click on a control nobody is listening to dispatches perfectly and changes
   * nothing, and every count says it worked. Watching the DOM answers it locally,
   * per action — no comparison against other viewers, so an unrelated clock
   * elsewhere in the session cannot turn it into a permanent false alarm the way
   * comparing page fingerprints did.
   *
   * Its blind spot is an app that responds without touching the DOM: a canvas
   * draw, a sound, a request whose answer has not arrived. Hence "the page did
   * not change", never "the app ignored you".
   */
  function watchEffect() {
    var changed = false;
    var navigated = false;
    var obs = null;
    try {
      obs = new MutationObserver(function () { changed = true; });
      obs.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
    } catch (e) { obs = null; }
    var onLeave = function () { navigated = true; };
    try {
      window.addEventListener("pagehide", onLeave);
      window.addEventListener("beforeunload", onLeave);
    } catch (e) {}
    return function () {
      return new Promise(function (resolve) {
        setTimeout(function () {
          try { if (obs) obs.disconnect(); } catch (e) {}
          try {
            window.removeEventListener("pagehide", onLeave);
            window.removeEventListener("beforeunload", onLeave);
          } catch (e) {}
          // A navigation IS the effect, and the document is on its way out — the
          // observer may never see the new page at all.
          resolve({ changed: changed || navigated, navigated: navigated });
        }, EFFECT_SETTLE_MS);
      });
    };
  }

  // A click the app will actually notice.
  //
  // el.click() fires ONE event, the click itself. Anything listening for
  // pointerdown, mousedown or focus — most component libraries, every drag
  // interaction, and a lot of hand-rolled controls — sees nothing at all, and
  // the driver used to report that as success. An action nobody can observe,
  // acknowledged as done, is the worst answer this thing can give.
  //
  // Every event below is synthetic, so isTrusted stays false and the takeover
  // detector above correctly ignores our own clicks.
  function realClick(el, spot) {
    var r = el.getBoundingClientRect();
    var x = spot ? spot.x : r.left + r.width / 2;
    var y = spot ? spot.y : r.top + r.height / 2;
    function fire(type, Ctor, extra) {
      var init = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, button: 0, detail: 1,
      };
      for (var k in extra) init[k] = extra[k];
      var ev = null;
      try { ev = new Ctor(type, init); }
      catch (e) {
        // Two different hosts to survive: one with no PointerEvent, and one that
        // rejects a member of the init outright. The old fallback re-used the
        // init that had just been refused, so it threw again and took the whole
        // click with it — the enrichment killing the very thing it enriches.
        try { ev = new MouseEvent(type, init); }
        catch (e2) {
          try { ev = new MouseEvent(type, { bubbles: true, cancelable: true }); }
          catch (e3) { ev = null; }
        }
      }
      if (ev) el.dispatchEvent(ev);
    }
    var P = window.PointerEvent || MouseEvent;
    var pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true };
    fire("pointerover", P, pointer); fire("mouseover", MouseEvent, {});
    fire("pointermove", P, pointer); fire("mousemove", MouseEvent, {});
    fire("pointerdown", P, Object.assign({ buttons: 1 }, pointer));
    fire("mousedown", MouseEvent, { buttons: 1 });
    try { if (el.focus) el.focus(); } catch (e) {}
    fire("pointerup", P, Object.assign({ buttons: 0 }, pointer));
    fire("mouseup", MouseEvent, { buttons: 0 });
    // Last, and via the native method: it is what triggers default behaviour
    // (following a link, submitting a form, toggling a checkbox), which a
    // dispatched click event does NOT do for untrusted events in every case.
    if (typeof el.click === "function") el.click(); else fire("click", MouseEvent, {});
  }

  /**
   * How far this page has got, kept where it survives everything.
   *
   * Actions are ordered and numbered by the server. This page writes down the
   * number of the last one it applied BEFORE acknowledging it, so an
   * acknowledgement always means "recorded", never "in flight". On the way back
   * in — a reload, a navigation, a laptop waking up — it says where it got to and
   * the server subtracts. That is the whole lag mechanism.
   *
   * localStorage rather than sessionStorage because the interesting cases are
   * exactly the ones sessionStorage does not survive; keyed per preview because
   * the origin is a slot that the next preview inherits.
   */
  var PREVIEW_ID = window.__hooopPreviewId || "";
  var SEQ_KEY = "__hooop_seq:" + PREVIEW_ID;
  var applied = 0;
  try { applied = parseInt(localStorage.getItem(SEQ_KEY) || "0", 10) || 0; } catch (e) {}
  function record(seq) {
    if (typeof seq !== "number" || !(seq > applied)) return;
    applied = seq;
    // A page with storage disabled still drives correctly; it just cannot prove
    // where it got to after a reload, and is told it is behind. Honest either way.
    try { localStorage.setItem(SEQ_KEY, String(seq)); } catch (e) {}
  }

  var ACTIONS = {
    snapshot: function () {
      var out = [];
      var nodes = document.querySelectorAll(
        "a[href],button,input,select,textarea,[role=button],[role=link],[onclick]");
      Array.prototype.forEach.call(nodes, function (el) {
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;   // not on screen, not actionable
        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || undefined,
          label: label(el),
          // State the model has to have to act sensibly, and which no amount of
          // text tells it: a disabled control eats a click, and a checkbox it
          // cannot see the state of gets toggled the wrong way half the time.
          disabled: el.disabled === true ? true : undefined,
          filled: filled(el),
          selector: cssPath(el),
        });
      });
      var shown = out.slice(0, 100);
      return {
        title: document.title,
        url: location.href,
        elements: shown,
        // Never silently: a model reasoning about a page it has seen the first
        // hundred controls of, with no way to know that, will conclude the rest
        // do not exist and say so.
        truncated: out.length > shown.length
          ? "showing the first " + shown.length + " of " + out.length +
            " interactive elements; narrow the page or scroll to reach the rest"
          : undefined,
      };
    },
    click: function (p) {
      var el = find(p.selector);
      requireActionable(el, p.selector);
      mark(el);
      // Bringing it into view is courtesy to whoever is watching, exactly like
      // the ring — so it must not be able to fail the action. Not every host
      // implements it, and an element the model can reach and click is not
      // necessarily one that can be scrolled to.
      try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
      var spot = whereToClick(el, p.selector);
      var watch = watchEffect();
      realClick(el, spot);
      return watch().then(function (effect) {
        return {
          clicked: p.selector,
          // Everything below is about whether the APP noticed. An acknowledgement
          // on its own only ever meant "the events dispatched without throwing".
          navigated: effect.navigated || undefined,
          changed: effect.changed,
          note: effect.changed ? undefined
            : "the page did not change within " + EFFECT_SETTLE_MS + "ms of this click — " +
              "the element may have no handler for it, or the app may respond more slowly than that",
        };
      });
    },
    type: function (p) {
      var el = find(p.selector);
      // Same refusals as a click — a disabled or invisible field is not one a
      // person could have typed into. No hit test: typing goes through focus,
      // which does not care what is painted on top.
      requireActionable(el, p.selector);
      mark(el);
      el.focus();
      var setter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        "value");
      // React tracks the value on the node and ignores a plain assignment, so
      // go through the native setter and then fire the events it listens for.
      if (setter && setter.set) setter.set.call(el, p.text); else el.value = p.text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Did it stick? A DOM mutation watch is the wrong instrument here — value
      // is a property, not an attribute, so nothing mutates — but the field can
      // be read back directly, which is stronger. A controlled component that
      // rejects the input reverts it, and this is the only sign of that.
      //
      // Reported, not thrown: an app that reformats as you type (a phone number,
      // a currency) has legitimately changed the value, and refusing would be
      // wrong. The length is enough to tell the two apart without echoing what
      // the field now contains back into the transcript.
      var accepted = el.value === p.text;
      return {
        typed: p.text,
        into: p.selector,
        accepted: accepted,
        note: accepted ? undefined
          : "the field now holds " + String(el.value == null ? "" : el.value).length +
            " characters rather than the " + p.text.length + " typed — the app may be " +
            "reformatting the input, or rejecting it",
      };
    },
    list_tools: function () {
      var out = [];
      tools.forEach(function (t, name) {
        out.push({ name: name, description: t.description, inputSchema: t.inputSchema });
      });
      return { tools: out };
    },
    call_tool: function (p) {
      var t = tools.get(p.name);
      if (!t) {
        var known = Array.from(tools.keys());
        throw new Error("no tool named " + p.name + " is registered on this page" +
          (known.length ? " (it declares: " + known.join(", ") + ")" : " (it declares none)"));
      }
      // A declared tool is the one kind of action with nothing to draw a ring
      // around — it runs in the app's own code, not on an element. Without this
      // the operator watches the page change for no visible reason, which is the
      // exact failure the ring and dot exist to prevent.
      notice("The agent called " + p.name);
      return Promise.resolve(t.execute(p.arguments || {})).then(function (r) {
        return { result: r };
      });
    },
  };

  // ── follow / detach ───────────────────────────────────────────────────────
  // This copy of the page follows the model until a human touches it. Then it is
  // theirs: it stops replaying the model's actions and does not rejoin until the
  // page reloads, because two diverged client states cannot be reconciled.
  //
  // The discriminator is trust. Everything the driver does above goes through
  // el.click() and synthetic events, which the browser marks isTrusted:false; a
  // real pointer or key press is the only thing that can be true. So the model
  // can never detach the page on the user's behalf, and the user never has to
  // announce themselves — using the app IS the announcement.
  var following = true;
  // A stable id for THIS tab, kept in sessionStorage so it survives navigation
  // (a new document, same tab) but not a new tab. It is what lets the server
  // wait for the specific pages that went away instead of counting heads —
  // counting cannot tell "the slow peer came back" from "somebody else's tab
  // opened", which on a mixed-speed session is most of the time.
  var vid;
  try {
    vid = sessionStorage.getItem("__hooop_vid");
    if (!vid) {
      vid = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem("__hooop_vid", vid);
    }
  } catch (e) {
    vid = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
  }
  function send(obj) {
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {}
  }
  function detach(reason) {
    if (!following) return;
    following = false;
    send({ type: "detach", reason: reason });
    notice("You have control of this preview — reload to follow along again");
    // This copy is theirs now, so "you no longer match the other viewers" has
    // stopped being a warning and become a description of what they asked for.
    renderStale();
    // Tell the panel around us, if we are in one. It cannot see into this frame
    // — different origin, deliberately — and without this it goes on covering a
    // page the agent can no longer touch with "the agent is using this page" on
    // the next action, which also puts an interrupt-the-turn button over a page
    // the human has already taken. Targeted at "*" because the parent's origin
    // is the one thing we do not know; the message carries nothing secret.
    tellPanel("detached");
  }
  /**
   * Tell the panel around us what this copy is doing.
   *
   * It cannot see in — different origin, deliberately — and it needs to know for
   * one reason: the agent's "I am acting" is broadcast to the whole SESSION, but
   * the agent only ever acts on FOLLOWING pages. Without this, a viewer who took
   * control still got "the agent is using this page" over their own window every
   * time it drove somebody else's.
   *
   * Targeted at "*" because the parent's origin is the one thing we do not know;
   * the message carries nothing but our own stance.
   */
  function tellPanel(type) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: "hooop-preview-driver", type: type }, "*");
      }
    } catch (e) { /* sandboxed or gone */ }
  }

  function notice(text) {
    try {
      var el = document.createElement("div");
      el.className = "__hooop-notice";
      el.textContent = text;
      styled();
      document.body.appendChild(el);
      // Transient on purpose: a permanent banner would deface someone's app. The
      // durable indicator belongs in hooop's own chrome around the iframe, which
      // can say it without touching the page.
      setTimeout(function () { el.remove(); }, 5000);
    } catch (e) {}
  }
  // The panel's overlay covers this frame, so a click on "take control" never
  // reaches the page — which is why taking control that way used to hide the
  // overlay and change nothing: the copy stayed in the fan-out and the agent
  // went on driving it. Only the parent can say that happened.
  //
  // Accepted from our own embedder only, and it can do exactly one thing: give
  // this copy to its viewer. Anyone else who frames the preview can send it too,
  // and all they achieve is detaching the copy they are already looking at.
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || d.source !== "hooop-preview-panel" || d.type !== "take-control") return;
    detach("took control from the panel");
  });

  ["pointerdown", "keydown"].forEach(function (type) {
    // Capture, so we record the takeover before the app handles the event; we
    // never preventDefault, so the interaction itself works normally.
    window.addEventListener(type, function (ev) {
      if (ev.isTrusted) detach(type === "keydown" ? "typed in the page" : "clicked in the page");
    }, true);
  });

  /**
   * Say, on the page itself, that this copy is behind the others.
   *
   * Not a toast: it stays until it is dealt with. A viewer who cannot tell that
   * their window stopped matching everyone else's will read the agent's next
   * three actions as broken software — and they are right to, because what they
   * are looking at is not what the agent is describing.
   *
   * But it is only ever worth saying when THREE things hold, which is why the
   * text and the element are kept apart and re-rendered rather than toggled:
   *
   *  1. the server says we are behind — obviously;
   *  2. this page is still following. A viewer who took control owns their copy
   *     and being different from the others is the POINT, not a fault. Left up,
   *     the banner never went away again: the server only ever clears banners
   *     for pages that are still following, so taking control froze it forever;
   *  3. the agent is not mid-run. The dashboard covers the iframe with its own
   *     "the agent is using this page" overlay while driving, and two competing
   *     messages is one too many — worse, the overlay swallows the click, so the
   *     banner's own "click to catch up" cannot be taken up. Reloading mid-run
   *     is bad advice anyway: you would lose your place and diverge again on the
   *     agent's very next action.
   */
  var staleText = null;
  var staleBanner = null;
  /** Matches the dashboard's DRIVING_DECAY_MS, so both surfaces relax together. */
  var DRIVE_QUIET_MS = ${DRIVE_QUIET_MS};
  var driveTimer = null;

  function renderStale() {
    var wanted = staleText && following && !driveTimer;
    if (!wanted) {
      if (staleBanner) { try { staleBanner.remove(); } catch (e) {} staleBanner = null; }
      return;
    }
    if (staleBanner) { staleBanner.textContent = staleText; return; }
    try {
      styled();
      staleBanner = document.createElement("button");
      staleBanner.className = "__hooop-stale";
      staleBanner.textContent = staleText;
      staleBanner.addEventListener("click", function (ev) {
        ev.stopPropagation();
        location.reload();
      });
      document.body.appendChild(staleBanner);
    } catch (e) { staleBanner = null; }
  }
  function backInStep() { staleText = null; renderStale(); }
  function outOfStep(missed) {
    staleText = missed
      ? "This view is " + missed + " action" + (missed === 1 ? "" : "s") + " behind the others — click to catch up"
      : "This view no longer matches the other viewers — click to catch up";
    renderStale();
  }
  /**
   * The agent is working here: hold the banner back until it stops.
   *
   * The ms argument lets the server hand a FRESH document the remainder of a run
   * already in progress — after an agent-driven navigation this page has no other
   * way to know, and would otherwise raise its banner under the panel's overlay.
   */
  function agentActive(ms) {
    if (driveTimer) clearTimeout(driveTimer);
    driveTimer = setTimeout(function () { driveTimer = null; renderStale(); },
      typeof ms === "number" && ms > 0 ? ms : DRIVE_QUIET_MS);
    renderStale();
  }

  // ── socket ────────────────────────────────────────────────────────────────
  var ws = null, backoff = 500;
  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    try { ws = new WebSocket(proto + "//" + location.host + "${DRIVER_SOCKET_PATH}"); }
    catch (e) { return; }
    ws.onopen = function () {
      backoff = 500;
      // seq is the whole point of the hello: it is how far this page actually
      // got, read from its own storage, and the server subtracts to get the lag.
      send({ type: "hello", url: location.href, vid: vid, seq: applied });
      // Re-announce, or a page that took control would silently rejoin the
      // fan-out the moment its socket reconnected — with state nobody else has.
      if (!following) send({ type: "detach", reason: "reconnected after taking control" });
    };
    ws.onclose = function () {
      // The panel may be open for hours across restarts and sleeps; a driver
      // that gives up after one drop is a driver nobody can rely on.
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === "busy") return agentActive(msg.ms);
      if (msg.type === "stale") return outOfStep(msg.missed);
      if (msg.type === "fresh") return backInStep();
      // Anything with an action is the agent working in this page, whether or
      // not we end up running it.
      agentActive();
      var fn = ACTIONS[msg.action];
      var reply = function (body) {
        try { ws.send(JSON.stringify(Object.assign({ id: msg.id }, body))); } catch (e) {}
      };
      if (!fn) return reply({ ok: false, error: "unknown action: " + msg.action });
      // The server already filters to followers; this is the same rule enforced
      // where the state actually lives, so a race cannot move a page a human owns.
      if (!following) return reply({ ok: false, error: "this page has been taken over by its viewer" });
      try {
        Promise.resolve(fn(msg.params || {})).then(
          function (r) {
            // Recorded BEFORE the acknowledgement, never after: an ack has to
            // mean "applied and written down". Acknowledge first and a reload in
            // the gap loses the position, and this page is then told to catch up
            // on an action it already has.
            record(msg.seq);
            reply({ ok: true, result: r });
          },
          function (e) { reply({ ok: false, error: String((e && e.message) || e) }); });
      } catch (e) {
        reply({ ok: false, error: String((e && e.message) || e) });
      }
    };
  }
  connect();
  // Says "this document is following" — which, because rejoining means
  // reloading, is only ever true of a document that has just loaded. It is what
  // lets the panel stop suppressing the overlay after a takeover.
  tellPanel("following");
  window.__hooopDriver = {
    actions: Object.keys(ACTIONS),
    following: function () { return following; },
  };
})();
`;
