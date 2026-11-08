import { test, expect } from '@playwright/test'
import sync from './preview_sync_module.mjs'

// The virtual document (#18) built from the sources, what each line of a
// stretch between body runs printed, and the arguments a call passes, all
// seen from outside: where runs land, which run a caret finds and how the
// sources are laid out. Documents are written inline.

const { alignRuns, buildVirtualDoc, locate, offsetOf, runForOffset } = sync

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
    closest: (sel) => (sel === '.typst-page' ? page(r.page || 0) : null)
  }))
  return { querySelectorAll: () => nodes }
}

// Runs as the worker renders them: text, or `null` for a picture.
const rendered = (...ts) => ts.map((t) => (t === null ? { image: true } : { t }))

function align(files, entry = 'main.typ', recorded = [], entryPath = entry) {
  const main = files.find((f) => f.path === entry)
  const doc = buildVirtualDoc(entry, main.content, files.filter((f) => f !== main), entryPath)
  const runs = alignRuns(container(recorded), doc)
  const where = (offset) => {
    const l = locate(doc, offset)
    return `${l.file}:${l.line}:${l.col}`
  }
  return {
    doc,
    runs,
    at: (i) => where(runs[i].start),
    // The run a caret resting at file:line:col finds.
    caret: (file, line, col = 1) => runs.indexOf(runForOffset(runs, offsetOf(doc, file, line, col), doc))
  }
}

const layout = (doc) => doc.lines.map((l) => `${l.file}:${l.line}`)
// The files after the primary text, in their order.
const appendix = (doc) => [...new Set(doc.lines.slice(doc.primaryLines).map((l) => l.file))]

test.describe('virtual document: sources and includes (#18)', () => {
  test('a source without a path is skipped, one without content is empty', () => {
    const doc = buildVirtualDoc('main.typ', 'Body.\n', [null, { path: 5, content: 'x' }, { path: 'a.csv', content: null }, { path: 'b.csv', content: 'v\n' }])
    expect(layout(doc)).toEqual(['main.typ:1', 'main.typ:2', 'a.csv:1', 'b.csv:1', 'b.csv:2'])
  })

  test('a buffer without a path is main.typ', () => {
    const doc = buildVirtualDoc('', 'Body.\n', [])
    expect(layout(doc)).toEqual(['main.typ:1', 'main.typ:2'])
    expect(locate(doc, offsetOf(doc, 'main.typ', 1, 3))).toEqual({ file: 'main.typ', line: 1, col: 3 })
  })

  test('an entry missing from the sources leaves the buffer the body: generated text keeps its line', () => {
    const a = align([{ path: 'main.typ', content: '= Head\n#lorem(5)\nEnd words.\n' }], 'main.typ', rendered('Head', 'Lorem ipsum dolor sit amet.', 'End words.'), 'missing.typ')
    expect(a.doc.primaryLines).toBe(4)
    expect(a.at(1)).toBe('main.typ:2:1')
    expect(a.caret('main.typ', 2, 3)).toBe(1)
  })

  test('an include opening a code line, or on a last line without a newline, splices after its own line', () => {
    const doc = buildVirtualDoc('main.typ', 'Top line.\n#{\ninclude "a.typ"\n}\nmid\n#include "b.typ"\nx\n#include "d.typ"', [
      { path: 'a.typ', content: 'A text.\n' },
      { path: 'b.typ', content: 'B text.\n#include "c.typ"' },
      { path: 'c.typ', content: 'C text.' },
      { path: 'd.typ', content: 'D text.' }
    ])
    expect(layout(doc)).toEqual([
      'main.typ:1', 'main.typ:2', 'main.typ:3', 'a.typ:1', 'a.typ:2', 'main.typ:4', 'main.typ:5',
      'main.typ:6', 'b.typ:1', 'b.typ:2', 'c.typ:1', 'main.typ:7', 'main.typ:8', 'd.typ:1'
    ])
  })

  test('a file only the appendix reaches nests its includes as deep as the body does', () => {
    const chain = Array.from({ length: 10 }, (_, k) => ({ path: `lib${k}.typ`, content: `L${k}\n#include "lib${k + 1}.typ"\n` }))
    const doc = buildVirtualDoc('main.typ', 'Body.\n', chain)
    const lines = layout(doc)
    // lib0 at depth 0 takes lib1 .. lib8 inside it; lib9 is past the limit.
    expect(lines.indexOf('lib8.typ:1')).toBeLessThan(lines.indexOf('lib7.typ:3'))
    expect(appendix(doc)).toEqual(['lib0.typ', 'lib1.typ', 'lib2.typ', 'lib3.typ', 'lib4.typ', 'lib5.typ', 'lib6.typ', 'lib7.typ', 'lib8.typ', 'lib9.typ'])
    expect(lines.indexOf('lib9.typ:1')).toBeGreaterThan(lines.indexOf('lib0.typ:3'))
  })
})

