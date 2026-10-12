import { test, expect } from '@playwright/test'
import sync from './preview_sync_module.mjs'

// Lookups after alignment (#149): which run a resting caret finds
// (`runForOffset`), where a click at a run's end lands (`clickSpot`) and
// which characters a click on drawn glyphs falls between (`textBeforeX`).
// Documents are inline and synthetic; the runs are what Typst would render.

const { alignRuns, buildVirtualDoc, clickSpot, locate, offsetOf, runForOffset, textBeforeX } = sync

// The SVG as alignRuns reads it: `.tsel` runs in document order, one page.
function container(recorded) {
  const page = { page: 0 }
  const nodes = recorded.map((t) => ({
    tagName: 'span',
    textContent: t,
    parentElement: { closest: () => null },
    closest: (sel) => (sel === '.typst-page' ? page : null)
  }))
  return { querySelectorAll: () => nodes }
}

// Aligns runs (their texts) with the files, `main.typ` alone when given as a
// string.
function align(files, recorded) {
  if (typeof files === 'string') files = [{ path: 'main.typ', content: files }]
  const main = files.find((f) => f.path === 'main.typ')
  const doc = buildVirtualDoc('main.typ', main.content, files.filter((f) => f !== main), 'main.typ')
  const runs = alignRuns(container(recorded), doc)
  const where = (offset) => {
    const l = locate(doc, offset)
    return `${l.file}:${l.line}:${l.col}`
  }
  const caret = (file, line, col = 1) => runs.indexOf(runForOffset(runs, offsetOf(doc, file, line, col), doc))
  return {
    doc,
    runs,
    caret,
    // The text of the run a caret at file:line:col finds, null for none.
    found(file, line, col = 1) {
      const i = caret(file, line, col)
      return i < 0 ? null : runs[i].text
    },
    kind: (i) => (runs[i].anchored ? runs[i].kind : 'placed'),
    // Where a click on character `idx` of run i's text lands.
    click: (i, idx) => where(clickSpot(runs[i], recorded[i].slice(0, idx)))
  }
}

const lines = (...ls) => ls.join('\n') + '\n'

