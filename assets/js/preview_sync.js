// Preview ↔ source sync (#149): click a spot in the rendered preview to jump
// the editor there, and follow the editor's cursor in the preview.
//
// The bundled typst.ts exposes no span resolver to JavaScript (the renderer's
// `source_span` reads page source mappings the incremental server no longer
// packs into the artifact, and the compiler has no `resolve_span`), so the two
// sides are aligned by *text*. The SVG carries the laid-out text of every run
// in a hidden selection layer (`.typst-text > foreignObject .tsel`) in document
// order, and the sources that produced the render are known. Alignment goes
// from the strongest evidence to the weakest:
//
// 1. A text rendered exactly as often as the sources hold it pairs up with
//    those occurrences in order, and the heaviest chain of pairs that keeps
//    both orders is the backbone. Text rendered out of order (an outline
//    entry, a top float, a footnote) falls out of the chain instead of
//    dragging the reading position. Printed data need not keep its file's
//    order: a unique value pairs wherever it prints, a repeated one in the
//    record of the value printed next to it.
// 2. The other runs are matched inside the source stretch between their
//    backbone neighbours (per data file for printed data), then in their
//    line or page, by a suffix (a caption without its label), by their words,
//    in the definitions of the functions their stretch calls (a template's
//    separators), as copies of text already shown (running headers, outline
//    entries, a table printed twice, a glossary listing a CSV's rows), by the
//    literal part of a mixed run, or as one word Typst split into runs.
// 3. Runs with nothing to match (bullets, numbering, `#lorem`, pictures) are
//    placed on the source line between their neighbours able to produce them.
//
// A click maps through each run's per-character spots, walked with the same
// folding as matching. The inverse lookup serves the editor's cursor.

const MAX_INCLUDE_DEPTH = 8
const CLICK_SLOP_PX = 48
// Safety cap on placement scoring (runs × lines of one gap): past it, the
// runs of a gap take its first producing line without comparing words.
const MAX_SCORING_WORK = 2_000_000

// ── Text ─────────────────────────────────────────────────────────────────────

// Quotation marks of every locale: Typst prints `"` and `'` as the language's
// quotes (“ ” „ “ « » ‹ › 「 」 …), so a run's quote matches any of them.
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2039\u203a\u300e\u300f]/g
const DOUBLE_QUOTES = /[\p{Pi}\p{Pf}\u201e\u300c\u300d\u301d-\u301f]/gu
const QUOTE_CLASS = "[\"'\\p{Pi}\\p{Pf}\\u201a\\u201e\\u300c-\\u300f\\u301d-\\u301f]"
const IS_QUOTE = new RegExp(QUOTE_CLASS, "u")
const ALNUM = /[\p{L}\p{N}]/u
const LETTER = /\p{L}/u
const FORMAT_CHAR = /\p{Cf}/u
// What composes with the character before it: combining marks and the
// vowel and final jamo of a Hangul syllable.
const COMBINING = /[\p{M}\u1160-\u11ff\ud7b0-\ud7ff]/u
// Scripts written without spaces between words: a line may break anywhere,
// so a run can start or end inside a source word.
const NO_SPACE_SCRIPT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u
// A line broken inside a word renders a hyphen (Typst's is a soft hyphen in
// a run of its own).
const BREAK_HYPHEN = /[\u00ad\u2010-]\s*$/

