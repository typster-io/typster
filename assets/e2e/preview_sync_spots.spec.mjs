import { test, expect } from '@playwright/test'
import sync from './preview_sync_module.mjs'

// Click spots and occurrence lookup (#149) on synthetic documents: where a
// click on each character of a matched run lands in the sources (dashes,
// escapes, quotes, values printed by code), and which occurrence a run takes
// when its words, separators and decoration are spelled several ways.

const { alignRuns, buildVirtualDoc, clickSpot, locate } = sync

function container(recorded) {
  const pages = new Map()
  const page = (p) => {
    if (!pages.has(p)) pages.set(p, { page: p })
    return pages.get(p)
  }
  const nodes = recorded.map((r) => ({
    tagName: 'span',
    textContent: r.t,
    parentElement: { closest: () => null },
    closest: (sel) => (sel === '.typst-page' ? page(r.page) : null)
  }))
  return { querySelectorAll: () => nodes }
}

// Runs of one page, given as their texts.
const onPage = (...texts) => texts.map((t) => ({ t, page: 0 }))

function align(files, entry, recorded) {
  const main = files.find((f) => f.path === entry)
  const doc = buildVirtualDoc(entry, main.content, files.filter((f) => f !== main), entry)
  const runs = alignRuns(container(recorded), doc)
  const where = (offset) => {
    const l = locate(doc, offset)
    return `${l.file}:${l.line}:${l.col}`
  }
  return {
    runs,
    at: (i) => where(runs[i].start),
    kind: (i) => (runs[i].anchored ? runs[i].kind : 'placed'),
    // Where a click before character `idx` of run i's text lands.
    click: (i, idx) => where(clickSpot(runs[i], recorded[i].t.slice(0, idx))),
    // Where a click before each character of run i lands, and one past its end.
    spots: (i) => Array.from({ length: recorded[i].t.length + 1 }, (_, k) => where(clickSpot(runs[i], recorded[i].t.slice(0, k))))
  }
}

const main = (content, recorded) => align([{ path: 'main.typ', content }], 'main.typ', recorded)

// Source spots on one line: numbers are columns, [from, to] a run of them.
function on(line, ...cols) {
  return cols.flatMap((c) => (Array.isArray(c) ? Array.from({ length: c[1] - c[0] + 1 }, (_, k) => c[0] + k) : [c])).map((c) => `main.typ:${line}:${c}`)
}