test.describe('a resting caret', () => {
  test('at either edge of a paragraph finds it; a comment line finds the text after it, the last one the text before', () => {
    const a = align(lines('Alpha text here.', '// note', '', 'Beta text there.', '// tail'), ['Alpha text here.', 'Beta text there.'])
    expect(a.found('main.typ', 1, 1)).toBe('Alpha text here.')
    expect(a.found('main.typ', 1, 17)).toBe('Alpha text here.')
    expect(a.found('main.typ', 2, 4)).toBe('Beta text there.')
    expect(a.found('main.typ', 5, 4)).toBe('Beta text there.')
  })

  test('on a loop body finds the first record it printed, wherever on the body it rests', () => {
    const csv = align(
      [
        { path: 'main.typ', content: lines('#let rows = csv("p.csv")', '= Prices', '#for r in rows [', '  - #r.at(0) costs #r.at(1)', ']', 'Done.') },
        { path: 'p.csv', content: lines('apple,12', 'plum,7', 'pear,30') }
      ],
      ['Prices', '•', 'apple costs 12', '•', 'plum costs 7', '•', 'pear costs 30', 'Done.']
    )
    // Right after the literal word, and on the value after it.
    expect(csv.found('main.typ', 4, 19)).toBe('apple costs 12')
    expect(csv.found('main.typ', 4, 22)).toBe('apple costs 12')
    // A closing bracket in the body goes on to the text after it.
    expect(csv.found('main.typ', 5, 1)).toBe('Done.')

    const json = align(
      [
        { path: 'main.typ', content: lines('#let d = json("c.json")', '#for b in d [', '  Bird: #b.name, seen #b.count times.', ']') },
        { path: 'c.json', content: lines('[', '  {', '    "name": "owl",', '    "count": 3', '  },', '  {', '    "name": "wren",', '    "count": 5', '  }', ']') }
      ],
      ['Bird: owl, seen 3 times.', 'Bird: wren, seen 5 times.']
    )
    const owl = 'Bird: owl, seen 3 times.'
    const wren = 'Bird: wren, seen 5 times.'
    // The line loading the data, the end of the body text, the end of its
    // line and the bracket closing the loop.
    expect(json.found('main.typ', 1, 5)).toBe(owl)
    expect(json.found('main.typ', 3, 37)).toBe(owl)
    expect(json.found('main.typ', 3, 38)).toBe(owl)
    expect(json.found('main.typ', 4, 1)).toBe(owl)
    // In the data file each value finds the record showing it, from its
    // first letter to past its closing quote.
    expect(json.found('c.json', 3, 14)).toBe(owl)
    expect(json.found('c.json', 3, 17)).toBe(owl)
    expect(json.found('c.json', 3, 18)).toBe(owl)
    expect(json.found('c.json', 4, 14)).toBe(owl)
    expect(json.found('c.json', 7, 18)).toBe(wren)
  })

  test('in a template definition finds the text its call printed', () => {
    const note = 'Achtung Careful: Hot surface.'
    const local = align(
      lines('#let note(title: "", body) = block[', '  Achtung #title: #body', ']', 'First paragraph.', '#note(title: "Careful")[Hot surface.]', 'Last paragraph.'),
      ['First paragraph.', note, 'Last paragraph.']
    )
    // Column 1 too: the `#` of the `#let`, where Home puts the caret.
    for (const col of [1, 2, 5, 13]) expect(local.found('main.typ', 1, col)).toBe(note)
    expect(local.found('main.typ', 2, 11)).toBe(note)

    // Defined in a file of its own: up to the end of the definition, and
    // nothing on the line after it.
    const imported = align(
      [
        { path: 'main.typ', content: lines('#import "notes.typ": note', 'First paragraph.', '#note(title: "Careful")[Hot surface.]', 'Last paragraph.') },
        { path: 'notes.typ', content: lines('#let note(title: "", body) = block[', '  Achtung #title: #body', ']') }
      ],
      ['First paragraph.', note, 'Last paragraph.']
    )
    expect(imported.found('notes.typ', 1, 1)).toBe(note)
    expect(imported.found('notes.typ', 1, 2)).toBe(note)
    expect(imported.found('notes.typ', 3, 2)).toBe(note)
    expect(imported.found('notes.typ', 4, 1)).toBeNull()
  })

  test('on the words of a template finds its text: at the first letter, past the code after it', () => {
    const sized = align(
      lines('#let note(size: 10pt, body) = block[', '  #text(size)[Achtung] #body', ']', 'First paragraph.', '#note(size: 12pt)[Hot surface.]', 'Last paragraph.'),
      ['First paragraph.', 'Achtung Hot surface.', 'Last paragraph.']
    )
    expect(sized.found('main.typ', 2, 15)).toBe('Achtung Hot surface.')
    expect(sized.found('main.typ', 2, 24)).toBe('Achtung Hot surface.')

    const spaced = align(
      lines('#let note(size: 10pt, body) = block[', '  Achtung #h(size) #body', ']', 'First paragraph.', '#note(size: 12pt)[', '  Hot surface.', ']', 'Last paragraph.'),
      ['First paragraph.', 'Achtung Hot surface.', 'Last paragraph.']
    )
    expect(spaced.found('main.typ', 2, 14)).toBe('Achtung Hot surface.')
  })

  test('on a parameter a template uses finds what the first call passed, else the template text', () => {
    // `#body` set as a paragraph of its own: the body the call passed.
    const body = align(
      lines('#let note(title: "", body) = block[', '  Achtung #title:', '', '  #body', ']', 'First paragraph.', '#note(title: "Careful")[Hot surface.]', 'Last paragraph.'),
      ['First paragraph.', 'Achtung Careful:', 'Hot surface.', 'Last paragraph.']
    )
    expect(body.found('main.typ', 4, 5)).toBe('Hot surface.')
    expect(body.found('main.typ', 2, 3)).toBe('Achtung Careful:')
    // A length prints nothing: the template's own text, not the paragraph
    // after the call.
    const size = align(
      lines('#let note(size: 10pt) = block[', '  #v(size)', '  Achtung', ']', 'First paragraph.', '#note(size: 12pt)', 'Last paragraph.'),
      ['First paragraph.', 'Achtung', 'Last paragraph.']
    )
    expect(size.found('main.typ', 2, 5)).toBe('Achtung')
  })

  test('on the body parameter of a `#show: template.with(...)` finds the document after the rule', () => {
    const project = (rest) => lines('#let project(title: "", body) = {', '  align(center, text(17pt, title))', '  body', '}', '#show: project.with(title: "Bird Notes")', ...rest)
    const plain = align(project(['The body text starts here.']), ['Bird Notes', 'The body text starts here.'])
    expect(plain.found('main.typ', 3, 3)).toBe('The body text starts here.')
    // A heading the outline copies further on: the heading itself.
    const headed = align(project(['= Intro', 'The body text.', '#outline()']), ['Bird Notes', 'Intro', 'The body text.', 'Contents', 'Intro', ' ⁠1'])
    const i = headed.caret('main.typ', 3, 3)
    expect(headed.runs[i].text).toBe('Intro')
    expect(headed.kind(i)).toBe('ordered')
  })

  test('after a value printed twice finds its own text, not the copy', () => {
    const a = align(lines('#let x = [Shared words]', '#x', '', '#x', 'End.'), ['Shared words', 'Shared words', 'End.'])
    const i = a.caret('main.typ', 1, 24)
    expect(a.runs[i].text).toBe('Shared words')
    expect(a.kind(i)).toBe('ordered')
  })

  test('on a loop line printing only a value finds a value, not the bullet at its start', () => {
    const a = align(
      [
        { path: 'main.typ', content: lines('Birds:', '#for r in csv("p.csv") [', '  - #r.at(0)', ']', 'Done.') },
        { path: 'p.csv', content: lines('kestrel', 'heron') }
      ],
      ['Birds:', '•', 'kestrel', '•', 'heron', 'Done.']
    )
    for (const col of [2, 8, 13]) expect(['kestrel', 'heron']).toContain(a.found('main.typ', 3, col))
  })

  test('on a loop line printing a value after a bullet finds the first record, as with no bullet', () => {
    const loop = (body, rows, runs) =>
      align([{ path: 'main.typ', content: lines('Birds:', '#for r in csv("p.csv") [', body, ']', 'Done.') }, { path: 'p.csv', content: lines(...rows) }], ['Birds:', ...runs, 'Done.'])
    const two = loop('  - #r.at(0)', ['kestrel', 'heron'], ['•', 'kestrel', '•', 'heron'])
    expect([two.found('main.typ', 3, 8), two.found('main.typ', 3, 13), two.found('main.typ', 4, 1)]).toEqual(['kestrel', 'kestrel', 'kestrel'])
    const three = loop('  - #r.at(0)', ['kestrel', 'heron', 'owl'], ['•', 'kestrel', '•', 'heron', '•', 'owl'])
    expect(three.found('main.typ', 3, 8)).toBe('kestrel')
    const bare = loop('  #r.at(0)', ['kestrel', 'heron'], ['kestrel', 'heron'])
    expect(bare.found('main.typ', 3, 5)).toBe('kestrel')
  })

  test('in a comment after a reference finds what the reference printed', () => {
    const a = align(lines('= Intro <intro>', 'Text.', '= Methods <methods>', 'More.', 'See @intro // first'), ['Intro', 'Text.', 'Methods', 'More.', 'See ', 'Section 1'])
    expect(a.found('main.typ', 5, 14)).toBe('Section 1')
  })

  test('in a bibliography file: the key line finds the entry, a blank line the next entry', () => {
    const bib = (keys, cited) =>
      align(
        [
          { path: 'main.typ', content: lines(`Raptors are studied @${keys[0]} and @${keys[1]}.`, '#bibliography("refs.bib")') },
          {
            path: 'refs.bib',
            content: lines(
              `@book{${keys[0]},`, '  title = {Night Owls},', '  author = {Smith, Anna},', '  year = {2020},', '}', '',
              `@book{${keys[1]},`, '  title = {Herons},', '  author = {Jones, Bob},', '  year = {2019},', '}'
            )
          }
        ],
        [cited, 'Bibliography', '[1]', 'A. Smith, Night Owls. 2020.', '[2]', 'B. Jones, Herons. 2019.']
      )
    // Keys that name nothing printed: the number the entry's head shows.
    const coded = bib(['smith20', 'jb19'], 'Raptors are studied [1] and [2].')
    expect(coded.found('refs.bib', 1, 5)).toBe('[1]')
    expect(coded.found('refs.bib', 6, 1)).toBe('[2]')
    // A key naming the author: at the start of its line, the entry's text
    // that begins on that line rather than the number placed there.
    const named = bib(['smith', 'jones'], 'Raptors are studied [1] and [2].')
    expect(named.found('refs.bib', 1, 1)).toBe('A. Smith, Night Owls. 2020.')
  })

  test('in a bibliography file: a block before the first entry finds that entry, its closing brace too', () => {
    const a = align(
      [
        { path: 'main.typ', content: lines('Raptors are studied @smith20.', '#bibliography("refs.bib")') },
        { path: 'refs.bib', content: lines('@comment{', '  field notes', '}', '@book{smith20,', '  title = {Night Owls},', '  author = {Smith, Anna},', '  year = {2020},', '}') }
      ],
      ['Raptors are studied [1].', 'Bibliography', '[1]', 'A. Smith, Night Owls. 2020.']
    )
    expect(a.found('refs.bib', 1, 3)).toBe('[1]')
    expect(a.found('refs.bib', 3, 1)).toBe('[1]')
  })

  test('in a data file: a blank line finds the row after it, a first line no generated text', () => {
    const raw = align(
      [
        { path: 'main.typ', content: lines('#table(columns: 2, ..csv("p.csv").flatten())', 'After.') },
        { path: 'p.csv', content: lines('bird,count', 'kestrel,4', '', 'heron,7') }
      ],
      ['bird', 'count', 'kestrel', '4', 'heron', '7', 'After.']
    )
    expect(raw.found('p.csv', 3, 1)).toBe('heron')

    const trailing = align(
      [
        { path: 'main.typ', content: lines('Opening words here.', '#let d = json("c.json")', '#lorem(3)') },
        { path: 'c.json', content: lines('[', '  1', ']') }
      ],
      ['Opening words here.', 'Lorem ipsum dolor.']
    )
    expect(trailing.found('c.json', 1, 1)).toBeNull()
  })

  test('without a document: a mark at the caret, else the next run, else the one before', () => {
    const a = align(lines('Intro line.', '- first item', '- second item', 'Outro line.'), ['Intro line.', '•', 'first item', '•', 'second item', 'Outro line.'])
    expect(runForOffset(a.runs, offsetOf(a.doc, 'main.typ', 2, 1)).text).toBe('•')
    const b = align(lines('Alpha text here.', '// note', 'Beta text there.', '// tail'), ['Alpha text here.', 'Beta text there.'])
    expect(runForOffset(b.runs, offsetOf(b.doc, 'main.typ', 2, 4)).text).toBe('Beta text there.')
    expect(runForOffset(b.runs, offsetOf(b.doc, 'main.typ', 4, 4)).text).toBe('Beta text there.')
  })
})

