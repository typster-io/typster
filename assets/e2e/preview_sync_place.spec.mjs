import { test, expect } from '@playwright/test'
import sync from './preview_sync_module.mjs'

// Placement of the runs no text matched (#149): generated words, pictures
// and marks without letters. Each document is written inline; the runs are
// what Typst would render for it, and the tests check where each run lands,
// where a click on it goes and which run a resting caret finds.

const { alignRuns, buildVirtualDoc, clickSpot, locate, offsetOf, runForOffset } = sync

// The SVG as alignRuns reads it: `.tsel` runs and `<image>` pictures in
// document order, all on one page.
function container(recorded) {
  const page = { page: 0 }
  const nodes = recorded.map((r) => ({
    tagName: r.image ? 'image' : 'span',
    textContent: r.image ? '' : r.t,
    parentElement: { closest: () => null },
    closest: (sel) => (sel === '.typst-page' ? page : null)
  }))
  return { querySelectorAll: () => nodes }
}

const IMG = { image: true, t: '' }

// Aligns runs (strings, or IMG for a picture) with the files, `main` alone
// when given as a string.
function align(files, runs) {
  if (typeof files === 'string') files = [{ path: 'main.typ', content: files }]
  const recorded = runs.map((r) => (typeof r === 'string' ? { t: r } : r))
  const main = files.find((f) => f.path === 'main.typ')
  const doc = buildVirtualDoc('main.typ', main.content, files.filter((f) => f !== main), 'main.typ')
  const out = alignRuns(container(recorded), doc)
  const where = (offset) => {
    const l = locate(doc, offset)
    return `${l.file}:${l.line}:${l.col}`
  }
  return {
    runs: out,
    at: (i) => where(out[i].start),
    placed: (i) => !out[i].anchored,
    // Where a click on character `idx` of run i's text lands.
    click: (i, idx = 0) => where(clickSpot(out[i], recorded[i].t.slice(0, idx))),
    // The run a caret resting at file:line:col finds.
    caret: (file, line, col = 1) => out.indexOf(runForOffset(out, offsetOf(doc, file, line, col), doc))
  }
}

const lines = (...ls) => ls.join('\n') + '\n'

