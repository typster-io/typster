import { test, expect } from '@playwright/test'
import sync from './preview_sync_module.mjs'

// Preview ↔ source alignment (#149) of runs that are not where their
// neighbours are: a float moved to another page, a generated label in front
// of a caption, a paragraph Typst set from two sources, a run mixing
// literal text with values, a show rule's text around what it shows. Each
// document is written inline and its runs are given as the Typst worker
// would render them; the tests check where a run lands, where a click
// inside it goes and which run a resting caret finds.

const { alignRuns, buildVirtualDoc, clickSpot, locate, offsetOf, runForOffset } = sync

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

// `recorded` runs as { t, page } (a plain string is a run on page 0), a
// picture as { image: true, page }.
function align(files, entry = 'main.typ', recorded = []) {
  recorded = recorded.map((r) => (typeof r === 'string' ? { t: r, page: 0 } : r))
  const main = files.find((f) => f.path === entry)
  const doc = buildVirtualDoc(entry, main.content, files.filter((f) => f !== main), entry)
  const runs = alignRuns(container(recorded), doc)
  const where = (offset) => {
    const l = locate(doc, offset)
    return `${l.file}:${l.line}:${l.col}`
  }
  return {
    runs,
    // The index of the run whose text is `t`.
    nth(t) {
      const i = recorded.findIndex((r) => r.t === t)
      if (i < 0) throw new Error(`no run ${t}`)
      return i
    },
    at: (i) => where(runs[i].start),
    // Where a click on character `idx` of run i's text lands.
    click: (i, idx) => where(clickSpot(runs[i], recorded[i].t.slice(0, idx))),
    // Where a click on each character of run i lands, from `from` on.
    clicks: (i, from = 0, to = recorded[i].t.length) => Array.from({ length: to - from }, (_, k) => where(clickSpot(runs[i], recorded[i].t.slice(0, from + k)))),
    // The run a caret resting at file:line:col finds.
    caret(file, line, col = 1) {
      return runs.indexOf(runForOffset(runs, offsetOf(doc, file, line, col), doc))
    }
  }
}

const main = (lines, ...more) => [{ path: 'main.typ', content: lines.join('\n') + '\n' }, ...more]
// n spots in a row on `line` of `file`, from column `col` on.
const cols = (file, line, col, n) => Array.from({ length: n }, (_, k) => `${file}:${line}:${col + k}`)

