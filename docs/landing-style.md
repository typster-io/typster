# Landing Page Style Guide

Design language for the Typster marketing landing page (`/`). All tokens
live in `assets/css/app.css`; component markup is split between
`lib/typster_web/components/layouts/marketing.html.heex` (shell + nav)
and `lib/typster_web/controllers/page_html/home.html.heex` (sections).

## Theming

Two themes selected via `data-theme` on `<html>` (`light` default, `dark`
opt-in). User preference is stored in `localStorage["phx:theme"]` and
applied by the head bootstrap before the stylesheet loads, preventing
theme flash on first paint. Theme toggle uses the View Transitions API
for a circular reveal centered on the toggle button.

```html
<html data-theme="dark">
```

Both `:root` and `[data-theme="dark"]` define all `--mk-*` color/shadow
tokens, so any component using those variables gets dark-mode adaptation
automatically without per-component overrides.

## Color tokens

Defined as CSS custom properties on `:root` (light) and overridden under
`[data-theme="dark"]`.

### Brand
| Token            | Light       | Dark        | Usage                       |
| ---------------- | ----------- | ----------- | --------------------------- |
| `--mk-pri`       | `#4f46e5`   | `#6366f1`   | Primary CTA, brand mark     |
| `--mk-pri-h`     | `#4338ca`   | `#4f46e5`   | Primary hover               |
| `--mk-pri-50`    | `#eef2ff`   | rgba indigo | Pill background, soft chips |
| `--mk-pri-100`   | `#e0e7ff`   |             | Pill border                 |

The brand mark (`.mk-brand-mark`) fills its tile with an accent-aware
diagonal gradient: `135deg, var(--mk-pri) → color-mix(--mk-pri-h, #000)`.
It tracks the active accent (indigo/violet/sky/emerald/rose) and stays
visible in both themes. This is the one place — alongside the CTA band —
where the brand gradient appears; never apply it broadly.

### Neutrals
| Token         | Light       | Dark        | Usage                       |
| ------------- | ----------- | ----------- | --------------------------- |
| `--mk-fg`     | `#09090b`   | `#fafafa`   | Headings, primary text      |
| `--mk-fg2`    | `#3f3f46`   | `#d4d4d8`   | Body, secondary text        |
| `--mk-fg3`    | `#71717a`   | `#a1a1aa`   | Muted, captions             |
| `--mk-fg4`    | `#a1a1aa`   | `#71717a`   | Disabled, hint              |
| `--mk-bd`     | `#e4e4e7`   | `#27272a`   | Border default              |
| `--mk-bd2`    | `#f4f4f5`   | `#1f1f23`   | Surface hover, separators   |
| `--mk-bg`     | `#ffffff`   | `#0a0a0b`   | Card surface                |
| `--mk-bg2`    | `#fafafa`   | `#111114`   | Tinted section bg           |
| `--mk-bg3`    | `#f1f1f3`   | `#18181b`   | Inset surface (3rd tier)    |

### Accent theming (`[data-accent]`)
The product UI lets a user pick an accent. `_accent.css` overrides
`--mk-pri`/`-h`/`-50`/`-100` on a `[data-accent="…"]` ancestor (`indigo`
default, plus `violet`, `sky`, `emerald`, `rose`), with `[data-theme="dark"]`
descendant variants. The app applies it via `data-accent` on the `.ts-app`
wrapper from `current_scope.user.accent_color`; dark mode wins on specificity
because `data-theme` lives on `<html>` and `data-accent` on a descendant. The
focus ring (`--ring`) derives from `--mk-pri` via `color-mix`, so it retints too.

### Page background
- `html` and `body` share `#eef0f4` (light) / `#15131f` (dark) — solid
  cool-gray base. `overscroll-behavior: none` is set to remove the
  rubber-band seam between overscroll color and decorative layers.

### Accent code-token palette (mock editor)
| Class              | Color       | Token role          |
| ------------------ | ----------- | ------------------- |
| `.mk-tok-comment`  | `#71717a`   | Slash-slash comment |
| `.mk-tok-keyword`  | `#9333ea`   | `#set`, `#datetime` |
| `.mk-tok-string`   | `#16a34a`   | String literals     |
| `.mk-tok-heading`  | `#0369a1`   | `=`, `==` headings  |
| `.mk-tok-em`       | `#dc2626`   | `*bold*`, `_em_`    |