test.describe('click spots of a run matched whole', () => {
  test('dashes: a click steps over each source spelling of a dash, also the last character of a run', () => {
    const lines = ['First line --- with a dash.', '', 'Second -- en and a ‐ hyphen and - dash.', '', 'Third — em – en.', '', 'He paused—', '', 'Then spoke---', '', 'Open since 2004–', '', 'Also 1990--']
    const a = main(lines.join('\n') + '\n', onPage('First line — with a dash.', 'Second – en and a - hyphen and - dash.', 'Third — em – en.', 'He paused—', 'Then spoke—', 'Open since 2004–', 'Also 1990–'))
    expect(a.spots(0)).toEqual(on(1, [1, 12], [15, 28]))
    expect(a.spots(1)).toEqual(on(3, [1, 8], [10, 40]))
    expect(a.spots(2)).toEqual(on(5, [1, 17]))
    expect(a.spots(3)).toEqual(on(7, [1, 11]))
    expect(a.spots(4)).toEqual(on(9, [1, 11], 14))
    expect(a.spots(5)).toEqual(on(11, [1, 17]))
    expect(a.spots(6)).toEqual(on(13, [1, 10], 12))
  })

  test('escapes, doubled marks and quotes: a click skips the backslash and keeps each mark its own', () => {
    const lines = ['Cost \\$5 \\# and 50\\% off.', '', 'Wow!! Great?? Yes.', '', 'He said « bonjour » and "hi" there, \\"x\\" too.', '', 'Price in \\$']
    const a = main(lines.join('\n') + '\n', onPage('Cost $5 # and 50% off.', 'Wow!! Great?? Yes.', 'He said «bonjour» and “hi” there, "x" too.', 'Price in $'))
    expect(a.spots(0)).toEqual(on(1, [1, 6], [8, 10], [12, 19], [21, 26]))
    expect(a.spots(1)).toEqual(on(3, [1, 19]))
    expect(a.spots(2)).toEqual(on(5, [1, 9], [11, 18], [20, 37], 39, 40, [42, 47]))
    expect(a.spots(3)).toEqual(on(7, [1, 10], 12))
  })

  test('escaped hyphens: each is one hyphen, a click steps over its backslash', () => {
    const lines = ['Intro.', '', 'Wait\\-\\-\\-then go.', '', 'Pages 10\\-\\-20 here.', '', 'Pages 10\\-20 here.']
    const a = main(lines.join('\n') + '\n', onPage('Intro.', 'Wait---then go.', 'Pages 10--20 here.', 'Pages 10-20 here.'))
    expect(a.spots(1)).toEqual(on(3, [1, 5], 7, 9, [11, 19]))
    expect(a.spots(2)).toEqual(on(5, [1, 9], 11, [13, 21]))
    expect(a.spots(3)).toEqual(on(7, [1, 9], [11, 19]))
  })

  test('a word broken after its own hyphen: the first part ends on the hyphen, the second starts after it', () => {
    const a = main('Intro text.\n\nA well-known fact here.\n', onPage('Intro text.', 'A well-', 'known fact here.'))
    expect(a.spots(1)).toEqual(on(3, [1, 7], 7))
    expect(a.at(2)).toBe('main.typ:3:8')
  })

  test('a click past the trailing space of a run lands at its end', () => {
    const a = main('Intro text.\n\nWe saw kestrels today.\n', [{ t: 'Intro text. ', page: 0 }, { t: 'We saw kestrels today. ', page: 0 }])
    expect(a.click(0, 12)).toBe('main.typ:1:12')
    expect(a.click(1, 23)).toBe('main.typ:3:23')
  })

  test('the characters around an emoji or a letter outside the basic plane keep their own spots', () => {
    const a = main('Smile 😀 and 𠀀x more.\n', onPage('Smile 😀 and 𠀀x more.'))
    expect(a.click(0, 5)).toBe('main.typ:1:6')
    expect(a.click(0, 6)).toBe('main.typ:1:7')
    expect(a.click(0, 8)).toBe('main.typ:1:9')
    expect(a.click(0, 12)).toBe('main.typ:1:13')
    expect(a.click(0, 13)).toBe('main.typ:1:14')
    expect(a.click(0, 15)).toBe('main.typ:1:16')
  })
})

test.describe('click spots of a run found word by word', () => {
  test('the marks a data value starts with land on the value in its file', () => {
    const a = align([
      { path: 'main.typ', content: '= Phones\n\n#for r in csv("d.csv") [Call #r.at(1) now.\n\n]\n' },
      { path: 'd.csv', content: 'ann,+(39) 055\nbob,-(1) 212\n' }
    ], 'main.typ', onPage('Phones', 'Call +(39) 055 now.', 'Call -(1) 212 now.'))
    for (const [i, row] of [[1, 1], [2, 2]]) {
      expect(a.click(i, 'Call '.length)).toBe(`d.csv:${row}:5`)
      expect(a.click(i, 'Call +'.length)).toBe(`d.csv:${row}:6`)
    }
    expect(a.click(1, 'Call +(39) '.length)).toBe('d.csv:1:11')
  })

  test('a sign at the very start of the document is the value it precedes', () => {
    const a = main('-5 degrees #upper[cold] here.\n', onPage('-5 degrees COLD here.'))
    expect(a.spots(0)).toEqual(on(1, [1, 11], [19, 23], [25, 29], 29))
  })

  test('a printed array: its brackets and quotes land on the literal it prints', () => {
    const a = main('#let xs = ("alpha", "beta")\n= Head\n\n#xs and more.\n', onPage('Head', '("alpha", "beta") and more.'))
    expect(a.click(1, 0)).toBe('main.typ:1:11')
    expect(a.click(1, 1)).toBe('main.typ:1:12')
    expect(a.click(1, 2)).toBe('main.typ:1:13')
  })

  test('a value found nowhere takes the code printing it, past the marks before it', () => {
    const a = main('#let p = (name: "Eino", city: "Oulu")\n#let n = 42\n#let m = 7\n= H\n\nNimi: #p.at("name"), kaupunki: (#p.at("city")).\n\nIn all #n.\n\nWe have #n and #m.\n', onPage('H', 'Nimi: Eino, kaupunki: (Oulu).', 'In all 42.', 'We have 42 and 7.'))
    expect(a.spots(1)).toEqual(on(6, [1, 5], 5, [7, 7], 7, 7, 7, 7, 7, [22, 30], 30, 30, 33, 33, 33, 33, 33, 33, 33))
    expect(a.spots(2)).toEqual(on(8, [1, 8], 8, 8, 8))
    expect(a.spots(3)).toEqual(on(10, [1, 9], 9, 9, [12, 16], 16, 16))
  })

  test('a value found nowhere takes the code printing it also when the word after it is defined above', () => {
    const run = onPage('H', 'Hi 42, Ann!')
    const above = main('#let p = (a: "Ann")\n= H\n\nHi #str(40 + 2), #p.at("a")!\n', run)
    const below = main('= H\n\nHi #str(40 + 2), #p.at("a")!\n#let p = (a: "Ann")\n', run)
    expect(above.click(1, 3)).toBe('main.typ:4:4')
    expect(below.click(1, 3)).toBe('main.typ:3:4')
  })

  test('a generated label before the first word of the document lands on that word', () => {
    const a = main('Kestrels #upper[hunt] mice.\n', onPage('Note: Kestrels HUNT mice.'))
    expect(a.spots(0)).toEqual(on(1, 1, 1, 1, 1, 1, 1, [1, 9], [17, 21], [23, 27], 27))
  })

  test('words printed in capitals map character by character', () => {
    const a = main('#upper[shout loud] now.\n', onPage('SHOUT LOUD now.'))
    expect(a.spots(0)).toEqual(on(1, [8, 18], [20, 23], 23))
  })
})