// The run's text as the sources would spell it: compatibility characters
// folded (math italic letters, ligatures, full-width forms), format
// characters (soft hyphens, joiners) dropped, whitespace collapsed, quotes
// reduced to `"` and `'`, dashes spelled the way Typst's markup writes them.
function normalizeRun(text) {
  let out = String(text || "")
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
  out = out.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"')
  return out.replace(/[\u2010\u2011\u2212]/g, "-").replace(/\u2014/g, "---").replace(/\u2013/g, "--")
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

const ESCAPE = /[.*+?^${}()|[\]\\\/]/g
const SOURCE_SPACE = "[\\s~]+"

// The regex pieces matching `text` however the sources spell it: any
// whitespace run (an indented continuation line, a tab, `~`) for a space,
// none needed next to a quote (French « » carry their own thin spaces), any
// quotation mark for a quote, `---` or an em dash, `--` or an en dash, and
// punctuation possibly escaped (`\$`, `\#`). Each piece keeps the run offset
// it starts at, so a pattern can be cut there.
function patternPieces(text) {
  const pieces = []
  const chars = Array.from(text)
  let at = 0
  for (let k = 0; k < chars.length; ) {
    const ch = chars[k]
    let re
    let take = 1
    if (ch === " ") {
      const nearQuote = IS_QUOTE.test(chars[k - 1] || "") || IS_QUOTE.test(chars[k + 1] || "")
      re = nearQuote ? "[\\s~]*" : SOURCE_SPACE
    } else if (ch === "-" && chars[k + 1] === "-" && chars[k + 2] === "-") {
      re = "(?:---|\\u2014)"
      take = 3
    } else if (ch === "-" && chars[k + 1] === "-") {
      re = "(?:--|\\u2013)"
      take = 2
    } else if (ch === "-") {
      re = "[-\\u2010]"
    } else if (IS_QUOTE.test(ch)) {
      re = `\\\\?${QUOTE_CLASS}`
    } else if (ALNUM.test(ch)) {
      re = ch.replace(ESCAPE, "\\$&")
    } else {
      re = `\\\\?${ch.replace(ESCAPE, "\\$&")}`
    }
    pieces.push({ re, at })
    for (let t = 0; t < take; t++) at += chars[k + t].length
    k += take
  }
  return pieces
}

function joinPieces(pieces, from, to) {
  let out = ""
  for (const p of pieces) if (p.at >= from && p.at < to) out += p.re
  return out
}

// What separates two words (or decorates them) as a comparison sees it:
// escapes dropped (`\$` shows `$`), whitespace and `~` one space, every
// quotation mark one `"` with the spaces around it optional (French « »
// carry their own thin spaces), dashes spelled the way Typst's markup writes
// them. The same rules as the patterns below, for the words-first lookup.
const QUOTE_ALL = new RegExp(QUOTE_CLASS, "gu")

function foldSeparator(s) {
  if (s === " " || s === "") return s
  return s
    .replace(/\\(?=\S)/g, "")
    .replace(/[\s~]+/g, " ")
    .replace(QUOTE_ALL, '"')
    .replace(/\u2014/g, "---")
    .replace(/\u2013/g, "--")
    .replace(/\u2010/g, "-")
    .replace(/ ?" ?/g, '"')
}

// What a run is matched with: its text split into a decoration (leading and
// trailing punctuation such as the quotes Typst prints around a string value,
// optional in the source) around a core holding its words, and the folded
// separators between those words. `relaxStart` and `relaxEnd` drop the
// word-boundary requirement at that end (a word broken across lines, a
// script without spaces): the first or last word may then be part of a
// longer source word.
function compileRun(text, relaxStart, relaxEnd) {
  const tokens = tokensOf(text)
  const coreFrom = tokens.length ? tokens[0].at : 0
  const coreTo = tokens.length ? tokens[tokens.length - 1].at + tokens[tokens.length - 1].text.length : text.length
  const lead = text.slice(0, coreFrom)
  const trail = text.slice(coreTo)
  const openStart = relaxStart && coreFrom === 0
  const openEnd = relaxEnd && coreTo === text.length
  // A word is complete when the source must hold it as a whole word: what
  // the word index can look it up by.
  const complete = []
  tokens.forEach((t, k) => {
    if (!(k === 0 && openStart) && !(k === tokens.length - 1 && openEnd)) complete.push(k)
  })
  const seps = tokens.slice(1).map((t, k) => foldSeparator(text.slice(tokens[k].at + tokens[k].text.length, t.at)))
  return {
    text,
    tokens,
    complete,
    seps,
    coreFrom,
    coreTo,
    lead,
    trail,
    leadF: foldSeparator(lead),
    trailF: foldSeparator(trail),
    relaxStart,
    relaxEnd,
    openStart,
    openEnd,
    pieces: null,
    scan: null
  }
}

function piecesOf(m) {
  if (!m.pieces) m.pieces = patternPieces(m.text)
  return m.pieces
}

// The regex finding a run without whole words (punctuation, a fragment of a
// line in a script without spaces) inside a bounded stretch.
function scanRegex(m) {
  if (!m.scan) {
    const p = piecesOf(m)
    const n = m.text.length
    if (!m.tokens.length) m.scan = new RegExp(joinPieces(p, 0, n), "gu")
    else {
      const lead = m.lead ? `(?<l>${joinPieces(p, 0, m.coreFrom)})?` : ""
      const trail = m.trail ? `(?:${joinPieces(p, m.coreTo, n)})?` : ""
      m.scan = new RegExp(`${lead}(?<c>${joinPieces(p, m.coreFrom, m.coreTo)})${trail}`, "dgu")
    }
  }
  return m.scan
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

// ── Typst source structure ──────────────────────────────────────────────────
// A light scan of a Typst source that marks what each character is for, so
// matching only lands where rendered text can come from. DISP marks text that
// may show verbatim (markup, content blocks, strings, raw, math); PROD marks
// what renders where it stands (markup text, a call, a reference). Comments,
// code, markup syntax and declarations carry neither: a heading number never
// matches the `"1."` of a numbering rule, generated text never lands on a
// comment, and a word never matches an argument name (`caption:`). The scan
// also finds `include`s (any form, outside comments and definitions), calls,
// `let` definitions and strings that name project files.

const DISP = 1
const PROD = 2

// Typst's spacing and break functions lay out nothing visible.
const SILENT_CALLS = new Set(["v", "h", "pagebreak", "colbreak", "linebreak", "parbreak"])
// Builtins whose first string argument names a file, not text to show.
const FILE_CALLS = new Set(["csv", "json", "yaml", "toml", "xml", "cbor", "read", "image", "bibliography", "plugin"])
// Accessor methods whose first string argument is a key (`p.at("city")`),
// not text; a function of the same name (`#let at(place) = ...`) prints it.
// Method callees are passed with their dot.
const KEY_CALLS = new Set([".at"])
// Statements that configure rather than show: their strings are settings.
const DECLARATIONS = new Set(["set", "show", "import", "include"])
const CONTROL = new Set(["if", "for", "while", "context", "return"])

const IDENT_START = /[\p{L}_]/u
const IDENT_CHAR = /[\p{L}\p{N}_-]/u
const EXPR_START = /[\p{L}_({["]/u
const LABEL_CHAR = /[\p{L}\p{N}_\-:.]/u
const MARKER_Y = /(?:=+|[-+/])(?=[ \t\r\n]|$)/y
const LABEL_Y = /<[\p{L}\p{N}_\-:.]+>/uy
const BINDING_Y = /[ \t]*([\p{L}_][\p{L}\p{N}_-]*)[ \t]*=[ \t]*"([^"\n]*)"[ \t]*(?:;|\/\/|$)/muy
// A parenthesized value made of literals only (strings, numbers with units,
// `true`, `false`, `none`, `auto`, `key:` names): it shows as written.
const LITERAL_Y = /\((?:\s|"(?:[^"\\\n]|\\.)*"|-?\d+(?:\.\d+)?[a-z%]*|true|false|none|auto|[\p{L}_][\p{L}\p{N}_-]*\s*:|[(),])*\)/uy
const DEF_Y = /[ \t]*([\p{L}_][\p{L}\p{N}_-]*)/uy
const SET_Y = /[ \t]*set\b/y
// A `set page(...)` rule, and its arguments that are content set on every
// page.
const PAGE_SET_Y = /set[ \t]+page[ \t]*\(/y
const PAGE_CONTENT = new Set(["header", "footer", "background", "foreground"])
// A show rule's transform taking the element as a parameter (`it =>`).
const PARAM_Y = /\s*([\p{L}_][\p{L}\p{N}_-]*)\s*=>/uy

// The element a show rule's selector names (`heading`, `heading.where(level:
// 2)`, `figure`), with the heading level it asks for; null for a selector
// matching text, a label or a combination (`"TODO"`, `<intro>`, `.or(..)`).
const SELECTOR_Y = /^\s*([\p{L}_][\p{L}\p{N}_-]*(?:\.[\p{L}_][\p{L}\p{N}_-]*)?)\s*(?:\.where\(([^()]*)\))?\s*$/u

function selectorElement(text) {
  const m = SELECTOR_Y.exec(text)
  if (!m) return null
  const level = m[2] && /\blevel\s*:\s*(\d+)/.exec(m[2])
  return { name: m[1], level: level ? Number(level[1]) : null }
}

export function lexTypst(src, namesFile) {
  const n = src.length
  const flags = new Uint8Array(n)
  const includes = [] // { at, target }
  const calls = [] // { at, name, decl }: calls and embedded names
  const defs = [] // { name, from, to }: `let` statements
  const mentions = [] // { at, value }: strings naming a file
  const notes = [] // { at, from, to }: the arguments of a `footnote` call
  const markers = [] // { at, decl }: list and enum markers (`- `, `+ `)
  const rules = [] // { pre, suf }: the literal text a show rule prints around what it shows
  const pages = [] // { from, to }: the header, footer, ... values of `set page` rules
  const bindings = new Map() // `let name = "text"`
  let i = 0
  let declDepth = 0 // inside a declaration or `let`: nothing renders here
  let letDepth = 0 // inside a `let`: an include there renders where it is used

  const identAt = (k) => {
    let j = k
    while (j < n && IDENT_CHAR.test(src[j])) j++
    return src.slice(k, j)
  }
  const mark = (a, b, f) => {
    if (f) flags.fill(f, a, b)
  }
  // A footnote's argument group [from, end) (its closing bracket excluded),
  // joined to the call's earlier group (`footnote(numbering: "*")[...]`).
  const note = (at, from, end) => {
    const to = end > from && /[)\]]/.test(src[end - 1]) ? end - 1 : end
    const last = notes[notes.length - 1]
    if (last && last.at === at) last.to = to
    else notes.push({ at, from, to })
  }
  const lineComment = () => {
    while (i < n && src.charCodeAt(i) !== 10) i++
  }
  const blockComment = () => {
    let depth = 0
    while (i < n) {
      if (src[i] === "/" && src[i + 1] === "*") {
        depth++
        i += 2
      } else if (src[i] === "*" && src[i + 1] === "/") {
        i += 2
        if (--depth === 0) return
      } else i++
    }
  }
  // A string literal at `i`: returns its value's [from, to).
  const string = () => {
    const from = ++i
    while (i < n && src[i] !== '"' && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1
    const to = Math.min(i, n)
    if (src[i] === '"') i++
    return [from, to]
  }
  const raw = (f) => {
    let k = i
    while (k < n && src[k] === "`") k++
    const ticks = k - i
    i = k
    if (ticks === 2) return
    if (ticks >= 3) while (i < n && IDENT_CHAR.test(src[i])) i++ // language tag
    const end = src.indexOf("`".repeat(ticks), i)
    const stop = end < 0 ? n : end
    mark(i, stop, f)
    i = end < 0 ? n : end + ticks
  }

  // Markup up to the `]` closing a content block (or the end). `f` is the
  // flag its text gets: DISP | PROD where it renders in place, DISP alone in
  // a declaration (a `set page(header: [...])` shows its text elsewhere).
  const markup = (f, inBlock) => {
    let depth = 0
    // A content block starts its markup as a line does (`[- item]`).
    let lineStart = i === 0 || src[i - 1] === "\n" || (inBlock && src[i - 1] === "[")
    while (i < n) {
      const c = src.charCodeAt(i)
      if (c === 10) {
        lineStart = true
        i++
        continue
      }
      if (lineStart) {
        if (c === 32 || c === 9 || c === 13) {
          i++
          continue
        }
        lineStart = false
        // Heading and list markers render as numbers, bullets or nothing.
        MARKER_Y.lastIndex = i
        if (MARKER_Y.test(src)) {
          if (c === 45 || c === 43) markers.push({ at: i, decl: declDepth > 0 })
          i = MARKER_Y.lastIndex
          continue
        }
      }
      if (c === 47 && src[i + 1] === "/" && src[i - 1] !== ":") {
        lineComment()
        continue
      }
      if (c === 47 && src[i + 1] === "*") {
        blockComment()
        continue
      }
      if (c === 92) {
        // An escape shows the character after it (the backslash is part of
        // how the source spells it); `\u{...}` shows a code point.
        if (src[i + 1] === "u" && src[i + 2] === "{") {
          const e = src.indexOf("}", i)
          i = e < 0 ? n : e + 1
          continue
        }
        if (i + 1 < n && !/\s/.test(src[i + 1])) mark(i, i + 2, f)
        i += 2
        continue
      }
      if (c === 96) {
        raw(f)
        continue
      }
      if (c === 36) {
        i++
        math(f)
        continue
      }
      if (c === 35 && i + 1 < n && EXPR_START.test(src[i + 1])) {
        embed(f)
        continue
      }
      if (c === 91) depth++
      if (c === 93) {
        if (inBlock && depth === 0) {
          i++
          return
        }
        depth = Math.max(0, depth - 1)
      }
      if (c === 60) {
        LABEL_Y.lastIndex = i
        if (LABEL_Y.test(src)) {
          i = LABEL_Y.lastIndex
          continue
        }
      }
      if (c === 64 && LABEL_CHAR.test(src[i + 1] || "") && !ALNUM.test(src[i - 1] || "")) {
        // A reference renders its target's number, not its key.
        const from = i++
        while (i < n && LABEL_CHAR.test(src[i])) i++
        while (i > from + 1 && /[.:]/.test(src[i - 1])) i--
        mark(from, i, f & PROD)
        continue
      }
      if (c === 42 || c === 95) {
        i++ // `*` and `_` delimit strong and emphasis
        continue
      }
      flags[i++] = f
    }
  }

  const math = (f) => {
    // The parentheses grouping an attachment (`_(i=1)`, `^(n+1)`) are
    // syntax: only what they hold renders.
    const groups = []
    while (i < n) {
      const c = src.charCodeAt(i)
      if (c === 36) {
        i++
        return
      }
      if (c === 92) {
        if (i + 1 < n) flags[i + 1] = f
        i += 2
      } else if (c === 47 && src[i + 1] === "/") lineComment()
      else if (c === 47 && src[i + 1] === "*") blockComment()
      else if (c === 34) {
        const [a, b] = string()
        mark(a, b, f)
      } else if (c === 35 && i + 1 < n && EXPR_START.test(src[i + 1])) embed(f)
      else if (c === 40) {
        const group = src[i - 1] === "_" || src[i - 1] === "^"
        groups.push(group)
        if (!group) flags[i] = f
        i++
      } else if (c === 41) {
        if (!groups.pop()) flags[i] = f
        i++
      } else flags[i++] = f
    }
  }

  // An expression embedded with `#`: a statement (`#let`, `#set`, ...) runs
  // to the end of its line; anything else is a primary followed by field
  // accesses, calls and trailing content blocks written without spaces.
  const embed = (f) => {
    const hash = i++
    const word = IDENT_START.test(src[i]) ? identAt(i) : ""
    if (word === "let" || DECLARATIONS.has(word)) {
      statement(word)
      return
    }
    if (CONTROL.has(word)) {
      if (f & PROD) flags[hash] = PROD
      i += word.length
      code(null, f, null, false)
      return
    }
    const head = i
    const silent = expression(f)
    if (!silent && f & PROD) mark(hash, word ? head + word.length : hash + 1, PROD)
  }

  const expression = (f) => {
    let callee = null
    const c = src[i]
    if (c === "(") {
      // A literal value shows as written (`#(key: "v", n: 12)`); a
      // computation (`#(17 * 3)`) shows its result.
      LITERAL_Y.lastIndex = i
      const literal = LITERAL_Y.test(src)
      if (literal) flags[i] = f
      i++
      code(")", f, null, false, literal)
    } else if (c === "{") {
      i++
      code("}", f, null, false)
    } else if (c === "[") {
      i++
      markup(f, true)
    } else if (c === '"') {
      const [a, b] = string()
      mark(a, b, f)
    } else {
      callee = identAt(i)
      calls.push({ at: i, name: callee, decl: declDepth > 0 })
      i += callee.length
    }
    const name = callee
    const at = i - (callee ? callee.length : 0)
    let silent = false
    let method = false
    for (;;) {
      const d = src[i]
      if (d === "." && i + 1 < n && IDENT_START.test(src[i + 1])) {
        i++
        callee = identAt(i)
        i += callee.length
        method = true
      } else if (d === "(") {
        // `#v(..)`, `#pagebreak()`, `#counter(..).update(..)` show nothing.
        if (callee === "update" || (callee === name && SILENT_CALLS.has(name))) silent = true
        const from = ++i
        code(")", f, method ? `.${callee}` : callee, false)
        if (callee === "footnote") note(at, from, i)
      } else if (d === "[") {
        const from = ++i
        markup(f, true)
        if (callee === "footnote") note(at, from, i)
      } else return silent
    }
  }

  // Code up to `close` (consumed), or, for a statement (`close` null), up to
  // the end of its line, a `;` or a bracket closing the enclosing block.
  // `callee` names the call whose arguments these are: the first string of
  // `csv(...)`, `image(...)` and the like names a file. `decl` marks a
  // declaration, whose strings are settings rather than text. In a shown
  // literal (`literal`), names, numbers and punctuation show too. In a `show`
  // rule (`rule`), what follows its `:` is the transform: values handed to it
  // (`project.with(title: "...")`, a replacement string) may print, unless
  // it is a `set` rule.
  const code = (close, f, callee, decl, literal = false, rule = false) => {
    let first = true
    let stmt = close === "}"
    let noteAt = -1 // a `footnote` call whose content block may follow at `noteNext`
    let noteNext = -1
    while (i < n) {
      const c = src[i]
      if (close === null && (c === "\n" || c === ";")) return
      if (c === ")" || c === "}" || c === "]") {
        if (c === close) {
          if (literal) flags[i] = f
          i++
        }
        return
      }
      if (c === "\n" || c === ";") {
        stmt = close === "}"
        i++
        continue
      }
      if (c === " " || c === "\t" || c === "\r") {
        i++
        continue
      }
      if (c === "/" && src[i + 1] === "/") {
        lineComment()
        continue
      }
      if (c === "/" && src[i + 1] === "*") {
        blockComment()
        continue
      }
      if (c === '"') {
        const quote = i
        const [a, b] = string()
        const value = src.slice(a, b)
        // A string compared with `==` or `!=` (`r.at(1) == "retired"`) is a
        // condition, not text.
        const compared = /[=!]=[ \t]*$/.test(src.slice(Math.max(0, quote - 8), quote)) || /^[ \t]*[=!]=/.test(src.slice(i, i + 8))
        if ((first && FILE_CALLS.has(callee)) || namesFile(value)) mentions.push({ at: a, value })
        else if (!decl && !compared && !(first && KEY_CALLS.has(callee))) mark(literal ? a - 1 : a, literal ? Math.min(b + 1, n) : b, f)
      } else if (c === "[") {
        const from = ++i
        markup(f, true)
        if (from - 1 === noteNext) note(noteAt, from, i)
      } else if (c === "{") {
        i++
        code("}", f, null, decl)
      } else if (c === "(") {
        if (literal) flags[i] = f
        i++
        code(")", f, null, decl, literal)
      } else if (c === "$") {
        i++
        math(f)
      } else if (IDENT_START.test(c)) {
        const at = i
        const word = identAt(i)
        if (stmt && (word === "let" || DECLARATIONS.has(word))) {
          statement(word)
          stmt = false
          continue
        }
        i += word.length
        if (literal) mark(at, i, f)
        if (src[i] === "(" || src[i] === "[") calls.push({ at, name: word, decl: declDepth > 0 })
        if (word === "footnote") {
          noteAt = at
          noteNext = i
        }
        if (src[i] === "(") {
          const from = ++i
          code(")", f, src[at - 1] === "." ? `.${word}` : word, decl)
          if (word === "footnote") {
            note(at, from, i)
            noteNext = i
          }
        }
      } else {
        if (c === ",") first = false
        if (rule && c === ":") {
          rule = false
          SET_Y.lastIndex = i + 1
          decl = SET_Y.test(src)
        }
        if (literal) flags[i] = f
        i++
        continue
      }
      first = false
      stmt = false
    }
  }

  // A declaration or a `let`, to the end of its line (an `include` ends with
  // the file it names, so several fit on a line). Nothing in it renders
  // where it stands; a `let` keeps its strings and content matchable (they
  // show where the name is used), the others' strings are settings
  // (`numbering: "1."`, `lang: "fr"`).
  const statement = (word) => {
    const from = i
    i += word.length
    let name = null
    if (word === "include") {
      const target = includeTarget()
      if (target != null && !letDepth) includes.push({ at: from, target })
      return
    } else if (word === "let") {
      BINDING_Y.lastIndex = i
      const b = BINDING_Y.exec(src)
      if (b) bindings.set(b[1], b[2])
      DEF_Y.lastIndex = i
      const d = DEF_Y.exec(src)
      if (d) name = d[1]
      letDepth++
    }
    declDepth++
    code(null, DISP, null, word !== "let", false, word === "show")
    declDepth--
    if (word === "show") rulePieces(from, i)
    if (word === "set") pageContent(from, i)
    if (word === "let") {
      letDepth--
      if (name) defs.push({ name, from, to: i })
    }
  }

  // A `set page(...)` rule [from, to): where its header, footer, background
  // and foreground values stand, content Typst sets on every page.
  const pageContent = (from, to) => {
    PAGE_SET_Y.lastIndex = from
    const m = PAGE_SET_Y.exec(src)
    if (!m) return
    for (const a of callArguments(src, from + m[0].length - 1)) if (PAGE_CONTENT.has(a.name) && a.to <= to) pages.push({ from: a.at, to: a.to })
  }

  // A show rule whose transform is content around the element it shows
  // (`#show heading: it => block[#it.body (Part)]`, `[Teil: #it]`) prints
  // the literal text next to that placeholder around every element it
  // matches: the text before and after it, up to the content block's
  // bracket (`open` false) or to the code next to it. Embedded expressions
  // between the text and the bracket (`[Kapitel #counter(heading).display():
  // #it.body]`) print computed text: the piece reaches through them to the
  // bracket and lists them as its `gaps`. The rule's selector names the
  // element it shows (`element`, see `selectorElement`). [from, to) is the
  // rule.
  const rulePieces = (from, to) => {
    let k = from + "show".length
    let depth = 0
    for (; k < to; k++) {
      const c = src[k]
      if (c === '"') while (++k < to && src[k] !== '"') k += src[k] === "\\" ? 1 : 0
      else if (c === "(" || c === "[" || c === "{") depth++
      else if (c === ")" || c === "]" || c === "}") depth--
      else if (c === ":" && depth === 0) break
    }
    // A rule without a selector (`#show: project`) shows the whole document.
    if (k >= to || !src.slice(from + "show".length, k).trim()) return
    PARAM_Y.lastIndex = k + 1
    const param = PARAM_Y.exec(src)
    if (!param) return
    const element = selectorElement(src.slice(from + "show".length, k))
    const literal = (t) => flags[t] & DISP || /[\s*_~]/.test(src[t])
    // Past the bracket group opening at `t`, strings skipped.
    const groupEnd = (t) => {
      let depth = 0
      for (; t < to; t++) {
        const c = src[t]
        if (c === '"') while (++t < to && src[t] !== '"') t += src[t] === "\\" ? 1 : 0
        else if (c === "(" || c === "[" || c === "{") depth++
        else if ((c === ")" || c === "]" || c === "}") && --depth === 0) return t + 1
      }
      return to
    }
    // The embedded expressions of [x, y) when everything else is literal
    // text, else null.
    const through = (x, y) => {
      const gaps = []
      for (let t = x; t < y; ) {
        if (literal(t)) {
          t++
          continue
        }
        if (src[t] !== "#" || !IDENT_START.test(src[t + 1] || "")) return null
        let e = t + 1
        while (e < y && IDENT_CHAR.test(src[e])) e++
        for (;;) {
          if (src[e] === "." && IDENT_START.test(src[e + 1] || "")) for (e++; e < y && IDENT_CHAR.test(src[e]); ) e++
          else if (src[e] === "(" || src[e] === "[") e = groupEnd(e)
          else break
        }
        if (e > y) return null
        gaps.push([t, e])
        t = e
      }
      return gaps
    }
    // The content block's bracket before `a` (`dir` -1) or from `b` on.
    const bracket = (t, dir) => {
      let depth = 0
      for (; t > k && t < to; t += dir) {
        const c = src[t]
        if (c === (dir < 0 ? ")" : "(") || c === (dir < 0 ? "]" : "[") || c === (dir < 0 ? "}" : "{")) depth++
        else if (c === "(" || c === "[" || c === "{" || c === ")" || c === "]" || c === "}") {
          if (depth-- === 0) return c === (dir < 0 ? "[" : "]") ? t : -1
        }
      }
      return -1
    }
    const placeholder = new RegExp(`#${param[1]}(?:\\.body)?(?![\\p{L}\\p{N}_\\-([]|\\.[\\p{L}_])`, "gu")
    placeholder.lastIndex = PARAM_Y.lastIndex
    for (let m = placeholder.exec(src); m && m.index < to; m = placeholder.exec(src)) {
      let a = m.index
      while (a > k && literal(a - 1)) a--
      let b = placeholder.lastIndex
      while (b < to && literal(b)) b++
      let preGaps = []
      let sufGaps = []
      const open = src[a - 1] === "[" ? -1 : bracket(a - 1, -1)
      const close = src[b] === "]" ? -1 : bracket(b, 1)
      const before = open >= 0 ? through(open + 1, a) : null
      const after = close >= 0 ? through(b, close) : null
      if (before) {
        a = open + 1
        preGaps = before
      }
      if (after) {
        b = close
        sufGaps = after
      }
      const pre = [a, m.index, src[a - 1] !== "[", preGaps]
      const suf = [placeholder.lastIndex, b, src[b] !== "]", sufGaps]
      const shown = (x, y, gaps) => gaps.reduce((t, [g, e]) => t.slice(0, g - x) + " ".repeat(e - g) + t.slice(e - x), src.slice(x, y))
      if (ALNUM.test(shown(a, m.index, preGaps) + shown(placeholder.lastIndex, b, sufGaps))) rules.push({ pre, suf, element })
    }
  }

  // The file an `include` names (a string, a parenthesized string, or a name
  // bound to a string by `let`), reading past it.
  const includeTarget = () => {
    while (src[i] === " " || src[i] === "\t") i++
    const paren = src[i] === "("
    if (paren) i++
    while (src[i] === " " || src[i] === "\t") i++
    let target = null
    if (src[i] === '"') {
      const [a, b] = string()
      target = src.slice(a, b)
      mentions.push({ at: a, value: target })
    } else if (IDENT_START.test(src[i] || "")) {
      const name = identAt(i)
      i += name.length
      if (bindings.has(name)) target = bindings.get(name)
    }
    if (paren) code(")", 0, null, true)
    return target
  }

  while (i < n) markup(DISP | PROD, false)
  return { flags, includes, calls, defs, mentions, notes, markers, rules, pages }
}

// ── Virtual document ─────────────────────────────────────────────────────────
// The project's sources in reading order: the entry file with each included
// file spliced in right after its include line, then every other text source
// (CSV data, `#import`ed modules) as an appendix of regions, one per file, so
// text the document pulls from a data file still resolves to its row.
// `primaryEnd` marks where the appendix starts. `search` is `text` folded
// the way runs are (newlines as spaces, format characters dropped,
// compatibility characters folded), with `toText`/`toSearch` mapping offsets.

function foldSource(text) {
  if (!/[^\x00-\x7f]/.test(text)) {
    const id = (i) => i
    return { search: text.replace(/\n/g, " "), toText: id, toSearch: id }
  }
  const parts = []
  const map = [] // search offset -> text offset
  const back = new Int32Array(text.length + 1) // text offset -> search offset
  let len = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    let ch = String.fromCodePoint(cp)
    // A letter and the marks combining with it (`e` + U+0301) fold as one:
    // a run's text is folded whole, so decomposed accents compose on both
    // sides. Each folded character maps back to the cluster's start.
    if (cp !== 10 && !FORMAT_CHAR.test(ch)) {
      for (let j = i + ch.length; j < text.length; ) {
        const next = String.fromCodePoint(text.codePointAt(j))
        if (!COMBINING.test(next)) break
        ch += next
        j += next.length
      }
    }
    for (let k = 0; k < ch.length; k++) back[i + k] = len
    let rep
    if (cp === 10) rep = " "
    else if (ch.length === 1 && cp < 0x80) rep = ch
    else if (FORMAT_CHAR.test(ch)) rep = ""
    else rep = ch.normalize("NFKC")
    parts.push(rep)
    for (let k = 0; k < rep.length; k++) map.push(i)
    len += rep.length
    i += ch.length
  }
  back[text.length] = len
  map.push(text.length)
  const toText = (s) => map[Math.max(0, Math.min(s, map.length - 1))]
  const toSearch = (t) => back[Math.max(0, Math.min(t, back.length - 1))]
  return { search: parts.join(""), toText, toSearch }
}

export function buildVirtualDoc(bufferPath, bufferContent, sources, entryPath) {
  const byPath = new Map()
  for (const s of Array.isArray(sources) ? sources : []) {
    if (s && typeof s.path === "string") byPath.set(cleanPath(s.path), s.content || "")
  }
  const buffer = cleanPath(bufferPath) || "main.typ"
  byPath.set(buffer, bufferContent || "")
  const entry = cleanPath(entryPath)
  const main = entry && byPath.has(entry) ? entry : buffer

  const lexed = new Map()
  const lexOf = (file) => {
    if (!lexed.has(file)) {
      const typst = /\.typ$/i.test(file)
      lexed.set(file, typst ? lexTypst(byPath.get(file), (v) => byPath.has(resolveInclude(file, v))) : null)
    }
    return lexed.get(file)
  }

  const lines = []
  const local = [] // per line: its offset inside its file
  const fileLines = new Map() // file -> doc line index of each of its lines
  const visited = new Set()
  const expand = (file, depth) => {
    if (visited.has(file) || depth > MAX_INCLUDE_DEPTH) return
    const content = byPath.get(file)
    if (content == null) return
    visited.add(file)
    const lex = lexOf(file)
    const own = []
    fileLines.set(file, own)
    const texts = content.split("\n")
    const after = new Map() // line number -> include targets, in order
    if (lex) {
      let k = 0
      let off = 0
      for (const inc of lex.includes) {
        while (k < texts.length - 1 && off + texts[k].length < inc.at) off += texts[k++].length + 1
        if (!after.has(k)) after.set(k, [])
        after.get(k).push(inc.target)
      }
    }
    let off = 0
    texts.forEach((text, k) => {
      own.push(lines.length)
      lines.push({ file, line: k + 1, text })
      local.push(off)
      off += text.length + 1
      for (const target of after.get(k) || []) expand(resolveInclude(file, target), depth + 1)
    })
  }
  // Which of a file's lines (doc line indices `own`) holds its offset `at`.
  const lineIn = (own, at) => {
    let lo = 0
    let hi = own.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (local[own[mid]] <= at) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  expand(main, 0)
  const primaryLines = lines.length
  // The other files become regions in an order that does not depend on how
  // the sources are listed: a file another file includes is spliced into
  // its first includer; the others come in the order the primary text names
  // them (`#for f in ("a.typ", "c.typ") { include f }`, `csv("data.csv")`),
  // then by path. Files only reachable through a cycle come last, by path.
  const included = new Set()
  const named = new Map() // file -> [doc line, offset in its file] of its first mention in the primary
  for (const file of byPath.keys()) {
    const lex = lexOf(file)
    if (!lex) continue
    for (const inc of lex.includes) included.add(resolveInclude(file, inc.target))
    const own = fileLines.get(file)
    if (!own || own[0] >= primaryLines) continue
    for (const m of lex.mentions) {
      const target = resolveInclude(file, m.value)
      const line = own[lineIn(own, m.at)]
      const prev = named.get(target)
      if (!prev || line < prev[0] || (line === prev[0] && m.at < prev[1])) named.set(target, [line, m.at])
    }
  }
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const rest = [...byPath.keys()].filter((f) => !visited.has(f)).sort(byName)
  const roots = rest.filter((f) => !included.has(f))
  const rank = (f) => named.get(f) || [Infinity, 0]
  roots.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1] || byName(a, b))
  const regionLines = [0] // first line of each region: the primary, then one per file
  const regionFiles = [main]
  for (const file of [...roots, ...rest]) {
    const before = lines.length
    expand(file, 0)
    if (lines.length > before) {
      regionLines.push(before)
      regionFiles.push(file)
    }
  }

  const starts = []
  let text = ""
  for (const l of lines) {
    starts.push(text.length)
    text += l.text + "\n"
  }
  const primaryEnd = primaryLines < lines.length ? starts[primaryLines] : text.length

  // What each character is for (text offsets): Typst files from their scan,
  // data files are all text.
  const flagsT = new Uint8Array(text.length)
  lines.forEach((l, k) => {
    const lex = lexed.get(l.file)
    if (lex) flagsT.set(lex.flags.subarray(local[k], local[k] + l.text.length), starts[k])
    else flagsT.fill(DISP, starts[k], starts[k] + l.text.length)
  })
  // A file-local offset of `file` as a doc text offset.
  const docOffset = (file, at) => {
    const own = fileLines.get(file)
    if (!own) return null
    const idx = own[lineIn(own, at)]
    return starts[idx] + Math.min(at - local[idx], lines[idx].text.length)
  }

  const fold = foldSource(text)
  const search = fold.search
  const flags = new Uint8Array(search.length)
  for (let s = 0; s < search.length; s++) flags[s] = flagsT[fold.toText(s)]
  const primaryEndS = fold.toSearch(primaryEnd)
  const regions = regionLines.map((line, k) => ({
    file: regionFiles[k],
    data: !lexed.get(regionFiles[k]),
    start: fold.toSearch(starts[line]),
    end: k + 1 < regionLines.length ? fold.toSearch(starts[regionLines[k + 1]]) : k === 0 ? primaryEndS : search.length
  }))
  regions[0].end = primaryEndS

  // Pictures come from `image(...)` or from a name whose `let` shows one.
  const pictureNames = new Set(["image"])
  for (let grew = true; grew; ) {
    grew = false
    for (const [file, lex] of lexed) {
      if (!lex) continue
      for (const d of lex.defs) {
        if (pictureNames.has(d.name)) continue
        if (lex.calls.some((c) => c.at >= d.from && c.at < d.to && pictureNames.has(c.name))) {
          pictureNames.add(d.name)
          grew = true
        }
      }
    }
  }
  const calls = []
  const mentions = []
  const notes = [] // footnote texts (search offsets), in source order
  const markers = [] // list and enum markers (text offsets) that render where they stand
  const rules = [] // the literal text show rules print around what they show (search offsets)
  const pages = [] // what `set page` rules set on every page (search offsets)
  // What the project defines, by name: where each `let` stands (search
  // offsets) and the names called inside it, so text that a call prints
  // from a definition can be found there.
  const defs = new Map()
  for (const [file, lex] of lexed) {
    if (!lex) continue
    for (const c of lex.calls) {
      if (c.decl || SILENT_CALLS.has(c.name) || c.name === "update") continue
      const at = docOffset(file, c.at)
      if (at != null) calls.push({ at, name: c.name, picture: pictureNames.has(c.name) })
    }
    const callAt = lex.calls.map((c) => c.at)
    for (const d of lex.defs) {
      const a = docOffset(file, d.from)
      const b = docOffset(file, d.to)
      if (a == null || b == null) continue
      const callees = new Set()
      for (let k = lowerBound(callAt, d.from); k < lex.calls.length && lex.calls[k].at < d.to; k++) callees.add(lex.calls[k].name)
      if (!defs.has(d.name)) defs.set(d.name, [])
      defs.get(d.name).push({ from: fold.toSearch(a), to: fold.toSearch(b), callees })
    }
    for (const m of lex.mentions) {
      const target = resolveInclude(file, m.value)
      const region = regionFiles.indexOf(target)
      const at = docOffset(file, m.at)
      if (region > 0 && at != null) mentions.push({ at: fold.toSearch(at), region })
    }
    for (const m of lex.markers) {
      const at = m.decl ? null : docOffset(file, m.at)
      if (at != null) markers.push(at)
    }
    for (const rule of lex.rules) {
      const [pre, suf] = [rule.pre, rule.suf].map(([a, b, open, gaps]) => {
        const at = docOffset(file, a)
        const s = (x) => fold.toSearch(at + x - a)
        return at == null ? null : [s(a), s(b), open, gaps.map(([g, e]) => [s(g), s(e)])]
      })
      if (pre && suf) rules.push({ pre, suf, element: rule.element })
    }
    for (const nt of lex.notes) {
      const a = docOffset(file, nt.from)
      const b = docOffset(file, nt.to)
      if (a != null && b != null && b > a) notes.push({ from: fold.toSearch(a), to: fold.toSearch(b) })
    }
    for (const pg of lex.pages) {
      const a = docOffset(file, pg.from)
      const b = docOffset(file, pg.to)
      if (a != null && b != null && b > a) pages.push({ from: fold.toSearch(a), to: fold.toSearch(b) })
    }
  }
  calls.sort((a, b) => a.at - b.at)
  mentions.sort((a, b) => a.at - b.at)
  notes.sort((a, b) => a.from - b.from)
  markers.sort((a, b) => a - b)

  // Lines that render something where they stand (not blank, a comment, a
  // declaration, a closing bracket or a spacing call).
  const lineProd = new Uint8Array(lines.length)
  lines.forEach((l, k) => {
    for (let t = starts[k]; t < starts[k] + l.text.length; t++) {
      if (flagsT[t] & PROD && text.charCodeAt(t) > 32) {
        lineProd[k] = 1
        break
      }
    }
  })

  return {
    lines,
    starts,
    text,
    search,
    toText: fold.toText,
    toSearch: fold.toSearch,
    flags,
    primaryEnd,
    primaryEndS,
    primaryLines,
    regions,
    calls,
    defs,
    mentions,
    notes,
    markers,
    rules,
    pages,
    lineProd
  }
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

// Claims on source characters: matched text owns them; the literal words of
// a mixed run may be shared by the next items of a loop; a producer (`@key`,
// `#footnote`) shown by a placed mark is not handed to the next mark.
const FULL = 1
const SHARED = 2
const SHOWN = 3

function lowerBound(list, x) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

function regionOf(doc, s) {
  const rs = doc.regions
  let lo = 0
  let hi = rs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (rs[mid].start <= s) lo = mid
    else hi = mid - 1
  }
  return lo
}

function charBefore(S, k) {
  if (k <= 0) return ""
  const c = S.charCodeAt(k - 1)
  return c >= 0xdc00 && c <= 0xdfff && k >= 2 ? S.slice(k - 2, k) : S[k - 1]
}

function charAt(S, k) {
  return k < S.length ? String.fromCodePoint(S.codePointAt(k)) : ""
}

// Everything matching needs, built once per alignment: the words of the
// sources in order (`words`: where each starts and ends) and, per word, its
// ordinals in that list (so a run is looked up by its rarest word instead of
// scanned for), which characters cannot be part of rendered text, and which
// are already claimed.
function alignmentContext(doc, runs) {
  const S = doc.search
  const bad = new Int32Array(S.length + 1)
  for (let k = 0; k < S.length; k++) {
    const c = S.charCodeAt(k)
    bad[k + 1] = bad[k] + (c > 32 && c !== 160 && !(doc.flags[k] & DISP) ? 1 : 0)
  }
  const pos = []
  const end = []
  const text = []
  const index = new Map()
  const re = /[\p{L}\p{N}]+/gu
  for (let m = re.exec(S); m; m = re.exec(S)) {
    const list = index.get(m[0])
    if (list) list.push(text.length)
    else index.set(m[0], [text.length])
    pos.push(m.index)
    end.push(m.index + m[0].length)
    text.push(m[0])
  }
  const words = { pos: Int32Array.from(pos), end: Int32Array.from(end), text }
  return { doc, S, runs, bad, words, index, lower: null, claimed: new Uint8Array(S.length + 1), compiled: new Map() }
}

// The first word ordinal of `list` starting at or after `at`.
function firstWordFrom(ctx, list, at) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ctx.words.pos[list[mid]] < at) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Where each word occurs ignoring case (a run printed through `upper()`).
function lowerIndex(ctx) {
  if (!ctx.lower) {
    const lower = new Map()
    for (const [word, list] of ctx.index) {
      const key = word.toLowerCase()
      const at = list.map((o) => ctx.words.pos[o])
      const have = lower.get(key)
      lower.set(key, have ? have.concat(at) : at)
    }
    for (const [key, list] of lower) if (list.length > 1) lower.set(key, list.slice().sort((a, b) => a - b))
    ctx.lower = lower
  }
  return ctx.lower
}

function compiled(ctx, text, relaxStart, relaxEnd) {
  const key = `${relaxStart ? 1 : 0}${relaxEnd ? 1 : 0}${text}`
  let m = ctx.compiled.get(key)
  if (!m) {
    m = compileRun(text, relaxStart, relaxEnd)
    m.key = key
    ctx.compiled.set(key, m)
  }
  return m
}

function isFree(ctx, a, b, shared) {
  for (let k = a; k < b; k++) {
    const c = ctx.claimed[k]
    if (c && !(shared && c === SHARED)) return false
  }
  return true
}

// An occurrence is usable when it is text in the source (no code, comment or
// markup syntax inside it), whole words at both ends (unless relaxed) and
// free. The whole match is preferred; when its decoration is not text there
// (the quotes of a code string), the core alone.
function usable(ctx, m, start, coreStart, coreEnd, end, led, taken = false) {
  const { S } = ctx
  for (const [a, b, from] of [
    [start, end, led ? 0 : m.coreFrom],
    [coreStart, coreEnd, m.coreFrom]
  ]) {
    if (b <= a || ctx.bad[b] - ctx.bad[a]) continue
    if (!m.relaxStart && ALNUM.test(charAt(S, a)) && ALNUM.test(charBefore(S, a))) continue
    if (!m.relaxEnd && ALNUM.test(charBefore(S, b)) && ALNUM.test(charAt(S, b))) continue
    if (!taken && !isFree(ctx, a, b, false)) continue
    return { start: a, end: b, matchFrom: from }
  }
  return null
}

// Free occurrences of the run inside [lo, hi), in source order, at most
// `limit` (with `taken`, claimed ones too). A run with a whole word is
// looked up by its rarest one: the source words around each occurrence must
// be the run's words, with the same separators once folded. Others
// (punctuation, a fragment of a line in a script without spaces) are scanned
// for inside the bounds.
function occurrences(ctx, m, lo, hi, limit = Infinity, taken = false) {
  const out = []
  if (hi <= lo || !m.text) return out
  const { S, words } = ctx
  if (m.complete.length) {
    let anchorAt = -1
    let list = null
    for (const k of m.complete) {
      const l = ctx.index.get(m.tokens[k].text)
      if (!l) return out
      if (!list || l.length < list.length) {
        list = l
        anchorAt = k
      }
    }
    const n = m.tokens.length
    const last = n - 1
    for (let k = firstWordFrom(ctx, list, lo); k < list.length && words.pos[list[k]] < hi; k++) {
      const o0 = list[k] - anchorAt
      if (o0 < 0 || o0 + n > words.text.length) continue
      let ok = true
      for (let j = 0; j < n && ok; j++) {
        const src = words.text[o0 + j]
        const t = m.tokens[j].text
        if (src === t) continue
        const open0 = j === 0 && m.openStart
        const open1 = j === last && m.openEnd
        ok = open0 && open1 ? src.includes(t) : open0 ? src.endsWith(t) : open1 ? src.startsWith(t) : false
      }
      for (let j = 1; j < n && ok; j++) {
        const sep = S.slice(words.end[o0 + j - 1], words.pos[o0 + j])
        ok = sep === m.seps[j - 1] || foldSeparator(sep) === m.seps[j - 1]
      }
      if (!ok) continue
      const first = words.text[o0]
      let coreStart = words.pos[o0]
      if (first !== m.tokens[0].text) coreStart += m.openEnd && n === 1 ? first.indexOf(m.tokens[0].text) : first.length - m.tokens[0].text.length
      const coreEnd = n === 1 ? coreStart + m.tokens[0].text.length : words.pos[o0 + last] + m.tokens[last].text.length
      // The decoration, when the source spells it right around the words.
      let start = coreStart
      let end = coreEnd
      if (m.leadF) {
        const floor = Math.max(lo, o0 > 0 ? words.end[o0 - 1] : 0)
        for (let a = coreStart - 1; a >= floor; a--) {
          const f = foldSeparator(S.slice(a, coreStart))
          if (f === m.leadF) {
            start = a
            break
          }
          if (f.length > m.leadF.length + 1) break
        }
      }
      if (m.trailF) {
        const ceil = Math.min(hi, o0 + n < words.text.length ? words.pos[o0 + n] : S.length)
        for (let b = coreEnd + 1; b <= ceil; b++) {
          const f = foldSeparator(S.slice(coreEnd, b))
          if (f === m.trailF) {
            end = b
            break
          }
          if (f.length > m.trailF.length + 1) break
        }
      }
      const hit = usable(ctx, m, start, coreStart, coreEnd, end, start < coreStart, taken)
      if (hit && !(out.length && hit.start < out[out.length - 1].end)) {
        out.push(hit)
        if (out.length >= limit) break
      }
    }
    return out
  }
  const re = scanRegex(m)
  const seg = S.slice(lo, hi)
  re.lastIndex = 0
  for (let x = re.exec(seg); x; x = re.exec(seg)) {
    if (!x[0].length) {
      re.lastIndex++
      continue
    }
    const start = lo + x.index
    const end = start + x[0].length
    const g = x.indices && x.indices.groups
    const hit = usable(ctx, m, start, g ? lo + g.c[0] : start, g ? lo + g.c[1] : end, end, !!(g && g.l), taken)
    if (hit) {
      out.push(hit)
      if (out.length >= limit) break
      re.lastIndex = Math.max(x.index + 1, hit.end - lo)
    } else re.lastIndex = x.index + 1
  }
  return out
}

// The heaviest chain of matches that keeps both orders (run order and source
// order, without overlaps): a longest-increasing-subsequence over weighted
// candidates. Items are { ri, start, end, w }; ties go to the later run, so a
// body heading wins over its outline entry rendered before it. A `compact`
// chain (the words of one printed record) prefers, among equally heavy ones,
// the one ending first, each word followed closely by the next: a value
// repeated in later records stays with the record it opened.
function heaviestChain(items, compact = false) {
  if (!items.length) return []
  items.sort((a, b) => a.ri - b.ri || b.start - a.start)
  const ends = [...new Set(items.map((x) => x.end))].sort((a, b) => a - b)
  const size = ends.length
  const treeW = new Float64Array(size + 1)
  const treeI = new Int32Array(size + 1).fill(-1)
  const better = compact
    ? (w, i, w2, i2) => i2 < 0 || w > w2 || (w === w2 && items[i].end > items[i2].end)
    : (w, i, w2, i2) => i2 < 0 || w > w2 || (w === w2 && items[i].ri > items[i2].ri)
  const best = new Float64Array(items.length)
  const prev = new Int32Array(items.length)
  for (let k = 0; k < items.length; ) {
    let g = k
    while (g < items.length && items[g].ri === items[k].ri) g++
    for (let t = k; t < g; t++) {
      // Best chain ending at or before this item's start.
      let qi = -1
      let qw = 0
      for (let p = lowerBound(ends, items[t].start + 1); p > 0; p -= p & -p) {
        if (treeI[p] >= 0 && better(treeW[p], treeI[p], qw, qi)) {
          qw = treeW[p]
          qi = treeI[p]
        }
      }
      best[t] = items[t].w + qw
      prev[t] = qi
    }
    for (let t = k; t < g; t++) {
      for (let p = lowerBound(ends, items[t].end) + 1; p <= size; p += p & -p) {
        if (better(best[t], t, treeW[p], treeI[p])) {
          treeW[p] = best[t]
          treeI[p] = t
        }
      }
    }
    k = g
  }
  let top = -1
  for (let t = 0; t < items.length; t++) {
    if (top < 0 || (compact ? best[t] > best[top] || (best[t] === best[top] && items[t].end < items[top].end) : better(best[t], t, best[top], top))) top = t
  }
  const out = []
  for (let t = top; t >= 0; t = prev[t]) out.push(items[t])
  return out.reverse()
}

function anchor(ctx, r, hit, kind) {
  const { doc } = ctx
  r.searchStart = hit.start
  r.searchEnd = hit.end
  r.start = doc.toText(hit.start)
  r.end = doc.toText(hit.end)
  r.matchFrom = hit.matchFrom || 0
  r.anchored = true
  r.kind = kind
  r.ordered = kind === "ordered"
  r.repeat = kind === "copy"
  r.weak = kind === "copy" || kind === "partial" || kind === "field" || kind === "template"
  r.region = regionOf(doc, hit.start)
  if (hit.tokens) r.tokens = hit.tokens
  // Built on the first click only: most runs are never clicked. Over the
  // text matched now, which `joinRuleRuns` widens back to the whole run.
  const text = r.text
  r.spots = () => spotsOf(doc, text, hit)
  if (kind === "ordered" || kind === "loose" || kind === "words") ctx.claimed.fill(FULL, hit.start, hit.end)
}

// A run's word found at search offset `s` (null when not found): `src` is
// its text offset (what a caret is compared with), `s` where the click
// mapping walks from.
function token(doc, text, at, s) {
  return { text, at, s, src: s == null ? null : doc.toText(s) }
}

// ── Click spots ──────────────────────────────────────────────────────────────
// Where each character of a matched run lies in the sources: the run's text
// walked against the source it matched under the same folding as matching
// (a space for any whitespace run, or none next to a quote; any quotation
// mark; `---` or an em dash; an escape before punctuation; format characters
// already dropped on both sides), so a click lands on the character under
// the pointer whatever the source spells around it.
const SOURCE_WS = /[\s~]/

function sameChar(a, b) {
  return a === b || a.toLowerCase() === b.toLowerCase()
}

// Walks text[k0, k1) against the search text from `s` (not past `sEnd`),
// writing the search offset of each character into `map`; returns where
// the walk ended in the source.
function walkSpots(S, text, k0, k1, s, sEnd, map) {
  let k = k0
  while (k < k1) {
    map[k] = s
    const c = text[k]
    if (c === " ") {
      while (s < sEnd && SOURCE_WS.test(S[s])) s++
      k++
    } else if (c === "-" && text.startsWith("---", k) && k + 3 <= k1) {
      if (S.startsWith("---", s) && s + 3 <= sEnd) s += 3
      else if (S[s] === "\u2014" && s < sEnd) s++
      map[k + 1] = map[k + 2] = map[k]
      k += 3
    } else if (c === "-" && text[k + 1] === "-" && k + 2 <= k1) {
      if (S.startsWith("--", s) && s + 2 <= sEnd) s += 2
      else if (S[s] === "\u2013" && s < sEnd) s++
      map[k + 1] = map[k]
      k += 2
    } else if (c === "-") {
      if (s < sEnd && (S[s] === "-" || S[s] === "\u2010")) s++
      k++
    } else if (IS_QUOTE.test(c)) {
      // The spaces around a quote are optional on both sides.
      let t = s
      while (t < sEnd && SOURCE_WS.test(S[t])) t++
      if (S[t] === "\\") t++
      if (t < sEnd && IS_QUOTE.test(S[t])) s = t + 1
      k++
    } else {
      const ch = String.fromCodePoint(text.codePointAt(k))
      const len = ch.length
      if (len > 1) map[k + 1] = s
      if (ALNUM.test(ch)) {
        // A letter is in the source as such; what folding ignores (a
        // space, `~`, an escape, a quote) may stand before it.
        let t = s
        while (t < sEnd && !sameChar(S.slice(t, t + len), ch) && (SOURCE_WS.test(S[t]) || S[t] === "\\" || IS_QUOTE.test(S[t]))) t++
        if (t + len <= sEnd && sameChar(S.slice(t, t + len), ch)) {
          map[k] = t
          if (len > 1) map[k + 1] = t
          s = t + len
        }
      } else if (S[s] === "\\" && S.startsWith(ch, s + 1) && s + 1 + len <= sEnd) s += 1 + len
      else if (S.startsWith(ch, s) && s + len <= sEnd) s += len
      k += len
    }
  }
  map[k1] = s
  return s
}

// The run's spots as text offsets, one per character of its normalized text
// and one for its end. A run matched as a whole walks from where its match
// starts; a run matched word by word walks each word from its own spot (a
// value of a mixed run may lie in a data file). A word found nowhere right
// after text found, where the source goes on with code (`In all
// #crew.len() sailors`, `[Sheet #counter(page).display()]`), is that
// code's value: it takes the code's start. A
// character with no spot of its own (a generated label, a quote the source
// does not spell, what separates words found apart) takes the spot after
// the text before it, or the first spot.
function spotsOf(doc, text, hit) {
  const S = doc.search
  const n = text.length
  const map = new Int32Array(n + 1).fill(-1)
  if (hit.tokens) {
    for (const t of hit.tokens) {
      if (t.s == null || t.at >= n) continue
      walkSpots(S, text, t.at, Math.min(n, t.at + t.text.length), t.s, S.length, map)
      // Marks the run shows right before the word that the source writes
      // right before it too (the `+` of a value `+39 055`) are its own.
      for (let k = t.at - 1, s = t.s - 1; k >= 0 && s >= 0 && map[k] < 0 && !ALNUM.test(text[k]) && text[k] !== " " && S[s] === text[k]; k--, s--) map[k] = s
    }
    let prev = -1
    for (let k = 0; k < n; k++) {
      if (map[k] >= 0) {
        prev = k
        continue
      }
      if (prev < 0 || !ALNUM.test(text[k]) || ALNUM.test(text[k - 1] || "")) continue
      let next = k + 1
      while (next <= n && map[next] < 0) next++
      const [, lineEnd] = lineBoundsS(doc, doc.toText(map[prev]))
      // Past the marks and spaces the source spells after that text just
      // as the run does (`Nimi: #p.at("name")`), a quotation mark as any
      // (`und „#p.b“`: the run's quotes are folded straight).
      let q = map[prev]
      for (let j = prev; j < k && q < lineEnd; j++) {
        if (text[j] === " ") while (q < lineEnd && SOURCE_WS.test(S[q])) q++
        else if ((S[q] === text[j] || (IS_QUOTE.test(text[j]) && IS_QUOTE.test(S[q]))) && !ALNUM.test(text[j])) q++
        else break
      }
      while (q < lineEnd && SOURCE_WS.test(S[q])) q++
      if (q < lineEnd && (next > n || q < map[next]) && !(doc.flags[q] & DISP) && (S[q] === "#" || doc.flags[q] & PROD)) map[k] = q
    }
  } else walkSpots(S, text, Math.min(hit.matchFrom || 0, n), n, hit.start, hit.end, map)
  let last = -1
  for (let k = 0; k <= n && last < 0; k++) last = map[k]
  if (last < 0) last = hit.start
  for (let k = 0; k <= n; k++) {
    if (map[k] >= 0) last = map[k]
    map[k] = doc.toText(last)
  }
  return map
}

function chainInto(ctx, items, kind) {
  for (const it of heaviestChain(items)) anchor(ctx, ctx.runs[it.ri], it, kind)
}

// The runs found in reading order in the document body, as the gaps between
// them: fn(from, to, lo, hi) for the runs strictly between two of them and
// the source stretch between their texts.
function forEachGap(ctx, fn) {
  const { runs, doc } = ctx
  let from = 0
  let lo = doc.regions[0].start
  for (let i = 0; i <= runs.length; i++) {
    const r = runs[i]
    if (i < runs.length && !(r.ordered && r.region === 0)) continue
    fn(from, i, lo, i < runs.length ? r.searchStart : doc.regions[0].end)
    if (i < runs.length) {
      from = i + 1
      lo = r.searchEnd
    }
  }
}

function chainGap(ctx, from, to, lo, hi) {
  if (hi <= lo) return
  const items = []
  for (let i = from; i < to; i++) {
    const r = ctx.runs[i]
    if (r.anchored || !r.m) continue
    for (const hit of occurrences(ctx, r.m, lo, hi)) items.push({ ri: i, ...hit, w: hit.end - hit.start })
  }
  chainInto(ctx, attachedOnly(ctx, items, from, to), "ordered")
}

// A run of punctuation alone takes no mark that a Typst source writes right
// after a word of text when another run of the gap, still unplaced, shows
// that word with the mark: an outline's leader dots never take the period
// of a header's `Стр.`, which its own run shows.
function attachedOnly(ctx, items, from, to) {
  const { runs, S, doc } = ctx
  const lone = (it) => !ALNUM.test(runs[it.ri].text) && !doc.regions[regionOf(doc, it.start)].data
  if (!items.some(lone)) return items
  const shown = new Map() // the word with its mark -> whether an unplaced run shows it
  const showsWord = (word) => {
    if (!shown.has(word)) {
      let found = false
      for (let i = Math.max(0, from - 1); i <= Math.min(runs.length - 1, to) && !found; i++) found = !runs[i].anchored && runs[i].text.includes(word)
      shown.set(word, found)
    }
    return shown.get(word)
  }
  return items.filter((it) => {
    if (!lone(it)) return true
    let k = it.start
    while (k > 0 && ALNUM.test(S[k - 1]) && doc.flags[k - 1] & DISP) k--
    return k === it.start || !showsWord(S.slice(k, it.end))
  })
}

// Whether [a, b) of a data file covers whole values: it starts and ends at
// a field boundary (a delimiter, a bracket or quote, a line end).
function wholeFields(doc, a, b) {
  const text = doc.text
  let t = doc.toText(a)
  let e = doc.toText(b)
  while (t > 0 && text[t - 1] === " ") t--
  while (e < text.length && text[e] === " ") e++
  return (t === 0 || FIELD_DELIM.test(text[t - 1])) && (e >= text.length || FIELD_DELIM.test(text[e]))
}

// 1. A text rendered exactly as often as the sources hold it pairs up with
// those occurrences in order; the heaviest chain of pairs per region is the
// backbone. In a data file a printed value is a whole value: an occurrence
// inside a longer cell (`bird` in `wading bird of marshes`) belongs to that
// cell's run, not to this pairing.
function pairCorrespondences(ctx) {
  const { runs, S, doc } = ctx
  const groups = new Map()
  runs.forEach((r, i) => {
    if (!r.m || !r.m.complete.length) return
    if (!groups.has(r.m.key)) groups.set(r.m.key, [])
    groups.get(r.m.key).push(i)
  })
  const byRegion = new Map()
  for (const idxs of groups.values()) {
    const occ = occurrences(ctx, runs[idxs[0]].m, 0, S.length, idxs.length + 1)
    if (occ.length !== idxs.length) continue
    idxs.forEach((ri, k) => {
      const g = regionOf(doc, occ[k].start)
      if (doc.regions[g].data && !wholeFields(doc, occ[k].start, occ[k].end)) return
      if (!byRegion.has(g)) byRegion.set(g, [])
      byRegion.get(g).push({ ri, ...occ[k], w: occ[k].end - occ[k].start })
    })
  }
  // Printed data need not keep the file's order (a table printed reversed,
  // sorted or filtered): a value with letters found exactly once in its file
  // is that value wherever it prints (where two such values overlap, the
  // heavier one, else the later one, keeps it). Values repeated in the file
  // then go to the records of the values printed next to them (1b); only
  // what is left pairs in order. Bare numbers keep the order (in the body
  // they may be page numbers).
  const single = (it) => groups.get(runs[it.ri].m.key).length === 1 && LETTER.test(runs[it.ri].text)
  const later = []
  for (const [g, items] of byRegion) {
    if (!doc.regions[g].data) {
      chainInto(ctx, items, "ordered")
      continue
    }
    for (const it of items.filter(single).sort((a, b) => b.w - a.w || b.ri - a.ri)) {
      if (isFree(ctx, it.start, it.end, false)) anchor(ctx, runs[it.ri], it, "ordered")
    }
    later.push(items.filter((it) => !single(it)))
  }
  matchRecords(ctx)
  for (const items of later) chainInto(ctx, items.filter((it) => !runs[it.ri].anchored && isFree(ctx, it.start, it.end, false)), "ordered")
}

// 1b. A value repeated in its data file (`active` on many rows) is found in
// the record (line) of a value printed next to it, when that record holds
// it once: a table printed in another order than its file still pairs each
// cell with its own row.
function matchRecords(ctx) {
  const { runs, doc } = ctx
  // The nearest run with words before or after run i, if it is matched in
  // a data file.
  const near = (i, step) => {
    for (let k = i + step; k >= 0 && k < runs.length; k += step) {
      const q = runs[k]
      if (!q.m || !q.m.complete.length) continue
      return q.anchored && doc.regions[q.region].data ? q : null
    }
    return null
  }
  runs.forEach((r, i) => {
    if (r.anchored || !r.m || !r.m.complete.length) return
    for (const q of [near(i, -1), near(i, 1)]) {
      if (!q) continue
      const [lo, hi] = lineBoundsS(doc, q.start)
      const hits = occurrences(ctx, r.m, lo, hi, 2)
      if (hits.length === 1 && wholeFields(doc, hits[0].start, hits[0].end)) {
        anchor(ctx, r, hits[0], "ordered")
        return
      }
    }
  })
}

// 1c. A footnote's text is set in the footnote area at the bottom of its
// page, after the page's flow (which ends with the page's last run found in
// reading order outside a footnote), and the entries there follow the order
// of their `#footnote` calls. So the runs after the flow of their page pair
// with the footnotes' texts keeping both orders (the heaviest chain, between
// the footnote runs step 1 already placed): a short or repeated text
// (`Note 1.`, `Ibid.`) goes to its own call. The marker in the flow is not
// among them; it is placed at its call (`#footnote`) later.
function matchNotes(ctx) {
  const { runs, doc } = ctx
  const notes = doc.notes
  if (!notes.length) return
  const froms = notes.map((nt) => nt.from)
  const noteAt = (s) => {
    const k = lowerBound(froms, s + 1) - 1
    return k >= 0 && s < notes[k].to ? k : -1
  }
  const flowEnd = new Map()
  runs.forEach((r, i) => {
    if (r.ordered && r.region === 0 && noteAt(r.searchStart) < 0) flowEnd.set(r.page, i)
  })
  const fixed = []
  runs.forEach((r, i) => {
    if (r.anchored && noteAt(r.searchStart) >= 0) fixed.push(i)
  })
  const items = []
  let f = 0
  runs.forEach((r, i) => {
    while (f < fixed.length && fixed[f] < i) f++
    if (r.anchored || !r.m || i <= (flowEnd.has(r.page) ? flowEnd.get(r.page) : -1)) return
    const lo = f > 0 ? runs[fixed[f - 1]].searchEnd : 0
    const hi = f < fixed.length ? runs[fixed[f]].searchStart : ctx.S.length
    for (const nt of notes) {
      if (nt.to <= lo) continue
      if (nt.from >= hi) break
      for (const hit of occurrences(ctx, r.m, Math.max(lo, nt.from), Math.min(hi, nt.to))) items.push({ ri: i, ...hit, w: hit.end - hit.start })
    }
  })
  chainInto(ctx, items, "loose")
}

// The data regions named by file names in [lo, hi) of the sources.
function mentionsIn(doc, lo, hi) {
  const list = doc.mentions
  let a = 0
  let b = list.length
  while (a < b) {
    const mid = (a + b) >> 1
    if (list[mid].at < lo) a = mid + 1
    else b = mid
  }
  const out = []
  for (let k = a; k < list.length && list[k].at < hi; k++) out.push(list[k].region)
  return out
}

// 2. Between two backbone runs, the runs in between are matched in the
// source stretch between them (the heaviest chain again). Runs printed from
// a data file are matched in that file between the values already found
// there, from where the previous gap left off: the files of the values found
// in the gap and the files its source names (`csv("a.csv")`).
function matchGaps(ctx) {
  const { runs, doc } = ctx
  forEachGap(ctx, (from, to, lo, hi) => chainGap(ctx, from, to, lo, hi))
  const reading = new Map() // region -> where the last run found there ends
  forEachGap(ctx, (from, to, lo, hi) => {
    const regions = new Set(mentionsIn(doc, lo, hi))
    for (let i = from; i < to; i++) if (runs[i].anchored && runs[i].region > 0) regions.add(runs[i].region)
    for (const g of regions) {
      const R = doc.regions[g]
      let cursor = reading.has(g) ? reading.get(g) : R.start
      let prev = from
      const found = []
      for (let i = from; i < to; i++) if (runs[i].ordered && runs[i].region === g) found.push(i)
      for (const a of [...found, to]) {
        const end = a < to ? runs[a].searchStart : R.end
        if (cursor < end) chainGap(ctx, prev, a, cursor, end)
        if (a < to) {
          cursor = Math.max(cursor, runs[a].searchEnd)
          prev = a + 1
        }
      }
    }
    for (let i = from; i < to; i++) {
      const r = runs[i]
      if (r.ordered && r.region > 0) reading.set(r.region, Math.max(reading.get(r.region) || 0, r.searchEnd))
    }
  })
}

// For each run, the nearest backbone runs of the document body before and
// after it (indices, -1 when none); `bound` may widen what counts.
const inBackbone = (r) => r.ordered && r.region === 0

function bodyNeighbours(ctx, bound = inBackbone) {
  const { runs } = ctx
  const prev = new Int32Array(runs.length)
  const next = new Int32Array(runs.length)
  let last = -1
  for (let i = 0; i < runs.length; i++) {
    prev[i] = last
    if (bound(runs[i])) last = i
  }
  last = -1
  for (let i = runs.length - 1; i >= 0; i--) {
    next[i] = last
    if (bound(runs[i])) last = i
  }
  return { prev, next }
}

function lineBoundsS(doc, t) {
  const idx = lineIndexAt(doc, t)
  return [doc.toSearch(doc.starts[idx]), doc.toSearch(doc.starts[idx] + doc.lines[idx].text.length)]
}

// The source between the body neighbours of run i: their texts excluded
// (`gap`) or their whole lines included (`lines`).
function spans(ctx, nb, i) {
  const { runs, doc } = ctx
  const p = nb.prev[i]
  const q = nb.next[i]
  const gap = [p >= 0 ? runs[p].searchEnd : doc.regions[0].start, q >= 0 ? runs[q].searchStart : doc.regions[0].end]
  const lines = [p >= 0 ? lineBoundsS(doc, runs[p].end)[0] : gap[0], q >= 0 ? lineBoundsS(doc, runs[q].start)[1] : gap[1]]
  return { gap, lines }
}

// The source that can have produced a page and the one before it (a float
// or a footnote may move to the next page): from the end of what the pages
// before showed to the start of what the pages after show. Without page
// information, the whole document body.
function pageWindows(ctx) {
  const { runs, doc } = ctx
  const pages = runs.reduce((n, r) => Math.max(n, (r.page || 0) + 1), 1)
  const lastEnd = new Array(pages).fill(-1)
  const firstStart = new Array(pages).fill(Infinity)
  for (const r of runs) {
    if (!(r.ordered && r.region === 0)) continue
    const p = r.page || 0
    lastEnd[p] = Math.max(lastEnd[p], r.searchEnd)
    firstStart[p] = Math.min(firstStart[p], r.searchStart)
  }
  for (let p = 1; p < pages; p++) lastEnd[p] = Math.max(lastEnd[p], lastEnd[p - 1])
  for (let p = pages - 2; p >= 0; p--) firstStart[p] = Math.min(firstStart[p], firstStart[p + 1])
  const body = doc.regions[0]
  return (page) => {
    const p = page || 0
    const lo = p >= 2 && lastEnd[p - 2] >= 0 ? lastEnd[p - 2] : body.start
    const hi = p + 1 < pages && firstStart[p + 1] < Infinity ? firstStart[p + 1] : body.end
    return [lo, Math.max(lo, hi)]
  }
}

// 3. Text displaced by layout: a footnote at the page bottom, a top float, a
// table cell spanning rows, the words of a right-to-left line rendered in
// visual order. Such a run is taken where its text occurs once, still free,
// in the lines of its neighbours, else (text with letters) in the source of
// its page.
function matchDisplaced(ctx) {
  const nb = bodyNeighbours(ctx)
  const page = pageWindows(ctx)
  ctx.runs.forEach((r, i) => {
    if (r.anchored || !r.m || !r.m.tokens.length) return
    const { lines } = spans(ctx, nb, i)
    let hits = occurrences(ctx, r.m, lines[0], lines[1], 2)
    if (hits.length !== 1 && LETTER.test(r.text)) {
      const [lo, hi] = page(r.page)
      hits = occurrences(ctx, r.m, lo, hi, 2)
    }
    if (hits.length === 1) anchor(ctx, r, hits[0], "loose")
  })
}

// A running header or footer (`set page(footer: [Internal draft ·
// #title])`) stands before or after the flow of each page: a run there that
// found nothing, whose literal words are in that content or in a
// definition it calls (in whichever file the rule stands), with its values
// where the names the content uses get them (the `let` string, what the
// template's call passes), whatever printed those already. Every page shows
// it again: only its literal words are claimed, shared. A run of literal
// words alone is a copy (`matchFurniture`).
function matchPageContent(ctx) {
  const { runs, doc } = ctx
  if (!doc.pages.length) return
  const nb = bodyNeighbours(ctx)
  const flow = new Map() // page -> [first, last] body run
  runs.forEach((r, i) => {
    if (!inBackbone(r)) return
    if (!flow.has(r.page)) flow.set(r.page, [i, i])
    else flow.get(r.page)[1] = i
  })
  const edge = (i) => !flow.has(runs[i].page) || i < flow.get(runs[i].page)[0] || i > flow.get(runs[i].page)[1]
  const sources = doc.pages.map((pg) => [[pg.from, pg.to], ...valueSources(doc, pg.from, pg.to)])
  runs.forEach((r, i) => {
    if (r.anchored || !r.m || !r.m.tokens.length || !edge(i)) return
    const tokens = r.m.tokens
    const weight = (chain) => chain.reduce((n, it) => n + (LETTER.test(tokens[it.ri].text) ? it.w : 0), 0)
    // What the body around it holds must account for less of the run.
    const { gap } = spans(ctx, nb, i)
    let top = weight(wordChain(ctx, tokens, gap[0], gap[1], true))
    let found = null
    for (const ranges of sources) {
      let body = []
      let within = null
      for (const [a, b] of ranges) {
        // Every page shows it again: what an earlier page took counts.
        const chain = wordChain(ctx, tokens, a, b, true, true)
        if (weight(chain) > weight(body)) {
          body = chain
          within = [a, b]
        }
      }
      if (!body.length || body.length >= tokens.length) continue
      const passed = []
      const used = new Set(body.map((it) => it.ri))
      for (const [a, b] of ranges) {
        if (a === within[0] && b === within[1]) continue
        for (const it of wordChain(ctx, tokens, a, b, false, true)) {
          if (used.has(it.ri)) continue
          used.add(it.ri)
          passed.push(it)
        }
      }
      if (weight(body) + weight(passed) > top) {
        top = weight(body) + weight(passed)
        found = { body, passed, within }
      }
    }
    if (!found) return
    const src = new Map([...found.body, ...found.passed].map((it) => [it.ri, it.start]))
    for (const it of found.body) for (let k = it.start; k < it.end; k++) if (!ctx.claimed[k]) ctx.claimed[k] = SHARED
    const spots = tokens.map((t, k) => token(doc, t.text, t.at, src.has(k) ? src.get(k) : null))
    anchor(ctx, r, { start: found.body[0].start, end: found.body[found.body.length - 1].end, tokens: spots }, "partial")
    // Printed by no line of the body around it, only by that content.
    r.furniture = true
    r.within = found.within.map(doc.toText)
  })
}

// 4. A generated label in front of the text ("Figure 1: ", "Fig. 1. -- ",
// "Tableau 2 – "): the longest suffix of the run that its gap holds, else
// that its lines or its page hold once. The suffix must carry most of the
// run's letters: a run lives where most of its text comes from.
function matchSuffixes(ctx) {
  const nb = bodyNeighbours(ctx)
  const page = pageWindows(ctx)
  ctx.runs.forEach((r, i) => {
    if (r.anchored || !r.m || r.m.tokens.length < 2 || !LETTER.test(r.text)) return
    const { gap, lines } = spans(ctx, nb, i)
    const letters = r.m.tokens.reduce((n, t) => n + t.text.length, 0)
    let kept = letters
    for (let k = 1; k < r.m.tokens.length; k++) {
      kept -= r.m.tokens[k - 1].text.length
      if (kept * 2 < letters) return
      const from = r.m.tokens[k].at
      const sub = compiled(ctx, r.m.text.slice(from), false, r.m.relaxEnd)
      let hits = occurrences(ctx, sub, gap[0], gap[1], 1)
      if (!hits.length) hits = occurrences(ctx, sub, lines[0], lines[1], 2)
      if (hits.length !== 1) hits = occurrences(ctx, sub, ...page(r.page), 2)
      if (hits.length === 1) {
        const hit = { ...hits[0], matchFrom: from + hits[0].matchFrom }
        // The part before the suffix may be text of its own rather than a
        // generated label: one paragraph Typst set from two sources (two
        // `#include`s on consecutive lines, text then an include). When it
        // is found exactly once before the suffix, each part keeps its own
        // click spot.
        const head = r.m.text.slice(0, r.m.tokens[k - 1].at + r.m.tokens[k - 1].text.length)
        if (LETTER.test(head)) {
          const hm = compiled(ctx, head, r.m.relaxStart, false)
          // A value printed before literal text (`- #d.lead runs the
          // survey.`, a whole value of a data file), or a definition's text
          // before an argument (`[Banner: #title]` in an imported module):
          // a mixed run, matched later with its parts.
          for (const g of dataRegions(ctx, i, gap)) {
            const R = ctx.doc.regions[g]
            if (occurrences(ctx, hm, R.start, R.end, 1, true).some((o) => !R.data || wholeFields(ctx.doc, o.start, o.end))) return
          }
          // A definition's text after an argument (`[Hallo #n,
          // willkommen!]` called in the gap): mixed as well, and every call
          // shows that text again, so the first one does not take it.
          if (calledBodies(ctx, gap).some((d) => d.from <= hit.start && hit.end <= d.to)) return
          let pre = occurrences(ctx, hm, gap[0], hit.start, 2)
          if (pre.length !== 1) pre = occurrences(ctx, hm, ...page(r.page), 2)
          if (pre.length === 1 && pre[0].end <= hit.start + 1) {
            const ph = pre[0].matchFrom || 0
            hit.tokens = [
              token(ctx.doc, r.m.text.slice(ph, from), ph, pre[0].start),
              token(ctx.doc, r.m.text.slice(hit.matchFrom), hit.matchFrom, hit.start)
            ]
            ctx.claimed.fill(FULL, pre[0].start, pre[0].end)
          } else if (!pre.length) {
            // A head printed around a value (`Totalt #folk.len() personer`):
            // its words found in order on the suffix's line, with only code
            // between them and the suffix, keep their own spots.
            const words = r.m.tokens.slice(0, k)
            const [lineFrom] = lineBoundsS(ctx.doc, ctx.doc.toText(hit.start))
            const chain = wordChain(ctx, words, lineFrom, hit.start, true)
            const last = chain.length ? chain[chain.length - 1].end : hit.start
            let text = false
            for (let t = last; t < hit.start && !text; t++) text = !ctx.claimed[t] && ctx.doc.flags[t] & DISP && ALNUM.test(ctx.S[t])
            if (chain.length && !text) {
              hit.tokens = [
                ...chain.map((it) => token(ctx.doc, words[it.ri].text, words[it.ri].at, it.start)),
                token(ctx.doc, r.m.text.slice(hit.matchFrom), hit.matchFrom, hit.start)
              ]
            }
          }
        }
        anchor(ctx, r, hit, "loose")
        return
      }
    }
  })
}

// The anchored runs of each data region in run order, for the reading
// position there around a run: [end of the last one before i, start of the
// first one after i].
function dataReading(ctx) {
  const { runs, doc } = ctx
  const lists = new Map()
  runs.forEach((r, i) => {
    if (!r.anchored || r.region === 0) return
    if (!lists.has(r.region)) lists.set(r.region, [])
    lists.get(r.region).push(i)
  })
  return (g, i) => {
    const R = doc.regions[g]
    const list = lists.get(g) || []
    const k = lowerBound(list, i)
    const lo = k > 0 ? runs[list[k - 1]].searchEnd : R.start
    const hi = k < list.length ? runs[list[k]].searchStart : R.end
    return hi > lo ? [lo, hi] : [lo, R.end]
  }
}

// The data regions a run may come from: those of its nearest matched
// neighbours, then those its gap's source names.
function dataRegions(ctx, i, gap) {
  const { runs } = ctx
  const out = []
  for (let k = i - 1; k >= 0; k--) {
    if (!runs[k].anchored) continue
    if (runs[k].region > 0) out.push(runs[k].region)
    break
  }
  for (let k = i + 1; k < runs.length; k++) {
    if (!runs[k].anchored) continue
    if (runs[k].region > 0 && !out.includes(runs[k].region)) out.push(runs[k].region)
    break
  }
  for (const g of mentionsIn(ctx.doc, gap[0], gap[1])) if (!out.includes(g)) out.push(g)
  // Nothing around it: the files the document loaded before this point
  // (`#let x = xml("c.xml")` above a loop over `x`), the latest first.
  if (!out.length) for (const g of mentionsIn(ctx.doc, 0, gap[1]).reverse()) if (!out.includes(g)) out.push(g)
  return out
}

// The run's words in order with anything but letters and digits between
// them, from source word `o0` on: their spans, if each is text and free.
function wordsAt(ctx, tokens, o0, hi) {
  const { words } = ctx
  if (o0 + tokens.length > words.text.length || words.end[o0 + tokens.length - 1] > hi) return null
  const spots = []
  for (let j = 0; j < tokens.length; j++) {
    const o = o0 + j
    if (words.text[o] !== tokens[j].text) return null
    const a = words.pos[o]
    const b = words.end[o]
    if (ctx.bad[b] - ctx.bad[a] || !isFree(ctx, a, b, false)) return null
    spots.push([a, b])
  }
  return { start: spots[0][0], end: spots[spots.length - 1][1], spots }
}

// 5. The words in order however punctuated: a printed array row
// `("key", "short")` against `key,short`, typography the patterns miss.
// First in the body (`data` false: the gap, else once in the lines), later
// in the data files around the run, from their reading position.
function matchWords(ctx, data) {
  const { runs, doc } = ctx
  const nb = bodyNeighbours(ctx)
  const reading = dataReading(ctx)
  runs.forEach((r, i) => {
    if (r.anchored || !r.m || r.m.tokens.length < 2) return
    const tokens = r.m.tokens
    const list = ctx.index.get(tokens[0].text)
    if (!list) return
    const { gap, lines } = spans(ctx, nb, i)
    const windows = data ? dataRegions(ctx, i, gap).map((g) => reading(g, i)) : [gap]
    for (const [lo, hi] of windows) {
      for (let k = firstWordFrom(ctx, list, lo); k < list.length && ctx.words.pos[list[k]] < hi; k++) {
        const hit = wordsAt(ctx, tokens, list[k], hi)
        if (!hit) continue
        const spots = tokens.map((t, j) => token(doc, t.text, t.at, hit.spots[j][0]))
        anchor(ctx, r, { start: hit.start, end: hit.end, tokens: spots }, "words")
        return
      }
    }
    if (data) return
    const found = []
    for (let k = firstWordFrom(ctx, list, lines[0]); k < list.length && ctx.words.pos[list[k]] < lines[1] && found.length < 2; k++) {
      const hit = wordsAt(ctx, tokens, list[k], lines[1])
      if (hit) found.push(hit)
    }
    if (found.length === 1) {
      const spots = tokens.map((t, j) => token(doc, t.text, t.at, found[0].spots[j][0]))
      anchor(ctx, r, { start: found[0].start, end: found[0].end, tokens: spots }, "words")
    }
  })
}

// 6. Text shown again with its source already taken: a running header, an
// outline entry, a table printed twice. A copy takes the next occurrence of
// its original after the last text read in that file, wrapping around, so
// the second copy of a table walks down its rows again and a header copy
// returns to the header. Bare numbers copy data values only (in the body
// they are page or list numbers). A value no run matched as such copies its
// field in a data file (below).
function matchCopies(ctx) {
  const { runs } = ctx
  const originals = new Map()
  for (const r of runs) {
    if (!r.anchored || r.weak || !r.text) continue
    if (!originals.has(r.text)) originals.set(r.text, [])
    originals.get(r.text).push(r)
  }
  for (const list of originals.values()) list.sort((a, b) => a.searchStart - b.searchStart)
  const nextRegion = new Int32Array(runs.length).fill(-1)
  for (let i = runs.length - 2; i >= 0; i--) nextRegion[i] = runs[i + 1].anchored ? runs[i + 1].region : nextRegion[i + 1]
  const read = new Map()
  let lastRegion = -1
  // A value with letters printed again from a data file whose every
  // occurrence is taken (a glossary listing the rows a raw print of the
  // file shows too) copies its next whole-field occurrence after what was
  // last read in that file, wrapping around: the files of the runs around
  // it first.
  const nb = bodyNeighbours(ctx)
  const copyField = (r, i) => {
    if (!r.m.complete.length || !LETTER.test(r.text)) return
    const { gap } = spans(ctx, nb, i)
    for (const g of dataRegions(ctx, i, gap)) {
      const R = ctx.doc.regions[g]
      const all = occurrences(ctx, r.m, R.start, R.end, Infinity, true).filter((o) => wholeFields(ctx.doc, o.start, o.end))
      if (!all.length) continue
      const from = read.has(g) ? read.get(g) : R.start
      const o = all.find((x) => x.start >= from) || all[0]
      anchor(ctx, r, o, "copy")
      read.set(g, o.end)
      lastRegion = g
      return
    }
  }
  runs.forEach((r, i) => {
    if (r.anchored) {
      if (r.ordered || r.repeat) read.set(r.region, r.searchEnd)
      lastRegion = r.region
      return
    }
    if (!r.m || !r.m.tokens.length) return
    let pool = originals.get(r.text)
    if (pool && !LETTER.test(r.text)) pool = pool.filter((o) => o.region > 0)
    if (!pool || !pool.length) return copyField(r, i)
    const has = (g) => g >= 0 && pool.some((o) => o.region === g)
    const g = has(lastRegion) ? lastRegion : has(nextRegion[i]) ? nextRegion[i] : pool[0].region
    const mine = pool.filter((o) => o.region === g)
    const from = read.has(g) ? read.get(g) : 0
    const o = mine.find((x) => x.searchStart >= from) || mine[0]
    anchor(ctx, r, { start: o.searchStart, end: o.searchEnd, matchFrom: o.matchFrom }, "copy")
    read.set(g, o.searchEnd)
    lastRegion = g
  })
}

// The definitions a call of `name` reaches, in source order, those nested in
// another left out: one text to walk.
function definitionBodies(doc, name) {
  const found = []
  const seen = new Set()
  const visit = (name) => {
    if (seen.has(name) || !doc.defs.has(name)) return
    seen.add(name)
    for (const d of doc.defs.get(name)) {
      found.push(d)
      for (const n of d.callees) visit(n)
    }
  }
  visit(name)
  found.sort((x, y) => x.from - y.from || y.to - x.to)
  const bodies = []
  for (const d of found) if (!bodies.length || d.from >= bodies[bodies.length - 1].to) bodies.push(d)
  return bodies
}

// The definitions the calls in [lo, hi) reach.
function calledBodies(ctx, [lo, hi]) {
  const { doc } = ctx
  const b = doc.toText(hi)
  const out = []
  for (let k = lowerBound(doc.calls.map((c) => c.at), doc.toText(lo)); k < doc.calls.length && doc.calls[k].at < b; k++) {
    if (doc.defs.has(doc.calls[k].name)) out.push(...definitionBodies(doc, doc.calls[k].name))
  }
  return out
}

// 5b. Text a function prints from its own definition (a template's ` --- `
// between a term and its meaning, a closing `[.]`): a run still unmatched
// between body runs whose source calls a function the project defines is
// looked up in that definition and in the ones it calls. Every call shows
// that text again, so nothing is claimed. The text is walked in order and
// starts over only once something else printed in between (the next item's
// values). The calls print in source order: once a run read through a later
// call or file name of the stretch appears (`#csv(...)` after the glossary),
// an earlier call's output is over.
function matchTemplates(ctx) {
  const { runs, doc } = ctx
  if (!doc.defs.size) return
  const callAt = doc.calls.map((c) => c.at)
  forEachGap(ctx, (from, to, lo, hi) => {
    if (hi <= lo) return
    const a = doc.toText(lo)
    const b = doc.toText(hi)
    const called = []
    for (let k = lowerBound(callAt, a); k < doc.calls.length && doc.calls[k].at < b; k++) {
      const c = doc.calls[k]
      if (doc.defs.has(c.name)) called.push({ line: lineIndexAt(doc, c.at), call: c.at, bodies: definitionBodies(doc, c.name), cursor: -1 })
    }
    if (!called.length) return
    const mentions = doc.mentions.filter((m) => m.at >= lo && m.at < hi)
    // The line whose call printed the latest values: calls on earlier lines
    // are over (a file named in the call's own arguments is its own).
    let since = -1
    let sinceAt = lo
    let printed = true
    for (let i = from; i < to; i++) {
      const r = runs[i]
      if (r.anchored) {
        if (r.region > 0 && (r.ordered || r.kind === "words")) {
          const m = mentions.find((x) => x.region === r.region && x.at >= sinceAt)
          if (m) {
            sinceAt = m.at
            since = lineIndexAt(doc, doc.toText(m.at))
          }
        }
        if (LETTER.test(r.text)) printed = true
        continue
      }
      if (!r.m) continue
      let hit = null
      let via = null
      for (const c of called) {
        if (c.line < since) continue
        const look = (cursor) => {
          for (const body of c.bodies) {
            if (body.to <= cursor) continue
            const h = occurrences(ctx, r.m, Math.max(body.from, cursor), body.to, 1, true)
            if (h.length) return { ...h[0], body }
          }
          return null
        }
        hit = look(c.cursor)
        if (!hit && printed && c.cursor >= 0) hit = look(-1)
        if (hit) {
          c.cursor = hit.end
          via = c.call
          break
        }
      }
      if (hit) {
        anchor(ctx, r, hit, "template")
        r.producer = via
        r.within = [doc.toText(hit.body.from), doc.toText(hit.body.to)]
        printed = false
      } else if (LETTER.test(r.text)) printed = true
    }
  })
}

// The run's words found in order among the words of [lo, hi) that are text
// and free (or shared literal words), ignoring case: the heaviest chain. In
// the body (`cut`) it is cut where it would skip other free text (the run's
// words may skip the code that printed its values, not text it did not
// show) and the piece kept that accounts for most of the run, each of its
// words counted as often as the run shows it (a loop shows its literal
// once per item: `Hello` thrice from `[Hello #name. ]` outweighs two names
// of the array it walks); in a data file skipping other fields is what
// printing a few of them does. With `taken`, claimed words count too.
function wordChain(ctx, tokens, lo, hi, cut, taken = false) {
  const lower = lowerIndex(ctx)
  const items = []
  tokens.forEach((t, k) => {
    const list = lower.get(t.text.toLowerCase())
    if (!list) return
    const len = t.text.length
    for (let p = lowerBound(list, lo); p < list.length && list[p] + len <= hi; p++) {
      const s = list[p]
      if (ctx.bad[s + len] - ctx.bad[s] || !(taken || isFree(ctx, s, s + len, true))) continue
      if (ctx.S.slice(s, s + len).toLowerCase() !== t.text.toLowerCase()) continue
      items.push({ ri: k, start: s, end: s + len, w: len })
    }
  })
  const chain = heaviestChain(items, !cut)
  if (!cut) return chain
  const skipsText = (a, b) => {
    for (let k = a; k < b; k++) if (!ctx.claimed[k] && ctx.doc.flags[k] & DISP && ALNUM.test(ctx.S[k])) return true
    return false
  }
  let best = []
  let bestW = 0
  for (let k = 0, from = 0; k <= chain.length; k++) {
    if (k < chain.length && (k === from || !skipsText(chain[k - 1].end, chain[k].start))) continue
    const piece = chain.slice(from, k)
    const own = new Set(piece.map((it) => tokens[it.ri].text.toLowerCase()))
    const w = tokens.reduce((n, t) => n + (own.has(t.text.toLowerCase()) ? t.text.length : 0), 0)
    if (w > bestW) {
      best = piece
      bestW = w
    }
    from = k
  }
  return best
}

// Where the values that the source [a, b) names come from (search offsets):
// for a name a `let` binds, its definitions and the ones they call (`#let
// title = "..."`, `#let hdr() = [...]`); for a parameter of the function
// holding [a, b), what its first call passes (`report.with(title: "...")`).
const NAME_RE = /(^|[^\p{L}\p{N}_.-])([\p{L}_][\p{L}\p{N}_-]*)(?![\p{L}\p{N}_-]|\s*:)/gu

function valueSources(doc, a, b) {
  const out = []
  const inside = (d) => d.from <= a && b <= d.to
  let holder = null
  for (const [name, list] of doc.defs) {
    for (const d of list) {
      if (!inside(d) || (holder && holder.d.to - holder.d.from <= d.to - d.from)) continue
      const params = parametersAt(doc, doc.toText(d.from))
      if (params) holder = { name, list, d, params }
    }
  }
  const seen = new Set()
  for (const m of doc.text.slice(doc.toText(a), doc.toText(b)).matchAll(NAME_RE)) {
    const name = m[2]
    if (seen.has(name)) continue
    seen.add(name)
    if (doc.defs.has(name)) {
      for (const d of definitionBodies(doc, name)) if (!inside(d)) out.push([d.from, d.to])
      continue
    }
    const used = holder && holder.params.find((p) => p.name === name)
    const p = used && passedArgument(doc, holder.name, holder.list, holder.params, used)
    if (p && p.arg) out.push([doc.toSearch(p.arg.at), doc.toSearch(p.arg.to)])
  }
  return out
}

// The first occurrence of `word` in [lo, hi) as a whole word of free text
// (or of shared literal words), ignoring case; null when none.
function freeWord(ctx, word, lo, hi) {
  const list = lowerIndex(ctx).get(word.toLowerCase())
  if (!list) return null
  for (let p = lowerBound(list, lo); p < list.length && list[p] + word.length <= hi; p++) {
    const s = list[p]
    if (!(ctx.bad[s + word.length] - ctx.bad[s]) && isFree(ctx, s, s + word.length, true)) return s
  }
  return null
}

// Where the values of a mixed run lie in data region g, read from `from` on
// (`values` holds the run's tokens, null for its literal words): the
// shortest stretch after `from`, else anywhere in the file, holding each
// value word the file holds, in its own spelling when the file has it (the
// `holm` of `holm@example.org` is not the `Holm` of a name). That is the
// record the loop printed: a value repeated in later records stays in the
// one being printed. Each word takes its next occurrence in the stretch.
// Returns { spots: token index -> search offset, end } or null.
const MAX_VALUE_SPOTS = 50_000

function valueSpots(ctx, values, g, from) {
  const { words } = ctx
  const R = ctx.doc.regions[g]
  const lists = new Map() // spelling -> sorted search offsets in the file
  const keyOf = values.map((t) => {
    if (!t) return null
    for (const [key, list, pos] of [
      [t.text, ctx.index.get(t.text), (o) => words.pos[o]],
      [t.text.toLowerCase(), lowerIndex(ctx).get(t.text.toLowerCase()), (o) => o]
    ]) {
      if (!list) continue
      if (lists.has(key)) return key
      let a = 0
      let b = list.length
      while (a < b) {
        const mid = (a + b) >> 1
        if (pos(list[mid]) < R.start) a = mid + 1
        else b = mid
      }
      const at = []
      for (let k = a; k < list.length && pos(list[k]) < R.end; k++) at.push(pos(list[k]))
      if (!at.length) continue
      lists.set(key, at)
      return key
    }
    return null
  })
  if (!lists.size) return null
  const keys = [...lists.keys()]
  let size = 0
  for (const l of lists.values()) size += l.length
  if (size > MAX_VALUE_SPOTS) return null
  // The shortest stretch from `lo` on holding every key.
  const shortest = (lo) => {
    const events = []
    keys.forEach((key, k) => {
      for (const at of lists.get(key)) if (at >= lo) events.push([at, k])
    })
    events.sort((a, b) => a[0] - b[0])
    const count = new Int32Array(keys.length)
    let have = 0
    let best = null
    for (let a = 0, b = 0; b < events.length; b++) {
      if (count[events[b][1]]++ === 0) have++
      while (have === keys.length) {
        const span = events[b][0] - events[a][0]
        if (!best || span < best[1] - best[0]) best = [events[a][0], events[b][0]]
        if (--count[events[a][1]] === 0) have--
        a++
      }
    }
    return best
  }
  const win = shortest(from) || shortest(R.start)
  if (!win) return null
  const spots = new Map()
  let walk = win[0]
  let end = win[0]
  values.forEach((t, k) => {
    if (!keyOf[k]) return
    const list = lists.get(keyOf[k])
    const at = list.find((x) => x >= walk && x <= win[1]) ?? list.find((x) => x >= win[0] && x <= win[1])
    if (at == null) return
    spots.set(k, at)
    walk = at + t.text.length
    end = Math.max(end, walk)
  })
  return { spots, end }
}

// The top-level bracket groups of data region g (text offsets): its records
// when it holds several (BibTeX entries).
function recordGroups(ctx, g) {
  const { doc } = ctx
  if (!ctx.records) ctx.records = new Map()
  if (!ctx.records.has(g)) {
    const R = doc.regions[g]
    const list = []
    let depth = 0
    for (let k = doc.toText(R.start), e = doc.toText(R.end); k < e; k++) {
      const c = doc.text[k]
      if (c === "{" || c === "[") {
        if (depth++ === 0) list.push([k, e])
      } else if ((c === "}" || c === "]") && depth > 0 && --depth === 0) list[list.length - 1][1] = k + 1
    }
    ctx.records.set(g, list)
  }
  return ctx.records.get(g)
}

// The record of a data file holding search offset s, as search offsets: its
// bracket group when the file holds several, else its line.
function recordOf(ctx, s) {
  const { doc } = ctx
  const g = regionOf(doc, s)
  const t = doc.toText(s)
  const list = doc.regions[g].data ? recordGroups(ctx, g) : []
  const rec = list.length > 1 ? list.find(([a, b]) => a <= t && t < b) : null
  return rec ? [doc.toSearch(rec[0]), doc.toSearch(rec[1])] : lineBoundsS(doc, t)
}

// 7. A run mixing literal text with generated values (`Held in #d.city`,
// `- #r.at(0) costs #r.at(1)`): its words found in order among the free text
// of its gap are the literal part, which is where the run lives (a loop
// shows that literal once per item, so the words stay shared, and a word
// of it shown again takes the same spot). Its other words are looked up in
// the data files around it, else in order in the rest of its stretch (the
// array literal a `#for` walks), so a click on a value still lands on the
// value. A run with no literal part matches a data file only when most of
// its letters come from there; its words printed out of the file's order
// (a bibliography's authors before the title) are then looked up in order
// in the record holding the rest.
function matchPartial(ctx, data) {
  const { runs, doc } = ctx
  const nb = bodyNeighbours(ctx)
  const reading = dataReading(ctx)
  const read = new Map() // region -> where the values last printed from it end
  const callAt = doc.calls.map((c) => c.at)
  runs.forEach((r, i) => {
    if (r.anchored || !r.m || !r.m.tokens.length) return
    const tokens = r.m.tokens
    const { gap } = spans(ctx, nb, i)
    let body = data ? [] : wordChain(ctx, tokens, gap[0], gap[1], true)
    // The literal may be a function's the stretch calls (`#for p in folk
    // [#rad(p)]` printing `#let rad(p) = [#p.namn bor i #p.stad ...]`): its
    // words in that definition, when they account for more of the run and
    // values are left (a run of the definition's text alone is its
    // template text, step 8).
    let via = null
    if (!data && doc.defs.size) {
      const weight = (chain) => chain.reduce((n, it) => n + (LETTER.test(tokens[it.ri].text) ? it.w : 0), 0)
      const a = doc.toText(gap[0])
      const b = doc.toText(gap[1])
      for (let k = lowerBound(callAt, a); k < doc.calls.length && doc.calls[k].at < b; k++) {
        const c = doc.calls[k]
        if (!doc.defs.has(c.name)) continue
        // The values the call writes in its own arguments (`#ficha("Lucía",
        // "Sevilla")`, `#ficha[Lucía][Sevilla]`) print beside the
        // definition's text: the run's other words found there.
        const argsTo = doc.toSearch(callArguments(doc.text, c.at + c.name.length).end)
        const argsFrom = doc.toSearch(c.at)
        for (const d of definitionBodies(doc, c.name)) {
          const chain = wordChain(ctx, tokens, d.from, d.to, true)
          if (chain.length >= tokens.length) continue
          const inDef = new Set(chain.map((it) => it.ri))
          const passed = (via ? via.passed : body).filter((it) => !inDef.has(it.ri) && it.start >= argsFrom && it.end <= argsTo)
          if (weight(chain) + weight(passed) > weight(body) + (via ? weight(via.passed) : 0)) {
            body = chain
            via = { call: c.at, within: [doc.toText(d.from), doc.toText(d.to)], passed }
          }
        }
      }
    }
    const literal = body.some((it) => LETTER.test(tokens[it.ri].text))
    if (!literal && !data) return
    const regions = dataRegions(ctx, i, gap)
    if (literal) {
      const passed = via ? via.passed : []
      const src = new Map([...body, ...passed].map((it) => [it.ri, it.start]))
      const shown = new Map(body.map((it) => [tokens[it.ri].text.toLowerCase(), it.start]))
      const values = tokens.map((t, k) => (src.has(k) || shown.has(t.text.toLowerCase()) ? null : t))
      const found = []
      for (const g of regions) {
        const v = valueSpots(ctx, values, g, Math.max(reading(g, i)[0], read.has(g) ? read.get(g) : 0))
        if (!v) continue
        found.push(v.spots)
        read.set(g, v.end)
      }
      let gapAt = gap[0]
      let called = null
      const spots = tokens.map((t, k) => {
        if (src.has(k)) return token(doc, t.text, t.at, src.get(k))
        if (shown.has(t.text.toLowerCase())) return token(doc, t.text, t.at, shown.get(t.text.toLowerCase()))
        const v = found.find((m) => m.has(k))
        if (v) return token(doc, t.text, t.at, v.get(k))
        let at = freeWord(ctx, t.text, gapAt, gap[1])
        if (at != null) gapAt = at + t.text.length
        else {
          // Text a call of the stretch prints from its function's
          // definition around the argument (`um #tag("8") und` with `#let
          // tag(x) = [#x Uhr]`): every call shows it again, from there. A
          // variable's value (`#p.b`) stays on the code printing it.
          if (!called) called = calledBodies(ctx, gap).filter((d) => parametersAt(doc, doc.toText(d.from)))
          for (const d of called) if (at == null) at = freeWord(ctx, t.text, d.from, d.to)
        }
        return token(doc, t.text, t.at, at)
      })
      for (const part of [body, passed]) {
        if (!part.length) continue
        for (const it of part) for (let k = it.start; k < it.end; k++) if (!ctx.claimed[k]) ctx.claimed[k] = SHARED
        // The calls on those lines printed its values: nothing left to show.
        const [a] = lineBoundsS(doc, doc.toText(part[0].start))
        const [, b] = lineBoundsS(doc, doc.toText(part[part.length - 1].end))
        for (let k = a; k < b; k++) if (!ctx.claimed[k] && doc.flags[k] & PROD) ctx.claimed[k] = SHOWN
      }
      anchor(ctx, r, { start: body[0].start, end: body[body.length - 1].end, tokens: spots }, "partial")
      // Printed by the call, from the definition: a caret on the call finds
      // it as it finds a template's text.
      if (via) {
        r.producer = via.call
        r.within = via.within
      }
      return
    }
    const letters = tokens.reduce((n, t) => n + t.text.length, 0)
    for (const g of regions) {
      // From where the values before it, matched in this pass too, end.
      const [lo0, hi0] = reading(g, i)
      const at = read.has(g) ? Math.max(lo0, read.get(g)) : lo0
      for (const [lo, hi] of [[at, at < hi0 ? hi0 : doc.regions[g].end], [doc.regions[g].start, doc.regions[g].end]]) {
        const chain = wordChain(ctx, tokens, lo, hi, false)
        const got = chain.reduce((n, it) => n + it.w, 0)
        if (!chain.length || got * 2 < letters) continue
        const src = new Map(chain.map((it) => [it.ri, it.start]))
        const [recFrom, recEnd] = recordOf(ctx, chain[0].start)
        let recAt = recFrom
        let spots = tokens.map((t, k) => {
          if (src.has(k)) return token(doc, t.text, t.at, src.get(k))
          const at = LETTER.test(t.text) ? freeWord(ctx, t.text, recAt, recEnd) : null
          if (at != null) recAt = at + t.text.length
          return token(doc, t.text, t.at, at)
        })
        let start = chain[0].start
        let end = chain[chain.length - 1].end
        // A record written one field per line and printed in another order
        // (`#m.role --- #m.name`): the shortest stretch holding all its
        // words, when that accounts for more of the run.
        const found = (list) => list.reduce((n, t) => n + (t.s != null ? t.text.length : 0), 0)
        const v = valueSpots(ctx, tokens, g, lo)
        if (v) {
          const alt = tokens.map((t, k) => token(doc, t.text, t.at, v.spots.has(k) ? v.spots.get(k) : null))
          if (found(alt) > found(spots)) {
            spots = alt
            start = Math.min(...alt.filter((t) => t.s != null).map((t) => t.s))
            end = Math.max(...alt.filter((t) => t.s != null).map((t) => t.s + t.text.length))
          }
        }
        anchor(ctx, r, { start, end, tokens: spots }, "partial")
        read.set(g, end)
        return
      }
    }
  })
}

// 8. A value formatted on output (`1234.57` from `1234.5678`, `1,500` from
// `1500`) right after a value found in a data file: the next field of that
// file, before the next value found there, in the record (line) of one of
// them. A key (`name:` in YAML or JSON, `name =` in TOML) holds no value.
const FIELD_DELIM = /[,;\t\n"'()[\]{}<>:=|]/
const KEY_END = /^["']?[ \t]*[:=]/

function matchFields(ctx) {
  const { runs, doc } = ctx
  const text = doc.text
  let prev = null
  runs.forEach((r, i) => {
    if (r.anchored) {
      prev = r
      return
    }
    if (!prev || prev.region === 0 || !r.m || !r.m.tokens.length) return
    let next = null
    for (let k = i + 1; k < runs.length && !next; k++) if (runs[k].anchored) next = runs[k]
    const R = doc.regions[prev.region]
    const stop = doc.toText(next && next.region === prev.region && next.searchStart >= prev.searchEnd ? next.searchStart : R.end)
    let t = prev.end
    while (t < stop && t > 0 && !FIELD_DELIM.test(text[t - 1]) && !FIELD_DELIM.test(text[t])) t++
    let e = t
    for (;;) {
      while (t < stop && (FIELD_DELIM.test(text[t]) || /\s/.test(text[t]))) t++
      e = t
      while (e < stop && !FIELD_DELIM.test(text[e])) e++
      if (e >= stop || !KEY_END.test(text.slice(e, e + 3))) break
      t = e
    }
    while (e > t && /\s/.test(text[e - 1])) e--
    if (e <= t) return
    const line = lineIndexAt(doc, t)
    if (line !== lineIndexAt(doc, prev.end) && !(next && line === lineIndexAt(doc, next.start))) return
    anchor(ctx, r, { start: doc.toSearch(t), end: doc.toSearch(e) }, "field")
    prev = r
  })
}

// 10. A running header or footer is set on every page from one content (a
// `set page(header: [...])`), its values aside (the page number). A run first
// or last on its page that found nothing, with the words (numbers aside) of
// a run at the same end of another page matched in text shown elsewhere
// (not where it stands), is a copy of that run: its words take their spots.
function matchFurniture(ctx) {
  const { runs, doc } = ctx
  const ends = new Map() // page -> [first, last] run with text
  runs.forEach((r, i) => {
    if (r.image || !r.text) return
    if (!ends.has(r.page)) ends.set(r.page, [i, i])
    else ends.get(r.page)[1] = i
  })
  const letterWords = (r) => wordsOf(r.text).filter((w) => LETTER.test(w)).join(" ")
  const set = []
  for (const pair of ends.values()) {
    pair.forEach((i, at) => {
      const r = runs[i]
      if (r.anchored && r.region === 0 && LETTER.test(r.text) && !(doc.flags[r.searchStart] & PROD)) set.push({ at, r, words: letterWords(r) })
    })
  }
  for (const pair of set.length ? ends.values() : []) {
    pair.forEach((i, at) => {
      const r = runs[i]
      if (r.anchored || !r.m || !LETTER.test(r.text)) return
      const words = letterWords(r)
      const o = set.find((f) => f.at === at && f.r.page !== r.page && f.words === words)
      if (!o) return
      const q = o.r
      // Each word of the copy at the spot of the same word of the original
      // (its k-th word with letters), when the original found it.
      const own = tokensOf(q.text).filter((t) => LETTER.test(t.text))
      let next = 0
      const spot = (t) => {
        if (!LETTER.test(t.text)) return token(doc, t.text, t.at, null)
        const w = own[next++]
        const u = w && q.tokens.find((v) => v.s != null && v.at <= w.at && w.at < v.at + v.text.length)
        if (!u) return token(doc, t.text, t.at, null)
        if (typeof q.spots === "function") q.spots = q.spots()
        return token(doc, t.text, t.at, doc.toSearch(q.spots[w.at]))
      }
      anchor(ctx, r, { start: q.searchStart, end: q.searchEnd, matchFrom: q.matchFrom, tokens: q.tokens ? r.m.tokens.map(spot) : null }, "copy")
    })
  }
  // None of them matched (`footer: context [Page #counter(page).display()]`
  // prints a number into every copy): runs with the same words at the same
  // end of several pages are copies of one content, found by those words in
  // order in text shown elsewhere.
  const groups = new Map()
  for (const pair of ends.values()) {
    pair.forEach((i, at) => {
      const r = runs[i]
      if (r.anchored || !r.m || !LETTER.test(r.text)) return
      const key = `${at} ${letterWords(r)}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(r)
    })
  }
  const body = doc.regions[0]
  const lower = lowerIndex(ctx)
  for (const list of groups.values()) {
    if (new Set(list.map((r) => r.page)).size < 2) continue
    const tokens = list[0].m.tokens
    const items = []
    tokens.forEach((t, k) => {
      if (!LETTER.test(t.text)) return
      const at = lower.get(t.text.toLowerCase()) || []
      const len = t.text.length
      for (let p = lowerBound(at, body.start); p < at.length && at[p] + len <= body.end; p++) {
        const a = at[p]
        if (doc.flags[a] & PROD || ctx.bad[a + len] - ctx.bad[a]) continue
        items.push({ ri: k, start: a, end: a + len, w: len })
      }
    })
    const chain = heaviestChain(items, true)
    if (chain.length !== tokens.filter((t) => LETTER.test(t.text)).length) continue
    const at = new Map(chain.map((it) => [it.ri, it.start]))
    for (const r of list) {
      const spots = r.m.tokens.map((t, k) => token(doc, t.text, t.at, at.has(k) ? at.get(k) : null))
      anchor(ctx, r, { start: chain[0].start, end: chain[chain.length - 1].end, tokens: spots }, "copy")
    }
  }
}

// ── Placement ────────────────────────────────────────────────────────────────
// Runs with nothing to match are placed between their matched neighbours.
// Pictures take the picture calls of their gap in order (a call to `image`
// or to a name whose `let` shows one, two on a line for two calls there,
// else the first call of a later line). Text with letters (generated words,
// `#lorem`) claims the line of its gap it shares the most words with, and the
// runs after it stay there until another claims a later line; else what is
// left to show on the previous run's line, else the first producing line of
// the gap. Marks without letters go with their neighbours: closing
// punctuation, and a mark set after a space (an outline page number), follow
// the text before it; a line between the texts around a mark that shows
// something nothing matched (`#context counter(page).display()`) is the
// mark's source, and the marks right after it stay there; else a marker
// (bullet, number, opening bracket) precedes the text after it, at the start
// of its line or of its record in a data file (a BibTeX entry), unless the
// previous run's line still has something to show (`@key`, `#footnote`).
const CLOSING = /^[)\]}>,;.:!?\p{Pf}]/u

function wordsOf(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
}

function placeRest(ctx) {
  const { runs, doc } = ctx
  const nb = bodyNeighbours(ctx)
  const lineWords = new Map()
  const wordsAtLine = (k) => {
    if (!lineWords.has(k)) lineWords.set(k, new Set(wordsOf(doc.lines[k].text)))
    return lineWords.get(k)
  }
  const placedLines = new Set()
  const span = (r, k) => {
    r.start = doc.starts[k]
    r.end = doc.starts[k] + doc.lines[k].text.length
    r.region = regionOf(doc, doc.toSearch(r.start))
    placedLines.add(k)
  }
  const point = (r, t) => {
    r.start = t
    r.end = t
    r.region = regionOf(doc, doc.toSearch(t))
  }
  const lineStart = (t) => doc.starts[lineIndexAt(doc, t)]
  // Where the record holding text offset t of a data file starts: its top
  // level bracket group (a BibTeX entry `@book{...}`) when the file holds
  // several and the group starts on an earlier line, else t's line.
  const recordStart = (t) => {
    const g = regionOf(doc, doc.toSearch(t))
    if (!doc.regions[g].data) return lineStart(t)
    const list = recordGroups(ctx, g)
    const rec = list.length > 1 ? list.find(([a, b]) => a <= t && t < b) : null
    return rec && lineIndexAt(doc, rec[0]) < lineIndexAt(doc, t) ? lineStart(rec[0]) : lineStart(t)
  }
  // The first thing left to show on the line of matched run `a` after its
  // text (before `stop`): text no run matched, a call, a reference, as
  // { at, to } (text offsets of its first character and of its end).
  const leftOnLine = (a, stop) => {
    if (!a || a.region !== 0) return null
    const k = lineIndexAt(doc, a.end)
    return leftIn(a.end, Math.min(stop == null ? Infinity : stop, doc.starts[k] + doc.lines[k].text.length))
  }
  // The same on the line of matched run `b` before its text (after `from`):
  // `#cite(<key>, form: "prose")` printing the words before `b`.
  const leftBefore = (b, from) => {
    if (!b || b.region !== 0) return null
    return leftIn(Math.max(from, lineStart(b.start)), b.start)
  }
  const leftIn = (from, end) => {
    for (let t = from; t < end; t++) {
      const s = doc.toSearch(t)
      if (!(doc.flags[s] & PROD) || ctx.claimed[s] || doc.text.charCodeAt(t) <= 32) continue
      let e = s
      while (e < ctx.S.length && doc.flags[e] & PROD && ctx.S.charCodeAt(e) > 32 && !ctx.claimed[e]) e++
      ctx.claimed.fill(SHOWN, s, e)
      return { at: t, to: doc.toText(e) }
    }
    return null
  }
  // A run placed at what it shows (`@intro` printing `Section 1`) reaches
  // to its end: a caret anywhere on it finds the run.
  const shows = (r, left) => {
    point(r, left.at)
    r.showTo = left.to
  }
  // The lines of the gap around run i, with the text bounds of its
  // neighbours: their own lines count only for what lies outside their text.
  const gapOf = (i) => {
    const p = nb.prev[i]
    const q = nb.next[i]
    const from = p >= 0 ? runs[p].end : 0
    const to = q >= 0 ? runs[q].start : doc.primaryEnd
    return { from, to, first: lineIndexAt(doc, from), last: Math.min(lineIndexAt(doc, Math.max(from, to - 1)), doc.primaryLines - 1) }
  }
  const produces = (g, k) => {
    if (!doc.lineProd[k]) return false
    const a = Math.max(doc.starts[k], g.from)
    const b = Math.min(doc.starts[k] + doc.lines[k].text.length, g.to)
    for (let t = a; t < b; t++) if (doc.flags[doc.toSearch(t)] & PROD && doc.text.charCodeAt(t) > 32) return true
    return false
  }
  // The calls of the gap after `after` that may show a picture: picture
  // calls one by one (a line with two `image` calls shows two), else the
  // first call of each line.
  const callAt = doc.calls.map((c) => c.at)
  const pictureCall = (g, after) => {
    const from = lowerBound(callAt, Math.max(g.from, after + 1))
    for (let k = from; k < doc.calls.length && doc.calls[k].at < g.to; k++) if (doc.calls[k].picture) return doc.calls[k].at
    const line = after >= 0 ? lineIndexAt(doc, after) : -1
    for (let k = from; k < doc.calls.length && doc.calls[k].at < g.to; k++) if (lineIndexAt(doc, doc.calls[k].at) > line) return doc.calls[k].at
    return null
  }
  const prevMatched = (i) => {
    for (let k = i - 1; k >= 0; k--) if (runs[k].anchored) return runs[k]
    return null
  }
  const nextMatched = (i) => {
    for (let k = i + 1; k < runs.length; k++) if (runs[k].anchored) return runs[k]
    return null
  }

  // Pictures and text with letters.
  let gapKey = -2
  let claimedLine = -1
  let lastPicture = -1
  let gapSize = 0
  runs.forEach((r, i) => {
    if (r.anchored || !(r.image || LETTER.test(r.text))) return
    if (nb.prev[i] !== gapKey) {
      gapKey = nb.prev[i]
      claimedLine = -1
      lastPicture = -1
      gapSize = 0
      for (let k = i; k < runs.length && nb.prev[k] === gapKey; k++) gapSize++
    }
    const g = gapOf(i)
    if (r.image) {
      const at = pictureCall(g, lastPicture)
      if (at != null) {
        lastPicture = at
        span(r, lineIndexAt(doc, at))
        return
      }
    } else if (gapSize * (g.last - g.first + 1) <= MAX_SCORING_WORK) {
      const words = new Set(wordsOf(r.text))
      let best = -1
      let bestScore = 0
      for (let k = Math.max(g.first, claimedLine); k <= g.last; k++) {
        if (!produces(g, k)) continue
        let score = 0
        for (const w of wordsAtLine(k)) if (words.has(w)) score += w.length
        if (score > bestScore) {
          bestScore = score
          best = k
        }
      }
      if (best >= 0) claimedLine = best
    }
    if (claimedLine >= 0 && !r.image) return span(r, claimedLine)
    const a = prevMatched(i)
    const b = nextMatched(i)
    const left = leftOnLine(a, b && b.start > (a ? a.end : 0) ? b.start : null) || leftBefore(b, a && a.region === 0 ? a.end : 0)
    if (left) return shows(r, left)
    for (let k = g.first; k <= g.last; k++) if (produces(g, k)) return span(r, k)
  })

  // Whether line k leaves a bracket open (`#for x in xs [`): what it shows
  // is its body on the lines below.
  const opensBlock = (k) => {
    const text = doc.lines[k].text
    let depth = 0
    for (let t = 0; t < text.length; t++) {
      const c = text[t]
      if (c === '"') {
        while (++t < text.length && text[t] !== '"') if (text[t] === "\\") t++
      } else if (c === "/" && text[t + 1] === "/") break
      else if (c === "(" || c === "[" || c === "{") depth++
      else if (c === ")" || c === "]" || c === "}") depth--
    }
    return depth > 0
  }
  // The first line strictly between the lines of text offsets a and b that
  // renders something where it stands and shows nothing yet (no matched
  // text, no placed run), else -1.
  const opens = new Map()
  const unshownLine = (a, b) => {
    const last = lineIndexAt(doc, b)
    for (let k = lineIndexAt(doc, a) + 1; k < last; k++) {
      if (!doc.lineProd[k] || placedLines.has(k)) continue
      if (!opens.has(k)) opens.set(k, opensBlock(k))
      if (opens.get(k)) continue
      let shown = false
      for (let t = doc.toSearch(doc.starts[k]), e = doc.toSearch(doc.starts[k] + doc.lines[k].text.length); t < e && !shown; t++) shown = ctx.claimed[t] > 0
      if (!shown) return k
    }
    return -1
  }

  // Whether something that renders and shows nothing yet lies after line k
  // and before text offset b: a line in between, or on b's own line before
  // it (the `sum` of the math line whose first matched glyph is b).
  const unshownAfter = (k, b) => {
    if (unshownLine(doc.starts[k], b) >= 0) return true
    const lb = lineIndexAt(doc, b)
    if (lb <= k) return false
    for (let t = doc.starts[lb]; t < b; t++) {
      const s = doc.toSearch(t)
      if (doc.flags[s] & PROD && !ctx.claimed[s] && doc.text.charCodeAt(t) > 32) return true
    }
    return false
  }
  const depth = (text) => {
    let d = 0
    for (const c of text) d += "([{".includes(c) ? 1 : ")]}".includes(c) ? -1 : 0
    return d
  }

  // A marker (bullet, number) stands before its text on the line: after a
  // list or heading marker, a call. A mark before text that opens a later
  // line plainly (strong or emphasis aside; not a footnote's) ends what
  // came before it instead: the number `(1)` Typst sets after an
  // equation's last glyph.
  const inNote = (q) => doc.notes.some((nt) => nt.from <= q.searchStart && q.searchStart < nt.to)
  const endsBefore = (a, b) =>
    a &&
    a.region === 0 &&
    b.region === 0 &&
    b.start > a.end &&
    lineIndexAt(doc, b.start) > lineIndexAt(doc, a.end) &&
    /^[\s*_]*$/.test(doc.text.slice(lineStart(b.start), b.start)) &&
    !inNote(b)
  // Whether run q starts with a value read from a data file.
  const valueFirst = (q) => {
    if (q.region > 0) return doc.regions[q.region].data
    const t = q.tokens && q.tokens.find((u) => u.s != null)
    return !!t && t.at === q.tokens[0].at && !!doc.regions[regionOf(doc, t.s)].data
  }
  // The list marker (`- `, `+ `) of the gap around mark i that printed it:
  // the first from the line of the text before it when that text is in
  // the gap, else the one the previous such mark took, else the gap's first.
  let lastMarker = null
  const listMarker = (i, prev) => {
    const g = gapOf(i)
    const k = lowerBound(doc.markers, g.from)
    if (!(k < doc.markers.length && doc.markers[k] < g.to)) return null
    if (prev && prev.region === 0 && prev.start >= g.from) {
      const j = lowerBound(doc.markers, Math.max(g.from, lineStart(prev.start)))
      if (j < doc.markers.length && doc.markers[j] < g.to) return doc.markers[j]
    }
    if (lastMarker != null && lastMarker >= g.from && lastMarker < g.to) return lastMarker
    return doc.markers[k]
  }
  // Marks, and anything still without a place.
  const nextPlaced = new Array(runs.length).fill(null)
  for (let i = runs.length - 2; i >= 0; i--) nextPlaced[i] = runs[i + 1].start != null ? runs[i + 1] : nextPlaced[i + 1]
  let before = null
  let text = null // the last run with letters or a picture: what a mark sits between
  let open = 0 // brackets the output of a line (`shownBy`) opened and has not closed
  // Copies and a template's text sit where their source is, out of reading
  // order: no stretch of source lies between them and their neighbours.
  const inOrder = (q) => q && q.region === 0 && q.kind !== "copy" && q.kind !== "template"
  runs.forEach((r, i) => {
    if (r.start != null) {
      before = r
      if (r.image || LETTER.test(r.text)) text = r
      return
    }
    const after = nextPlaced[i]
    // Closing punctuation, and a mark Typst set after a space (an outline
    // entry's page number after its leaders), continue the text before it;
    // so do the marks after one that a line's own output placed (below),
    // while that output has a bracket open (`(1,)` from `.get()`) or
    // nothing else is left to show before the next text (else the mark is
    // that next thing's: the `∑` of a math line below).
    const trailing = ((!r.text || CLOSING.test(r.text)) && !ALNUM.test(r.text)) || (/^\s/u.test(r.raw) && !LETTER.test(r.text))
    const continues = before && before.shownBy != null && (open > 0 || !inOrder(after) || !unshownAfter(before.shownBy, after.start))
    let quiet = -1
    let marker = null
    if ((trailing || continues) && before) {
      point(r, before.end)
      r.shownBy = before.shownBy
      if (r.shownBy != null) open += depth(r.text)
    } else if (inOrder(text) && inOrder(after) && after.start > text.end && (quiet = unshownLine(text.end, after.start)) >= 0) {
      // A line between the texts around the mark shows something that
      // nothing matched (`#context counter(page).display()`): the mark is
      // its output.
      point(r, doc.starts[quiet])
      placedLines.add(quiet)
      r.shownBy = quiet
      open = depth(r.text)
    } else if (after && valueFirst(after) && (marker = listMarker(i, before)) != null) {
      // A bullet or number before a printed value: the list marker of the
      // loop body that printed it (`#for p in people [- #p.name]`).
      point(r, lineStart(marker))
      lastMarker = marker
    } else if (before && after && before.region > 0 && before.region === after.region && before.end <= after.start) {
      const ls = recordStart(after.start)
      point(r, ls >= before.end ? ls : after.start)
    } else {
      // Something left to show on the previous text's line (`@key`,
      // `#footnote`) is what this mark shows; else it precedes the text
      // after it: at its line start when that is a later line or the
      // source starts over (the next item of a loop, a footnote under its
      // page), else right before it.
      const left = leftOnLine(prevMatched(i), after && before && after.start > before.end ? after.start : null)
      const restart =
        after &&
        (!before ||
          after.region !== before.region ||
          after.start <= before.start ||
          lineIndexAt(doc, after.start) > lineIndexAt(doc, before.end))
      // A mark opening a later line, at that line's start, reaches over the
      // word the line leaves unshown before the text after it: a caret on
      // the `integral` of `$ integral_0^1 ...` finds the `∫`.
      let lead = null
      if (!left && after && restart && !endsBefore(before, after)) {
        lead = leftBefore(after, before && before.region === 0 ? before.end : 0)
        if (lead && !LETTER.test(doc.text[lead.at])) {
          ctx.claimed.fill(0, doc.toSearch(lead.at), doc.toSearch(lead.to))
          lead = null
        }
      }
      if (left) shows(r, left)
      else if (lead) {
        point(r, recordStart(after.start))
        r.showTo = lead.to
      } else if (!after) point(r, before ? before.end : 0)
      else if (endsBefore(before, after)) point(r, before.end)
      else point(r, restart ? recordStart(after.start) : after.start)
    }
    before = r
  })
}

// What run r is matched with, given the runs around it. A word broken
// across lines continues past the run's end (Typst's break hyphen is a soft
// hyphen in a run of its own) or began before its start; in a script without
// spaces any run may start or end mid-word.
function matcher(ctx, r, prev, next) {
  const first = String.fromCodePoint(r.text.codePointAt(0))
  const last = charBefore(r.text, r.text.length)
  const relaxStart = !!(prev && BREAK_HYPHEN.test(prev.raw)) || NO_SPACE_SCRIPT.test(first)
  let relaxEnd = /\u00ad\s*$/.test(r.raw) || !!(next && /^\s*\u00ad/.test(next.raw)) || NO_SPACE_SCRIPT.test(last)
  let text = r.text
  if (/\p{L}-$/u.test(text) && !/--$/.test(text)) {
    text = text.slice(0, -1)
    relaxEnd = true
  }
  return compiled(ctx, text, relaxStart, relaxEnd)
}

// The length of `text` once folded the way runs are (an em dash is `---`, a
// soft hyphen nothing), without its leading space: where a prefix of a run's
// text ends in its normalized text.
function foldedLength(text) {
  return String(text)
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^ /, "")
    .replace(/\u2014/g, "---")
    .replace(/\u2013/g, "--").length
}

// 9. Typst splits a word into several runs where the font changes (a
// Cyrillic letter inside a Latin word, `etеr`). Neighbouring runs that touch
// inside a word (letters on both sides of the seam, no space) and found
// nothing on their own, or only a field guessed by position, are matched
// together where the sources hold their joined text once; `splitWord` hands
// each part its piece. Table cells set side by side found their own text
// and stay apart.
function matchSplitWords(ctx) {
  const { runs } = ctx
  const loose = (r) => r.m && r.m.tokens.length && (!r.anchored || r.kind === "field")
  const seam = (a, b) =>
    a.page === b.page && !/\s$/u.test(a.raw) && !/^\s/u.test(b.raw) &&
    ALNUM.test(charBefore(a.text, a.text.length)) && ALNUM.test(String.fromCodePoint(b.text.codePointAt(0)))
  for (let i = 0; i < runs.length; ) {
    let j = i + 1
    if (loose(runs[i])) while (j < runs.length && loose(runs[j]) && seam(runs[j - 1], runs[j])) j++
    if (j - i > 1) {
      const parts = runs.slice(i, j)
      const raw = parts.map((p) => p.raw).join("")
      const unit = { ...parts[0], raw, text: normalizeRun(raw), parts, anchored: false, tokens: undefined }
      unit.m = matcher(ctx, unit, runs[i - 1], runs[j])
      const hits = occurrences(ctx, unit.m, 0, ctx.S.length, 2)
      if (hits.length === 1) {
        anchor(ctx, unit, hits[0], "loose")
        splitWord(unit)
      }
    }
    i = j
  }
}

// Each part of a word matched as one run takes its piece of the match: its
// span and click spots are the word's, from where its text starts there.
function splitWord(u) {
  let at = 0
  let raw = ""
  for (const p of u.parts) {
    raw += p.raw
    const from = at
    const to = foldedLength(raw)
    at = to
    for (const key of ["anchored", "kind", "ordered", "repeat", "weak", "region", "tokens", "searchStart", "searchEnd"]) p[key] = u[key]
    if (!u.anchored) {
      p.start = u.start
      p.end = u.end
      continue
    }
    if (typeof u.spots === "function") u.spots = u.spots()
    const spots = u.spots.subarray(Math.min(from, u.spots.length - 1), Math.min(to, u.spots.length - 1) + 1)
    p.spots = spots
    p.start = spots[0]
    p.end = spots[spots.length - 1]
  }
}

// What a rule's literal text and a run are compared by: their characters
// other than whitespace, any quotation mark as `"`, each with its offset.
function squeezed(text) {
  let str = ""
  const at = []
  for (let k = 0; k < text.length; k++) {
    if (/\s/.test(text[k])) continue
    str += IS_QUOTE.test(text[k]) ? '"' : text[k]
    at.push(k)
  }
  return { str, at }
}

// The text a rule's literal piece shows: its text characters, an escape for
// the character it escapes, `~` as a space.
function pieceText(doc, [a, b]) {
  let out = ""
  for (let s = a; s < b; s++) {
    const c = doc.search[s]
    if (c === "\\" && s + 1 < b && !/\s/.test(doc.search[s + 1])) continue
    out += doc.flags[s] & DISP && c !== "~" ? c : /[\s~]/.test(c) ? " " : ""
  }
  return normalizeRun(out)
}

// A rule's piece as the literal stretches between the code it reaches
// through, those showing something: each its compared text (`str`), search
// range and whether code (or what the piece's open end touches) stands
// before or after it. `codeIn` tells whether code stands between the last
// stretch and the body (`atEnd`, the piece before it) or between the body
// and the first stretch.
function pieceParts(doc, [a, b, open, gaps], atEnd) {
  const parts = []
  let from = a
  for (const [g, e] of [...gaps, [b, b]]) {
    const str = squeezed(pieceText(doc, [from, g])).str
    // Its range without the spaces around it, where its first and last
    // characters are.
    let x = from
    let y = g
    while (x < y && /[\s~]/.test(doc.search[x])) x++
    while (y > x && /[\s~]/.test(doc.search[y - 1])) y--
    if (str) parts.push({ str, range: [x, y], codeBefore: from > a || (atEnd && open), codeAfter: g < b || (!atEnd && open) })
    from = e
  }
  const near = atEnd ? (parts.length ? parts[parts.length - 1].range[1] : a) : parts.length ? parts[0].range[0] : b
  const codeIn = gaps.some(([g, e]) => (atEnd ? g >= near : e <= near))
  return { parts, codeIn, gaps }
}

// Whether the source text at search offset `s` is shown by an element the
// rule's selector names: a heading's line (of the level asked for), a list,
// enum or term item's, or a call of the element's function holding it.
// Elements that also come from inline markup or from plain text (`strong`,
// `par`) and selectors naming no element match anywhere.
const ELEMENT_LINE = { heading: /^\s*(=+)[ \t]/, list: /^\s*-[ \t]/, enum: /^\s*(?:\+|\d+\.)[ \t]/, terms: /^\s*\/[ \t]/ }
const INLINE_ELEMENTS = new Set(["par", "text", "strong", "emph", "raw", "link", "ref", "cite", "smartquote", "math.equation", "equation", "footnote", "quote", "space", "linebreak"])

function shownByElement(doc, s, element) {
  if (!element || INLINE_ELEMENTS.has(element.name)) return true
  const t = doc.toText(s)
  const marker = ELEMENT_LINE[element.name]
  const marks = (line) => {
    const m = marker && marker.exec(line)
    return !!m && (element.level == null || !m[1] || m[1].length === element.level)
  }
  if (marks(doc.lines[lineIndexAt(doc, t)].text)) return true
  // A call of the element's function (of its parent's for a part of one:
  // `figure` for `figure.caption`), or of a function the project defines
  // that calls it (`#chapter[Intro]` with `#let chapter(t) = heading(t)`)
  // or writes its markup at the start of a line or of content
  // (`#let chapter(t) = [= #t]`).
  const parent = element.name.split(".")[0]
  const makes = (name, seen = new Set()) => {
    if (name === element.name || name === parent) return true
    if (seen.has(name) || !doc.defs.has(name)) return false
    seen.add(name)
    return doc.defs.get(name).some((d) => doc.text.slice(doc.toText(d.from), doc.toText(d.to)).split(/[\n[]/).some(marks) || [...d.callees].some((c) => makes(c, seen)))
  }
  for (const c of doc.calls) {
    if (c.at > t) break
    if (makes(c.name) && t < callArguments(doc.text, c.at + c.name.length).end) return true
  }
  return false
}

// 0. A show rule printing literal text around each element it shows
// (`#show heading: it => block[#it.body (Part)]`, `[Teil: #it.body]`):
// a run holding that text before and after a body (a run of its own the
// sources hold nowhere as a whole, the body somewhere an element the rule
// selects shows it) is matched by the body alone, the element's own text,
// and the rule's pieces keep their spots in the rule (`joinRuleRuns`). Text
// the rule's code prints between a piece and the body (a number) is not the
// body's: the body may drop its words on that side. Of several rules, the
// one whose pieces cover the most of the run.
function splitRuleRuns(ctx) {
  const { runs, doc, S } = ctx
  if (!doc.rules.length) return
  const rules = doc.rules.map((rule) => ({ rule, pre: pieceParts(doc, rule.pre, true), suf: pieceParts(doc, rule.suf, false) }))
  const shownAt = (text, element) => occurrences(ctx, compiled(ctx, text, false, false), 0, S.length, 64, true).some((h) => shownByElement(doc, h.start, element))
  for (const r of runs) {
    if (r.image || !ALNUM.test(r.text)) continue
    const q = squeezed(r.text)
    const found = []
    for (const { rule, pre, suf } of rules) {
      // The pre piece's stretches in order from the run's start (anywhere
      // after code), the suf piece's backwards from its end.
      let b0 = 0
      let ok = true
      const preAt = []
      pre.parts.forEach((p, k) => {
        const at = k === 0 && !p.codeBefore ? (q.str.startsWith(p.str) ? 0 : -1) : q.str.indexOf(p.str, b0)
        if (at < 0) ok = false
        else {
          preAt.push(at)
          b0 = at + p.str.length
        }
      })
      let e = q.str.length
      const sufAt = []
      for (let k = suf.parts.length - 1; k >= 0 && ok; k--) {
        const p = suf.parts[k]
        const at = k === suf.parts.length - 1 && !p.codeAfter ? (q.str.endsWith(p.str) ? q.str.length - p.str.length : -1) : q.str.lastIndexOf(p.str, e - p.str.length)
        if (at < b0 || at + p.str.length > e) ok = false
        else {
          sufAt.unshift(at)
          e = at
        }
      }
      if (!ok || e <= b0) continue
      const cover = [...pre.parts, ...suf.parts].reduce((n, p) => n + p.str.length, 0)
      const from = q.at[b0]
      const to = q.at[e - 1] + 1
      if (!cover || !ALNUM.test(r.text.slice(from, to))) continue
      const at = (list, parts) => list.map((x, k) => [q.at[x], q.at[x + parts[k].str.length - 1] + 1])
      found.push({ rule, pre, suf, cover, from, to, preSpans: at(preAt, pre.parts), sufSpans: at(sufAt, suf.parts) })
    }
    if (!found.length || occurrences(ctx, compiled(ctx, r.text, false, false), 0, S.length, 1, true).length) continue
    found.sort((x, y) => y.cover - x.cover)
    for (const f of found) {
      // The body's words, fewer of them on a side the rule's code prints.
      const words = tokensOf(r.text.slice(f.from, f.to))
      let body = null
      for (let i = 0; i < words.length && !body && (i === 0 || f.pre.codeIn); i++) {
        for (let j = words.length; j > i && !body && (j === words.length || f.suf.codeIn); j--) {
          const a = i === 0 ? f.from : f.from + words[i].at
          const b = j === words.length ? f.to : f.from + words[j - 1].at + words[j - 1].text.length
          if (shownAt(r.text.slice(a, b), f.rule.element)) body = [a, b]
        }
      }
      if (!body) continue
      r.split = { ...f, body, text: r.text }
      r.text = r.text.slice(body[0], body[1])
      break
    }
  }
}

// The runs `splitRuleRuns` matched by their body take back their whole
// text: the body keeps its spots, each stretch of the rule's pieces walks
// its own text in the rule, and what the rule's code (or the code next to
// an open piece) printed beside them (a number) takes the spot of that
// code. The pieces also count as shown by the run, so a caret on the rule
// finds the elements it shows.
function joinRuleRuns(ctx) {
  const { runs, doc, S } = ctx
  for (const r of runs) {
    const sp = r.split
    if (!sp) continue
    delete r.split
    r.text = sp.text
    if (!r.anchored) continue
    const inner = r.spots
    const { pre, suf } = sp.rule
    const n = sp.text.length
    const [from, to] = sp.body
    // Where text printed between the stretches goes: the code after the
    // stretch before it, else the piece's edge.
    const codeAfter = (side, s, edge) => {
      const g = side.gaps.find(([a]) => a >= s)
      return doc.toText(g ? g[0] : edge)
    }
    const codeBefore = (side, s, edge) => {
      const g = side.gaps.filter(([, e]) => e <= s).pop()
      return doc.toText(g ? g[0] : edge)
    }
    r.spots = () => {
      const body = typeof inner === "function" ? inner() : inner
      const out = new Int32Array(n + 1)
      const walk = (k0, k1, [a, b]) => {
        const map = new Int32Array(n + 1).fill(-1)
        walkSpots(S, sp.text, k0, k1, a, b, map)
        for (let k = k0; k <= k1; k++) out[k] = doc.toText(map[k] >= 0 ? map[k] : a)
      }
      const first = sp.pre.parts[0]
      out.fill(!first ? codeBefore(sp.pre, pre[1], pre[0]) : first.codeBefore ? codeBefore(sp.pre, first.range[0], pre[0]) : doc.toText(first.range[0]), 0, from)
      sp.pre.parts.forEach((p, k) => {
        const [k0, k1] = sp.preSpans[k]
        walk(k0, k1, p.range)
        out.fill(codeAfter(sp.pre, p.range[1], pre[1]), k1 + 1, k + 1 < sp.pre.parts.length ? sp.preSpans[k + 1][0] : from)
      })
      const next = sp.suf.parts[0]
      out.fill(next ? codeBefore(sp.suf, next.range[0], suf[0]) : codeAfter(sp.suf, suf[0], suf[1]), to, n + 1)
      sp.suf.parts.forEach((p, k) => {
        const [k0, k1] = sp.sufSpans[k]
        walk(k0, k1, p.range)
        const last = k + 1 === sp.suf.parts.length
        out.fill(last ? (p.codeAfter ? codeAfter(sp.suf, p.range[1], suf[1]) : doc.toText(p.range[1])) : codeAfter(sp.suf, p.range[1], suf[1]), k1 + 1, last ? n + 1 : sp.sufSpans[k + 1][0])
      })
      for (let k = from; k <= to; k++) out[k] = body[Math.min(k - from, body.length - 1)]
      return out
    }
    const shift = (r.tokens || []).map((t) => ({ ...t, at: t.at + from }))
    const piece = (p, [k0]) => token(doc, S.slice(p.range[0], p.range[1]), k0, p.range[0])
    r.tokens = [...sp.pre.parts.map((p, k) => piece(p, sp.preSpans[k])), ...shift, ...sp.suf.parts.map((p, k) => piece(p, sp.sufSpans[k]))]
  }
}

export function alignRuns(container, doc) {
  const runs = []
  const pages = new Map()
  const pageOf = (node) => {
    const g = node.closest ? node.closest(".typst-page") : null
    if (!g) return 0
    if (!pages.has(g)) pages.set(g, pages.size)
    return pages.get(g)
  }
  // Text runs and pictures, in document order.
  for (const sel of container.querySelectorAll(".tsel, image")) {
    const base = { start: null, end: null, anchored: false, ordered: false, repeat: false, weak: false, page: pageOf(sel) }
    if (sel.tagName && sel.tagName.toLowerCase() === "image") {
      runs.push({ ...base, el: sel, text: "", raw: "", image: true })
      continue
    }
    if (sel.parentElement && sel.parentElement.closest(".tsel")) continue
    const raw = sel.textContent || ""
    runs.push({ ...base, el: sel.closest(".typst-text") || sel, text: normalizeRun(raw), raw })
  }
  const ctx = alignmentContext(doc, runs)
  splitRuleRuns(ctx)
  runs.forEach((r, i) => {
    if (!r.image && r.text) r.m = matcher(ctx, r, runs[i - 1], runs[i + 1])
  })
  pairCorrespondences(ctx)
  matchNotes(ctx)
  matchGaps(ctx)
  matchDisplaced(ctx)
  matchPageContent(ctx)
  matchSuffixes(ctx)
  matchWords(ctx, false)
  // A run whose literal part is in the body lives there, whatever values
  // it shows; only then are runs matched into data files by their words.
  matchPartial(ctx, false)
  matchWords(ctx, true)
  matchTemplates(ctx)
  matchCopies(ctx)
  matchPartial(ctx, true)
  matchFields(ctx)
  matchSplitWords(ctx)
  matchFurniture(ctx)
  placeRest(ctx)
  joinRuleRuns(ctx)
  // Every run whose text is not found in the body remembers the stretch of
  // body lines between the body runs around it (the backbone and the
  // literal parts of mixed runs): a caret on a line in it whose own text
  // matched nothing (`#csv(...)`, `#for x in data [...]`, `#greeting`) finds
  // these runs. Runs found in the body are found on their own lines.
  const inBody = (r) => r.region === 0 && r.anchored && r.kind !== "copy" && r.kind !== "field" && r.kind !== "template" && r.producer == null && !r.furniture
  const nb = bodyNeighbours(ctx, (r) => r.region === 0 && (r.ordered || (r.kind === "partial" && r.producer == null && !r.furniture)))
  runs.forEach((r, i) => {
    delete r.m
    if (inBody(r)) return
    r.gapFrom = nb.prev[i] >= 0 ? lineIndexAt(doc, runs[nb.prev[i]].end) + 1 : 0
    r.gapTo = nb.next[i] >= 0 ? lineIndexAt(doc, runs[nb.next[i]].start) : doc.primaryLines
  })
  producerRanges(doc, runs)
  return runs
}

// Inside one stretch between body runs, which lines printed which runs: a
// template's text was printed by the line calling it, a placed run by its
// line, values matched in a data file by the line of the stretch naming
// that file (`#csv("a.csv")`), when that keeps the lines in reading order.
// The other runs printed the lines between those, and a producer's lines
// run on to the next one (its arguments, its closing bracket). A caret on a
// line of the stretch then finds what that line printed (`prodFrom` ..
// `prodTo`, doc line indices).
function producerRanges(doc, runs) {
  for (let i = 0; i < runs.length; ) {
    const r0 = runs[i]
    if (r0.gapFrom == null) {
      i++
      continue
    }
    let j = i
    while (j < runs.length && runs[j].gapFrom === r0.gapFrom && runs[j].gapTo === r0.gapTo) j++
    const group = runs.slice(i, j).filter((r) => r.start != null)
    i = j
    const from = r0.gapFrom
    const to = Math.max(from, r0.gapTo - 1)
    const line = new Int32Array(group.length).fill(-1)
    group.forEach((r, k) => {
      if (r.producer != null) line[k] = lineIndexAt(doc, r.producer)
      else if (!r.anchored && r.region === 0 && (r.end > r.start || r.image)) line[k] = lineIndexAt(doc, r.start)
    })
    // Values of a data file and the marks printed among them: the line
    // naming it, between the lines known before and after them (a copy may
    // come from anywhere).
    const lo = doc.toSearch(doc.starts[from])
    const hi = r0.gapTo < doc.primaryLines ? doc.toSearch(doc.starts[r0.gapTo]) : doc.primaryEndS
    const named = doc.mentions.filter((m) => m.at >= lo && m.at < hi)
    const byName = new Uint8Array(group.length)
    if (named.length) {
      const after = new Int32Array(group.length + 1).fill(to + 1)
      for (let k = group.length - 1; k >= 0; k--) after[k] = line[k] >= 0 ? Math.min(line[k], after[k + 1]) : after[k + 1]
      let seen = from
      group.forEach((r, k) => {
        if (line[k] >= 0) {
          seen = Math.max(seen, line[k])
          return
        }
        if (r.region === 0 || r.kind === "copy") return
        const m = named.find((x) => x.region === r.region && lineIndexAt(doc, doc.toText(x.at)) >= seen)
        const l = m ? lineIndexAt(doc, doc.toText(m.at)) : -1
        if (l >= 0 && l <= after[k + 1]) {
          line[k] = l
          byName[k] = 1
        }
      })
    }
    // Ranges: a stretch of runs without a line takes the lines between its
    // neighbours' lines; a run with a line takes it up to the next range.
    const range = group.map(() => [from, to])
    for (let k = 0; k < group.length; ) {
      if (line[k] >= 0) {
        k++
        continue
      }
      let e = k
      while (e < group.length && line[e] < 0) e++
      let a = k > 0 ? line[k - 1] + 1 : from
      let b = e < group.length ? line[e] - 1 : to
      if (a > b) a = b = k > 0 ? line[k - 1] : line[e]
      for (let t = k; t < e; t++) range[t] = [a, b]
      k = e
    }
    // The values of the file one line names share its reach: a caret on the
    // lines after `#let rows = csv(...)` finds the first value printed, not
    // the last.
    for (let k = group.length - 1; k >= 0; k--) {
      if (line[k] < 0) continue
      const same = k + 1 < group.length && byName[k] && byName[k + 1] && line[k + 1] === line[k]
      const next = k + 1 < group.length ? range[k + 1][0] : to + 1
      range[k] = [k === 0 ? Math.min(from, line[k]) : line[k], same ? range[k + 1][1] : next > line[k] ? next - 1 : line[k]]
    }
    group.forEach((r, k) => {
      r.prodFrom = range[k][0]
      r.prodTo = range[k][1]
    })
  }
}

const ARG_NAME = /^\s*([\p{L}_][\p{L}\p{N}_-]*)\s*:(?!:)\s*/u

// The arguments of the call whose parenthesis or first content block opens
// at `open` (its argument list and the content blocks right after it): each
// argument's name (null when positional), the offset where its value starts
// (inside a string's quotes or a block's bracket) and the one past it
// (`to`), with `end` past the last group. Stops at the end of the text.
function callArguments(text, open) {
  const args = []
  let k = open
  const piece = (a, b) => {
    const m = ARG_NAME.exec(text.slice(a, b))
    // An array's first item stands for it (`authors: ("Ada", "Bo")`).
    let v = a + (m ? m[0].length : 0)
    while (v < b && /[\s(]/.test(text[v])) v++
    if (v >= b) return
    args.push({ name: m ? m[1] : null, at: v + (text[v] === '"' || text[v] === "[" ? 1 : 0), to: b })
  }
  // Past the bracket group opening at `from`, strings skipped.
  const group = (from) => {
    let depth = 0
    for (let t = from; t < text.length; t++) {
      const c = text[t]
      if (c === '"') {
        while (++t < text.length && text[t] !== '"' && text[t] !== "\n") if (text[t] === "\\") t++
      } else if (c === "(" || c === "[" || c === "{") depth++
      else if ((c === ")" || c === "]" || c === "}") && --depth === 0) return t + 1
    }
    return text.length
  }
  if (text[open] === "(") {
    let a = open + 1
    let depth = 0
    for (k = open + 1; k < text.length; k++) {
      const c = text[k]
      if (c === '"') {
        while (++k < text.length && text[k] !== '"' && text[k] !== "\n") if (text[k] === "\\") k++
      } else if (c === "(" || c === "[" || c === "{") depth++
      else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--
      else if (c === "," && depth === 0) {
        piece(a, k)
        a = k + 1
      } else if (c === ")") {
        piece(a, k)
        k++
        break
      }
    }
  }
  while (text[k] === "[") {
    const at = k + 1
    k = group(k)
    args.push({ name: null, at, to: k })
  }
  args.end = k
  return args
}

// A caret on a line of a function's definition that names one of its
// parameters (`text(17pt, title)` in `#let project(title: "", body) =
// ...`): where the first call passing that argument (`project.with(title:
// "...")`, `#note(title: "...")[...]`) writes its value, as a text offset.
// The last positional parameter left out of a `#show: name.with(...)` rule
// is the rest of the document: the start of the line after the rule
// (`rest`). `use` is where the line names the parameter. Else null.
function argumentOffset(doc, li) {
  const at = doc.toSearch(doc.starts[li])
  const line = doc.lines[li].text
  for (const [name, list] of doc.defs) {
    const d = list.find((x) => x.from <= at && at < x.to)
    if (!d) continue
    const params = parametersAt(doc, doc.toText(d.from))
    if (!params) continue
    let use = -1
    const used = params.find((p) => {
      const m = p.name && new RegExp(`(^|[^\\p{L}\\p{N}_.-])${p.name}(?![\\p{L}\\p{N}_-]|\\s*:)`, "u").exec(line)
      if (m) use = m.index + m[1].length
      return m
    })
    if (!used) continue
    const p = passedArgument(doc, name, list, params, used)
    if (p) return p.arg ? { at: p.arg.at, use: doc.starts[li] + use } : { at: p.rest, rest: true, use: doc.starts[li] + use }
  }
  return null
}

// The parameters of the function a `let` at text offset `from` binds (`let
// project(title: "", body) = ...`): named ones (`title: ""`) and positional
// ones in order. Null when it binds no function.
function parametersAt(doc, from) {
  const head = /^let\s+[\p{L}_][\p{L}\p{N}_-]*\s*(?=\()/u.exec(doc.text.slice(from, from + 256))
  if (!head) return null
  return callArguments(doc.text, from + head[0].length).map((p) =>
    p.name ? { name: p.name, named: true } : { name: (/^[\p{L}_][\p{L}\p{N}_-]*/u.exec(doc.text.slice(p.at, p.at + 64)) || [""])[0], named: false }
  )
}

// The first call of function `name` (defined at `list`) that passes its
// parameter `used`: { arg } with that argument (`project.with(title:
// "...")`), or { rest } for a `#show: name.with(...)` rule leaving out the
// last positional one, the start of the line after the rule. Null when no
// call does.
function passedArgument(doc, name, list, params, used) {
  const positional = params.filter((p) => !p.named)
  const call = new RegExp(`(^|[^\\p{L}\\p{N}_-])${name}(?:\\.with)?(?=[(\\[])`, "gu")
  for (let m = call.exec(doc.text); m; m = call.exec(doc.text)) {
    const c = m.index + m[1].length
    const cs = doc.toSearch(c)
    if (list.some((x) => x.from <= cs && cs < x.to) || doc.regions[regionOf(doc, cs)].data) continue
    const args = callArguments(doc.text, c + m[0].length - m[1].length)
    const arg = used.named ? args.find((a) => a.name === used.name) : args.filter((a) => !a.name)[positional.indexOf(used)]
    if (arg) return { arg }
    const ls = doc.starts[lineIndexAt(doc, c)]
    if (!used.named && used === positional[positional.length - 1] && /show\s*:\s*$/.test(doc.text.slice(ls, c))) {
      const next = lineIndexAt(doc, c) + 1
      if (next < doc.lines.length) return { rest: doc.starts[next] }
    }
  }
  return null
}

// How much a run containing the caret is its own: matched text first, then
// copies and partial matches, then runs placed on a whole line, then marks
// placed at a point.
function ownership(r) {
  const wide = r.end > r.start
  if (r.anchored && !r.weak && wide) return 0
  if (r.anchored && wide) return 1
  return wide ? 2 : 3
}

// The run the caret is in (its own text before copies and placed lines; a
// value a mixed run shows from a data file counts as inside it). Failing
// that, the next run on the caret's own line, a value a run shows there
// included (the caret sits on a `== `, a `caption: [` or a data key before
// it), then a mark placed right at the caret, then the run before the caret
// on its line (a comment after the text). Failing that, the caret's line
// produced output that matched nothing of its own (a `#csv(...)` whose rows
// resolved to the data file, a call printing a template): the runs printed
// between the body runs around it, those that line printed first (see
// `producerRanges`), the one sharing a word with the line first. Else the
// nearest run after the caret in its own file, else before it; in a data
// file a line closing a bracket belongs to the record above it.
export function runForOffset(runs, offset, doc, viaArgument = true) {
  let best = null
  let after = null
  let before = null
  let mark = null
  const li = doc ? lineIndexAt(doc, offset) : -1
  const lineFrom = doc ? doc.starts[li] : 0
  const lineTo = doc ? lineFrom + doc.lines[li].text.length : 0
  const region = doc ? regionOf(doc, doc.toSearch(offset)) : -1
  let nextOn = null
  let nextAt = Infinity
  let prevOn = null
  let prevAt = -Infinity
  const shows = (r) => r.tokens && r.tokens.some((t) => t.src != null && t.src <= offset && offset <= t.src + t.text.length)
  // The nearest spots on the caret's line after and before it: a run's own
  // span or a value it shows.
  const near = (r, a, b) => {
    if (a > offset && a <= lineTo && (a < nextAt || (a === nextAt && ownership(r) < ownership(nextOn)))) {
      nextOn = r
      nextAt = a
    }
    if (b < offset && b >= lineFrom && (b > prevAt || (b === prevAt && ownership(r) < ownership(prevOn)))) {
      prevOn = r
      prevAt = b
    }
  }
  for (const r of runs) {
    if (r.start == null) continue
    const reach = r.showTo != null ? r.showTo : r.end
    if (r.start === offset && reach === offset) {
      if (!mark) mark = r
    } else if ((r.start <= offset && offset <= reach) || shows(r)) {
      // Between two runs that touch (`(` then `birds`), the caret before a
      // character belongs to the run that starts there.
      const own = ownership(r)
      if (!best || own < ownership(best) || (own === ownership(best) && best.end === offset && r.end > offset)) best = r
    } else if (doc && (r.region !== region || (r.within && !(r.within[0] <= offset && offset <= r.within[1])))) {
      // Only runs of the caret's own file region are near it; text a
      // template printed only inside the definition it comes from.
    } else if (r.start > offset) {
      if (!after || r.start < after.start || (r.start === after.start && ownership(r) < ownership(after))) after = r
    } else if (!before || r.end > before.end || (r.end === before.end && ownership(r) < ownership(before))) {
      before = r
    }
    if (!doc) continue
    // A mark placed at a line's start (a loop's bullet) is no spot for a
    // caret further on that line: the text that line printed is.
    if (r.anchored || r.start < r.end || r.start !== lineFrom || region > 0) near(r, r.start, r.end)
    if (r.tokens) for (const t of r.tokens) if (t.src != null) near(r, t.src, t.src + t.text.length)
  }
  if (best) return best
  if (!doc) return mark || after || before
  if (nextOn) return nextOn
  if (mark) return mark
  // A parameter the line names past the text before the caret (`[Achtung
  // #level:] #msg` in a definition): what the first call passed for it.
  const arg = viaArgument ? argumentOffset(doc, li) : null
  if (prevOn && !(arg && arg.use >= prevAt)) return prevOn
  if (arg) {
    if (arg.rest) {
      // The first run of the rest of the document.
      const g = regionOf(doc, doc.toSearch(arg.at))
      let first = null
      for (const r of runs) if (r.start != null && r.start >= arg.at && r.region === g && (!first || r.start < first.start)) first = r
      if (first) return first
    } else {
      const r = runForOffset(runs, arg.at, doc, false)
      if (r && r.start <= arg.at && arg.at <= (r.showTo != null ? r.showTo : r.end)) return r
    }
  }
  if (prevOn) return prevOn
  const inGap = runs.filter((r) => r.gapFrom != null && r.start != null && r.gapFrom <= li && li < r.gapTo)
  if (inGap.length) {
    const own = inGap.filter((r) => r.prodFrom <= li && li <= r.prodTo)
    // Words with letters only: a digit shared with `slice(1)` says nothing.
    const words = new Set(wordsOf(doc.lines[li].text).filter((w) => LETTER.test(w)))
    let pick = null
    let pickScore = -1
    for (const r of own.length ? own : inGap) {
      let n = 0
      for (const w of new Set(wordsOf(r.text))) if (words.has(w)) n++
      if (n > pickScore || (n === pickScore && ownership(r) < ownership(pick))) {
        pick = r
        pickScore = n
      }
    }
    return pick
  }
  if (doc.regions[region].data && /^\s*[}\])]/.test(doc.lines[li].text)) return before || after
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

// Where in the source a click lands, given the run's text before the click
// as the text layer holds it. Matching saw that text normalized, so the
// click is counted the same way (an en dash is `--`, an ellipsis `...`) and
// looked up in the run's spots (see `spotsOf`): a matched run maps character
// by character, a value of a mixed run into its data file. A run placed on
// a line rather than matched (generated text) goes to its end.
export function clickSpot(run, before) {
  if (!run.anchored) return run.end
  const idx = foldedLength(before)
  if (typeof run.spots === "function") run.spots = run.spots()
  if (!run.spots) return run.start
  return run.spots[Math.max(0, Math.min(idx, run.spots.length - 1))]
}

// ── Glyphs ───────────────────────────────────────────────────────────────────
// Typst draws a run's characters as glyphs: its `.typst-text` group holds one
// `<use>` per glyph at the glyph's pen position (`x`, in the group's units).
// The hidden text layer is set in the browser's own font, narrower or wider
// than the glyphs (a monospace dump, negative tracking), so a click is read
// off the glyphs, the way typst.ts's own text layout maps glyphs to
// characters: each glyph draws one character, or `1 + data-liga-len` when
// its definition marks a ligature.

// Scripts written right to left: their glyphs come in visual order, against
// the text's, so such a run is read off the text layer.
const RTL_SCRIPT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u

// The run's words paired with its glyphs: characters and glyphs cut at
// whitespace and at blank glyphs (no outline: a space) must give the same
// sequence of words and gaps. Null when they do not.
function pairWords(chars, glyphs) {
  const segments = (list, gap) => {
    const out = []
    list.forEach((v, k) => {
      const isGap = gap(v)
      const last = out[out.length - 1]
      if (last && last.gap === isGap) last.to = k + 1
      else out.push({ gap: isGap, from: k, to: k + 1 })
    })
    return out
  }
  const cs = segments(chars, (c) => /\s/u.test(c))
  const gs = segments(glyphs, (g) => g.blank)
  if (cs.length !== gs.length || cs.some((s, k) => s.gap !== gs[k].gap)) return null
  return cs.map((s, k) => ({ gap: s.gap, c: s.from, cEnd: s.to, g: gs[k].from, gEnd: gs[k].to }))
}

// How many characters (code points) each glyph draws. When the marked
// counts miss the text (this renderer leaves most ligatures unmarked: `fi`,
// `fl`, `fj` draw two characters with one glyph), the run's words are
// paired with its glyphs (`pairWords`). Inside a word with fewer glyphs than
// characters, a glyph the page draws elsewhere for one character (`char`)
// draws that character here too, and the others take the characters whose
// widths best fill their advances, so a ligature takes its letters. A
// character's width is its advance where the run or its page draws it
// alone, else its width in the text layer (`layer`, scaled to the glyphs),
// else the mean advance. Null when the glyphs cannot account for the text.
const MISFIT = 1e15

function glyphCounts(chars, glyphs, endX, layer) {
  const marked = glyphs.map((g) => g.n || 1)
  if (marked.reduce((a, b) => a + b, 0) === chars.length) return marked
  if (glyphs.length > chars.length) return null
  const words = pairWords(chars, glyphs)
  if (!words) return null
  const adv = glyphs.map((g, k) => Math.max(0, (k + 1 < glyphs.length ? glyphs[k + 1].x : Math.max(endX, g.x)) - g.x))
  const width = new Map()
  let sum = 0
  let num = 0
  const learn = (ch, w) => {
    if (!width.has(ch)) width.set(ch, w)
    if (!/\s/u.test(ch)) {
      sum += w
      num++
    }
  }
  glyphs.forEach((g, k) => {
    if (g.char) learn(g.char, adv[k])
  })
  for (const w of words) if (w.cEnd - w.c === w.gEnd - w.g) for (let j = w.c; j < w.cEnd; j++) learn(chars[j], adv[w.g + j - w.c])
  const layerTotal = layer ? layer.reduce((x, y) => x + y, 0) : 0
  const scale = layerTotal > 0 ? adv.reduce((x, y) => x + y, 0) / layerTotal : 0
  const counts = new Array(glyphs.length).fill(1)
  for (const w of words) {
    const c = w.cEnd - w.c
    const g = w.gEnd - w.g
    if (g > c) return null
    if (g === c) continue
    const a = adv.slice(w.g, w.gEnd)
    const mean = num ? sum / num : a.reduce((x, y) => x + y, 0) / c
    const pre = [0]
    for (let j = 0; j < c; j++) {
      const ch = chars[w.c + j]
      pre.push(pre[j] + (width.has(ch) ? width.get(ch) : scale ? layer[w.c + j] * scale : mean))
    }
    // cost[i][j]: least squared misfit of the first i glyphs drawing the
    // first j characters, each at least one.
    const cost = Array.from({ length: g + 1 }, () => new Float64Array(c + 1).fill(Infinity))
    const take = Array.from({ length: g + 1 }, () => new Int32Array(c + 1))
    cost[0][0] = 0
    for (let i = 1; i <= g; i++) {
      const known = glyphs[w.g + i - 1].char
      for (let j = i; j <= c - (g - i); j++) {
        for (let m = 1; m <= j - (i - 1); m++) {
          const d = a[i - 1] - (pre[j] - pre[j - m])
          const misfit = known ? (m === 1 && chars[w.c + j - 1] === known ? 0 : MISFIT) : d * d
          const v = cost[i - 1][j - m] + misfit
          if (v < cost[i][j]) {
            cost[i][j] = v
            take[i][j] = m
          }
        }
      }
    }
    for (let i = g, j = c; i > 0; i--) {
      counts[w.g + i - 1] = take[i][j]
      j -= take[i][j]
    }
  }
  return counts
}

// The text of a run before a pointer at `x` along its baseline, given its
// glyphs ({ x: pen position, n: characters marked, blank: no outline,
// char: what the glyph draws elsewhere or null }, in order) and where the
// run ends (`endX`), all in the same units, and optionally each character's
// width in the text layer (`layer`, any unit). Inside a
// glyph its characters share its advance evenly; the caret goes before the
// character whose share holds the pointer in its left half, after it in its
// right half. Null when the glyphs cannot be read (none, right to left, out
// of order, or not accounting for the text).
export function textBeforeX(text, glyphs, endX, x, layer = null) {
  if (!glyphs.length || RTL_SCRIPT.test(text)) return null
  for (let k = 1; k < glyphs.length; k++) if (glyphs[k].x < glyphs[k - 1].x) return null
  const chars = Array.from(text)
  const counts = glyphCounts(chars, glyphs, endX, layer)
  if (!counts) return null
  let before = 0
  if (x >= glyphs[0].x) {
    let g = glyphs.length - 1
    while (g > 0 && x < glyphs[g].x) g--
    for (let k = 0; k < g; k++) before += counts[k]
    const right = g + 1 < glyphs.length ? glyphs[g + 1].x : Math.max(endX, glyphs[g].x)
    const share = (right - glyphs[g].x) / counts[g]
    const into = share > 0 ? Math.round((x - glyphs[g].x) / share) : x > glyphs[g].x ? counts[g] : 0
    before += Math.max(0, Math.min(counts[g], into))
  }
  return chars.slice(0, before).join("")
}

function glyphRef(use) {
  const ref = use.getAttribute("href") || use.getAttribute("xlink:href") || ""
  return ref.startsWith("#") ? ref.slice(1) : ""
}

// A glyph without an outline to draw (a space).
function blankGlyph(def) {
  return !def || !(def.getAttribute("d") || def.children.length)
}

function glyphUses(group) {
  return Array.from(group.children).filter((c) => c.tagName && c.tagName.toLowerCase() === "use")
}

// The character each glyph of a page draws, learnt from the words of the
// page's runs drawn one glyph per character (null where two words
// disagree). Built once per page of a render: a new render brings new
// elements.
const lexicons = new WeakMap()

function lexiconOf(group) {
  const page = group.closest(".typst-page") || group.parentNode
  if (!page) return new Map()
  let lex = lexicons.get(page)
  if (lex) return lex
  lex = new Map()
  const doc = group.ownerDocument
  for (const sel of page.querySelectorAll(".tsel")) {
    const g = sel.closest(".typst-text")
    const text = sel.textContent || ""
    if (!g || RTL_SCRIPT.test(text)) continue
    const uses = glyphUses(g)
    const ids = uses.map(glyphRef)
    const chars = Array.from(text)
    const words = uses.length === chars.length ? [{ c: 0, cEnd: chars.length, g: 0, gEnd: uses.length }] : pairWords(chars, ids.map((id) => ({ blank: blankGlyph(id && doc.getElementById(id)) })))
    for (const w of words || []) {
      if (w.cEnd - w.c !== w.gEnd - w.g) continue
      for (let j = 0; j < w.cEnd - w.c; j++) {
        const id = ids[w.g + j]
        const ch = chars[w.c + j]
        if (!id) continue
        if (!lex.has(id)) lex.set(id, ch)
        else if (lex.get(id) !== ch) lex.set(id, null)
      }
    }
  }
  lexicons.set(page, lex)
  return lex
}

// Each character's width in the run's text layer (the browser's font: a
// stand-in for the proportions of the glyphs).
function layerWidths(sel) {
  const out = []
  const range = sel.ownerDocument.createRange()
  const walker = sel.ownerDocument.createTreeWalker(sel, NodeFilter.SHOW_TEXT)
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    for (let i = 0; i < t.textContent.length; ) {
      const len = String.fromCodePoint(t.textContent.codePointAt(i)).length
      range.setStart(t, i)
      range.setEnd(t, i + len)
      out.push(range.getBoundingClientRect().width)
      i += len
    }
  }
  return out
}

// The run's text before the pointer, read off its glyphs (see `textBeforeX`):
// the pointer and the run's end (the far edge of its text layer box) are
// mapped into the glyph group's own units, so a scaled or rotated run reads
// the same. Null when the run draws no glyphs or they cannot be read.
export function glyphTextBefore(run, event) {
  const group = run.el
  if (!group || !group.children || typeof group.getScreenCTM !== "function") return null
  const uses = glyphUses(group)
  const sel = group.querySelector(".tsel")
  const box = sel && sel.closest("foreignObject")
  const ctm = group.getScreenCTM()
  const boxCtm = box && box.getScreenCTM()
  if (!uses.length || !box || !ctm || !boxCtm) return null
  const inv = ctm.inverse()
  const local = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f })
  const at = local(inv, event.clientX, event.clientY)
  const far = local(boxCtm, (parseFloat(box.getAttribute("x")) || 0) + (parseFloat(box.getAttribute("width")) || 0), parseFloat(box.getAttribute("y")) || 0)
  const end = local(inv, far.x, far.y)
  const doc = group.ownerDocument
  const text = sel.textContent || ""
  const glyphs = uses.map((u) => {
    const def = glyphRef(u) ? doc.getElementById(glyphRef(u)) : null
    return {
      x: parseFloat(u.getAttribute("x")) || 0,
      n: 1 + (parseInt(def && def.getAttribute("data-liga-len"), 10) || 0),
      blank: blankGlyph(def),
      char: null
    }
  })
  // Only a run whose glyphs miss its characters needs the page's lexicon
  // and the layer's proportions.
  let layer = null
  if (glyphs.reduce((t, g) => t + g.n, 0) !== Array.from(text).length) {
    const lex = lexiconOf(group)
    uses.forEach((u, k) => {
      glyphs[k].char = lex.get(glyphRef(u)) || null
    })
    layer = layerWidths(sel)
  }
  return textBeforeX(text, glyphs, end.x, at.x, layer)
}

// The text position under (x, y) inside `root`, found by measuring each
// character's box: the caret goes before the character when the pointer is
// on its left half, after it otherwise. Null when no character is on that
// line of the root.
function characterAt(root, x, y) {
  const range = document.createRange()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let best = null
  let bestDx = Infinity
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    for (let i = 0; i < t.textContent.length; i++) {
      range.setStart(t, i)
      range.setEnd(t, i + 1)
      const b = range.getBoundingClientRect()
      if (!b.width || y < b.top || y > b.bottom) continue
      if (x >= b.left && x <= b.right) return { node: t, offset: x < b.left + b.width / 2 ? i : i + 1 }
      const dx = x < b.left ? b.left - x : x - b.right
      if (dx < bestDx) {
        bestDx = dx
        best = { node: t, offset: x < b.left ? i : i + 1 }
      }
    }
  }
  return best
}

// Where in the run's source the click landed: the character under the
// pointer as the glyphs show it, else as the text layer lays it out (a
// picture, a run whose glyphs cannot be read), else the run's end.
function clickedOffset(run, event) {
  if (!run.anchored) return run.end
  const drawn = glyphTextBefore(run, event)
  if (drawn != null) return clickSpot(run, drawn)
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
  // Over a link Typst draws a rectangle on top of the text, so the point
  // resolves to that rectangle rather than a character: find the character
  // under the pointer from the text's own layout instead.
  if (!node || !sel.contains(node)) {
    const hit = characterAt(sel, event.clientX, event.clientY)
    if (!hit) return run.end
    node = hit.node
    offset = hit.offset
  }
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
  return clickSpot(run, sel.textContent.slice(0, before))
}

// The text of `file` as the rendered compile saw it: the buffer, or one of
// the project's sources (null when the compile did not have it).
function renderedText(file) {
  const project = rendered.project || {}
  if ((cleanPath(project.mainPath) || "main.typ") === file) return rendered.content || ""
  const src = (project.sources || []).find((s) => s && cleanPath(s.path) === file)
  return src ? src.content || "" : null
}

// Offset of `line`/`col` (1-based) in `text`, clamped to that line.
function textOffset(text, line, col) {
  let start = 0
  for (let n = 1; n < line; n++) {
    const nl = text.indexOf("\n", start)
    if (nl < 0) break
    start = nl + 1
  }
  let end = text.indexOf("\n", start)
  if (end < 0) end = text.length
  return Math.min(start + Math.max((col || 1) - 1, 0), end)
}

function textLocation(text, offset) {
  const before = text.slice(0, offset)
  const nl = before.lastIndexOf("\n")
  return { line: before.split("\n").length, col: offset - nl }
}

// The same spot in a newer copy of a file. A clicked location is found in
// `basis`, the text the preview was compiled and aligned from, but the
// editor may hold newer text: a save from another session that the jump's
// re-read brought in, or keystrokes made since the compile. Text the two
// copies share before the changed stretch keeps its offset, text they share
// after it moves by the change's length. Inside the changed stretch an edit
// may sit both above and below the click, or in the clicked line itself, so
// the lines of that stretch are diffed: a line both copies keep moves to its
// partner (which picks the right copy of a repeated line), and an edited
// line goes to the most alike line among those that replaced it.
export function relocate(basis, fresh, line, col) {
  if (basis == null || fresh == null || basis === fresh) return { line, col }
  const off = textOffset(basis, line, col)
  const shared = Math.min(basis.length, fresh.length)
  let pre = 0
  while (pre < shared && basis[pre] === fresh[pre]) pre++
  let suf = 0
  while (suf < shared - pre && basis[basis.length - 1 - suf] === fresh[fresh.length - 1 - suf]) suf++
  let spot
  if (off >= basis.length - suf) spot = off + fresh.length - basis.length
  else if (off < pre) spot = off
  else spot = relocateByLines(basis, fresh, off)
  return textLocation(fresh, Math.max(0, Math.min(spot, fresh.length)))
}

// Largest middle stretch (lines × lines) diffed exactly; beyond it a
// reformat touched most of a long file and the diff would stall the click,
// so the line is looked up by its text instead.
const RELOCATE_DIFF_CELLS = 4_000_000

// `off` (inside the changed stretch of `basis`) mapped into `fresh` through a
// longest-common-subsequence diff of the two copies' lines.
function relocateByLines(basis, fresh, off) {
  const a = basis.split("\n")
  const b = fresh.split("\n")
  const starts = (lines) => {
    const out = new Array(lines.length)
    let at = 0
    for (let i = 0; i < lines.length; i++) {
      out[i] = at
      at += lines[i].length + 1
    }
    return out
  }
  const aStart = starts(a)
  const bStart = starts(b)
  const row = textLocation(basis, off).line - 1
  const within = off - aStart[row]
  // Lines both copies share at their ends need no diff.
  let top = 0
  while (top < a.length && top < b.length && a[top] === b[top]) top++
  let tail = 0
  while (tail < a.length - top && tail < b.length - top && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  if (row < top) return bStart[row] + within
  if (row >= a.length - tail) return bStart[row + b.length - a.length] + within
  const n = a.length - tail - top
  const m = b.length - tail - top
  // The fresh lines the clicked line may have become: its partner when the
  // diff keeps it, else the lines that replaced the gap it sits in.
  let lo = top
  let hi = top + m
  let partner = -1
  if (n * m <= RELOCATE_DIFF_CELLS) {
    // lcs[i][j]: common lines of a[top+i..] and b[top+j..]; under the cap
    // the shorter side has fewer than 2^16 lines, so 16 bits hold it.
    const w = m + 1
    const lcs = new Uint16Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          a[top + i] === b[top + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[top + i] === b[top + j]) {
        if (top + i === row) {
          partner = top + j
          break
        }
        i++
        j++
        lo = top + j
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        if (top + i === row) {
          // The clicked line is dropped here; the fresh lines up to the next
          // kept line are what replaced its stretch.
          let k = i + 1
          let l = j
          while (k < n && l < m && a[top + k] !== b[top + l]) {
            if (lcs[(k + 1) * w + l] >= lcs[k * w + l + 1]) k++
            else l++
          }
          hi = k < n && l < m ? top + l : top + m
          break
        }
        i++
      } else {
        j++
      }
    }
  } else {
    // Too long to diff: the clicked line's own text, where it still occurs,
    // nearest the click shifted by what changed above it.
    const guess = aStart[row] + fresh.length - basis.length
    let best = Infinity
    for (let r = top; r < top + m; r++) {
      if (b[r] !== a[row] || !a[row].trim()) continue
      const dist = Math.abs(bStart[r] - guess)
      if (dist < best) {
        best = dist
        partner = r
      }
    }
  }
  if (partner >= 0) return bStart[partner] + within
  // The clicked line was edited or removed: the most alike replacing line,
  // by the words they share, the earliest on a tie.
  if (hi <= lo) return bStart[Math.min(lo, b.length - 1)]
  const words = (text) => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])
  const clicked = words(a[row])
  let pick = lo
  let most = 0
  for (let r = lo; r < hi; r++) {
    let common = 0
    for (const word of words(b[r])) if (clicked.has(word)) common++
    if (common > most) {
      most = common
      pick = r
    }
  }
  return bStart[pick] + spotInLine(a[row], b[pick], within)
}