## Typography

- **Family:** `Inter` (Google Fonts, weights 100–900) with system
  fallback `system-ui, sans-serif`.
- **Base:** `14px / 1.5`, antialiased.
- **Hero h1:** clamp-style sizing, weight `700`, tight line-height,
  `<em>` rendered in brand color (no italic).
- **Section h2 (`.mk-section-h`):** large display weight on neutral fg.
- **Eyebrow (`.mk-eyebrow`):** small uppercase tracking-wide muted text
  above each section heading.
- **Mono surfaces** (mock editor source) inherit OS monospace.

## Surface treatment

Two persistent decorative layers inside `.mk-body`:

1. **Solid base color** on `html` + `body` (matches overscroll exactly).
2. **`.mk-body::after`** — fixed-position 800px-tall texture overlay:
   - SVG `feTurbulence` fractal-noise tile (240×240, baseFrequency 0.85)
   - Two `repeating-linear-gradient` brushed diagonals at 115° and 118°
   - `mix-blend-mode: multiply` (light) / `screen` (dark)
   - Linear-gradient mask fades the texture out by 800px

No corner glows, no radial gradients — the original gradient hero was
intentionally removed in favor of a calmer, brushed-silver field.

## Layout

- **Container:** `.mk-container` is centered, `max-width: ~1100px`,
  symmetric horizontal padding.
- **Sections:** `.mk-section` provides vertical rhythm with `~96px`
  padding. `.mk-section-tinted` fills with `--mk-bg2`.
- **Floating navbar (`.mk-nav`):** `position: fixed; top: 14px`, pill
  shape (`border-radius: 18px`), frosted glass via
  `backdrop-filter: blur(20px) saturate(180%)`, semi-transparent white
  fill, soft inset highlight + outer drop shadow. Adds `.is-scrolled`
  class after 16px of scroll for elevated state.

## Components

### Buttons (`.mk-btn`)
- Heights `34px` (`-sm`), `40px` (default), `48px` (`-lg`).
- `border-radius` `var(--mk-r-sm)` / `var(--mk-r)` for `-lg`.
- Variants: `-primary` (filled brand), `-light` (white on dark CTA
  band), `-outline` (border + neutral surface), `-ghost` (text-only,
  hover bg).
- Active state scales to `0.97`, transitions `120–160ms` with
  `--mk-ease-out` (`cubic-bezier(0.23, 1, 0.32, 1)`).
- Disabled (`:disabled` / `[disabled]`): `opacity 0.45`, `cursor:
  not-allowed`; hover and active states are suppressed (gated on
  `:not(:disabled)`). Used for not-yet-wired placeholders such as the
  inactive OAuth buttons in the auth card.

### Pill (`.mk-pill`)
- Small rounded chip with brand-50 fill, brand-100 border,
  brand-hover text. Used for "v1.0 · Public beta is live" tag.
- Includes a `.mk-pill-dot` 6px brand-color dot.

### Hero mockup (`.mk-art`/`.mk-mock`)
Three-pane editor mock: traffic-light bar, file sidebar, source code
with line numbers and syntax tokens, PDF preview. Shadow:
`var(--mk-sh-2xl)` (deep ambient drop). Card `border-radius` ~12px,
`border: 1px var(--mk-bd)`.

### Stats band (`.mk-stats`)
4-column grid, large numerals (`.mk-stat-n`), muted labels. Numerals
mix solid weight with `<span>`-wrapped suffixes for hierarchy
(e.g. `2,400`, `~200ms`).

### How-it-works (`.mk-hiw-steps`)
3 columns, each step with monospace `01/02/03` numeral, title, copy.

### Feature grid (`.mk-feat-grid`)
3×2 cards (`.mk-feat`), each with `.mk-feat-icon` (40px square in
brand-50 fill, brand-color stroke, 20px SVG inside).