test.describe('which occurrence a run takes', () => {
  test('a document opening with a quotation: the run starts at its opening mark', () => {
    for (const content of ['“Hello,” she said.\n\nThen silence.\n', '"Hello," she said.\n\nThen silence.\n', '(Draft) Kestrels hunt.\n\nThen silence.\n']) {
      const first = content.split('\n')[0]
      const t = first.startsWith('(') ? first : '“Hello,” she said.'
      const a = main(content, onPage(t, 'Then silence.'))
      expect(a.at(0), content).toBe('main.typ:1:1')
      expect(a.spots(0), content).toEqual(on(1, [1, t.length + 1]))
    }
  })

  test('quotes written apart from the word, the decoration of a run of its own', () => {
    const a = main('Intro.\n\nIl a dit « Kestrels » hier.\n\nAfter.\n', onPage('Intro.', 'Il a dit', '«Kestrels»', 'hier.', 'After.'))
    expect(a.at(2)).toBe('main.typ:3:10')
    expect(a.spots(2)).toEqual(on(3, 10, [12, 20], 22))
  })

  test('decoration printed by code: a quoted sentence and an array literal', () => {
    const a = main('Intro.\n\n"Kestrels hunt," she said.\n\n#("alpha", "beta")\n\nAfter.\n', onPage('Intro.', '“Kestrels hunt,” she said.', '("alpha", "beta")', 'After.'))
    expect(a.spots(1)).toEqual(on(3, [1, 27]))
    expect(a.spots(2)).toEqual(on(5, [2, 19]))
  })

  test('a run takes the occurrence with its own separators, not a longer one spelled otherwise', () => {
    const a = main('Intro.\n\nalpha,   beta, gamma.\n\nalpha beta, gamma.\n', onPage('Intro.', 'alpha beta, gamma.'))
    expect(a.at(1)).toBe('main.typ:5:1')
  })

  test('runs that touch in the source each take their own copy', () => {
    const a = main('= T\n\nHa!Ha!\n', onPage('T', 'Ha!', 'Ha!'))
    expect(a.at(1)).toBe('main.typ:3:1')
    expect(a.at(2)).toBe('main.typ:3:4')
  })

  test('two figures with the same caption: each label goes with its own caption', () => {
    const a = main('= T\n\n#figure(rect(), caption: [Kestrels at dawn.])\n\n#figure(rect(), caption: [Kestrels at dawn.])\n\nEnd.\n', onPage('T', 'Figure 1: Kestrels at dawn.', 'Figure 2: Kestrels at dawn.', 'End.'))
    expect(a.at(1)).toBe('main.typ:3:27')
    expect(a.at(2)).toBe('main.typ:5:27')
  })

  test('figures with the same one-word caption or a Japanese caption under a Latin label: each label goes with its own caption', () => {
    const figs = (caption, n) => `= T\n\n${`#figure(rect(), caption: [${caption}])\n\n`.repeat(n)}End.\n`
    const labels = (caption, n) => onPage('T', ...Array.from({ length: n }, (_, k) => `Figure ${k + 1}: ${caption}`), 'End.')
    const ja = main(figs('東京の地図', 2), labels('東京の地図', 2))
    expect([ja.at(1), ja.at(2)]).toEqual(['main.typ:3:27', 'main.typ:5:27'])
    const three = main(figs('Tokyo', 3), labels('Tokyo', 3))
    expect([three.at(1), three.at(2), three.at(3)]).toEqual(['main.typ:3:27', 'main.typ:5:27', 'main.typ:7:27'])
  })

  test('a figure label: the label goes to the caption, each caption letter to itself, also the one the label starts with', () => {
    const a = main('= T\n\n#figure(rect(), caption: [Foxes at dawn.])\n\nEnd.\n', onPage('T', 'Figure 1: Foxes at dawn.', 'End.'))
    expect(a.spots(1)).toEqual(on(3, ...Array(11).fill(27), [28, 41]))
  })

  // Between two paragraphs the source holds a near spelling of the run; its
  // own text stands further down (a float, a note set elsewhere).
  const nearMiss = (near, run) => main(`= T\n\nBefore the text.\n\n${near}\n\nAfter the text.\n\n${run}\n`, onPage('T', 'Before the text.', run, 'After the text.'))

  test('a run lands on its own text, not on a near spelling between its neighbours', () => {
    for (const [near, run] of [
      ['and herons', 'the herons'],
      ['alpha, beta gamma, delta', 'alpha beta gamma, delta'],
      ['alpha beta gamma.', 'alpha beta, gamma.'],
      ['大東京タワー is big.', '東京 is big.']
    ]) expect(nearMiss(near, run).at(2), run).toBe('main.typ:9:1')
    const a = main('= T\n\nBefore big text big.\n\nIt is bigger 大阪\n\nAfter the text.\n\nIt is big 大阪\n', onPage('T', 'Before big text big.', 'It is big 大阪', 'After the text.'))
    expect(a.at(2)).toBe('main.typ:9:1')
  })
})