test.describe('virtual document: the order of the other files', () => {
  test('files come in the order the body first names them, the rest by path, cycles last', () => {
    const files = [
      { path: 'zeta.csv', content: 'z1\n' },
      { path: 'alpha.csv', content: 'a1\n' },
      { path: 'mid.csv', content: 'm1\n' },
      { path: 'p.typ', content: 'P\n' },
      { path: 'q.typ', content: 'Q\n' },
      { path: 'unnamed2.csv', content: 'u2\n' },
      { path: 'unnamed1.csv', content: 'u1\n' },
      { path: 'cyc1.typ', content: 'c1\n#include "cyc2.typ"\n' },
      { path: 'cyc2.typ', content: 'c2\n#include "cyc1.typ"\n' }
    ]
    const main = '#let a = csv("zeta.csv")\n#let b = csv("alpha.csv") + csv("mid.csv")\n#let c = json("alpha.csv")\n#for f in ("q.typ", "p.typ") { include f }\n'
    for (const sources of [files, [...files].reverse()]) {
      const doc = buildVirtualDoc('main.typ', main, sources)
      expect(appendix(doc)).toEqual(['zeta.csv', 'alpha.csv', 'mid.csv', 'q.typ', 'p.typ', 'unnamed1.csv', 'unnamed2.csv', 'cyc1.typ', 'cyc2.typ'])
    }
  })

  test('on one line the first naming counts, wherever the file is named again', () => {
    const doc = buildVirtualDoc('main.typ', '#csv("x.csv") #csv("y.csv") #csv("x.csv")\n', [{ path: 'y.csv', content: 'y\n' }, { path: 'x.csv', content: 'x\n' }])
    expect(appendix(doc)).toEqual(['x.csv', 'y.csv'])
  })

  test('the earliest line naming a file counts, whichever source names it first in the list', () => {
    const ch = { path: 'ch.typ', content: '#csv("y.csv")\n#csv("x.csv")\n' }
    const data = [{ path: 'x.csv', content: 'x\n' }, { path: 'y.csv', content: 'y\n' }]
    const doc = buildVirtualDoc('main.typ', '#csv("x.csv")\n#csv("y.csv")\n#include "ch.typ"\n', [ch, ...data])
    expect(appendix(doc)).toEqual(['x.csv', 'y.csv'])
    // Editing the chapter of a book: a later line naming a file early in
    // its own text does not move the file ahead.
    const book = { path: 'book.typ', content: 'Padding words on the first line.\n#csv("x.csv")\n#csv("y.csv")\n#include "ch.typ"\n' }
    const edited = buildVirtualDoc('ch.typ', '#csv("x.csv")\n', [book, ...data], 'book.typ')
    expect(appendix(edited)).toEqual(['x.csv', 'y.csv'])
  })
})