### Keyboard band (`.mk-kb-band`)
2-column grid of shortcut rows; `<kbd class="mk-kb-key">` chips for
keys with subtle shadow + border.

### Snippet switcher (`.mk-demo-section`)
Tab bar (`.mk-demo-tab`) over a fixed-height (`420px`) split panel
showing source ↔ rendered PDF side-by-side. JS `mkSwitchTab` toggles
`.is-active` between panels; height is fixed to prevent layout jumps.

### Use cases (`.mk-usecase-grid`)
5 cards with emoji icons and short copy. Looser, more conversational
section.

### Pricing (`.mk-price-grid`)
3 columns. Featured tier (`.mk-price-featured`) gains a "Most popular"
flag, brand-tinted border, and bolder shadow.

### FAQ (`.mk-faq`)
Native `<details>` accordion, custom `+`/`−` icon, hairline borders,
generous vertical padding.

### Badge / Status chip (`.mk-badge`)

Small inline status label. Pill-shaped by default.

```html
<span class="mk-badge mk-badge-success">
  <span class="mk-badge-dot"></span> Published
</span>
```

- **Base:** `.mk-badge` — pill, `11px`, 500 weight, 1px border.
- **Sizes:** `.mk-badge-sm` (10px), `.mk-badge-lg` (12px).
- **`.mk-badge-dot`** — 5px dot in `currentColor` for live-indicator patterns.
- **Variants:** `-default`, `-primary`, `-accent`, `-success`, `-warning`, `-error`, `-info`.
  All variants use semantic `--mk-*-50` background, full color for text, `--mk-*-bd` border.

### Inline alert (`.mk-alert`)

Full-width informational block. Reaches for `.mk-r` radius and semantic colors.

```html
<div class="mk-alert mk-alert-warning">
  <span class="mk-alert-icon"><!-- SVG --></span>
  <div class="mk-alert-body">
    <span class="mk-alert-title">Draft saved</span>
    Your changes were queued — compile to publish.
  </div>
</div>
```

- **Base:** `.mk-alert` — flex, 14px body, 16px icon slot.
- **`.mk-alert-title`** — 600 weight, 13px, renders in `currentColor`.
- **Variants:** `-default`, `-info`, `-success`, `-warning`, `-error`.

### Floating notifications (`.mk-toast`)

Stacked, auto-dismissing toasts anchored bottom-right. Created via JS — no markup needed.

**JS API:**
```js
// basic
mkToast('Document compiled.', { type: 'success' })

// with title + custom duration
mkToast('Sync failed — check your connection.', {
  type: 'error',
  title: 'Export error',
  duration: 6000,      // ms; 0 = persistent
})

// returns dismiss fn
const close = mkToast('Processing…', { type: 'info', duration: 0 })
close() // call to dismiss
```

- **`type`:** `'default'` | `'success'` | `'warning'` | `'error'` | `'info'`
- **Appearance:** frosted glass (`backdrop-filter`), matches nav style, semantic left-border accent.
- **`mk-toast-progress`** — 2px bottom bar that depletes over `duration`; hidden when `prefers-reduced-motion`.
- **Stack:** `.mk-toast-stack` is appended to `<body>` on first call; `aria-live="polite"` for screen readers.
- Respects `prefers-reduced-motion` — animations disabled.

### Dialog / Modal (`.mk-dialog`)

Centered overlay for confirmations, forms, detail views.

```html
<div class="mk-dialog-backdrop" id="my-dialog" style="display:none" data-dismiss-on-backdrop>
  <div class="mk-dialog">
    <div class="mk-dialog-head">
      <h2 class="mk-dialog-title">Delete <em>document</em></h2>
      <button class="mk-dialog-close" onclick="mkDialogClose(this.closest('.mk-dialog-backdrop'))">
        <!-- X SVG -->
      </button>
    </div>
    <p class="mk-dialog-sub">This can't be undone.</p>
    <div class="mk-dialog-body">…</div>
    <div class="mk-dialog-footer">
      <button class="mk-btn mk-btn-outline" onclick="mkDialogClose(document.getElementById('my-dialog'))">Cancel</button>
      <button class="mk-btn mk-btn-primary">Delete</button>
    </div>
  </div>
</div>
```

