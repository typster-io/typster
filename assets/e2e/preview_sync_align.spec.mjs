import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadFixture } from './preview_sync_fixtures.mjs'

// Preview ↔ source alignment (#149) without a browser. Each fixture in
// fixtures/preview_sync names a document's sources (real files under a folder
// of the fixture's name) and holds the runs the Typst worker rendered for it (their text and page, pictures as image runs),
// recorded once through the real worker. The tests align those runs with the
// real module and check where each run lands, where a click inside it goes
// and which run a resting caret finds.

const here = dirname(fileURLToPath(import.meta.url))

// assets/js is not an ES module package (the bundler reads it; Node would
// take it for CommonJS) and the module imports nothing, so its source is
// loaded as an ES module from a temporary .mjs copy.
const copy = join(mkdtempSync(join(tmpdir(), 'preview-sync-')), 'preview_sync.mjs')
writeFileSync(copy, readFileSync(join(here, '../js/preview_sync.js'), 'utf8'))
const { alignRuns, buildVirtualDoc, clickSpot, locate, offsetOf, runForOffset, textBeforeX } = await import(pathToFileURL(copy).href)

// The SVG as alignRuns reads it: `.tsel` runs and `<image>` pictures in
// document order, each inside its page.
function container(recorded) {
  const pages = new Map()
  const page = (p) => {
    if (!pages.has(p)) pages.set(p, { page: p })
    return pages.get(p)
  }
  const nodes = recorded.map((r) => ({
    tagName: r.image ? 'image' : 'span',
    textContent: r.image ? '' : r.t,
    parentElement: { closest: () => null },
    closest: (sel) => (sel === '.typst-page' ? page(r.page) : null)
  }))
  return { querySelectorAll: () => nodes }
}

function align(files, entry = 'main.typ', recorded = []) {
  const main = files.find((f) => f.path === entry)
  const doc = buildVirtualDoc(entry, main.content, files.filter((f) => f !== main), entry)
  const runs = alignRuns(container(recorded), doc)
  const where = (offset) => {
    const l = locate(doc, offset)
    return `${l.file}:${l.line}:${l.col}`
  }
  // Runs are looked up by their text as matching saw it (no-break spaces
  // as spaces, quotes straight).
  const text = (i) => runs[i].text
  return {
    doc,
    runs,
    where,
    // The index of the k-th run whose text (trimmed) is `t` or matches it.
    nth(t, k = 0) {
      const hits = runs.map((_, i) => i).filter((i) => !recorded[i].image && (t instanceof RegExp ? t.test(text(i)) : text(i) === t))
      if (k >= hits.length) throw new Error(`no run #${k} for ${t}`)
      return hits[k]
    },
    pictures: () => runs.map((_, i) => i).filter((i) => recorded[i].image),
    at: (i) => where(runs[i].start),
    kind: (i) => (runs[i].anchored ? runs[i].kind : 'placed'),
    // Where a click on character `idx` of run i's text lands.
    click: (i, idx) => where(clickSpot(runs[i], recorded[i].t.slice(0, idx))),
    // Where a click at `x` along run i's drawn glyphs lands (see glyphs()).
    clickGlyph: (i, drawn, x) => where(clickSpot(runs[i], textBeforeX(recorded[i].t, drawn.glyphs, drawn.endX, x, drawn.layer))),
    // The run a caret resting at file:line:col finds.
    caret(file, line, col = 1) {
      return runs.indexOf(runForOffset(runs, offsetOf(doc, file, line, col), doc))
    }
  }
}

function fixture(shape) {
  const fx = loadFixture(shape)
  return align(fx.files, fx.entry, fx.runs)
}

test.describe('virtual document (#18)', () => {
  test('splices includes in reading order: nested, relative, absolute', () => {
    const doc = buildVirtualDoc('main.typ', 'm1\n#include "chapters/a.typ"\nm3\n', [
      { path: 'chapters/a.typ', content: 'a1\n#include "../top.typ"\na3\n' },
      { path: 'top.typ', content: 't1\n#include "/chapters/b.typ"\n' },
      { path: 'chapters/b.typ', content: 'b1\n' }
    ])
    const order = doc.lines.slice(0, doc.primaryLines).map((l) => `${l.file}:${l.line}`)
    expect(order).toEqual([
      'main.typ:1', 'main.typ:2',
      'chapters/a.typ:1', 'chapters/a.typ:2',
      'top.typ:1', 'top.typ:2', 'chapters/b.typ:1', 'chapters/b.typ:2', 'top.typ:3',
      'chapters/a.typ:3', 'chapters/a.typ:4',
      'main.typ:3', 'main.typ:4'
    ])
    expect(doc.primaryLines).toBe(doc.lines.length)
  })

  test('finds includes in every form and skips commented and bound ones (#2 #9)', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'old', 'later'].map((n) => ({ path: `${n}.typ`, content: `${n.toUpperCase()}\n` }))
    const main = [
      '#include "a.typ" #include "b.typ"',
      '#{ include "c.typ"; include "d.typ" }',
      '#let ch = "e.typ"',
      '#include ch',
      '/* #include "old.typ" /* nested */ still a comment */',
      '#include("f.typ")',
      '#let later = include "later.typ"',
      'end'
    ].join('\n')
    const doc = buildVirtualDoc('main.typ', main, files)
    const spliced = new Set(doc.lines.slice(0, doc.primaryLines).map((l) => l.file))
    for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) expect(spliced.has(`${f}.typ`)).toBe(true)
    // Commented out, or rendered where `later` is used: appendix only.
    expect(spliced.has('old.typ')).toBe(false)
    expect(spliced.has('later.typ')).toBe(false)
    expect(doc.lines.slice(doc.primaryLines).map((l) => l.file)).toEqual(expect.arrayContaining(['old.typ', 'later.typ']))
  })

  test('stops at cycles and past the include depth limit', () => {
    const cycle = buildVirtualDoc('main.typ', '#include "a.typ"\n', [
      { path: 'a.typ', content: 'a\n#include "b.typ"\n' },
      { path: 'b.typ', content: 'b\n#include "a.typ"\n#include "/main.typ"\n' }
    ])
    expect(cycle.lines.map((l) => `${l.file}:${l.line}`)).toEqual([
      'main.typ:1', 'a.typ:1', 'a.typ:2', 'b.typ:1', 'b.typ:2', 'b.typ:3', 'b.typ:4', 'a.typ:3', 'main.typ:2'
    ])

    const chain = Array.from({ length: 12 }, (_, k) => ({ path: `f${k}.typ`, content: `f${k}\n#include "f${k + 1}.typ"\n` }))
    const deep = buildVirtualDoc('main.typ', '#include "f0.typ"\n', chain)
    const spliced = new Set(deep.lines.slice(0, deep.primaryLines).map((l) => l.file))
    expect(spliced.has('f7.typ')).toBe(true)
    expect(spliced.has('f8.typ')).toBe(false)
    expect(deep.lines.slice(deep.primaryLines).some((l) => l.file === 'f8.typ')).toBe(true)
  })

  test('falls back to the buffer for a missing entry; offsets round-trip', () => {
    const doc = buildVirtualDoc('main.typ', 'one\ntwo\n', [{ path: 'top.typ', content: 'abc\n' }], 'missing.typ')
    expect(doc.lines[0].file).toBe('main.typ')
    expect(offsetOf(doc, 'nope.typ', 1, 1)).toBeNull()
    const off = offsetOf(doc, '/top.typ', 1, 99)
    expect(locate(doc, off)).toEqual({ file: 'top.typ', line: 1, col: 4 })
    expect(locate(doc, offsetOf(doc, 'main.typ', 2, 2))).toEqual({ file: 'main.typ', line: 2, col: 2 })
  })

  test('an empty document maps offset 0 to its first line and aligns without text', () => {
    const doc = buildVirtualDoc('main.typ', '', [])
    expect(locate(doc, 0)).toEqual({ file: 'main.typ', line: 1, col: 1 })
    expect(offsetOf(doc, 'main.typ', 1, 1)).toBe(0)
    expect(offsetOf(doc, 'main.typ', 2, 1)).toBeNull()
    expect(alignRuns(container([]), doc)).toEqual([])
    expect(runForOffset([], 0, doc)).toBeNull()
    // Runs of an older render with nothing left to match stay at the start.
    const runs = alignRuns(container([{ t: 'Stale paragraph from the last compile.', page: 0 }, { t: '1', page: 0 }]), doc)
    expect(runs.map((r) => locate(doc, r.start))).toEqual([{ file: 'main.typ', line: 1, col: 1 }, { file: 'main.typ', line: 1, col: 1 }])
    expect(runForOffset(runs, 0, doc)).toBe(runs[0])
  })

  test('drops format characters from the search text and maps offsets back', () => {
    const text = 'soft hy­phen and a word⁠joiner here\n'
    const doc = buildVirtualDoc('main.typ', text, [])
    expect(doc.search.startsWith('soft hyphen and a wordjoiner here')).toBe(true)
    const s = doc.search.indexOf('phen')
    expect(locate(doc, doc.toText(s))).toEqual({ file: 'main.typ', line: 1, col: 9 })
    expect(doc.toSearch(doc.toText(s))).toBe(s)
  })
})