test.describe('a float moved to another page', () => {
  // The caption's text stands in the source where the float is written
  // and, hidden, on pages before or after it. The run is looked up in the
  // source of its page and the one before (a float moves forward, never
  // back) up to where the next page starts.
  const caption = 'Moved figure caption words.'

  test('a float shown at the top of a later page lands on its own text, not on a copy pages away', () => {
    const a = align(main([
      'Page zero opens here.',
      `#hide[${caption}]`,
      'Page zero closes here.',
      '',
      'Page one paragraph.',
      '',
      'Page two first paragraph.',
      '',
      'Page two second paragraph.',
      '',
      caption,
      '',
      'Page three paragraph.',
      `#hide[${caption}]`,
      'Page three closes.'
    ]), 'main.typ', [
      { t: 'Page zero opens here.', page: 0 },
      { t: 'Page zero closes here.', page: 0 },
      { t: 'Page one paragraph.', page: 1 },
      { t: caption, page: 2 },
      { t: 'Page two first paragraph.', page: 2 },
      { t: 'Page two second paragraph.', page: 2 },
      { t: 'Page three paragraph.', page: 3 },
      { t: 'Page three closes.', page: 3 }
    ])
    const i = a.nth(caption)
    expect(a.at(i)).toBe('main.typ:11:1')
    expect(a.clicks(i)).toEqual(cols('main.typ', 11, 1, caption.length))
    expect(a.caret('main.typ', 11, 5)).toBe(i)
  })

  test('pages without text of their own do not widen the window: a float from the page before lands on its text', () => {
    // Pages 1 and 4 show only a picture; page 0 also shows a value of a
    // data file. The float written among page 2's text shows on page 3.
    const a = align([
      ...main([
        'Alpha opens the report.',
        `#hide[${caption}]`,
        'Alpha closes the report.',
        '#let rows = csv("v.csv")',
        '#rows.at(0).at(0)',
        '',
        'Gamma first paragraph.',
        '',
        caption,
        '',
        'Gamma second paragraph.',
        '',
        'Delta paragraph here.',
        '',
        'Zeta paragraph here.',
        `#hide[${caption}]`,
        'Zeta closes here.'
      ]),
      { path: 'v.csv', content: 'Quokka,1\n' }
    ], 'main.typ', [
      { t: 'Alpha opens the report.', page: 0 },
      { t: 'Alpha closes the report.', page: 0 },
      { t: 'Quokka', page: 0 },
      { image: true, page: 1 },
      { t: 'Gamma first paragraph.', page: 2 },
      { t: 'Gamma second paragraph.', page: 2 },
      { t: caption, page: 3 },
      { t: 'Delta paragraph here.', page: 3 },
      { image: true, page: 4 },
      { t: 'Zeta paragraph here.', page: 5 },
      { t: 'Zeta closes here.', page: 5 }
    ])
    const i = a.nth(caption)
    expect(a.at(i)).toBe('main.typ:9:1')
    expect(a.clicks(i)).toEqual(cols('main.typ', 9, 1, caption.length))
    expect(a.at(a.nth('Quokka'))).toBe('v.csv:1:1')
  })

  test('a float written after the text of its page lands there, past a page with only a picture', () => {
    const a = align(main([
      'Alpha one paragraph.',
      '',
      'Beta one paragraph.',
      '',
      'Beta two paragraph.',
      '',
      caption,
      '',
      'Delta one paragraph.',
      `#hide[${caption}]`,
      'Delta two paragraph.'
    ]), 'main.typ', [
      { t: 'Alpha one paragraph.', page: 0 },
      { t: 'Beta one paragraph.', page: 1 },
      { t: caption, page: 1 },
      { t: 'Beta two paragraph.', page: 1 },
      { image: true, page: 2 },
      { t: 'Delta one paragraph.', page: 3 },
      { t: 'Delta two paragraph.', page: 3 }
    ])
    expect(a.clicks(a.nth(caption))).toEqual(cols('main.typ', 7, 1, caption.length))
  })

  test('a float on the first page lands on its text, not on a copy on the next page', () => {
    const a = align(main([
      'Alpha first paragraph.',
      '',
      caption,
      '',
      'Alpha second paragraph.',
      '',
      'Beta paragraph here.',
      `#hide[${caption}]`,
      'Beta closes here.'
    ]), 'main.typ', [
      { t: caption, page: 0 },
      { t: 'Alpha first paragraph.', page: 0 },
      { t: 'Alpha second paragraph.', page: 0 },
      { t: 'Beta paragraph here.', page: 1 },
      { t: 'Beta closes here.', page: 1 }
    ])
    expect(a.clicks(a.nth(caption))).toEqual(cols('main.typ', 3, 1, caption.length))
  })

  test('a float on the last page with text lands on its text, not on a file the document does not include', () => {
    const a = align([
      ...main(['Alpha first paragraph.', '', caption, '', 'Alpha second paragraph.']),
      { path: 'draft.typ', content: `${caption}\n` }
    ], 'main.typ', [
      { t: caption, page: 0 },
      { t: 'Alpha first paragraph.', page: 0 },
      { t: 'Alpha second paragraph.', page: 0 },
      { image: true, page: 1 }
    ])
    expect(a.clicks(a.nth(caption))).toEqual(cols('main.typ', 3, 1, caption.length))
  })
})

