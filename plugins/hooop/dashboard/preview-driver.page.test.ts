/**
 * @vitest-environment jsdom
 *
 * The injected half, run for real in a document.
 *
 * Follow/detach hangs entirely on one discriminator: the browser marks events it
 * generated itself `isTrusted: true`, and everything the driver dispatches
 * `false`. If that were wrong in either direction the feature inverts — the model
 * would either detach every page it touched, or keep driving a page a human had
 * taken over. So it is worth testing in a DOM rather than by reading the code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DRIVER_SCRIPT } from "./preview-driver.mjs";

type Frame = {
  id?: string; type?: string; action?: string; ok?: boolean; error?: string;
  vid?: string; url?: string; fp?: string; result?: unknown;
};

class FakeSocket {
  static last: FakeSocket;
  readyState = 1;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor() { FakeSocket.last = this; }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
}

let runs = 0;

// jsdom does no layout, so EVERY element measures zero — which the actionability
// check correctly reads as "not on screen". That is an artifact of the test
// environment, not of the code, so give everything a box by default; the tests
// that care about geometry override it.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, width: 80, height: 20, top: 0, left: 0, right: 80, bottom: 20,
      toJSON: () => ({}) } as DOMRect);
});
afterEach(() => { vi.restoreAllMocks(); });

function loadDriver(opts: { native?: object } = {}) {
  document.body.innerHTML = `<button id="go" aria-label="Go">Go</button>`;
  // The guard that stops a second injection also stops a second test, and the
  // listeners of a previous instance are inert here — nothing inspects them.
  delete (window as unknown as Record<string, unknown>).__hooopDriver;
  (globalThis as unknown as Record<string, unknown>).WebSocket = FakeSocket;

  // A fresh document each time, or the previous shim is still sitting on the
  // document and the new one wraps IT — every registration would land in two
  // maps and the tool counts would drift test by test.
  // Position is persisted per preview; a stale value from the previous test
  // would make the next one assert against somebody else's run.
  localStorage.clear();
  delete (document as unknown as Record<string, unknown>).modelContext;
  delete (navigator as unknown as Record<string, unknown>).modelContext;
  if (opts.native) {
    Object.defineProperty(document, "modelContext", { value: opts.native, configurable: true });
  }

  // jsdom cannot produce a trusted event — `isTrusted` is a non-configurable own
  // property fixed at false, and there is no real input device to make one true.
  // So capture the listeners the driver installs and call them the way a browser
  // would. Untrusted events still go through real dispatch below, which is the
  // direction where the DOM's own behaviour is what we are checking.
  const handlers = new Map<string, EventListener>();
  const realAdd = window.addEventListener.bind(window);
  window.addEventListener = ((type: string, fn: EventListener, opts?: unknown) => {
    handlers.set(type, fn);
    realAdd(type, fn, opts as boolean);
  }) as typeof window.addEventListener;
  new Function(DRIVER_SCRIPT)();
  window.addEventListener = realAdd;

  return {
    socket: FakeSocket.last,
    following: () => (window as unknown as { __hooopDriver: { following(): boolean } })
      .__hooopDriver.following(),
    deliver(action: string, params: object = {}) {
      FakeSocket.last.onmessage?.({ data: JSON.stringify({ id: "a1", action, params }) });
    },
    /** Deliver an action and wait for the reply the driver sends back for it. */
    async run(action: string, params: object = {}, seq?: number): Promise<Frame> {
      const id = `r${(runs += 1)}`;
      FakeSocket.last.onmessage?.({ data: JSON.stringify({ id, action, params, seq }) });
      // An action may be a promise chain several links long (call_tool awaits the
      // app's own execute), and a click waits out its effect window before
      // answering — so give it real time, not just a drained microtask queue.
      await new Promise((r) => setTimeout(r, 250));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      return FakeSocket.last.sent.find((m) => m.id === id) as Frame;
    },
    states: () => FakeSocket.last.sent.filter((m) => m.type === "state"),
    detaches: () => FakeSocket.last.sent.filter((m) => m.type === "detach"),
    /** What the browser does when a human actually clicks or types. */
    trusted(type: string, ev: object = {}) {
      const event = { isTrusted: true, type, target: document.body, ...ev };
      handlers.get(type)?.(event as unknown as Event);
      return event;
    },
  };
}