test.describe('virtual document: what the sources hold', () => {
  test('list markers of a loop over data: at their line start, on a last line, in a one-line chapter', () => {
    const data = { path: 'a.csv', content: 'Kestrel\nHeron\n' }
    const runs = rendered('Birds', '•', 'Kestrel', '•', 'Heron', 'End words.')
    const loop = align([{ path: 'main.typ', content: '= Birds\n#for r in csv("a.csv") [\n- #r.at(0)\n]\nEnd words.\n' }, data], 'main.typ', runs)
    expect([1, 3].map(loop.at)).toEqual(['main.typ:3:1', 'main.typ:3:1'])
    // The loop's head finds the first value it printed.
    expect(loop.caret('main.typ', 2)).toBe(2)
    const last = align([{ path: 'main.typ', content: '= Birds\n#include "list.typ"\nEnd words.\n' }, { path: 'list.typ', content: '#for r in csv("a.csv") [\n- #r.at(0) ]' }, data], 'main.typ', runs)
    expect([1, 3].map(last.at)).toEqual(['list.typ:2:1', 'list.typ:2:1'])
    expect(last.caret('list.typ', 2, 1)).toBe(1)
    expect(last.caret('list.typ', 1)).toBe(2)
    const one = align([{ path: 'main.typ', content: '= Fruits\n#include "l.typ"\nAfter words.\n' }, { path: 'l.typ', content: '- Cherry tart' }], 'main.typ', rendered('Fruits', '•', 'Cherry tart', 'After words.'))
    expect([1, 2].map(one.at)).toEqual(['l.typ:1:1', 'l.typ:1:3'])
  })

  test('a list marker in a chapter goes to the chapter when the body has one after the include', () => {
    const a = align([
      { path: 'main.typ', content: '= Birds\n#include "ch.typ"\n#lorem(2)\n#for r in csv("a.csv") [\n- #r.at(0)\n]\nEnd words.\n' },
      { path: 'ch.typ', content: '#lorem(3)\n#for r in csv("c.csv") [\n- #r.at(0)\n]\n' },
      { path: 'a.csv', content: 'Kestrel\n' },
      { path: 'c.csv', content: 'Osprey\n' }
    ], 'main.typ', rendered('Birds', 'Lorem ipsum dolor.', '•', 'Osprey', 'Lorem ipsum.', '•', 'Kestrel', 'End words.'))
    expect(a.at(2)).toBe('ch.typ:3:1')
    expect(a.at(3)).toBe('c.csv:1:1')
  })

  test('a picture goes to the call showing it, through definitions in any order', () => {
    const lines = ['#let mark(x) = metadata(x)', '#let frame(p) = photo(p)', '#let photo(p) = image(p)', '= Pictures', '#mark("start")', '#frame("a.png")', 'Closing words.']
    const a = align([{ path: 'main.typ', content: lines.join('\n') + '\n' }], 'main.typ', rendered('Pictures', null, 'Closing words.'))
    expect(a.at(1)).toBe('main.typ:6:1')
    expect(a.caret('main.typ', 6, 3)).toBe(1)
  })

  test('a picture no call shows goes to the first call that renders, not a spacing call or a binding', () => {
    const a = align([{ path: 'main.typ', content: '= Charts\n#v(1em)\n#let size = measure(box())\n#plot("data")\nClosing words.\n' }], 'main.typ', rendered('Charts', null, 'Closing words.'))
    expect(a.at(1)).toBe('main.typ:4:1')
  })

  test('pictures of a chapter and of the body after it each go to their own call', () => {
    const a = align([
      { path: 'main.typ', content: '= Charts\n#include "ch.typ"\n#image("b.png")\nEnd words.\n' },
      { path: 'ch.typ', content: 'Chapter words.\n#image("a.png")\n' }
    ], 'main.typ', rendered('Charts', 'Chapter words.', null, null, 'End words.'))
    expect([2, 3].map(a.at)).toEqual(['ch.typ:2:1', 'main.typ:3:1'])
    expect(a.caret('main.typ', 3, 3)).toBe(3)
  })

  test('repeated footnote texts in a chapter and the body pair with their own calls', () => {
    const a = align([
      { path: 'main.typ', content: 'Alpha one.#footnote[Ibid.]\n#include "ch.typ"\nGamma three.#footnote[Closing note here.]\n' },
      { path: 'ch.typ', content: 'Beta two.#footnote[Ibid.]\n' }
    ], 'main.typ', rendered('Alpha one.', '1', 'Beta two.', '2', 'Gamma three.', '3', '1', 'Ibid.', '2', 'Ibid.', '3', 'Closing note here.'))
    expect([7, 9, 11].map(a.at)).toEqual(['main.typ:1:21', 'ch.typ:1:20', 'main.typ:3:23'])
    expect(a.caret('ch.typ', 1, 21)).toBe(9)
  })

  test('a line of spacing calls renders nothing: a page number goes to the line displaying it', () => {
    const a = align([{ path: 'main.typ', content: 'First words.\n#v(1em) #h(1em)\n#counter(page).display()\nSecond words.\n' }], 'main.typ', rendered('First words.', '1', 'Second words.'))
    expect(a.at(1)).toBe('main.typ:3:1')
  })

  test('a line of a lone punctuation mark renders: generated text between body lines goes there', () => {
    const a = align([{ path: 'main.typ', content: 'Head words.\n!\nTail words.\n' }], 'main.typ', rendered('Head words.', 'Generated text here.', 'Tail words.'))
    expect(a.at(1)).toBe('main.typ:2:1')
  })
})