test.describe('a generated label in front of a caption', () => {
  // The figure stands after both paragraphs, its caption shown between
  // them with a label Typst generates: the run lives at the caption when
  // the caption carries at least half of its letters.
  const around = (caption, label, more = []) =>
    align(main(['Opening line here.', '', 'Closing line here.', '', `#figure(rect(), caption: [${caption}])`, ...more]), 'main.typ', ['Opening line here.', `${label} ${caption}`, 'Closing line here.'])

  test('a caption carrying half of the letters takes the run, a shorter one does not', () => {
    const half = around('Wxyz', 'Abcd')
    expect(half.at(1)).toBe('main.typ:5:27')
    expect(half.clicks(1, 5)).toEqual(cols('main.typ', 5, 27, 4))
    // Three letters of seven: the run stays after the line before it.
    const less = around('Xyz', 'Abcd')
    expect(less.clicks(1, 5)).toEqual(Array(3).fill('main.typ:1:19'))
  })

  test('a label and one caption word: the word takes the run', () => {
    const a = around('Overview', 'Fig')
    expect(a.clicks(1, 4)).toEqual(cols('main.typ', 5, 27, 8))
  })

  test('a run without letters is not matched by its last number', () => {
    const a = align(main(['Opening line here.', '', 'Closing line here.', '', 'Total 2024']), 'main.typ', ['Opening line here.', '7 2024', 'Closing line here.'])
    expect(a.clicks(1)).toEqual(Array(6).fill('main.typ:1:19'))
  })

  // `Abb` is generated: the caption `Results overview` is what the source
  // holds, and the tests move it between the gap of the run, the lines
  // around it and the rest of the page, with a hidden copy elsewhere.
  const label = ['Opening line here.', 'Abb Results overview', 'Closing line here.']

  test('a caption in the gap wins over a copy on the line before it', () => {
    const a = align(main(['#hide[Results overview] Opening line here.', '', '#figure(rect(), caption: [Results overview])', '', 'Closing line here.']), 'main.typ', label)
    expect(a.clicks(1, 4)).toEqual(cols('main.typ', 3, 27, 16))
  })

  test('of two captions in the gap, the first takes the run', () => {
    const a = align(main(['Opening line here.', '', '#figure(rect(), caption: [Results overview])', '#hide[Results overview]', '', 'Closing line here.']), 'main.typ', label)
    expect(a.clicks(1, 4)).toEqual(cols('main.typ', 3, 27, 16))
  })

  test('a caption in the gap wins over a copy later on the page', () => {
    const a = align(main(['Opening line here.', '', '#figure(rect(), caption: [Results overview])', '', 'Closing line here.', '', 'Later line here.', '#hide[Results overview]', 'Last line here.']), 'main.typ', [...label, 'Later line here.', 'Last line here.'])
    expect(a.clicks(1, 4)).toEqual(cols('main.typ', 3, 27, 16))
  })

  test('a caption on the line of the run before wins over a copy later on the page', () => {
    const a = align(main(['#figure(rect(), caption: [Results overview]) Opening line here.', '', 'Closing line here.', '', 'Later line here.', '#hide[Results overview]', 'Last line here.']), 'main.typ', [...label, 'Later line here.', 'Last line here.'])
    expect(a.clicks(1, 4)).toEqual(cols('main.typ', 1, 27, 16))
  })

  test('a caption word inside a longer word is not the caption', () => {
    const a = align(main(['Opening line here.', '', '#figure(rect(), caption: [PreResults overview])', '', 'Closing line here.']), 'main.typ', label)
    // `overview` is found; `Results` is not the end of `PreResults`.
    expect(a.clicks(1, 12)).toEqual(cols('main.typ', 3, 38, 8))
    expect(a.click(1, 4)).toBe('main.typ:3:38')
  })
})

