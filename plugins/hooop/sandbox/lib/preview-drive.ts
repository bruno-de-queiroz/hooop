/**
 * The model's half of driving a preview.
 *
 * The load-bearing constraint is that **the sandbox cannot call the dashboard**.
 * That arrow does not exist, and adding it would invert the trust model: the
 * container running agent-authored code would gain a route into the process that
 * holds the operator's session. But the page the model wants to drive is in the
 * operator's browser, reachable only from the dashboard's front process.
 *
 * So the dashboard PULLS, exactly as auto-share does. A tool call parks an action
 * here; the dashboard long-polls for it, runs it in the watching pages, and posts
 * the result back over the UDS it already owns. This module is the queue in the
 * middle, and it is a separate file from active-sessions.ts so the timing rules —
 * which are the whole difficulty — can be tested without a server.
 *
 * Three deadlines matter and they are deliberately different:
 *
 *   pickup   how long an action waits for the dashboard to collect it. Short:
 *            if the front process is not polling, nothing will ever run it.
 *   run      how long the page has to answer once collected. The dashboard
 *            enforces its own timeout too; this is the backstop for a dashboard
 *            that collected an action and then died.
 *   gate     the ceiling on the whole thing, set by the permission hook (see
 *            PREVIEW_GATE_BUDGET_MS): a tool call that outlives its long-poll is
 *            reported to the model as DENIED BY THE OPERATOR, which is a lie
 *            about a human's intent. Settling early and honestly beats it.
 */

export interface DriveAction {
  /** Queue id, echoed back with the result. */
  id: string;
  previewId: string;
  /** Which published slot the dashboard should drive. */
  slot: number;
  action: string;
  params: Record<string, unknown>;
  /**
   * How long the dashboard should hold the action waiting for somebody to open
   * the preview. Zero on the first try — a viewer is either there or not — and
   * only non-zero on the retry that follows a nudge, which is the one that has a
   * reason to expect a human to arrive.
   */
  waitForViewerMs?: number;
}

/** What the dashboard reports back after running an action in the pages. */
export interface DriveResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  reason?: string;
  viewers?: {
    following: number;
    detached: number;
    succeeded: number;
    /** Present only when the following pages are NOT all on the same URL. */
    urls?: string[];
    /** Pages that navigated away and did not reconnect in time to run this. */
    missed?: number;
    /** Pages that never acknowledged and are now treated as gone. */
    offline?: number;
    /**
     * Pages that are watching but have not applied every action yet.
     *
     * Exact, not inferred: each action carries a sequence number and each page
     * records the last one it applied before acknowledging, so this is a
     * subtraction. It replaced a comparison of page fingerprints, which called
     * any app with a clock permanently divergent and could not see a change that
     * was not text.
     */
    behind?: number;
  };
}

interface Parked {
  action: DriveAction;
  settle: (r: DriveResult) => void;
  /** Cleared when the action is collected — pickup is no longer the risk. */
  pickupTimer: ReturnType<typeof setTimeout> | null;
  runTimer: ReturnType<typeof setTimeout> | null;
}

export interface DriveQueue {
  /** Park an action and resolve when the dashboard reports back (or gives up). */
  request(
    action: Omit<DriveAction, "id">,
    opts?: { pickupMs?: number; runMs?: number },
  ): Promise<DriveResult>;
  /** Dashboard: collect the next action, waiting up to `waitMs` for one. */
  take(waitMs: number): Promise<DriveAction | null>;
  /** Dashboard: report what the pages did. Unknown ids are ignored. */
  settle(id: string, result: DriveResult): void;
  /** For diagnostics: how many actions are queued or running. */
  size(): { waiting: number; running: number };
}