test.describe('a click at the end of a run', () => {
  test('lands after its last character, a trailing space included', () => {
    const a = align(lines('Alpha text here.', '', 'Beta text there.'), ['Alpha text here. ', 'Beta text there.'])
    expect(a.click(0, 17)).toBe('main.typ:1:17')
    expect(a.click(0, 16)).toBe('main.typ:1:17')
    expect(a.click(1, 16)).toBe('main.typ:3:17')
    expect(a.click(1, 15)).toBe('main.typ:3:16')
  })
})

// Glyphs at pen positions `xs` (blank: a space), as textBeforeX reads them.
const glyphs = (xs, blank = []) => xs.map((x, k) => ({ x, n: 1, blank: blank.includes(k), char: null }))

test.describe('a click on drawn glyphs', () => {
  test('glyphs out of order from the first pair on are left to the text layer', () => {
    expect(textBeforeX('abc', glyphs([200, 0, 300]), 400, 250)).toBeNull()
  })

  test('fewer glyphs than characters and no blank glyph where the text has a space are left to the text layer', () => {
    expect(textBeforeX('ab cd', glyphs([0, 100, 200, 300]), 400, 150)).toBeNull()
  })

  test('in the last two glyphs: each half of a glyph puts the caret before or after it', () => {
    const drawn = glyphs([0, 100, 200])
    expect(textBeforeX('abc', drawn, 300, 180)).toBe('ab')
    expect(textBeforeX('abc', drawn, 300, 220)).toBe('ab')
    expect(textBeforeX('abc', drawn, 300, 280)).toBe('abc')
  })

  test('an accent drawn with no advance stays with its letter', () => {
    // `é` as `e` and a combining acute at the next glyph's pen position.
    expect(textBeforeX('ét', glyphs([0, 100, 100]), 200, 100)).toBe('é')
  })

  test('a last glyph with no advance: a click on its pen puts the caret before it', () => {
    expect(textBeforeX('abc', glyphs([0, 50, 100]), 100, 100)).toBe('ab')
  })

  test('a ligature mark in a run with one glyph per character is ignored', () => {
    const marked = glyphs([0, 100, 200])
    marked[0].n = 2
    expect(textBeforeX('abc', marked, 300, 150)).toBe('ab')
  })

  test('glyph positions in any unit read the same', () => {
    for (const scale of [1, 0.001]) {
      const at = (x) => x * scale
      expect(textBeforeX('abc', glyphs([0, 100, 200].map(at)), at(300), at(130))).toBe('a')
      expect(textBeforeX('abc', glyphs([0, 100, 200].map(at)), at(300), at(170))).toBe('ab')
    }
  })
})