**JS helpers:**
```js
mkDialogOpen(document.getElementById('my-dialog'))
mkDialogClose(document.getElementById('my-dialog'))
```

- **Base backdrop:** `.mk-dialog-backdrop` — fixed, blurred overlay, flex-centered.
- **Sizes:** `.mk-dialog-sm` (360px), default (480px), `.mk-dialog-lg` (640px), `.mk-dialog-xl` (800px).
- **`data-dismiss-on-backdrop`** — clicking the backdrop closes the dialog.
- **Title `<em>`** renders in Instrument Serif italic + `--mk-pri`, matching the hero/auth pattern.
- **`.mk-dialog-footer`** — right-aligned actions; `.mk-dialog-footer-left` for left-aligned.
- **`.mk-dialog-danger`** — danger variant: error-colored title.
- Mobile: bottom-sheet slide-up (full width, square bottom corners).

### CTA band (`.mk-cta-band`)
Full-width brand-color block with white headline + light button.

### Footer (`.mk-foot`)
4-column layout: brand block + 3 link columns. Compact bottom row with
copyright and tagline.

## Product UI (`.ts-*`)

The authenticated app (editor, projects, settings) uses a `.ts-*` class system
in `_typster_ui.css`, aliasing the `--mk-*` tokens (so dark mode + accent come
for free). It reuses the landing's floating `.mk-nav` and the Instrument Serif
italic accent. Key shared primitives added with the product-UI redesign:

| Class             | Role                                                      |
| ----------------- | --------------------------------------------------------- |
| `.ts-serif`       | Instrument Serif italic accent (mirrors landing `<em>`)   |
| `.ts-seg`         | Segmented control (theme/filter switches)                 |
| `.ts-pill`        | Status pill (`--accent`/`--success`/`--error` variants)   |
| `.ts-window`      | Rounded chrome wrapping the 3-pane editor                 |
| `.ts-formatbar`   | WYSIWYG formatting toolbar row (separate from tabs)        |
| `.ts-outline`     | Live document outline (parsed headings); pinned to the sidebar foot in `.ts-side__outline`, the heading under the cursor gets `.is-active` |
| `.ts-side__find`  | Flat "Find file ⌘P" row at the top of the sidebar that opens the palette |
| `.ts-tree__badge` | Red error count on a file row (from compile diagnostics)  |
| `.ts-tree__dir--assets` | Virtual `assets/` folder row: a toggle button plus the upload label |
| `.ts-side__foot`  | Pinned "Upload file" row under the outline: opens the picker for every file type the project takes and auto-uploads; the sidebar is the file drop target and lights up via `.phx-drop-target-active`; hidden under 600px of height |
| `_editor_compact.css` | Viewport fit: `.ts-app` is clipped so the editor never scrolls as a page (only the sidebar lists, CodeMirror, preview and drawer body scroll); the chrome tightens under 760px and again under 600px of height |
| `.ts-statusbar`   | Editor status bar (Ln/Col, language, ⌘K hint)             |
| `.ts-project-icon`| Serif-italic project initial tile (`--ts-icon` hue)       |
| `.ts-swatch`      | Settings accent swatch (`--sw` hue)                       |
| `.ts-emptystate`  | Serif "blank page" empty state                            |
| `.ts-card--action`| Clickable action card (templates / import), `.ts-cards` row |
| `.ts-dragghost`   | Drag image for a sidebar row: chip, name, snippet to insert |
| `.ts-prefrow`     | Settings preference row (label + control)                 |
| `.ts-cm-search`   | Custom CodeMirror find & replace panel (`_codemirror.css`) |