test.describe('generated words', () => {
  test('a generated paragraph stays on its call, not on a comment or the next text sharing its words', () => {
    const commented = align(lines('Kestrels hunt. // lorem ipsum dolor', '#lorem(3)', 'Herons wait.'), ['Kestrels hunt.', 'Lorem ipsum dolor.', 'Herons wait.'])
    expect(commented.placed(1)).toBe(true)
    expect(commented.at(1)).toBe('main.typ:2:1')
    // Nor on the line of the next text, indented after the gap's end.
    const indented = align(lines('Kestrels hunt.', '#lorem(3)', '  Lorem ipsum wait.'), ['Kestrels hunt.', 'Lorem ipsum dolor.', 'Lorem ipsum wait.'])
    expect(indented.at(1)).toBe('main.typ:2:1')
    expect(indented.at(2)).toBe('main.typ:3:3')
    const echoed = align(lines('Kestrels hunt.', '#lorem(3)', 'Lorem ipsum wait.'), ['Kestrels hunt.', 'Lorem ipsum dolor.', 'Lorem ipsum wait.'])
    expect(echoed.at(1)).toBe('main.typ:2:1')
    expect(echoed.at(2)).toBe('main.typ:3:1')
  })

  test('a generated paragraph on the last line of a file without a final newline lands there', () => {
    const a = align('Kestrels hunt.\n#lorem(3)', ['Kestrels hunt.', 'Lorem ipsum dolor.'])
    expect(a.at(1)).toBe('main.typ:2:1')
    // A click on a run placed on a line goes to the line's end.
    expect(a.click(1, 3)).toBe('main.typ:2:10')
  })

  test('a generated paragraph on the first line keeps it, even with a call before the next text', () => {
    const a = align(lines('#lorem(3)', '  #greet() rules here.'), ['Lorem ipsum dolor.', 'rules here.'])
    expect(a.at(0)).toBe('main.typ:1:1')
    expect(a.at(1)).toBe('main.typ:2:12')
  })

  test('words with nothing in common land on the only line of their gap that renders', () => {
    const a = align(lines('Kestrels hunt.', '#greet()', 'Herons wait.'), ['Kestrels hunt.', 'Hello there', 'Herons wait.'])
    expect(a.at(1)).toBe('main.typ:2:1')
    // The run spans the line: a click on it opens the line's end.
    expect(a.click(1, 2)).toBe('main.typ:2:9')
  })

  test('a word of one character is enough to pick its line', () => {
    const a = align(lines('Kestrels hunt.', '#rule()', '#tally(7)', 'Herons wait.'), ['Kestrels hunt.', 'Total 7', 'Herons wait.'])
    expect(a.at(1)).toBe('main.typ:3:1')
  })

  test('a word run in a later gap does not join the line an earlier gap claimed', () => {
    const a = align(lines('Kestrels hunt.', '#lorem(3)', 'Herons wait.', '#greet()', 'Owls sleep.'), [
      'Kestrels hunt.', 'Lorem ipsum dolor.', 'Herons wait.', 'Hello there', 'Owls sleep.'
    ])
    expect(a.at(1)).toBe('main.typ:2:1')
    expect(a.at(3)).toBe('main.typ:4:1')
  })

  test('the runs after a claimed line stay on it or claim a later line, never an earlier one', () => {
    const a = align(lines('Kestrels hunt.', '#alpha()', '#beta()', 'Herons wait.'), ['Kestrels hunt.', 'Beta words', 'Alpha words', 'Herons wait.'])
    expect(a.at(1)).toBe('main.typ:3:1')
    expect(a.at(2)).toBe('main.typ:3:1')
  })

  test('words printed by a call before the text on its line go to the call', () => {
    // First in the document: the call at its very first character.
    const first = align(lines('#greet() rules here.'), ['Hello', 'rules here.'])
    expect(first.at(0)).toBe('main.typ:1:1')
    expect(first.caret('main.typ', 1, 3)).toBe(0)
    // After a value from a data file: the call on the next text's line.
    const files = [
      { path: 'main.typ', content: lines('= People', '#let d = json("d.json")', '#d.name', '#greet() rules here.') },
      { path: 'd.json', content: lines('{', '  "name": "Ada",', '  "city": "Oslo"', '}') }
    ]
    const a = align(files, ['People', 'Ada', 'Hello', 'rules here.'])
    expect(a.at(1)).toBe('d.json:2:12')
    expect(a.at(2)).toBe('main.typ:4:1')
  })

  test('words between two texts that touch in the source stay between them; the call after them takes the next words', () => {
    const a = align(lines('猫が好き #f()', 'Herons wait.'), ['猫が', 'Zebra', '好き', 'Quokka', 'Herons wait.'])
    expect(a.at(1)).toBe('main.typ:1:3')
    expect(a.at(3)).toBe('main.typ:1:6')
  })
})

test.describe('picture runs', () => {
  test('a picture with no call left after the text before it stays after that text', () => {
    const a = align(lines('#set page(background: image("bg.png"))', 'Kestrels hunt.'), ['Kestrels hunt.', IMG])
    expect(a.at(1)).toBe('main.typ:2:15')
  })

  test('a picture takes a picture call of its own gap, not one after the next text', () => {
    const a = align(lines('Kestrels hunt.', '#pic("a")', 'Herons wait.', '#image("b.png")'), ['Kestrels hunt.', IMG, 'Herons wait.', IMG])
    expect(a.at(1)).toBe('main.typ:2:1')
    expect(a.at(3)).toBe('main.typ:4:1')
  })

  test('pictures from calls the document does not define take the first call of each later line', () => {
    const a = align(lines('Kestrels hunt.', '#pic("a") #note("b")', '#pic("c")', 'Herons wait.'), ['Kestrels hunt.', IMG, IMG, 'Herons wait.'])
    expect(a.at(1)).toBe('main.typ:2:1')
    expect(a.at(2)).toBe('main.typ:3:1')
  })

  test('a picture first in the document takes the call on the first line', () => {
    const a = align(lines('#image("a.png")', 'Kestrels hunt.'), [IMG, 'Kestrels hunt.'])
    expect(a.at(0)).toBe('main.typ:1:1')
  })
})