// Column `within` of line `from` in its edited version `to`: text before the
// edit keeps its column, text after it moves by the edit's length. A spot
// inside the edit goes to the clicked word where `to` still has it (the copy
// nearest the spot), else to where the edit starts.
function spotInLine(from, to, within) {
  const shared = Math.min(from.length, to.length)
  let pre = 0
  while (pre < shared && from[pre] === to[pre]) pre++
  let suf = 0
  while (suf < shared - pre && from[from.length - 1 - suf] === to[to.length - 1 - suf]) suf++
  if (within < pre) return within
  if (within >= from.length - suf) return Math.min(within + to.length - from.length, to.length)
  const wordChar = /[\p{L}\p{N}_]/u
  let start = within
  while (start > 0 && wordChar.test(from[start - 1])) start--
  let end = within
  while (end < from.length && wordChar.test(from[end])) end++
  const word = from.slice(start, end)
  let spot = pre
  let best = Infinity
  if (word) {
    for (let at = to.indexOf(word); at >= 0; at = to.indexOf(word, at + 1)) {
      const whole = !(at > 0 && wordChar.test(to[at - 1])) && !wordChar.test(to[at + word.length] || "")
      const dist = Math.abs(at - start)
      if (whole && dist < best) {
        best = dist
        spot = at + within - start
      }
    }
  }
  return spot
}

// Preview → source: resolve the clicked run (or the nearest one) to a source
// location and hand it to the editor's goto, which switches files as needed.
// The goto carries the file's text the location was found in, so the editor
// can find the same spot in a newer copy (see `relocate`).
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
        detail: {
          cmd: "goto",
          file: loc.file,
          line: loc.line,
          col: loc.col,
          source: "preview",
          basis: renderedText(loc.file)
        }
      })
    )
  }
  container.addEventListener("click", onClick)
  return () => container.removeEventListener("click", onClick)
}
