import { test, expect } from '@playwright/test'
import sync from './preview_sync_module.mjs'

// The Typst scan behind preview ↔ source sync (#149): which source characters
// can show in the preview (DISP: verbatim somewhere; PROD: where they stand),
// and what it collects for alignment (calls, footnotes, list markers, show
// rule text, includes, page headers). Documents are inline and synthetic.

const { lexTypst } = sync
const DISP = 1
const PROD = 2

const lex = (src) => lexTypst(src, (v) => v.endsWith('.typ'))

// The source with every character that lacks `bit` blanked to `·`.
function marked(src, bit) {
  const { flags } = lex(src)
  let out = ''
  for (let k = 0; k < src.length; k++) out += flags[k] & bit ? src[k] : '·'
  return out
}
// What renders where it stands.
const shows = (src) => marked(src, PROD)
// What may show verbatim (here or where a definition is used).
const text = (src) => marked(src, DISP)

// A show rule's printed pieces as source text: `open` is true when the piece
// stops short of the content block's bracket, `gaps` are the embedded
// expressions it reaches through.
function rules(src) {
  const piece = ([a, b, open, gaps]) => ({ text: src.slice(a, b), open, gaps: gaps.map(([g, e]) => src.slice(g, e)) })
  return lex(src).rules.map((r) => ({ pre: piece(r.pre), suf: piece(r.suf), element: r.element }))
}

// Each footnote as [the call it belongs to, the source its arguments span].
const notes = (src) => lex(src).notes.map((n) => [src.slice(n.at, n.at + 'footnote'.length), src.slice(n.from, n.to)])

test.describe('markup', () => {
  test('heading and list markers are syntax at a line start, after indentation and in a content block', () => {
    const src = '= Title\n- item\n  - sub\n\t+ tab\n#block[- inner] #[= x]'
    expect(shows(src)).toBe('· Title·· item···· sub··· tab·#block·· inner· #·· x·')
    expect(lex(src).markers.map((m) => src.slice(m.at, m.at + 2))).toEqual(['- ', '- ', '+ ', '- '])
  })

  test('a marker inside a definition renders where the definition is used', () => {
    const src = '#let z = [- a]\n- b'
    expect(lex(src).markers.map((m) => [src[m.at + 2], m.decl])).toEqual([['a', true], ['b', false]])
  })

  test('comments are hidden; slashes and stars in text are not', () => {
    expect(shows('a /**/ b /* 2*3 */c /* x */yz')).toBe('a ···· b ·········c ·······yz')
    expect(shows('1/2 cup, see https://typst.app now // note')).toBe('1/2 cup, see https://typst.app now ·······')
  })

  test('an escape shows its character, a code point escape or a line break shows none of its source', () => {
    expect(shows('a \\u{41} b \\# c\\ d \\#*e* f\\')).toBe('a ······ b \\# c··d \\#·e· f·')
    expect(shows('Tag \\#')).toBe('Tag \\#')
    expect(shows('set \\#{x} b')).toBe('set \\#{x} b')
  })

  test('raw text shows its content, not its backticks or language tag', () => {
    expect(shows('x `abc` y *b*')).toBe('x ·abc· y ·b·')
    expect(shows('```py code``` z')).toBe('····· code··· z')
    expect(shows('a `` *b*')).toBe('a ·· ·b·')
  })

  test('labels are hidden, references render a number, not their key; mail addresses are text', () => {
    const src = 'Intro <intro> see @intro. Mail x@typst.app or @a here'
    expect(text(src)).toBe('Intro ······· see ······. Mail x@typst.app or ·· here')
    expect(shows(src)).toBe('Intro ······· see @intro. Mail x@typst.app or @a here')
    expect(text('See @.')).toBe('See ·.')
    expect(text('@intro starts, ends @')).toBe('······ starts, ends @')
  })

  test('strong and emphasis delimiters are syntax', () => {
    expect(shows('*bold* _emph_')).toBe('·bold· ·emph·')
  })

  test('nested brackets inside a content block stay its text', () => {
    const src = '#let x = [a [b [c] d] e]\nafter'
    expect(text(src)).toBe('··········a [b [c] d] e··after')
    expect(shows(src)).toBe('·························after')
  })
})

