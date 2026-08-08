import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const fakeFiles = vi.hoisted(() => ({
  store: new Map<string, string>(),
  reset() { this.store.clear(); },
}));

vi.mock("node:fs", () => {
  const api = {
    existsSync: (p: string) => fakeFiles.store.has(p),
    readFileSync: (p: string) => {
      const v = fakeFiles.store.get(p);
      if (v == null) throw new Error("ENOENT");
      return v;
    },
    writeFileSync: (p: string, data: string | Buffer) => {
      fakeFiles.store.set(p, typeof data === "string" ? data : data.toString());
    },
    chmodSync: () => undefined,
    mkdirSync: () => undefined,
  };
  return { ...api, default: api };
});

let mod: typeof import("./auth");

beforeEach(async () => {
  vi.resetModules();
  fakeFiles.reset();
  process.env.HOOOP_DASHBOARD_TOKEN_FILE = "/mock/state/dashboard.token";
  mod = await import("./auth");
});

describe("dashboardToken", () => {
  it("generates a 64-char hex token on first call and persists it", () => {
    const t = mod.dashboardToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(fakeFiles.store.get("/mock/state/dashboard.token")).toBe(t);
  });

  it("returns the same token on subsequent calls within a process", () => {
    const a = mod.dashboardToken();
    const b = mod.dashboardToken();
    expect(a).toBe(b);
  });

  it("reads the persisted token from disk on a fresh module load", async () => {
    fakeFiles.store.set("/mock/state/dashboard.token", "a".repeat(64));
    vi.resetModules();
    const fresh = await import("./auth");
    expect(fresh.dashboardToken()).toBe("a".repeat(64));
  });

  it("regenerates if the persisted token is too short to trust", async () => {
    fakeFiles.store.set("/mock/state/dashboard.token", "short");
    vi.resetModules();
    const fresh = await import("./auth");
    const t = fresh.dashboardToken();
    expect(t.length).toBe(64);
    expect(t).not.toBe("short");
  });
});

describe("tokenMatches", () => {
  it("returns true only for the exact token", () => {
    const t = mod.dashboardToken();
    expect(mod.tokenMatches(t)).toBe(true);
    // Flip the last char to one guaranteed different from the real token's — a
    // hardcoded "0" collides ~1/16 of the time when the random hex token already
    // ends in "0", making the mutated string identical and the assertion flaky.
    const flipped = t.slice(0, -1) + (t.at(-1) === "0" ? "1" : "0");
    expect(mod.tokenMatches(flipped)).toBe(false);
  });

  it("returns false for null / undefined / empty", () => {
    mod.dashboardToken();
    expect(mod.tokenMatches(null)).toBe(false);
    expect(mod.tokenMatches(undefined)).toBe(false);
    expect(mod.tokenMatches("")).toBe(false);
  });

  it("returns false for a same-prefix value of different length (no short-circuit)", () => {
    const t = mod.dashboardToken();
    expect(mod.tokenMatches(t.slice(0, 10))).toBe(false);
    expect(mod.tokenMatches(t + "extra")).toBe(false);
  });
});

describe("readTokenFromCookieHeader", () => {
  it("returns the hooop_token value when present", () => {
    expect(mod.readTokenFromCookieHeader("hooop_token=abc; foo=bar")).toBe("abc");
    expect(mod.readTokenFromCookieHeader("foo=bar; hooop_token=xyz")).toBe("xyz");
  });

  it("returns null when the cookie is absent or the header is empty/null", () => {
    expect(mod.readTokenFromCookieHeader(null)).toBeNull();
    expect(mod.readTokenFromCookieHeader("")).toBeNull();
    expect(mod.readTokenFromCookieHeader("foo=bar; baz=qux")).toBeNull();
  });

  it("handles a value containing = correctly", () => {
    expect(mod.readTokenFromCookieHeader("hooop_token=a=b=c")).toBe("a=b=c");
  });
});