test.describe('one paragraph from two sources or around a value', () => {
  const chapters = [
    { path: 'ch1.typ', content: 'Chapter text about otters.\n' },
    { path: 'ch2.typ', content: 'Second chapter about beavers.\n' }
  ]
  const both = 'Chapter text about otters. Second chapter about beavers.'

  test('each part keeps its file when the first part is written again later on the page', () => {
    const a = align(main(['= Book', '', '#include "ch1.typ"', '#include "ch2.typ"', '', 'After about herons.', '', 'Later words here.', '#hide[Chapter text about otters]', 'Last words here.'], ...chapters), 'main.typ', ['Book', both, 'After about herons.', 'Later words here.', 'Last words here.'])
    expect(a.clicks(1, 0, 6)).toEqual(cols('ch1.typ', 1, 1, 6))
    expect(a.clicks(1, 27, 33)).toEqual(cols('ch2.typ', 1, 1, 6))
    expect(a.caret('ch1.typ', 1, 5)).toBe(1)
  })

  test('each part keeps its file when a longer word starts like the end of the first part', () => {
    const a = align(main(['= Book', '', '#hide[Chapter text about otterspotting]', '#include "ch1.typ"', '#include "ch2.typ"', '', 'After about herons.'], ...chapters), 'main.typ', ['Book', both, 'After about herons.'])
    expect(a.clicks(1, 0, 6)).toEqual(cols('ch1.typ', 1, 1, 6))
    expect(a.clicks(1, 27, 33)).toEqual(cols('ch2.typ', 1, 1, 6))
  })

  test('words printed around a value keep their spots; words cut off by text the run does not show do not', () => {
    const value = align(main(['#let people = (1, 2, 3)', 'Opening line here.', '', 'Total #people.len() persons counted', '', 'Closing line here.']), 'main.typ', ['Opening line here.', 'Total 3 persons counted', 'Closing line here.'])
    expect(value.clicks(1, 0, 5)).toEqual(cols('main.typ', 4, 1, 5))
    expect(value.clicks(1, 8, 15)).toEqual(cols('main.typ', 4, 21, 7))
    // `extra` stands between `Total` and the rest: `Total` is not the run's.
    const hidden = align(main(['#let people = (1, 2, 3)', 'Opening line here.', '', 'Total #hide[extra] #people.len() persons counted', '', 'Closing line here.']), 'main.typ', ['Opening line here.', 'Total 3 persons counted', 'Closing line here.'])
    expect(hidden.clicks(1, 0, 5)).toEqual(Array(5).fill('main.typ:4:34'))
    expect(hidden.clicks(1, 8, 15)).toEqual(cols('main.typ', 4, 34, 7))
    // Only `of all` is next to the value: `Sum` goes with them.
    const cut = align(main(['#let people = (1, 2, 3)', 'Opening line here.', '', 'Sum #hide[x] of all #people.len() persons counted', '', 'Closing line here.']), 'main.typ', ['Opening line here.', 'Sum of all 3 persons counted', 'Closing line here.'])
    expect(cut.clicks(1, 0, 10)).toEqual(['main.typ:4:14', 'main.typ:4:14', 'main.typ:4:14', 'main.typ:4:14', ...cols('main.typ', 4, 14, 2), 'main.typ:4:16', ...cols('main.typ', 4, 17, 3)])
  })

  test('text a module prints before an argument goes to the module, on every call', () => {
    const mod = { path: 'mod.typ', content: '#let banner(t) = [Hello from #t]\n' }
    const a = align(main(['#import "mod.typ": banner', 'Opening line here.', '', '#banner[Alpha beta gamma]', '', 'Middle line here.', '', '#banner[Delta epsilon zeta]', '', 'Closing line here.'], mod), 'main.typ', ['Opening line here.', 'Hello from Alpha beta gamma', 'Middle line here.', 'Hello from Delta epsilon zeta', 'Closing line here.'])
    for (const [i, line] of [[1, 4], [3, 8]]) {
      expect(a.clicks(i, 0, 5)).toEqual(cols('mod.typ', 1, 19, 5))
      expect(a.clicks(i, 11, 16)).toEqual(cols('main.typ', line, 9, 5))
    }
  })

  test('a value of a data file printed again before literal text goes to the file', () => {
    const a = align(main(['#let d = csv("people.csv")', 'Opening line here.', '', '#table(..d.flatten())', '', 'Middle line here.', '', '#for r in d [- #r.at(0) runs the survey today.]', '', 'Closing line here.'], { path: 'people.csv', content: 'Ada Lovelace,Lead\n' }), 'main.typ', ['Opening line here.', 'Ada Lovelace', 'Lead', 'Middle line here.', 'Ada Lovelace runs the survey today.', 'Closing line here.'])
    expect(a.clicks(4, 0, 12)).toEqual(cols('people.csv', 1, 1, 12))
    expect(a.clicks(4, 13, 17)).toEqual(cols('main.typ', 8, 25, 4))
  })

  test('a value printed before literal text goes to the file also when a longer cell before it holds it too', () => {
    const lines = ['#let d = csv("people.csv")', 'Opening line here.', '', '#table(..d.flatten())', '', 'Middle line here.', '', '#for r in d [- #r.at(0) runs the survey today.]', '', 'Closing line here.']
    const runs = ['Opening line here.', 'Ada Lovelace Institute', 'x', 'Ada Lovelace', 'y', 'Middle line here.', 'Ada Lovelace runs the survey today.', 'Closing line here.']
    const a = align(main(lines, { path: 'people.csv', content: 'Ada Lovelace Institute,x\nAda Lovelace,y\n' }), 'main.typ', runs)
    for (const spot of a.clicks(6, 0, 12)) expect(spot).toMatch(/^people\.csv:/)
    expect(a.clicks(6, 13, 17)).toEqual(cols('main.typ', 8, 25, 4))
  })
})