describe("taking control of a page", () => {
  let driver: ReturnType<typeof loadDriver>;
  beforeEach(() => { driver = loadDriver(); });

  it("starts out following", () => {
    expect(driver.following()).toBe(true);
    expect(driver.detaches()).toHaveLength(0);
  });

  it("does not treat the model's own click as a human taking over", () => {
    // el.click() is how the driver acts. If this detached, the model would kick
    // every viewer out of the fan-out with its first action.
    driver.deliver("click", { selector: "#go" });
    expect(driver.following()).toBe(true);
    expect(driver.detaches()).toHaveLength(0);
  });

  it("does not treat the model's synthetic input events as a human typing", () => {
    document.body.innerHTML += `<input id="t" />`;
    driver.deliver("type", { selector: "#t", text: "hello" });
    expect((document.querySelector("#t") as HTMLInputElement).value).toBe("hello");
    expect(driver.following()).toBe(true);
  });

  it("ignores an untrusted event even when it is dispatched at the window", () => {
    // Belt and braces on the same rule: app code can dispatch pointerdown too.
    window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(driver.following()).toBe(true);
  });

  it("detaches on a real click, and says so", () => {
    driver.trusted("pointerdown");
    expect(driver.following()).toBe(false);
    expect(driver.detaches()).toEqual([{ type: "detach", reason: "clicked in the page" }]);
  });

  it("detaches on a real keystroke", () => {
    driver.trusted("keydown");
    expect(driver.following()).toBe(false);
    expect(driver.detaches()[0]).toMatchObject({ reason: "typed in the page" });
  });

  it("detaches once, however much the human then does", () => {
    for (let i = 0; i < 3; i += 1) driver.trusted("pointerdown");
    expect(driver.detaches()).toHaveLength(1);
  });

  it("lets the interaction through — taking control is not a click being eaten", () => {
    // We listen in capture and never cancel, so the app still receives the click
    // that took control. Anything else would make the first click in a detached
    // preview vanish.
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    driver.trusted("pointerdown", { preventDefault, stopPropagation });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it("refuses actions once its viewer has taken over", () => {
    let clicked = false;
    document.querySelector("#go")!.addEventListener("click", () => { clicked = true; });
    driver.trusted("pointerdown");

    driver.deliver("click", { selector: "#go" });
    expect(clicked).toBe(false);
    const reply = driver.socket.sent.find((m) => m.id === "a1");
    expect(reply).toMatchObject({ ok: false });
    expect(reply!.error).toContain("taken over");
  });

  it("tells the panel around it, which cannot see in", () => {
    // The preview is a separate origin on purpose, so the dashboard cannot tell
    // that a click landed inside the frame. Without this it goes on covering a
    // page the agent no longer drives with "the agent is using this page".
    const posted: unknown[] = [];
    const parent = { postMessage: (m: unknown) => posted.push(m) };
    Object.defineProperty(window, "parent", { value: parent, configurable: true });
    try {
      driver.trusted("pointerdown");
      expect(posted).toEqual([{ source: "hooop-preview-driver", type: "detached" }]);
    } finally {
      Object.defineProperty(window, "parent", { value: window, configurable: true });
    }
  });

  it("says nothing to a parent that is itself — a standalone tab has no panel", () => {
    const posted: unknown[] = [];
    const spy = vi.spyOn(window, "postMessage").mockImplementation((m) => { posted.push(m); });
    try {
      driver.trusted("pointerdown");
      expect(posted).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("tells the panel it is following, so the overlay is not suppressed for ever", () => {
    // The panel stops trusting "the agent is acting" once a viewer takes
    // control, because that broadcast is session-wide and the agent only drives
    // FOLLOWING pages. Rejoining means reloading, so a fresh document saying so
    // is what lets the panel start trusting it again.
    const posted: unknown[] = [];
    const parent = { postMessage: (m: unknown) => posted.push(m) };
    Object.defineProperty(window, "parent", { value: parent, configurable: true });
    try {
      loadDriver();
      expect(posted).toContainEqual({ source: "hooop-preview-driver", type: "following" });
    } finally {
      Object.defineProperty(window, "parent", { value: window, configurable: true });
    }
  });

  it("re-announces the takeover when its socket reconnects", () => {
    driver.trusted("pointerdown");
    driver.socket.sent.length = 0;
    driver.socket.onopen?.();
    expect(driver.detaches()).toEqual([
      { type: "detach", reason: "reconnected after taking control" },
    ]);
  });

  it("does not re-announce a takeover that never happened", () => {
    driver.socket.sent.length = 0;
    driver.socket.onopen?.();
    expect(driver.detaches()).toHaveLength(0);
  });

  it("announces which page it is on when it connects", () => {
    // Two viewers can both be following and still be on different URLs of the
    // same app. The server can only report that if each page says where it is.
    driver.socket.sent.length = 0;
    driver.socket.onopen?.();
    const [hello] = driver.socket.sent;
    expect(hello).toMatchObject({ type: "hello", url: location.href });
    // An id for THIS tab, so the server can wait for the specific pages that
    // went away rather than counting heads — see the registry's drop handling.
    expect(hello.vid).toBeTruthy();
  });

  it("keeps the same id across a navigation, and only across that", () => {
    // sessionStorage survives a document swap in the same tab, which is exactly
    // the lifetime we want: the page that navigated is the page we wait for.
    driver.socket.onopen?.();
    const first = driver.socket.sent.find((m) => m.type === "hello")?.vid;
    const reloaded = loadDriver();
    reloaded.socket.onopen?.();
    const again = reloaded.socket.sent.find((m) => m.type === "hello")?.vid;
    expect(first).toBeTruthy();
    expect(again).toBe(first);
  });

  it("tells the viewer what just happened, without defacing the app for good", () => {
    driver.trusted("pointerdown");
    const notice = document.querySelector(".__hooop-notice");
    expect(notice?.textContent).toContain("reload to follow along");
  });
});

/**
 * The out-of-step banner, which is the one thing hooop puts on somebody's screen
 * and leaves there. It has to appear when the view stops matching, and — the
 * part that was missing — go away when it matches again. A warning that outlives
 * its cause trains the person to ignore the next one.
 */
describe("telling a viewer their view is behind", () => {
  let driver: ReturnType<typeof loadDriver>;
  const banner = () => document.querySelector(".__hooop-stale");
  const tell = (msg: object) => driver.socket.onmessage?.({ data: JSON.stringify(msg) });

  beforeEach(() => { driver = loadDriver(); });

  it("puts up a banner that stays until it is dealt with", () => {
    tell({ type: "stale" });
    expect(banner()?.textContent).toContain("no longer matches the other viewers");
  });

  it("counts the actions a returning page missed", () => {
    tell({ type: "stale", missed: 3 });
    expect(banner()?.textContent).toContain("3 actions behind");
  });

  it("takes it down again when the page comes back into agreement", () => {
    tell({ type: "stale" });
    tell({ type: "fresh" });
    expect(banner()).toBeNull();
  });

  it("can put it back up after it has been cleared", () => {
    // Not a one-shot: a page can drift, catch up and drift again.
    tell({ type: "stale" });
    tell({ type: "fresh" });
    tell({ type: "stale" });
    expect(banner()).not.toBeNull();
  });

  it("does not stack banners when told twice", () => {
    tell({ type: "stale" });
    tell({ type: "stale" });
    expect(document.querySelectorAll(".__hooop-stale")).toHaveLength(1);
  });

  it("shrugs off a fresh it never needed", () => {
    tell({ type: "fresh" });
    expect(banner()).toBeNull();
  });

  it("takes it down when the viewer takes control — their copy is theirs now", () => {
    // Being different from everyone else is the POINT once you have taken over,
    // not a fault. And it could never come down again: the server only clears
    // banners for pages that are still following, so a takeover froze it.
    tell({ type: "stale" });
    driver.trusted("pointerdown");
    expect(banner()).toBeNull();
  });

  it("never raises one for a viewer who already took control", () => {
    driver.trusted("pointerdown");
    tell({ type: "stale" });
    expect(banner()).toBeNull();
  });

  it("holds it back while the agent is working in the page", () => {
    // The dashboard covers the iframe with its own "the agent is using this
    // page" overlay, so this would be a second competing message — and one the
    // person cannot act on, because the overlay swallows the click.
    vi.useFakeTimers();
    try {
      tell({ type: "stale" });
      expect(banner()).not.toBeNull();
      tell({ id: "x1", action: "click", params: { selector: "#go" } });
      expect(banner()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("brings it back once the agent has stopped", () => {
    vi.useFakeTimers();
    try {
      tell({ type: "stale" });
      tell({ id: "x1", action: "click", params: { selector: "#go" } });
      expect(banner()).toBeNull();
      vi.advanceTimersByTime(10_000);
      expect(banner()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resurrect a banner the server has since cleared", () => {
    vi.useFakeTimers();
    try {
      tell({ type: "stale" });
      tell({ id: "x1", action: "click", params: { selector: "#go" } });
      tell({ type: "fresh" });
      vi.advanceTimersByTime(10_000);
      expect(banner()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the banner for a run already in progress when it loads mid-run", () => {
    // A navigation the agent caused gives this document no memory of the run.
    // The server hands it the remainder of the quiet window instead.
    vi.useFakeTimers();
    try {
      tell({ type: "busy", ms: 4000 });
      tell({ type: "stale", missed: 2 });
      expect(banner()).toBeNull();
      vi.advanceTimersByTime(4000);
      expect(banner()?.textContent).toContain("2 actions behind");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not answer a busy notice as if it were an action", () => {
    driver.socket.sent.length = 0;
    tell({ type: "busy", ms: 1000 });
    expect(driver.socket.sent).toHaveLength(0);
  });

  it("does not answer a stale notice as if it were an action", () => {
    // It carries no id; replying would settle somebody else's fan-out.
    driver.socket.sent.length = 0;
    tell({ type: "stale" });
    expect(driver.socket.sent).toHaveLength(0);
  });
});

/**
 * What the model is shown of the page.
 *
 * A snapshot goes into the model's context and into the transcript, which makes
 * it the one place where "just include everything useful" is actively unsafe.
 */
describe("what a snapshot says about the page", () => {
  it("never reports what somebody typed, including into a password field", async () => {
    const driver = loadDriver();
    document.body.innerHTML = `
      <input id="pw" type="password" />
      <input id="user" type="text" />`;
    (document.querySelector("#pw") as HTMLInputElement).value = "hunter2";
    (document.querySelector("#user") as HTMLInputElement).value = "bruno@example.com";

    const reply = await driver.run("snapshot");
    const dumped = JSON.stringify(reply.result);
    expect(dumped).not.toContain("hunter2");
    expect(dumped).not.toContain("bruno@example.com");
  });

  it("does say whether a field has something in it", async () => {
    const driver = loadDriver();
    document.body.innerHTML = `<input id="a" value="x" /><input id="b" />`;
    const els = (await driver.run("snapshot")).result as { elements: Array<{ selector: string; filled?: boolean }> };
    expect(els.elements.find((e) => e.selector === "#a")?.filled).toBe(true);
    expect(els.elements.find((e) => e.selector === "#b")?.filled).toBe(false);
  });

  it("names a field from its label when it has no aria-label", async () => {
    const driver = loadDriver();
    document.body.innerHTML = `<label for="e">Email address</label><input id="e" />`;
    const r = (await driver.run("snapshot")).result as { elements: Array<{ label: string }> };
    expect(r.elements.some((e) => e.label === "Email address")).toBe(true);
  });

  it("reports a disabled control, which a click would silently do nothing to", async () => {
    const driver = loadDriver();
    document.body.innerHTML = `<button id="go" disabled>Go</button>`;
    const r = (await driver.run("snapshot")).result as { elements: Array<{ disabled?: boolean }> };
    expect(r.elements[0].disabled).toBe(true);
  });

  it("says when it has truncated, rather than implying that is the whole page", async () => {
    // A model reasoning about the first hundred controls, with no way to know
    // there are more, concludes the rest do not exist and tells somebody so.
    const driver = loadDriver();
    document.body.innerHTML = Array.from({ length: 120 },
      (_, i) => `<button id="b${i}">b${i}</button>`).join("");
    const r = (await driver.run("snapshot")).result as { elements: unknown[]; truncated?: string };
    expect(r.elements).toHaveLength(100);
    expect(r.truncated).toContain("first 100 of 120");
  });

  it("says nothing about truncation when nothing was truncated", async () => {
    const driver = loadDriver();
    document.body.innerHTML = `<button id="only">only</button>`;
    const r = (await driver.run("snapshot")).result as { truncated?: string };
    expect(r.truncated).toBeUndefined();
  });
});

/**
 * A click the app can actually notice.
 *
 * el.click() fires one event. Every component library, every drag handle and a
 * great many hand-rolled controls listen for pointerdown or mousedown instead
 * and would see nothing — while the driver reported success, which is the worst
 * answer it can give. The sequence below is what a browser does for a real
 * click, and the ONE thing it must never do is fire the click twice.
 */
describe("clicking the way a browser does", () => {
  it("gives the app the pointer sequence, and exactly one click", () => {
    const driver = loadDriver();
    const seen: string[] = [];
    const el = document.querySelector("#go")!;
    ["pointerover", "pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]
      .forEach((t) => el.addEventListener(t, () => seen.push(t)));

    driver.deliver("click", { selector: "#go" });

    expect(seen.filter((t) => t === "click")).toHaveLength(1);
    expect(seen).toEqual([
      "pointerover", "pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click",
    ]);
  });

  it("still clicks on a host that refuses to construct the richer events", () => {
    // jsdom is that host — it rejects `view` in the init. A picky environment
    // must cost us the enrichment, not the click.
    const driver = loadDriver();
    let clicked = 0;
    document.querySelector("#go")!.addEventListener("click", () => { clicked += 1; });
    driver.deliver("click", { selector: "#go" });
    expect(clicked).toBe(1);
  });
});

/**
 * What an acknowledgement is allowed to mean.
 *
 * On its own it only ever meant "the events dispatched without throwing" — which
 * is true of a button under a modal, an invisible control, and an element nobody
 * is listening to. Each check below turns one of those from a reported success
 * into either a refusal (it could not have happened) or a stated fact (it
 * happened, and the app did nothing).
 */
describe("proving the click could have happened", () => {
  let driver: ReturnType<typeof loadDriver>;
  const box = (over: Partial<DOMRect>) =>
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, width: 80, height: 20, top: 0, left: 0, right: 80, bottom: 20,
        toJSON: () => ({}), ...over } as DOMRect);

  beforeEach(() => { driver = loadDriver(); });
  afterEach(() => { delete (document as unknown as Record<string, unknown>).elementFromPoint; });

  /** jsdom has no hit testing at all, so the API has to be installed to test it. */
  const topmostIs = (el: Element | null) => {
    Object.defineProperty(document, "elementFromPoint", {
      value: () => el, configurable: true, writable: true,
    });
  };

  it("refuses an element with no size on screen", async () => {
    box({ width: 0, height: 0, right: 0, bottom: 0 });
    const r = await driver.run("click", { selector: "#go" });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain("no size on screen");
  });

  it("refuses a hidden element", async () => {
    (document.querySelector("#go") as HTMLElement).style.visibility = "hidden";
    const r = await driver.run("click", { selector: "#go" });
    expect(r.error).toContain("not visible");
  });

  it("refuses an aria-disabled control", async () => {
    // Common in component libraries, which keep the element focusable and mark
    // it this way instead of using the disabled attribute.
    document.querySelector("#go")!.setAttribute("aria-disabled", "true");
    const r = await driver.run("click", { selector: "#go" });
    expect(r.error).toContain("aria-disabled");
  });

  it("refuses anything inside an inert subtree", async () => {
    // What a modal does to the page behind it.
    document.body.innerHTML = `<div inert><button id="go">Go</button></div>`;
    const r = await driver.run("click", { selector: "#go" });
    expect(r.error).toContain("inert");
  });

  it("refuses an element something else is painted over", async () => {
    // The realistic way a click lands on nothing: dispatching at the element
    // bypasses hit testing, so a button under a modal used to click perfectly.
    document.body.innerHTML = `<button id="go">Go</button><div id="scrim">scrim</div>`;
    topmostIs(document.querySelector("#scrim"));

    const r = await driver.run("click", { selector: "#go" });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain("covered by <div#scrim>");
  });

  it("accepts a hit on a child of the target, which is the normal case", async () => {
    // A button containing a span: the topmost thing at that point is the span.
    document.body.innerHTML = `<button id="go"><span id="inner">Go</span></button>`;
    topmostIs(document.querySelector("#inner"));
    expect(await driver.run("click", { selector: "#go" })).toMatchObject({ ok: true });
  });

  it("refuses when the topmost thing is an ANCESTOR, which means we are not painted", async () => {
    // pointer-events:none is exactly this: the point resolves to the parent, and
    // a real click would go to the parent, not to us.
    document.body.innerHTML = `<div id="wrap"><button id="go">Go</button></div>`;
    topmostIs(document.querySelector("#wrap"));
    const r = await driver.run("click", { selector: "#go" });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain("covered by <div#wrap>");
  });

  it("clicks anyway when the element is scrolled out of view", async () => {
    // Nothing is covering it — the point simply cannot be asked about, and
    // refusing on that basis would be wrong.
    box({ top: -400, bottom: -380, left: 0, right: 80, width: 80, height: 20 });
    const seen = vi.fn();
    document.querySelector("#go")!.addEventListener("click", seen);
    expect(await driver.run("click", { selector: "#go" })).toMatchObject({ ok: true });
    expect(seen).toHaveBeenCalled();
  });

  it("does not refuse on a host with no hit testing at all", async () => {
    // jsdom is that host: it does not implement elementFromPoint. Where we
    // cannot ask what is on top, we do not get to refuse.
    expect((document as unknown as { elementFromPoint?: unknown }).elementFromPoint)
      .toBeUndefined();
    expect(await driver.run("click", { selector: "#go" })).toMatchObject({ ok: true });
  });

  it("does not refuse when hit testing throws", async () => {
    Object.defineProperty(document, "elementFromPoint", {
      value: () => { throw new Error("Not implemented"); }, configurable: true, writable: true,
    });
    expect(await driver.run("click", { selector: "#go" })).toMatchObject({ ok: true });
  });
});

/**
 * The check an acknowledgement cannot make.
 *
 * A click on a control nobody is listening to dispatches perfectly and changes
 * nothing, and every count in the fan-out says it worked. This is the honest
 * answer to "did the app notice", and it is local to the page: no comparison
 * against other viewers, so a clock elsewhere cannot turn it into the permanent
 * false alarm that comparing page fingerprints was.
 */
describe("saying whether the app actually did anything", () => {
  let driver: ReturnType<typeof loadDriver>;
  beforeEach(() => { driver = loadDriver(); });

  it("reports a change when a handler touches the DOM", async () => {
    document.querySelector("#go")!.addEventListener("click", () => {
      document.body.appendChild(document.createElement("p"));
    });
    const r = await driver.run("click", { selector: "#go" });
    expect(r.result).toMatchObject({ changed: true });
    expect((r.result as { note?: string }).note).toBeUndefined();
  });

  it("says so, in words, when nothing happened", async () => {
    const r = await driver.run("click", { selector: "#go" });
    expect(r).toMatchObject({ ok: true });
    expect(r.result).toMatchObject({ changed: false });
    expect((r.result as { note: string }).note).toContain("did not change");
  });

  it("is a statement about what was observed, not a verdict on the app", async () => {
    // It is a lower bound on a short window. Claiming the app ignored the click
    // would be a stronger assertion than the evidence supports.
    const r = await driver.run("click", { selector: "#go" });
    const note = (r.result as { note: string }).note;
    expect(note).toContain("within");
    expect(note).toContain("may respond more slowly");
    expect(note).not.toContain("ignored");
  });

  it("counts a navigation as the effect, since the document is leaving", async () => {
    document.querySelector("#go")!.addEventListener("click", () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    const r = await driver.run("click", { selector: "#go" });
    expect(r.result).toMatchObject({ navigated: true, changed: true });
  });

  it("notices an attribute change, not just added nodes", async () => {
    document.querySelector("#go")!.addEventListener("click", (e) => {
      (e.currentTarget as HTMLElement).setAttribute("aria-pressed", "true");
    });
    expect((await driver.run("click", { selector: "#go" })).result)
      .toMatchObject({ changed: true });
  });
});

describe("typing that the field actually took", () => {
  let driver: ReturnType<typeof loadDriver>;
  beforeEach(() => { driver = loadDriver(); });

  it("confirms the value stuck", async () => {
    document.body.innerHTML += `<input id="t" />`;
    const r = await driver.run("type", { selector: "#t", text: "hello" });
    expect(r.result).toMatchObject({ accepted: true });
  });

  it("says when the field holds something else, without echoing it back", async () => {
    // A controlled component that rejects input reverts it, and this is the only
    // sign of that. The content itself stays out of the transcript.
    document.body.innerHTML += `<input id="t" />`;
    const el = document.querySelector("#t") as HTMLInputElement;
    el.addEventListener("input", () => { el.value = "(415) 555"; });

    const r = await driver.run("type", { selector: "#t", text: "4155550000" });
    const out = r.result as { accepted: boolean; note: string };
    expect(out.accepted).toBe(false);
    expect(out.note).toContain("9 characters");
    expect(JSON.stringify(out)).not.toContain("(415) 555");
  });

  it("refuses a disabled field rather than reporting a typed value", async () => {
    document.body.innerHTML += `<input id="t" disabled />`;
    expect((await driver.run("type", { selector: "#t", text: "x" })).error)
      .toContain("disabled");
  });
});

/**
 * The tools an app declares about itself — the WebMCP half.
 *
 * This is the path we tell the model to prefer, because `add_todo({text})` is
 * both more reliable and more readable to whoever is watching than a march
 * through the DOM. It is also the path with no visible affordance and no
 * fallback: a tool the app registered under a global we do not provide is a tool
 * the model is told does not exist, and it will go clicking instead without ever
 * learning why. So the shim is tested against a document, not read.
 *
 * The consuming half of the spec is still a TODO in the draft, so hooop supplies
 * it — sanctioned by the explainer's "author-provided agents embedded directly
 * on a page". The registration half below follows the April 2026 shape.
 */
describe("tools the app declares about itself", () => {
  let driver: ReturnType<typeof loadDriver>;

  /** What an app does in its own script tag, after our injected head script. */
  function declare(tool: Record<string, unknown>, options?: { signal: AbortSignal }) {
    (document as unknown as { modelContext: { registerTool(t: unknown, o?: unknown): void } })
      .modelContext.registerTool(tool, options);
  }
  const addTodo = (execute: (a: Record<string, unknown>) => unknown = () => ({ added: true })) => ({
    name: "add_todo",
    description: "Add an item to the list",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute,
  });

  beforeEach(() => { driver = loadDriver(); });

  it("is there for the app under both names the draft has used", () => {
    // The API moved from navigator to document between drafts. An app that
    // feature-detects the other one registers nothing AND reports no error, so
    // supporting only today's name would fail in the quietest way available.
    const onDocument = (document as unknown as { modelContext?: object }).modelContext;
    const onNavigator = (navigator as unknown as { modelContext?: object }).modelContext;
    expect(onDocument).toBeTruthy();
    expect(onNavigator).toBe(onDocument);
  });

  it("lists what the app declared, with the schema needed to call it", async () => {
    declare(addTodo());
    const reply = await driver.run("list_tools");

    expect(reply).toMatchObject({ ok: true });
    expect(reply.result).toEqual({
      tools: [{
        name: "add_todo",
        description: "Add an item to the list",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      }],
    });
  });

  it("says an app declares nothing, rather than failing at it", async () => {
    // Most apps declare nothing. That is a normal answer with a normal remedy
    // (snapshot and click), not an error the model should retry.
    const reply = await driver.run("list_tools");
    expect(reply).toMatchObject({ ok: true, result: { tools: [] } });

    const clicked = await driver.run("click", { selector: "#go" });
    expect(clicked).toMatchObject({ ok: true });
  });

  it("calls a tool by name and hands back what it produced", async () => {
    const execute = vi.fn(() => ({ id: 7, text: "milk" }));
    declare(addTodo(execute));

    const reply = await driver.run("call_tool", { name: "add_todo", arguments: { text: "milk" } });
    expect(execute).toHaveBeenCalledWith({ text: "milk" });
    expect(reply).toMatchObject({ ok: true, result: { result: { id: 7, text: "milk" } } });
  });

  it("waits for a tool that does its work asynchronously", async () => {
    // execute() returning a promise is the common case — it saves, it fetches.
    // Answering before it settles would report a write that has not happened.
    declare(addTodo(async () => ({ saved: true })));
    const reply = await driver.run("call_tool", { name: "add_todo", arguments: {} });
    expect(reply).toMatchObject({ ok: true, result: { result: { saved: true } } });
  });

  it("calls a tool that takes no arguments at all", async () => {
    const execute = vi.fn(() => "cleared");
    declare({ name: "clear", description: "Empty the list", execute });
    await driver.run("call_tool", { name: "clear" });
    expect(execute).toHaveBeenCalledWith({});
  });

  it("names the tools it does have when asked for one it does not", async () => {
    // The model picked a name from somewhere — a stale list, or a guess. Telling
    // it what IS here turns a dead end into its next call.
    declare(addTodo());
    const reply = await driver.run("call_tool", { name: "add_item" });
    expect(reply).toMatchObject({ ok: false });
    expect(reply.error).toContain("no tool named add_item");
    expect(reply.error).toContain("add_todo");
  });

  it("says so plainly when the app has no tools and one is called anyway", async () => {
    const reply = await driver.run("call_tool", { name: "add_todo" });
    expect(reply.error).toContain("declares none");
  });

  it("reports a tool that threw as a failure, not as a call that worked", async () => {
    declare(addTodo(() => { throw new Error("list is full"); }));
    const reply = await driver.run("call_tool", { name: "add_todo" });
    expect(reply).toMatchObject({ ok: false, error: "list is full" });
  });

  it("reports a rejected promise the same way", async () => {
    declare(addTodo(() => Promise.reject(new Error("offline"))));
    const reply = await driver.run("call_tool", { name: "add_todo" });
    expect(reply).toMatchObject({ ok: false, error: "offline" });
  });

  it("refuses a second tool under a name already taken", () => {
    // Silently shadowing would mean the model calls the tool it was shown the
    // schema for and a different one runs.
    declare(addTodo());
    expect(() => declare(addTodo())).toThrow(/already registered/);
  });

  it("insists on a name and a description", () => {
    expect(() => declare({ name: "x", execute: () => 1 })).toThrow();
    expect(() => declare({ description: "no name", execute: () => 1 })).toThrow();
  });

  it("forgets a tool when the view that registered it goes away", async () => {
    // An unmounted component's tools are actions the person cannot see. Offering
    // them is how the model ends up operating a screen that is not on screen.
    const gone = new AbortController();
    declare(addTodo(), { signal: gone.signal });
    expect((await driver.run("list_tools")).result).toMatchObject({ tools: [{ name: "add_todo" }] });

    gone.abort();
    expect((await driver.run("list_tools")).result).toEqual({ tools: [] });
  });

  it("ignores a registration that arrives already aborted", async () => {
    const gone = new AbortController();
    gone.abort();
    declare(addTodo(), { signal: gone.signal });
    expect((await driver.run("list_tools")).result).toEqual({ tools: [] });
  });

  it("still honours the removed unregisterTool, for apps written to it", async () => {
    declare(addTodo());
    (document as unknown as { modelContext: { unregisterTool(n: string): void } })
      .modelContext.unregisterTool("add_todo");
    expect((await driver.run("list_tools")).result).toEqual({ tools: [] });
  });

  it("will not run a declared tool for a viewer who has taken control", async () => {
    const execute = vi.fn();
    declare(addTodo(execute));
    driver.trusted("pointerdown");

    const reply = await driver.run("call_tool", { name: "add_todo" });
    expect(execute).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ ok: false });
    expect(reply.error).toContain("taken over");
  });

  it("leaves a visible trace, because a tool call has no element to ring", async () => {
    // Every other action marks the thing it touched. This one runs inside the
    // app's own code, so without a word on screen the page simply changes by
    // itself while the person watching is told the agent is working.
    declare(addTodo());
    await driver.run("call_tool", { name: "add_todo" });
    expect(document.querySelector(".__hooop-notice")?.textContent).toContain("add_todo");
  });

  it("records its position before acknowledging, never after", async () => {
    // The ordering is the whole guarantee: an acknowledgement has to mean
    // "applied AND written down". Acknowledge first and a reload in the gap
    // loses the position, so this page is told to catch up on an action it
    // already has — and catching up means throwing away its state.
    declare(addTodo());
    const reply = await driver.run("call_tool", { name: "add_todo" }, 7);
    expect(reply).toMatchObject({ ok: true });
    expect(localStorage.getItem("__hooop_seq:")).toBe("7");
  });

  it("keeps the highest position it has reached, not the latest it was told", async () => {
    declare(addTodo());
    await driver.run("call_tool", { name: "add_todo" }, 9);
    await driver.run("call_tool", { name: "add_todo2" }, 3).catch(() => {});
    expect(localStorage.getItem("__hooop_seq:")).toBe("9");
  });

  it("records nothing for an action that failed", async () => {
    // It did not happen here, so claiming the position would make this page
    // look up to date while showing something nobody else has.
    localStorage.removeItem("__hooop_seq:");
    const reply = await driver.run("call_tool", { name: "nope" }, 4);
    expect(reply).toMatchObject({ ok: false });
    expect(localStorage.getItem("__hooop_seq:")).toBeNull();
  });

  it("mirrors registrations into a browser-native modelContext when there is one", async () => {
    // If a browser ships the consuming half, the app should reach it too — our
    // shim is a stand-in for a missing consumer, not a replacement for a present
    // one. And a native that rejects the call must not lose us the tool.
    const native = { registerTool: vi.fn(() => { throw new Error("nope"); }) };
    driver = loadDriver({ native });
    declare(addTodo());

    expect(native.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "add_todo" }), undefined);
    expect((await driver.run("list_tools")).result).toMatchObject({ tools: [{ name: "add_todo" }] });
  });
});