test.describe('alignment of recorded documents (#19 #35)', () => {
  test('includes: each file at its line, a commented draft never (#2 #9 #18)', () => {
    const a = fixture('includes')
    expect(a.at(a.nth('Part one'))).toBe('parts/part1.typ:1:4')
    expect(a.at(a.nth('Chapter one'))).toBe('parts/chapters/ch1.typ:1:5')
    expect(a.at(a.nth('A shared note about methodology and sampling.'))).toBe('shared/note.typ:1:1')
    expect(a.at(a.nth('Part two'))).toBe('parts/part2.typ:1:4')
    expect(a.at(a.nth('Badgers dug new setts nearby.'))).toBe('parts/part2.typ:3:1')
    expect(a.at(a.nth('Appendix'))).toBe('back/appendix.typ:1:4')
    expect(a.at(a.nth('Set in a serif face by the editors.'))).toBe('shared/colophon.typ:1:1')
    expect(a.at(a.nth('Closing words of the book.'))).toBe('main.typ:17:1')
    expect(a.caret('main.typ', 5, 3)).toBe(a.nth('Part one'))
  })

  test('typography: quotes of every locale, dashes, escapes, emoji, soft hyphens (#5 #19)', () => {
    const a = fixture('typography')
    expect(a.at(a.nth(/^He said/))).toBe('main.typ:3:1')
    expect(a.at(a.nth(/^Dr\. Smith/))).toBe('main.typ:5:1')
    expect(a.at(a.nth(/^Cost \(USD\)/))).toBe('main.typ:7:1')
    expect(a.at(a.nth(/^A family/))).toBe('main.typ:9:1')
    for (const [re, line] of [[/^Er sagte/, 11], [/^Il a dit/, 13], [/^Он сказал/, 15]]) {
      expect(a.kind(a.nth(re))).toBe('ordered')
      expect(a.at(a.nth(re))).toBe(`main.typ:${line}:19`)
    }
    // A click on "Jones" lands on it; on "dash" after an en dash too.
    expect(a.click(a.nth(/^Dr\. Smith/), 'Dr. Smith met Mr. '.length)).toBe('main.typ:5:19')
    expect(a.click(a.nth(/^He said/), 'He said “hello” — and ‘bye’ – '.length)).toBe('main.typ:3:34')
  })

  test('hyphenation: each part of a broken word lands inside it', () => {
    const a = fixture('hyphenation')
    expect(a.at(a.nth('Die Donaudampfschiff'))).toBe('main.typ:5:1')
    expect(a.at(a.nth('fahrtsgesellschaftskapi'))).toBe('main.typ:5:21')
    expect(a.at(a.nth(/^tänsmütze/))).toBe('main.typ:5:44')
  })

  test('captions: the label is dropped, the caption: argument never matched (#6)', () => {
    const a = fixture('captions')
    const en = a.nth(/^Figure 1:/)
    const fr = a.nth(/^Fig\. 2\./)
    const sep = a.nth(/^Figure 3/)
    expect(a.at(en)).toBe('main.typ:3:50')
    expect(a.at(fr)).toBe('main.typ:5:68')
    expect(a.at(sep)).toBe('main.typ:8:50')
    // A click on the caption's first letter lands on it, one inside the label
    // goes to the caption's start.
    expect(a.click(en, 'Figure 1: '.length)).toBe('main.typ:3:50')
    expect(a.click(en, 2)).toBe('main.typ:3:50')
    expect(a.click(fr, 'Fig. 2. – A French '.length)).toBe('main.typ:5:77')
  })

  test('outline: entries copy their headings, the body keeps its own (#0 #27 #51)', () => {
    const a = fixture('outline')
    const long = /^A rather long heading/
    expect(a.kind(a.nth(long, 0))).toBe('copy')
    expect(a.kind(a.nth(long, 1))).toBe('ordered')
    expect(a.at(a.nth(long, 0))).toBe('main.typ:4:3')
    // The two entries named Notes copy the two headings in order.
    expect(a.at(a.nth('Notes', 0))).toBe('main.typ:8:4')
    expect(a.at(a.nth('Notes', 1))).toBe('main.typ:16:4')
    expect(a.at(a.nth(/^Herons stand still/))).toBe('main.typ:6:1')
    expect(a.at(a.nth(/^Kestrels hover/))).toBe('main.typ:14:1')
    // A caret on a heading or a paragraph finds the body, not the outline.
    expect(a.caret('main.typ', 4, 5)).toBe(a.nth(long, 1))
    expect(a.caret('main.typ', 8, 5)).toBe(a.nth('Notes', 2))
    expect(a.caret('main.typ', 6, 3)).toBe(a.nth(/^Herons stand still/))
    expect(a.caret('main.typ', 16, 5)).toBe(a.nth('Notes', 3))
    expect(a.caret('main.typ', 2, 3)).toBe(a.nth('Contents'))
  })

  test('running header: each page copy goes to the header, the title to its heading', () => {
    const a = fixture('header')
    expect(a.at(a.nth('Field notes', 0))).toBe('main.typ:1:33')
    expect(a.at(a.nth('Field notes', 1))).toBe('main.typ:2:3')
    expect(a.kind(a.nth('Field notes', 2))).toBe('copy')
    expect(a.at(a.nth('Field notes', 2))).toBe('main.typ:1:33')
    expect(a.at(a.nth(/^Paragraph number 8 /))).toBe('main.typ:18:1')
  })

  test('footnotes: the text far behind on its page, markers on their call (#1 #29 #31)', () => {
    const a = fixture('footnotes')
    expect(a.at(a.nth('The footnote body explains the opening claim.'))).toBe('main.typ:3:37')
    expect(a.at(a.nth('Short second note.'))).toBe('main.typ:7:46')
    // Superscripts: at their `#footnote`; footnote-area numbers: on the line
    // of their call, not at the end of the page's last paragraph.
    expect(a.at(a.nth('1', 0))).toBe('main.typ:3:27')
    expect(a.at(a.nth('2', 0))).toBe('main.typ:7:36')
    expect(a.at(a.nth('1', 1))).toBe('main.typ:3:1')
    expect(a.at(a.nth('2', 1))).toBe('main.typ:7:1')
    expect(a.at(a.nth('Final paragraph.'))).toBe('main.typ:9:1')
  })

  test('bibliography: citation markers and periods stay in the body (#29 #30)', () => {
    const a = fixture('bibliography')
    expect(a.at(a.nth('[1]', 0))).toBe('main.typ:3:27')
    expect(a.at(a.nth('[2]', 0))).toBe('main.typ:3:54')
    expect(a.at(a.nth('.', 0))).toBe('main.typ:3:62')
    expect(a.at(a.nth('[1]', 1))).toBe('main.typ:5:32')
    expect(a.at(a.nth('.', 1))).toBe('main.typ:5:42')
    const entry = a.nth(/^J\. Smith and J\. Doe/)
    expect(a.at(entry)).toBe('refs.bib:2:12')
    expect(a.click(entry, 'J. Smith and J. Doe, “'.length)).toBe('refs.bib:2:12')
    expect(a.caret('refs.bib', 2, 15)).toBe(entry)
    expect(a.caret('main.typ', 7, 3)).toBe(a.nth('Bibliography'))
  })

  test('floats: a top caption with a long text does not move the page before it (#28)', () => {
    const a = fixture('floats')
    expect(a.at(a.nth(/^Figure 1: A rather long caption/))).toBe('main.typ:10:50')
    expect(a.at(a.nth('Float page'))).toBe('main.typ:2:3')
    expect(a.at(a.nth(/^Bra finbrany/))).toBe('main.typ:4:1')
    expect(a.caret('main.typ', 2, 3)).toBe(a.nth('Float page'))
    expect(a.caret('main.typ', 4, 3)).toBe(a.nth(/^Bra finbrany/))
  })

  test('raw: one-character tokens land on their character (#32)', () => {
    const a = fixture('raw')
    expect(a.at(a.nth('(', 0))).toBe('main.typ:6:14')
    expect(a.at(a.nth('n', 0))).toBe('main.typ:6:15')
    expect(a.at(a.nth('(', 2))).toBe('main.typ:9:40')
    expect(a.at(a.nth('2', 1))).toBe('main.typ:9:45')
    expect(a.at(a.nth('let x = 42'))).toBe('main.typ:12:9')
  })

  test('math: glyphs on their characters, not on a comment or a spacing call (#8 #33)', () => {
    const a = fixture('math')
    // Math italic letters read as the letters the source spells.
    expect(a.at(a.nth('x'))).toBe('main.typ:3:14')
    expect(a.at(a.nth('area'))).toBe('main.typ:7:4')
    expect(a.at(a.nth('∑'))).toBe('main.typ:10:1')
    // Every glyph of the sum is on its line, its closing parenthesis too.
    expect(a.at(a.nth(')', 0))).toBe('main.typ:10:26')
    expect(a.at(a.caret('main.typ', 10, 3))).toMatch(/^main\.typ:10:/)
  })

  test('scripts: right-to-left words in visual order and CJK fragments (#34)', () => {
    const a = fixture('scripts')
    const arabic = { 'مرحبا': 1, 'بالعالم': 7, 'هذا': 15, 'نص': 19, 'عربي': 22, 'طويل': 27, 'للاختبار': 32 }
    for (const [w, col] of Object.entries(arabic)) expect(a.at(a.nth(w))).toBe(`main.typ:4:${col}`)
    expect(a.at(a.nth(/^שלום/))).toBe('main.typ:6:1')
    expect(a.at(a.nth(/^这是一个中文段落/))).toBe('main.typ:8:1')
    const japanese = { '日本語': 1, 'の': 4, '文章': 5, 'もここに': 7, '書': 11, 'きます。': 12 }
    for (const [w, col] of Object.entries(japanese)) expect(a.at(a.nth(w))).toBe(`main.typ:10:${col}`)
  })

  test('pictures: each takes its own line, in order (#4 #36 #37)', () => {
    const a = fixture('pictures')
    const lines = a.pictures().map((i) => a.at(i).split(':')[1])
    expect(lines).toEqual(['8', '9', '10', '15', '17', '22', '25', '26', '29'])
    expect(a.caret('main.typ', 9, 3)).toBe(a.pictures()[1])
    expect(a.caret('main.typ', 17, 3)).toBe(a.pictures()[4])
    expect(a.caret('main.typ', 22, 3)).toBe(a.pictures()[5])
  })

  test('tables: short cells and a row-spanning cell land on their brackets (#3 #34)', () => {
    const a = fixture('tables')
    const cells = { Id: '5:4', Yes: '5:10', No: '5:17', A1: '6:4', 12: '6:10', 3: '6:16', Owl: '9:21', Forest: '9:50', 7: '9:60', Kestrel: '9:65', 30: '9:76' }
    for (const [t, at] of Object.entries(cells)) expect(a.at(a.nth(t))).toBe(`main.typ:${at}`)
  })

  test('csv printed raw: brackets and cells go to the data file (#12 #14)', () => {
    const a = fixture('csv-raw')
    expect(a.at(a.nth(/^Lorem ipsum/))).toBe('main.typ:3:1')
    expect(a.at(a.nth('(', 0))).toBe('birds.csv:1:1')
    expect(a.at(a.nth('(', 1))).toBe('birds.csv:1:1')
    const bird = a.nth('"bird"', 0)
    expect(a.at(bird)).toBe('birds.csv:1:1')
    expect(a.click(bird, 3)).toBe('birds.csv:1:3')
    expect(a.at(a.nth('(', 2))).toBe('birds.csv:2:1')
    expect(a.at(a.nth('"a long-legged wading bird of marshes"', 0))).toBe('birds.csv:2:7')
    // After a one-letter heading the next print still opens the data file.
    expect(a.at(a.nth('D'))).toBe('main.typ:7:4')
    expect(a.at(a.nth('(', 3))).toBe('birds.csv:1:1')
    expect(a.at(a.nth('"bird"', 1))).toBe('birds.csv:1:1')
    expect(a.caret('main.typ', 5, 3)).toBe(bird)
  })

  test('csv with repeated values: each cell walks down its own row (#49)', () => {
    const a = fixture('csv-repeated')
    for (let k = 1; k <= 40; k++) {
      const cell = a.nth(`person${k}`) + 1
      expect(a.at(cell)).toBe(`s.csv:${k + 1}:${`person${k},`.length + 1}`)
    }
  })

  test('csv printed twice: the second copy walks the rows again (#52)', () => {
    const a = fixture('csv-twice')
    const rows = { alpha: 2, bravo: 3, charlie: 4, delta: 5, echo: 6 }
    for (const [name, line] of Object.entries(rows)) {
      const second = a.nth(name, 1)
      expect(a.at(second)).toBe(`s.csv:${line}:1`)
      expect(a.at(second + 1)).toBe(`s.csv:${line}:${name.length + 2}`)
    }
  })

  test('csv files: values go to the file the call reads; a caret on a call finds its table (#53 #54)', () => {
    const a = fixture('csv-files')
    expect(a.at(a.nth('Bergen', 0))).toBe('new.csv:3:1')
    expect(a.at(a.nth('city', 0))).toBe('new.csv:1:1')
    expect(a.at(a.nth('Bergen', 1))).toBe('b.csv:2:1')
    expect(a.at(a.nth('Akerselva'))).toBe('b.csv:4:6')
    expect(a.runs.some((r) => r.start != null && a.where(r.start).startsWith('aold.csv'))).toBe(false)
    expect(a.caret('main.typ', 3, 3)).toBe(a.nth('city', 0))
    expect(a.caret('main.typ', 7, 3)).toBe(a.nth('city', 1))
  })

  test('csv with a long skipped cell: the values after it are still found (#7)', () => {
    const a = fixture('csv-long-cell')
    expect(a.at(a.nth('7'))).toBe('d.csv:2:605')
    expect(a.at(a.nth('fox'))).toBe('d.csv:3:1')
    expect(a.at(a.nth('9'))).toBe('d.csv:3:605')
  })

  test('loop: every item lives on the loop body, its values in the data (#55 #58)', () => {
    const a = fixture('csv-loop')
    for (const item of ['APPLE costs 1234.5678', 'PEAR costs 2.5', 'MANGO costs 0.333', 'PLUM costs 4']) {
      expect(a.at(a.nth(item))).toBe('main.typ:5:21')
    }
    const plum = a.nth('PLUM costs 4')
    expect(a.click(plum, 1)).toBe('p.csv:5:2')
    expect(a.click(plum, 6)).toBe('main.typ:5:22')
    expect(a.at(a.nth('•', 3))).toBe('main.typ:5:1')
    expect(a.caret('main.typ', 5, 3)).toBe(a.nth('APPLE costs 1234.5678'))
    expect(a.caret('p.csv', 5, 2)).toBe(plum)
  })

  test('numbers formatted on output take the cell between their neighbours (#57)', () => {
    const a = fixture('csv-numbers')
    expect(a.at(a.nth('1234.57'))).toBe('p.csv:2:7')
    expect(a.at(a.nth('1,500'))).toBe('p.csv:2:17')
    expect(a.at(a.nth('20,000'))).toBe('p.csv:3:10')
    expect(a.at(a.nth('0.33'))).toBe('p.csv:4:7')
  })

  test('table header words repeated in the prose stay in the data (#50)', () => {
    const a = fixture('csv-prose')
    expect(a.at(a.nth('city'))).toBe('a.csv:1:1')
    expect(a.at(a.nth('pop'))).toBe('a.csv:1:14')
    expect(a.at(a.nth(/^Oslo is the biggest/))).toBe('main.typ:5:1')
    expect(a.at(a.nth(/^The pop column/))).toBe('main.typ:7:1')
  })

  test('json: literal parts in the body, values clickable in the file (#54 #58)', () => {
    const a = fixture('json')
    const held = a.nth(/^Held in/)
    expect(a.at(held)).toBe('main.typ:10:1')
    expect(a.click(held, 0)).toBe('main.typ:10:1')
    expect(a.click(held, 'Held in '.length)).toBe('c.json:7:47')
    const title = a.nth(/^Title:/)
    expect(a.at(title)).toBe('main.typ:4:1')
    expect(a.click(title, 'Title: Unicode '.length)).toBe('c.json:2:21')
    expect(a.at(a.nth(/^José Núñez/))).toBe('c.json:4:16')
    expect(a.caret('main.typ', 10, 3)).toBe(held)
    expect(a.caret('main.typ', 12, 3)).toBe(a.nth(/^first note\./))
    expect([a.nth(/^José/), a.nth(/^Zoë/), a.nth('•', 0), a.nth('•', 1)]).toContain(a.caret('main.typ', 7, 3))
  })

  test('yaml: the literal word anchors the run, values map into the file (#58)', () => {
    const a = fixture('yaml')
    const run = a.nth(/^Night survey of owls by/)
    expect(a.at(run)).toBe('main.typ:4:10')
    expect(a.click(run, 'Night survey of owls by '.length)).toBe('c.yaml:3:9')
    expect(a.caret('main.typ', 4, 3)).toBe(run)
    expect(a.at(a.nth('tawny owl'))).toBe('c.yaml:7:12')
    expect(a.caret('main.typ', 6, 3)).toBe(a.nth('barn owl'))
  })

  test('read: a text file shown twice, a caret on each call finds its copy (#54)', () => {
    const a = fixture('read')
    expect(a.at(a.nth(/^It continues/, 0))).toBe('notes.txt:2:1')
    expect(a.kind(a.nth(/^It continues/, 1))).toBe('copy')
    expect(a.caret('main.typ', 3, 3)).toBe(a.nth(/^First paragraph/, 0))
    expect(a.caret('main.typ', 7, 3)).toBe(a.nth(/^First paragraph/, 1))
  })

  test('xml: values joined by a loop over a file loaded above it', () => {
    const a = fixture('xml')
    const owls = a.nth(/^Owls of the North/)
    expect(a.at(owls)).toBe('c.xml:2:16')
    expect(a.click(owls, 'Owls of the North / '.length)).toBe('c.xml:2:49')
    expect(a.at(a.nth(/^Herons and Egrets/))).toBe('c.xml:3:16')
  })

  test('lorem, a three-letter heading with a label, bullets and numbers', () => {
    const a = fixture('lorem')
    expect(a.at(a.nth('1.', 0))).toBe('main.typ:2:1')
    const lorem = a.nth(/^Lorem ipsum/)
    expect(a.at(lorem)).toBe('main.typ:4:1')
    expect(a.click(lorem, 3)).toBe('main.typ:4:11')
    expect(a.at(a.nth(/^possit, augeri/))).toBe('main.typ:4:1')
    expect(a.at(a.nth('1.1.'))).toBe('main.typ:6:1')
    expect(a.at(a.nth('fji'))).toBe('main.typ:6:4')
    expect(a.at(a.nth('•', 1))).toBe('main.typ:9:1')
    expect(a.at(a.nth('2.'))).toBe('main.typ:12:1')
    expect(a.caret('main.typ', 4, 3)).toBe(lorem)
  })

  test('imports, a function call, computed and literal values', () => {
    const a = fixture('imports')
    expect(a.at(a.nth('Dear reader of this letter'))).toBe('strings.typ:1:18')
    expect(a.at(a.nth(/^Banner:/))).toBe('main.typ:7:10')
    expect(a.at(a.nth('Total: 51 units.'))).toBe('main.typ:9:1')
    expect(a.at(a.nth('12'))).toBe('main.typ:11:24')
    expect(a.caret('main.typ', 5, 3)).toBe(a.nth('Dear reader of this letter'))
  })
})