describe("isAllowedHost", () => {
  afterEach(() => {
    delete process.env.HOOOP_TRUSTED_HOSTS;
  });

  it("allows localhost with a port", () => {
    expect(mod.isAllowedHost("localhost:7842")).toBe(true);
  });

  it("allows bare localhost", () => {
    expect(mod.isAllowedHost("localhost")).toBe(true);
  });

  it("allows 127.0.0.1 with a port", () => {
    expect(mod.isAllowedHost("127.0.0.1:7842")).toBe(true);
  });

  it("allows [::1] with a port (browser bracket form)", () => {
    expect(mod.isAllowedHost("[::1]:7842")).toBe(true);
  });

  it("allows bare [::1]", () => {
    expect(mod.isAllowedHost("[::1]")).toBe(true);
  });

  it("allows host.docker.internal with a port", () => {
    expect(mod.isAllowedHost("host.docker.internal:7842")).toBe(true);
  });

  it("rejects an unknown hostname", () => {
    expect(mod.isAllowedHost("evil.example.com")).toBe(false);
  });

  it("rejects an unknown hostname with port", () => {
    expect(mod.isAllowedHost("evil.example.com:7842")).toBe(false);
  });

  it("rejects null", () => {
    expect(mod.isAllowedHost(null)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(mod.isAllowedHost("")).toBe(false);
  });

  it("HOOOP_TRUSTED_HOSTS: bare hostname matches any port", () => {
    process.env.HOOOP_TRUSTED_HOSTS = "mybox.local,10.0.0.5:7842";
    expect(mod.isAllowedHost("mybox.local:9999")).toBe(true);
  });

  it("HOOOP_TRUSTED_HOSTS: host:port entry matches exactly", () => {
    process.env.HOOOP_TRUSTED_HOSTS = "mybox.local,10.0.0.5:7842";
    expect(mod.isAllowedHost("10.0.0.5:7842")).toBe(true);
  });

  it("HOOOP_TRUSTED_HOSTS: host:port entry rejects wrong port", () => {
    process.env.HOOOP_TRUSTED_HOSTS = "mybox.local,10.0.0.5:7842";
    expect(mod.isAllowedHost("10.0.0.5:9999")).toBe(false);
  });

  it("HOOOP_TRUSTED_HOSTS: unknown host is still rejected", () => {
    process.env.HOOOP_TRUSTED_HOSTS = "mybox.local,10.0.0.5:7842";
    expect(mod.isAllowedHost("evil.example.com")).toBe(false);
  });
});

describe("isSameOrigin", () => {
  function req(headers: Record<string, string>): Request {
    return new Request("http://localhost:7842/api/x", { headers });
  }

  it("accepts when Origin host matches Host header", () => {
    expect(mod.isSameOrigin(req({ host: "localhost:7842", origin: "http://localhost:7842" }))).toBe(true);
  });

  it("rejects when Origin host differs", () => {
    expect(mod.isSameOrigin(req({ host: "localhost:7842", origin: "https://evil.com" }))).toBe(false);
  });

  it("falls back to Sec-Fetch-Site=same-origin when Origin is omitted", () => {
    expect(mod.isSameOrigin(req({ host: "localhost:7842", "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("falls back to Referer host match when Origin and Sec-Fetch-Site are missing", () => {
    expect(mod.isSameOrigin(req({ host: "localhost:7842", referer: "http://localhost:7842/" }))).toBe(true);
  });

  it("allows when no origin signal is present (curl / non-browser; token is the gate)", () => {
    delete process.env.HOOOP_NETWORK_HARDENING;
    expect(mod.isSameOrigin(req({ host: "localhost:7842" }))).toBe(true);
  });

  it("rejects when Sec-Fetch-Site explicitly says cross-site", () => {
    expect(mod.isSameOrigin(req({ host: "localhost:7842", "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("rejects when Origin is malformed", () => {
    expect(mod.isSameOrigin(req({ host: "localhost:7842", origin: "not a url" }))).toBe(false);
  });

  it("under HOOOP_NETWORK_HARDENING=1: rejects when no origin signal is present", () => {
    process.env.HOOOP_NETWORK_HARDENING = "1";
    try {
      expect(mod.isSameOrigin(req({ host: "localhost:7842" }))).toBe(false);
    } finally {
      delete process.env.HOOOP_NETWORK_HARDENING;
    }
  });

  it("under HOOOP_NETWORK_HARDENING=1: still accepts when Origin matches", () => {
    process.env.HOOOP_NETWORK_HARDENING = "1";
    try {
      expect(mod.isSameOrigin(req({ host: "localhost:7842", origin: "http://localhost:7842" }))).toBe(true);
    } finally {
      delete process.env.HOOOP_NETWORK_HARDENING;
    }
  });
});