test.describe('marks without letters', () => {
  test('a line between the texts that shows something unmatched is the mark source; marks after it stay there', () => {
    const a = align(lines('Kestrels hunt.', '#context counter(page).display()', 'Herons wait.'), ['Kestrels hunt.', '1', '7', 'Herons wait.'])
    expect(a.at(1)).toBe('main.typ:2:1')
    expect(a.at(2)).toBe('main.typ:2:1')
  })

  test('a blank line before the line showing the mark is skipped', () => {
    const a = align(lines('Kestrels hunt.', '', '#context counter(page).display()', 'Herons wait.'), ['Kestrels hunt.', '1', 'Herons wait.'])
    expect(a.at(1)).toBe('main.typ:3:1')
  })

  test('a line opening a block shows its body: the marks go to the body line', () => {
    const a = align(lines('Kestrels hunt.', '#for n in range(3) [', '  #n', ']', 'Herons wait.'), ['Kestrels hunt.', '0', '1', '2', 'Herons wait.'])
    for (const i of [1, 2, 3]) expect(a.at(i)).toBe('main.typ:3:1')
  })

  test('a bracketed value a line prints keeps all its marks on that line', () => {
    const a = align(lines('Kestrels hunt.', '#context state("s", (1,)).get()', 'Herons wait.'), ['Kestrels hunt.', '(', '1', ',', ')', 'Herons wait.'])
    for (const i of [1, 2, 3, 4]) expect(a.at(i)).toBe('main.typ:2:1')
  })

  test('a mark shows what is left on the line of the text before it', () => {
    const bang = align(lines('Kestrels fly. !#f()', 'Herons wait.'), ['Kestrels fly.', '1', 'Herons wait.'])
    expect(bang.at(1)).toBe('main.typ:1:15')
    expect(bang.caret('main.typ', 1, 16)).toBe(1)
    expect(bang.caret('main.typ', 1, 17)).toBe(1)
    const ref = align(lines('Kestrels fly @intro', '', '= Intro <intro>'), ['Kestrels fly', '1', 'Intro'])
    expect(ref.at(1)).toBe('main.typ:1:14')
    expect(ref.caret('main.typ', 1, 16)).toBe(1)
  })

  test('a footnote marker goes to its call, the marker under the page to the footnote line', () => {
    const a = align(lines('Kestrels fly.#footnote[Far away.]', '', 'Herons wait.'), ['Kestrels fly.', '1', 'Herons wait.', '1', 'Far away.'])
    expect(a.at(1)).toBe('main.typ:1:14')
    expect(a.at(3)).toBe('main.typ:1:1')
  })

  test('a mark between two values of one record goes to the line of the value after it', () => {
    const files = [
      { path: 'main.typ', content: lines('= People', '', '#let d = json("d.json")', '#d.name #sym.arrow #d.city', '', 'The end here.') },
      { path: 'd.json', content: lines('{', '  "name": "Ada",', '  "city": "Oslo"', '}') }
    ]
    const a = align(files, ['People', 'Ada', '→', 'Oslo', 'The end here.'])
    expect(a.at(1)).toBe('d.json:2:12')
    expect(a.at(2)).toBe('d.json:3:1')
    expect(a.at(3)).toBe('d.json:3:12')
  })
})

