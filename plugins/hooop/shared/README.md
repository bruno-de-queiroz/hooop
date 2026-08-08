# `shared/`

Small TypeScript modules shared between the `dashboard/` (Next.js UI) and
`sandbox/` (claude runtime) packages. The trigger to split these out was
three near-identical files starting to drift: `logger.ts`, `shutdown.ts`,
`clamp.ts`.

## How callers import

Both packages declare a TypeScript path alias `@shared/*` resolving to
`../shared/*`. Use it from any consumer file:

```ts
import { log } from "@shared/logger";
import { registerShutdown } from "@shared/shutdown";
import { clampInt } from "@shared/clamp";
```

## Build wiring

- **Sandbox** (`esbuild`): resolves the alias via `tsconfig.json` paths and
  bundles the source files into `dist/server.mjs` (no separate publish).
- **Dashboard** (`Next.js`): resolves via `tsconfig.json` paths. The
  Dockerfile copies `shared/` alongside `lib/`, and `next.config.mjs` keeps
  the alias mapping in webpack.
- **Docker**: both Dockerfiles set `context` to `plugins/hooop/` so
  `shared/` is reachable. Each then `COPY` only what its image needs.

## Tests

Vitest in each package picks up its own copy of the test suite via the
`@shared/*` alias — the same source modules. Don't add per-package
divergent tests; if a test only applies to one consumer, put it next to
that consumer.

## When to add a module here

Only when **at least two** of `dashboard`, `sandbox`, and (future)
additional packages need it. Avoid using `shared/` as a junk drawer; the
trade-off is that every change here recompiles both packages.