test.describe('a run mixing literal text with values', () => {
  const people = (content) => ({ path: 'people.csv', content })
  const loop = ['#let d = csv("people.csv")', 'Opening line here.', '', '#for r in d [- #r.at(0) lives in #r.at(1) now.]', '', 'Closing line here.']

  test('the literal words stay on the loop body, a hidden copy of a value before it does not take the value', () => {
    const lines = [...loop.slice(0, 3), '#hide[Ada wrote]', ...loop.slice(3)]
    const a = align(main(lines, people('Ada,London\nGrace,Paris\n')), 'main.typ', ['Opening line here.', 'Ada lives in London now.', 'Grace lives in Paris now.', 'Closing line here.'])
    expect(a.clicks(1, 0, 3)).toEqual(cols('people.csv', 1, 1, 3))
    expect(a.clicks(1, 4, 13)).toEqual(cols('main.typ', 5, 25, 9))
    expect(a.clicks(1, 13, 19)).toEqual(cols('people.csv', 1, 5, 6))
    expect(a.clicks(2, 0, 5)).toEqual(cols('people.csv', 2, 1, 5))
  })

  test('a row printed twice: each copy takes its own row', () => {
    const a = align(main(loop, people('Ada,London\nAda,London\n')), 'main.typ', ['Opening line here.', 'Ada lives in London now.', 'Ada lives in London now.', 'Closing line here.'])
    for (const [i, row] of [[1, 1], [2, 2]]) {
      expect(a.clicks(i, 0, 3)).toEqual(cols('people.csv', row, 1, 3))
      expect(a.clicks(i, 13, 19)).toEqual(cols('people.csv', row, 5, 6))
    }
  })

  test('a call writing its values beside the definition: the values on the call, the words on the definition', () => {
    const a = align(main(['#let ficha(n, c) = [Nombre: #n, ciudad: #c.]', 'Opening line here.', '', '#ficha("Lucía", "Sevilla")', '', '#ficha[Andrés][Bilbao]', '', 'Closing line here.']), 'main.typ', ['Opening line here.', 'Nombre: Lucía, ciudad: Sevilla.', 'Nombre: Andrés, ciudad: Bilbao.', 'Closing line here.'])
    expect(a.clicks(1, 0, 6)).toEqual(cols('main.typ', 1, 21, 6))
    expect(a.clicks(1, 8, 13)).toEqual(cols('main.typ', 4, 9, 5))
    expect(a.clicks(1, 15, 21)).toEqual(cols('main.typ', 1, 33, 6))
    expect(a.clicks(1, 23, 30)).toEqual(cols('main.typ', 4, 18, 7))
    expect(a.clicks(2, 8, 14)).toEqual(cols('main.typ', 6, 8, 6))
    expect(a.clicks(2, 24, 30)).toEqual(cols('main.typ', 6, 16, 6))
    // A caret on each call finds the card it printed.
    expect(a.caret('main.typ', 4, 3)).toBe(1)
    expect(a.caret('main.typ', 6, 3)).toBe(2)
  })

  test('a definition printed whole by two calls: a caret on each call finds its own copy', () => {
    const a = align(main(['#let sign() = [Signed by the board]', 'Opening line here.', '', '#sign()', '', 'Middle line here.', '', '#sign()', '', 'Closing line here.']), 'main.typ', ['Opening line here.', 'Signed by the board', 'Middle line here.', 'Signed by the board', 'Closing line here.'])
    expect(a.click(1, 0)).toBe('main.typ:1:16')
    expect(a.click(3, 0)).toBe('main.typ:1:16')
    expect(a.caret('main.typ', 4, 2)).toBe(1)
    expect(a.caret('main.typ', 8, 2)).toBe(3)
    expect(a.caret('main.typ', 1, 18)).toBe(1)
  })
})

