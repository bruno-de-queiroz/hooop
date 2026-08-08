import type { MetadataRoute } from "next";

/**
 * A web app manifest is one of Chromium's PWA-installability signals. Without
 * one, some browsers withhold the "Install" prompt entirely and, on at least
 * some builds, appear to gate background push (`userVisibleOnly` subscribe)
 * on the origin being an installed app rather than a plain tab.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "hooop",
    short_name: "hooop",
    description: "Being alone is not a requirement",
    start_url: "/",
    display: "standalone",
    background_color: "#0c0d0f",
    theme_color: "#0c0d0f",
    // PNGs alongside the SVG, because the installed app's icon is what the OS
    // shows next to a notification — and that is decided at install time from
    // this list, not per-notification. An SVG-only manifest left macOS with
    // nothing to use and it fell back to the browser's own icon.
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