// What a caret finds on each line `from`..`to` of main.typ (run indices).
const carets = (a, from, to) => Array.from({ length: to - from + 1 }, (_, k) => a.caret('main.typ', from + k))
const kestrel = { path: 'a.csv', content: 'Kestrel,Hover\n' }
const heron = { path: 'b.csv', content: 'Heron,Wade\n' }
const main = (lines) => ({ path: 'main.typ', content: lines.join('\n') + '\n' })

test.describe('lines between body runs: a caret finds what its line printed', () => {
  test('values of a file named above other output keep reading order', () => {
    const lines = ['= Birds', '#let a = csv("a.csv")', '#let b = csv("b.csv")', '#table(..a.flatten())', '#lorem(3)', '#table(..b.flatten())', 'End words here.']
    const a = align([main(lines), kestrel, heron], 'main.typ', rendered('Birds', 'Kestrel', 'Hover', 'Lorem ipsum dolor.', 'Heron', 'Wade', 'End words here.'))
    expect(a.at(3)).toBe('main.typ:5:1')
    // The lets and the first table: Kestrel; the generated text; b's table
    // (b is named before the generated text, so its values follow it).
    expect(carets(a, 2, 6)).toEqual([1, 1, 1, 3, 4])
  })

  test('a file named again after generated text: each print finds its own values', () => {
    const lines = ['#let a = csv("a.csv")', '= Birds', '#table(..a.flatten())', '#lorem(3)', '#let b = csv("a.csv")', '#b.flatten().join(" and ")', 'End words.']
    const a = align([main(lines), kestrel], 'main.typ', rendered('Birds', 'Kestrel', 'Hover', 'Lorem ipsum dolor.', 'Kestrel and Hover', 'End words.'))
    expect(carets(a, 3, 6)).toEqual([1, 3, 3, 4])
  })

  test('two files each printed below its let, then a picture', () => {
    const lines = ['= Birds', '#let a = csv("a.csv")', '#table(..a.flatten())', '#let b = csv("b.csv")', '#table(..b.flatten())', '#image("x.png")', 'End words.']
    const a = align([main(lines), kestrel, heron], 'main.typ', rendered('Birds', 'Kestrel', 'Hover', 'Heron', 'Wade', null, 'End words.'))
    expect(a.at(5)).toBe('main.typ:6:1')
    expect(carets(a, 2, 6)).toEqual([1, 1, 3, 3, 5])
  })

  test('a picture or generated text between a let and the table it feeds', () => {
    const picture = align([main(['= Birds', '#let a = csv("a.csv")', '#let b = csv("b.csv")', '#image("x.png")', '#table(..a.flatten(), ..b.flatten())', 'End words.']), kestrel, heron], 'main.typ', rendered('Birds', null, 'Kestrel', 'Hover', 'Heron', 'Wade', 'End words.'))
    expect(carets(picture, 2, 5)).toEqual([1, 1, 1, 2])
    const generated = align([main(['= Birds', '#let a = csv("a.csv")', '#lorem(3)', '#table(..a.flatten())', '#image("x.png")', 'End words.']), kestrel], 'main.typ', rendered('Birds', 'Lorem ipsum dolor.', 'Kestrel', 'Hover', null, 'End words.'))
    expect(generated.at(1)).toBe('main.typ:3:1')
    expect(carets(generated, 2, 5)).toEqual([1, 1, 2, 4])
  })

  test('blank lines go with the output above them, to the end of the body', () => {
    const top = align([main(['#let a = csv("a.csv")', '#table(..a.flatten())', '', '#lorem(3)', '', '= End']), kestrel], 'main.typ', rendered('Kestrel', 'Hover', 'Lorem ipsum dolor.', 'End'))
    expect(carets(top, 1, 5)).toEqual([0, 0, 0, 2, 2])
    const end = align([main(['= Start', '#image("a.png")', '', '#lorem(3)', '', '#let a = csv("a.csv")', '#a.flatten().join(", ")', '', '']), kestrel], 'main.typ', rendered('Start', null, 'Lorem ipsum dolor.', 'Kestrel, Hover'))
    expect(carets(end, 2, 10)).toEqual([1, 1, 2, 2, 3, 3, 3, 3, 3])
    const pictures = align([main(['= Birds', '#image("x.png")', '', '#image("y.png")', '', '#image("z.png")', 'End words.'])], 'main.typ', rendered('Birds', null, null, null, 'End words.'))
    expect(carets(pictures, 2, 6)).toEqual([1, 1, 2, 2, 3])
  })

  test('values printed before the first body run: the lines naming and printing each file find it', () => {
    const lines = ['#let a = csv("a.csv")', '#let b = csv("b.csv")', '#table(..a.flatten())', '#image("x.png")', '#table(..b.flatten())', '= End']
    const a = align([main(lines), kestrel, heron], 'main.typ', rendered('Kestrel', 'Hover', null, 'Heron', 'Wade', 'End'))
    expect(carets(a, 1, 5)).toEqual([0, 0, 0, 2, 3])
  })

  test('a line between generated text and a line printing a file it names goes with the generated text', () => {
    const blank = align([main(['= Start', '#lorem(3)', '', '#table(..csv("a.csv").flatten())', 'End words.']), kestrel], 'main.typ', rendered('Start', 'Lorem ipsum dolor.', 'Kestrel', 'Hover', 'End words.'))
    expect(carets(blank, 2, 4)).toEqual([1, 1, 2])
    // The line printing the file also shows a picture after its values.
    const shared = align([main(['= Birds', '#lorem(3)', '#let x = 1', '#table(..csv("a.csv").flatten()) #image("x.png")', 'End words.']), kestrel], 'main.typ', rendered('Birds', 'Lorem ipsum dolor.', 'Kestrel', 'Hover', null, 'End words.'))
    expect(carets(shared, 2, 3)).toEqual([1, 1])
  })

  test('a file named again on the next body line keeps its values on the lines printing them', () => {
    const lines = ['#let rows = csv("a.csv")', '= Birds', '#lorem(3)', '', '#rows.flatten().join(", ")', 'There are #csv("a.csv").len() rows.']
    const a = align([main(lines), kestrel], 'main.typ', rendered('Birds', 'Lorem ipsum dolor.', 'Kestrel, Hover', 'There are 1 rows.'))
    expect(carets(a, 3, 5)).toEqual([1, 2, 2])
  })

  test('a line printing a file named above and one it names finds the first value it printed', () => {
    const lines = ['#let rows = csv("b.csv")', '= Birds', '#table(..rows.flatten(), ..csv("a.csv").flatten())', '', 'End words.']
    const a = align([main(lines), kestrel, heron], 'main.typ', rendered('Birds', 'Heron', 'Wade', 'Kestrel', 'Hover', 'End words.'))
    // The blank line after it is in the reach of the file the line names.
    expect(carets(a, 3, 4)).toEqual([1, 3])
  })

  test('the same line after generated text still finds the first value it printed, from the file named above', () => {
    const lines = ['#let rows = csv("b.csv")', '= Birds', '#lorem(3)', '#table(..rows.flatten(), ..csv("a.csv").flatten())', 'End words.']
    const a = align([main(lines), kestrel, heron], 'main.typ', rendered('Birds', 'Lorem ipsum dolor.', 'Heron', 'Wade', 'Kestrel', 'Hover', 'End words.'))
    expect(carets(a, 3, 4)).toEqual([1, 2])
  })

  test('a file printed again after another: the lines printing it find its values', () => {
    const lines = ['= Birds', '#table(..csv("a.csv").flatten())', '#table(..csv("b.csv").flatten())', '#table(..csv("a.csv").flatten())', 'End words here.']
    const a = align([main(lines), kestrel, heron], 'main.typ', rendered('Birds', 'Kestrel', 'Hover', 'Heron', 'Wade', 'Kestrel', 'Hover', 'End words here.'))
    expect(carets(a, 3, 4)).toEqual([3, 5])
  })
})