test.describe('lines of a script without spaces', () => {
  test('a line mixing Latin words lands where all its words are, not where one only ends a longer word', () => {
    const a = main('It is what it is.\n\n東京 this big 大阪.\n\n東京 is big 大阪.\n', onPage('It is what it is.', '東京 is big 大阪.'))
    expect(a.at(1)).toBe('main.typ:5:1')
    const b = main('It is what it is.\n\n大阪 big island 東京.\n\n大阪 big is 東京.\n', onPage('It is what it is.', '大阪 big is 東京.'))
    expect(b.at(1)).toBe('main.typ:5:1')
  })

  test('a line starting inside a word lands after the part the line before shows', () => {
    const a = main('= T\n\n大東京の東京 Skytree と東京タワー。\n', onPage('T', '大東京の', '東京 Skytree と東京', 'タワー。'))
    expect(a.at(1)).toBe('main.typ:3:1')
    expect(a.at(2)).toBe('main.typ:3:5')
    expect(a.at(3)).toBe('main.typ:3:19')
    const b = main('= T\n\n東京の東京 tower is tall 大阪城\n', onPage('T', '東京の', '東京 tower is tall 大阪', '城'))
    expect(b.at(2)).toBe('main.typ:3:4')
  })

  test('a commented word at the very start or end of the document does not hide a line', () => {
    expect(main('// big\n東京 big.\n', onPage('東京 big.')).at(0)).toBe('main.typ:2:1')
    expect(main('Intro big 大阪城\n// big\n', onPage('Intro', 'big 大阪')).at(1)).toBe('main.typ:1:7')
  })

  test('a line ending inside a repeated character: each part lands on its own characters', () => {
    const a = main('= T\n\nははは。\n', onPage('T', 'はは', 'は。'))
    expect(a.at(1)).toBe('main.typ:3:1')
    expect(a.at(2)).toBe('main.typ:3:3')
  })

  test('two figures with the same caption in Japanese: each label goes with its own caption', () => {
    const a = main('#set text(lang: "ja")\n= T\n\n#figure(rect(), caption: [東京の地図])\n\n#figure(rect(), caption: [東京の地図])\n\nEnd.\n', onPage('T', '図 1: 東京の地図', '図 2: 東京の地図', 'End.'))
    expect(a.at(1)).toBe('main.typ:4:27')
    expect(a.at(2)).toBe('main.typ:6:27')
  })

  test('a line opening with a quotation mark: a click before the mark lands on it', () => {
    const a = main('= 見出し\n\n彼は「東京タワー」と言った。\n', onPage('見出し', '彼は', '「東京タ', 'ワー」と言った。'))
    expect(a.spots(2)).toEqual(on(3, [3, 7]))
  })
})
