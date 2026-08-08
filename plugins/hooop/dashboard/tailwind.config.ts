import type { Config } from "tailwindcss";

// The dashboard is written entirely in Tailwind `neutral-*` classes, each used
// with a stable semantic role (950 = stage, 900 = panel, 200 = ink, 500 = muted
// ink, 800 = divider, ...). Point that scale at CSS variables instead of fixed
// hexes so flipping `<html data-theme>` re-skins every surface without touching
// a class. Channels are space-separated RGB triples so `/opacity` modifiers
// (bg-neutral-900/80, bg-neutral-950/95, ...) keep working. See globals.css.
const neutral = Object.fromEntries(
  [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [
    step,
    `rgb(var(--neutral-${step}) / <alpha-value>)`,
  ]),
);

// Desktop-app semantic tokens (the migration target — see DESIGN.md). Each maps
// to a CSS var defined per-theme in globals.css. Colors use the `<alpha-value>`
// form so tint modifiers work (`bg-accent/15`, `text-ink-mute/70`). The neutral
// scale above stays for un-migrated panels until they're ported.
const rgb = (token: string) => `rgb(var(--${token}) / <alpha-value>)`;
const semantic = {
  // surfaces
  bg: rgb("bg"),
  window: rgb("window"),
  rail: rgb("rail"),
  center: rgb("center"),
  elevated: rgb("elevated"),
  "elevated-2": rgb("elevated-2"),
  // ink
  ink: rgb("ink"),
  "ink-soft": rgb("ink-soft"),
  "ink-mute": rgb("ink-mute"),
  "ink-faint": rgb("ink-faint"),
  "ink-hush": rgb("ink-hush"),
  // cues (state only)
  accent: rgb("accent"),
  "accent-press": rgb("accent-press"),
  live: rgb("live"),
  wrap: rgb("wrap"),
  sdk: rgb("sdk"),
  direct: rgb("direct"),
  fail: rgb("fail"),
  // chat
  "host-bubble": rgb("host-bubble"),
  "peer-bubble": rgb("peer-bubble"),
  // Anything drawn on top of one of those two fills. White under the dark
  // theme, near-black under the light one, so hairlines and dots stay visible
  // in both instead of being hardcoded `white/NN`.
  "bubble-ink": rgb("bubble-ink"),
};

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        neutral,
        ...semantic,
        // rgba tint/overlay tokens (no alpha modifier — used as-is)
        sunken: "var(--sunken)",
        divider: "var(--divider)",
      },
      // --sunken/--divider double as ready-made border/background utilities.
      borderColor: { divider: "var(--divider)", DEFAULT: "var(--divider)" },
      backgroundColor: { sunken: "var(--sunken)" },
      fontFamily: {
        // Archivo for UI/display, JetBrains Mono for figures/code. Loaded via
        // next/font in layout.tsx, which sets these CSS vars.
        sans: ["var(--font-archivo)", "system-ui", "-apple-system", "sans-serif"],
        display: ["var(--font-archivo)", "system-ui", "-apple-system", "sans-serif"],
        mono: [
          "var(--font-jetbrains-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      borderRadius: {
        // desktop-app scale: window → cards → controls
        window: "22px",
        card: "16px",
        control: "10px",
        bubble: "16px",
      },
      boxShadow: {
        // elevation set ported from the mockup (dark-tuned ambient shadows)
        card: "0 24px 60px -20px rgba(0, 0, 0, 0.7)",
        overlay: "0 40px 120px -30px rgba(0, 0, 0, 0.8)",
        drawer: "0 -30px 90px -20px rgba(0, 0, 0, 0.7)",
        slideover: "-30px 0 100px -20px rgba(0, 0, 0, 0.7)",
      },
      // Motion: one shared "ease with weight" curve (a soft easeOut that settles
      // rather than stops) + the enter keyframes the shell composes. Everything
      // is opacity/transform only so it stays cheap and `motion-safe:`-gated at
      // the call site honours prefers-reduced-motion.
      transitionTimingFunction: {
        smooth: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "modal-in": {
          from: { opacity: "0", transform: "translateY(8px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "slide-in-bottom": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "msg-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Exit counterparts — reversed, and on a slightly quicker "ease-in"
        // (accelerate away) so dismissal feels crisp rather than sluggish.
        "fade-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        "modal-out": {
          from: { opacity: "1", transform: "translateY(0) scale(1)" },
          to: { opacity: "0", transform: "translateY(8px) scale(0.98)" },
        },
        "slide-out-right": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(100%)" },
        },
        "slide-out-bottom": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(100%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out both",
        "modal-in": "modal-in 0.24s cubic-bezier(0.22, 1, 0.36, 1) both",
        "slide-in-right": "slide-in-right 0.3s cubic-bezier(0.22, 1, 0.36, 1) both",
        "slide-in-bottom": "slide-in-bottom 0.3s cubic-bezier(0.22, 1, 0.36, 1) both",
        "msg-in": "msg-in 0.26s cubic-bezier(0.22, 1, 0.36, 1) both",
        "fade-out": "fade-out 0.18s ease-in both",
        "modal-out": "modal-out 0.18s cubic-bezier(0.4, 0, 1, 1) both",
        "slide-out-right": "slide-out-right 0.24s cubic-bezier(0.4, 0, 1, 1) both",
        "slide-out-bottom": "slide-out-bottom 0.24s cubic-bezier(0.4, 0, 1, 1) both",
      },
    },
  },
  plugins: [],
};
export default config;