test.describe('embedded expressions', () => {
  test('a hash that starts no expression is text', () => {
    expect(shows('Issue #')).toBe('Issue #')
    expect(lex('Issue #').calls).toEqual([])
    expect(lex('#x').calls.map((c) => c.name)).toEqual(['x'])
  })

  test('a call renders where it stands, its key and parentheses do not', () => {
    expect(shows('#title #(1 + 2) x #[y]')).toBe('#title #······· x #·y·')
    expect(text('#title #(1 + 2) x #[y]')).toBe('······ ········ x ··y·')
  })

  test('a full stop after an embedded name ends the sentence, a field access does not', () => {
    expect(shows('see #x. Next #y.z w')).toBe('see #x. Next #y·· w')
    expect(shows('ends with #x.')).toBe('ends with #x.')
    expect(shows('ends with #x.y')).toBe('ends with #x··')
  })

  test('calls inside a definition are marked as such', () => {
    const src = '#let x = [#emph[a]]\n#let y = f(1)\n#emph[b]'
    expect(lex(src).calls.map((c) => [c.name, c.decl])).toEqual([['emph', true], ['f', true], ['emph', false]])
  })
})

test.describe('math mode', () => {
  test('math shows its symbols, not its delimiters, comments or attachment groups', () => {
    expect(shows('$x$ *b*')).toBe('·x· ·b·')
    expect(shows('$a \\$ b$ $1/2 // half\n$ $a /* note */ * b$ $a*b/2$ after')).toBe(
      '·a ·$ b· ·1/2 ·······\n· ·a ·········· * b· ·a*b/2· after'
    )
    expect(shows('$x "if" y$ $x_(i=1) y^(n+1) f(x)$')).toBe('·x ·if· y· ·x_·i=1· y^·n+1· f(x)·')
  })

  test('an embedded name in math is a call', () => {
    expect(text('$#x$')).toBe('····')
    expect(lex('$#x$').calls.map((c) => c.name)).toEqual(['x'])
  })
})

test.describe('code', () => {
  test('math in a code block shows its symbols', () => {
    expect(shows('#{ $x^2$ } *y*')).toBe('#···x^2··· ·y·')
  })

  test('strings computed in parentheses or a code block show', () => {
    expect(shows('#("Hello" + " world") #{"Hi"}')).toBe('#··Hello····· world·· #··Hi··')
    expect(shows('#("a\\\\") *x* #("say \\"hi\\" now")')).toBe('#("a\\\\") ·x· #("say \\"hi\\" now")')
  })

  test('a shown literal shows its quotes and punctuation, not what follows it', () => {
    expect(text('#("ab", "cd")\n// c')).toBe('·("ab",·"cd")·····')
    expect(text('#(\n  "a",\n  "b"\n)')).toBe('·(···"a",···"b"·)')
  })

  test('a string compared with == or != is a condition, not text', () => {
    expect(shows('#if x=="a" [yes]')).toBe('#···········yes·')
    expect(shows('#if x == "a" [Yes] #if "b" == y [No]')).toBe('#·············Yes················No·')
  })

  test('a string compared across wide padding is still a condition: spaces, tabs, a line break in parentheses', () => {
    const pad = ' '.repeat(8)
    expect(shows(`#if x ==${pad}"a" [Yes]`)).toBe(`#···${'·'.repeat(17)}Yes·`)
    expect(shows(`#if "b"${pad}!= y [No]`)).toBe(`#···${'·'.repeat(17)}No·`)
    expect(shows('#if x ==\t\t\t\t\t\t\t\t"a" [Yes]')).toBe(`#···${'·'.repeat(17)}Yes·`)
    expect(shows('#if (x ==\n  "a") [Yes]')).toBe('#·················Yes·')
    // A string beside a comma, not an operator, still shows.
    expect(shows(`#("b"${pad}, "c")`)).toBe(`#("b"${'·'.repeat(8)},·"c")`)
  })

  test('the key of an .at() lookup is not text; the argument of a function named at is', () => {
    expect(shows('#{ p.at("city") } #p.at("town") #{ at("Paris") }')).toBe('#················ #p··········· #······Paris····')
  })

  test('only the first string of a file call names a file', () => {
    const src = '#image("a.png", alt: "A cat")'
    expect(lex(src).mentions.map((m) => m.value)).toEqual(['a.png'])
    expect(shows(src)).toBe('#image················A cat··')
  })

  test('a slash or star in code is an operator, not a comment', () => {
    expect(shows('#{ 4/2; "s" } #{ 2*3; "t" }')).toBe('#········s··· #········t···')
    expect(shows('#{ /* "old" */ "new" }')).toBe('#···············new···')
  })

  test('let and set start statements in a code block, other names are calls', () => {
    expect(shows('#{ emph[Hi] } #{ let x = "a" }')).toBe('#·······Hi··· #···············')
    expect(lex('#{ strong("a"); emph[b]; x }').calls.map((c) => c.name)).toEqual(['strong', 'emph'])
  })

  test('a let or set typed right after another statement on its line still starts one', () => {
    expect(text('#{ include "a.typ" set text(lang: "fr")\n[Bonjour] }')).toBe('·'.repeat(41) + 'Bonjour···')
    expect(shows('#{ include "a.typ" let x = "Hi"\n[Bonjour] }')).toBe('#' + '·'.repeat(32) + 'Bonjour···')
  })

  test('a show-set rule configures; a show rule replacing text shows its replacement', () => {
    const src = '#show heading.where(level: 1): set text(font: "Inria")\n#show "TODO": "DONE"\n#show heading:set text(font: "Serif")'
    expect(text(src).replace(/·+/g, ' ').trim()).toBe('DONE')
  })
})