test.describe('the glossary project (user report)', () => {
  // glossarium prints abbr-list.csv (read in abbr-setup.typ) through
  // custom-print-glossary, defined and called in abbreviations.typ; main.typ
  // then prints the same file raw with #csv.
  test('each glossary value opens its row of abbr-list.csv at its column', () => {
    const a = fixture('glossary')
    const rows = [['ВПП', 0, 2, 5], ['взлетно-посадочная полоса', 0, 2, 9], ['ЕЧР', 0, 3, 5], ['Европейская часть России', 0, 3, 9], ['ЕЧР', 1, 4, 6], ['Европейская часть России', 1, 4, 10]]
    for (const [text, k, line, col] of rows) {
      const i = a.nth(text, k)
      expect(a.at(i)).toBe(`abbr-list.csv:${line}:${col}`)
      expect(a.click(i, 0)).toBe(`abbr-list.csv:${line}:${col}`)
      expect(a.click(i, 2)).toBe(`abbr-list.csv:${line}:${col + 2}`)
    }
  })

  test('punctuation the template prints opens its line in abbreviations.typ', () => {
    const a = fixture('glossary')
    for (let k = 0; k < 3; k++) expect(a.at(a.nth('---', k))).toMatch(/^abbreviations\.typ:30:/)
    for (let k = 0; k < 2; k++) expect(a.at(a.nth(';', k))).toMatch(/^abbreviations\.typ:125:/)
    expect(a.at(a.nth('.', 0))).toMatch(/^abbreviations\.typ:126:/)
    // The raw print's brackets stay in the data file.
    expect(a.at(a.nth('(', 0))).toBe('abbr-list.csv:1:1')
  })

  test('a key split into runs by a Cyrillic letter opens each character', () => {
    const a = fixture('glossary')
    const et = a.nth('"et')
    expect(a.click(et, 1)).toBe('abbr-list.csv:4:1')
    expect(a.click(et, 2)).toBe('abbr-list.csv:4:2')
    expect(a.click(et + 1, 0)).toBe('abbr-list.csv:4:3')
    expect(a.click(et + 2, 0)).toBe('abbr-list.csv:4:4')
    expect(a.caret('abbr-list.csv', 4, 3)).toBe(et + 1)
  })

  test('carets on the lines printing the glossary find it, not the raw print', () => {
    const a = fixture('glossary')
    const glossary = new Set(Array.from({ length: 12 }, (_, k) => a.nth('ВПП') + k))
    for (let line = 150; line <= 163; line++) expect(glossary.has(a.caret('abbreviations.typ', line, 3))).toBe(true)
    expect(a.caret('main.typ', 54, 1)).toBe(a.nth('"key"'))
    // A blank line after #lorem stays on the lorem text; the last one on
    // the last paragraph; the module reading the CSV shows nothing.
    expect(a.runs[a.caret('main.typ', 57, 1)].text).toMatch(/^non delectet/)
    expect(a.caret('main.typ', 61, 1)).toBe(a.nth('Tail paragraph about herons.'))
    expect(a.caret('abbr-setup.typ', 2, 1)).toBe(-1)
  })
})

