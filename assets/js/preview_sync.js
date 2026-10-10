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

// The run's words with their positions in its text, for matching a printed
// value by its words alone (`("key", "short")` against `key,short`) and for
// mapping a click inside a word to that word's source position.
const TOKEN_RE = /[\p{L}\p{N}]+/gu

function tokensOf(text) {
  const out = []
  for (const m of text.matchAll(TOKEN_RE)) out.push({ text: m[0], at: m.index })
  return out
}

// A regex matching the words in order with anything but letters and digits
// between them, each word captured so `d` indices give its position.
function tokenPattern(tokens) {
  const body = tokens.map((t) => `(${t.text.replace(ESCAPE, "\\$&")})`).join("[^\\p{L}\\p{N}]+")
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "gud")
}

// Source position of each word of a token match (text offsets).
function tokenSpots(tokens, hit, doc) {
  const idx = hit.match && hit.match.indices
  return tokens.map((t, k) => ({
    text: t.text,
    at: t.at,
    src: idx && idx[k + 1] ? doc.toText(hit.from + idx[k + 1][0]) : null
  }))
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
      const hit = { start: from + m.index, end: from + m.index + m[0].length, from, match: m }
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

function placeGap(doc, prev, next, gap, prevAdjacent, nextAdjacent) {
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
  // Closing punctuation (`)`, `],`) follows the text before it.
  const closingFallback = (r) => (prev && /^[)\]}>,;.:]+$/.test(r.text) ? point(prev.end) : fallback())
  // Remember the stretch each run was placed in: a caret on a line in it
  // whose own text matched nothing (`#csv(...)`) finds these runs.
  for (const r of gap) {
    r.gapFrom = from
    r.gapTo = to
  }
  if (to <= from) {
    for (const r of gap) Object.assign(r, closingFallback(r))
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

  // A short run (a bracket, a lone value) printed next to text that came
  // from a data file is part of the same printed structure: it belongs with
  // that neighbour, not to a body line that happens to follow.
  const inAppendix = (r) => r && r.anchored && r.start > doc.primaryEnd
  const structural = (r) => !r.image && forwardWindow(r.text) < 400
  const neighbourSpot = inAppendix(nextAdjacent)
    ? point(nextAdjacent.start)
    : inAppendix(prevAdjacent)
      ? point(prevAdjacent.end)
      : null

  // A short printed value with words of its own (`"key"`) sits in the data
  // file between its neighbours: look for its words just before the next
  // one, else just after the previous one (and after the last value placed
  // this way), so a click inside it lands on the right cell.
  const NEAR_DATA = 400
  const findTokens = (tokens, from, to, wantLast) => {
    const re = tokenPattern(tokens)
    const seg = doc.search.slice(from, to)
    re.lastIndex = 0
    let best = null
    let m
    while ((m = re.exec(seg))) {
      const hit = { start: from + m.index, end: from + m.index + m[0].length, from, match: m }
      if (!wantLast) return hit
      best = hit
      re.lastIndex = m.index + 1
    }
    return best
  }
  let afterPrev = inAppendix(prevAdjacent) ? prevAdjacent.searchEnd : null

  // Closing punctuation (`)`, `],`) follows the text before it; everything
  // else without a line of its own precedes the text after it.
  const closing = (r) => /^[)\]}>,;.:]+$/.test(r.text)

  let claimed = -1
  for (const r of gap) {
    if (neighbourSpot && claimed < 0 && !r.image) {
      // Next to text from a data file: a run with words of its own (a cell
      // such as `"name"`) is looked up in that file around the neighbours;
      // a bare bracket goes with the neighbour it belongs to.
      const tokens = tokensOf(r.text)
      let hit = null
      if (tokens.length && inAppendix(nextAdjacent)) {
        // The previous neighbour may sit later in the data file (a glossary
        // printed from row 2 before an array printed from row 1): then only
        // the stretch before the next neighbour counts.
        const to = nextAdjacent.searchStart
        const from = afterPrev != null && afterPrev < to ? afterPrev : Math.max(doc.primaryEndS, to - NEAR_DATA)
        hit = findTokens(tokens, from, to, true)
      }
      if (!hit && tokens.length && afterPrev != null) {
        hit = findTokens(tokens, afterPrev, afterPrev + NEAR_DATA, false)
      }
      if (hit) {
        r.start = doc.toText(hit.start)
        r.end = doc.toText(hit.end)
        r.anchored = true
        r.searchStart = hit.start
        r.searchEnd = hit.end
        r.tokens = tokenSpots(tokens, hit, doc)
        afterPrev = hit.end
        continue
      }
      if (structural(r)) {
        Object.assign(r, closing(r) && inAppendix(prevAdjacent) ? point(prevAdjacent.end) : neighbourSpot)
        continue
      }
    }
    if (claimed < 0 && prev && closing(r)) {
      Object.assign(r, point(prev.end))
      continue
    }
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

// A picture has no text to match; its words name what its source line must
// hold (`#image(...)`, `#figure(image(...))`), so gap placement can claim it.
const IMAGE_WORDS = "image figure"

export function alignRuns(container, doc) {
  const runs = []
  const claimed = new Uint8Array(doc.search.length + 1) // in search offsets
  const firstBy = new Map() // normalized text -> first anchored run
  let lastAnchored = null
  let pos = 0
  // Text runs and pictures, in document order.
  for (const sel of container.querySelectorAll(".tsel, image")) {
    if (sel.tagName && sel.tagName.toLowerCase() === "image") {
      runs.push({ el: sel, text: IMAGE_WORDS, start: null, end: null, anchored: false, repeat: false, weak: false, image: true })
      continue
    }
    if (sel.parentElement && sel.parentElement.closest(".tsel")) continue
    const el = sel.closest(".typst-text") || sel
    const text = normalizeRun(sel.textContent)
    const run = { el, text, start: null, end: null, anchored: false, repeat: false, weak: false }

    const forward = forwardWindow(text)
    const tokens = tokensOf(text)
    // Where in the run text the matched part starts, so a click inside the
    // run maps onto the source; with word positions when matched by words.
    let matchFrom = 0
    let hit = null
    if (forward > 0) {
      hit = findNear(doc, runPattern(text, false), pos, forward, claimed, false, text.length * 2 + 16)
      if (!hit) {
        const stripped = text.replace(LABEL_PREFIX, "")
        if (stripped !== text && forwardWindow(stripped) > 0) {
          hit = findNear(doc, runPattern(stripped, false), pos, forward, claimed, false, stripped.length * 2 + 16)
          if (hit) matchFrom = text.length - stripped.length
        }
      }
      if (!hit && tokens.length > 1) {
        // The words in order, however they are punctuated: a printed array
        // row against its CSV line.
        hit = findNear(doc, tokenPattern(tokens), pos, forward, claimed, true, text.length * 2 + 16)
        if (hit) run.tokens = tokenSpots(tokens, hit, doc)
      }
      if (!hit) {
        const word = longestWord(text)
        if (word) {
          hit = findNear(doc, runPattern(word, true), pos, forward, claimed, true, word.length * 2 + 16)
          if (hit) matchFrom = text.indexOf(word)
        }
      }
    }
    // A short printed value (`"vpp",`) right after text that resolved to a
    // data file is the next thing in that file: look just past that text.
    if (!hit && tokens.length && lastAnchored && lastAnchored.searchEnd > doc.primaryEndS) {
      const from = lastAnchored.searchEnd
      const re = tokenPattern(tokens)
      const seg = doc.search.slice(from, from + 400)
      re.lastIndex = 0
      const m = re.exec(seg)
      if (m) {
        hit = { start: from + m.index, end: from + m.index + m[0].length, from, match: m }
        run.tokens = tokenSpots(tokens, hit, doc)
      }
    }
    if (forward > 0 || hit) {
      if (hit) {
        run.start = doc.toText(hit.start)
        run.end = doc.toText(hit.end)
        run.anchored = true
        run.matchFrom = matchFrom
        run.searchStart = hit.start
        run.searchEnd = hit.end
        lastAnchored = run
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
    placeGap(doc, prev, next, runs.slice(i, j), i > 0 ? runs[i - 1] : null, runs[j] || null)
    i = j
  }
  return runs
}

// The run the caret is in. Failing that, the caret's line produced output
// that matched nothing of its own (a `#csv(...)` whose rows resolved to the
// data file, a value read from a module): the runs placed in the stretch of
// lines around it are that output, the one sharing a word with the line
// first, else the earliest. Else the nearest run after the caret, else
// before it.
export function runForOffset(runs, offset, doc) {
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
  if (doc) {
    const li = lineIndexAt(doc, offset)
    const inGap = runs.filter((r) => r.gapFrom != null && r.gapFrom <= li && li < r.gapTo)
    if (inGap.length) {
      const words = new Set(wordsOf(doc.lines[li].text))
      let best = null
      let bestScore = 0
      for (const r of inGap) {
        let n = 0
        for (const w of wordsOf(r.text)) if (words.has(w)) n++
        if (n > bestScore) {
          bestScore = n
          best = r
        }
      }
      return best || inGap[0]
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
  const run = runForOffset(state.runs, offset, state.doc)
  if (!run) return false
  revealRun(run.el, run !== lastTarget)
  lastTarget = run
  return true
}

// Where in the run's source the click landed: the character under the pointer
// (the text layer holds the run's text one-to-one with the matched source,
// give or take collapsed whitespace), else the run's end. A run placed on a
// line rather than matched (generated text) goes to that line's end.
function clickedOffset(run, event) {
  if (!run.anchored) return run.end
  const sel = run.el.querySelector ? run.el.querySelector(".tsel") || run.el : run.el
  let node = null
  let offset = 0
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(event.clientX, event.clientY)
    if (p) {
      node = p.offsetNode
      offset = p.offset
    }
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(event.clientX, event.clientY)
    if (r) {
      node = r.startContainer
      offset = r.startOffset
    }
  }
  if (!node || !sel.contains(node)) return run.end
  // Count the characters of the run's text before the hit, across its nodes.
  let before = 0
  const walker = document.createTreeWalker(sel, NodeFilter.SHOW_TEXT)
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (t === node) {
      before += offset
      break
    }
    before += t.textContent.length
  }
  const lead = (sel.textContent.match(/^\s*/) || [""])[0].length
  const idx = Math.max(0, before - lead)
  if (run.tokens) {
    // Matched by words: the click sits in or after some word.
    let spot = run.start
    for (const t of run.tokens) {
      if (t.src == null) continue
      if (idx < t.at) break
      spot = t.src + Math.min(idx - t.at, t.text.length)
    }
    return Math.min(spot, run.end)
  }
  const rel = idx - (run.matchFrom || 0)
  if (rel <= 0) return run.start
  return Math.min(run.start + rel, run.end)
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
    const el = target && target.closest(".typst-text, image")
    const run = (el && state.byEl.get(el)) || nearestRun(state.runs, event.clientX, event.clientY)
    if (!run || run.start == null) return
    const loc = locate(state.doc, clickedOffset(run, event))
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
