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

// Typst's typographic substitutions, undone so a run reads like its markup.
const TYPOGRAPHY = [
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"],
  [/—/g, "---"],
  [/–/g, "--"],
  [/…/g, "..."]
]

// The run's text with Typst's typography undone and whitespace collapsed.
function normalizeRun(text) {
  let out = String(text || "")
    .replace(/­/g, "")
    .replace(/[  ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  for (const [re, repl] of TYPOGRAPHY) out = out.replace(re, repl)
  return out
}

// A regex that finds the run in the sources however they spell it: any
// whitespace run (an indented continuation line, a tab, `~`) for a space,
// straight or curly quotes, `---` or an em dash, `...` or an ellipsis. It
// runs against `doc.search` (soft hyphens already dropped), so offsets map
// back to the text exactly.
const ESCAPE = /[.*+?^${}()|[\]\\\/]/g
const SOURCE_SPACE = "[\\s\\u00a0\\u202f~]+"

function runPattern(text, whole) {
  const parts = []
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let m
    if (rest[0] === " ") {
      parts.push(SOURCE_SPACE)
      i += 1
    } else if (rest.startsWith("---")) {
      parts.push("(?:---|\\u2014)")
      i += 3
    } else if (rest.startsWith("--")) {
      parts.push("(?:--|\\u2013)")
      i += 2
    } else if (rest.startsWith("...")) {
      parts.push("(?:\\.\\.\\.|\\u2026)")
      i += 3
    } else if (rest[0] === '"') {
      parts.push('["\\u201c\\u201d]')
      i += 1
    } else if (rest[0] === "'") {
      parts.push("['\\u2018\\u2019]")
      i += 1
    } else if ((m = rest.match(/^[^\s"'.\-]+/))) {
      // Escape each code point on its own (a surrogate pair stays whole).
      parts.push(Array.from(m[0], (ch) => ch.replace(ESCAPE, "\\$&")).join(""))
      i += m[0].length
    } else {
      parts.push(rest[0].replace(ESCAPE, "\\$&"))
      i += 1
    }
  }
  const body = parts.join("")
  const source = whole ? `(?<![\\p{L}\\p{N}_-])${body}(?![\\p{L}\\p{N}_-])` : body
  return new RegExp(source, "gu")
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
  const appendixStart = primaryLines

  const starts = []
  let text = ""
  let primaryEnd = 0
  for (let i = 0; i < lines.length; i++) {
    if (i === primaryLines) primaryEnd = text.length
    starts.push(text.length)
    text += lines[i].text + "\n"
  }
  if (primaryLines === lines.length) primaryEnd = text.length

  // `search` is `text` with newlines as spaces and soft hyphens removed (a
  // regex allowing one between every character compiles far too slowly);
  // `toText` maps a search offset back to a text offset, identity unless a
  // soft hyphen was dropped.
  let search = text.replace(/\n/g, " ")
  let toText = (i) => i
  let primaryEndS = primaryEnd
  if (search.includes("\u00ad")) {
    const map = new Int32Array(search.length + 1)
    let out = ""
    let j = 0
    for (let i = 0; i < search.length; i++) {
      if (i === primaryEnd) primaryEndS = j
      if (search.charCodeAt(i) === 0xad) continue
      map[j++] = i
    }
    if (primaryEnd >= search.length) primaryEndS = j
    map[j] = search.length
    search = search.replace(/\u00ad/g, "")
    toText = (i) => map[Math.min(i, map.length - 1)]
  }
  return { lines, starts, text, search, toText, primaryEnd, primaryEndS, primaryLines: appendixStart }
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

// Nearest match of `re` around `pos`: ahead within `forward` chars, else
// behind within the backward window (not for the lone-word fallback, whose
// `whole` pattern is too weak a clue to look back for), else anywhere in the
// appendix of data files for a run with real text. Returns {start, end} or
// null. Source text claimed by an earlier run is never handed out again: the
// same sentence rendered twice must not send every copy to the first one.
function findNear(doc, re, pos, forward, claimed, whole, maxLen) {
  const hay = doc.search
  const free = (start, end) => {
    for (let k = start; k < end; k++) if (claimed[k]) return false
    return true
  }
  const scan = (from, to, wantLast) => {
    const seg = hay.slice(from, to)
    re.lastIndex = 0
    let best = null
    let m
    while ((m = re.exec(seg))) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      const hit = { start: from + m.index, end: from + m.index + m[0].length }
      if (free(hit.start, hit.end)) {
        if (!wantLast) return hit
        best = hit
      }
      re.lastIndex = m.index + 1
    }
    return best
  }
  const ahead = scan(pos, pos + forward + maxLen, false)
  if (ahead) return ahead
  if (forward < 400) return null
  if (!whole) {
    const behind = scan(Math.max(0, pos - BACKWARD_WINDOW), pos + maxLen, true)
    if (behind) return behind
  }
  if (maxLen < 8) return null
  return scan(Math.max(doc.primaryEndS, pos + forward), hay.length, false)
}

// Lines that cannot be what a rendered run came from: blank, comments,
// closing brackets, and declarations that produce no content themselves.
const SILENT_LINE = /^\s*(?:$|\/\/|[\])}]+\s*$|#(?:set|show|let|import|include)\b)/

function wordsOf(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [])
}

// Place a gap of unanchored runs somewhere between the previous and the next
// matched run. Walking the gap in order, a run sharing a word with a source
// line in the remaining stretch claims that line (`#lorem(400)` for a "Lorem
// ipsum …" paragraph, `#table(` for "Table 1") and the runs after it stay
// there until another run claims a later line. Runs before any claim take the
// first line able to produce content; a gap with nothing to claim and no such
// line sits at the previous run's end (inline math, a styled word).
const MAX_SCORING_WORK = 2_000_000

function lineSpan(doc, idx) {
  return { start: doc.starts[idx], end: doc.starts[idx] + doc.lines[idx].text.length }
}

function placeGap(doc, prev, next, gap) {
  const prevLine = prev ? lineIndexAt(doc, prev.end) : -1
  const nextLine = next ? lineIndexAt(doc, next.start) : doc.primaryLines
  const from = prevLine + 1
  const to = nextLine
  // A marker that precedes the text of its own line (a bullet, a heading
  // number) has no line of its own between its neighbours: it belongs to
  // the start of the next run's line when that is a later line, else inline
  // right where the previous run ended.
  const point = (offset) => ({ start: offset, end: offset })
  const fallback = () =>
    next && nextLine > prevLine ? point(doc.starts[nextLine]) : prev ? point(prev.end) : point(next ? next.start : 0)
  if (to <= from) {
    for (const r of gap) Object.assign(r, fallback())
    return
  }

  const lineWords = []
  let firstContent = -1
  for (let i = from; i < to; i++) {
    const line = doc.lines[i].text
    const silent = SILENT_LINE.test(line)
    if (!silent && firstContent < 0) firstContent = i
    lineWords.push(silent ? null : wordsOf(line))
  }
  const leadIn = firstContent >= 0 ? lineSpan(doc, firstContent) : fallback()
  const score = gap.length * (to - from) <= MAX_SCORING_WORK

  let claimed = -1
  for (const r of gap) {
    let best = -1
    if (score) {
      const words = new Set(wordsOf(r.text))
      let bestScore = 0
      if (words.size) {
        for (let i = Math.max(from, claimed); i < to; i++) {
          const lw = lineWords[i - from]
          if (!lw) continue
          let n = 0
          for (const w of lw) if (words.has(w)) n++
          if (n > bestScore) {
            bestScore = n
            best = i
          }
        }
      }
    }
    if (best >= 0) claimed = best
    Object.assign(r, claimed >= 0 ? lineSpan(doc, claimed) : leadIn)
  }
}

// A generated label in front of the text ("Figure 1: ", "1.2 ", "Table 3. ").
const LABEL_PREFIX = /^(?:[^\s:]{1,16}(?:\s+\d+(?:\.\d+)*)?[:.]\s+|\d+(?:\.\d+)*\.?\s+)/

// How far ahead a match may be and still move the reading position: a short
// run (a table-of-contents entry, a heading repeated in the outline) found a
// page ahead must not drag the position past the body that follows it.
const NEAR_AHEAD = 400
const LONG_RUN = 40

export function alignRuns(container, doc) {
  const runs = []
  const claimed = new Uint8Array(doc.search.length + 1) // in search offsets
  const firstBy = new Map() // normalized text -> first anchored run
  let pos = 0
  for (const sel of container.querySelectorAll(".tsel")) {
    if (sel.parentElement && sel.parentElement.closest(".tsel")) continue
    const el = sel.closest(".typst-text") || sel
    const text = normalizeRun(sel.textContent)
    const run = { el, text, start: null, end: null, anchored: false, repeat: false, weak: false }

    const forward = forwardWindow(text)
    if (forward > 0) {
      let hit = findNear(doc, runPattern(text, false), pos, forward, claimed, false, text.length * 2 + 16)
      if (!hit) {
        const stripped = text.replace(LABEL_PREFIX, "")
        if (stripped !== text && forwardWindow(stripped) > 0) {
          hit = findNear(doc, runPattern(stripped, false), pos, forward, claimed, false, stripped.length * 2 + 16)
        }
      }
      if (!hit) {
        const word = longestWord(text)
        if (word) hit = findNear(doc, runPattern(word, true), pos, forward, claimed, true, word.length * 2 + 16)
      }
      if (hit) {
        run.start = doc.toText(hit.start)
        run.end = doc.toText(hit.end)
        run.anchored = true
        // A short run found far ahead (a table-of-contents entry, a value
        // that the body spells out later) is a weak match: it neither claims
        // the text (the body's own copy still needs it), nor moves the
        // reading position, nor bounds the placement of its neighbours.
        run.weak = hit.start - pos > NEAR_AHEAD && text.length < LONG_RUN
        if (!run.weak) {
          claimed.fill(1, hit.start, hit.end)
          if (!firstBy.has(text)) firstBy.set(text, run)
          // A match behind the position (a footnote) does not move it back,
          // one in the appendix of data files does not move it at all.
          if (run.end <= doc.primaryEnd) pos = Math.max(pos, hit.end)
        }
      } else if (firstBy.has(text)) {
        // The same text again with its source already taken: a running
        // header or footer. It is a copy of the first one.
        const first = firstBy.get(text)
        run.start = first.start
        run.end = first.end
        run.anchored = true
        run.repeat = true
      }
    }
    runs.push(run)
  }

  // Unanchored runs are placed gap by gap, between the matched runs of the
  // document body (matches in the appendix and repeats do not bound a gap).
  const bounds = (r) => r.anchored && !r.repeat && !r.weak && r.start <= doc.primaryEnd
  let prev = null
  let i = 0
  while (i < runs.length) {
    if (runs[i].anchored) {
      if (bounds(runs[i])) prev = runs[i]
      i++
      continue
    }
    let j = i
    while (j < runs.length && !runs[j].anchored) j++
    let next = null
    for (let k = j; k < runs.length; k++) {
      if (bounds(runs[k])) {
        next = runs[k]
        break
      }
    }
    placeGap(doc, prev, next, runs.slice(i, j))
    i = j
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

// The run nearest a click beside the text: the one on the same line (least
// vertical distance) wins, horizontal distance only breaks ties, both within
// the slop.
function nearestRun(runs, x, y) {
  let best = null
  let bestDy = CLICK_SLOP_PX
  let bestDx = CLICK_SLOP_PX
  for (const r of runs) {
    if (!r.el.isConnected) continue
    const b = r.el.getBoundingClientRect()
    const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0
    const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0
    if (dy > CLICK_SLOP_PX || dx > CLICK_SLOP_PX) continue
    if (dy < bestDy || (dy === bestDy && dx < bestDx)) {
      bestDy = dy
      bestDx = dx
      best = r
    }
  }
  return best
}

// Flash a highlight over `el` inside the scroll pane and bring it into view.
export function revealRun(el, flash) {
  const owner = scrollOwner(el)
  if (!owner || !el.isConnected) return
  // Measure before scrolling: with instant scrolling (reduced motion) the
  // pane moves synchronously and a later read would be off by the scroll.
  const box = el.getBoundingClientRect()
  const pane = owner.getBoundingClientRect()
  const scrollLeft = owner.scrollLeft
  const scrollTop = owner.scrollTop
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
  flashEl.style.setProperty("--flash-left", `${box.left - pane.left + scrollLeft}px`)
  flashEl.style.setProperty("--flash-top", `${box.top - pane.top + scrollTop}px`)
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
