// Preview ↔ source sync (#149): click a spot in the rendered preview to jump
// the editor there, and follow the editor's cursor in the preview.
//
// The bundled typst.ts exposes no span resolver to JavaScript (the renderer's
// `source_span` reads page source mappings the incremental server no longer
// packs into the artifact, and the compiler has no `resolve_span`), so the two
// sides are aligned by *text*. The SVG carries the laid-out text of every run
// in a hidden selection layer (`.typst-text > foreignObject .tsel`) in document
// order, and the sources that produced the render are known: walking the runs
// in order and locating each one's text in the sources (with `#include`s
// spliced in where they appear) gives every run a source offset; the inverse
// lookup serves the editor's cursor. Runs without enough text to anchor
// (bullets, numbering, math glyphs, page numbers) take the first source line
// between their neighbours, so block elements still land on their own line.

const BACKWARD_WINDOW = 2000
const MAX_INCLUDE_DEPTH = 8
const CLICK_SLOP_PX = 48

// How far ahead of the reading position a run may match, by how much text it
// carries: a word or two only counts when it sits right where the previous
// run ended, a whole line may skip a page of unmatched code.
function forwardWindow(text) {
  const alnum = (text.match(/[\p{L}\p{N}]/gu) || []).length
  if (alnum < 2) return 0
  if (alnum < 4) return 64
  if (text.length < 8) return 400
  return 20000
}

// Typst's typographic substitutions, undone so a run matches its markup.
const TYPOGRAPHY = [
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"],
  [/—/g, "---"],
  [/–/g, "--"],
  [/…/g, "..."]
]