test.describe('footnote arguments', () => {
  test('a footnote spans its arguments and content, without the closing bracket', () => {
    expect(notes('#footnote[abc] x')).toEqual([['footnote', 'abc']])
    expect(notes('#footnote(numbering: "*")[text]')).toEqual([['footnote', 'numbering: "*")[text']])
    expect(notes('#emph(x) #emph[y]')).toEqual([])
  })

  test('a footnote in a code block', () => {
    expect(notes('#{ footnote[hi] }')).toEqual([['footnote', 'hi']])
    expect(notes('#{ footnote(numbering: "*")[hi] }')).toEqual([['footnote', 'numbering: "*")[hi']])
    expect(notes('#{ emph[x] }')).toEqual([])
  })
})

test.describe('show rules', () => {
  const heading = { name: 'heading', level: null }

  test('the text around the placeholder reaches through embedded expressions to the bracket', () => {
    expect(rules('#show heading: it => [Kapitel #counter(heading).display(): #it.body]')).toEqual([
      { pre: { text: 'Kapitel #counter(heading).display(): ', open: false, gaps: ['#counter(heading).display()'] }, suf: { text: '', open: false, gaps: [] }, element: heading }
    ])
    expect(rules('#show heading: it => [#it.body, Teil #counter(heading).display()]')).toEqual([
      { pre: { text: '', open: false, gaps: [] }, suf: { text: ', Teil #counter(heading).display()', open: false, gaps: ['#counter(heading).display()'] }, element: heading }
    ])
    expect(rules('#show heading: it => [#smallcaps[Part] One: #it.body]')[0].pre).toEqual({ text: '#smallcaps[Part] One: ', open: false, gaps: ['#smallcaps[Part]'] })
    expect(rules('#show heading: it => [Teil #h(1em) Eins: #it.body]')[0].pre).toEqual({ text: 'Teil #h(1em) Eins: ', open: false, gaps: ['#h(1em)'] })
    expect(rules('#show heading: it => [#pos.x Teil: #it.body]')[0].pre).toEqual({ text: '#pos.x Teil: ', open: false, gaps: ['#pos.x'] })
    expect(rules('#show heading: it => [#counter(heading).display(). #h(1em) Kapitel: #it.body]')[0].pre.gaps).toEqual(['#counter(heading).display()', '#h(1em)'])
    expect(rules('#show heading: it => [#h(1em) [Entwurf] #it.body]')[0].pre).toEqual({ text: '#h(1em) [Entwurf] ', open: false, gaps: ['#h(1em)'] })
  })

  test('strings inside an embedded expression do not end it early', () => {
    expect(rules('#show heading: it => [Kapitel #text(")(") Teil: #it.body]')[0].pre).toEqual({ text: 'Kapitel #text(")(") Teil: ', open: false, gaps: ['#text(")(")'] })
    expect(rules('#show heading: it => [Kapitel #counter(heading).display("I"): #it.body]')[0].pre.gaps).toEqual(['#counter(heading).display("I")'])
    expect(rules('#show heading: it => [Pfad #text("\\\\") Teil: #it.body]')[0].pre).toEqual({ text: 'Pfad #text("\\\\") Teil: ', open: false, gaps: ['#text("\\\\")'] })
  })

  test('a reference before the placeholder stops the text short of the bracket', () => {
    expect(rules('#show heading: it => [Siehe @intro, Kapitel #it.body]')[0].pre).toEqual({ text: ', Kapitel ', open: true, gaps: [] })
  })

  test('a rule prints text only when some letter or digit is left outside the gaps', () => {
    expect(rules('#show heading: it => [#counter(heading).display(): #it.body]')).toEqual([])
    expect(rules('#show heading: it => [S#counter(heading).display(): #it.body]')[0].pre.text).toBe('S#counter(heading).display(): ')
    expect(rules('#show heading: it => [#counter(heading).display() Teil: #it.body]')[0].pre.text).toBe('#counter(heading).display() Teil: ')
    expect(rules('#show heading: it => [(#it.body)]')).toEqual([])
  })

  test('the text after the placeholder ends at the bracket', () => {
    expect(rules('#show heading: it => [#it.body (Part)]')[0].suf).toEqual({ text: ' (Part)', open: false, gaps: [] })
  })

  test('parentheses the rule shows as text around embedded code do not stop the piece short of the bracket', () => {
    expect(rules('#show heading: it => [#it.body (Teil #n, Band #n)]')[0].suf).toEqual({ text: ' (Teil #n, Band #n)', open: false, gaps: ['#n', '#n'] })
    expect(rules('#show heading: it => [(#n Teil): #it.body]')[0].pre).toEqual({ text: '(#n Teil): ', open: false, gaps: ['#n'] })
  })

  test('selectors: where-filters, strings with colons, no space after the colon', () => {
    expect(rules('#show heading.where(level: 1): it => [Part #it.body]')[0].element).toEqual({ name: 'heading', level: 1 })
    expect(rules('#show heading.where(body: [Intro]): it => [Part #it.body]')[0].pre.text).toBe('Part ')
    expect(rules('#show "TODO: x": it => [Fix #it now]')).toEqual([
      { pre: { text: 'Fix ', open: false, gaps: [] }, suf: { text: ' now', open: false, gaps: [] }, element: null }
    ])
    expect(rules('#show "abc": it => [Fix #it now]')[0].pre.text).toBe('Fix ')
    expect(rules('#show "a\\\\": it => [Fix #it now]')[0].pre.text).toBe('Fix ')
    expect(rules('#show heading:it => [Part #it]')[0].pre.text).toBe('Part ')
  })

  test('a comment in the selector, with a colon in it, does not end the selector', () => {
    expect(rules('#show /* a: b */ heading: it => [Part #it]').map((r) => r.pre.text)).toEqual(['Part '])
    expect(rules('#show heading /* x: y */: it => [#it (Part)]').map((r) => r.suf.text)).toEqual([' (Part)'])
  })

  test('a rule without a selector or with the placeholder in a comment prints nothing per element', () => {
    expect(rules('#show: doc => [Draft #doc]')).toEqual([])
    expect(rules('#show heading: it => it.body // not #it')).toEqual([])
  })
})

test.describe('includes and page content', () => {
  test('include targets: a string, with or without parentheses and spaces', () => {
    const src = '#include ("chapter.typ")\n#include ( "a.typ" )\n#include "b.typ"'
    expect(lex(src).includes.map((x) => x.target)).toEqual(['chapter.typ', 'a.typ', 'b.typ'])
  })

  test('an include names its file through a let binding; a bare include at the end names none', () => {
    expect(lex('#let ch = "a.typ"\n#include ch\n#include').includes.map((x) => x.target)).toEqual(['a.typ'])
  })

  test('only header, footer, background and foreground of a page rule are page content', () => {
    const src = '#set page(header: [H], margin: 1cm, footer: [F])'
    expect(lex(src).pages.map((p) => src.slice(p.from, p.to))).toEqual(['H]', 'F]'])
  })
})