test.describe('a run printed from a data file alone', () => {
  const crew = (content) => ({ path: 'crew.yaml', content })

  test('values printed in another order than their record come from that record, a repeated value from the record printed', () => {
    const a = align(main(['#let d = yaml("crew.yaml")', 'Opening line here.', '', '#for m in d [- #m.role --- #m.name]', '', 'Closing line here.'], crew('- name: Ines\n  role: botanist\n- name: Oskar\n  role: botanist\n')), 'main.typ', ['Opening line here.', 'botanist — Ines', 'botanist — Oskar', 'Closing line here.'])
    for (const [i, line, name] of [[1, 1, 4], [2, 3, 5]]) {
      expect(a.at(i)).toBe(`crew.yaml:${line}:9`)
      expect(a.clicks(i, 0, 8)).toEqual(cols('crew.yaml', line + 1, 9, 8))
      expect(a.clicks(i, 11, 11 + name)).toEqual(cols('crew.yaml', line, 9, name))
      expect(a.caret('crew.yaml', line, 9)).toBe(i)
      expect(a.caret('crew.yaml', line + 1, 9)).toBe(i)
    }
  })

  test('values printed around a count in another order than their row come from that row, not from a hidden copy', () => {
    const a = align(main(['#let d = csv("people.csv")', '#hide[Ada]', 'Opening line here.', '', '#for r in d [#r.at(1) #r.len() #r.at(2) #r.at(0)]', '', 'Closing line here.'], { path: 'people.csv', content: 'Grace,Rome,Oslo\nAda,London,Rome\n' }), 'main.typ', ['Opening line here.', 'Rome 3 Oslo Grace', 'London 3 Rome Ada', 'Closing line here.'])
    expect(a.clicks(1, 0, 4)).toEqual(cols('people.csv', 1, 7, 4))
    expect(a.clicks(1, 12)).toEqual(cols('people.csv', 1, 1, 5))
    expect(a.clicks(2, 0, 6)).toEqual(cols('people.csv', 2, 5, 6))
    expect(a.clicks(2, 9, 13)).toEqual(cols('people.csv', 2, 12, 4))
    expect(a.clicks(2, 14)).toEqual(cols('people.csv', 2, 1, 3))
  })

  test('a run takes the file only when the file holds at least half of its letters', () => {
    const a = align(main(['#let d = yaml("crew.yaml")', 'Opening line here.', '', '#for m in d [#m.name #m.role]', '', 'Closing line here.'], crew('- name: Ines\n  role: botanist\n- name: Oskar\n  role: pilot\n')), 'main.typ', ['Opening line here.', 'Ines wrote', 'Oskar flew', 'Closing line here.'])
    // Four letters of nine: the run stays on the loop.
    expect(a.clicks(1, 0, 4)).toEqual(Array(4).fill('main.typ:4:30'))
    // Five of nine: the name is clicked in the file.
    expect(a.clicks(2, 0, 5)).toEqual(cols('crew.yaml', 3, 9, 5))
  })
})

// A compact list of click spots: `L:C+n` is n columns from line L column
// C on, `L:C*n` n times the same spot, `L:C` one spot; `B` stands for the
// line of the element's body.
function spots(spec, bodyLine, file = 'main.typ') {
  return spec.split(' ').flatMap((part) => {
    const m = /^(B|\d+:)(\d+)(?:([+*])(\d+))?$/.exec(part)
    const line = m[1] === 'B' ? bodyLine : Number(m[1].slice(0, -1))
    const col = Number(m[2])
    const n = m[4] ? Number(m[4]) : 1
    return Array.from({ length: n }, (_, k) => `${file}:${line}:${m[3] === '+' ? col + k : col}`)
  })
}

