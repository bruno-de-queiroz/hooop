---
name: hooop dashboard
description: Local observability for Claude Code sessions, sub-agents, skills, and events.
# Token catalog — mirrors app/globals.css (per-theme CSS vars) and
# tailwind.config.ts (semantic color/rounded/shadow scales). Values below are
# the dark reference; the light theme mirrors the ramp (see globals.css).
surfaces:
  bg: "#141210"          # desktop backdrop behind the window
  window: "#201e1b"      # the floating app window
  rail: "#1a1815"        # left/right rails + status bar
  center: "#221f1c"      # center chat pane
  elevated: "#2b2825"    # raised control / assistant bubble
  elevated-2: "#332f2b"  # raised-on-raised (hover)
  sunken: "rgba(0,0,0,0.28)"          # inset well (fields, tool cards)
  divider: "rgba(255,255,255,0.07)"   # hairline borders
ink:
  ink: "#ede8e0"         # primary text
  ink-soft: "#cbc4b9"    # body text
  ink-mute: "#948d82"    # secondary / labels
  ink-faint: "#6b645b"   # section titles / chips
  ink-hush: "#4c463e"    # placeholders / disabled
cues:
  accent: "#e266a7"       # brand — rationed, primary actions only
  accent-press: "#c75a93" # accent :active
  live: "#f5b544"         # amber — running / attention
  wrap: "#3ecf8e"         # green — wrapper / resolved
  sdk: "#5aa2f0"          # blue — SDK / background
  direct: "#c084fc"       # purple — direct / sub-agent
  fail: "#fb7185"         # rose — error / failure
chat:
  host-bubble: "#2f6f52"  # host chat bubble (green)
  peer-bubble: "#4589d4"  # peer chat bubble (blue)
typography:
  display:
    fontFamily: "Archivo, system-ui, -apple-system, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Archivo, system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Archivo, system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  meta:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "0.02em"
  section-title:
    fontFamily: "Archivo, system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.08em"
    textTransform: "uppercase"
  chip:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.06em"
rounded:
  control: "10px"   # buttons, fields, chips
  card: "16px"      # bubbles, cards, tool cards
  window: "22px"    # the app window itself
  full: "9999px"    # avatars, status dots
shadow:
  card: "0 24px 60px -20px rgba(0,0,0,0.7)"      # dropdowns, popovers, floating cards
  overlay: "0 40px 120px -30px rgba(0,0,0,0.8)"  # centered modals
  drawer: "0 -30px 90px -20px rgba(0,0,0,0.7)"   # bottom drawer
  slideover: "-30px 0 100px -20px rgba(0,0,0,0.7)" # right slide-over
---

# Design System: hooop dashboard

## 1. Overview

**Creative North Star: "The Desktop App"**

The dashboard is a single, self-contained application window floating on a dim desktop — a macOS-style app, not a web page. A title bar runs across the top, a left rail lists sessions, a center pane carries the live conversation, a collapsible right rail holds skills and sub-agents, and a status bar sits at the bottom. The operator (an engineering leader or IC) watches a live performance: the agent runs on stage in the center pane, and the surrounding chrome is arranged for one-glance reading. Color is **rationed** — a cue means "live", "done", "direct", "background", or "failed"; it is never decoration. Information is plentiful but it does not shout. The eye rests until something asks for attention, then gets exactly the attention it needs.

This system rejects four reflexes by name: generic SaaS admin templates (KPI grids, identical card shells), crypto-hacker neon (black with electric-green glow), Notion-style consumer warmth (off-white, pastel emoji), and AI-product purple-gradient heroes (glassmorphism, glowing borders). When a tile, chip, or panel edges toward any of those, rewrite it — don't tune it.

Density is the trade. Following Linear and Raycast more than Datadog: many things on screen, every pixel earned, no decorative chrome between the operator and the data. Neutral surfaces by default; semantic color only where it carries meaning. The window ships in **dark (reference) and light** — the same token names resolve per-theme via `data-theme` on `<html>`, so a single class layer re-skins everything.

**Key characteristics:**
- A floating, rounded app **window** on a dim desktop backdrop — three panes plus title/status bars.
- Warm-neutral surfaces stepping stage → window → rail → center → elevated. Never pure grey.
- **Archivo** for UI/display/body voice; **JetBrains Mono** for figures, code, and chips.
- **Six cue colors**, each tied to one meaning (accent, live, wrap, sdk, direct, fail). Never decorative.
- Flat panes; ambient shadows are reserved for genuinely-lifted overlays (modal, slide-over, drawer, popover).
- No gradients as decoration, no glass, no bouncy motion, no oversized corners.