// A proportional font for the glyphs (advances in 1000ths of an em) and
// another for the text layer, as a browser would set it. The glyph font
// draws `ff`, `fi`, `fl`, `ffi`, `ffl` and `fj` as one glyph each, a little
// narrower than their letters.
const GLYPH_FONT = { a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278, j: 278, k: 500, l: 278, m: 778, n: 500, o: 500, p: 500, q: 500, r: 333, s: 389, t: 278, u: 500, v: 500, w: 722, x: 500, y: 500, z: 444, O: 722, ' ': 250 }
const LAYER_FONT = { a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, O: 778, ' ': 278 }
const LIGATURES = ['ffi', 'ffl', 'ff', 'fi', 'fl', 'fj']

// `text` set in the glyph font at `scale`: its glyphs (none marked as a
// ligature, nothing known of what they draw), where it ends, the characters
// each glyph draws, and the text layer's widths when `layer` maps a
// character's layer-font width to a width in some unit.
function typeset(text, { scale = 1, layer = null } = {}) {
  const drawn = []
  const parts = []
  let x = 0
  for (let i = 0; i < text.length; ) {
    const part = LIGATURES.find((l) => text.startsWith(l, i)) || text[i]
    drawn.push({ x: x * scale, n: 1, blank: part === ' ', char: null })
    parts.push(part)
    x += part.length > 1 ? Math.round(0.92 * [...part].reduce((w, c) => w + GLYPH_FONT[c], 0)) : GLYPH_FONT[part]
    i += part.length
  }
  return { glyphs: drawn, endX: x * scale, parts, layer: layer && [...text].map((c) => layer(LAYER_FONT[c])) }
}