test.describe('round two defects', () => {
  test('a click maps through escapes, dashes, format characters and locale quotes', () => {
    const a = fixture('clicks')
    const lines = a.doc.text.split('\n')
    const words = [[3, 'tax'], [5, 'это'], [5, 'главное'], [7, 'partit'], [7, 'bonjour'], [9, 'is'], [11, 'cover'], [13, 'really'], [15, 'here'], [17, 'and'], [17, 'emoji'], [21, 'inside']]
    for (const [line, word] of words) {
      const i = a.runs.findIndex((r) => r.anchored && a.where(r.start).startsWith(`main.typ:${line}:`))
      expect(a.click(i, a.runs[i].raw.indexOf(word))).toBe(`main.typ:${line}:${lines[line - 1].indexOf(word) + 1}`)
    }
  })

  test('a caret at the first letter of a word after punctuation finds the word', () => {
    const a = fixture('clicks')
    expect(a.caret('main.typ', 24, 11)).toBe(a.nth('birds'))
    const raw = fixture('csv-raw')
    expect(raw.caret('birds.csv', 1, 6)).toBe(raw.nth('"habitat"', 0))
  })

  test('#context output stays on its line, not the next one nor the math', () => {
    const a = fixture('context')
    expect(a.at(a.nth('1', 0))).toBe('main.typ:5:1')
    expect(a.caret('main.typ', 5, 3)).toBe(a.nth('1', 0))
    // `(1,)` from counter.get(): on its line, not in `sum_(i=1)`.
    for (const t of ['(', ',)']) expect(a.at(a.nth(t))).toMatch(/^main\.typ:9:/)
    expect(a.at(a.nth('1', 1))).toMatch(/^main\.typ:9:/)
  })

  test('tables printed reversed, sorted or filtered pair each value with its row', () => {
    const a = fixture('csv-order')
    const files = { heron: 'a.csv', owl: 'b.csv', finch: 'c.csv' }
    let pairs = 0
    a.runs.forEach((r, i) => {
      const m = r.text.match(/^(heron|owl|finch)(\d+)$/)
      if (!m) return
      const row = Number(m[2]) + 1
      expect(a.at(i)).toBe(`${files[m[1]]}:${row}:1`)
      expect(a.at(i + 1)).toBe(`${files[m[1]]}:${row}:${m[0].length + 2}`)
      pairs++
    })
    expect(pairs).toBe(93)
    // The filter's "retired" is a condition, never the text of a cell.
    expect(a.runs.some((r) => r.start != null && a.where(r.start).startsWith('main.typ:13:'))).toBe(false)
  })

  test('two pictures on one #grid line after figures both stay on it', () => {
    const a = fixture('grid-after-figure')
    expect(a.pictures().map((i) => a.at(i).split(':')[1])).toEqual(['5', '9', '11', '11'])
  })

  test('an outline page number goes with its own entry', () => {
    const a = fixture('outline')
    const numbers = a.runs.map((_, i) => i).filter((i) => /^\s\u2060\d+$/.test(a.runs[i].raw))
    expect(numbers.map((i) => a.at(i).split(':')[1])).toEqual(['4', '8', '12', '16'])
  })

  test('a caret on a data key finds the run printing that record', () => {
    const json = fixture('json')
    expect(json.caret('c.json', 2, 3)).toBe(json.nth(/^Title:/))
    expect(json.caret('c.json', 7, 3)).toBe(json.nth(/^Held in/))
    const yaml = fixture('yaml')
    expect(yaml.caret('c.yaml', 1, 1)).toBe(yaml.nth(/^Night survey of owls by/))
  })

  test('bibliography: a closing brace stays in its entry, a label opens the entry head', () => {
    const a = fixture('bibliography')
    expect(a.at(a.caret('refs.bib', 6, 1))).toMatch(/^refs\.bib:[1-5]:/)
    // The labels of the list come after the citations in the body.
    expect(a.click(a.nth('[1]', 2), 1)).toBe('refs.bib:1:1')
    expect(a.click(a.nth('[2]', 1), 1)).toBe('refs.bib:8:1')
  })

  test('a 120-page document with an outline aligns within a frame budget (#56)', () => {
    const first = ['Anna', 'Boris', 'Clara', 'Dmitri', 'Elena', 'Felix', 'Greta']
    const cities = ['Oslo', 'Bergen', 'Riga', 'Tallinn', 'Vilnius', 'Helsinki', 'Turku']
    const sections = Array.from({ length: 120 }, (_, k) => {
      const p = k + 1
      return {
        title: `Section ${p} on topic ${first[p % 7]} ${cities[(p * 3) % 7]}`,
        one: `This is paragraph one of section ${p}, written about ${cities[p % 7]} and its harbour number ${p * 13}.`,
        two: `It continues here with a second line describing the weather in ${cities[(p + 5) % 7]}.`,
        short: `A shorter second paragraph for section ${p}.`
      }
    })
    const main = '#set page(height: 12cm)\n#outline()\n\n' + sections.map((s) => `= ${s.title}\n\n${s.one}\n${s.two}\n\n${s.short}\n\n#pagebreak()\n`).join('\n')
    const recorded = [{ t: 'Contents', page: 0 }]
    sections.forEach((s, k) => {
      const page = Math.floor(k / 17)
      recorded.push({ t: `${s.title} `, page })
      for (let d = 0; d < 88; d++) recorded.push({ t: '.', page })
      recorded.push({ t: ` \u2060${k + 8}`, page })
    })
    sections.forEach((s, k) => {
      const page = k + 7
      const cut = s.one.length - 12
      recorded.push({ t: s.title, page }, { t: `${s.one.slice(0, cut)}`, page }, { t: `${s.one.slice(cut)} ${s.two}`, page }, { t: s.short, page })
    })
    const started = performance.now()
    const a = align([{ path: 'main.typ', content: main }], 'main.typ', recorded)
    expect(performance.now() - started).toBeLessThan(300)
    // The entry copies its heading; its page number goes with it.
    const entry = a.nth(sections[60].title, 0)
    const heading = a.nth(sections[60].title, 1)
    expect(a.kind(entry)).toBe('copy')
    expect(a.kind(heading)).toBe('ordered')
    expect(a.at(entry + 89).split(':')[1]).toBe(a.at(heading).split(':')[1])
  })
})

test.describe('placement and lookup', () => {
  test('a huge gap of generated runs stays bounded and keeps its line (#22)', () => {
    const lines = Array.from({ length: 2100 }, (_, k) => `#f${k}()`)
    const main = `Opening sentence about kestrels.\n#lorem(2000)\n${lines.join('\n')}\nClosing sentence about herons.\n`
    const recorded = [{ t: 'Opening sentence about kestrels.', page: 0 }]
    for (let k = 0; k < 1000; k++) recorded.push({ t: `Lorem ipsum dolor sit amet number ${k} consectetur.`, page: 0 })
    recorded.push({ t: 'Closing sentence about herons.', page: 0 })
    const started = Date.now()
    const a = align([{ path: 'main.typ', content: main }], 'main.typ', recorded)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(a.at(1)).toBe('main.typ:2:1')
    expect(a.at(1000)).toBe('main.typ:2:1')
    expect(a.at(1001)).toBe('main.typ:2103:1')
  })

  test('a caret prefers matched text over a copy or a mark at the same place (#27 #30)', () => {
    const a = align([{ path: 'main.typ', content: '#outline()\n\n= Kestrels\n\nBody about kestrels here.\n' }], 'main.typ', [
      { t: 'Contents', page: 0 },
      { t: 'Kestrels', page: 0 },
      { t: '1', page: 0 },
      { t: 'Kestrels', page: 0 },
      { t: 'Body about kestrels here.', page: 0 }
    ])
    expect(a.kind(1)).toBe('copy')
    expect(a.kind(3)).toBe('ordered')
    expect(a.caret('main.typ', 3, 4)).toBe(3)
    expect(a.caret('main.typ', 3, 1)).toBe(3)
  })
})

test.describe('one paragraph from several sources', () => {
  // Two `#include`s on consecutive lines set one paragraph: each part keeps
  // its own file, both for a click and for a resting caret.
  const files = [
    { path: 'main.typ', content: '= Book\n\n#include "ch1.typ"\n#include "ch2.typ"\n\nAfter about herons.\n' },
    { path: 'ch1.typ', content: 'Chapter text about otters.\n' },
    { path: 'ch2.typ', content: 'Second chapter about beavers.\n' }
  ]
  const recorded = [
    { t: 'Book', page: 0 },
    { t: 'Chapter text about otters. Second chapter about beavers.', page: 0 },
    { t: 'After about herons.', page: 0 }
  ]

  test('a click in either part opens that part at the character', () => {
    const a = align(files, 'main.typ', recorded)
    const i = a.nth(/^Chapter text/)
    expect(a.click(i, 0)).toBe('ch1.typ:1:1')
    expect(a.click(i, 21)).toBe('ch1.typ:1:22')
    expect(a.click(i, 30)).toBe('ch2.typ:1:4')
    expect(a.click(i, 50)).toBe('ch2.typ:1:24')
  })

  test('a caret in either file finds the paragraph', () => {
    const a = align(files, 'main.typ', recorded)
    const i = a.nth(/^Chapter text/)
    expect(a.caret('ch1.typ', 1, 5)).toBe(i)
    expect(a.caret('ch2.typ', 1, 5)).toBe(i)
  })
})

// Glyphs as the SVG draws them: pen positions (`x`, in the glyph group's
// units) and blank glyphs (spaces), optionally the characters a ligature
// glyph is marked with (`n`), what the page draws with a glyph elsewhere
// (`char`) and the text layer's character widths (`layer`).
function glyphs(xs, endX, { blank = [], n = [], char = [], layer = null } = {}) {
  return { glyphs: xs.map((x, k) => ({ x, n: n[k] || 1, blank: blank.includes(k), char: char[k] || null })), endX, layer }
}

// The pointer in the left quarter of the advance of glyph k (at least 20
// units in), as the gate's sweep clicks a visible glyph.
function leftQuarter(drawn, k) {
  const xs = drawn.glyphs.map((g) => g.x)
  const right = k + 1 < xs.length ? xs[k + 1] : drawn.endX
  return xs[k] + Math.max(0.25 * (right - xs[k]), 20)
}

