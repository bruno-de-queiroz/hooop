import { describe, it, expect, vi } from "vitest";
import {
  injectScript, isInjectableHtml, isDocumentRequest, SCRIPT_TAG, createDriverRegistry,
  RECONNECT_GRACE_BASE_MS, ACK_TIMEOUT_MS, DRIVE_QUIET_MS,
} from "./preview-driver.mjs";

/**
 * Injection rewrites somebody else's app on its way to their browser, so the
 * bar is not "usually works" — it is "never corrupts anything we did not mean
 * to touch". These pin the narrowness, which is the part that protects the app.
 */

describe("what gets rewritten", () => {
  it("injects before </head>", () => {
    const out = injectScript("<html><head><title>x</title></head><body>hi</body></html>", SCRIPT_TAG);
    expect(out).toContain(SCRIPT_TAG);
    expect(out.indexOf(SCRIPT_TAG)).toBeLessThan(out.indexOf("</head>"));
  });

  it("runs before the app's own scripts, so it must not be deferred", () => {
    // The whole WebMCP half depends on this. An app declares its tools with
    // `if (document.modelContext)` — the only correct way to write it — and a
    // deferred driver installs that API after every inline script has already
    // run. The app then registers nothing, reports nothing, and the model is
    // told the app declares no tools. It was `defer` for months and this is
    // the one line that says why it cannot be.
    expect(SCRIPT_TAG).not.toMatch(/\bdefer\b|\basync\b/);
  });

  it("falls back to </body> when there is no head", () => {
    const out = injectScript("<html><body>hi</body></html>", SCRIPT_TAG);
    expect(out.indexOf(SCRIPT_TAG)).toBeLessThan(out.indexOf("</body>"));
  });

  it("leaves a document it does not understand completely alone", () => {
    // A fragment, a streamed partial, something exotic. Returning it untouched
    // means the preview still works without the driver — strictly better than a
    // preview we broke trying to instrument it.
    const frag = "<div>just a fragment</div>";
    expect(injectScript(frag, SCRIPT_TAG)).toBe(frag);
  });

  it("is case-insensitive about the closing tag", () => {
    expect(injectScript("<HTML><HEAD></HEAD><BODY></BODY></HTML>", SCRIPT_TAG)).toContain(SCRIPT_TAG);
  });

  it("injects once, at the first head close", () => {
    const out = injectScript("<head></head><head></head>", SCRIPT_TAG);
    expect(out.split(SCRIPT_TAG).length - 1).toBe(1);
  });
});

describe("what is left byte-for-byte", () => {
  it("only touches text/html", () => {
    expect(isInjectableHtml({ "content-type": "text/html; charset=utf-8" })).toBe(true);
    for (const type of ["application/json", "text/css", "image/png", "text/plain", undefined]) {
      expect(isInjectableHtml({ "content-type": type })).toBe(false);
    }
  });

  it("refuses an already-compressed body", () => {
    // We ask for identity on documents; if the app compresses anyway, splicing
    // the bytes would produce garbage. Pass it through instead.
    expect(isInjectableHtml({ "content-type": "text/html", "content-encoding": "gzip" })).toBe(false);
    expect(isInjectableHtml({ "content-type": "text/html", "content-encoding": "br" })).toBe(false);
    expect(isInjectableHtml({ "content-type": "text/html", "content-encoding": "identity" })).toBe(true);
  });
});

describe("which requests get downgraded to identity encoding", () => {
  it("navigations do", () => {
    expect(isDocumentRequest({ "sec-fetch-dest": "document" })).toBe(true);
    expect(isDocumentRequest({ "sec-fetch-dest": "iframe" })).toBe(true);
  });

  it("subresources do not — they keep their compression", () => {
    for (const dest of ["script", "style", "image", "fetch", "empty"]) {
      expect(isDocumentRequest({ "sec-fetch-dest": dest })).toBe(false);
    }
  });

  it("falls back to Accept when Sec-Fetch-Dest is absent", () => {
    expect(isDocumentRequest({ accept: "text/html,application/xhtml+xml" })).toBe(true);
    expect(isDocumentRequest({ accept: "application/json" })).toBe(false);
    expect(isDocumentRequest({})).toBe(false);
  });

  it("trusts Sec-Fetch-Dest over Accept when both are present", () => {
    // A fetch() for an HTML partial sends Accept: text/html but is not a
    // navigation; rewriting it would corrupt an SPA's own content.
    expect(isDocumentRequest({ "sec-fetch-dest": "empty", accept: "text/html" })).toBe(false);
  });
});

/**
 * Every viewer has their own copy of the page, so the fan-out replays
 * instructions into N independent DOMs. These pin the rule that keeps that
 * honest: a copy a human has touched is theirs and stops following.
 */
