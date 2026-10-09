// Built from granular @codemirror/* packages (not the `codemirror` meta-package)
// so the EditorView, keymaps, and decorations all share one instance set — the
// meta-package bundled a second @codemirror/view/state copy, which made
// decoration-facet identity mismatch and silently dropped Typst highlighting.
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  dropCursor,
  highlightActiveLine,
  Decoration,
  ViewPlugin,
  WidgetType
} from "@codemirror/view"
import { EditorState, Compartment } from "@codemirror/state"
import {
  StreamLanguage,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldKeymap
} from "@codemirror/language"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search"
import { searchPanelExtensions } from "./cm_search_panel"
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap
} from "@codemirror/autocomplete"
import { lintKeymap, lintGutter, setDiagnostics } from "@codemirror/lint"
import { typst, setTypstTheme, registerTypstView } from "./typst_highlight"
import { markdown } from "@codemirror/lang-markdown"
import { yaml } from "@codemirror/lang-yaml"
import { stex } from "@codemirror/legacy-modes/mode/stex"
import { compileTypst, downloadTypstPdf } from "./typst_worker"
import { editorV3Extensions, setDiagData } from "./editor_v3"
import { typstCompletionSource } from "./typst_completions"
import { createCollab } from "./collab"

// Native selection paints nothing visible for a selected trailing newline (an
// empty line shows nothing, a text line ends right at the glyphs). VS Code draws
// a small block at the line's end to show the break is selected. We do the same
// on every line whose newline is in the selection — including blank lines.
//
// The marker is an inline span holding a transparent non-breaking space: its
// *background* therefore paints the exact same inline content box the browser
// uses for ::selection on that line, so it matches the selection band's height
// and per-line rounding pixel-for-pixel (a fixed-size box never could).
class EolMarkWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const span = document.createElement("span")
    span.className = "cm-eol-mark"
    span.textContent = " "
    span.setAttribute("aria-hidden", "true")
    return span
  }
  ignoreEvent() {
    return true
  }
}
const eolSelectionMark = Decoration.widget({ widget: new EolMarkWidget(), side: 1 })

const eolSelection = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view)
    }
    update(u) {
      // Deliberately not on geometryChanged: the marker must not feed back into
      // layout (it's out of flow), and reacting to geometry would flicker.
      if (u.selectionSet || u.docChanged || u.viewportChanged)
        this.decorations = this.build(u.view)
    }
    build(view) {
      const seen = new Set()
      const deco = []
      for (const range of view.state.selection.ranges) {
        if (range.empty) continue
        for (const vr of view.visibleRanges) {
          let pos = Math.max(vr.from, range.from)
          const end = Math.min(vr.to, range.to)
          while (pos <= end) {
            const line = view.state.doc.lineAt(pos)
            // line.to < range.to ⇒ this line's newline is inside the selection.
            if (line.to < range.to && !seen.has(line.to)) {
              seen.add(line.to)
              deco.push(eolSelectionMark.range(line.to))
            }
            pos = line.to + 1
          }
        }
      }
      deco.sort((a, b) => a.from - b.from)
      return Decoration.set(deco)
    }
  },
  { decorations: (v) => v.decorations }
)

// Equivalent of `codemirror`'s `basicSetup`, assembled from granular packages.
const basicSetup = [
  eolSelection,
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  // No drawSelection(): its custom selection layer extends a selected newline
  // to the full editor width (a giant bar) and mis-measures single glyphs.
  // Native browser selection hugs the text and shows the newline as a small
  // trailing mark — styled via `::selection` in _codemirror.css.
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  // autocompletion() is added per-editor below so its source can be Typst-aware.
  highlightActiveLine(),
  // Don't spray match boxes for 1-char selections (every `i`/`2` lit up).
  highlightSelectionMatches({ minSelectionLength: 2 }),
  ...searchPanelExtensions,
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap
  ])
]

// Typst-aware auto-closing pairs for `closeBrackets()`: the usual brackets plus
// `$ $` for math mode. Single-quote is intentionally dropped so apostrophes in
// prose ("it's") aren't auto-paired. Provided as languageData so closeBrackets
// picks it up only for Typst buffers.
const typstCloseBrackets = EditorState.languageData.of(() => [
  { closeBrackets: { brackets: ["(", "[", "{", "$", "\"", "`"] } }
])

// Auto-recompile debounce (ms from the last keystroke). Configurable via
// localStorage so a single keystroke doesn't thrash the WASM compiler; a
// negative value disables auto-compile (manual ⌘↵ / Compile only).
export const DEFAULT_COMPILE_DELAY = 700

