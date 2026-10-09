// Typst syntax highlighting for CodeMirror via Shiki's official Typst
// TextMate grammar (VS Code quality). We tokenize with Shiki and paint the
// tokens as CodeMirror decorations from a ViewPlugin — there is no mature
// Lezer Typst grammar yet (see README roadmap for `codemirror-lang-typst`).
//
// The JavaScript regex engine is used on purpose so we do not ship Shiki's
// oniguruma WASM (the app already carries the Typst compiler WASM).
//
// NOTE: `@codemirror/view` must resolve to a single instance shared with
// editor.js (which imports `EditorView` from "@codemirror/view", not
// "codemirror") — otherwise the decoration facet identity differs and CM
// silently drops these decorations.
import { Decoration, ViewPlugin } from "@codemirror/view"
import { RangeSetBuilder, StateEffect } from "@codemirror/state"
import { createHighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import typstLang from "@shikijs/langs/typst"
import githubLight from "@shikijs/themes/github-light"
import githubDark from "@shikijs/themes/github-dark"

// The grammar lets comments nest inside a `//` line comment; under the
// JavaScript regex engine a second `//` on the same line (`// a // b`) then
// opens a nested comment that never closes and paints the rest of the file
// grey. Nothing inside a line comment needs sub-tokens, so drop them.
function withoutNestedLineComments(lang) {
  const copy = JSON.parse(JSON.stringify(lang))
  const walk = (node) => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.name === "comment.line.double-slash.typst") delete node.patterns
    for (const key of Object.keys(node)) walk(node[key])
  }
  walk(copy)
  return copy
}

const LIGHT_THEME = "github-light"
const DARK_THEME = "github-dark"
const MAX_CHARS = 200_000 // skip highlighting for very large documents

// Dispatch this (from editor theme switches / highlighter-ready) to force a recolor.
export const setTypstTheme = StateEffect.define()

// Shared, lazily-created highlighter. Shiki creation is async; tokenizing is
// sync once ready.
let highlighter = null
let highlighterPromise = null

function ensureHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubLight, githubDark],
      langs: [withoutNestedLineComments(typstLang)],
      engine: createJavaScriptRegexEngine({ forgiving: true })
    })
      .then((hl) => {
        highlighter = hl
        return hl
      })
      .catch((error) => {
        console.error("Failed to init Typst highlighter:", error)
        return null
      })
  }
  return highlighterPromise
}

function currentTheme() {
  const theme = document.documentElement.getAttribute("data-theme")
  if (theme === "dark") return DARK_THEME
  if (theme === "light") return LIGHT_THEME
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? DARK_THEME : LIGHT_THEME
}

// Compose an inline style from a Shiki token's color + fontStyle bitmask
// (1 = italic, 2 = bold, 4 = underline).
function tokenStyle(token) {
  const parts = []
  if (token.color) parts.push(`color:${token.color}`)
  const fs = token.fontStyle
  if (fs & 1) parts.push("font-style:italic")
  if (fs & 2) parts.push("font-weight:600")
  if (fs & 4) parts.push("text-decoration:underline")
  return parts.join(";")
}

function buildDecorations(state) {
  if (!highlighter) return Decoration.none

  const code = state.doc.toString()
  if (code.length === 0 || code.length > MAX_CHARS) return Decoration.none

  let result
  try {
    result = highlighter.codeToTokens(code, { lang: "typst", theme: currentTheme() })
  } catch (_error) {
    return Decoration.none
  }

  const builder = new RangeSetBuilder()
  let pos = 0
  for (const line of result.tokens) {
    for (const token of line) {
      const from = pos
      const to = pos + token.content.length
      const style = tokenStyle(token)
      if (to > from && style && /\S/.test(token.content)) {
        builder.add(from, to, Decoration.mark({ attributes: { style } }))
      }
      pos = to
    }
    pos += 1 // newline between lines
  }
  return builder.finish()
}

// A ViewPlugin owns the decorations and rebuilds them on doc/theme changes.
// (Provided as a top-level extension; a StateField's decoration `provide` did
// not paint here, and a ViewPlugin nested in a compartment never constructs.)
const typstHighlightPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view.state)
    }

    update(update) {
      const themeChanged = update.transactions.some((tr) =>
        tr.effects.some((effect) => effect.is(setTypstTheme))
      )
      if (update.docChanged || themeChanged) {
        // CM reads the `decorations` getter right after update(), so a
        // synchronous rebuild is enough — no extra dispatch (which would loop).
        this.decorations = buildDecorations(update.view.state)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

// Called by editor.js right after the EditorView is created for a Typst file:
// kicks off async highlighter init and repaints once it's ready.
export function registerTypstView(view) {
  ensureHighlighter().then(() => {
    if (highlighter && view.dom.isConnected) {
      view.dispatch({ effects: setTypstTheme.of(null) })
    }
  })
}

export function typst() {
  return [typstHighlightPlugin]
}