// The characters a click covers in each glyph: from its pen position to just
// before the next glyph's.
function reading(text, set) {
  const xs = set.glyphs.map((g) => g.x)
  return xs.map((x, k) => {
    const right = k + 1 < xs.length ? xs[k + 1] : set.endX
    const from = textBeforeX(text, set.glyphs, set.endX, x, set.layer)
    const to = textBeforeX(text, set.glyphs, set.endX, right - (right - x) * 1e-3, set.layer)
    return to.slice(from.length)
  })
}

test.describe('ligatures the renderer leaves unmarked', () => {
  test('by the advances alone a ligature takes its letters, at the end of a word or after other words, in any unit', () => {
    // `ff` alone (`pages ff`, `ff pages`) is a word of one glyph.
    for (const text of ['staff', 'affix', 'so stiff', 'Our staff of fifty', 'pages ff', 'ff pages']) {
      for (const scale of [1, 0.001]) {
        const set = typeset(text, { scale })
        expect(reading(text, set)).toEqual(set.parts)
      }
    }
  })

  test('letters the run draws alone elsewhere keep their widths inside a word with a ligature', () => {
    // A monospace text layer says nothing of the proportions; `Oslo` gives
    // the wide `O` its width, so `Office` reads `O`, `ffi`, `c`, `e`.
    for (const scale of [1, 0.001]) {
      for (const em of [0.6, 0.06]) {
        const set = typeset('in Oslo Office', { scale, layer: () => em })
        expect(reading('in Oslo Office', set)).toEqual(set.parts)
      }
    }
  })

  test('the text layer widths count in any unit', () => {
    for (const layer of [(w) => w / 1000, (w) => w * 0.016, (w) => w / 1e5]) {
      const set = typeset('fine fish', { layer })
      expect(reading('fine fish', set)).toEqual(['fi', 'n', 'e', ' ', 'fi', 's', 'h'])
    }
  })
})