## 2. Tokens & Color

Every surface, ink level, and cue is a **semantic token** — a CSS var defined per-theme in `app/globals.css` and exposed to Tailwind in `tailwind.config.ts`. You write `bg-elevated`, `text-ink-mute`, `text-accent`, `border-divider` — never a raw hue. Colors are stored as space-separated RGB triples so alpha modifiers work (`bg-accent/15`, `text-ink-mute/70`); `--sunken` and `--divider` are stored as rgba tints and used as-is (`bg-sunken`, `border-divider`).

### Surfaces (the tonal staircase)

The window is built from a warm-neutral staircase, each step half a tone above the last:

- **`bg`** — the desktop backdrop *behind* the window. Rarely seen directly.
- **`window`** — the app window body; the resting surface of rails' containers and overlays.
- **`rail`** — the left/right rails and the bottom status bar. One step off `window`.
- **`center`** — the center chat pane, faintly lifted with an accent floor-glow behind the transcript.
- **`elevated`** — raised controls, pill buttons, the assistant bubble, chips, avatars.
- **`elevated-2`** — raised-on-raised: the hover state of an `elevated` control.
- **`sunken`** — an inset well: field backgrounds, tool cards. Reads as *cut into* the surface.
- **`divider`** — the hairline. Always 1px, always this token.

### Ink (the five-step text ramp)

- **`ink`** — primary text; the highest-contrast line. The operator's own voice wins here.
- **`ink-soft`** — body text; assistant prose, readable content.
- **`ink-mute`** — secondary content, labels, tool names.
- **`ink-faint`** — section titles, chip text, at-rest glyphs.
- **`ink-hush`** — placeholders, disabled text. Below this, omit the text instead.

### Cues (six meanings, state only)

- **`accent`** (`#e266a7`, pink) — the brand. The single primary action per context (Send, the active tab/row tint, focus ring). Rationed hard: if two things on screen are accent, one is wrong.
- **`live`** (amber) — "currently running." Busy session dot, the `?` of AskUserQuestion, in-flight spinners, the running-agent pulse.
- **`wrap`** (green) — "resolved." Completed run dots, tool-call bullets, OK exit codes. A state that *finished*, never a "submit" affordance.
- **`sdk`** (blue) — "background, not a person." Marks SDK/CLI sessions so a glance separates automation from humans.
- **`direct`** (purple) — "the user caused this." Sub-agent invocation, skill-spawned sessions, direct-driven actions.
- **`fail`** (rose) — errors only. Never a generic "danger" tint on benign actions.

### Chat bubbles

- **`host-bubble`** (green) — the host's chat messages (right-aligned, white ink).
- **`peer-bubble`** (blue) — a peer's chat messages (right-aligned, white ink).
- The assistant speaks from an **`elevated`** bubble (left-aligned, `ink-soft`).

### Named rules

**The Rationed Color Rule.** Cue colors encode state, never character. A colored glyph/chip/dot must say *what is happening* (accent = primary action, live/wrap/sdk/direct/fail = the five states). There are exactly six cue meanings; everything else is a neutral surface or ink step.

**The Brightest Pixel Rule.** The highest-contrast text belongs to whoever is giving direction — the operator's prompt line renders in `ink`; the assistant's voice drops to `ink-soft`; tool calls drop further to `ink-mute`/`ink-faint`. Hierarchy is enforced by contrast, not font weight.

**The No-Decorative-Tint Rule.** Backgrounds come from the surface staircase (`window`→`elevated-2`) plus `sunken`. The only sanctioned color tints are functional: the active list-row / active-tab accent wash, the focus ring, and the summary card's faint accent floor. No green "success" panels, no purple hover.

## 3. Typography

**Display / UI / body:** **Archivo** (`--font-archivo`, loaded via `next/font` → `font-sans` / `font-display`).
**Figures / code / chips:** **JetBrains Mono** (`--font-jetbrains-mono` → `font-mono`), always `tabular-nums`.

**Character:** Archivo carries the human-readable layer — titles, labels, chat prose. JetBrains Mono is reserved for anything that must *align or be read as data*: durations, token counts, PIDs, timestamps, code, and the uppercase classification chips. The split is deliberate: prose in Archivo reads as conversation, monospace figures read as instruments.