test.describe('round three defects', () => {
  test('a click on a drawn glyph lands on its character, not where the text layer puts it', () => {
    // Pen positions recorded from the user's glossary project on 4002: the
    // printed CSV dump is set in a monospace font much wider than the text
    // layer, the body text in a proportional one.
    const a = fixture('glossary')
    const key = glyphs([0, 1233, 2466, 3699, 4932], 6164.96)
    expect([1, 2, 3].map((k) => a.clickGlyph(a.nth('"key"'), key, leftQuarter(key, k)))).toEqual(['abbr-list.csv:1:1', 'abbr-list.csv:1:2', 'abbr-list.csv:1:3'])
    const description = glyphs([0, 1233, 2466, 3699, 4932, 6165, 7398, 8631, 9864, 11097, 12330, 13563, 14796], 16028.96)
    expect(a.clickGlyph(a.nth('"description"'), description, leftQuarter(description, 6))).toBe('abbr-list.csv:1:21')
    // The right half of a glyph puts the caret after its character.
    expect(a.clickGlyph(a.nth('"description"'), description, 7398 + 1000)).toBe('abbr-list.csv:1:22')
    const strip = glyphs(
      [0, 479, 915, 1442, 1889, 2334, 2920, 3424, 3762, 4348, 4852, 5280, 5737, 6275, 6779, 7318, 7904, 8361, 8842, 9092, 9678, 10182, 10709, 11213, 11641],
      12097.92,
      { blank: [18] }
    )
    expect(a.clickGlyph(a.nth('взлетно-посадочная полоса', 0), strip, leftQuarter(strip, 5))).toBe('abbr-list.csv:2:14')
    const tail = glyphs(
      [0, 548, 1005, 1276, 1540, 1790, 2309, 2766, 3138, 3595, 4095, 4467, 4924, 5443, 5981, 6231, 6688, 7191, 7695, 8226, 8542, 8792, 9330, 9777, 10141, 10645, 11187, 11577],
      11796.96,
      { blank: [4, 14, 20] }
    )
    const run = a.nth('Tail paragraph about herons.')
    for (let k = 0; k < 28; k++) expect(a.clickGlyph(run, tail, leftQuarter(tail, k))).toBe(`main.typ:60:${k + 1}`)
  })

  test('a ligature glyph shares its advance among the characters it draws', () => {
    // `fji` draws `fj` with one glyph the renderer does not mark: its
    // advance holds two characters, so each third of the run is one of them.
    const a = fixture('glossary')
    const fji = glyphs([0, 631], 952.96)
    expect([79, 394, 711].map((x) => a.clickGlyph(a.nth('fji'), fji, x))).toEqual(['main.typ:58:4', 'main.typ:58:5', 'main.typ:58:6'])
    // A ligature marked with data-liga-len: `ffi` draws three characters.
    const marked = glyphs([0, 730, 1677, 2133], 2622, { n: [1, 3, 1, 1] })
    expect([1100, 1400, 1700].map((x) => textBeforeX('Office', marked.glyphs, marked.endX, x))).toEqual(['Of', 'Off', 'Offi'])
    // Unmarked, the wide `O` would take two letters by advance alone; the
    // glyphs the page draws elsewhere (`O`, `c`, `e`), or the text layer's
    // proportions, leave the three to the ligature.
    for (const hint of [{ char: ['O', null, 'c', 'e'] }, { layer: [0.72, 0.33, 0.33, 0.28, 0.44, 0.44] }]) {
      const drawn = glyphs([0, 730, 1677, 2133], 2622, hint)
      expect([1100, 1400, 1700].map((x) => textBeforeX('Office', drawn.glyphs, drawn.endX, x, drawn.layer))).toEqual(['Of', 'Off', 'Offi'])
    }
    // A character outside the Basic Multilingual Plane is one glyph.
    expect(textBeforeX('a😀b', glyphs([0, 100, 300], 400).glyphs, 400, 320)).toBe('a😀')
  })

  test('glyphs that cannot be read leave the click to the text layer', () => {
    // Right to left (glyphs in visual order), out of order, more glyphs than
    // characters, none at all.
    expect(textBeforeX('مرحبا', glyphs([0, 1, 2, 3, 4], 5).glyphs, 5, 2)).toBeNull()
    expect(textBeforeX('abc', glyphs([0, 200, 100], 300).glyphs, 300, 150)).toBeNull()
    expect(textBeforeX('ab', glyphs([0, 1, 2], 3).glyphs, 3, 1)).toBeNull()
    expect(textBeforeX('ab', [], 3, 1)).toBeNull()
  })

  test('short or repeated footnote texts pair with their own calls, in order', () => {
    // `Note 1.`, `Note 2.`, `Ibid.` twice; the fifth note's paragraph goes
    // to page 2 with the sixth.
    const a = fixture('footnotes-short')
    const bodies = [['Note 1.', 0, '4:57'], ['Note 2.', 0, '6:57'], ['See Smith, p. 4.', 0, '8:64'], ['Ibid.', 0, '10:64'], ['Ibid.', 1, '12:62'], ['Note 6.', 0, '14:62']]
    for (const [t, k, at] of bodies) expect(a.at(a.nth(t, k))).toBe(`main.typ:${at}`)
    expect(a.click(a.nth('Ibid.', 1), 2)).toBe('main.typ:12:64')
    // The markers stay at their calls, the footnote-area numbers at the
    // start of their call's line.
    for (const [k, line, col] of [[1, 4, 47], [2, 6, 47], [3, 8, 54], [4, 10, 54], [5, 12, 52]]) {
      expect(a.at(a.nth(String(k), 0))).toBe(`main.typ:${line}:${col}`)
      expect(a.at(a.nth(String(k), 1))).toBe(`main.typ:${line}:1`)
    }
    // A caret in a body finds it; one on the call finds its marker.
    expect(a.caret('main.typ', 10, 66)).toBe(a.nth('Ibid.', 0))
    expect(a.caret('main.typ', 4, 50)).toBe(a.nth('1', 0))
  })

  test('a math line after a #context line keeps its first glyph', () => {
    const a = fixture('context')
    expect(a.at(a.nth('∑'))).toBe('main.typ:10:1')
    // `(1,)` from counter.get() still goes to its own line.
    for (const t of ['(', ',)']) expect(a.at(a.nth(t))).toMatch(/^main\.typ:9:/)
  })

  test('a #for over an array literal: the template text on the body, each value on its literal', () => {
    const a = fixture('loops')
    const run = a.nth(/^Hello Ada/)
    const text = a.runs[run].raw
    const at = (word, k = 0) => {
      let idx = -1
      for (let n = 0; n <= k; n++) idx = text.indexOf(word, idx + 1)
      return a.click(run, idx)
    }
    for (let k = 0; k < 3; k++) expect(at('Hello', k)).toBe('main.typ:3:36')
    expect([at('Ada'), at('Bob'), at('Cy')]).toEqual(['main.typ:3:16', 'main.typ:3:23', 'main.typ:3:30'])
    expect(a.caret('main.typ', 3, 30)).toBe(run)
  })

  test('a caret inside an @reference finds the printed Section N', () => {
    const a = fixture('references')
    expect(a.caret('main.typ', 8, 6)).toBe(a.nth('Section 1'))
    expect(a.caret('main.typ', 8, 17)).toBe(a.nth('Section 2'))
    expect(a.click(a.nth('Section 1'), 0)).toBe('main.typ:8:5')
    expect(a.caret('main.typ', 8, 13)).toBe(a.nth('and'))
  })

  test('a caret on a BibTeX author line finds the entry printing the authors', () => {
    const a = fixture('bibliography')
    const entry = a.nth(/^J\. Smith and J\. Doe/)
    expect(a.caret('refs.bib', 3, 3)).toBe(entry)
    expect(a.click(entry, 'J. '.length)).toBe('refs.bib:3:13')
    expect(a.caret('refs.bib', 4, 3)).toBe(a.nth('Journal of Ornithology'))
  })
})

test.describe('round four defects', () => {
  test('string arguments of a `#show: project.with(...)` template print where they are written', () => {
    const a = fixture('show-template')
    const title = a.nth('Migration of Cranes')
    expect(a.at(title)).toBe('main.typ:2:29')
    expect(a.click(title, 'Migration of '.length)).toBe('main.typ:2:42')
    expect(a.click(a.nth(/^Ada Lin/), 0)).toBe('main.typ:2:62')
    expect(a.click(a.nth('Борис Ким'), 'Борис '.length)).toBe('main.typ:2:79')
    // The template's own text stays in its file.
    expect(a.at(a.nth('Prepared for the field station.'))).toBe('template.typ:5:4')
    expect(a.caret('main.typ', 2, 30)).toBe(title)
    expect(a.caret('main.typ', 2, 75)).toBe(a.nth('Борис Ким'))
  })

  test('the strings of a `show` rule that sets are settings, not text', () => {
    const files = [{ path: 'main.typ', content: '#show heading: set text(font: "Arial")\n= Arial\n' }]
    const a = align(files, 'main.typ', [{ t: 'Arial', page: 0 }])
    expect(a.at(0)).toBe('main.typ:2:3')
  })

  test('a prose citation goes to its #cite, an equation number to its equation', () => {
    const a = fixture('cite-prose')
    const prose = a.nth('I. Petrov [1]')
    expect(a.at(prose)).toBe('main.typ:4:1')
    expect(a.click(prose, 'I. Pe'.length)).toBe('main.typ:4:1')
    expect(a.caret('main.typ', 4, 3)).toBe(prose)
    expect(a.at(a.nth('(1)'))).toMatch(/^main\.typ:6:/)
    expect(a.at(a.nth(/^predicts/))).toBe('main.typ:8:15')
  })

  test('the bullets of a #for over data go to the loop body, the values to the file', () => {
    const a = fixture('json-loop')
    for (let k = 0; k < 3; k++) expect(a.at(a.nth('•', k))).toBe('main.typ:4:1')
    expect(a.at(a.nth(/^Борис Орлов/))).toBe('people.json:3:13')
    expect(a.click(a.nth(/^Chen Wei/), 0)).toBe('people.json:4:13')
    const json = fixture('json')
    for (let k = 0; k < 2; k++) expect(json.at(json.nth('•', k))).toBe('main.typ:7:1')
  })

  test('a running header on every page goes to its definition, outline numbers to their entries', () => {
    const a = fixture('running-header')
    for (const t of ['Стр. 1', 'Стр. 2']) {
      expect(a.at(a.nth(t))).toBe('main.typ:2:41')
      expect(a.click(a.nth(t), 0)).toBe('main.typ:2:41')
    }
    const numbers = a.runs.map((_, i) => i).filter((i) => /^\s⁠\d+$/.test(a.runs[i].raw))
    expect(numbers.map((i) => a.at(i).split(':')[1])).toEqual(['4', '8', '13'])
    // The leader dots take no period of the header's text.
    const dots = a.runs.map((_, i) => i).filter((i) => a.runs[i].text === '.')
    expect(dots.every((i) => !a.at(i).startsWith('main.typ:2:'))).toBe(true)
  })
})