describe("who the model's actions reach", () => {
  type Sent = { id?: string; action?: string; params?: unknown; type?: string; seq?: number; missed?: number; ms?: number };

  function registryWithPages(count: number, slot = 1) {
    const registry = createDriverRegistry();
    const pages = Array.from({ length: count }, (_, n) => {
      const sent: Sent[] = [];
      const ws = {
        send: (raw: string) => { sent.push(JSON.parse(raw)); },
        closed: false,
        close() { this.closed = true; },
      };
      registry.attach(slot, "pv-1", ws);
      // Real pages announce themselves; the registry waits for them by name.
      registry.receive(ws, { type: "hello", url: "http://p:7850/", vid: `v${n}` });
      return {
        ws,
        sent,
        answer(body: object = { ok: true, result: "done" }) {
          // The last message WITH AN ID: the server also sends unsolicited
          // frames (busy, stale, fresh) that are not actions to answer.
          const action = [...sent].reverse().find((m) => m.id);
          registry.receive(ws, { id: action!.id, ...body });
        },
        /** The action ids this page has been sent, oldest first. */
        ids: () => sent.filter((m) => m.id).map((m) => m.id),
        takeControl() {
          registry.receive(ws, { type: "detach", reason: "clicked in the page" });
        },
      };
    });
    return { registry, pages };
  }

  it("fans out to every following page, not just one", async () => {
    // The bug this replaces: one peer watched the model work and everyone else
    // stared at a page that never moved.
    const { registry, pages } = registryWithPages(3);
    const run = registry.drive(1, "click", { selector: "#go" });
    for (const p of pages) p.answer();
    const r = await run;

    expect(pages.map((p) => p.sent.length)).toEqual([1, 1, 1]);
    expect(pages[0].sent[0]).toMatchObject({ action: "click", params: { selector: "#go" } });
    expect(r).toMatchObject({ ok: true, viewers: { following: 3, detached: 0, succeeded: 3 } });
  });

  it("sends to every peer at once, not one after the other", async () => {
    // Every page must get the action before ANY of them has answered. Waiting
    // for each ack before sending the next would make a session with five
    // viewers five times slower than one with a single viewer, and put the
    // furthest peer's latency in series with everyone else's — the slowest
    // person in the room would set the pace for all of it.
    const { registry, pages } = registryWithPages(4);
    registry.drive(1, "click", {});
    // Read BEFORE anything is answered: this line runs in the same tick as the
    // call above, so it can only pass if all four sends already went out.
    expect(pages.map((p) => p.sent.length)).toEqual([1, 1, 1, 1]);
    for (const p of pages) p.answer();
  });

  it("takes as long as the slowest peer, not the sum of them", async () => {
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(3);
      const run = registry.drive(1, "click", {});
      // Three pages answering at 300ms, 600ms and 900ms settle the whole
      // fan-out at 900ms — in series it would be 1800ms.
      setTimeout(() => pages[0].answer(), 300);
      setTimeout(() => pages[1].answer(), 600);
      setTimeout(() => pages[2].answer(), 900);
      await vi.advanceTimersByTimeAsync(900);
      expect((await run).viewers).toMatchObject({ succeeded: 3 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives every page its own request id, so replies cannot be crossed", async () => {
    const { registry, pages } = registryWithPages(2);
    const run = registry.drive(1, "snapshot", {});
    expect(pages[0].sent[0].id).not.toBe(pages[1].sent[0].id);
    for (const p of pages) p.answer();
    await run;
  });

  it("stops sending to a page whose viewer took control", async () => {
    const { registry, pages } = registryWithPages(2);
    const [mine, theirs] = pages;
    theirs.takeControl();

    const run = registry.drive(1, "click", { selector: "#go" });
    mine.answer();
    const r = await run;

    expect(theirs.sent).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, viewers: { following: 1, detached: 1, succeeded: 1 } });
  });

  it("distinguishes nobody watching from everybody driving themselves", async () => {
    // Different remedies — "open the panel" versus "stop taking control" — so
    // the model must be able to tell them apart and say the right thing.
    const empty = createDriverRegistry();
    expect(await empty.drive(1, "click", {})).toMatchObject({ reason: "no-viewer", ok: false });

    const { registry, pages } = registryWithPages(1);
    pages[0].takeControl();
    const r = await registry.drive(1, "click", {});
    expect(r).toMatchObject({ ok: false, reason: "all-detached" });
    expect(r.error).toContain("reload");
  });

  it("re-announced detach on reconnect keeps a page out of the fan-out", async () => {
    // The socket drops and comes back; the DIVERGED PAGE does not. Without the
    // re-announcement a reconnect would silently rejoin it with state nobody
    // else has, which is exactly the failure this design exists to prevent.
    const { registry, pages } = registryWithPages(1);
    registry.drop(pages[0].ws);

    const sent: Sent[] = [];
    const reconnected = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
    registry.attach(1, "pv-1", reconnected);
    registry.receive(reconnected, { type: "hello", url: "http://p:7850/", vid: "v0" });
    registry.receive(reconnected, { type: "detach", reason: "reconnected after taking control" });

    expect(await registry.drive(1, "click", {})).toMatchObject({ reason: "all-detached" });
    expect(sent).toHaveLength(0);
  });

  it("follows again on a fresh load — which is what rejoining means", async () => {
    const { registry, pages } = registryWithPages(1);
    pages[0].takeControl();
    registry.drop(pages[0].ws);

    const sent: Sent[] = [];
    const reloaded = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
    registry.attach(1, "pv-1", reloaded);
    registry.receive(reloaded, { type: "hello", url: "http://p:7850/", vid: "v0" });

    const run = registry.drive(1, "click", {});
    registry.receive(reloaded, { id: sent[0].id, ok: true });
    expect(await run).toMatchObject({ ok: true, viewers: { following: 1, detached: 0 } });
  });

  it("does not let one silent page hold up the answer", async () => {
    // A backgrounded tab is throttled, not gone. The model still gets an answer
    // from the pages that did run it, and a count that says one did not.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      const run = registry.drive(1, "click", {}, { timeoutMs: 1000 });
      pages[0].answer();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await run).toMatchObject({ ok: true, viewers: { following: 2, succeeded: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the followers' URLs only when they disagree", async () => {
    // Nobody took control here — two people simply opened different pages of the
    // same app. The instruction still lands in both, against unrelated DOMs, and
    // the single result returned is from one of them. Silence would let the model
    // reason about a page it never touched.
    const { registry, pages } = registryWithPages(2);
    registry.receive(pages[0].ws, { type: "hello", url: "http://p/one" });
    registry.receive(pages[1].ws, { type: "hello", url: "http://p/two" });

    const run = registry.drive(1, "click", {});
    for (const p of pages) p.answer();
    const r = await run;
    expect(r.viewers.urls).toEqual(["http://p/one", "http://p/two"]);

    // Same URL: nothing worth saying.
    const same = registryWithPages(2);
    for (const p of same.pages) same.registry.receive(p.ws, { type: "hello", url: "http://p/one" });
    const run2 = same.registry.drive(1, "click", {});
    for (const p of same.pages) p.answer();
    expect((await run2).viewers).not.toHaveProperty("urls");
  });

  it("waits for a page that is mid-navigation before running the next action", async () => {
    // Caught live: the agent clicked a link, every follower's document was
    // replaced, and the NEXT action went out while their sockets were still
    // reconnecting — so it landed in whichever page happened to be back first
    // and the rest silently missed it. Half the viewers then had a board the
    // others did not, from a fan-out that reported success.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      registry.drop(pages[1].ws);                    // navigating away

      const run = registry.drive(1, "click", { selector: "#go" });
      await vi.advanceTimersByTimeAsync(50);
      expect(pages[0].sent, "drove before the navigating page was back").toHaveLength(0);

      // The new document connects and the action goes to both.
      const sent: Sent[] = [];
      const reloaded = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
      registry.attach(1, "pv-1", reloaded);
      registry.receive(reloaded, { type: "hello", url: "http://p:7850/", vid: "v1" });
      await vi.advanceTimersByTimeAsync(1);

      expect(pages[0].sent).toHaveLength(1);
      expect(sent).toHaveLength(1);
      pages[0].answer();
      registry.receive(reloaded, { id: sent[0].id, ok: true });
      expect((await run).viewers).toMatchObject({ following: 2, succeeded: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for ALL of them when a navigation drops every page at once", async () => {
    // The bug the first version of this shipped with, caught live: the drops
    // arrive one at a time, so each one saw fewer pages than the last and the
    // final drop recorded "expect 1 back". The wait was then satisfied by the
    // first page to return and the other three missed the action — while the
    // fan-out reported a clean 3-of-3, because the pages that got it answered.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(3);
      for (const p of pages) registry.drop(p.ws);         // one navigation, three drops

      const run = registry.drive(1, "click", {});
      const back: Array<{ sent: Sent[]; ws: { send(raw: string): void } }> = [];
      for (let i = 0; i < 3; i += 1) {
        await vi.advanceTimersByTimeAsync(100);
        if (i < 2) expect(back.every((b) => b.sent.length === 0), "drove before all three were back").toBe(true);
        const sent: Sent[] = [];
        const ws = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
        registry.attach(1, "pv-1", ws);
        registry.receive(ws, { type: "hello", url: "http://p:7850/", vid: `v${i}` });
        back.push({ sent, ws });
      }
      await vi.advanceTimersByTimeAsync(1);

      expect(back.map((b) => b.sent.length)).toEqual([1, 1, 1]);
      for (const b of back) registry.receive(b.ws, { id: b.sent[0].id, ok: true });
      expect((await run).viewers).toMatchObject({ following: 3, succeeded: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a page that closed rather than stalling every action", async () => {
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      registry.drop(pages[1].ws);                    // tab closed, not navigating

      const run = registry.drive(1, "click", {});
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_BASE_MS);   // the whole grace
      expect(pages[0].sent).toHaveLength(1);
      pages[0].answer();
      expect((await run).viewers).toMatchObject({ following: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the pages that never came back, instead of a clean N-of-N", async () => {
    // Without this the result is indistinguishable from a full fan-out: the two
    // pages that DID run it answer happily, and whoever is in front of the third
    // is left looking at a page nobody else has, with nothing saying so.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(3);
      registry.drop(pages[2].ws);

      const run = registry.drive(1, "click", {});
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_BASE_MS);
      pages[0].answer();
      pages[1].answer();
      const r = await run;

      expect(r.viewers).toMatchObject({ following: 2, succeeded: 2, missed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing about missed pages when everyone came back", async () => {
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      registry.drop(pages[1].ws);
      const run = registry.drive(1, "click", {});
      const sent: Sent[] = [];
      const reloaded = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
      registry.attach(1, "pv-1", reloaded);
      registry.receive(reloaded, { type: "hello", url: "http://p:7850/", vid: "v1" });
      await vi.advanceTimersByTimeAsync(1);
      pages[0].answer();
      registry.receive(reloaded, { id: sent[0].id, ok: true });
      expect((await run).viewers).not.toHaveProperty("missed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait for a viewer who took control and then left", async () => {
    // They are not coming back as a follower, so holding the agent for them
    // would be waiting on a decision already made.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      pages[1].takeControl();
      registry.drop(pages[1].ws);

      const run = registry.drive(1, "click", {});
      await vi.advanceTimersByTimeAsync(1);
      expect(pages[0].sent).toHaveLength(1);
      pages[0].answer();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a new viewer where everyone else is, so it can land there", () => {
    // A panel that opens mid-run redeems a fresh grant and would otherwise land
    // on the app's root — the agent navigates everyone to the game, the person
    // who just joined is looking at the front door. Caught when auto-open made
    // joining mid-run the common case rather than the rare one.
    const { registry, pages } = registryWithPages(2);
    for (const p of pages) registry.receive(p.ws, { type: "hello", url: "http://p:7850/game.html?x=1" });
    expect(registry.followingPath(1)).toBe("/game.html?x=1");
  });

  it("follows the majority, not a straggler mid-navigation", () => {
    const { registry, pages } = registryWithPages(3);
    registry.receive(pages[0].ws, { type: "hello", url: "http://p:7850/game.html" });
    registry.receive(pages[1].ws, { type: "hello", url: "http://p:7850/game.html" });
    registry.receive(pages[2].ws, { type: "hello", url: "http://p:7850/" });
    expect(registry.followingPath(1)).toBe("/game.html");
  });

  it("never sends a new viewer to a page somebody took control of", () => {
    // That person's detour is theirs. Landing everyone else on it would spread
    // one viewer's divergence to the whole session.
    const { registry, pages } = registryWithPages(2);
    registry.receive(pages[0].ws, { type: "hello", url: "http://p:7850/game.html" });
    registry.receive(pages[1].ws, { type: "hello", url: "http://p:7850/somewhere-else" });
    pages[1].takeControl();
    expect(registry.followingPath(1)).toBe("/game.html");
  });

  it("has no opinion when nobody is watching", () => {
    expect(createDriverRegistry().followingPath(1)).toBeNull();
  });

  it("drops a page that does not acknowledge inside the window", async () => {
    // An action is a click in a page that is already loaded and connected. A
    // second is generous for that; a page that cannot answer in one is not slow,
    // it is gone — and waiting longer would hold up everyone who IS there, on
    // every action.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      const run = registry.drive(1, "click", {});
      pages[0].answer();
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
      const r = await run;

      expect(r.viewers).toMatchObject({ succeeded: 1, offline: 1 });
      // Closed, not merely forgotten: a page that IS alive sees the close,
      // reconnects on its own and rejoins. A dead one stays gone.
      expect(pages[1].ws.closed).toBe(true);
      expect(registry.census(1)).toMatchObject({ total: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still calls the action done when the only shortfall was an offline peer", async () => {
    // Nothing went wrong with the action: it ran everywhere there was somebody
    // to run it. Calling that a failure would have the model apologising for a
    // click that worked.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      const run = registry.drive(1, "click", {});
      pages[0].answer();
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
      expect(await run).toMatchObject({ ok: true, viewers: { offline: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT wait for an offline peer on the next action", async () => {
    // It was dropped as gone, so it is not a straggler mid-navigation. Treating
    // it as one would make every later action pay the reconnect grace for
    // somebody who already stopped answering.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      const first = registry.drive(1, "click", {});
      pages[0].answer();
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
      await first;

      const second = registry.drive(1, "click", {});
      pages[0].answer();
      expect(await second).toMatchObject({ ok: true, viewers: { following: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on when one page refuses, and reports what it said", async () => {
    // A page that answers "no element matches" is present and disagreeing —
    // that is divergence, not "they went away", and it must not stop the run for
    // the viewer who CAN see the agent working. The reason rides along so the
    // model can say who is out of step and why.
    const { registry, pages } = registryWithPages(2);
    const run = registry.drive(1, "click", { selector: "#gone" });
    pages[0].answer();
    pages[1].answer({ ok: false, error: "no element matches #gone" });
    const r = await run;
    expect(r).toMatchObject({ ok: true, error: "no element matches #gone" });
    expect(r.viewers).toMatchObject({ following: 2, succeeded: 1 });
    expect(r.viewers).not.toHaveProperty("offline");
    expect(pages[1].ws.closed).toBe(false);
  });

  it("reports every distinct reason, not whichever came back first", async () => {
    // Pages fail differently and the difference IS the diagnosis: "no element
    // matches" on two copies and "covered by a modal" on a third are two
    // separate problems with two separate fixes. Picking one at random sent the
    // model hunting a missing element while the real answer sat in the reply it
    // had thrown away.
    const { registry, pages } = registryWithPages(3);
    const run = registry.drive(1, "click", { selector: "#go" });
    pages[0].answer({ ok: false, error: "no element matches #go" });
    pages[1].answer({ ok: false, error: "no element matches #go" });
    pages[2].answer({ ok: false, error: "element is covered by <div#scrim>" });

    const r = await run;
    expect(r.error).toContain("no element matches #go (2 pages)");
    expect(r.error).toContain("element is covered by <div#scrim>");
  });

  it("keeps the summary short when pages fail in many different ways", async () => {
    const { registry, pages } = registryWithPages(5);
    const run = registry.drive(1, "click", {});
    pages.forEach((p, i) => p.answer({ ok: false, error: `reason ${i}` }));
    const r = await run;
    expect(r.error).toContain("and 2 other reasons");
  });

  it("fails only when NO following page ran it", async () => {
    const { registry, pages } = registryWithPages(2);
    const run = registry.drive(1, "click", { selector: "#gone" });
    for (const p of pages) p.answer({ ok: false, error: "no element matches #gone" });
    // Both pages gave the same reason, so the summary counts them.
    expect(await run).toMatchObject({
      ok: false, reason: "nobody-ran", error: "no element matches #gone (2 pages)",
    });
  });

  /**
   * How far behind a viewer is, is a FACT, not a guess about content.
   *
   * This replaced a fingerprint of the page's text, which was wrong in both
   * directions: any clock or relative timestamp made two perfectly synchronised
   * viewers disagree forever, and it was blind to everything that is not text —
   * a disabled button, a checkbox, a canvas. Actions are ordered and numbered,
   * the page writes down the number it applied before it acknowledges, and lag is
   * a subtraction.
   */
  describe("how far behind a page is", () => {
    it("stamps every action with its position in the order", async () => {
      const { registry, pages } = registryWithPages(2);
      const first = registry.drive(1, "click", {});
      for (const p of pages) p.answer();
      await first;
      const second = registry.drive(1, "click", {});
      for (const p of pages) p.answer();
      await second;

      expect(pages[0].sent.filter((m) => m.id).map((m) => m.seq)).toEqual([1, 2]);
    });

    it("does not count a read, which changes nothing", async () => {
      // Counting a snapshot would leave every page permanently one behind for
      // having been asked a question, and the next real action would then look
      // like it had been missed everywhere.
      const { registry, pages } = registryWithPages(1);
      const look = registry.drive(1, "snapshot", {});
      pages[0].answer();
      await look;
      const act = registry.drive(1, "click", {});
      pages[0].answer();
      await act;

      const seqs = pages[0].sent.filter((m) => m.id).map((m) => m.seq);
      expect(seqs).toEqual([null, 1]);
    });

    it("tells a returning page exactly how many actions it missed", async () => {
      vi.useFakeTimers();
      try {
        const { registry, pages } = registryWithPages(2);
        registry.drop(pages[1].ws);
        for (let i = 0; i < 3; i += 1) {
          const run = registry.drive(1, "click", {});
          // Only the first drive waits out the reconnect grace. Advancing past
          // ACK_TIMEOUT_MS on the others would drop the page that IS answering.
          if (i === 0) await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_BASE_MS);
          pages[0].answer();
          await run;
        }

        const sent: Array<{ type?: string; missed?: number }> = [];
        const back = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
        registry.attach(1, "pv-1", back);
        // It left having applied nothing, and says so.
        registry.receive(back, { type: "hello", url: "http://p:7850/", vid: "v1", seq: 0 });
        expect(sent.find((m) => m.type === "stale")).toMatchObject({ missed: 3 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("believes a page that reports having applied more than we last saw", async () => {
      // Its acknowledgement can be lost — a timeout, a dropped socket — while the
      // page has genuinely applied and recorded the action. The page's own record
      // is the better evidence, and telling it to reload would throw away state
      // it was right to keep.
      vi.useFakeTimers();
      try {
        const { registry, pages } = registryWithPages(1);
        const run = registry.drive(1, "click", {}, { timeoutMs: 1000 });
        await vi.advanceTimersByTimeAsync(1000);   // ack never arrives
        await run;

        const sent: Array<{ type?: string }> = [];
        const back = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
        registry.attach(1, "pv-1", back);
        registry.receive(back, { type: "hello", url: "http://p:7850/", vid: "v9", seq: 1 });
        expect(sent.some((m) => m.type === "stale")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("will not let a page declare itself ahead of the session", async () => {
      // The number comes from a page running agent-authored code. A page that
      // claimed a huge position would be permanently "up to date" and never told
      // it had missed anything.
      const { registry } = registryWithPages(0);
      const sent: Array<{ type?: string; missed?: number }> = [];
      const back = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
      registry.attach(1, "pv-1", back);
      registry.receive(back, { type: "hello", url: "http://p:7850/", vid: "v1", seq: 9_999 });

      const run = registry.drive(1, "click", {});
      const id = (sent.find((m) => (m as { id?: string }).id) as { id?: string }).id;
      registry.receive(back, { id, ok: true, result: "done" });
      const r = await run;
      expect(r.viewers).not.toHaveProperty("behind");
    });

    it("counts a viewer who arrived part-way through the run as behind", async () => {
      const { registry, pages } = registryWithPages(1);
      const first = registry.drive(1, "click", {});
      pages[0].answer();
      await first;

      const late: Array<{ type?: string; missed?: number; id?: string }> = [];
      const ws = { send: (raw: string) => { late.push(JSON.parse(raw)); }, close() {} };
      registry.attach(1, "pv-1", ws);
      registry.receive(ws, { type: "hello", url: "http://p:7850/", vid: "vLate", seq: 0 });
      expect(late.find((m) => m.type === "stale")).toMatchObject({ missed: 1 });

      // And it stops being behind the moment it applies the next one.
      const second = registry.drive(1, "click", {});
      pages[0].answer();
      registry.receive(ws, { id: late.filter((m) => m.id).pop()!.id, ok: true, result: "done" });
      expect((await second).viewers).not.toHaveProperty("behind");
    });

    it("counts behind over the pages it actually asked, not a later census", async () => {
      // A viewer reconnecting between the fan-out and the answer would otherwise
      // be counted as behind but not as following, and the result read "ran in 1
      // of 2 following pages … 2 viewers are behind" — arithmetic nobody can
      // follow, in the one place the model is supposed to trust the numbers.
      const { registry, pages } = registryWithPages(2);
      const run = registry.drive(1, "click", {});
      for (const p of pages) p.answer();

      // Somebody new turns up mid-action, having applied nothing.
      const late = { send: () => {}, close() {} };
      registry.attach(1, "pv-1", late);
      registry.receive(late, { type: "hello", url: "http://p:7850/", vid: "vLate", seq: 0 });

      const r = await run;
      expect(r.viewers).toMatchObject({ following: 2, succeeded: 2 });
      expect(r.viewers).not.toHaveProperty("behind");
    });

    it("says nothing about lag to a viewer who has taken control", async () => {
      // Once the copy is theirs, being somewhere else is what they asked for.
      // Telling them they are behind is nagging them about their own decision.
      const { registry, pages } = registryWithPages(1);
      const first = registry.drive(1, "click", {});
      pages[0].answer();
      await first;

      const sent: Array<{ type?: string }> = [];
      const ws = { send: (raw: string) => { sent.push(JSON.parse(raw)); }, close() {} };
      registry.attach(1, "pv-1", ws);
      registry.receive(ws, { type: "detach", reason: "clicked in the page" });
      registry.receive(ws, { type: "hello", url: "http://p:7850/", vid: "vOwn", seq: 0 });

      expect(sent.some((m) => m.type === "stale")).toBe(false);
    });

    it("stops counting a page as behind once its viewer takes control", async () => {
      const { registry, pages } = registryWithPages(2);
      const first = registry.drive(1, "click", {});
      pages[0].answer();
      pages[1].answer({ ok: false, error: "no element matches" });
      await first;

      pages[1].takeControl();
      const second = registry.drive(1, "click", {});
      pages[0].answer();
      const r = await second;
      expect(r.viewers).toMatchObject({ following: 1, detached: 1 });
      expect(r.viewers).not.toHaveProperty("behind");
    });

    it("says nothing to a page that is up to date and never was behind", () => {
      const { registry } = registryWithPages(0);
      const sent: Array<{ type?: string }> = [];
      const back = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
      registry.attach(1, "pv-1", back);
      registry.receive(back, { type: "hello", url: "http://p:7850/", vid: "v1", seq: 0 });
      expect(sent).toHaveLength(0);
    });

    it("takes the banner down when a page catches up", async () => {
      // The banner lives in the page, so clearing a flag server-side was never
      // enough — a viewer who caught up kept being told they were behind.
      const { registry, pages } = registryWithPages(1);
      const first = registry.drive(1, "click", {});
      pages[0].answer();
      await first;

      const sent: Array<{ type?: string; id?: string }> = [];
      const ws = { send: (raw: string) => { sent.push(JSON.parse(raw)); }, close() {} };
      registry.attach(1, "pv-1", ws);
      registry.receive(ws, { type: "hello", url: "http://p:7850/", vid: "vB", seq: 0 });
      expect(sent.some((m) => m.type === "stale")).toBe(true);

      // It reloads and comes back having caught up to the session.
      registry.drop(ws);
      const again: Array<{ type?: string }> = [];
      const ws2 = { send: (raw: string) => { again.push(JSON.parse(raw)); }, close() {} };
      registry.attach(1, "pv-1", ws2);
      registry.receive(ws2, { type: "hello", url: "http://p:7850/", vid: "vB", seq: 1 });
      expect(again.some((m) => m.type === "stale")).toBe(false);
    });

    it("forgets the ordering when the slot changes hands", async () => {
      // Otherwise a viewer of the new preview is told it is three actions behind
      // a run in somebody else's session that it was never part of.
      const registry = createDriverRegistry();
      const oldWs = { send: () => {}, close() {} };
      registry.attach(1, "pv-old", oldWs);
      registry.receive(oldWs, { type: "hello", url: "http://p:7850/", vid: "vOld", seq: 0 });
      const first = registry.drive(1, "click", {}, { previewId: "pv-old" });
      registry.receive(oldWs, { id: "d1", ok: true });
      await first.catch(() => {});

      // A real page says hello the moment it connects, before any action — so
      // the reset has to have happened by then, which is why attaching is what
      // triggers it rather than the next drive.
      const sent: Array<{ type?: string }> = [];
      const fresh = { send: (raw: string) => { sent.push(JSON.parse(raw)); }, close() {} };
      registry.attach(1, "pv-new", fresh);
      registry.receive(fresh, { type: "hello", url: "http://p:7850/", vid: "vNew", seq: 0 });
      expect(sent.some((m) => m.type === "stale")).toBe(false);
      expect(registry.census(1)).toMatchObject({ total: 1 });
    });
  });

  it("does not say \"fresh\" to a page that was never stale", () => {
    const { registry, pages } = registryWithPages(2);
    const agreed = { type: "state", fp: "/game#abc:120", url: "http://p:7850/" };
    for (const p of pages) registry.receive(p.ws, agreed);
    expect(pages[0].sent.some((m) => (m as { type?: string }).type === "fresh")).toBe(false);
  });

  it("does not call a READ partial because somebody was mid-navigation", async () => {
    // A snapshot changes nothing, so a page that was away missed nothing. The
    // old rule failed the call, and then told the model not to try again — for
    // the one kind of call that is always safe to repeat.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      registry.drop(pages[1].ws);

      const run = registry.drive(1, "snapshot", {});
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_BASE_MS);
      pages[0].answer({ ok: true, result: { title: "Game" } });
      const r = await run;

      expect(r).toMatchObject({ ok: true, result: { title: "Game" } });
      expect(r.viewers).not.toHaveProperty("missed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps driving the page that stayed when another was mid-navigation", async () => {
    // The rule that matters most in practice: one tab reloading must not stop
    // the agent for the person watching the other one. The absence is reported,
    // not enforced.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      registry.drop(pages[1].ws);

      const run = registry.drive(1, "click", {});
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_BASE_MS);
      pages[0].answer();
      const r = await run;

      expect(r).toMatchObject({ ok: true });
      expect(r.viewers).toMatchObject({ missed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a returning page how far behind it is", async () => {
    // It was away while the agent worked ON THE PAGES THAT STAYED. Only that
    // viewer can fix their copy, and they cannot decide to unless told.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      registry.drop(pages[1].ws);                       // this viewer wanders off

      const run = registry.drive(1, "click", {});       // happens without them
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_BASE_MS);
      pages[0].answer();
      await run;

      const sent: Array<{ type?: string; missed?: number }> = [];
      const back = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
      registry.attach(1, "pv-1", back);
      registry.receive(back, { type: "hello", url: "http://p:7850/", vid: "v1" });

      expect(sent.find((m) => m.type === "stale")).toMatchObject({ missed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The page runs code the AGENT wrote, on an origin that can open its own
   * socket to the driver endpoint — the grant cookie rides along automatically.
   * So "the page" is not a trusted peer, and everything it can say has to be
   * bounded by what it is entitled to say about ITSELF.
   */
  describe("what one page is allowed to say about another", () => {
    it("ignores a reply to an action that was sent to a different page", async () => {
      // Matching by id alone let any connected page answer for every other one:
      // manufacture acknowledgements the fan-out counts as real, and hand back a
      // snapshot payload the model reads as somebody else's screen.
      const { registry, pages } = registryWithPages(2, 1);
      const run = registry.drive(1, "snapshot", {}, { timeoutMs: 50 });

      const idForPage0 = pages[0].sent[pages[0].sent.length - 1].id;
      registry.receive(pages[1].ws, { id: idForPage0, ok: true, result: "forged" });
      pages[0].answer({ ok: true, result: "genuine" });
      pages[1].answer({ ok: true, result: "also genuine" });

      const r = await run;
      expect(r.result).toBe("genuine");
      expect(r.viewers).toMatchObject({ succeeded: 2 });
    });

    it("does not let a forged reply strand the page that was really asked", async () => {
      vi.useFakeTimers();
      try {
        const { registry, pages } = registryWithPages(2, 1);
        const run = registry.drive(1, "click", {}, { timeoutMs: 1000 });
        const idForPage0 = pages[0].sent[pages[0].sent.length - 1].id;
        registry.receive(pages[1].ws, { id: idForPage0, ok: true, result: "forged" });
        pages[1].answer();
        // The real page still has its full window to answer.
        await vi.advanceTimersByTimeAsync(900);
        pages[0].answer({ ok: true, result: "genuine" });
        const r = await run;
        expect(r).toMatchObject({ ok: true, result: "genuine" });
        expect(r.viewers).not.toHaveProperty("offline");
      } finally {
        vi.useRealTimers();
      }
    });

    it("bounds a fingerprint, which is otherwise a string the page chooses", () => {
      const { registry, pages } = registryWithPages(1);
      registry.receive(pages[0].ws, { type: "state", fp: "x".repeat(50_000), url: "http://p:7850/" });
      expect(registry.census(1)).toMatchObject({ total: 1 });
    });

    it("bounds a detach reason, which is kept and logged", () => {
      const { registry, pages } = registryWithPages(1);
      registry.receive(pages[0].ws, { type: "detach", reason: "y".repeat(50_000) });
      const [detach] = registry.recent(1).filter((r) => r.kind === "detach");
      expect((detach as { reason?: string }).reason!.length).toBeLessThanOrEqual(120);
    });
  });

  /**
   * Slots are recycled between sessions, and stopping a preview closes nobody's
   * socket — a census taken after an idle sweep still shows the old viewers.
   */
  describe("a slot that has changed hands", () => {
    function attachTo(registry: ReturnType<typeof createDriverRegistry>, previewId: string) {
      const sent: Sent[] = [];
      const ws = { send: (raw: string) => { sent.push(JSON.parse(raw)); }, closed: false, close() { this.closed = true; } };
      registry.attach(1, previewId, ws);
      return { ws, sent, answer: (b: object = { ok: true, result: "done" }) =>
        registry.receive(ws, { id: [...sent].reverse().find((m) => m.id)!.id, ...b }) };
    }

    it("does not drive a viewer left over from the previous preview", async () => {
      // Otherwise one session's click runs inside another session's app, and its
      // page_snapshot comes back to a model with no business reading it.
      const registry = createDriverRegistry();
      const old = attachTo(registry, "pv-old");
      const now = attachTo(registry, "pv-new");

      const run = registry.drive(1, "snapshot", {}, { previewId: "pv-new" });
      now.answer({ ok: true, result: "the new app" });
      const r = await run;

      expect(r).toMatchObject({ ok: true, result: "the new app" });
      expect(r.viewers).toMatchObject({ following: 1, succeeded: 1 });
      expect(old.sent).toHaveLength(0);
    });

    it("closes the stale socket rather than leaving it to linger", async () => {
      const registry = createDriverRegistry();
      const old = attachTo(registry, "pv-old");
      const now = attachTo(registry, "pv-new");
      const run = registry.drive(1, "click", {}, { previewId: "pv-new" });
      now.answer();
      await run;
      expect(old.ws.closed).toBe(true);
      expect(registry.census(1)).toMatchObject({ total: 1 });
    });

    it("says nobody is watching when only the previous preview's viewers remain", async () => {
      // The honest answer, and the one that triggers the nudge. Reporting the
      // leftovers as viewers would have the agent wait for people who are not
      // looking at its app.
      const registry = createDriverRegistry();
      attachTo(registry, "pv-old");
      expect(await registry.drive(1, "click", {}, { previewId: "pv-new" }))
        .toMatchObject({ ok: false, reason: "no-viewer" });
    });

    it("leaves everyone alone when the caller names no preview", async () => {
      // The diagnostic endpoint drives without one; it must not become a way to
      // sweep the slot.
      const registry = createDriverRegistry();
      const a = attachTo(registry, "pv-old");
      const run = registry.drive(1, "click", {});
      a.answer();
      await run;
      expect(a.ws.closed).toBe(false);
    });
  });

  it("tells a page that loads mid-run that the agent is still working", async () => {
    // The two-message bug, from the one direction the page cannot see. An
    // agent-driven navigation replaces the document, so the fresh copy has no
    // memory of the run — it says hello, is told it missed actions, and raises
    // its banner underneath the panel's "the agent is using this page" overlay.
    // Only the server still remembers, so it says so, first.
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(2);
      registry.drop(pages[1].ws);
      const run = registry.drive(1, "click", {});
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_BASE_MS);
      pages[0].answer();
      await run;

      const sent: Array<{ type?: string; ms?: number }> = [];
      const back = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
      registry.attach(1, "pv-1", back);
      registry.receive(back, { type: "hello", url: "http://p:7850/", vid: "v1" });

      const busy = sent.findIndex((m) => m.type === "busy");
      const stale = sent.findIndex((m) => m.type === "stale");
      expect(busy).toBeGreaterThanOrEqual(0);
      expect(sent[busy].ms).toBeGreaterThan(0);
      // Order matters: the hold has to be in place before the banner is asked for.
      expect(busy).toBeLessThan(stale);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing about being busy long after the agent stopped", async () => {
    vi.useFakeTimers();
    try {
      const { registry, pages } = registryWithPages(1);
      const run = registry.drive(1, "click", {});
      pages[0].answer();
      await run;
      await vi.advanceTimersByTimeAsync(DRIVE_QUIET_MS + 1000);

      const sent: Array<{ type?: string }> = [];
      const back = { send: (raw: string) => { sent.push(JSON.parse(raw)); } };
      registry.attach(1, "pv-1", back);
      registry.receive(back, { type: "hello", url: "http://p:7850/", vid: "vX" });
      expect(sent.some((m) => m.type === "busy")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Taking control stops the turn only when the agent was actually using the
   * page. Without that second condition the feature was destructive: clicking
   * inside a preview is how you USE an app, and with one viewer that ordinary
   * click killed the model's turn — even when the agent had never touched the
   * preview. A killed turn also discards input queued behind it, so messages
   * other people had typed while the model worked went with it.
   */
  describe("when taking control stops the turn", () => {
    function registryWatching(count: number) {
      const idle: number[] = [];
      const registry = createDriverRegistry({ onIdle: (slot: number) => { idle.push(slot); } });
      const pages = Array.from({ length: count }, (_, n) => {
        const sent: Array<{ id?: string }> = [];
        const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close() {} };
        registry.attach(1, "pv-1", ws);
        registry.receive(ws, { type: "hello", url: "http://p:7850/", vid: `v${n}`, seq: 0 });
        return {
          ws,
          answer: () => registry.receive(ws, { id: [...sent].reverse().find((m) => m.id)!.id, ok: true }),
          takeControl: () => registry.receive(ws, { type: "detach", reason: "clicked in the page" }),
        };
      });
      return { registry, pages, idle };
    }

    it("does not stop a turn for a click in a preview the agent was not driving", async () => {
      const { pages, idle } = registryWatching(1);
      pages[0].takeControl();
      expect(idle).toEqual([]);
    });

    it("stops it when the last follower leaves a preview the agent IS driving", async () => {
      const { registry, pages, idle } = registryWatching(1);
      const run = registry.drive(1, "click", {});
      pages[0].answer();
      await run;

      pages[0].takeControl();
      expect(idle).toEqual([1]);
    });

    it("keeps going while somebody is still following", async () => {
      const { registry, pages, idle } = registryWatching(2);
      const run = registry.drive(1, "click", {});
      for (const p of pages) p.answer();
      await run;

      pages[0].takeControl();
      expect(idle).toEqual([]);
      pages[1].takeControl();
      expect(idle).toEqual([1]);
    });

    it("does not stop a turn long after the agent stopped using the page", async () => {
      // The agent moved on; the preview is just a window somebody has open.
      vi.useFakeTimers();
      try {
        const { registry, pages, idle } = registryWatching(1);
        const run = registry.drive(1, "click", {});
        pages[0].answer();
        await run;
        await vi.advanceTimersByTimeAsync(DRIVE_QUIET_MS + 1000);

        pages[0].takeControl();
        expect(idle).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("reports the census so the UI can say who is following", () => {
    const { registry, pages } = registryWithPages(3);
    pages[0].takeControl();
    expect(registry.census(1)).toEqual({ total: 3, following: 2, detached: 1 });
    registry.drop(pages[1].ws);
    expect(registry.census(1)).toEqual({ total: 2, following: 1, detached: 1 });
    expect(registry.census(2)).toEqual({ total: 0, following: 0, detached: 0 });
  });
});