test.describe('show rules printing text and code around what they show', () => {
  // Each rule as written, the run it sets for a heading and where a click
  // on each character lands: the heading's text on the heading, the rule's
  // words on the rule, what its code prints (a value, a formula) on that
  // code.
  const rules = [
    ['[Kapitel#datum: #it.body]', (b) => `Kapitel2024: ${b}`, '3:23+8 3:30*3 3:36+2 B3+4'],
    ['[#it.body #datum: Teil]', (b) => `${b} 2024: Teil`, 'B3+5 3:32*4 3:38+6'],
    ['[#it.body #monat: Teil]', (b) => `${b} Mai 2024: Teil`, 'B3+5 3:32*8 3:38+6'],
    ['[$star$ Part: #it.body]', (b) => `★ Part: ${b}`, '3:29*2 3:30+6 B3+4'],
    ['[#it.body (Part) $star$]', (b) => `${b} (Part) ★`, 'B3+5 3:32+8'],
    ['[Kapitel #datum, Teil #datum: #it.body]', (b) => `Kapitel 2024, Teil 2024: ${b}`, '3:23+9 3:31*3 3:37+8 3:44*3 3:50+2 B3+4'],
    ['[#datum Kapitel: #it.body]', (b) => `2024 Kapitel: ${b}`, '3:23*5 3:30+9 B3+4'],
    ['[#it.body (Teil) #datum]', (b) => `${b} (Teil) 2024`, 'B3+5 3:32+8 3:39*3'],
    ['[#it.body -- Teil #datum, Band #datum.]', (b) => `${b} – Teil 2024, Band 2024.`, 'B3+5 3:32 3:34+7 3:40*3 3:46+8 3:53*3 3:59'],
    ['[#datum Kapitel #datum: #it.body]', (b) => `2024 Kapitel 2024: ${b}`, '3:23*5 3:30+9 3:38*3 3:44+2 B3+4'],
    ['[Teil: #it.body #datum]', (b) => `Teil: ${b} 2024`, '3:23+6 B3+5 3:38*4'],
    ['[Teil: #it.body #monat]', (b) => `Teil: ${b} Mai 2024`, '3:23+6 B3+5 3:38*8'],
    ['[Kapitel: #monat #it.body]', (b) => `Kapitel: Mai 2024 ${b}`, '3:23+10 3:32*8 B3+4'],
    ['[#it.body #datum -- Teil #monat.]', (b) => `${b} 2024 – Teil Mai 2024.`, 'B3+5 3:32*5 3:39 3:41+6 3:47*8 3:53'],
    // Parentheses the rule shows as text around its code.
    ['[#it.body (Teil #datum, Band #datum)]', (b) => `${b} (Teil 2024, Band 2024)`, 'B3+5 3:32+6 3:38*4 3:44+7 3:51*4 3:57'],
    ['[(#datum Teil): #it.body]', (b) => `(2024 Teil): ${b}`, '3:23 3:24*5 3:31+7 B3+4']
  ]

  test('every character of every heading lands on the heading, the rule\'s words or the code next to them', () => {
    for (const [rule, shown, spec] of rules) {
      const lines = ['#let datum = "2024"', '#let monat = "Mai 2024"', `#show heading: it => ${rule}`, '= Eins', '', 'Absatz eins.', '', '= Zwei', '', 'Absatz zwei.']
      const a = align(main(lines), 'main.typ', [shown('Eins'), 'Absatz eins.', shown('Zwei'), 'Absatz zwei.'])
      expect(a.clicks(0), rule).toEqual(spots(spec, 4))
      expect(a.clicks(2), rule).toEqual(spots(spec, 8))
      expect(a.clicks(1, 0, 6), rule).toEqual(cols('main.typ', 6, 1, 6))
      // A caret on a heading finds its run, one on the rule the first.
      expect(a.caret('main.typ', 4, 4), rule).toBe(0)
      expect(a.caret('main.typ', 8, 4), rule).toBe(2)
      expect(a.caret('main.typ', 3, 23 + rule.search(/[A-Z]/)), rule).toBe(0)
    }
  })

  test('a comment with a colon in the rule\'s selector: the rule\'s word still goes to the rule for every heading', () => {
    const a = align(main(['#show /* a: b */ heading: it => [Part #it.body]', '= Intro', '', 'Body one here.', '', '= Outro', '', 'Body two here.']), 'main.typ', ['Part Intro', 'Body one here.', 'Part Outro', 'Body two here.'])
    expect(a.clicks(0)).toEqual(spots('1:34+5 B3+5', 2))
    expect(a.clicks(2)).toEqual(spots('1:34+5 B3+5', 6))
  })

  test('a heading of two words before a value of two words keeps both words', () => {
    const a = align(main(['#let monat = "Mai 2024"', '#show heading: it => [Teil: #it.body #monat]', '= Eins Zwei', '', 'Absatz eins.']), 'main.typ', ['Teil: Eins Zwei Mai 2024', 'Absatz eins.'])
    expect(a.clicks(0)).toEqual(spots('2:23+6 3:3+10 2:38*8', 3))
  })

  test('a heading shown through two rules: the outer rule\'s word goes to its rule, the inner rule\'s to its own', () => {
    const prefix = align(main(['#show heading: it => [Part: #it.body]', '#show heading: it => [Big #it]', '= Intro', '', 'Body one here.']), 'main.typ', ['Big Part: Intro', 'Body one here.'])
    expect(prefix.clicks(0, 0, 3)).toEqual(cols('main.typ', 2, 23, 3))
    expect(prefix.clicks(0, 4, 9)).toEqual(cols('main.typ', 1, 23, 5))
    expect(prefix.clicks(0, 10)).toEqual(cols('main.typ', 3, 3, 5))
    const suffix = align(main(['#show heading: it => [#it.body (Part)]', '#show heading: it => [#it Big]', '= Intro', '', 'Body one here.']), 'main.typ', ['Intro (Part) Big', 'Body one here.'])
    expect(suffix.clicks(0)).toEqual(spots('3:3+6 1:32+6 1:37 2:27+3', 3))
  })

  test('a paragraph writing the rule\'s text itself is not split, nor one shown by no heading', () => {
    const literal = align(main(['#show heading: it => block[#it.body (Draft)]', '= Report', '', 'Report (Draft)', '', 'Closing words here.']), 'main.typ', ['Report (Draft)', 'Report (Draft)', 'Closing words here.'])
    expect(literal.clicks(0)).toEqual(spots('2:3+7 1:37+7', 2))
    expect(literal.clicks(1)).toEqual(cols('main.typ', 4, 1, 14))
    // Paragraphs printing a value where the rule's code does: their own
    // words are no heading's, so they keep their lines.
    const before = align(main(['#let datum = "2024"', '#show heading: it => [Kapitel: #datum #it.body]', '= Eins', '', 'Kapitel: #datum Absatz', '', 'Closing words here.']), 'main.typ', ['Kapitel: 2024 Eins', 'Kapitel: 2024 Absatz', 'Closing words here.'])
    expect(before.clicks(0)).toEqual(spots('2:23+10 2:32*4 3:3+4', 3))
    expect(before.clicks(1)).toEqual(spots('5:1+8 5:8 5:10*5 5:17+6', 5))
    const after = align(main(['#let datum = "2024"', '#show heading: it => [#it.body #datum: Teil]', '= Eins', '', 'Absatz #datum: Teil', '', 'Closing words here.']), 'main.typ', ['Eins 2024: Teil', 'Absatz 2024: Teil', 'Closing words here.'])
    expect(after.clicks(0)).toEqual(spots('3:3+5 2:32*4 2:38+6', 3))
    expect(after.clicks(1, 0, 6)).toEqual(cols('main.typ', 5, 1, 6))
    expect(after.clicks(1, 7, 11)).toEqual(Array(4).fill('main.typ:5:8'))
    expect(after.clicks(1, 13)).toEqual(cols('main.typ', 5, 16, 4))
  })

  test('a value printed with the rule\'s text is no heading because a heading starts or ends with it', () => {
    for (const heading of ['Reporting', 'MyReport']) {
      const a = align(main(['#show heading: it => block[#it.body (Draft)]', '#let s = "Report"', `= ${heading}`, '', '#s (Draft)', '', 'Closing words here.']), 'main.typ', [`${heading} (Draft)`, 'Report (Draft)', 'Closing words here.'])
      expect(a.clicks(0), heading).toEqual(spots(`3:3+${heading.length + 1} 1:37+7`, 3))
      expect(a.clicks(1), heading).toEqual(spots('2:11+7 5:4+7', 5))
    }
  })

  test('of two rules matching a heading, the one whose words cover more of it splits it', () => {
    const a = align(main(['#show heading: it => [#it.body Draft]', '#show heading: it => [#it.body Final Draft]', '= Intro', '', 'Body one.', '', '= Intro Final', '', 'Body two.']), 'main.typ', ['Intro Final Draft', 'Body one.', 'Intro Final Draft', 'Body two.'])
    expect(a.clicks(0)).toEqual(spots('3:3+6 2:32+11', 3))
  })
})