test.describe('a caret on a parameter in a definition finds what the call passed', () => {
  // Line 2 names the title, line 3 the body.
  const note = ['#let note(title, body) = block[', '  #strong(title):', '  #body', ']', '= Notes']
  const passed = (call, title, body) => {
    const a = align([main([...note, call, 'Closing words.'])], 'main.typ', rendered('Notes', title, ':', body, 'Closing words.'))
    return carets(a, 2, 3)
  }

  test('content blocks after the name, after empty parentheses, after a string', () => {
    expect(passed('#note[Heron][Herons wade in shallow water.]', 'Heron', 'Herons wade in shallow water.')).toEqual([1, 3])
    expect(passed('#note[H][W]', 'H', 'W')).toEqual([1, 3])
    expect(passed('#note()[Heron][Herons wade in shallow water.]', 'Heron', 'Herons wade in shallow water.')).toEqual([1, 3])
    expect(passed('#note("Heron")[Herons wade in shallow water.]', 'Heron', 'Herons wade in shallow water.')).toEqual([1, 3])
    expect(passed('#note("Heron",)[Herons wade in shallow water.]', 'Heron', 'Herons wade in shallow water.')).toEqual([1, 3])
  })

  test('content blocks opening with a space or a line break', () => {
    expect(passed('#note[ Heron][ Herons wade in shallow water.]', 'Heron', 'Herons wade in shallow water.')).toEqual([1, 3])
    expect(passed('#note[\n  Heron\n][\n  Herons wade in shallow water.\n]', 'Heron', 'Herons wade in shallow water.')).toEqual([1, 3])
    expect(passed('#note([\n  Heron\n], [\n  Herons wade in shallow water.\n])', 'Heron', 'Herons wade in shallow water.')).toEqual([1, 3])
  })

  test('a lone double quote in a content block is a plain quote, not a string', () => {
    expect(passed('#note[A 5" screen][Screens glow at night.]', 'A 5” screen', 'Screens glow at night.')).toEqual([1, 3])
    expect(passed('#note([A 5" screen], [Screens glow at night.])', 'A 5” screen', 'Screens glow at night.')).toEqual([1, 3])
  })

  test('a first block holding calls, code and nested brackets still lets the body be found', () => {
    expect(passed('#note[Grey heron #text(size: 9pt)[(Ardea)] and #{ "egret" }][Herons wade in shallow water.]', 'Grey heron (Ardea) and egret', 'Herons wade in shallow water.')[1]).toBe(3)
    expect(passed('#note[Grey heron #emph[(Ardea {cinerea})]][Herons wade in shallow water.]', 'Grey heron (Ardea {cinerea})', 'Herons wade in shallow water.')[1]).toBe(3)
  })

  test('strings holding brackets, commas and escaped quotes do not end an argument', () => {
    expect(passed('#note[Heron #str("a]]b")][Herons wade in shallow water.]', 'Heron a]]b', 'Herons wade in shallow water.')[1]).toBe(3)
    expect(passed('#note[Heron #str("say \\"]\\"")][Herons wade in shallow water.]', 'Heron say "]"', 'Herons wade in shallow water.')[1]).toBe(3)
    expect(passed('#note("Grey \\"heron\\", tall")[Herons wade in shallow water.]', 'Grey "heron", tall', 'Herons wade in shallow water.')).toEqual([1, 3])
  })

  test('arguments in parentheses: content with a comma, a nested call, no spaces', () => {
    expect(passed('#note([Herons, egrets], [Both wade in shallow water.])', 'Herons, egrets', 'Both wade in shallow water.')).toEqual([1, 3])
    // Lines 3 and 4 name the title and the body.
    const card = (params, call, runs) => {
      const lines = [`#let card(${params}) = block[`, '  #date', '  #emph(title)', '  #body', ']', '= Cards', call, 'Closing words.']
      return carets(align([main(lines)], 'main.typ', rendered('Cards', ...runs, 'Closing words.')), 3, 4)
    }
    expect(card('date: none, title: "", body', '#card(date: upper("may"), title: "Cranes")[Cranes fly south.]', ['MAY', 'Cranes', 'Cranes fly south.'])).toEqual([2, 3])
    expect(card('date: none, title: "", body: []', '#card(title:"Cranes",body:[Cranes fly south.])', ['Cranes', 'Cranes fly south.'])).toEqual([1, 2])
  })
})