### Hierarchy

- **Display** (Archivo `600`, `20px`, `-0.01em`): the app/session title in the title bar. Once per view.
- **Title** (Archivo `600`, `14px`): panel headers (`Sessions`, `Skills`, `Sub-agents`, `Events`), one per panel, paired with the panel icon.
- **Body** (Archivo `400`, `14px`, `1.5`): the transcript dialog and readable panel content.
- **Meta** (JetBrains Mono `400`, `12px`): tool-call rows, result previews, run history, expanded JSON.
- **Label** (JetBrains Mono `400`, `11px`, `0.02em`): grid labels (`session`, `cwd`, `pid`), shortcut hints.
- **Section title** (Archivo `600`, `11px`, `0.08em`, uppercase): the small rail sub-headers.
- **Chip** (JetBrains Mono `600`, `10px`, `0.06em`): namespace/entrypoint/transport pills.

### Named rules

**The Tabular Numerals Rule.** All numeric content (durations, token counts, PIDs, timestamps, byte sizes) uses `font-variant-numeric: tabular-nums` via `font-mono`. Numbers that don't align across rows make the eye work — a "calm" violation.

**The Two-Family Rule.** Archivo + JetBrains Mono, full stop. No third family, no "elegant serif for empty states." If mono creeps into prose or Archivo into a figure column, you're decorating.

## 4. Elevation

Panes are **flat** — they sit on the window through tonal stepping (`window` → `rail` → `center` → `elevated` → `elevated-2`), not shadow. Borders are 1px `divider` hairlines.

Shadow means **genuinely lifted above the window**. The elevation set (in `tailwind.config.ts` `boxShadow`, dark-tuned):

- **`shadow-card`** — dropdowns, popovers, the session switcher, floating cards.
- **`shadow-overlay`** — centered modals (Settings, Search, Identity, ShareDialog).
- **`shadow-drawer`** — the bottom drawer (Events).
- **`shadow-slideover`** — the right slide-over (AgentDetail, detail panels).

### Named rules

**The Flat-At-Rest Rule.** Panes and rows carry no shadow at rest; hover is a half-step tonal lift to `elevated`/`elevated-2`, never a shadow. Reaching for `box-shadow` on an in-pane element means you want a clearer arrangement, not elevation.

**The Shadow-Means-Lifted Rule.** Anything with a shadow is, by definition, floating above the window. A shadow on an in-pane card/row/chip is a category error — rewrite without it.

## 5. Components (the primitive library)

All shared UI lives in **`app/components/ui/`**, built with **`tailwind-variants` (tv)** + a **`cn()`** helper (`tailwind-merge` + `clsx`). Multi-part components (Panel, the overlays) use tv **slots**; class merging avoids specificity fights. Every primitive has a co-located `*.test.tsx` and appears in the dev-only **gallery route** (`/ui-gallery`) rendered in both themes. The API sketch:

```
cn(...classes)                                          // tailwind-merge + clsx
<Button variant="accent|pill|ghost|icon" size="sm|md">  <IconButton icon label>
<Chip tone="neutral|accent|live|wrap|sdk|direct|fail">  <StatusDot state pulse>
<Avatar initials|icon size ring>                        <Readout tone>          // tabular figure
<Field label hint error><Input|Select|Textarea/></Field>   <SectionTitle>  <Tab>/<TabGroup>
<Panel><Panel.Header icon title count actions/><Panel.Body/></Panel>   <Card>
<Modal open onClose>  <SlideOver side="right">  <Drawer side="bottom">   // shared backdrop/click-out/Esc/focus-trap/reduced-motion
<Bubble author="host|peer|assistant" wide?>  <ToolCard>  <CodeBlock lang>  <SystemNotice>
<AppShell><TitleBar/><Rail side collapsible/><CenterPane/><StatusBar/></AppShell>
```

### Buttons

- **Accent** (primary action — Send): solid `accent` fill, white text, `rounded-control`, `:active` → `accent-press`, hover `brightness(1.07)`. One per context.
- **Pill** (secondary — Share, Rename): `elevated` fill, `ink-soft`, hover `elevated-2`.
- **Ghost** (tertiary — Cancel, Dismiss): transparent, `ink-faint`, hover brightens to `ink`.
- **Icon**: square icon-only button, `ink-mute`, hover `elevated` + `ink`.

