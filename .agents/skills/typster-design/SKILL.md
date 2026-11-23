---
name: typster-design
description: Design system, aesthetic direction, and copy voice guide for all Typster frontend work. Use this skill whenever the user is building, editing, reviewing, or extending any page or component in the Typster web app — landing page, app UI, marketing sections, new routes, or any .heex template or CSS. Also trigger when the user asks about tokens, copy, components, dark mode, animations, redesign direction, or wants to add a new section, page, or design pattern. When a new design decision is made, update the relevant guide doc to keep it current.
---

# Typster Design System

Two docs to read before any frontend work:

1. **`docs/landing-redesign-guide.md`** — the current aesthetic direction: what's in bounds, what's out of bounds, the five high-leverage moves, usability guardrails, and the concrete implementation deltas. This is the *why* and *what next*.
2. **`docs/landing-style.md`** — the source of truth for every existing token, component, layout rule, motion pattern, and icon. This is the *what exists now*.

When they conflict, the redesign guide wins — it represents intent, the style doc represents current state.

**Two surfaces, one system.** The marketing landing page uses `.mk-*` classes; the authenticated app (editor, projects, settings, auth) uses `.ts-*` classes in `assets/css/_typster_ui.css` that **alias the same `--mk-*` tokens**, so dark mode and accent work for free, and reuses the landing's floating `.mk-nav` and Instrument Serif italic accent. The app's component catalog, the per-user accent system (`[data-accent]`), Shiki Typst highlighting, and the white-"paper" preview all live in the **"Product UI (`.ts-*`)"** section of `docs/landing-style.md` — read it before touching editor/projects/settings/auth.

## Aesthetic lane (internalize this)

Typster is an academic/research tool. The peer set is typst.app, Overleaf, Linear, distill.pub — not consumer SaaS, not Framer templates, not Web3.

The page must read as *trustworthy enough to commit a dissertation to* before it reads as cool.

**In bounds:** display-serif italic + grotesk pairing, tight large hero, one restrained accent, bento grid with real product screenshots, larger radii, polished dark mode, scroll-reveal fades.

**Out of bounds** (never propose by default): marquee/ticker strips, rotated stickers, brutalist hard-offset shadows, magnetic cursor, hand-drawn doodles, slang microcopy ("lock in", "no cap"), Y2K chrome, multiple competing accents, custom cursors, Lenis/scroll-jacking, emoji as primary iconography.

## Hard rules

**CSS tokens only.** Every color, shadow, and radius lives in `app.css` as a `--mk-*` variable. Hardcoded values are wrong by default.

**Both themes, always.** Every new component must work in light *and* dark. New tokens get declared in both `:root` and `[data-theme="dark"]`. Dark mode is the more striking of the two — researchers write late.

**Reach for existing components first.** `.mk-btn`, `.mk-pill`, `.mk-badge`, `.mk-alert`, `.mk-toast`, `.mk-dialog`, `.mk-feat`, `.mk-section`, and friends exist — extend before inventing. New components go into `app.css` under the `--mk-` namespace.

**Semantic color tokens exist.** Use `--mk-success`, `--mk-warning`, `--mk-error`, `--mk-info` (and their `-50`/`-bd`/`-h` variants) for any status UI — never hardcode green/red/amber. Both themes are covered.

**Spacing scale exists.** `--mk-sp-1` through `--mk-sp-24` (4px–96px). Use them in new components instead of raw pixel values.

**Accent is per-user.** The app accent is one of `indigo`(default)/`violet`/`sky`/`emerald`/`rose`, applied via `[data-accent]` on the `.ts-app` wrapper (`_accent.css` overrides `--mk-pri`/`-h`/`-50`/`-100`; dark variants use the descendant combinator). Drive accent-colored UI from `--mk-pri` (or `.ts-*` aliases) so it retints automatically — never hardcode the indigo hex. Surfaces have a third tier `--mk-bg3` beyond `--mk-bg`/`--mk-bg2`.

**No inline styles.** `style=""` is banned except for CSS custom property injection (e.g., `--i` stagger index, `--ts-icon`/`--sw` hue on tiles/swatches).

**CSS is linted.** stylelint runs on `assets/css/**` (pre-commit hook + `cd assets && bun run lint:css`). Keep new partials passing; preserve the import order in `app.css` (tokens/accent before consumers).