// A page as the SVG draws it, enough for glyphTextBefore: each run a
// `.typst-text` group of `<use>` glyphs (`ids`, at pen positions `xs` in the
// group's units) and its text layer box (`box`: x, y, width), all placed on
// screen by `matrix` (an SVG transform: a b c d e f). `liga` marks a glyph's
// definition with `data-liga-len`; `layer` gives each character's width in
// the text layer (the browser's font). `at(i, x)` is a pointer at x along
// run i's baseline.
function drawnPage(runs, matrix = [1, 0, 0, 1, 0, 0]) {
  const [a, b, c, d, e, f] = matrix
  const det = a * d - b * c
  const ctm = { a, b, c, d, e, f, inverse: () => ({ a: d / det, b: -b / det, c: -c / det, d: a / det, e: (c * f - d * e) / det, f: (b * e - a * f) / det }) }
  const defs = new Map()
  const page = { querySelectorAll: () => groups.map((g) => g.sel) }
  const groups = runs.map(({ text, ids, xs, box, liga = {}, layer = [], noX = [] }) => {
    ids.forEach((id) => defs.set(id, { getAttribute: (k) => (k === 'd' ? (id === ' ' ? null : 'M0 0') : k === 'data-liga-len' ? (liga[id] ?? null) : null), children: [] }))
    const textNode = { textContent: text }
    const doc = {
      getElementById: (id) => defs.get(id) || null,
      createRange() {
        let at = 0
        return { setStart: (_, i) => (at = i), setEnd() {}, getBoundingClientRect: () => ({ width: layer[at] ?? 0 }) }
      },
      createTreeWalker() {
        let done = false
        return { nextNode: () => (done ? null : ((done = true), textNode)) }
      }
    }
    const fo = { getScreenCTM: () => ctm, getAttribute: (k) => (k in box ? String(box[k]) : null) }
    const uses = ids.map((id, k) => ({ tagName: 'use', getAttribute: (n) => (n === 'href' ? `#${id}` : n === 'x' && !noX.includes(k) ? String(xs[k]) : null) }))
    const group = { children: uses, ownerDocument: doc, getScreenCTM: () => ctm, closest: (s) => (s === '.typst-page' ? page : null) }
    group.sel = { textContent: text, ownerDocument: doc, closest: (s) => (s === 'foreignObject' ? fo : s === '.typst-text' ? group : null) }
    group.querySelector = () => group.sel
    return group
  })
  return {
    run: (i) => ({ el: groups[i] }),
    at: (i, x) => ({ clientX: a * x + e, clientY: b * x + f })
  }
}