export function compileDelay() {
  try {
    const raw = localStorage.getItem("typster:compile_delay")
    if (raw === null) return DEFAULT_COMPILE_DELAY
    const v = parseInt(raw, 10)
    return Number.isFinite(v) ? v : DEFAULT_COMPILE_DELAY
  } catch (_e) {
    return DEFAULT_COMPILE_DELAY
  }
}

function getCurrentTheme() {
  const html = document.documentElement
  const theme = html.getAttribute("data-theme")
  if (theme === "dark") return "dark"
  if (theme === "light") return "light"
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  return prefersDark ? "dark" : "light"
}

const lightTheme = EditorView.theme({
  "&": {
    backgroundColor: "#ffffff",
    color: "#09090b",
    fontSize: "14px",
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
  },
  ".cm-content": {
    padding: "16px",
    minHeight: "100%",
    lineHeight: "1.6",
    caretColor: "#09090b",
    // Ligatures (=>, !=, ->) skew per-char coordinate measurement; disable them.
    fontVariantLigatures: "none"
  },
  ".cm-focused": { outline: "none" },
  ".cm-editor": { height: "100%" },
  ".cm-scroller": {
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
  },
  ".cm-gutters": { backgroundColor: "#f4f4f5", color: "#a1a1aa", border: "none" },
  // Reserve room for 5 digits (≤ 99999), right-aligned; CM auto-grows past that.
  // box-sizing is border-box, so add the horizontal padding into the floor.
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "calc(5ch + 24px)",
    padding: "0 8px 0 16px",
    textAlign: "right"
  },
  ".cm-activeLine": { backgroundColor: "rgba(9, 9, 11, 0.045)" },
  ".cm-activeLineGutter": { backgroundColor: "#ececee", color: "#09090b" },
  // Match highlights use a neutral bordered box so they read as "other
  // occurrences", distinct from the (indigo) native ::selection.
  ".cm-selectionMatch": {
    backgroundColor: "rgba(9, 9, 11, 0.06)",
    outline: "1px solid rgba(9, 9, 11, 0.28)",
    borderRadius: "2px"
  }
})

const darkTheme = EditorView.theme({
  "&": {
    backgroundColor: "#09090b",
    color: "#fafafa",
    fontSize: "14px",
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
  },
  ".cm-content": {
    padding: "16px",
    minHeight: "100%",
    lineHeight: "1.6",
    caretColor: "#fafafa",
    fontVariantLigatures: "none"
  },
  ".cm-focused": { outline: "none" },
  ".cm-editor": { height: "100%" },
  ".cm-scroller": {
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
  },
  ".cm-gutters": { backgroundColor: "#18181b", color: "#71717a", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "calc(5ch + 24px)",
    padding: "0 8px 0 16px",
    textAlign: "right"
  },
  ".cm-activeLine": { backgroundColor: "rgba(250, 250, 250, 0.06)" },
  ".cm-activeLineGutter": { backgroundColor: "#27272a", color: "#fafafa" },
  ".cm-selectionMatch": {
    backgroundColor: "rgba(250, 250, 250, 0.10)",
    outline: "1px solid rgba(250, 250, 250, 0.35)",
    borderRadius: "2px"
  }
})

function getThemeExtension() {
  return getCurrentTheme() === "dark" ? darkTheme : lightTheme
}

// ── Formatting commands ─────────────────────────────────────────────────────
// Markers are language-aware: Typst uses *bold* _italic_, Markdown uses
// **bold** *italic*. Everything funnels through `runCommand`.
const MARKERS = {
  typst: {
    bold: ["*", "*"],
    italic: ["_", "_"],
    math: ["$ ", " $"],
    heading: { line: "= " },
    list: { line: "- " },
    link: { snippet: '#link("https://")[text]', placeholder: "text" },
    image: { snippet: '#image("image.png")' },
    table: { snippet: "#table(\n  columns: 2,\n  [a], [b],\n)" }
  },
  markdown: {
    bold: ["**", "**"],
    italic: ["*", "*"],
    math: ["$", "$"],
    heading: { line: "# " },
    list: { line: "- " },
    link: { snippet: "[text](https://)", placeholder: "text" },
    image: { snippet: "![](image.png)" },
    table: { snippet: "| a | b |\n| --- | --- |\n| 1 | 2 |" }
  }
}

function markersFor(language) {
  return MARKERS[language] || MARKERS.typst
}

function wrapSelection(view, before, after) {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + selected.length }
  })
  view.focus()
}

function prefixLine(view, prefix) {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  view.dispatch({
    changes: { from: line.from, insert: prefix },
    selection: { anchor: view.state.selection.main.head + prefix.length }
  })
  view.focus()
}