// The run's text as it was laid out, then with Typst's typography undone: a
// source may spell an em dash as `---` or as the character itself.
function runVariants(text) {
  const plain = String(text || "")
    .replace(/­/g, "")
    .replace(/[  ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  let ascii = plain
  for (const [re, repl] of TYPOGRAPHY) ascii = ascii.replace(re, repl)
  return ascii === plain ? [plain] : [plain, ascii]
}

function longestWord(text) {
  const words = text.match(/[\p{L}\p{N}]{5,}/gu)
  if (!words) return null
  return words.reduce((a, b) => (b.length > a.length ? b : a))
}

function cleanPath(path) {
  return String(path || "").replace(/^\/+/, "").trim()
}

// Resolve an `#include` target the way Typst does: absolute from the project
// root, otherwise relative to the including file's directory.
function resolveInclude(from, target) {
  if (target.startsWith("/")) return cleanPath(target)
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : ""
  const parts = []
  for (const seg of (dir + target).split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") parts.pop()
    else parts.push(seg)
  }
  return parts.join("/")
}

// ── Virtual document ─────────────────────────────────────────────────────────
// The project's sources in reading order: the entry file with each `#include`d
// file spliced in right after its include line, then every other text source
// (CSV data, `#import`ed modules) as an appendix, so text the document pulls
// from a data file still resolves to its row. `primaryEnd` marks where the
// appendix starts: matches there never move the reading position. `search`
// is `text` with newlines turned into spaces (same length, so offsets agree)
// because a rendered line freely spans source line breaks.

export function buildVirtualDoc(bufferPath, bufferContent, sources, entryPath) {
  const byPath = new Map()
  for (const s of Array.isArray(sources) ? sources : []) {
    if (s && typeof s.path === "string") byPath.set(cleanPath(s.path), s.content || "")
  }
  const buffer = cleanPath(bufferPath) || "main.typ"
  byPath.set(buffer, bufferContent || "")
  const entry = cleanPath(entryPath)
  const main = entry && byPath.has(entry) ? entry : buffer

  const lines = []
  const visited = new Set()
  const expand = (file, depth) => {
    if (visited.has(file) || depth > MAX_INCLUDE_DEPTH) return
    const content = byPath.get(file)
    if (content == null) return
    visited.add(file)
    content.split("\n").forEach((text, i) => {
      lines.push({ file, line: i + 1, text })
      const m = text.match(/^\s*#include\s+"([^"]+)"/)
      if (m) expand(resolveInclude(file, m[1]), depth + 1)
    })
  }
  expand(main, 0)
  const primaryLines = lines.length
  for (const file of byPath.keys()) expand(file, 0)

  const starts = []
  let text = ""
  let primaryEnd = 0
  for (let i = 0; i < lines.length; i++) {
    if (i === primaryLines) primaryEnd = text.length
    starts.push(text.length)
    text += lines[i].text + "\n"
  }
  if (primaryLines === lines.length) primaryEnd = text.length
  return { lines, starts, text, search: text.replace(/\n/g, " "), primaryEnd }
}

function lineIndexAt(doc, offset) {
  let lo = 0
  let hi = doc.starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (doc.starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function locate(doc, offset) {
  if (!doc.lines.length) return null
  const idx = lineIndexAt(doc, Math.max(0, Math.min(offset, doc.text.length)))
  const l = doc.lines[idx]
  return { file: l.file, line: l.line, col: Math.max(1, offset - doc.starts[idx] + 1) }
}

export function offsetOf(doc, file, line, col) {
  const f = cleanPath(file)
  const idx = doc.lines.findIndex((l) => l.file === f && l.line === line)
  if (idx < 0) return null
  const l = doc.lines[idx]
  return doc.starts[idx] + Math.min(Math.max((col || 1) - 1, 0), l.text.length)
}

// ── Alignment ────────────────────────────────────────────────────────────────

// Nearest occurrence of `needle` around `pos`: ahead within `forward` chars,
// else behind within the backward window, else (for a run with real text)
// anywhere in the appendix of data files. -1 when none.
function findNear(doc, needle, pos, forward) {
  const hay = doc.search
  const from = Math.max(0, pos - BACKWARD_WINDOW)
  const seg = hay.slice(from, pos + forward + needle.length)
  const ahead = seg.indexOf(needle, pos - from)
  if (ahead >= 0) return from + ahead
  if (forward < 400) return -1
  const behind = seg.lastIndexOf(needle, pos - from)
  if (behind >= 0) return from + behind
  if (needle.length < 8) return -1
  const appendix = hay.indexOf(needle, Math.max(doc.primaryEnd, pos + forward))
  return appendix >= 0 ? appendix : -1
}

// Where an unanchored run belongs: between its matched neighbours, on the
// first non-blank source line after the previous one when the next anchor is
// on a later line (a block of its own — an equation, a figure, a list bullet),
// otherwise right where the previous run ended (inline math, a styled word).
function inferOffset(doc, prev, next) {
  if (prev && prev.end > doc.primaryEnd) prev = null
  if (next && next.start > doc.primaryEnd) next = null
  if (!prev) return next ? next.start : 0
  const prevLine = lineIndexAt(doc, prev.end)
  const nextLine = next ? lineIndexAt(doc, next.start) : doc.lines.length
  if (nextLine <= prevLine) return prev.end
  for (let i = prevLine + 1; i < nextLine; i++) {
    if (doc.lines[i].text.trim()) return doc.starts[i]
  }
  return prev.end
}

export function alignRuns(container, doc) {
  const runs = []
  let pos = 0
  for (const sel of container.querySelectorAll(".tsel")) {
    if (sel.parentElement && sel.parentElement.closest(".tsel")) continue
    const el = sel.closest(".typst-text") || sel
    const variants = runVariants(sel.textContent)
    const text = variants[0]
    const run = { el, text, start: null, end: null, anchored: false }

    const forward = forwardWindow(text)
    if (forward > 0) {
      let hit = -1
      let len = 0
      for (const v of variants) {
        hit = findNear(doc, v, pos, forward)
        len = v.length
        if (hit >= 0) break
      }
      if (hit < 0) {
        const word = longestWord(text)
        if (word) {
          hit = findNear(doc, word, pos, forward)
          len = word.length
        }
      }
      if (hit >= 0) {
        run.start = hit
        run.end = hit + len
        run.anchored = true
        // A match behind the cursor (a running header, a footnote) does not
        // move the reading position backwards, and one in the appendix of
        // data files does not move it at all.
        if (run.end <= doc.primaryEnd) pos = Math.max(pos, run.end)
      }
    }
    runs.push(run)
  }

  let prev = null
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].anchored) {
      if (runs[i].start <= doc.primaryEnd) prev = runs[i]
      continue
    }
    let next = null
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j].anchored && runs[j].start <= doc.primaryEnd) {
        next = runs[j]
        break
      }
    }
    runs[i].start = runs[i].end = inferOffset(doc, prev, next)
  }
  return runs
}