const officeGlyphs = { text: 'Office', ids: ['O', 'ffi', 'c', 'e'], xs: [0, 730, 1677, 2133], box: { x: 0, y: -12, width: 2622 } }

test.describe('a click on a run drawn on screen', () => {
  test('reads its glyphs in the group units, however the run is scaled, rotated and moved', () => {
    for (const matrix of [[1, 0, 0, 1, 0, 0], [0.02, 0, 0, 0.02, 140, 30], [0, 0.02, -0.02, 0, 300, 40]]) {
      const page = drawnPage([{ ...officeGlyphs, liga: { ffi: '2' } }], matrix)
      expect([300, 1100, 1400, 1700, 2600].map((x) => sync.glyphTextBefore(page.run(0), page.at(0, x)))).toEqual(['', 'Of', 'Off', 'Offi', 'Office'])
    }
    // Units of any size; the text layer box set off from the glyphs'
    // origin or at it (no `x`); a first glyph drawn without an `x` at 0.
    for (const box of [{ x: 0.5, y: -0.2, width: 2.5 }, { y: -0.2, width: 3 }]) {
      const small = drawnPage([{ text: 'abc', ids: ['a', 'b', 'c'], xs: [0, 1, 2], box, noX: [0] }], [0, 50, -50, 0, 10, 20])
      expect([0.3, 1.8, 2.45, 2.7].map((x) => sync.glyphTextBefore(small.run(0), small.at(0, x)))).toEqual(['', 'ab', 'ab', 'abc'])
    }
  })

  test('an unmarked ligature takes its letters by what the page draws alone, else by the text layer proportions', () => {
    globalThis.NodeFilter ??= { SHOW_TEXT: 4 }
    const lexicon = drawnPage([{ text: 'Once', ids: ['O', 'n', 'c', 'e'], xs: [0, 722, 1222, 1666], box: { x: 0, y: -12, width: 2110 } }, officeGlyphs])
    expect([1100, 1400, 1700].map((x) => sync.glyphTextBefore(lexicon.run(1), lexicon.at(1, x)))).toEqual(['Of', 'Off', 'Offi'])
    const layer = drawnPage([{ ...officeGlyphs, layer: [11.5, 5.3, 5.3, 4.5, 7, 7] }])
    expect([1100, 1400, 1700].map((x) => sync.glyphTextBefore(layer.run(0), layer.at(0, x)))).toEqual(['Of', 'Off', 'Offi'])
  })

  test('a run with no glyphs, no text layer box or no screen transform is left to the text layer', () => {
    const page = drawnPage([{ text: '', ids: [], xs: [], box: { x: 0, y: 0, width: 0 } }, { text: 'ab', ids: ['a', 'b'], xs: [0, 100], box: { x: 0, y: 0, width: 200 } }])
    expect(sync.glyphTextBefore(page.run(0), page.at(0, 0))).toBeNull()
    expect(sync.glyphTextBefore({ el: null }, page.at(1, 50))).toBeNull()
    const el = page.run(1).el
    expect(sync.glyphTextBefore({ el }, page.at(1, 50))).toBe('a')
    expect(sync.glyphTextBefore({ el: { ...el, getScreenCTM: undefined } }, page.at(1, 50))).toBeNull()
    expect(sync.glyphTextBefore({ el: { ...el, getScreenCTM: () => null } }, page.at(1, 50))).toBeNull()
    expect(sync.glyphTextBefore({ el: { ...el, querySelector: () => null } }, page.at(1, 50))).toBeNull()
    const boxless = { ...el.sel, closest: () => ({ getScreenCTM: () => null, getAttribute: () => null }) }
    expect(sync.glyphTextBefore({ el: { ...el, querySelector: () => boxless } }, page.at(1, 50))).toBeNull()
  })
})