function insertSnippet(view, snippet, placeholder) {
  const { from, to } = view.state.selection.main
  view.dispatch({ changes: { from, to, insert: snippet } })

  if (placeholder) {
    const idx = snippet.indexOf(placeholder)
    if (idx >= 0) {
      view.dispatch({
        selection: { anchor: from + idx, head: from + idx + placeholder.length }
      })
    }
  }
  view.focus()
}

function gotoLine(view, lineNumber, column) {
  const total = view.state.doc.lines
  const n = Math.min(Math.max(parseInt(lineNumber, 10) || 1, 1), total)
  const line = view.state.doc.line(n)
  const col = Math.max(parseInt(column, 10) || 1, 1) - 1
  const anchor = Math.min(line.from + col, line.to)
  view.dispatch({ selection: { anchor }, scrollIntoView: true })
  view.focus()
}

function runEditorCommand(view, language, cmd, arg = {}) {
  const m = markersFor(language)
  switch (cmd) {
    case "bold":
    case "italic":
    case "math":
      wrapSelection(view, m[cmd][0], m[cmd][1])
      break
    case "heading":
    case "list":
      prefixLine(view, m[cmd].line)
      break
    case "link":
    case "image":
    case "table":
      insertSnippet(view, m[cmd].snippet, m[cmd].placeholder)
      break
    case "goto":
      gotoLine(view, arg.line, arg.col)
      break
    default:
      break
  }
}