export function createDriveQueue(): DriveQueue {
  /** Collected in order — an action queued first should run first. */
  const waiting: Parked[] = [];
  const running = new Map<string, Parked>();
  /** Dashboard pollers parked with nothing to give them yet. */
  const takers: Array<(a: DriveAction | null) => void> = [];
  /** id -> run budget, for actions parked before a poller existed. */
  const runBudgets = new Map<string, number>();
  let seq = 0;

  function finish(parked: Parked, result: DriveResult) {
    if (parked.pickupTimer) clearTimeout(parked.pickupTimer);
    if (parked.runTimer) clearTimeout(parked.runTimer);
    running.delete(parked.action.id);
    const i = waiting.indexOf(parked);
    if (i >= 0) waiting.splice(i, 1);
    parked.settle(result);
  }

  function request(
    action: Omit<DriveAction, "id">,
    { pickupMs = 5_000, runMs = 20_000 }: { pickupMs?: number; runMs?: number } = {},
  ): Promise<DriveResult> {
    return new Promise((resolve) => {
      const id = `pd${++seq}`;
      const parked: Parked = {
        action: { ...action, id },
        settle: resolve,
        pickupTimer: null,
        runTimer: null,
      };
      parked.pickupTimer = setTimeout(() => {
        // Nobody came for it. Naming this separately from "the page did not
        // answer" matters: one means the dashboard is not there, the other means
        // the viewer is not — and only the second is something a human can fix
        // by opening the panel.
        finish(parked, {
          ok: false,
          reason: "no-dashboard",
          error: "the dashboard did not collect this action; the preview panel may not be reachable",
        });
      }, pickupMs);
      parked.pickupTimer.unref?.();

      const taker = takers.shift();
      if (taker) {
        collect(parked, runMs);
        taker(parked.action);
      } else {
        waiting.push(parked);
        // The run budget belongs to the request, but the clock only starts when
        // somebody collects it — so park the number until then.
        runBudgets.set(id, runMs);
      }
    });
  }

  function collect(parked: Parked, runMs: number) {
    if (parked.pickupTimer) { clearTimeout(parked.pickupTimer); parked.pickupTimer = null; }
    running.set(parked.action.id, parked);
    const i = waiting.indexOf(parked);
    if (i >= 0) waiting.splice(i, 1);
    parked.runTimer = setTimeout(() => {
      finish(parked, {
        ok: false,
        reason: "no-result",
        error: "the dashboard collected this action but never reported a result",
      });
    }, runMs);
    parked.runTimer.unref?.();
  }

  function take(waitMs: number): Promise<DriveAction | null> {
    const next = waiting[0];
    if (next) {
      collect(next, runBudgets.get(next.action.id) ?? 20_000);
      runBudgets.delete(next.action.id);
      return Promise.resolve(next.action);
    }
    return new Promise((resolve) => {
      const done = (a: DriveAction | null) => { clearTimeout(timer); resolve(a); };
      const timer = setTimeout(() => {
        const i = takers.indexOf(done);
        if (i >= 0) takers.splice(i, 1);
        // An empty answer, not an error: the dashboard polls in a loop and an
        // idle session is the normal case.
        resolve(null);
      }, waitMs);
      timer.unref?.();
      takers.push(done);
    });
  }

  function settle(id: string, result: DriveResult) {
    const parked = running.get(id);
    if (!parked) return;   // already timed out; the model has been told something
    finish(parked, result);
  }

  return {
    request,
    take,
    settle,
    size: () => ({ waiting: waiting.length, running: running.size }),
  };
}

/** The one queue the server and the tools share. */
export const driveQueue = createDriveQueue();

/**
 * Actions that only look at the page, named here in the driver's own vocabulary.
 *
 * Deliberately a second copy of the dashboard's READ_ONLY_ACTIONS rather than an
 * import: the sandbox cannot reach the dashboard's code, and inventing a shared
 * module for two words would tie the model's wording to the browser's protocol.
 */
const READ_ONLY = new Set(["snapshot", "list_tools"]);

/**
 * The click landed and the page did not move.
 *
 * The one failure an acknowledgement can never catch: the events dispatched
 * perfectly into a control nobody is listening to, and every count in the
 * fan-out says it worked. The page watches its own DOM across the action and
 * reports what it saw, so this is an observation with a stated window — not a
 * verdict on the app, which may simply be slower than that or may not express
 * itself in the DOM at all.
 */
function noEffect(result: unknown): string {
  const r = result as { changed?: boolean; note?: string; navigated?: boolean } | null;
  if (!r || r.changed !== false || !r.note) return "";
  return `\n\nWarning: ${r.note}. Do not report this as having had an effect until you have ` +
    `checked — call page_snapshot and look, or pick a different target. If the app declares ` +
    `WebMCP tools, calling one by name is more reliable than clicking at all.`;
}

/**
 * An app that declares no WebMCP tools of its own — the common case.
 *
 * An empty list is a perfectly good answer, but a model reading `{"tools": []}`
 * with no comment treats it as a page that has not finished loading and asks
 * again. Naming the remedy in the same breath is what turns it into the next
 * call instead of a retry loop.
 */
function noTools(action: string, result: unknown): string {
  if (action !== "list_tools") return "";
  const tools = (result as { tools?: unknown[] } | null)?.tools;
  if (!Array.isArray(tools) || tools.length > 0) return "";
  return `\n\nThis app declares no tools of its own, which is normal and not a failure. ` +
    `Drive it with page_snapshot and page_click instead.`;
}

/**
 * Turn a drive result into the sentence the model reads.
 *
 * The model cannot see the screen, so the answer has to carry what a person
 * would have seen: whether it ran, where, and — when it did not — which of the
 * several different "no" answers this is, because the remedies differ.
 */