### Find & replace panel (`.ts-cm-search`)
Custom CodeMirror search panel supplied by `cm_search_panel.js` via
`search({ createPanel })`, replacing CM's stock panel. A find row (input +
live match count "3 of 12"/"No results"/"Invalid regex", `Aa`/`.*`/whole-word
icon toggles with an `.is-active` accent state, ↑/↓ nav, a labelled "Select
all", close) over a separated replace row ("Replace" / "Replace all"). Every
control has a `title` + `aria-label`. Styled entirely from tokens in
`_codemirror.css` (no JS colors), so light/dark/accent are free. Opened via the
format-bar Find button (`<i data-lucide="search">`, `cmd: "search"` →
`editorInstance.openSearch()`) or ⌘F. Behaviour comes from the official
`@codemirror/search` commands; action buttons flush the debounced query first.

Formatting-toolbar glyphs use `lucide` (`data-lucide`, re-init via
`window.mkIcons` on LiveView patches); brand marks use `simple-icons`;
everything else uses heroicons `<.icon name="hero-…">`.

### Typst syntax highlighting (`typst_highlight.js`)

The CodeMirror editor highlights Typst with **Shiki's official Typst TextMate
grammar** (VS Code quality), painted as CodeMirror decorations — there is no
mature Lezer Typst grammar yet (`codemirror-lang-typst` is on the README
roadmap). It uses Shiki's **JavaScript regex engine** (`forgiving: true`, no
extra oniguruma WASM) and the `github-light` / `github-dark` themes, swapping on
theme change. Markup (`*bold*` / `_emph_`), `#` code, and `$ $` math are all
distinguished.

**Editor-CodeMirror caveat:** all CodeMirror imports must resolve to a *single*
`@codemirror/view` / `@codemirror/state` instance (editor.js builds `basicSetup`
from granular `@codemirror/*` packages, not the `codemirror` meta-package, and
the lockfile pins one `@codemirror/view`). A second copy makes the decoration
facet identity mismatch and CM silently drops Typst highlighting *and* keymaps.

### Preview "paper" (`#typst-svg-output`)

Compiled Typst renders to a transparent SVG with black glyphs. It is placed on a
white "paper" card (shadow, centered, scales to width) so the document stays
readable in **both** themes — the UI theme never tints the page, matching
Overleaf / typst.app.

## Motion

- **Scroll-revealed elements:** any node with `.mk-reveal` (or children
  of `.mk-reveal-group`) starts hidden (`opacity 0`, `translateY 12px`)
  and animates in on `IntersectionObserver` intersection. Group children
  receive a `--i` index var for staggered delay.
- **Theme transition (pour):** the toggle button "pours" the next theme
  into the page. A round-shaped `clip-path` reveal grows from the
  button's center on `::view-transition-new(root)` (760ms,
  `cubic-bezier(.65, 0, .15, 1)`) and drifts ~14px downward so it reads
  as liquid spreading by gravity rather than a flat ripple. Only the
  new layer is animated — the outgoing layer is left static so its
  edges don't expose the incoming color as a stray border. While the
  pour is in flight, the toggle gains `.is-pouring` and tilts like a
  teapot (`@keyframes mk-pour-tilt`); a `__mkPouring` flag suppresses
  re-entry until the transition resolves.
- **Easing curves:**
  - `--mk-ease`: `cubic-bezier(.4, 0, .2, 1)` (standard)
  - `--mk-ease-out`: `cubic-bezier(0.23, 1, 0.32, 1)` (overshoot-out)
  - `--mk-ease-in-out`: `cubic-bezier(0.77, 0, 0.175, 1)` (deep)
- All motion respects `@media (prefers-reduced-motion: reduce)`.

## Iconography

Three sources, by context — search them before inventing a mark:

- **App UI (heroicons):** `<.icon name="hero-…" class="size-…"/>` from
  `core_components.ex`. Rendered as a masked `<span>` — no JS init needed. Use
  this for almost everything in the `.ts-*` app.
- **`lucide` (glyphs heroicons lacks):** `<i data-lucide="bold">` upgraded to
  `<svg>` by `window.mkIcons()` (app.js `createIcons` over a curated
  `mkIconSet`). `mkIcons()` runs on `phx:page-loading-stop` and is re-invoked
  from hooks on LiveView patches — any icon added by name to a template must
  also be added to `mkIconSet`. Used by the editor formatting toolbar
  (bold/italic/heading/list/sigma/link/table/image).
