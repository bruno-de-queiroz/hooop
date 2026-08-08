import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDriveQueue, describeDriveResult } from "./preview-drive.js";

/**
 * The queue exists because a tool call is a promise a human is watching a
 * spinner for. Every path through it must END — with the truth about which part
 * failed, since "nobody is watching", "the dashboard is gone" and "the page
 * threw" have three different remedies and only one of them involves the model
 * trying again.
 */
describe("relaying an action to the dashboard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const click = { previewId: "pv1", slot: 2, action: "click", params: { selector: "#go" } };

  it("hands a parked action to the next poller, and its result back to the model", async () => {
    const q = createDriveQueue();
    const call = q.request(click);
    const got = await q.take(1000);

    expect(got).toMatchObject({ previewId: "pv1", slot: 2, action: "click" });
    q.settle(got!.id, { ok: true, result: { clicked: "#go" } });
    expect(await call).toMatchObject({ ok: true, result: { clicked: "#go" } });
  });

  it("wakes a poller that was already waiting", async () => {
    // The normal case in production: the dashboard is parked on the long-poll
    // before the model calls anything, so pickup should be immediate.
    const q = createDriveQueue();
    const poll = q.take(30_000);
    const call = q.request(click);

    const got = await poll;
    expect(got).toMatchObject({ action: "click" });
    q.settle(got!.id, { ok: true, result: {} });
    await expect(call).resolves.toMatchObject({ ok: true });
  });

  it("gives an empty poll back rather than an error when nothing is queued", async () => {
    const q = createDriveQueue();
    const poll = q.take(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await poll).toBeNull();
  });

  it("says the dashboard never collected it, distinctly from a page failure", async () => {
    // No front process polling. The model must not be told "the page did not
    // answer" — no page was ever asked.
    const q = createDriveQueue();
    const call = q.request(click, { pickupMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await call).toMatchObject({ ok: false, reason: "no-dashboard" });
  });

  it("stops counting pickup once collected, and counts the run instead", async () => {
    const q = createDriveQueue();
    const call = q.request(click, { pickupMs: 500, runMs: 5_000 });
    const got = await q.take(0);

    // Well past the pickup deadline — collection cancelled it, so a page that
    // takes its time is not reported as a dashboard that never showed up.
    await vi.advanceTimersByTimeAsync(1000);
    q.settle(got!.id, { ok: true, result: {} });
    expect(await call).toMatchObject({ ok: true });
  });

  it("gives up on a dashboard that collected an action and vanished", async () => {
    const q = createDriveQueue();
    const call = q.request(click, { pickupMs: 500, runMs: 5_000 });
    await q.take(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await call).toMatchObject({ ok: false, reason: "no-result" });
  });

  it("ignores a result that arrives after the model has been answered", async () => {
    // A late POST must not throw, and must not resolve a promise twice.
    const q = createDriveQueue();
    const call = q.request(click, { pickupMs: 500, runMs: 1_000 });
    const got = await q.take(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(call).resolves.toMatchObject({ reason: "no-result" });
    expect(() => q.settle(got!.id, { ok: true })).not.toThrow();
  });

  it("keeps two actions apart and answers each one", async () => {
    const q = createDriveQueue();
    const first = q.request({ ...click, params: { selector: "#a" } });
    const second = q.request({ ...click, params: { selector: "#b" } });

    const a = await q.take(0);
    const b = await q.take(0);
    expect([a!.params, b!.params]).toEqual([{ selector: "#a" }, { selector: "#b" }]);

    q.settle(b!.id, { ok: true, result: "b" });
    q.settle(a!.id, { ok: true, result: "a" });
    expect(await first).toMatchObject({ result: "a" });
    expect(await second).toMatchObject({ result: "b" });
  });

  it("reports what is outstanding", async () => {
    const q = createDriveQueue();
    void q.request(click);
    expect(q.size()).toEqual({ waiting: 1, running: 0 });
    const got = await q.take(0);
    expect(q.size()).toEqual({ waiting: 0, running: 1 });
    q.settle(got!.id, { ok: true });
    expect(q.size()).toEqual({ waiting: 0, running: 0 });
  });
});

/**
 * The model cannot see the screen. The text below is the ONLY thing it learns,
 * so a failure that reads like a success — or a "no" whose remedy is unstated —
 * turns into the model confidently narrating something that did not happen.
 */
describe("what the model is told", () => {
  it("says where a successful action landed", () => {
    const text = describeDriveResult("click", {
      ok: true,
      result: { clicked: "#go" },
      viewers: { following: 2, detached: 0, succeeded: 2 },
    });
    expect(text).toContain("2 of 2 following pages");
    expect(text).toContain("#go");
  });

  it("mentions the peers who are no longer watching it work", () => {
    const text = describeDriveResult("click", {
      ok: true, result: {}, viewers: { following: 1, detached: 2, succeeded: 1 },
    });
    expect(text).toContain("2 other viewers have taken control");
  });

  it("asks for the panel to be opened rather than implying a hidden browser", () => {
    const text = describeDriveResult("click", { ok: false, reason: "no-viewer" });
    expect(text).toContain("Browser panel");
    expect(text).toMatch(/no invisible fallback/);
  });

  it("explains that a detached viewer rejoins by reloading", () => {
    const text = describeDriveResult("click", {
      ok: false, reason: "all-detached", error: "every viewer (1) has taken control",
      viewers: { following: 0, detached: 1, succeeded: 0 },
    });
    expect(text).toContain("The one viewer");
    expect(text).toContain("the click did not run");
    expect(text).toContain("reloading");
    // The dashboard's own wording says the same thing; quoting both reads to a
    // model like two separate findings, and it passes that on to the human.
    expect(text).not.toContain("every viewer (1)");
    expect(text.match(/rejoin/g)).toHaveLength(1);
  });

  it("counts the viewers when more than one has taken over", () => {
    const text = describeDriveResult("type", {
      ok: false, reason: "all-detached", viewers: { following: 0, detached: 3, succeeded: 0 },
    });
    expect(text).toContain("All 3 viewers");
  });

  it("keeps going when a page refused, and says who is now out of step", () => {
    // One watching page is enough for the run to continue — halting the agent
    // because a second tab was mid-navigation stops it for everybody, including
    // the person actually watching. What must not happen is the shortfall going
    // unsaid, because then "it worked" and "it worked everywhere" read alike.
    const text = describeDriveResult("click", {
      ok: true, result: { clicked: "#go" },
      error: "no element matches #go",
      viewers: { following: 3, detached: 0, succeeded: 2 },
    });
    expect(text).toContain("2 of 3 following pages");
    expect(text).toContain("1 following page did not run this");
    expect(text).toContain("no element matches #go");
    expect(text).toContain("out of step");
    expect(text).toContain("Do not re-run this to catch them up");
    // One page, one viewer: the sentence has to read as English, since the model
    // quotes this straight back to a human.
    expect(text).toContain("That viewer is now out of step with the rest and rejoins by reloading");
  });

  it("says it in the plural when more than one page refused", () => {
    const text = describeDriveResult("click", {
      ok: true, result: {}, error: "no element matches #go",
      viewers: { following: 4, detached: 0, succeeded: 2 },
    });
    expect(text).toContain("2 following pages did not run this");
    expect(text).toContain("Those viewers are now out of step with the rest and rejoin by reloading");
  });

  it("does not forbid repeating a READ that only some pages answered", () => {
    // The don't-repeat rule protects against applying a write twice. Aimed at a
    // snapshot it forbids the one remedy that works — and teaches the model that
    // the warning is noise, which is when it stops heeding the real one.
    const text = describeDriveResult("snapshot", {
      ok: true, result: { title: "Game" },
      viewers: { following: 3, detached: 0, succeeded: 2 },
    });
    expect(text).toContain("calling it again is safe");
    expect(text).not.toContain("apply it twice");
  });

  it("says nothing about a shortfall when there was none", () => {
    const text = describeDriveResult("click", {
      ok: true, result: {}, viewers: { following: 2, detached: 0, succeeded: 2 },
    });
    expect(text).not.toContain("did not run this");
  });

  it("does not count a peer dropped as offline as a page that refused", () => {
    // It never answered at all, and it already has its own sentence. Counting it
    // twice would invent a refusal nobody made.
    const text = describeDriveResult("click", {
      ok: true, result: {}, viewers: { following: 3, detached: 0, succeeded: 2, offline: 1 },
    });
    expect(text).not.toContain("did not run this");
    expect(text).toContain("stopped responding");
  });

  it("says why nothing ran, and that trying again is safe", () => {
    // "0 of 2 acknowledged" alone is unactionable: a selector that matches
    // nothing, a disabled control and a tool the app never registered all look
    // identical, and the model has no screen to check against. Nothing was
    // applied anywhere, so this is the one shortfall it CAN simply retry.
    const text = describeDriveResult("call_tool", {
      ok: false, reason: "nobody-ran",
      error: "no tool named take_square is registered on this page (it declares none)",
      viewers: { following: 2, detached: 0, succeeded: 0 },
    });
    expect(text).toContain("no tool named take_square");
    expect(text).toContain("safe to fix the problem and try again");
    expect(text).not.toContain("apply it twice");
  });

  it("names a slow network as the likely cause when pages did not reconnect", () => {
    const text = describeDriveResult("click", {
      ok: true, result: {}, viewers: { following: 2, detached: 0, succeeded: 2, missed: 1 },
    });
    expect(text).toContain("did not come back in time");
  });

  it("warns when a viewer is watching but has not applied every action", () => {
    // Exact, not a guess about what the page looks like: each action is numbered
    // and each page records the last one it applied. The model must not narrate a
    // screen that only some of the people in the session actually have.
    const text = describeDriveResult("click", {
      ok: true, result: {}, viewers: { following: 3, detached: 0, succeeded: 3, behind: 1 },
    });
    expect(text).toContain("1 viewer is watching but has not applied every action");
    expect(text).toContain("reloading catches them up");
    expect(text).toContain("Do not describe the page as if everyone sees the same thing");
  });

  it("turns an empty tool list into the next call, not a retry", () => {
    // `{"tools": []}` on its own reads like a page that has not finished
    // loading, and the model asks again. Most apps declare nothing.
    const text = describeDriveResult("list_tools", {
      ok: true, result: { tools: [] }, viewers: { following: 1, detached: 0, succeeded: 1 },
    });
    expect(text).toContain("declares no tools of its own");
    expect(text).toContain("page_snapshot and page_click");
  });

  it("says nothing extra when the app does declare tools", () => {
    const text = describeDriveResult("list_tools", {
      ok: true, result: { tools: [{ name: "add_todo" }] },
    });
    expect(text).not.toContain("declares no tools");
    expect(text).toContain("add_todo");
  });

  it("does not let a click that changed nothing read as one that worked", () => {
    // The failure an acknowledgement cannot catch. Every count says it worked;
    // the page watched its own DOM and nothing moved.
    const text = describeDriveResult("click", {
      ok: true,
      result: { clicked: "#go", changed: false, note: "the page did not change within 150ms of this click" },
      viewers: { following: 2, detached: 0, succeeded: 2 },
    });
    expect(text).toContain("did not change within 150ms");
    expect(text).toContain("Do not report this as having had an effect");
    expect(text).toContain("page_snapshot");
  });

  it("says nothing extra when the page did move", () => {
    const text = describeDriveResult("click", {
      ok: true, result: { clicked: "#go", changed: true },
      viewers: { following: 1, detached: 0, succeeded: 1 },
    });
    expect(text).not.toContain("Do not report this");
  });

  it("stays quiet for an action that reports no effect either way", () => {
    // A snapshot has no `changed` field; inventing a warning from its absence
    // would put a caveat on every read.
    const text = describeDriveResult("snapshot", {
      ok: true, result: { title: "Game" }, viewers: { following: 1, detached: 0, succeeded: 1 },
    });
    expect(text).not.toContain("Do not report this");
  });

  it("does not blame the page when the dashboard was the problem", () => {
    const text = describeDriveResult("click", {
      ok: false, reason: "no-dashboard", error: "nobody collected it",
    });
    expect(text).toContain("preview panel");
    expect(text).not.toMatch(/the page did not answer/);
  });
});