test.describe('round five defects', () => {
  test('a #for over records written one field per line takes each value from the record it prints', () => {
    for (const [shape, file, lines] of [
      ['yaml-records', 'crew.yaml', [[1, 2], [3, 4], [5, 6]]],
      ['json-records', 'crew.json', [[3, 4], [7, 8], [11, 12]]],
      ['toml-records', 'crew.toml', [[2, 3], [6, 7], [10, 11]]],
      ['xml-records', 'crew.xml', [[3, 4], [7, 8], [11, 12]]]
    ]) {
      const a = fixture(shape)
      ;['Ines', 'Oskar', 'Mirela'].forEach((name, k) => {
        const run = a.nth(new RegExp(`^${name}\\b`))
        const raw = a.runs[run].raw
        const role = raw.search(/botanist|pilot/)
        expect(a.click(run, 0)).toMatch(new RegExp(`^${file.replace('.', '\\.')}:${lines[k][0]}:`))
        expect(a.click(run, role)).toMatch(new RegExp(`^${file.replace('.', '\\.')}:${lines[k][1]}:`))
        // A caret on either value of the record finds the item printing it.
        for (const idx of [0, role]) {
          const [, line, col] = a.click(run, idx).split(':')
          expect(a.caret(file, +line, +col)).toBe(run)
        }
      })
    }
  })

  test('record fields printed in another order still come from one record', () => {
    const a = fixture('yaml-reversed')
    const items = [/^botanist\W+Ines/, /^pilot\W+Oskar/, /^botanist\W+Mirela/].map((t) => a.nth(t))
    expect(items.map((i) => [a.click(i, 0), a.click(i, a.runs[i].raw.indexOf('— ') + 2)])).toEqual([
      ['crew.yaml:2:9', 'crew.yaml:1:9'],
      ['crew.yaml:4:9', 'crew.yaml:3:9'],
      ['crew.yaml:6:9', 'crew.yaml:5:9']
    ])
    for (let line = 1; line <= 6; line++) expect(a.caret('crew.yaml', line, 9)).toBe(items[(line - 1) >> 1])
  })

  test('the numbers of an enum printed for data go to the list marker, not to a key of the file', () => {
    const a = fixture('yaml-records')
    for (const t of ['1.', '2.', '3.']) expect(a.at(a.nth(t))).toBe('main.typ:5:1')
  })

  test('a heading shown through a rule adding text lives at the heading, the added text in the rule', () => {
    const a = fixture('show-heading-literal')
    for (const [t, line] of [['Ascent', 3], ['Descent', 7]]) {
      const run = a.nth(new RegExp(`^${t} `))
      expect(a.at(run)).toBe(`main.typ:${line}:3`)
      expect(a.click(run, 1)).toBe(`main.typ:${line}:4`)
      expect(a.click(run, `${t} (C`.length)).toBe('main.typ:2:39')
      expect(a.caret('main.typ', line, 4)).toBe(run)
    }
  })

  test('a value printed first in a list item goes to its file, an e-mail to its own field', () => {
    const a = fixture('list-values')
    const lead = a.nth(/^Vera Lind/)
    expect(a.click(lead, 0)).toBe('staff.yaml:1:7')
    expect(a.click(lead, 'Vera '.length)).toBe('staff.yaml:1:12')
    expect(a.click(lead, 'Vera Lind '.length)).toBe('main.typ:2:11')
    expect(a.caret('staff.yaml', 1, 7)).toBe(lead)
    const contact = a.nth(/^Contact:/)
    expect(a.click(contact, 'Contact: '.length)).toBe('staff.yaml:2:7')
    expect(a.caret('staff.yaml', 2, 7)).toBe(contact)
  })

  test('a context footer on every page goes to its words in the page setup', () => {
    const a = fixture('page-footer')
    const footers = [a.nth('Page 1 of 3'), a.nth('Page 2 of 3')]
    for (const f of footers) {
      expect(a.click(f, 0)).toBe('main.typ:1:79')
      expect(a.click(f, 'Page 1 '.length)).toBe('main.typ:1:109')
    }
    expect(a.caret('main.typ', 1, 80)).toBe(footers[0])
  })

  test('a caret on the symbol opening a display-math line finds its glyph', () => {
    const a = fixture('math-lines')
    const integral = a.nth('∫')
    expect(a.at(integral)).toBe('main.typ:5:1')
    expect(a.caret('main.typ', 5, 5)).toBe(integral)
    // The text normalized: the math italic 𝑎 as `a`.
    expect(a.caret('main.typ', 9, 3)).toBe(a.nth('a'))
  })

  test('a caret on a call spreading a data file finds the first value it printed', () => {
    const a = fixture('csv-spread')
    expect(a.caret('main.typ', 4, 5)).toBe(a.nth('Species'))
    expect(a.caret('birds.csv', 4, 1)).toBe(a.nth('Kestrel'))
  })

  test('a caret on a template line using a parameter finds what the call passed', () => {
    const a = fixture('show-template')
    expect(a.caret('template.typ', 3, 10)).toBe(a.nth('Migration of Cranes'))
    expect(a.caret('template.typ', 4, 17)).toBe(a.nth(/^Ada Lin/))
    expect(a.caret('template.typ', 6, 3)).toBe(a.nth('Background'))
  })
})

// Words made from a seed (consonant-vowel syllables), so a rule's behaviour
// is checked over words nobody picked.
function wordsFrom(seed) {
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = (set) => set[Math.floor(rnd() * set.length)]
  return () => {
    let w = ''
    for (let k = 2 + Math.floor(rnd() * 3); k > 0; k--) w += pick('bcdfghklmnprstvz') + pick('aeiou')
    return w[0].toUpperCase() + w.slice(1)
  }
}

// Where `word` stands on the first line of `lines` holding it as a word
// that `skip` does not exclude, as file:line:col.
function wordAt(file, lines, word, skip = () => false) {
  for (let k = 0; k < lines.length; k++) {
    if (skip(k)) continue
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'u').exec(lines[k])
    if (m) return `${file}:${k + 1}:${m.index + 1}`
  }
  throw new Error(`no ${word}`)
}

test.describe('round six defects', () => {
  test('show rules printing text around what they show: the text goes to the rule, the rest to its element', () => {
    const fx = loadFixture('show-rule-pieces')
    const lines = fx.files[0].content.split('\n')
    const isRule = (k) => lines[k].startsWith('#show')
    const a = fixture('show-rule-pieces')
    // Every word of every run: a word a rule writes lands on the rule, any
    // other word on its own line (a heading, a paragraph, a caption).
    fx.runs.forEach((r, i) => {
      for (const m of r.t.matchAll(/[\p{L}\p{N}]+/gu)) {
        const rule = lines.findIndex((l, k) => isRule(k) && new RegExp(`[(\\[]${m[0]}[):]`, 'u').test(l))
        const want = rule >= 0 ? wordAt('main.typ', lines, m[0], (k) => k !== rule) : wordAt('main.typ', lines, m[0], isRule)
        expect(a.click(i, m.index), `${r.t} @ ${m[0]}`).toBe(want)
      }
    })
    // A caret on each heading finds the run showing it.
    lines.forEach((l, k) => {
      const h = /^=+ (.+)$/.exec(l)
      if (h) expect(a.runs[a.caret('main.typ', k + 1, l.indexOf(h[1]) + 2)].text).toContain(h[1])
    })
  })

  test('heading rules over generated words: every heading keeps its line, the added text its rule', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const word = wordsFrom(seed)
      for (const form of ['suffix', 'prefix', 'both', 'parameter']) {
        const add = word()
        const tail = word().toLowerCase()
        const rule = {
          suffix: `#show heading: it => block[#it.body (${add})]`,
          prefix: `#show heading: it => [${add}: #it.body]`,
          both: `#show heading: it => [${add} #it.body ${tail}]`,
          parameter: `#show heading: h => [${add} -- #h.body]`
        }[form]
        const shown = (h) => ({ suffix: `${h} (${add})`, prefix: `${add}: ${h}`, both: `${add} ${h} ${tail}`, parameter: `${add} – ${h}` })[form]
        const heads = Array.from({ length: 2 + (seed % 4) }, word)
        const lines = [rule]
        const runs = []
        for (const h of heads) {
          const sentence = `${word()} ${word().toLowerCase()}.`
          lines.push(`= ${h}`, '', sentence, '')
          runs.push({ t: shown(h), page: 0 }, { t: sentence, page: 0 })
        }
        const a = align([{ path: 'main.typ', content: lines.join('\n') }], 'main.typ', runs)
        heads.forEach((h, k) => {
          const line = 2 + 4 * k
          const i = 2 * k
          const label = `seed ${seed} ${form} ${runs[i].t}`
          expect(a.click(i, runs[i].t.indexOf(h)), label).toBe(`main.typ:${line}:3`)
          expect(a.click(i, runs[i].t.indexOf(add)), label).toBe(`main.typ:1:${rule.indexOf(add) + 1}`)
          if (form === 'both') expect(a.click(i, runs[i].t.lastIndexOf(tail)), label).toBe(`main.typ:1:${rule.lastIndexOf(tail) + 1}`)
          expect(a.caret('main.typ', line, 4), label).toBe(i)
          expect(a.click(i + 1, 0), label).toBe(`main.typ:${line + 2}:1`)
        })
      }
    }
  })

  test('records printed through a local function: values in their own record, the literal in the definition', () => {
    for (const [shape, file] of [['function-records-yaml', 'folk.yaml'], ['function-records-json', 'data/folk.json']]) {
      const fx = loadFixture(shape)
      const data = fx.files.find((f) => f.path === file).content.split('\n')
      const main = fx.files.find((f) => f.path === 'main.typ').content.split('\n')
      const a = fixture(shape)
      const items = ['Astrid', 'Björn', 'Cecilia'].map((name) => a.nth(new RegExp(`^${name} `)))
      items.forEach((i, k) => {
        const t = a.runs[i].text
        // The record of the k-th name: its lines in the file.
        const nameLine = data.findIndex((l) => l.includes(t.split(' ')[0]))
        const record = file.endsWith('.json') ? [nameLine, nameLine] : [nameLine - 2, nameLine]
        for (const m of t.matchAll(/[\p{L}\p{N}]+/gu)) {
          const at = a.click(i, m.index)
          if (main[1].includes(` ${m[0]} `) || main[1].includes(` ${m[0]}.`)) {
            expect(at, `${t} @ ${m[0]}`).toMatch(/^main\.typ:2:/)
          } else {
            const [f, line] = at.split(':')
            expect(f, `${t} @ ${m[0]}`).toBe(file)
            expect(Number(line) - 1, `${t} @ ${m[0]}`).toBeGreaterThanOrEqual(record[0])
            expect(Number(line) - 1, `${t} @ ${m[0]}`).toBeLessThanOrEqual(record[1])
          }
        }
        expect(a.caret(file, nameLine + 1, data[nameLine].indexOf(t.split(' ')[0]) + 1)).toBe(i)
      })
      // A caret on the call finds what it printed.
      expect(items).toContain(a.caret('main.typ', 7, 4))
      // The literal before an inline call keeps its spot.
      const total = a.nth(/^Totalt/)
      expect(a.click(total, 0)).toBe('main.typ:11:1')
      expect(a.click(total, 'Totalt 3 '.length)).toBe('main.typ:11:20')
    }
  })

  test('literal text in a function definition goes to the definition from every call', () => {
    const a = fixture('definition-literal')
    for (const k of [0, 1]) expect(a.click(a.nth(/^Achtung/, k), 0)).toBe('main.typ:2:25')
    expect(a.click(a.nth('Akku schwach'), 1)).toBe('main.typ:6:8')
    // A caret on the parameter after the definition's text finds what the
    // first call passed for it.
    expect(a.caret('main.typ', 2, 40)).toBe(a.nth('Akku schwach'))
  })

  test('a context footer on every page of a document without a header goes to its definition', () => {
    const a = fixture('page-footer-only')
    for (const t of ['Page 1 of 3', 'Page 2 of 3']) {
      expect(a.click(a.nth(t), 0)).toBe('main.typ:1:41')
      expect(a.click(a.nth(t), 'Page 1 '.length)).toBe('main.typ:1:71')
    }
    expect(a.caret('main.typ', 1, 42)).toBe(a.nth('Page 1 of 3'))
  })

  test('a value printed inline after literal text keeps its own marks', () => {
    const a = fixture('inline-values')
    const run = a.nth(/^La nostra guida/)
    expect(a.click(run, 'La nostra guida è '.length)).toBe('conf/viaggio.toml:3:9')
    expect(a.click(run, 'La nostra guida è Marco Bellini, raggiungibile al '.length)).toBe('conf/viaggio.toml:4:13')
    expect(a.click(run, 'La nostra guida è Marco Bellini, raggiungibile al +'.length)).toBe('conf/viaggio.toml:4:14')
  })
})

