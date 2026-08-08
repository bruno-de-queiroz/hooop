import { describe, it, expect } from "vitest";
import { validatePreviewSpec, PREVIEW_LIMITS } from "./preview-spec";

function ok(input: unknown) {
  const r = validatePreviewSpec(input);
  if (!r.ok) throw new Error(`expected valid spec, got: ${r.reason}`);
  return r.spec;
}

function reason(input: unknown): string {
  const r = validatePreviewSpec(input);
  if (r.ok) throw new Error("expected the spec to be rejected");
  return r.reason;
}

const MINIMAL = { name: "web", run: "npm run dev" };

describe("validatePreviewSpec", () => {
  it("accepts a minimal spec", () => {
    expect(ok(MINIMAL)).toEqual({ name: "web", run: "npm run dev" });
  });

  it("requires run, and says what it is when missing", () => {
    // The message has to teach the shape — the model reads this and retries.
    expect(reason({ name: "web" })).toContain("Dockerfile CMD");
  });

  it("passes commands through byte-for-byte", () => {
    // The whole contract: hooop never rewrites a command. If this test starts
    // failing because someone added a `--host` injection, that's the bug.
    const gnarly = `sh -c 'PORT=$PORT exec ./bin/serve --bind "127.0.0.1:$PORT" && echo "done"'`;
    const spec = ok({ name: "x", run: gnarly, setup: ["make deps  # comment", "echo $HOME"] });
    expect(spec.run).toBe(gnarly);
    expect(spec.setup).toEqual(["make deps  # comment", "echo $HOME"]);
  });

  it("is not npm-shaped — a Python or Go spec validates identically", () => {
    expect(ok({
      name: "api",
      setup: ["uv sync"],
      run: "uv run uvicorn app:app --port $PORT",
      port: { env: "PORT" },
    }).setup).toEqual(["uv sync"]);

    expect(ok({
      name: "svc",
      setup: ["mise install", "mise exec -- go build ./..."],
      run: "./svc -addr :$PORT",
    }).setup).toHaveLength(2);
  });

  describe("workdir", () => {
    it("accepts a relative clone subdirectory and strips a trailing slash", () => {
      expect(ok({ ...MINIMAL, workdir: "my-repo/" }).workdir).toBe("my-repo");
    });

    it("normalizes '.' away rather than storing it", () => {
      expect(ok({ ...MINIMAL, workdir: "." }).workdir).toBeUndefined();
    });

    it("rejects an absolute path", () => {
      expect(reason({ ...MINIMAL, workdir: "/etc" })).toContain("RELATIVE");
    });

    it("rejects '..' traversal", () => {
      expect(reason({ ...MINIMAL, workdir: "a/../../b" })).toContain("'..'");
    });
  });

  describe("env", () => {
    it("accepts plain name/value pairs", () => {
      expect(ok({ ...MINIMAL, env: { NODE_ENV: "development" } }).env).toEqual({ NODE_ENV: "development" });
    });

    it("rejects an env name that isn't a shell identifier", () => {
      expect(reason({ ...MINIMAL, env: { "not-valid": "x" } })).toContain("invalid env variable name");
    });

    it("refuses to let a spec override PORT, which hooop owns", () => {
      // Letting this through would let a spec point the app at a port the
      // supervisor isn't forwarding, which reads as "preview never came up".
      expect(reason({ ...MINIMAL, env: { PORT: "3000" } })).toContain("set by hooop");
    });

    it("bounds the number of variables", () => {
      const env: Record<string, string> = {};
      for (let i = 0; i <= PREVIEW_LIMITS.maxEnvVars; i += 1) env[`V${i}`] = "x";
      expect(reason({ ...MINIMAL, env })).toContain("at most");
    });
  });

  describe("bounds", () => {
    it("caps setup steps", () => {
      const setup = Array.from({ length: PREVIEW_LIMITS.maxSetupSteps + 1 }, () => "true");
      expect(reason({ ...MINIMAL, setup })).toContain("at most");
    });

    it("caps command length", () => {
      expect(reason({ name: "x", run: "a".repeat(PREVIEW_LIMITS.maxCommandLen + 1) })).toContain("run is required");
    });

    it("rejects a NUL byte in a command", () => {
      expect(reason({ name: "x", run: "echo \0" })).toContain("run is required");
    });

    it("bounds readyTimeoutSec", () => {
      expect(reason({ ...MINIMAL, readyTimeoutSec: PREVIEW_LIMITS.maxReadyTimeoutSec + 1 })).toContain("between 1 and");
      expect(ok({ ...MINIMAL, readyTimeoutSec: 30 }).readyTimeoutSec).toBe(30);
    });

    it("requires readyPath to be a path", () => {
      expect(reason({ ...MINIMAL, readyPath: "health" })).toContain("must start with '/'");
      expect(ok({ ...MINIMAL, readyPath: "/healthz" }).readyPath).toBe("/healthz");
    });
  });

  it("rejects non-objects", () => {
    expect(reason(null)).toContain("must be an object");
    expect(reason("npm run dev")).toContain("must be an object");
  });
});

// port.fixed is the escape hatch for an app that cannot be told which port to
// use — a hardcoded listen(3000), a port baked into a config file. Without it
// the runner probes the port it assigned, nothing answers, and the preview fails
// as "the app did not respond", which looks like a broken app.
describe("port.fixed", () => {
  const base = { name: "web", run: "npm start" };

  it("accepts a port in the unprivileged range", () => {
    const r = validatePreviewSpec({ ...base, port: { fixed: 3000 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.port).toEqual({ fixed: 3000 });
  });

  it("keeps env and fixed together — they answer different questions", () => {
    const r = validatePreviewSpec({ ...base, port: { env: "VITE_PORT", fixed: 5173 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.port).toEqual({ env: "VITE_PORT", fixed: 5173 });
  });

  // Below 1024 the runner's non-root user could not bind it anyway, so accepting
  // it would only defer the same failure somewhere less obvious.
  it.each([80, 443, 1023, 0, -1, 65536, 1.5])("rejects %s", (bad) => {
    expect(validatePreviewSpec({ ...base, port: { fixed: bad } }).ok).toBe(false);
  });

  it("rejects a non-numeric port", () => {
    expect(validatePreviewSpec({ ...base, port: { fixed: "3000" } }).ok).toBe(false);
  });

  // Absent fields are OMITTED from the validated spec rather than nulled (see
  // the builder's `...(port ? { port } : {})`), so "no port block" means the key
  // is simply not there — which is what the runner reads as assign-and-export.
  it("omits port entirely when no port block is given", () => {
    const r = validatePreviewSpec(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.port).toBeUndefined();
  });
});
