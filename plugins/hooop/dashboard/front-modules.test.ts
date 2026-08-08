import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The front process is not part of the Next build, so nothing traces its imports
// into the runtime image. Every module it pulls in has to be named in a COPY line
// or the container dies at startup with ERR_MODULE_NOT_FOUND — after a green test
// run and a successful build, because nothing before `node server.mjs` looks at
// that list. The Dockerfile says "keep this list in step with the imports at the
// top of server.mjs"; this is that instruction, enforced.
//
// Written after adding tunnel-start.mjs and shipping a dashboard that could not
// boot. A comment asking to remember something is not a mechanism.

const here = (f: string) => readFileSync(join(__dirname, f), "utf8");

/** Relative specifiers server.mjs imports, multi-line import blocks included. */
function frontImports(source: string): string[] {
  return [...source.matchAll(/\bfrom\s*"(\.\/[^"]+)"/g)]
    .map((m) => m[1].replace(/^\.\//, ""))
    // Only same-directory sidecars are copied by name; anything nested would
    // need its own COPY shape and should fail this test loudly if introduced.
    .filter((s) => s.endsWith(".mjs"));
}

describe("front process runtime image", () => {
  const server = here("server.mjs");
  const dockerfile = here("Dockerfile");
  // The runtime stage is the only one that enumerates files. The dev stage
  // copies the whole dashboard directory, so it can't drift this way.
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM "));

  it("finds the imports it is meant to be checking", () => {
    // Guards the regex itself: a silent zero-match would make every assertion
    // below vacuously pass, which is the one way this test could lie.
    const imports = frontImports(server);
    expect(imports.length).toBeGreaterThanOrEqual(4);
    expect(imports).toContain("tunnel-start.mjs");
  });

  it.each(frontImports(here("server.mjs")))("copies %s into the runtime image", (mod) => {
    expect(runtimeStage).toContain(`/build/dashboard/${mod} ./${mod}`);
  });

  it("copies no module the front process no longer imports", () => {
    const copied = [...runtimeStage.matchAll(/\/build\/dashboard\/([\w-]+\.mjs)\s/g)]
      .map((m) => m[1])
      .filter((f) => f !== "server.mjs");
    expect(copied.sort()).toEqual(frontImports(server).sort());
  });
});