test.describe('round seven defects', () => {
  test('decomposed, composed and mixed accents and compatibility characters: each word lands on itself', () => {
    const fx = loadFixture('nfd-text')
    const lines = fx.files[0].content.split('\n')
    const a = fixture('nfd-text')
    // A word (with its combining marks) as the source spells it, from line
    // `from` on: the run's text keeps the source's code points.
    const where = (w, from = 0, col = 0) => {
      for (let k = from; k < lines.length; k++) {
        const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${w}(?![\\p{L}\\p{M}\\p{N}])`, 'gu')
        re.lastIndex = k === from ? col : 0
        const m = re.exec(lines[k])
        if (m) return `main.typ:${k + 1}:${m.index + 1}`
      }
      throw new Error(`no ${w}`)
    }
    fx.runs.forEach((r, i) => {
      let [, line, col] = a.at(i).split(':').map(Number)
      for (const m of r.t.matchAll(/[\p{L}\p{M}\p{N}²]+/gu)) {
        const want = where(m[0], line - 1, col - 1)
        expect(a.click(i, m.index), `${r.t} @ ${m[0]}`).toBe(want)
        ;[, line, col] = want.split(':').map(Number)
        col += m[0].length
      }
    })
    const D = (s) => s.normalize('NFD')
    expect(where(D('Giới'))).toBe('main.typ:1:3')
    expect(where(D('Genève'))).toBe('main.typ:3:48')
    expect(where(D('dựng'))).toBe('main.typ:5:43')
    expect(where('tách')).toBe('main.typ:5:59')
    expect(where('２０２４')).toBe('main.typ:7:12')
    // A caret inside a decomposed word finds its run.
    expect(a.caret('main.typ', 1, 4)).toBe(a.nth(/^Giới/))
    expect(a.caret('main.typ', 3, 5)).toBe(a.nth(/^Le café/))
    expect(a.caret('main.typ', 5, 44)).toBe(a.nth(/^Đoạn/))
    expect(a.caret('main.typ', 7, 58)).toBe(a.nth(/^En l/))
  })

  test('a file two chapters reach through an include loop resolves the same in any source order', () => {
    const fx = loadFixture('dynamic-includes')
    const main = fx.files.find((f) => f.path === 'main.typ')
    const rest = fx.files.filter((f) => f !== main)
    const byPath = (x, y) => x.path.localeCompare(y.path)
    const orders = [rest, [...rest].reverse(), [...rest].sort(byPath), [...rest].sort(byPath).reverse()]
    let layout = null
    for (const files of orders) {
      const label = files.map((f) => f.path).join(' ')
      const a = align([...files, main], 'main.typ', fx.runs)
      const lines = a.doc.lines.map((l) => `${l.file}:${l.line}`)
      if (layout) expect(lines, label).toEqual(layout)
      layout = lines
      // The shared note, included relatively from one chapter and by an
      // absolute path from a file nested in the other: both renders go to it.
      for (const k of [0, 1]) expect(a.click(a.nth(/^Megjegyzés/, k), 0), label).toBe('kozos/labjegyzet.typ:1:2')
      expect(a.click(a.nth(/^Az északi/), 'Az '.length), label).toBe('resz/a.typ:3:4')
      expect(a.click(a.nth(/^A mérések/), 'A mérések '.length), label).toBe('resz/alresz/b.typ:3:11')
      expect(a.click(a.nth(/^Köszönjük/), 0), label).toBe('main.typ:8:1')
      expect([0, 1].map((k) => a.nth(/^Megjegyzés/, k)), label).toContain(a.caret('kozos/labjegyzet.typ', 1, 3))
      expect(a.caret('resz/c.typ', 3, 4), label).toBe(a.nth(/^A déli/))
    }
  })

  test("a definition's literal text goes to the definition, what its calls write to the calls", () => {
    const a = fixture('definition-call-args')
    const lucia = a.nth(/^Nombre: Lucía/)
    const andres = a.nth(/^Nombre: Andrés/)
    for (const i of [lucia, andres]) {
      expect(a.click(i, 0)).toBe('main.typ:1:21')
      expect(a.click(i, a.runs[i].text.indexOf('ciudad'))).toBe('main.typ:1:33')
    }
    // A string argument and a content argument.
    expect(a.click(lucia, 'Nombre: '.length)).toBe('main.typ:6:9')
    expect(a.click(lucia, 'Nombre: Lucía, ciudad: '.length)).toBe('main.typ:6:18')
    expect(a.click(andres, 'Nombre: '.length)).toBe('main.typ:8:8')
    expect(a.click(andres, 'Nombre: Andrés, ciudad: '.length)).toBe('main.typ:8:16')
    // A caret on the definition's text finds the first card.
    expect(a.caret('main.typ', 1, 23)).toBe(lucia)
    expect(a.caret('main.typ', 8, 10)).toBe(andres)
  })

  test("a rule's text is split only off what its selected element shows", () => {
    const a = fixture('show-rule-element')
    const intro = a.nth(/^Intro/)
    const report = a.nth(/^Report/)
    expect(a.click(intro, 0)).toBe('main.typ:3:3')
    expect(a.click(intro, 'Intro ('.length)).toBe('main.typ:1:38')
    // A paragraph printing a value and the same literal is no heading.
    expect(a.click(report, 'Report ('.length)).toBe('main.typ:7:5')
    expect(a.caret('main.typ', 7, 6)).toBe(report)
  })

  test('rule pieces reach through the code a rule prints beside the body', () => {
    const s = fixture('show-rule-counter-suffix')
    for (const [k, line] of [[0, 3], [1, 7]]) {
      const i = s.nth(/\(Teil\)$/, k)
      const t = s.runs[i].text
      expect(s.click(i, 0)).toBe('main.typ:2:44')
      expect(s.click(i, t.indexOf(' ') + 1)).toBe(`main.typ:${line}:3`)
      expect(s.click(i, t.indexOf('(') + 1)).toBe('main.typ:2:82')
      expect(s.caret('main.typ', line, 4)).toBe(i)
    }
    const p = fixture('show-rule-counter-prefix')
    for (const [k, line] of [[0, 3], [1, 7]]) {
      const i = p.nth(/^Kapitel/, k)
      expect(p.click(i, 0)).toBe('main.typ:2:23')
      expect(p.click(i, 'Kapitel '.length)).toBe('main.typ:2:31')
      expect(p.click(i, 'Kapitel 1: '.length)).toBe(`main.typ:${line}:3`)
      expect(p.caret('main.typ', line, 4)).toBe(i)
    }
  })

  test('only the .at method reads a key: a function named at prints its argument', () => {
    const a = fixture('key-method')
    const first = a.nth('Treffpunkt: Bahnhof')
    expect(a.click(first, 'Treffpunkt: '.length)).toBe('main.typ:5:6')
    expect(a.click(a.nth(/^Danach/), 'Danach Treffpunkt: '.length)).toBe('main.typ:7:13')
    expect(a.caret('main.typ', 5, 7)).toBe(first)
  })

  test('a value computed inline lands on the code printing it; a footer copy keeps every word after it', () => {
    const f = fixture('page-footer-words')
    for (const t of ['Sheet 1 of the log', 'Sheet 2 of the log']) {
      const i = f.nth(t)
      expect(f.click(i, 'Sheet '.length), t).toBe('main.typ:1:47')
      for (const [w, col] of [['of', 72], ['the', 75], ['log', 79]]) expect(f.click(i, t.indexOf(` ${w} `.trimEnd()) + 1), `${t} @ ${w}`).toBe(`main.typ:1:${col}`)
    }
    const y = fixture('function-records-yaml')
    expect(y.click(y.nth(/^Totalt/), 'Totalt '.length)).toBe('main.typ:11:8')
  })
})

test.describe('round eight defects', () => {
  test('rules printing text before, after or around the body over generated words: every body character lands on itself', () => {
    // What each form writes in the rule and how the run shows it (a counter
    // shows a number the test does not depend on).
    const forms = {
      prefix: (add) => [`${add}: #it.body`, (b) => `${add}: ${b}`],
      suffix: (add) => [`#it.body (${add})`, (b) => `${b} (${add})`],
      both: (add, tail) => [`${add}: #it.body (${tail})`, (b) => `${add}: ${b} (${tail})`],
      counter: (add) => [`${add} #counter(heading).display(): #it.body`, (b) => `${add} 1: ${b}`],
      counterBoth: (add, tail) => [`${add} #counter(heading).display(): #it.body, ${tail} #counter(heading).display()`, (b) => `${add} 1: ${b}, ${tail} 1`]
    }
    // Each element as the source writes it (`body` on the line returned
    // last) and the runs Typst sets for it, as recorded through the worker.
    const elements = {
      heading: (body, shown, word) => {
        const after = `${word()} ${word().toLowerCase()}.`
        return { lines: [`= ${body}`, '', after], prefix: '= ', runs: [shown(body), after] }
      },
      'figure.caption': (body, shown, word) => {
        const head = word()
        const line = '#figure(rect(width: 1cm, height: 5mm), caption: ['
        return { lines: [`= ${head}`, '', `${line}${body}])`], prefix: line, runs: [head, shown(body)] }
      },
      quote: (body, shown, word) => {
        const head = word()
        return { lines: [`= ${head}`, '', `#quote[${body}]`], prefix: '#quote[', runs: [head, shown(body)] }
      },
      strong: (body, shown, word) => {
        const head = word()
        const lead = `${word()} ${word().toLowerCase()} `
        const tail = ` ${word().toLowerCase()}.`
        return { lines: [`= ${head}`, '', `${lead}*${body}*${tail}`], prefix: `${lead}*`, runs: [head, lead, shown(body), tail] }
      }
    }
    for (let seed = 1; seed <= 6; seed++) {
      for (const [name, element] of Object.entries(elements)) {
        for (const [form, make] of Object.entries(forms)) {
          const word = wordsFrom(seed * 31 + form.length)
          const add = word()
          const tail = word().toLowerCase()
          const [piece, shown] = make(add, tail)
          const rule = `#show ${name}: it => block[${piece}]`
          const body = [word(), ...Array.from({ length: 1 + (seed % 3) }, () => word().toLowerCase())].join(' ')
          const e = element(body, shown, word)
          const lines = [rule, ...e.lines]
          const runs = e.runs.map((t) => ({ t, page: 0 }))
          const a = align([{ path: 'main.typ', content: lines.join('\n') + '\n' }], 'main.typ', runs)
          const i = runs.findIndex((r) => r.t === shown(body))
          const line = lines.findIndex((l) => l.startsWith(e.prefix) && l.includes(body)) + 1
          const label = `seed ${seed} ${name} ${form} ${runs[i].t}`
          // Every character of every body word, the first and the later ones.
          const from = runs[i].t.indexOf(body)
          for (const m of body.matchAll(/\p{L}+/gu)) {
            for (let k = 0; k < m[0].length; k++) {
              expect(a.click(i, from + m.index + k), `${label} @ ${m[0]}+${k}`).toBe(`main.typ:${line}:${e.prefix.length + m.index + k + 1}`)
            }
          }
          // The rule's own words land on the rule.
          expect(a.click(i, runs[i].t.indexOf(add)), label).toBe(`main.typ:1:${rule.indexOf(add) + 1}`)
          if (piece.includes(tail)) expect(a.click(i, runs[i].t.lastIndexOf(tail)), label).toBe(`main.typ:1:${rule.lastIndexOf(tail) + 1}`)
        }
      }
    }
  })

  test('a heading written by a function as markup keeps the rule split on every call', () => {
    const lines = ['#show heading: it => block[#it.body (Part)]', '#let chapter(t) = [= #t]', '#chapter[Intro]', '', 'Body one.', '', '#chapter[Middle]', '', 'Body two.', '', '#chapter[Outro]', '', 'Body three.']
    const runs = ['Intro (Part)', 'Body one.', 'Middle (Part)', 'Body two.', 'Outro (Part)', 'Body three.'].map((t) => ({ t, page: 0 }))
    const a = align([{ path: 'main.typ', content: lines.join('\n') + '\n' }], 'main.typ', runs)
    for (const [k, line] of [[0, 3], [2, 7], [4, 11]]) {
      const t = runs[k].t
      expect(a.click(k, 0), t).toBe(`main.typ:${line}:10`)
      expect(a.click(k, t.indexOf('Part')), t).toBe('main.typ:1:38')
    }
  })

  test('a one-line definition printed by two calls: its text after the argument stays in the definition for both', () => {
    const lines = ['#let gruss(n) = [Hallo #n, willkommen!]', '#let wer = "Mia"', '= Gäste', '', '#gruss(wer)', '', '#gruss("Tom")', '', 'Hallo zusammen.']
    const runs = ['Gäste', 'Hallo Mia, willkommen!', 'Hallo Tom, willkommen!', 'Hallo zusammen.'].map((t) => ({ t, page: 0 }))
    const a = align([{ path: 'main.typ', content: lines.join('\n') + '\n' }], 'main.typ', runs)
    for (const i of [1, 2]) {
      const t = runs[i].t
      expect(a.click(i, 0), t).toBe('main.typ:1:18')
      expect(a.click(i, t.indexOf('willkommen')), t).toBe('main.typ:1:28')
    }
    expect(a.click(2, runs[2].t.indexOf('Tom'))).toBe('main.typ:7:9')
    expect(a.click(3, 0)).toBe('main.typ:9:1')
  })

  test('a value printed right after literal text and a mark lands on the code printing it', () => {
    const lines = ['#let p = (name: "Eino", city: "Oulu")', '= Henkilö', '', 'Nimi: #p.at("name"), puhelin: #p.at("phone", default: "tuntematon").', '', 'Kaupunki #p.at("city") on pohjoisessa.']
    const runs = ['Henkilö', 'Nimi: Eino, puhelin: tuntematon.', 'Kaupunki Oulu on pohjoisessa.'].map((t) => ({ t, page: 0 }))
    const a = align([{ path: 'main.typ', content: lines.join('\n') + '\n' }], 'main.typ', runs)
    expect(a.click(1, 0)).toBe('main.typ:4:1')
    expect(a.click(1, 'Nimi: '.length)).toBe('main.typ:4:7')
    expect(a.click(1, 'Nimi: Eino, '.length)).toBe('main.typ:4:22')
    expect(a.click(2, 'Kaupunki '.length)).toBe('main.typ:6:10')
  })
})

// Distinct words from `wordsFrom`: none repeats another, ignoring case.
function distinctWords(seed) {
  const next = wordsFrom(seed)
  const seen = new Set()
  return () => {
    for (;;) {
      const w = next()
      if (!seen.has(w.toLowerCase())) {
        seen.add(w.toLowerCase())
        return w
      }
    }
  }
}

// Where whole word `w` starts in `text`.
function wordIndex(text, w) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, 'u').exec(text).index
}