// Parse headings into an outline. Typst headings start with `=`, Markdown `#`.
function parseOutline(content, language) {
  const re = language === "markdown" ? /^(#{1,6})\s+(.+?)\s*$/ : /^(={1,6})\s+(.+?)\s*$/
  const items = []
  content.split("\n").forEach((text, i) => {
    const match = re.exec(text)
    if (match) {
      items.push({
        level: Math.min(match[1].length, 3),
        text: match[2].replace(/[*_`]/g, ""),
        line: i + 1
      })
    }
  })
  return items
}

function cursorPosition(state) {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return { line: line.number, col: head - line.from + 1 }
}

function getLanguageExtension(lang) {
  switch (lang) {
    // Typst highlighting is a top-level extension (a StateField whose `provide`
    // does not apply from inside a reconfigurable compartment), not a language.
    case "typst":    return []
    case "markdown": return markdown()
    case "yaml":     return yaml()
    case "latex":
    case "tex":      return StreamLanguage.define(stex)
    default:         return []
  }
}

// Convert Typst diagnostics (1-based line/col, optional end) into CodeMirror
// lint diagnostics with absolute from/to offsets, clamped to the document.
function toCmDiagnostics(view, diags) {
  const doc = view.state.doc

  const offset = (line, col) => {
    const n = Math.min(Math.max(line || 1, 1), doc.lines)
    const l = doc.line(n)
    return Math.min(l.from + Math.max((col || 1) - 1, 0), l.to)
  }

  return (diags || [])
    .filter((d) => d.location && d.location.line != null)
    .map((d) => {
      const loc = d.location
      const from = offset(loc.line, loc.col)
      let to = loc.endLine != null ? offset(loc.endLine, loc.endCol) : from
      if (to <= from) {
        const l = doc.line(Math.min(Math.max(loc.line, 1), doc.lines))
        to = Math.min(l.to, from + 1)
      }
      return {
        from,
        to,
        severity: d.severity === "warning" ? "warning" : "error",
        message: d.message || "Compilation error"
      }
    })
}

export function initEditor(container, initialContent, socket, fileId, options = {}) {
  let autosaveTimer = null
  let compileTimer = null
  let outlineTimer = null
  let lastOutline = ""
  const themeCompartment = new Compartment()
  const languageCompartment = new Compartment()
  // Mutable: switching files reconfigures the editor in place, so the current
  // language must follow — otherwise the compile/outline gates go stale and a
  // non-Typst file (e.g. .csv) would be compiled as Typst.
  let language = options.language || "typst"
  // The buffer compiles when it is Typst, or when the preview's entry file is
  // Typst and this buffer merely feeds it (a CSV opened by a preview jump).
  const compiles = () => {
    if (language === "typst") return true
    const project = options.project || {}
    const entry = project.entryPath
    return !!entry && entry !== project.mainPath && /\.typ$/i.test(entry)
  }
  const onCursor = typeof options.onCursor === "function" ? options.onCursor : null
  const onOutline = typeof options.onOutline === "function" ? options.onOutline : null

  const emitOutline = (content) => {
    if (!onOutline) return
    const items = parseOutline(content, language)
    const signature = JSON.stringify(items)
    if (signature !== lastOutline) {
      lastOutline = signature
      onOutline(items)
    }
  }

  const updateListener = EditorView.updateListener.of((update) => {
    if (onCursor && (update.docChanged || update.selectionSet)) {
      const { line, col } = cursorPosition(update.state)
      // The third argument says whether the caret moved because the text
      // changed: typing must not drag the preview around, moving the caret may.
      onCursor(line, col, update.docChanged)
    }

    if (update.docChanged) {
      clearTimeout(autosaveTimer)

      const content = update.state.doc.toString()

      if (fileId && socket) {
        socket.pushEvent("save_started", {})
        autosaveTimer = setTimeout(() => {
          socket.pushEvent("autosave", {
            file_id: fileId,
            content: content
          })
        }, 500)
      }

      if (compiles()) {
        clearTimeout(compileTimer)
        const delay = compileDelay()
        if (delay >= 0) {
          compileTimer = setTimeout(() => {
            if (socket) socket.pushEvent("compile_started", {})
            compileTypst(content, options.project || {})
          }, delay)
        }
      }

      clearTimeout(outlineTimer)
      outlineTimer = setTimeout(() => emitOutline(content), 400)
    }
  })

  // Editing aids (lint, v3 assists, autocomplete) are skipped in read-only mode
  // — e.g. a shared/embedded view: just highlighting on a frozen, uneditable doc.
  const editingExtensions = options.readonly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [
        lintGutter(),
        ...editorV3Extensions,
        autocompletion(
          language === "typst"
            ? { override: [(ctx) => typstCompletionSource(ctx, options.project)] }
            : {}
        )
      ]

  // Collaborative editing: bind to a shared Yjs document over a Phoenix channel.
  // The doc's text arrives via sync, so the editor starts empty (no double-seed).
  const collab =
    options.collab && fileId && !options.readonly
      ? createCollab(fileId, options.user || {})
      : null

  const state = EditorState.create({
    doc: collab ? "" : initialContent || "",
    extensions: [
      basicSetup,
      ...editingExtensions,
      ...(collab ? [collab.extension] : []),
      themeCompartment.of(getThemeExtension()),
      languageCompartment.of(getLanguageExtension(language)),
      ...(language === "typst" ? [typstCloseBrackets, ...typst()] : []),
      updateListener
    ]
  })

  const editor = new EditorView({
    state: state,
    parent: container
  })

  if (language === "typst") {
    registerTypstView(editor)
  }

  if (initialContent && language === "typst" && !options.readonly) {
    compileTypst(initialContent, options.project || {})
  }

  // Seed cursor + outline from the initial document. The seed is flagged like
  // an edit: it is not a caret move the preview should follow.
  if (onCursor) {
    const { line, col } = cursorPosition(editor.state)
    onCursor(line, col, true)
  }
  emitOutline(initialContent || "")

  const updateTheme = () => {
    editor.dispatch({
      effects: [themeCompartment.reconfigure(getThemeExtension()), setTypstTheme.of(null)]
    })
  }

  const updateLanguage = (newLang) => {
    language = newLang || "plain"
    editor.dispatch({
      effects: languageCompartment.reconfigure(getLanguageExtension(language))
    })
    if (language === "typst") registerTypstView(editor)
  }

  return {
    editor,
    updateTheme,
    updateLanguage,
    runCommand: (cmd, arg) => runEditorCommand(editor, language, cmd, arg),
    openSearch: () => openSearchPanel(editor),
    setDiagnostics: (diags) => {
      const cm = toCmDiagnostics(editor, diags)
      editor.dispatch(setDiagnostics(editor.state, cm))
      editor.dispatch({ effects: setDiagData.of(cm) })
    },
    compile: () => {
      // The worker maps the buffer at its own path and compiles the entry file.
      if (compiles()) compileTypst(editor.state.doc.toString(), options.project || {})
    },
    download: () => {
      if (compiles()) {
        downloadTypstPdf(editor.state.doc.toString(), options.project || {}, container.dataset.fileName)
      }
    },
    destroy: () => {
      if (autosaveTimer) clearTimeout(autosaveTimer)
      if (compileTimer) clearTimeout(compileTimer)
      if (outlineTimer) clearTimeout(outlineTimer)
      if (collab) collab.destroy()
      editor.destroy()
    }
  }
}

export function updateEditorContent(editorInstance, content) {
  if (editorInstance && editorInstance.editor) {
    const currentContent = editorInstance.editor.state.doc.toString()
    if (currentContent !== content) {
      editorInstance.editor.dispatch({
        changes: {
          from: 0,
          to: editorInstance.editor.state.doc.length,
          insert: content
        }
      })
    }
  }
}

export function destroyEditor(editorInstance) {
  if (editorInstance && editorInstance.destroy) {
    editorInstance.destroy()
  }
}