// The run the cursor is in, else the nearest one after it, else before it.
export function runForOffset(runs, offset) {
  let after = null
  let before = null
  for (const r of runs) {
    if (r.start == null) continue
    if (r.start <= offset && offset <= r.end) return r
    if (r.start > offset) {
      if (!after || r.start < after.start) after = r
    } else if (!before || r.end > before.end) {
      before = r
    }
  }
  return after || before
}

// ── Live state ───────────────────────────────────────────────────────────────

let rendered = null // { container, content, project } of the SVG on screen
let aligned = null // { doc, runs, byEl } lazily built from `rendered`
let lastTarget = null
let flashEl = null

function ensureAligned() {
  if (!rendered || !rendered.container.isConnected) return null
  if (!aligned) {
    const { container, content, project } = rendered
    const doc = buildVirtualDoc(project.mainPath, content, project.sources, project.entryPath)
    const runs = alignRuns(container, doc)
    aligned = { doc, runs, byEl: new Map(runs.map((r) => [r.el, r])) }
  }
  return aligned
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function scrollOwner(el) {
  return el.closest("#preview-container") || el.closest(".ts-preview__scroll")
}

function selectingText(container) {
  const sel = window.getSelection && window.getSelection()
  if (!sel || sel.isCollapsed || !sel.anchorNode) return false
  return container.contains(sel.anchorNode)
}

function nearestRun(runs, x, y) {
  let best = null
  let bestDist = CLICK_SLOP_PX
  for (const r of runs) {
    const b = r.el.getBoundingClientRect()
    const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0
    const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0
    const d = Math.max(dx, dy)
    if (d < bestDist) {
      bestDist = d
      best = r
    }
  }
  return best
}

// Flash a highlight over `el` inside the scroll pane and bring it into view.
export function revealRun(el, flash) {
  const owner = scrollOwner(el)
  if (!owner) return
  const box = el.getBoundingClientRect()
  const pane = owner.getBoundingClientRect()
  const visible = box.top >= pane.top && box.bottom <= pane.bottom
  if (!visible) {
    const top = owner.scrollTop + (box.top - pane.top) - pane.height / 2 + box.height / 2
    owner.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? "auto" : "smooth" })
  }
  if (!flash) return

  if (!flashEl) {
    flashEl = document.createElement("div")
    flashEl.className = "ts-preview__flash"
    flashEl.setAttribute("aria-hidden", "true")
    flashEl.addEventListener("animationend", () => flashEl.remove())
  }
  flashEl.remove()
  flashEl.style.setProperty("--flash-left", `${box.left - pane.left + owner.scrollLeft}px`)
  flashEl.style.setProperty("--flash-top", `${box.top - pane.top + owner.scrollTop}px`)
  flashEl.style.setProperty("--flash-width", `${box.width}px`)
  flashEl.style.setProperty("--flash-height", `${box.height}px`)
  owner.appendChild(flashEl)
}

// Called by the worker client once a compile's SVG is in the DOM, with the
// exact sources that compile saw.
export function previewRendered(container, content, project) {
  rendered = { container, content, project: project || {} }
  aligned = null
  lastTarget = null
}

// Source → preview: scroll to the run holding the cursor and flash it (only
// when the target changed, so a cursor crawling along one line stays calm).
export function syncPreviewToCursor({ file, line, col }) {
  const state = ensureAligned()
  if (!state) return false
  const offset = offsetOf(state.doc, file, line, col)
  if (offset == null) return false
  const run = runForOffset(state.runs, offset)
  if (!run) return false
  revealRun(run.el, run !== lastTarget)
  lastTarget = run
  return true
}

// Preview → source: resolve the clicked run (or the nearest one) to a source
// location and hand it to the editor's goto, which switches files as needed.
export function installPreviewSync(container) {
  const onClick = (event) => {
    if (event.button !== 0 || event.defaultPrevented) return
    if (selectingText(container)) return
    const state = ensureAligned()
    if (!state) return
    const target = event.target instanceof Element ? event.target : null
    const el = target && target.closest(".typst-text")
    const run = (el && state.byEl.get(el)) || nearestRun(state.runs, event.clientX, event.clientY)
    if (!run || run.start == null) return
    const loc = locate(state.doc, run.start)
    if (!loc) return
    lastTarget = run
    window.dispatchEvent(
      new CustomEvent("phx:editor-command", {
        detail: { cmd: "goto", file: loc.file, line: loc.line, col: loc.col, source: "preview" }
      })
    )
  }
  container.addEventListener("click", onClick)
  return () => container.removeEventListener("click", onClick)
}