test.describe('the scoring budget (#22)', () => {
  // A gap of `lines` source lines holding a `#lorem` call amid other calls,
  // and `runs` generated runs printed into it before the closing text.
  // Scoring words costs runs × lines; up to the budget the runs find the
  // `#lorem` line, past it they take the first line of the gap that renders.
  function gap({ lines: count, runs, fromStart = false }) {
    const head = fromStart ? [''] : ['= Birds', 'Opening sentence about kestrels.']
    const inner = count - (fromStart ? 2 : 1)
    const body = Array.from({ length: inner }, (_, k) => (k === inner >> 1 ? '#lorem(2000)' : `#f${k}()`))
    const tail = [...(fromStart ? [''] : []), 'Closing sentence about herons.', 'The end.']
    const recorded = fromStart ? [] : ['Birds', 'Opening sentence about kestrels.']
    // The closing text belongs to the gap's runs too.
    for (let k = 0; k < runs - 1; k++) recorded.push(`Lorem ipsum dolor sit amet number ${k} consectetur.`)
    recorded.push('Closing sentence about herons.', 'The end.')
    const a = align(lines(...head, ...body, ...tail), recorded)
    return { a, first: fromStart ? 0 : 2, lorem: `main.typ:${head.length + (inner >> 1) + 1}:1`, opening: `main.typ:${head.length + 1}:1` }
  }

  test('a gap exactly at the budget still scores: its runs find the lorem line', () => {
    // From the line of the opening text to the line before the closing one.
    const { a, first, lorem } = gap({ lines: 2000, runs: 1000 })
    expect(a.at(first)).toBe(lorem)
    expect(a.at(first + 998)).toBe(lorem)
  })

  test('a gap one line past the budget takes its first rendering line', () => {
    // From the blank first line to the blank line before the closing text.
    const { a, opening } = gap({ lines: 2001, runs: 1000, fromStart: true })
    expect(a.at(0)).toBe(opening)
    expect(a.at(998)).toBe(opening)
  })
})