test.describe('round nine defects', () => {
  test('a running header or footer mixing literal words with a value, over generated words: the words land on the page rule, the value where it comes from, on every page', () => {
    for (let seed = 1; seed <= 4; seed++) {
      for (const key of ['header', 'footer']) {
        for (const shape of ['template', 'template printing the title', 'let', 'function']) {
          for (let count = 1; count <= 3; count++) {
            const word = distinctWords(seed * 37 + count * 5 + key.length + shape.length)
            const lit = [word(), word().toLowerCase()]
            const value = [word(), word().toLowerCase(), word().toLowerCase()]
            const shown = `${lit.join(' ')} · ${value.join(' ')}`
            const head = word()
            const paras = Array.from({ length: count }, () => `${word()} ${word().toLowerCase()} ${word().toLowerCase()}.`)
            const body = [`= ${head}`, '', ...paras.flatMap((p, k) => (k ? ['#pagebreak()', '', p, ''] : [p, '']))]
            const content = `[${lit.join(' ')} · #title]`
            let main
            let tpl = null
            let litFile = 'main.typ'
            if (shape.startsWith('template')) {
              tpl = ['#let report(title: "Untitled", body) = {', `  set page(height: 6cm, ${key}: ${content})`]
              if (shape === 'template printing the title') tpl.push('  align(center, strong(title))')
              tpl.push('  body', '}')
              main = ['#import "tpl/report.typ": report', `#show: report.with(title: "${value.join(' ')}")`, '', ...body]
              litFile = 'tpl/report.typ'
            } else if (shape === 'let') {
              main = [`#let title = "${value.join(' ')}"`, `#set page(height: 6cm, ${key}: ${content})`, ...body]
            } else {
              main = [`#let title = "${value.join(' ')}"`, `#let mark() = ${content}`, `#set page(height: 6cm, ${key}: mark())`, ...body]
            }
            // The runs as Typst sets them: a header before each page's
            // flow, a footer after it.
            const runs = []
            paras.forEach((p, k) => {
              if (key === 'header') runs.push({ t: shown, page: k })
              if (!k && shape === 'template printing the title') runs.push({ t: value.join(' '), page: 0 })
              if (!k) runs.push({ t: head, page: 0 })
              runs.push({ t: p, page: k })
              if (key === 'footer') runs.push({ t: shown, page: k })
            })
            const files = [{ path: 'main.typ', content: main.join('\n') + '\n' }]
            if (tpl) files.push({ path: 'tpl/report.typ', content: tpl.join('\n') + '\n' })
            const a = align(files, 'main.typ', runs)
            const label = `seed ${seed} ${key} ${shape} ${count} pages`
            const marks = runs.map((r, i) => i).filter((i) => runs[i].t === shown)
            expect(marks, label).toHaveLength(count)
            for (const i of marks) {
              for (const w of lit) expect(a.click(i, wordIndex(shown, w)), `${label} run ${i} @ ${w}`).toBe(wordAt(litFile, tpl || main, w))
              for (const w of value) expect(a.click(i, wordIndex(shown, w)), `${label} run ${i} @ ${w}`).toBe(wordAt('main.typ', main, w))
            }
            for (const p of paras) {
              const w = p.split(' ')[0]
              expect(a.click(runs.findIndex((r) => r.t === p), 0), `${label} @ ${w}`).toBe(wordAt('main.typ', main, w))
            }
            // A caret on the rule's literal finds a copy of the header.
            const [, line, col] = wordAt(litFile, tpl || main, lit[0]).split(':')
            expect(runs[a.caret(litFile, Number(line), Number(col) + 1)].t, label).toBe(shown)
          }
        }
      }
    }
  })

  test('text a function prints after its argument, called inline in a paragraph, over generated words: it lands on the definition for every call', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const word = distinctWords(seed * 53)
      const unit = word().toLowerCase()
      const [w1, w2, w3, w4, w5] = [word(), word().toLowerCase(), word().toLowerCase(), word().toLowerCase(), word().toLowerCase()]
      const [v1, v2] = [word(), word()]
      const lines = [`#let tag(x) = [#x ${unit}]`, `= ${word()}`, '', `${w1} ${w2} #tag("${v1}") ${w3} ${w4} #tag("${v2}") ${w5}.`]
      const para = `${w1} ${w2} ${v1} ${unit} ${w3} ${w4} ${v2} ${unit} ${w5}.`
      const runs = [lines[1].slice(2), para].map((t) => ({ t, page: 0 }))
      const a = align([{ path: 'main.typ', content: lines.join('\n') + '\n' }], 'main.typ', runs)
      const label = `seed ${seed} ${para}`
      const at = (re) => re.exec(para).index
      expect(a.click(1, at(new RegExp(`(?<=${v1} )${unit}`))), label).toBe(`main.typ:1:${lines[0].indexOf(unit) + 1}`)
      expect(a.click(1, at(new RegExp(`(?<=${v2} )${unit}`))), label).toBe(`main.typ:1:${lines[0].indexOf(unit) + 1}`)
      for (const w of [w1, w3, w5]) expect(a.click(1, wordIndex(para, w)), `${label} @ ${w}`).toBe(wordAt('main.typ', lines, w))
      for (const v of [v1, v2]) expect(a.click(1, wordIndex(para, v)), `${label} @ ${v}`).toBe(wordAt('main.typ', lines, v))
    }
  })

  test('a value inside quotation marks after literal text lands on the code printing it, whatever the quotes', () => {
    for (const [open, close] of [['„', '“'], ['«', '»'], ['“', '”'], ['‚', '‘'], ['「', '」']]) {
      const lines = ['#let p = (a: "Rot", b: "Blau")', '= Farben', '', `Farbe (#p.at("a")) und ${open}#p.b${close} sowie mehr.`]
      const para = `Farbe (Rot) und ${open}Blau${close} sowie mehr.`
      const runs = ['Farben', para].map((t) => ({ t, page: 0 }))
      const a = align([{ path: 'main.typ', content: lines.join('\n') + '\n' }], 'main.typ', runs)
      expect(a.click(1, para.indexOf('Blau')), open).toBe(`main.typ:4:${lines[3].indexOf('#p.b') + 1}`)
      expect(a.click(1, para.indexOf('Rot')), open).toBe(`main.typ:4:${lines[3].indexOf('#p.at') + 1}`)
      expect(a.click(1, para.indexOf('sowie')), open).toBe(`main.typ:4:${lines[3].indexOf('sowie') + 1}`)
    }
  })
})
