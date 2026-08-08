/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output bakes the minimal runtime tree under .next/standalone.
  // The Docker runtime stage copies that and runs `node server.js` — no
  // npm install at runtime.
  output: "standalone",
  // `instrumentation.ts` runs at server boot automatically since Next 15
  // (the Next 14 `experimental.instrumentationHook` flag was removed). Used to
  // prime the sandbox client + register the shutdown drainer.
  //
  // Build/dev run on Webpack (`--webpack` in package.json), not the Next 16
  // default Turbopack. The `@shared/*` alias resolves to `../shared` (a sibling
  // package outside this app dir); Turbopack only resolves within a single
  // root, and widening `turbopack.root` to the parent nests the standalone
  // output under `standalone/dashboard/`, breaking the front process
  // (`server.mjs` spawns `node server.js` at the standalone root) and the
  // Dockerfile COPY. Webpack resolves the alias and keeps the standalone tree
  // flat, exactly as on Next 14/15. Adopting Turbopack later means relocating
  // `shared/` into the app root.
};

export default nextConfig;