test.describe('marks between texts', () => {
  test('a line opening a block counts as one with a comment after its bracket or a division before it', () => {
    for (const loop of ['#for n in range(3) [// numbers', '#if 6/2 > 1 [']) {
      const a = align(lines('Kestrels hunt.', loop, '  #counter(page).display()', ']', 'Herons wait.'), ['Kestrels hunt.', '1', 'Herons wait.'])
      expect(a.at(1), loop).toBe('main.typ:3:1')
    }
  })

  test('a line whose brackets all close shows its output where it stands', () => {
    for (const quiet of ['#context [#counter(page).display()]', '#context {counter(page).display()}']) {
      const a = align(lines('Kestrels hunt.', quiet, 'Herons wait.'), ['Kestrels hunt.', '7', 'Herons wait.'])
      expect(a.at(1), quiet).toBe('main.typ:2:1')
    }
  })

  test('a mark between texts on consecutive lines does not reach a line before them', () => {
    const a = align(lines('#context counter(page).display()', 'Kestrels hunt.', 'Herons wait.'), ['Kestrels hunt.', '7', 'Herons wait.'])
    expect(a.at(1)).toBe('main.typ:2:15')
  })

  test('marks after a quiet line stay there while nothing else is left before the next text', () => {
    const indented = align(lines('Kestrels hunt.', '#context counter(page).display()', '    Herons wait.'), ['Kestrels hunt.', '1', '7', 'Herons wait.'])
    expect(indented.at(2)).toBe('main.typ:2:1')
    const generated = align(lines('Kestrels hunt.', '#context counter(page).display()', '#lorem(3)'), ['Kestrels hunt.', '1', '7', 'Lorem ipsum dolor.'])
    expect(generated.at(2)).toBe('main.typ:2:1')
    expect(generated.at(3)).toBe('main.typ:3:1')
  })

  test('a mark after a quiet line goes to a math line whose symbol shows nothing yet', () => {
    const a = align(lines('Kestrels hunt.', '#context counter(page).display()', '$ sum_(k) x $'), ['Kestrels hunt.', '1', '∑', 'k', 'x'])
    expect(a.at(1)).toBe('main.typ:2:1')
    expect(a.at(2)).toBe('main.typ:3:1')
    // A caret on `sum` finds the symbol.
    expect(a.caret('main.typ', 3, 4)).toBe(2)
  })

  test('marks inside an open bracket stay on the quiet line, the symbol after the close goes on', () => {
    const a = align(lines('Kestrels hunt.', '#context state("s", (1,)).get()', '$ sum_(k) x $'), ['Kestrels hunt.', '(', '1', ',', ')', '∑', 'k', 'x'])
    for (const i of [1, 2, 3, 4]) expect(a.at(i)).toBe('main.typ:2:1')
    expect(a.at(5)).toBe('main.typ:3:1')
  })

  test('marks inside nested brackets stay on the quiet line until the last one closes', () => {
    const a = align(lines('Kestrels hunt.', '#context state("s", ((1,), 2)).get()', '$ sum_(k) x $'), ['Kestrels hunt.', '(', '(', '1', ',', ')', ',', '2', ')', '∑', 'k', 'x'])
    for (let i = 1; i <= 8; i++) expect(a.at(i)).toBe('main.typ:2:1')
    expect(a.at(9)).toBe('main.typ:3:1')
  })

  test('marks after a quiet line stay there when the next text follows a comment', () => {
    const a = align(lines('Kestrels hunt.', '#context counter(page).display()', '/* note */ Herons wait.'), ['Kestrels hunt.', '1', '7', 'Herons wait.'])
    expect(a.at(1)).toBe('main.typ:2:1')
    expect(a.at(2)).toBe('main.typ:2:1')
  })

  test('a caret on the word a math symbol stands for finds the symbol, after a reference or a value', () => {
    const ref = align(lines('Kestrels fly @intro', '$ integral x dif x $', '', '= Intro <intro>'), ['Kestrels fly', '1', '∫', 'x', 'd', 'x', 'Intro'])
    expect(ref.at(1)).toBe('main.typ:1:14')
    expect(ref.at(2)).toBe('main.typ:2:1')
    expect(ref.caret('main.typ', 2, 4)).toBe(2)
    const files = [
      { path: 'main.typ', content: lines('= People', '#let d = json("d.json")', '#d.name', '$ integral x dif x $') },
      { path: 'd.json', content: lines('{', '  "name": "Ada",', '  "city": "Oslo"', '}') }
    ]
    const value = align(files, ['People', 'Ada', '∫', 'x', 'd', 'x'])
    expect(value.at(2)).toBe('main.typ:4:1')
    expect(value.caret('main.typ', 4, 4)).toBe(2)
  })

  test('marks after a value before an indented text: the first opens its line, the next stands before the text', () => {
    const files = [
      { path: 'main.typ', content: lines('= People', '#let d = json("d.json")', '#d.name', '    Herons wait.') },
      { path: 'd.json', content: lines('{', '  "name": "Ada",', '  "city": "Oslo"', '}') }
    ]
    const a = align(files, ['People', 'Ada', '1', '2', 'Herons wait.'])
    expect(a.at(2)).toBe('main.typ:4:1')
    expect(a.at(3)).toBe('main.typ:4:5')
  })

  test('a mark Typst sets between two words of a line goes right before the word after it', () => {
    const a = align(lines('Kestrels hunt.'), ['Kestrels', '·', 'hunt.'])
    expect(a.at(1)).toBe('main.typ:1:10')
  })

  test('a mark between two items of a loop goes to the start of the loop line', () => {
    const a = align(lines('#for x in range(2) [Fruit]'), ['Fruit', '•', 'Fruit'])
    expect(a.at(1)).toBe('main.typ:1:1')
  })

  test('marks between a reference and what follows it each show their own part of the line', () => {
    const spaced = align(lines('Kestrels fly @intro #count()', '', '= Intro <intro>'), ['Kestrels fly', 'Section 1', '3', 'Intro'])
    expect(spaced.at(1)).toBe('main.typ:1:14')
    expect(spaced.at(2)).toBe('main.typ:1:21')
    const bang = align(lines('Kestrels fly @intro! #count()', '', '= Intro <intro>'), ['Kestrels fly', 'Section 1', '3', 'Intro'])
    expect(bang.at(2)).toBe('main.typ:1:22')
  })

  test('a mark between two texts that touch in the source stays between them; the call after them is the next mark', () => {
    // No space between the texts (Japanese): the call after the second
    // text is what the mark after it shows, not the mark before it.
    const touching = align(lines('猫が好き #f()', 'Herons wait.'), ['猫が', '※', '好き', '†', 'Herons wait.'])
    expect(touching.at(1)).toBe('main.typ:1:3')
    expect(touching.at(3)).toBe('main.typ:1:6')
    expect(touching.caret('main.typ', 1, 6)).toBe(3)
    expect(touching.click(3)).toBe('main.typ:1:6')
    // The same with a space between the texts.
    const spaced = align(lines('猫が 好き #f()', 'Herons wait.'), ['猫が', '※', '好き', '†', 'Herons wait.'])
    expect(spaced.at(1)).toBe('main.typ:1:4')
    expect(spaced.at(3)).toBe('main.typ:1:7')
  })
})