export function describeDriveResult(action: string, r: DriveResult): string {
  if (r.ok) {
    const v = r.viewers;
    // The failure an acknowledgement cannot catch: the page received the action,
    // dispatched it, and the app did nothing — a disabled control, a handler
    // that was never registered, a copy that had already drifted. Comparing what
    // the pages SHOW is what finds it, and the model must not describe a screen
    // that only some viewers have.
    const diverged = v?.behind
      ? `\n\nWarning: ${v.behind} viewer${v.behind === 1 ? "" : "s"} ${v.behind === 1 ? "is" : "are"} watching but ${v.behind === 1 ? "has" : "have"} not applied every action ` +
        `— ${v.behind === 1 ? "it" : "they"} joined part-way through, or missed one while away. ` +
        `${v.behind === 1 ? "That viewer has" : "Those viewers have"} been told on screen how far behind they are, and reloading catches them up. ` +
        `Do not describe the page as if everyone sees the same thing.`
      : "";
    const dropped = v?.offline
      ? `\n\nNote: ${v.offline} viewer${v.offline === 1 ? "" : "s"} stopped responding and ${v.offline === 1 ? "was" : "were"} dropped as offline; ` +
        `${v.offline === 1 ? "it" : "they"} did not see this and will rejoin only by reloading.`
      : "";
    // Some pages refused it and the rest carried on. The run is not stopped for
    // this — one watching page is enough — but the people in front of the others
    // are now looking at something the agent is not describing, and that has to
    // be said out loud or it is the silent divergence all over again.
    const refused = v ? v.following - v.succeeded - (v.offline ?? 0) : 0;
    const shortfall = refused > 0
      ? `\n\nWarning: ${refused} following page${refused === 1 ? "" : "s"} did not run this` +
        (r.error ? ` — ${r.error}` : "") +
        `. ${refused === 1 ? "That viewer is now out of step with the rest and rejoins" : "Those viewers are now out of step with the rest and rejoin"} by reloading. ` +
        (READ_ONLY.has(action)
          ? `This only read the page, so calling it again is safe.`
          : `Do not re-run this to catch them up: the pages that did run it would apply it twice.`)
      : "";
    const where = v
      ? ` in ${v.succeeded} of ${v.following} following ${v.following === 1 ? "page" : "pages"}` +
        (v.detached > 0
          ? ` (${v.detached} other ${v.detached === 1 ? "viewer has" : "viewers have"} taken control of their own copy and no longer follow along)`
          : "")
      : "";
    // Followers can be on different pages of the same app without anyone having
    // taken control — two people simply opened different URLs. The same
    // instruction then hit unrelated DOMs, and the result below is from only one
    // of them, so the model has to be told rather than left to assume one page.
    // A page that missed an action is otherwise invisible: the ones that ran it
    // answer fine and the count reads as a clean N-of-N. Whoever is looking at
    // the page that missed it is now seeing something nobody else is.
    const lost = v?.missed
      ? `\n\nNote: ${v.missed} page${v.missed === 1 ? "" : "s"} that ${v.missed === 1 ? "was" : "were"} watching did not come back in time ` +
        `(usually a navigation) and missed this action, so ${v.missed === 1 ? "its viewer is" : "their viewers are"} now out of step. ` +
        `They rejoin by reloading.`
      : "";
    const split = v?.urls?.length
      ? `\n\nNote: the following pages are NOT all on the same URL (${v.urls.join(", ")}), ` +
        `so this ran against different documents and the result below is from one of them.`
      : "";
    return `${action} ran${where}.${split}${shortfall}${lost}${dropped}${diverged}${noEffect(r.result)}${noTools(action, r.result)}\n\n${JSON.stringify(r.result, null, 2)}`;
  }
  switch (r.reason) {
    case "nobody-ran": {
      // Nothing ran anywhere, which is the one shortfall that is safe to fix and
      // retry — no page applied it, so nothing can be applied twice. The reason
      // matters more than the count here: "0 of 2 acknowledged" cannot tell a
      // missing selector from a tool the app never registered, and the model has
      // no screen to check against.
      const v = r.viewers;
      const gone = v?.offline ? ` ${v.offline} stopped responding and ${v.offline === 1 ? "was" : "were"} dropped as offline.` : "";
      const late = v?.missed ? ` ${v.missed} did not reconnect in time (usually a slow network after a navigation).` : "";
      const why = r.error ? ` What the pages said: ${r.error}` : "";
      return `${action} did not run: no following page acknowledged it.${gone}${late}${why}\n\n` +
        `Nothing was applied anywhere, so it is safe to fix the problem and try again.`;
    }
    case "no-viewer":
      return `Nobody has this preview open, so there is no page to drive. Ask the people in the session to open the Browser panel — the point of this tool is that they watch you work, so there is deliberately no invisible fallback.`;
    case "all-detached": {
      // Deliberately not appending r.error here: it says the same thing in the
      // dashboard's words, and a doubled sentence reads like two separate
      // findings to a model quoting the result back to a human.
      const n = r.viewers?.detached ?? 0;
      const who = n === 1 ? "The one viewer of this preview has" : `All ${n} viewers of this preview have`;
      return `${who} taken control of their own copy of the page, so nobody is following your actions any more and the ${action} did not run. They rejoin by reloading the preview.`;
    }
    case "no-dashboard":
      return `Could not reach the preview panel: ${r.error}. The preview itself may still be running — try again, and call list_previews if it keeps failing.`;
    default:
      return `${action} failed: ${r.error ?? "the page did not answer"}`;
  }
}