- **`simple-icons` (brand marks):** e.g. `siGithub`, `siGoogle`, registered in
  app.js `mkIconSet` and rendered via `data-lucide="github"`. Used for OAuth
  buttons.

**No inline SVG, ever:** never write or generate raw `<svg>` markup inside HEEx,
HTML, JS, or CSS. SVGs must be stored **outside** as standalone `.svg` asset
files and referenced by path (`<img src>`, CSS `background`/`mask`, or a
component that loads the file). When no package icon fits, add a new external
`.svg` and reference it — do not paste the markup into a template. (There is no
`<.mk_icon>` helper or `priv/static/images/icons/`.)

## Semantic color tokens

Added to `:root` (light) and `[data-theme="dark"]` alongside the brand tokens.

| Token family       | Light (hex)  | Dark (rgba/hex)               | Usage                    |
| ------------------ | ------------ | ----------------------------- | ------------------------ |
| `--mk-success`     | `#16a34a`    | `#4ade80`                     | Confirmations, saves     |
| `--mk-success-50`  | `#f0fdf4`    | `rgba(74,222,128,.12)`        | Badge/alert background   |
| `--mk-success-bd`  | `#bbf7d0`    | `rgba(74,222,128,.28)`        | Badge/alert border       |
| `--mk-warning`     | `#d97706`    | `#fbbf24`                     | Caution, beta flags      |
| `--mk-warning-50`  | `#fffbeb`    | `rgba(251,191,36,.12)`        | Badge/alert background   |
| `--mk-warning-bd`  | `#fde68a`    | `rgba(251,191,36,.28)`        | Badge/alert border       |
| `--mk-error`       | `#dc2626`    | `#f87171`                     | Errors, destructive      |
| `--mk-error-50`    | `#fef2f2`    | `rgba(248,113,113,.12)`       | Badge/alert background   |
| `--mk-error-bd`    | `#fecaca`    | `rgba(248,113,113,.28)`       | Badge/alert border       |
| `--mk-info`        | `#0369a1`    | `#38bdf8`                     | Informational            |
| `--mk-info-50`     | `#f0f9ff`    | `rgba(56,189,248,.12)`        | Badge/alert background   |
| `--mk-info-bd`     | `#bae6fd`    | `rgba(56,189,248,.28)`        | Badge/alert border       |

## Spacing scale

Defined as `--mk-sp-*` on `:root` for consistent spacing across components.

| Token        | Value  |
| ------------ | ------ |
| `--mk-sp-1`  | `4px`  |
| `--mk-sp-2`  | `8px`  |
| `--mk-sp-3`  | `12px` |
| `--mk-sp-4`  | `16px` |
| `--mk-sp-5`  | `20px` |
| `--mk-sp-6`  | `24px` |
| `--mk-sp-8`  | `32px` |
| `--mk-sp-10` | `40px` |
| `--mk-sp-12` | `48px` |
| `--mk-sp-16` | `64px` |
| `--mk-sp-24` | `96px` |

## Shadows

| Token             | Use                                     |
| ----------------- | --------------------------------------- |
| `--mk-sh-sm`      | Subtle (kbd chips, small chips)         |
| `--mk-sh-md`      | Cards, mid-elevation surfaces           |
| `--mk-sh-lg`      | Pricing cards, raised surfaces          |
| `--mk-sh-2xl`     | Hero editor mock, max elevation         |

## Radii

| Token         | Value      | Use                          |
| ------------- | ---------- | ---------------------------- |
| `--mk-r-sm`   | `0.375rem` | Buttons, small chips         |
| `--mk-r`      | `0.5rem`   | Cards, large buttons, mocks  |
| (literal 18px)|            | Floating navbar              |

## Accessibility

- `color-scheme: light/dark` declared on `<html>` so native form
  controls and scrollbars match the active theme.
- All interactive elements maintain visible focus rings via UA defaults
  + the `:focus-visible` polyfill behavior.
- Reduced-motion users get static gradients and instant theme switches.

## Static preview

`preview-export/index.html` is a self-contained snapshot of the page
(no Phoenix runtime needed) for design review. It bundles a copy of
the compiled `app.css`. Open it directly in a browser.