test.describe('marks around data values', () => {
  const people = lines('[', '  {"name": "Ada", "city": "Oslo"},', '  {"name": "Bo", "city": "Rome"}', ']')

  test('a bullet before a value printed first in a list item goes to the list marker', () => {
    const files = [
      { path: 'main.typ', content: lines('= People', '#let people = json("p.json")', '#for p in people [', '  - #p.name', '    lives in #p.city', ']', 'The end here.') },
      { path: 'p.json', content: people }
    ]
    const a = align(files, ['People', '•', 'Ada lives in Oslo', '•', 'Bo lives in Rome', 'The end here.'])
    expect(a.at(1)).toBe('main.typ:4:1')
    expect(a.at(3)).toBe('main.typ:4:1')
  })

  test('the bullets of the later items of a loop go to the loop body, not to a list item above it', () => {
    const three = lines('[', '  {"name": "Ada", "city": "Oslo"},', '  {"name": "Bo", "city": "Rome"},', '  {"name": "Cy", "city": "Kyiv"}', ']')
    const files = [
      { path: 'main.typ', content: lines('= People', '#let people = json("p.json")', '- Leader: #people.at(0).name', '#for p in people [- #p.name rocks]', 'The end here.') },
      { path: 'p.json', content: three }
    ]
    const a = align(files, ['People', '•', 'Leader: Ada', '•', 'Ada rocks', '•', 'Bo rocks', '•', 'Cy rocks', 'The end here.'])
    expect(a.at(1)).toBe('main.typ:3:1')
    // The first item's bullet too, though the text before it is the list item above.
    expect(a.at(3)).toBe('main.typ:4:1')
    expect(a.at(5)).toBe('main.typ:4:1')
    expect(a.at(7)).toBe('main.typ:4:1')
  })

  test('a loop body of several list lines: each mark goes to the marker of the item it opens', () => {
    const three = lines('[', '  {"name": "Ada", "city": "Oslo"},', '  {"name": "Bo", "city": "Rome"},', '  {"name": "Cy", "city": "Kyiv"}', ']')
    const files = [
      { path: 'main.typ', content: lines('= People', '#let people = json("p.json")', '#for p in people [', '  - #p.name rocks', '  + #p.city town', ']', 'The end here.') },
      { path: 'p.json', content: three }
    ]
    const a = align(files, ['People', '•', 'Ada rocks', '1.', 'Oslo town', '•', 'Bo rocks', '2.', 'Rome town', '•', 'Cy rocks', '3.', 'Kyiv town', 'The end here.'])
    for (const i of [1, 5, 9]) expect(a.at(i)).toBe('main.typ:4:1')
    for (const i of [3, 7, 11]) expect(a.at(i)).toBe('main.typ:5:1')
  })

  test('a mark before values with no list marker in its gap does not take one further down', () => {
    const files = [
      { path: 'main.typ', content: lines('= People', '#let people = json("p.json")', '#for p in people [#sym.star #p.name]', 'The end here.', '- Last item') },
      { path: 'p.json', content: people }
    ]
    const a = align(files, ['People', '★', 'Ada', '★', 'Bo', 'The end here.', '•', 'Last item'])
    expect(a.at(1)).toBe('p.json:2:1')
    expect(a.at(3)).toBe('p.json:3:1')
    expect(a.at(6)).toBe('main.typ:5:1')
  })

  test('a mark between two values of a record written over several lines goes right before the second', () => {
    const files = [
      { path: 'main.typ', content: lines('= People', '#let people = read("p.jsonl")', '#for p in people [#p.name #sym.arrow #p.city]', 'The end here.') },
      { path: 'p.jsonl', content: lines('{"name": "Ada",', ' "city": "Oslo"}', '{"name": "Bo",', ' "city": "Rome"}') }
    ]
    const a = align(files, ['People', 'Ada', '→', 'Oslo', 'Bo', '→', 'Rome', 'The end here.'])
    expect(a.at(2)).toBe('p.jsonl:2:11')
    expect(a.at(5)).toBe('p.jsonl:4:11')
  })
})