Transitions are pure color/background/filter, ~150ms ease-out. No hover-scale, no bounce.

### Fields

`sunken` background, `1px divider` border, `rounded-control`, `ink` text, `ink-hush` placeholder. Focus: `accent`-tinted border + a soft `accent/16` ring (no hard glow). `Field` wraps label/hint/error around `Input`/`Select`/`Textarea`.

### Chips & status dots

- **Chip**: `elevated` background, `rounded` 6px, `ink-faint` (neutral) or a cue foreground (tinted). Never a fully-saturated solid pill.
- **StatusDot**: a `rounded-full` dot in a cue color. `live` pulses on a slow *opacity* cycle (no scale). No status → no dot.

### Panels & rows

- **Panel**: a titled region — `Panel.Header` (icon + title + optional count + right-aligned actions) over `Panel.Body`. Flat, `divider` hairline where it meets a neighbor.
- **Row** (`list-row`): transparent at rest, `rounded` 11px, hover → `elevated`, active/selected → `accent/14` wash. Tight (28–32px). The atomic scan unit.

### Overlays

One shared implementation each — **Modal** (centered), **SlideOver** (right), **Drawer** (bottom) — all with backdrop, click-out, `Esc`, focus-trap, and `prefers-reduced-motion` honoring. They replace the hand-rolled shells. Panels use `shadow-overlay`/`shadow-slideover`/`shadow-drawer` respectively; the backdrop dims the window behind.

### Chat surfaces (signature)

The center pane is a chat thread, not a log:

- **Assistant** — `elevated` bubble, `ink-soft`, left-aligned, tucked bottom-left corner (`Bubble author="assistant"`).
- **Host / Peer** — `host-bubble` (green) / `peer-bubble` (blue), white ink, right-aligned, tucked bottom-right corner.
- **Wide messages** — a bubble carrying a `CodeBlock` or `ToolCard` widens to a fixed `~48rem` (`wide`), a bit past the permission popup, never the full pane width. Text-only bubbles stay shrink-to-fit (`max-width: min(82%, 40rem)`).
- **ToolCard** — `sunken` well, `divider` border, `rounded-card`. **CodeBlock** wraps `highlight.js` in the `.hooop-code` chrome. **SystemNotice** — a centered, muted line for lifecycle events.

## 6. Do's and Don'ts

### Do

- **Do** use the six cue tokens only for *state*. If you can't name the state in one word, the color shouldn't be there.
- **Do** ration `accent`: one primary action per context. The tab/row active-wash and focus ring are the only other accent uses.
- **Do** keep panes flat; hover is a half-step tonal lift, never a shadow.
- **Do** set every figure in `font-mono` with `tabular-nums`; prose and titles in `font-sans` (Archivo).
- **Do** keep rows tight and scannable; density is the trade.
- **Do** reuse the shared overlay primitives (Modal/SlideOver/Drawer) — one implementation, one behavior contract.
- **Do** author new UI as a primitive in `app/components/ui/` with a co-located test and a gallery entry, in both themes.
- **Do** reach for a semantic token (`bg-elevated`, `text-ink-mute`); never a raw hex or a bare Tailwind hue.

### Don't

- **Don't** introduce gradients-as-decoration, glowing borders, glassmorphism, or hero-metric templates (the AI-product cliché this system rejects).
- **Don't** drift into SaaS-admin shell (identical KPI cards, four-column grids, icons-only sidebars), crypto neon (electric-green glow, glitch type), or Notion warmth (off-white, pastel chips, emoji headers).
- **Don't** use a colored `border-left` stripe as an accent (forbidden by the shared design law). Emphasis is a status dot or chip, not a side stripe.
- **Don't** use gradient text (`background-clip: text`). Ever.
- **Don't** add shadows to in-pane elements. Shadow is for genuinely-lifted overlays only.
- **Don't** hand-roll a fourth button variant or a one-off modal shell. If a control doesn't fit the primitives, the affordance is wrong, not the library.
- **Don't** add a third type family, or let mono leak into prose / Archivo into a figure column.
- **Don't** animate layout properties (`width`/`height`/`top`/`left`/`margin`). Animate `opacity`/`color`/`background`/`transform`, ease-out, no bounce.
- **Don't** invent marketing empty states. Say what's missing and how to fix it — no illustrations, no "Get started" hero.
