/**
 * Auto-share: a preview in a session that peers are already in should BE shared.
 *
 * Without this, a session can be live with peers in it while its preview stays
 * reachable only by the host — peers see a running app they cannot open, and
 * someone has to notice and click Share. Publishing widens nothing: the front
 * process re-derives preview access from a live share on every request, so a
 * tunnel URL only ever admits people already admitted to the session.
 *
 * Written as a RECONCILER rather than two event handlers because it has to cover
 * both orders — a preview starting into an already-shared session, and a peer
 * joining a session whose preview is already running. One sweep over (running
 * previews × live shares) satisfies both without depending on which event
 * arrived, or on any particular event shape.
 *
 * Extracted from server.mjs purely so it can be tested: server.mjs boots real
 * listeners and spawns cloudflared, so its logic is otherwise unreachable from a
 * test. Every side effect arrives as an injected dependency; this module owns the
 * DECISIONS and none of the transport. server.mjs keeps the debounce and the
 * transport, and drives the sweep through createCoalescingRunner below.
 */

/**
 * Serialize reconcile passes without ever LOSING one.
 *
 * A reconciler is only as good as its trigger. The guard here used to be a bare
 * `if (running) return`, which serialized correctly and dropped the signal on
 * the floor: any event arriving mid-pass was discarded, and since nothing sweeps
 * on a timer, nothing ever went back for it. The preview stayed unshared until
 * some unrelated event happened to trigger another pass.
 *
 * That window is not small. A pass spawns cloudflared, which can take tens of
 * seconds, and "preview started" then "preview is now running" are exactly the
 * kind of pair that straddles it — so the common case (start a preview in a
 * session that peers are already in) is the one most likely to be dropped.
 *
 * Re-runs go back through `schedule` rather than looping here, so the caller's
 * debounce still applies. That bounds the rate no matter how chatty the event
 * stream gets, and it cannot spin: the sweep is idempotent, so a pass with
 * nothing left to do produces no further events.
 *
 * @param {object} deps
 * @param {() => Promise<void>} deps.run       one reconcile pass; must not throw
 * @param {() => void} deps.schedule           request another pass (debounced)
 * @returns {() => Promise<"ran" | "coalesced">}
 */
export function createCoalescingRunner({ run, schedule }) {
  let running = false;
  let missed = false;
  return async function trigger() {
    if (running) {
      missed = true;
      return "coalesced";
    }
    running = true;
    try {
      await run();
    } finally {
      running = false;
      // Also re-runs after a FAILED pass, which is what we want: the trigger it
      // swallowed is owed a pass either way.
      if (missed) {
        missed = false;
        schedule();
      }
    }
    return "ran";
  };
}

/**
 * One reconcile pass.
 *
 * @param {object} deps
 * @param {() => Promise<Array>} deps.fetchPreviews     sandbox GET /previews
 * @param {() => Promise<Array>} deps.fetchShares       sandbox GET /shares
 * @param {(slot: number) => Promise<{url?: string, error?: string}>} deps.startPreviewTunnel
 * @param {(slot: number) => void} deps.stopPreviewTunnel
 * @param {(sessionId: string, previewId: string, url: string) => Promise<boolean>} deps.recordPreviewShared
 * @param {() => number[]} [deps.liveTunnelSlots]   slots currently holding a tunnel
 * @param {() => boolean} [deps.dashboardTunnelUp]  is the session tunnel running?
 * @param {() => void} [deps.stopDashboardTunnel]
 * @param {() => boolean} [deps.sawAnyShare]        has a share existed this run?
 * @param {(v: boolean) => void} [deps.setSawAnyShare]  latch, owned by the caller
 *        like the debounce is — it is process state, not policy.
 * @param {(...args: unknown[]) => void} [deps.log]
 * @returns {Promise<{shared: string[], failed: string[], reclaimed: number[],
 *          dashboardTunnelStopped: boolean}>} previewIds and reclaimed slots, for
 *          tests and for callers that want to log a summary.
 */
export async function autoShareSweep({
  fetchPreviews,
  fetchShares,
  startPreviewTunnel,
  stopPreviewTunnel,
  recordPreviewShared,
  liveTunnelSlots = () => [],
  dashboardTunnelUp = () => false,
  stopDashboardTunnel = () => {},
  sawAnyShare = () => false,
  setSawAnyShare = () => {},
  log = () => {},
}) {
  // dashboardTunnelStopped is declared here rather than assigned only when it
  // happens, so the returned shape is one thing callers (and the checker) can
  // rely on instead of two.
  const result = { shared: [], failed: [], reclaimed: [], dashboardTunnelStopped: false };

  const previews = await fetchPreviews();

  // ── collect the garbage first ──────────────────────────────────────────────
  // A tunnel outlives the preview it was opened for unless something closes it,
  // and nothing did: stopping a preview (from the dock, from settings, or now
  // from the idle sweeper) left cloudflared running against an empty slot, still
  // serving a public hostname. Reconciling both directions here means every way a
  // preview can end is covered by construction, instead of each caller having to
  // remember to tear the tunnel down.
  const sharedSlots = new Set(
    (previews ?? []).filter((p) => p.publicUrl).map((p) => p.slot),
  );
  for (const slot of liveTunnelSlots()) {
    if (sharedSlots.has(slot)) continue;
    stopPreviewTunnel(slot);
    result.reclaimed.push(slot);
    log("auto-share: no shared preview on slot", slot, "- tunnel closed");
  }
  // `publicUrl` already set means shared — re-sharing would strand a second
  // tunnel on the same slot with nothing tracking it.
  const candidates = (previews ?? []).filter((p) => p.state === "running" && !p.publicUrl);

  // Fetched only when it can change an outcome: the overwhelmingly common case
  // is a solo session with nothing to do, and this saves it a round trip.
  const needShares = candidates.length > 0 || dashboardTunnelUp();
  const shares = needShares ? await fetchShares() : null;

  // The session tunnel exposes the DASHBOARD, not one session, so it can only
  // come down once NOBODY is using it — the idle sweeper revoking the last
  // session's shares is what usually gets it there. `sawAnyShare` is the reason
  // this is not simply "no shares": the host starts the tunnel *before* inviting
  // anyone, and a bare zero-shares test would kill it mid-invite.
  if (dashboardTunnelUp() && shares) {
    if (shares.length > 0) setSawAnyShare(true);
    else if (sawAnyShare()) {
      stopDashboardTunnel();
      setSawAnyShare(false);
      result.dashboardTunnelStopped = true;
      log("auto-share: last share is gone - dashboard tunnel closed");
    }
  }

  if (candidates.length === 0 || !shares || shares.length === 0) return result;
  const sharedSessions = new Set(shares.map((s) => s.sessionId));

  for (const p of candidates) {
    if (!sharedSessions.has(p.sessionId)) continue;

    const started = await startPreviewTunnel(p.slot);
    if (!started?.url) {
      log("auto-share: could not start a tunnel for slot", p.slot, "-", started?.error ?? "unknown");
      result.failed.push(p.previewId);
      continue;
    }

    const recorded = await recordPreviewShared(p.sessionId, p.previewId, started.url);
    if (!recorded) {
      // Roll the tunnel back. A live tunnel the record does not know about is an
      // ingress nothing will ever close: unshare/stop both work from the record.
      stopPreviewTunnel(p.slot);
      log("auto-share: sandbox refused to record the share; tunnel rolled back", p.previewId);
      result.failed.push(p.previewId);
      continue;
    }

    log("auto-share: preview", p.spec?.name ?? p.previewId, "shared at", started.url);
    result.shared.push(p.previewId);
  }

  return result;
}