**No inline SVG, ever.** Never write or generate raw `<svg>` markup inside HEEx, HTML, JS, or CSS. SVGs must live **outside** as standalone `.svg` asset files and be referenced by path (`<img src>`, CSS `background`/`mask`, or a component that loads the file). Use icons by context (see `docs/landing-style.md` → Iconography): **heroicons** `<.icon name="hero-…">` for app UI; **`lucide`** via `<i data-lucide="…">` (also add to app.js `mkIconSet`; re-init with `window.mkIcons()` after LiveView patches); **`simple-icons`** for brand marks. There is no `<.mk_icon>` helper. Only when no package icon fits, add a new external `.svg` and reference it — do not paste `<svg>` into a template.

**Reduced motion is not optional.** Every animation or transition needs a `@media (prefers-reduced-motion: reduce)` counterpart. It's already wired up — keep it that way.

**Usability floor:** body text ≥ 14px, line-height ≥ 1.5, contrast ≥ 4.5:1 on body text, ≥ 3:1 on UI elements. No scroll hijacking. Every CTA reachable by keyboard.

## Copy voice: zoomer-academic

Typster copy lives at the intersection of a citation style guide and a group chat. Precise enough to earn trust, loose enough to feel human.

- **Typster is a verb.** "Just Typster it." "You've been Typstering." Let the brand act, not just sit there.
- **Dry wit over hype.** No exclamation marks in body copy. Deadpan > cheerful.
- **Real terms, casual delivery.** Use the actual vocabulary — compile, typeset, LaTeX, diff — without the stiff formality. "compiles in ~200ms" not "renders documents with sub-200ms latency."
- **Sentence case everywhere.** Headlines, buttons, labels. All of it.
- **No corpo filler.** On sight: delete "seamlessly", "powerful", "intuitive", "robust", "world-class", "cutting-edge". Each one is a confession that you ran out of things to say.
- **Academic register, gen-z cadence.** Think: "the document compiles. you're cooked if it doesn't."

## Component inventory

| Component      | Class(es)                          | JS API                                           |
| -------------- | ---------------------------------- | ------------------------------------------------ |
| Badge          | `.mk-badge`, `.mk-badge-{variant}` | —                                                |
| Inline alert   | `.mk-alert`, `.mk-alert-{variant}` | —                                                |
| Floating toast | `.mk-toast`, `.mk-toast-stack`     | `mkToast(msg, { type, title, duration })`        |
| Dialog         | `.mk-dialog-backdrop`, `.mk-dialog`| `mkDialogOpen(el)` / `mkDialogClose(el)`         |

Toast returns a dismiss function. Duration `0` = persistent. Type: `default` | `success` | `warning` | `error` | `info`.
Dialog titles support `<em>` for Instrument Serif italic — consistent with hero and auth card.

**Product UI (`.ts-*`).** App-side primitives in `_typster_ui.css`: `.ts-serif` (serif accent), `.ts-seg` (segmented control), `.ts-pill` (status pill), `.ts-window`/`.ts-formatbar`/`.ts-outline`/`.ts-statusbar` (editor chrome), `.ts-project-icon`, `.ts-swatch`, `.ts-emptystate`, `.ts-card--action`, `.ts-prefrow`. Full table + behavior in `docs/landing-style.md` → "Product UI (`.ts-*`)". Extend these before inventing app components.

**Editor (CodeMirror) caveat.** Typst highlighting is Shiki-based decorations (`typst_highlight.js`); all CodeMirror imports must resolve to a **single** `@codemirror/view`/`state` instance (editor.js composes `basicSetup` from granular `@codemirror/*` packages, not the `codemirror` meta-package) or decorations and keymaps silently break. A proper `codemirror-lang-typst` Lezer grammar is a tracked README roadmap item. Find & replace uses a **custom panel** (`.ts-cm-search`, `cm_search_panel.js` via `search({ createPanel })`) — token-styled icon toggles (`Aa`/`.*`/whole-word), a live match count, and a labelled Select all / Replace all — opened by the format-bar Find button (`cmd: "search"`) or ⌘F. Don't reintroduce CodeMirror's default search panel.

## Updating the guides

When a design decision extends or changes the system — new token, new component pattern, new copy rule, aesthetic shift — update the relevant doc:
- Changes to existing tokens/components (landing `.mk-*` or app `.ts-*`) → `docs/landing-style.md` (app primitives live in its "Product UI (`.ts-*`)" section)
- Changes to direction, aesthetic rules, or what's in/out of bounds → `docs/landing-redesign-guide.md`

The docs must stay in sync with the codebase, not lag behind it.
