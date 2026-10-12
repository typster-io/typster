import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Preview ↔ source sync (#149): a click in the rendered preview moves the
// editor's caret to the matching source line (switching files when the text
// came from an `#include`d file), and a resting caret scrolls the preview to
// its run and flashes it.
test.setTimeout(90_000)

// The test database keeps the projects of earlier runs (and of runs going on
// beside this one), so every project gets a name no other row carries, and
// its row is found by its whole title: a name that is the start of another
// ("E2E Sync Outline", "E2E Sync Outline Entry") must not match both.
async function createProjectAndOpenEditor(page, name) {
  const unique = `${name} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await page.goto('/projects')
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
  await page.locator('#new-project-button').click()
  await expect(page.locator('.ts-dialog')).toBeVisible({ timeout: 10_000 })
  await page.locator('.ts-dialog input[name="name"]').fill(unique)
  await page.locator('.ts-dialog button[type="submit"]').click()
  await expect(page.locator('.ts-dialog')).not.toBeVisible()
  const title = page.locator('.ts-list__title', { hasText: new RegExp(`^\\s*${escapeRe(unique)}\\s*$`) })
  const row = page.locator('.ts-list__row').filter({ has: title })
  await expect(row).toBeVisible()
  await row.getByRole('link', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/projects\/.+\/edit/)
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
}

async function createFile(page, path) {
  await page.locator('[phx-click="new_file"]').first().click()
  const draft = page.locator('#new-file-form input[name="path"]')
  await expect(draft).toBeVisible()
  await draft.fill(path)
  await draft.press('Enter')
  const cm = page.locator('#editor-container .cm-content')
  await expect(cm).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.ts-formatbar__hint')).toContainText(path)
  return cm
}

// Replace the whole buffer. Select-all needs the platform modifier (plain
// Control+A is "line start" in CodeMirror on macOS); the edit autosaves, and
// `waitForSaved` sees that round-trip through, so sibling files see the text.
// With collaboration on (the dev server), a shared buffer's text arrives a
// moment after it opens, within the editor's 3 s grace, and would merge with
// the new text (a project's first file brings its starter text that way), so
// the replacement waits for it first.
async function replaceBuffer(page, cm, text) {
  if ((await page.locator('#editor-container').getAttribute('data-collab')) === 'true') {
    await expect.poll(() => cm.innerText(), { timeout: 3_000 }).not.toBe('\n').catch(() => {})
  }
  await cm.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
}

async function waitForSaved(page) {
  await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saving/, { timeout: 8_000 })
  await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saved/, { timeout: 15_000 })
}

function run(page, text) {
  return page.locator('#typst-svg-output .tsel').filter({ hasText: text }).first()
}

// Distance (px) between the flash and the run holding `text`, read in one
// pass inside the page so a scroll in flight cannot skew it.
function flashGap(pane, text) {
  const flash = pane.querySelector('.ts-preview__flash')
  const sel = [...pane.querySelectorAll('.tsel')].find((n) => n.textContent.includes(text))
  if (!flash || !sel) return Infinity
  const f = flash.getBoundingClientRect()
  const t = sel.getBoundingClientRect()
  return Math.abs(f.top - t.top) + Math.abs(f.left - t.left)
}

// Distance (px) between the flash and the `nth` element of the preview
// matching `selector` whose text (trimmed) matches `pattern` (all elements
// when no pattern is given: pictures).
function flashGapNth(pane, { selector, pattern, nth }) {
  const flash = pane.querySelector('.ts-preview__flash')
  const re = pattern ? new RegExp(pattern) : null
  const hits = [...pane.querySelectorAll(selector)].filter((n) => !re || re.test(n.textContent.trim()))
  const target = hits[nth]
  if (!flash || !target) return Infinity
  const f = flash.getBoundingClientRect()
  const t = target.getBoundingClientRect()
  return Math.abs(f.top - t.top) + Math.abs(f.left - t.left)
}

// Whether the flash lies between the run holding `from` and the run holding
// `to` (the band of the preview a printed table fills).
function flashBetween(pane, { from, to }) {
  const flash = pane.querySelector('.ts-preview__flash')
  const runs = [...pane.querySelectorAll('.tsel')]
  const a = runs.find((n) => n.textContent.includes(from))
  const b = runs.find((n) => n.textContent.includes(to))
  if (!flash || !a || !b) return false
  const f = flash.getBoundingClientRect()
  const mid = (f.top + f.bottom) / 2
  return mid > a.getBoundingClientRect().bottom && mid < b.getBoundingClientRect().top
}

const cursor = (page) => page.locator('#status-cursor')
const activeTab = (page) => page.locator('.ts-tab.is-active .ts-tab__label')

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The runs whose whole text (trimmed) is `text`, in document order.
function exactRuns(page, text) {
  return page.locator('#typst-svg-output .tsel').filter({ hasText: new RegExp(`^\\s*${escapeRe(text)}\\s*$`) })
}

async function selectFile(page, name) {
  await page.locator('#file-tree-main [phx-click="select_file"]').filter({ hasText: name }).first().click()
  await expect(page.locator('.ts-formatbar__hint')).toContainText(name)
}

async function uploadPictures(page, names) {
  const png = readFileSync(join(here, 'fixtures/dot.png'))
  await page
    .locator('#dropped-upload-form input[type=file]')
    .setInputFiles(names.map((name) => ({ name, mimeType: 'image/png', buffer: png })))
  for (const name of names) await expect(page.locator('#asset-tree li').filter({ hasText: name })).toHaveCount(1)
}

// Click character `index` of a run's text (leading whitespace not counted).
// The click lands a third of the way into the character as drawn: its share
// of its glyph's advance (the preview reads clicks off the glyphs). Each
// glyph draws one grapheme (a letter typed with combining marks is one), or
// several in a ligature: a word whose glyphs miss its graphemes is matched
// against the glyphs the page draws for one grapheme elsewhere, and must
// match one way only. Only a run whose glyphs cannot be read so falls back
// to the hidden text layer's box, which is set in a system font and so
// differs between platforms. The caret then goes just before the character
// and the expected column is that character's own. The first pixel of a run is avoided on purpose: there the
// browser reports no character at all. A glyph too narrow for that (a
// period) is clicked on its right part with `after`, and the caret is then
// reported after it. The point is read until two reads agree, so a scroll
// still settling cannot move the target.
async function clickChar(page, loc, index, after = false) {
  // A compile landing meanwhile replaces the SVG; the locator then finds
  // the run again in the new one.
  for (let tries = 0; ; tries++) {
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 })
      break
    } catch (err) {
      if (tries >= 5 || !/not attached/.test(err.message)) throw err
      await page.waitForTimeout(100)
    }
  }
  const point = () =>
    loc.evaluate((el, [i, after]) => {
      let at = el.textContent.length - el.textContent.trimStart().length + i
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      const graphemes = (t) => Array.from(segmenter.segment(t), (x) => x.segment)
      const ref = (u) => (u.getAttribute('href') || u.getAttribute('xlink:href') || '').replace(/^#/, '')
      // A run's graphemes and glyphs, and the two cut into words and gaps
      // (graphemes at whitespace, glyphs at blank ones: no outline, a
      // space), paired; no words when the two do not cut alike.
      const wordsOf = (sel) => {
        const g = sel.closest('.typst-text')
        const uses = g ? [...g.children].filter((c) => c.tagName.toLowerCase() === 'use') : []
        const gs = graphemes(sel.textContent)
        const blank = (u) => {
          const def = ref(u) && document.getElementById(ref(u))
          return !def || !(def.getAttribute('d') || def.children.length)
        }
        const cut = (list, gap) => {
          const out = []
          list.forEach((v, k) => {
            const last = out[out.length - 1]
            if (last && last.gap === gap(v)) last.to = k + 1
            else out.push({ gap: gap(v), from: k, to: k + 1 })
          })
          return out
        }
        const cw = cut(gs, (c) => /^\s+$/u.test(c))
        const gw = cut(uses, blank)
        const words = cw.length === gw.length && cw.every((w, k) => w.gap === gw[k].gap) ? cw.map((c, k) => ({ c, g: gw[k] })) : []
        return { uses, gs, words }
      }
      // Which glyph draws the character, and its share of that glyph
      // (part `j` of `n`): null when the glyphs cannot tell.
      const drawnAt = (run) => {
        const { uses, gs, words } = run
        let ci = 0
        for (let len = 0; ci < gs.length && len + gs[ci].length <= at; ci++) len += gs[ci].length
        if (uses.length === gs.length) return { k: ci, j: 0, n: 1 }
        const word = words.find((w) => ci < w.c.to)
        if (!word) return null
        const { c, g } = word
        if (c.to - c.from === g.to - g.from) return { k: g.from + ci - c.from, j: 0, n: 1 }
        // The grapheme each glyph draws in the page's words drawn one glyph
        // per grapheme (null where two disagree).
        const lex = new Map()
        for (const sel of (el.closest('.typst-page') || document).querySelectorAll('.tsel')) {
          const r = wordsOf(sel)
          for (const w of r.words) {
            if (w.c.to - w.c.from !== w.g.to - w.g.from) continue
            for (let k = 0; k < w.g.to - w.g.from; k++) {
              const id = ref(r.uses[w.g.from + k])
              const ch = r.gs[w.c.from + k]
              lex.set(id, lex.has(id) && lex.get(id) !== ch ? null : ch)
            }
          }
        }
        // Every way the word's glyphs draw its graphemes: a known glyph its
        // own one, any other at least one.
        const ways = []
        const walk = (k, at, counts) => {
          if (ways.length > 1) return
          if (k === g.to) {
            if (at === c.to) ways.push(counts)
            return
          }
          const known = lex.get(ref(uses[k]))
          if (known) {
            if (gs[at] === known) walk(k + 1, at + 1, [...counts, 1])
            return
          }
          for (let m = 1; at + m <= c.to - (g.to - k - 1); m++) walk(k + 1, at + m, [...counts, m])
        }
        walk(g.from, c.from, [])
        if (ways.length !== 1) return null
        let from = c.from
        for (let k = 0; k < ways[0].length; k++) {
          if (ci < from + ways[0][k]) return { k: g.from + k, j: ci - from, n: ways[0][k] }
          from += ways[0][k]
        }
        return null
      }
      // Aim at the drawn glyph: its pen position and advance, in screen
      // coordinates.
      const run = wordsOf(el)
      const hit = run.uses.length ? drawnAt(run) : null
      if (hit) {
        const { k, j, n } = hit
        const uses = run.uses
        const m = el.closest('.typst-text').getScreenCTM()
        const fo = el.closest('foreignObject')
        const fm = fo.getScreenCTM()
        const sx = (x) => m.a * x + m.e
        const g0 = sx(+uses[k].getAttribute('x'))
        const g1 = k + 1 < uses.length ? sx(+uses[k + 1].getAttribute('x')) : fm.a * (+fo.getAttribute('x') + +fo.getAttribute('width')) + fm.e
        const x0 = g0 + ((g1 - g0) * j) / n
        const x1 = g0 + ((g1 - g0) * (j + 1)) / n
        const b = el.getBoundingClientRect()
        return { x: after ? x0 + ((x1 - x0) * 3) / 4 : x0 + Math.max(1, (x1 - x0) / 3), y: b.top + b.height / 2 }
      }
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (at < node.length) {
          const r = document.createRange()
          r.setStart(node, at)
          r.setEnd(node, at + 1)
          const b = r.getBoundingClientRect()
          const x = after ? b.left + (b.width * 3) / 4 : b.left + Math.max(1, b.width / 3)
          return { x, y: b.top + b.height / 2 }
        }
        at -= node.length
      }
      return null
    }, [index, after]).catch(() => null)
  let pt = await point()
  for (let tries = 0; tries < 20; tries++) {
    await page.waitForTimeout(50)
    const again = await point()
    if (pt && again && pt.x === again.x && pt.y === again.y) break
    pt = again
  }
  expect(pt, `character ${index} of the run`).not.toBeNull()
  await page.mouse.click(pt.x, pt.y)
}

// Click the first character of `needle` inside the run.
async function clickText(page, loc, needle) {
  const index = (await loc.textContent()).trim().indexOf(needle)
  expect(index, `"${needle}" in the run`).toBeGreaterThanOrEqual(0)
  await clickChar(page, loc, index)
}

// Count `.ts-preview__flash` insertions into the preview pane from now on.
async function countFlashes(page) {
  await page.locator('#preview-container').evaluate((el) => {
    window.__flashes = 0
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.classList?.contains('ts-preview__flash')) window.__flashes++
    }).observe(el, { childList: true })
  })
  return () => page.evaluate(() => window.__flashes)
}

// The column of `needle` in a source line, 1-based.
function colOf(line, needle) {
  const i = line.indexOf(needle)
  if (i < 0) throw new Error(`${needle} not in ${line}`)
  return i + 1
}

test.describe('Preview ↔ source sync', () => {
  test('clicking the preview moves the caret to the matching source line', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Click')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(
      page,
      cm,
      '= Alpha heading\n\nFirst paragraph about kestrels.\n\n== Beta section\n\nSecond paragraph about herons.\n'
    )
    await expect(run(page, 'herons')).toBeVisible({ timeout: 30_000 })

    // The caret lands on the clicked character, inside the sentence.
    await clickChar(page, run(page, 'herons'), 9)
    await expect(cursor(page)).toHaveText(/Ln 7, Col 10\b/)
    await expect(page.locator('#editor-container .cm-activeLine')).toContainText('herons')

    // Clicking the start of a run puts the caret at its first character.
    await run(page, 'herons').click({ position: { x: 1, y: 4 } })
    await expect(cursor(page)).toHaveText(/Ln 7, Col 1\b/)

    // A heading maps onto its own line, past the `== ` marker, character by
    // character.
    await run(page, 'Beta section').click({ position: { x: 1, y: 4 } })
    await expect(cursor(page)).toHaveText(/Ln 5, Col 4\b/)
    await clickChar(page, run(page, 'Beta section'), 5)
    await expect(cursor(page)).toHaveText(/Ln 5, Col 9\b/)
  })

  test('clicking text from an included file opens that file at its line', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Include')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, '= Main file\n\nOpening paragraph about kestrels.\n\n#include "ch1.typ"\n')
    await waitForSaved(page)

    const ch1 = await createFile(page, 'ch1.typ')
    await replaceBuffer(page, ch1, '== Chapter one\n\nIncluded paragraph about otters.\n')
    await waitForSaved(page)

    // Back to the entrypoint: the preview compiles the active buffer, with the
    // include resolved from the saved project sources.
    await page.locator('#file-tree-main [phx-click="select_file"]').filter({ hasText: 'main.typ' }).first().click()
    await expect(page.locator('.ts-formatbar__hint')).toContainText('main.typ')
    await expect(run(page, 'otters')).toBeVisible({ timeout: 30_000 })

    await run(page, 'otters').click({ position: { x: 1, y: 4 } })

    await expect(page.locator('.ts-tab.is-active .ts-tab__label')).toContainText('ch1.typ')
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 3, Col 1\b/)
    await expect(page.locator('#editor-container .cm-activeLine')).toContainText('otters')

    // The preview keeps compiling main.typ: the chapter is not rendered on its
    // own, and editing it re-renders the whole document.
    await page.keyboard.press('End')
    await page.keyboard.insertText(' Added about badgers.')
    await expect(run(page, 'badgers')).toBeVisible({ timeout: 30_000 })
    await expect(run(page, 'kestrels')).toBeVisible()
    await expect(page.locator('#preview-error')).not.toBeVisible()

    // Opening a file from the tree makes it the previewed document again.
    await page.locator('#file-tree-main [phx-click="select_file"]').filter({ hasText: 'ch1.typ' }).first().click()
    await expect(run(page, 'badgers')).toBeVisible({ timeout: 30_000 })
    await expect(run(page, 'kestrels')).toHaveCount(0)
  })

  test('chapters included from code land in their files, a commented-out include never', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Include Forms')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(
      page,
      main,
      '= Main\n\nOpening paragraph about kestrels.\n\n/* #include "old.typ" */\n#{ include "ch1.typ" }\n\n#include("ch2.typ")\n\nClosing paragraph about herons.\n'
    )
    await waitForSaved(page)
    // The commented-out draft holds the very text of chapter one.
    for (const [path, text] of [
      ['old.typ', 'Chapter text about otters.\n'],
      ['ch1.typ', 'Chapter text about otters.\n'],
      ['ch2.typ', 'Second chapter about beavers.\n']
    ]) {
      const cm = await createFile(page, path)
      await replaceBuffer(page, cm, text)
      await waitForSaved(page)
    }
    await selectFile(page, 'main.typ')
    await expect(run(page, 'beavers')).toBeVisible({ timeout: 30_000 })

    await clickChar(page, run(page, 'otters'), 0)
    await expect(activeTab(page)).toContainText('ch1.typ')
    await expect(cursor(page)).toHaveText(/Ln 1, Col 1\b/)
    await clickChar(page, run(page, 'beavers'), 7)
    await expect(activeTab(page)).toContainText('ch2.typ')
    await expect(cursor(page)).toHaveText(/Ln 1, Col 8\b/)
    await clickChar(page, run(page, 'herons'), 0)
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(/Ln 10, Col 1\b/)
  })

  test('a paragraph joining two included files sends each part to its own file', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Joined Includes')
    const main = await createFile(page, 'main.typ')
    // No blank line between the includes: Typst sets both chapters in one
    // paragraph, so one line of the preview holds text of two files.
    await replaceBuffer(page, main, '= Main\n\nOpening paragraph about kestrels.\n\n#include "ch1.typ"\n#include "ch2.typ"\n\nClosing paragraph about herons.\n')
    await waitForSaved(page)
    for (const [path, text] of [
      ['ch1.typ', 'Chapter text about otters.\n'],
      ['ch2.typ', 'Second chapter about beavers.\n']
    ]) {
      const cm = await createFile(page, path)
      await replaceBuffer(page, cm, text)
      await waitForSaved(page)
    }
    await selectFile(page, 'main.typ')
    const joined = run(page, 'about otters')
    await expect(joined).toContainText('beavers', { timeout: 30_000 })

    await clickText(page, joined, 'otters')
    await expect(activeTab(page)).toContainText('ch1.typ')
    await expect(cursor(page)).toHaveText(/Ln 1, Col 20\b/)
    await clickText(page, joined, 'beavers')
    await expect(activeTab(page)).toContainText('ch2.typ')
    await expect(cursor(page)).toHaveText(/Ln 1, Col 22\b/)
  })

  test('a printed data file resolves to the data file, brackets included', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Data')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, '= Data\n\nOpening paragraph about kestrels.\n\n#csv("birds.csv")\n')
    await waitForSaved(page)
    const csv = await createFile(page, 'birds.csv')
    await replaceBuffer(page, csv, 'bird,habitat\nheron,a long-legged wading bird of marshes\n')
    await waitForSaved(page)
    await page.locator('#file-tree-main [phx-click="select_file"]').filter({ hasText: 'main.typ' }).first().click()
    await expect(run(page, 'wading')).toBeVisible({ timeout: 30_000 })

    // The printed row resolves to its CSV line, and a click inside a word of
    // the long cell lands on that character of the cell (`wa|ding`).
    const row = run(page, 'wading')
    await clickText(page, row, 'wading')
    await expect(activeTab(page)).toContainText('birds.csv')
    await expect(cursor(page)).toHaveText(/Ln 2, Col 21\b/)
    await clickChar(page, row, (await row.textContent()).trim().indexOf('wading') + 2)
    await expect(cursor(page)).toHaveText(/Ln 2, Col 23\b/)

    // The printed quotes are not in the CSV: a click after the opening quote
    // of each short cell lands on that character of the cell (`he|ron`,
    // `bi|rd`).
    await clickChar(page, exactRuns(page, '"heron"').first(), 3)
    await expect(cursor(page)).toHaveText(/Ln 2, Col 3\b/)
    await clickChar(page, exactRuns(page, '"bird"').first(), 3)
    await expect(cursor(page)).toHaveText(/Ln 1, Col 3\b/)

    // The bare bracket opening the first row goes to the start of that row,
    // not to a body line.
    await clickChar(page, exactRuns(page, '(').first(), 0)
    await expect(activeTab(page)).toContainText('birds.csv')
    await expect(cursor(page)).toHaveText(/Ln 1, Col 1\b/)
  })

  test('a picture jumps to its #image line and the caret there flashes it', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Image')
    const cm = await createFile(page, 'main.typ')
    // A small red PNG, uploaded through the sidebar's picker.
    const png = readFileSync(join(here, 'fixtures/dot.png'))
    await page.locator('#dropped-upload-form input[type=file]').setInputFiles([{ name: 'dot.png', mimeType: 'image/png', buffer: png }])
    await expect(page.locator('#asset-tree li').filter({ hasText: 'dot.png' })).toHaveCount(1)

    await replaceBuffer(page, cm, '= Pictures\n\nParagraph about kestrels.\n\n#image("assets/dot.png", width: 4cm)\n\nParagraph about herons.\n')
    const picture = page.locator('#typst-svg-output image').first()
    await expect(picture).toBeVisible({ timeout: 30_000 })
    await expect(run(page, 'herons')).toBeVisible()

    // A picture has no character of its own: the caret goes to the end of
    // its line, `#image("assets/dot.png", width: 4cm)`.
    await picture.click()
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 5, Col 37\b/)
    await expect(page.locator('#editor-container .cm-activeLine')).toContainText('#image')

    // Caret on the paragraph after, then back on the #image line: the flash
    // lands on the picture.
    await cm.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(400)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    const pane = page.locator('#preview-container')
    await expect.poll(
      () =>
        pane.evaluate((el) => {
          const flash = el.querySelector('.ts-preview__flash')
          const img = el.querySelector('image')
          if (!flash || !img) return Infinity
          return Math.abs(flash.getBoundingClientRect().top - img.getBoundingClientRect().top)
        }),
      { timeout: 5_000 }
    ).toBeLessThan(16)

    // The flash tints what it marks instead of covering it, in both themes:
    // its background lets the picture through.
    for (const theme of ['light', 'dark']) {
      const background = await pane.evaluate((el, theme) => {
        const before = document.documentElement.getAttribute('data-theme')
        document.documentElement.setAttribute('data-theme', theme)
        const probe = document.createElement('div')
        probe.className = 'ts-preview__flash'
        el.appendChild(probe)
        const color = getComputedStyle(probe).backgroundColor
        probe.remove()
        if (before == null) document.documentElement.removeAttribute('data-theme')
        else document.documentElement.setAttribute('data-theme', before)
        return color
      }, theme)
      const alpha = background.match(/\/\s*([\d.]+)\s*\)$/) || background.match(/^rgba\(.*,\s*([\d.]+)\)$/)
      expect(alpha, `${theme} flash background ${background}`).not.toBeNull()
      expect(Number(alpha[1])).toBeGreaterThan(0)
      expect(Number(alpha[1])).toBeLessThan(0.5)
    }
  })

  test('a short heading after printed data stays in the document', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Short Heading')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, '= Data\n\nOpening paragraph about kestrels.\n\n#csv("birds.csv")\n\n#lorem(40)\n\n== fji\n\nTail paragraph about herons.\n')
    await waitForSaved(page)
    const csv = await createFile(page, 'birds.csv')
    await replaceBuffer(page, csv, 'bird,habitat\nheron,marsh\n')
    await waitForSaved(page)
    await page.locator('#file-tree-main [phx-click="select_file"]').filter({ hasText: 'main.typ' }).first().click()
    await expect(run(page, 'herons')).toBeVisible({ timeout: 30_000 })

    // Three letters are too few to search for, yet the line showing exactly
    // that text is the heading's, not a cell of the CSV printed before it.
    await clickChar(page, exactRuns(page, 'fji').first(), 0)
    await expect(page.locator('.ts-tab.is-active .ts-tab__label')).toContainText('main.typ')
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 9, Col 4\b/)
    await expect(page.locator('#editor-container .cm-activeLine')).toContainText('== fji')
  })

  test('generated text lands on the call that produced it', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Lorem')
    const cm = await createFile(page, 'main.typ')
    // Lorem has no source text to match; the paragraph belongs to `#lorem`.
    await replaceBuffer(page, cm, '= Filler\n\nA real sentence about kestrels.\n\n#lorem(60)\n\n== After\n\nAnother real sentence about herons.\n')
    await expect(run(page, 'herons')).toBeVisible({ timeout: 30_000 })

    // Generated text has no character to land on; the caret goes to the
    // end of the call's line.
    await run(page, 'ipsum').click()
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 5, Col 11\b/)

    // A later line of the same paragraph maps to the same call, not to the
    // heading that follows it.
    await page.locator('#typst-svg-output .tsel').filter({ hasText: /\b(?:tempor|labore|dolore|magna|aliqua)\b/ }).last().click()
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 5, Col 11\b/)
  })

  test('list bullets and heading numbers land on their own line', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Markers')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(
      page,
      cm,
      '#set heading(numbering: "1.")\n= Numbered heading about kestrels\n\n- bullet about herons\n- bullet about otters\n'
    )
    await expect(run(page, 'otters')).toBeVisible({ timeout: 30_000 })

    // The generated "1." in front of the heading belongs to the heading line
    // (a marker has no character of its own; the caret goes to the line
    // start the marker was placed at).
    await page.locator('#typst-svg-output .tsel').filter({ hasText: /^1\.$/ }).first().click()
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 2, Col 1\b/)

    // The second bullet glyph belongs to the second item's line.
    await page.locator('#typst-svg-output .tsel').filter({ hasText: /^•$/ }).nth(1).click()
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 5, Col 1\b/)
  })

  test('the previewed document survives a data file, a closed tab and a quick jump', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Entry')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, '= Main file\n\nOpening paragraph about kestrels.\n\n#include "ch1.typ"\n\n#csv("data.csv")\n')
    await waitForSaved(page)
    const ch1 = await createFile(page, 'ch1.typ')
    await replaceBuffer(page, ch1, '== Chapter one\n\nIncluded paragraph about otters.\n')
    await waitForSaved(page)
    const csv = await createFile(page, 'data.csv')
    await replaceBuffer(page, csv, 'bird,note\nheron,wades\n')
    await waitForSaved(page)

    // Choosing main.typ previews the whole document.
    await page.locator('#file-tree-main [phx-click="select_file"]').filter({ hasText: 'main.typ' }).first().click()
    await expect(run(page, 'otters')).toBeVisible({ timeout: 30_000 })

    // Opening a CSV from the tree keeps previewing the document, and a click
    // on the (unchanged) preview comes back to main.typ without compiling the
    // CSV as Typst.
    await page.locator('#file-tree-main [phx-click="select_file"]').filter({ hasText: 'data.csv' }).first().click()
    await expect(page.locator('.ts-formatbar__hint')).toContainText('data.csv')
    await run(page, 'kestrels').click({ position: { x: 1, y: 4 } })
    await expect(page.locator('.ts-formatbar__hint')).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(/Ln 3, Col 1\b/)
    await page.keyboard.press('End')
    await page.keyboard.insertText(' Added about badgers.')
    await expect(run(page, 'badgers')).toBeVisible({ timeout: 30_000 })
    await expect(run(page, 'otters')).toBeVisible()
    await expect(page.locator('#preview-error')).not.toBeVisible()

    // Edits made right before a preview jump are not lost to the switch.
    await page.keyboard.insertText(' Then lynxes.')
    await run(page, 'otters').click()
    await expect(page.locator('.ts-tab.is-active .ts-tab__label')).toContainText('ch1.typ')
    await expect(run(page, 'lynxes')).toBeVisible({ timeout: 30_000 })

    // Closing the jumped-to tab activates another tab (here the CSV) but keeps
    // the document in the preview.
    await page.locator('.ts-tab.is-active .ts-tab__close').click()
    await expect(page.locator('.ts-formatbar__hint')).toContainText('data.csv')
    await page.locator('#editor-container .cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('stoat,runs\n')
    await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saved/, { timeout: 15_000 })
    // main.typ prints the CSV, so the new row shows up in the document; the
    // chapter and the opening paragraph are still there, so the CSV was not
    // compiled as the entry.
    await expect(run(page, 'stoat')).toBeVisible({ timeout: 30_000 })
    await expect(run(page, 'kestrels')).toBeVisible()
    await expect(run(page, 'otters')).toBeVisible()
    await expect(run(page, 'lynxes')).toBeVisible()
    await expect(page.locator('#preview-error')).not.toBeVisible()
  })

  test('re-selecting the open file from the tree keeps unsaved keystrokes', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Reopen')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, '= Root\n\nParagraph about kestrels.\n')
    await waitForSaved(page)

    // Type, then click the file in the tree before the 500 ms autosave fires.
    await page.keyboard.insertText(' Also pumas.')
    await page.locator('#file-tree-main [phx-click="select_file"]').filter({ hasText: 'main.typ' }).first().click()

    await expect(page.locator('#editor-container .cm-content')).toContainText('pumas')
    await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saved/, { timeout: 15_000 })
    await expect(run(page, 'pumas')).toBeVisible({ timeout: 30_000 })
  })

  test('with reduced motion the flash still sits on its run after a scroll', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await createProjectAndOpenEditor(page, 'E2E Sync Reduced')
    const cm = await createFile(page, 'main.typ')
    const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} keeps the page count honest.`)
    await replaceBuffer(page, cm, `= Follow me\n\n${filler.join('\n\n')}\n\nClosing paragraph about wombats.\n`)
    await expect(run(page, 'wombats')).toBeVisible({ timeout: 30_000 })

    await cm.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('ArrowUp')

    const pane = page.locator('#preview-container')
    await expect(pane.locator('.ts-preview__flash')).toBeAttached({ timeout: 5_000 })
    await expect.poll(() => pane.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(0)
    // The click into the editor flashes its own line first; poll until the
    // flash for the caret's final line is on its run.
    await expect.poll(() => pane.evaluate(flashGap, 'wombats'), { timeout: 5_000 }).toBeLessThan(16)
  })

  test('a resting caret scrolls the preview to its run and flashes it', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Follow')
    const cm = await createFile(page, 'main.typ')
    const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} keeps the page count honest.`)
    await replaceBuffer(page, cm, `= Follow me\n\n${filler.join('\n\n')}\n\nClosing paragraph about wombats.\n`)
    await expect(run(page, 'wombats')).toBeVisible({ timeout: 30_000 })

    const pane = page.locator('#preview-container')
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0)

    // Move the caret (no edit) to the last paragraph.
    await cm.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('ArrowUp')

    await expect(page.locator('#preview-container .ts-preview__flash')).toBeAttached({ timeout: 5_000 })
    await expect.poll(() => pane.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(0)

    // The flash sits over the run (both boxes read in one pass, so a smooth
    // scroll still in flight cannot skew the comparison).
    await expect.poll(() => pane.evaluate(flashGap, 'wombats'), { timeout: 5_000 }).toBeLessThan(16)
  })
  // A main.typ that includes two chapters, selected so the preview shows the
  // whole document.
  async function chaptersProject(page, name, mainExtra = '') {
    await createProjectAndOpenEditor(page, name)
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(
      page,
      main,
      `= Main file\n\nOpening paragraph about kestrels.\n\n#include "ch1.typ"\n\n#include "ch2.typ"\n${mainExtra}`
    )
    await waitForSaved(page)
    const ch1 = await createFile(page, 'ch1.typ')
    await replaceBuffer(page, ch1, '== Chapter one\n\nIncluded paragraph about otters.\n')
    await waitForSaved(page)
    const ch2 = await createFile(page, 'ch2.typ')
    await replaceBuffer(page, ch2, '== Chapter two\n\nSecond chapter text about beavers.\n')
    await waitForSaved(page)
    await page.locator('#file-tree-main [phx-click="select_file"]').filter({ hasText: 'main.typ' }).first().click()
    await expect(page.locator('.ts-formatbar__hint')).toContainText('main.typ')
    await expect(run(page, 'beavers')).toBeVisible({ timeout: 30_000 })
  }

  test('on a slow link the last of two quick preview clicks wins', async ({ page }) => {
    await chaptersProject(page, 'E2E Sync Race')
    await page.evaluate(() => window.liveSocket.enableLatencySim(300))
    try {
      // Into a chapter, then back to the open file before the first reply:
      // the late reply must not switch to the chapter.
      await run(page, 'otters').click({ position: { x: 1, y: 4 } })
      await page.waitForTimeout(80)
      await run(page, 'kestrels').click({ position: { x: 1, y: 4 } })
      await page.waitForTimeout(1_500)
      await expect(page.locator('.ts-tab.is-active .ts-tab__label')).toContainText('main.typ')
      await expect(page.locator('#status-cursor')).toHaveText(/Ln 3, Col 1\b/)
      await expect(page.locator('#editor-container .cm-activeLine')).toContainText('kestrels')

      // Into one chapter, then another: the second chapter opens at its line.
      await run(page, 'otters').click({ position: { x: 1, y: 4 } })
      await page.waitForTimeout(100)
      await run(page, 'beavers').click({ position: { x: 1, y: 4 } })
      await expect(page.locator('.ts-tab.is-active .ts-tab__label')).toContainText('ch2.typ', { timeout: 5_000 })
      await expect(page.locator('#status-cursor')).toHaveText(/Ln 3, Col 1\b/)
      await expect(page.locator('#editor-container .cm-activeLine')).toContainText('beavers')
      await page.waitForTimeout(1_000)
      await expect(page.locator('.ts-tab.is-active .ts-tab__label')).toContainText('ch2.typ')
    } finally {
      await page.evaluate(() => window.liveSocket.disableLatencySim())
    }
  })

  test('a caret-follow still waiting does not scroll away from a click into another file', async ({ page }) => {
    const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} keeps the page count honest.`)
    await chaptersProject(page, 'E2E Sync Follow Race', `\n${filler.join('\n\n')}\n\nClosing paragraph about falcons.\n`)
    const pane = page.locator('#preview-container')

    // Caret near the end, preview back at the top where the chapter shows.
    await run(page, 'falcons').click()
    await expect(page.locator('#editor-container .cm-activeLine')).toContainText('falcons')
    await pane.evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }))
    await page.evaluate(() => window.liveSocket.enableLatencySim(400))
    try {
      // The arrow keys arm the follow; the click lands before it fires and
      // before the server answers.
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('ArrowUp')
      await run(page, 'otters').click({ position: { x: 1, y: 4 } })
      await expect(page.locator('.ts-tab.is-active .ts-tab__label')).toContainText('ch1.typ', { timeout: 5_000 })
      await page.waitForTimeout(600)
      const visible = await pane.evaluate((el) => {
        const sel = [...el.querySelectorAll('.tsel')].find((n) => n.textContent.includes('otters'))
        if (!sel) return false
        const a = el.getBoundingClientRect()
        const b = sel.getBoundingClientRect()
        return b.top >= a.top && b.bottom <= a.bottom
      })
      expect(visible).toBe(true)
    } finally {
      await page.evaluate(() => window.liveSocket.disableLatencySim())
    }
  })

  test("a jump after another session edited the chapter lands on the clicked text", async ({ page }) => {
    await chaptersProject(page, 'E2E Sync Stale')

    // A second tab of the same project adds lines at the top of ch1.typ.
    const other = await page.context().newPage()
    await other.goto(page.url())
    await other.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
    await other.locator('#file-tree-main [phx-click="select_file"]').filter({ hasText: 'ch1.typ' }).first().click()
    await expect(other.locator('.ts-formatbar__hint')).toContainText('ch1.typ')
    const otherCm = other.locator('#editor-container .cm-content')
    await replaceBuffer(
      other,
      otherCm,
      '// note one\n// note two\n// note three\n\nNew opening about badgers.\n\n== Chapter one\n\nIncluded paragraph about otters.\n'
    )
    await waitForSaved(other)
    await other.close()

    // This tab's preview still shows the old chapter; the jump opens the
    // fresh file and finds the clicked text there.
    await run(page, 'otters').click({ position: { x: 1, y: 4 } })
    await expect(page.locator('.ts-tab.is-active .ts-tab__label')).toContainText('ch1.typ')
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 9, Col 1\b/)
    await expect(page.locator('#editor-container .cm-activeLine')).toContainText('otters')
    await expect(run(page, 'badgers')).toBeVisible({ timeout: 30_000 })

    // Back in main.typ the document still compiles with the fresh chapter.
    await run(page, 'kestrels').click()
    await expect(page.locator('.ts-tab.is-active .ts-tab__label')).toContainText('main.typ')
    await page.locator('#editor-container .cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('\nClosing words about lynxes.\n')
    await expect(run(page, 'lynxes')).toBeVisible({ timeout: 30_000 })
    await expect(run(page, 'badgers')).toBeVisible()
  })

  // A second tab of the same project replaces `file` with `text` and saves;
  // this tab's preview still shows the text it compiled before.
  async function editInOtherTab(page, file, text) {
    const other = await page.context().newPage()
    await other.goto(page.url())
    await other.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
    await selectFile(other, file)
    await replaceBuffer(other, other.locator('#editor-container .cm-content'), text)
    await waitForSaved(other)
    await other.close()
  }

  const notesAbove = '// note one\n// note two\n// note three\n\nNew opening about badgers.\n\n'

  test('a jump after another session edited above the clicked line and the line itself lands on its text', async ({ page }) => {
    await chaptersProject(page, 'E2E Sync Stale Line')
    const fresh = 'Included paragraph about sea otters.'
    await editInOtherTab(page, 'ch1.typ', `${notesAbove}== Chapter one\n\n${fresh}\n`)

    // The stale run still reads "about otters"; the jump finds that word on
    // the edited line, six lines lower now.
    await clickText(page, run(page, 'otters'), 'otters')
    await expect(activeTab(page)).toContainText('ch1.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 9, Col ${colOf(fresh, 'otters')}\\b`))
  })

  test('a jump after another session edited above and below picks the clicked copy of a repeated line', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Stale Repeat')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, '= Main file\n\nOpening paragraph about kestrels.\n\n#include "ch1.typ"\n')
    await waitForSaved(page)
    const ch1 = await createFile(page, 'ch1.typ')
    const chapter = '== Chapter one\n\nSame line here.\n\nMiddle text.\n\nSame line here.\n\nEnd.\n'
    await replaceBuffer(page, ch1, chapter)
    await waitForSaved(page)
    await selectFile(page, 'main.typ')
    await expect(run(page, 'Middle text')).toBeVisible({ timeout: 30_000 })
    await editInOtherTab(page, 'ch1.typ', notesAbove + chapter.replace('End.', 'End, revised.'))

    await exactRuns(page, 'Same line here.').nth(1).click({ position: { x: 1, y: 4 } })
    await expect(activeTab(page)).toContainText('ch1.typ')
    await expect(cursor(page)).toHaveText(/Ln 13, Col 1\b/)
    await exactRuns(page, 'Same line here.').first().click({ position: { x: 1, y: 4 } })
    await expect(cursor(page)).toHaveText(/Ln 9, Col 1\b/)
  })

  test('a new Typst file becomes the previewed document', async ({ page }) => {
    await chaptersProject(page, 'E2E Sync New Entry')
    const notes = await createFile(page, 'notes.typ')
    await replaceBuffer(page, notes, '= Notes\n\nNotes about herons.\n')
    await expect(run(page, 'herons')).toBeVisible({ timeout: 30_000 })
    await expect(run(page, 'kestrels')).toHaveCount(0)
    await clickText(page, run(page, 'herons'), 'herons')
    await expect(activeTab(page)).toContainText('notes.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf('Notes about herons.', 'herons')}\\b`))
  })

  test('deleting the previewed document while in a chapter previews the chapter', async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    await chaptersProject(page, 'E2E Sync Delete Entry')
    await run(page, 'otters').click({ position: { x: 1, y: 4 } })
    await expect(activeTab(page)).toContainText('ch1.typ')

    const row = page.locator('#file-tree-main li').filter({ hasText: 'main.typ' }).first()
    await row.hover()
    await row.locator('[phx-click="delete_file"]').click({ force: true })
    await expect(page.locator('#file-tree-main li').filter({ hasText: 'main.typ' })).toHaveCount(0)
    await expect(run(page, 'kestrels')).toHaveCount(0, { timeout: 30_000 })
    await expect(run(page, 'otters')).toBeVisible()
    await expect(page.locator('#preview-error')).not.toBeVisible()
    await clickText(page, run(page, 'otters'), 'otters')
    await expect(activeTab(page)).toContainText('ch1.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf('Included paragraph about otters.', 'otters')}\\b`))
  })

  test('moving the open file into a folder compiles it from there', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Move Open')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, '= Main\n\nParagraph about kestrels.\n\n#include "ch1.typ"\n')
    await waitForSaved(page)
    const root = await createFile(page, 'ch1.typ')
    await replaceBuffer(page, root, 'Root copy about otters.\n')
    await waitForSaved(page)
    const nested = await createFile(page, 'chapters/ch1.typ')
    await replaceBuffer(page, nested, 'Chapter copy about badgers.\n')
    await waitForSaved(page)
    await selectFile(page, 'main.typ')
    await expect(run(page, 'otters')).toBeVisible({ timeout: 30_000 })

    // main.typ moves next to chapters/ch1.typ, so its #include "ch1.typ"
    // now reads that copy; the open buffer compiles under its new path.
    const src = page.locator('#file-tree-main li[data-dnd-file]').filter({ hasText: 'main.typ' }).first()
    await src.dragTo(page.locator("#file-tree-main [data-dnd-dir='chapters']").first())
    await expect(page.locator('.ts-formatbar__hint')).toContainText('chapters/main.typ')
    await page.locator('#editor-container .cm-content').click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText('\nMore text about lynxes.\n')
    await expect(run(page, 'lynxes')).toBeVisible({ timeout: 30_000 })
    await expect(run(page, 'badgers')).toBeVisible()
    await expect(run(page, 'otters')).toHaveCount(0)
    await expect(page.locator('#preview-error')).not.toBeVisible()

    // A click on the moved file's text stays in it; one on the chapter
    // opens the copy the document reads.
    await clickText(page, run(page, 'kestrels'), 'kestrels')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf('Paragraph about kestrels.', 'kestrels')}\\b`))
    await run(page, 'badgers').click({ position: { x: 1, y: 4 } })
    await expect(page.locator('.ts-formatbar__hint')).toContainText('chapters/ch1.typ')
    await expect(cursor(page)).toHaveText(/Ln 1, Col 1\b/)
  })

  test('after a burst of compiles a click lands on the latest text', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Burst')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, '= Burst\n\nLine about kestrels.')
    await expect(run(page, 'kestrels')).toBeVisible({ timeout: 30_000 })

    // Ten edits, each compiled at once, in one task of the page: the loop
    // yields only to microtasks, so no worker reply can arrive before the
    // last compile is sent. All ten are in flight together, more than the
    // client keeps sources for (MAX_PENDING_COMPILES, 4, in typst_worker.js),
    // and the oldest sources are dropped. The edits go through the editor's
    // DOM; CodeMirror reads each one in a microtask, so every compile
    // carries its own text.
    const sent = await page.evaluate(async () => {
      const worker = window.typstWorker
      const post = worker.postMessage
      const lengths = []
      worker.postMessage = function (msg, ...rest) {
        if (msg?.type === 'compile') lengths.push(msg.content.length)
        return post.call(this, msg, ...rest)
      }
      try {
        for (let i = 0; i < 10; i++) {
          document.execCommand('insertText', false, `\n\nParagraph ${i} about voles.`)
          await Promise.resolve()
          await Promise.resolve()
          window.dispatchEvent(new CustomEvent('phx:editor-command', { detail: { cmd: 'compile' } }))
        }
      } finally {
        worker.postMessage = post
      }
      return lengths
    })
    expect(sent).toHaveLength(10)
    expect(new Set(sent).size).toBe(10)
    await expect(run(page, 'Paragraph 9')).toBeVisible({ timeout: 30_000 })
    await run(page, 'Paragraph 9').click({ position: { x: 1, y: 4 } })
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 23, Col 1\b/)
    await run(page, 'Paragraph 4').click({ position: { x: 1, y: 4 } })
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 13, Col 1\b/)
    await expect(page.locator('#preview-error')).not.toBeVisible()
  })

  test('in a shared view a click on included text is a no-op without errors', async ({ page }) => {
    const errors = []
    page.on('pageerror', (err) => errors.push(err.message))
    await chaptersProject(page, 'E2E Sync Shared')

    await page.locator('.ts-tb__share').click()
    const modal = page.locator('.share-shell')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    // The copyable link carries the configured host; visit its path here so
    // the session cookie stays.
    const link = new URL((await modal.locator('.link-box .path').textContent()).trim())
    await page.goto(link.pathname + link.search)
    await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
    await expect(run(page, 'otters')).toBeVisible({ timeout: 30_000 })
    const source = page.locator('#editor-container .cm-content').first()
    await expect(source).toContainText('#include "ch1.typ"')

    await run(page, 'otters').click({ position: { x: 1, y: 4 } })
    await page.waitForTimeout(500)
    await expect(source).toContainText('#include "ch1.typ"')
    await expect(source).not.toContainText('Included paragraph about otters.')

    // Text of the shown file still moves the caret.
    await run(page, 'kestrels').click({ position: { x: 1, y: 4 } })
    await expect(page.locator('#editor-container .cm-activeLine').first()).toContainText('kestrels')
    expect(errors).toEqual([])
  })

  // Clicks the preview does not take as a jump, and caret moves it does not
  // answer with a flash.
  const twoParagraphs = '= Head\n\nShort kestrels.\n\nSecond line about herons that is long.\n'
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} keeps the page count honest.`)
  const longDocument = `= Follow me\n\n${filler.join('\n\n')}\n\nClosing paragraph about wombats.\n`

  test('a click beside a short line lands at its end; a click far beside it does nothing', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Beside')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, twoParagraphs)
    await expect(run(page, 'herons')).toBeVisible({ timeout: 30_000 })

    // Inside the click slop, right of `Short kestrels.`: the run on that
    // line, at its end.
    const box = await run(page, 'Short kestrels').boundingBox()
    await page.mouse.click(box.x + box.width + 20, box.y + box.height / 2)
    await expect(cursor(page)).toHaveText(/Ln 3, Col 16\b/)

    // Far past the slop no run is near: the caret stays where it was.
    await page.mouse.click(box.x + box.width + 300, box.y + box.height / 2)
    await page.waitForTimeout(500)
    await expect(cursor(page)).toHaveText(/Ln 3, Col 16\b/)
  })

  test('dragging across preview text selects it and leaves the caret alone', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Drag')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, twoParagraphs)
    await expect(run(page, 'herons')).toBeVisible({ timeout: 30_000 })
    await run(page, 'Short kestrels').click({ position: { x: 1, y: 4 } })
    await expect(cursor(page)).toHaveText(/Ln 3, Col 1\b/)

    const b = await run(page, 'herons').boundingBox()
    await page.mouse.move(b.x + 2, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 5 })
    await page.mouse.up()
    expect(await page.evaluate(() => String(window.getSelection()))).toContain('herons')
    await page.waitForTimeout(500)
    await expect(cursor(page)).toHaveText(/Ln 3, Col 1\b/)
  })

  test('a click in the preview neither flashes the preview nor scrolls it back', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Click Calm')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, longDocument)
    await expect(run(page, 'wombats')).toBeAttached({ timeout: 30_000 })

    // The closing paragraph is on page 2, out of view until scrolled to.
    const pane = page.locator('#preview-container')
    const target = run(page, 'wombats')
    await target.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    const top = await pane.evaluate((el) => el.scrollTop)
    expect(top).toBeGreaterThan(0)
    const flashes = await countFlashes(page)

    // The caret moves to the clicked text, and the preview stays as it is:
    // the user is looking at that spot already.
    await target.click({ position: { x: 1, y: 4 } })
    await expect(cursor(page)).toHaveText(/Ln 83, Col 1\b/)
    await page.waitForTimeout(900)
    expect(await flashes()).toBe(0)
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(top)

    // The next caret move in the editor is followed again.
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(cursor(page)).toHaveText(/Ln 81\b/)
    await expect.poll(flashes, { timeout: 5_000 }).toBe(1)
  })

  test('a caret moving within one run does not flash again, and a visible run is not scrolled to', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Calm Caret')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, longDocument)
    await expect(run(page, 'wombats')).toBeAttached({ timeout: 30_000 })

    // Scroll a little by hand, keeping the first paragraphs in view: a pane
    // that re-centred a run near the top would leave this offset.
    const pane = page.locator('#preview-container')
    await pane.evaluate((el) => el.scrollTo({ top: 60, behavior: 'instant' }))
    await run(page, 'Paragraph 2 keeps').click({ position: { x: 1, y: 4 } })
    await expect(cursor(page)).toHaveText(/Ln 5, Col 1\b/)
    const flashes = await countFlashes(page)

    // Down to paragraph 3: a new run, one flash, no scroll.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(cursor(page)).toHaveText(/Ln 7, Col 1\b/)
    await expect.poll(flashes, { timeout: 5_000 }).toBe(1)
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(60)

    // Along the same line: the same run, no new flash.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(350)
    }
    await expect(cursor(page)).toHaveText(/Ln 7, Col 4\b/)
    await page.waitForTimeout(500)
    expect(await flashes()).toBe(1)

    // On to paragraph 4: a new run again.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(cursor(page)).toHaveText(/Ln 9\b/)
    await expect.poll(flashes, { timeout: 5_000 }).toBe(2)
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(60)
  })

  test('with an outline, clicks and a resting caret reach the body, not the contents', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Outline')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(
      page,
      cm,
      '#outline()\n#pagebreak()\n\n= Alpha\n\nBody text about kestrels.\n\n= Bravo\n\nBody text about herons.\n\n= Charlie\n\nBody text about otters.\n'
    )
    await expect(run(page, 'otters')).toBeAttached({ timeout: 30_000 })
    // The outline entry comes first, the body heading on page 2 second.
    const bravo = exactRuns(page, 'Bravo')
    await expect(bravo).toHaveCount(2)

    // Short sections do not drag the body: each paragraph and heading is on
    // its own line.
    await clickChar(page, bravo.nth(1), 2)
    await expect(cursor(page)).toHaveText(/Ln 8, Col 5\b/)
    await clickChar(page, run(page, 'about kestrels'), 0)
    await expect(cursor(page)).toHaveText(/Ln 6, Col 1\b/)
    await clickChar(page, run(page, 'about otters'), 0)
    await expect(cursor(page)).toHaveText(/Ln 14, Col 1\b/)
    await clickChar(page, run(page, 'about herons'), 0)
    await expect(cursor(page)).toHaveText(/Ln 10, Col 1\b/)

    // A caret resting on the heading flashes the body heading, not its
    // outline entry, and on the paragraph the paragraph.
    const pane = page.locator('#preview-container')
    await pane.evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }))
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(cursor(page)).toHaveText(/Ln 8\b/)
    const heading = { selector: '#typst-svg-output .tsel', pattern: '^Bravo$', nth: 1 }
    await expect.poll(() => pane.evaluate(flashGapNth, heading), { timeout: 5_000 }).toBeLessThan(16)
    expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(cursor(page)).toHaveText(/Ln 10\b/)
    await expect.poll(() => pane.evaluate(flashGap, 'about herons'), { timeout: 5_000 }).toBeLessThan(16)
  })

  test('a click on an outline entry lands on that character of its heading', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Outline Entry')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, '#outline()\n#pagebreak()\n\n= Alpha\n\nBody text about kestrels.\n\n= Bravo\n\nBody text about herons.\n')
    const bravo = exactRuns(page, 'Bravo')
    await expect(bravo).toHaveCount(2, { timeout: 30_000 })

    // The entry is a copy of the heading `= Bravo`: its first letter is the
    // heading's, at column 3, and its third letter at column 5.
    await clickChar(page, bravo.nth(0), 0)
    await expect(cursor(page)).toHaveText(/Ln 8, Col 3\b/)
    await clickChar(page, bravo.nth(0), 2)
    await expect(cursor(page)).toHaveText(/Ln 8, Col 5\b/)
  })

  test('a footnote at the bottom of a full page jumps to its #footnote', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Footnote')
    const cm = await createFile(page, 'main.typ')
    const birds = ['kestrel', 'curlew', 'heron', 'merlin', 'plover', 'godwit', 'dunlin', 'avocet', 'bittern', 'egret']
    const sentence = (k) => `Sentence ${k} reports that the ${birds[k % 10]} and the ${birds[(k + 3) % 10]} were counted near site ${k}.`
    const paragraph = (from) => Array.from({ length: 12 }, (_, k) => sentence(from + k)).join(' ')
    const line3 = `Opening claim with a note.#footnote[The footnote body explains the opening claim.] ${paragraph(0)}`
    await replaceBuffer(page, cm, `= Foot page\n\n${line3}\n\n${paragraph(12)}\n\n${paragraph(24)}\n`)
    const body = run(page, 'The footnote body explains')
    await expect(body).toBeAttached({ timeout: 30_000 })

    // The footnote text sits at the page bottom, more than a page of source
    // after its call; a click inside it lands on that character of the call.
    await clickText(page, body, 'footnote')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf(line3, 'footnote body')}\\b`))

    // The superscript in the text goes to its `#footnote`, the number in
    // the footnote area to the line of its call.
    const marks = exactRuns(page, '1')
    await clickChar(page, marks.nth(0), 0)
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf(line3, '#footnote')}\\b`))
    await clickChar(page, marks.nth(1), 0)
    await expect(cursor(page)).toHaveText(/Ln 3, Col 1\b/)
  })

  test('citation markers and the closing period stay in their paragraph; an entry opens refs.bib', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Citations')
    const main = await createFile(page, 'main.typ')
    const line3 = 'Herons are studied widely @smith2020 and raptors too @lee2018.'
    const line5 = 'A second paragraph cites again @smith2020.'
    await replaceBuffer(page, main, `= Citations\n\n${line3}\n\n${line5}\n\n#bibliography("refs.bib")\n`)
    await waitForSaved(page)
    const bib = await createFile(page, 'refs.bib')
    await replaceBuffer(
      page,
      bib,
      '@article{smith2020,\n  title = {Wading birds of the northern marshes},\n  author = {Smith, John and Doe, Jane},\n  journal = {Journal of Ornithology},\n  year = {2020},\n}\n\n@book{lee2018,\n  title = {Raptors in flight},\n  author = {Lee, Anna},\n  publisher = {Feather Press},\n  year = {2018},\n}\n'
    )
    await waitForSaved(page)
    await selectFile(page, 'main.typ')
    const entry = run(page, 'Wading birds of the northern marshes')
    await expect(entry).toBeVisible({ timeout: 30_000 })

    // `[2]` at the end of paragraph 1 is its `@lee2018`, the period after it
    // the period of that line (clicked on its right half: the caret goes
    // after it), and `[1]` in paragraph 2 its `@smith2020`.
    await clickChar(page, exactRuns(page, '[2]').first(), 0)
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf(line3, '@lee2018')}\\b`))
    await clickChar(page, exactRuns(page, '.').first(), 0, true)
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${line3.length + 1}\\b`))
    await clickChar(page, exactRuns(page, '[1]').nth(1), 0)
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 5, Col ${colOf(line5, '@smith2020')}\\b`))

    // A bibliography entry resolves to its field in refs.bib.
    await clickText(page, entry, 'Wading')
    await expect(activeTab(page)).toContainText('refs.bib')
    await expect(cursor(page)).toHaveText(/Ln 2, Col 12\b/)
  })

  test('a template applied by `#show: project.with(..)` prints its arguments from main.typ, its own text from its file', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Show Template')
    const line2 = '#show: project.with(title: "Migration of Cranes", authors: ("Ada Lin", "Борис Ким"))'
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, `#import "template.typ": project\n${line2}\n\n= Background\n\nCranes fly south in autumn.\n`)
    await waitForSaved(page)
    const line5 = '  [Prepared for the field station.]'
    const template = await createFile(page, 'template.typ')
    await replaceBuffer(
      page,
      template,
      `#let project(title: "", authors: (), body) = {\n  set document(title: title)\n  align(center, text(17pt, weight: "bold", title))\n  align(center, authors.join(", "))\n${line5}\n  body\n}\n`
    )
    await waitForSaved(page)
    await selectFile(page, 'main.typ')
    const title = exactRuns(page, 'Migration of Cranes').first()
    await expect(title).toBeVisible({ timeout: 30_000 })

    // The title and the authors are the strings handed to the template, so
    // each click lands on that character of its literal in main.typ.
    await clickText(page, title, 'Cranes')
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 2, Col ${colOf(line2, 'Cranes')}\\b`))
    const ada = run(page, 'Ada Lin')
    await clickChar(page, ada, (await ada.textContent()).trim().indexOf('Ada') + 1)
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 2, Col ${colOf(line2, 'Ada') + 1}\\b`))
    await clickText(page, run(page, 'Борис Ким'), 'Ким')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 2, Col ${colOf(line2, 'Ким')}\\b`))

    // Text the template writes itself stays in template.typ.
    await clickText(page, run(page, 'Prepared for the field station'), 'field')
    await expect(activeTab(page)).toContainText('template.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 5, Col ${colOf(line5, 'field')}\\b`))
  })

  test('a prose citation lands on its #cite, and the caret there flashes it; an equation number stays on its equation', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Prose Cite')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(
      page,
      main,
      '#set math.equation(numbering: "(1)")\n= Sources\n\n#cite(<petrov2019>, form: "prose") describes owls, while @adams2021 covers hawks.\n\n$ N(t) = N_0 e^(r t) $ <eq-growth>\n\nAs @eq-growth predicts, the colony doubles.\n\n#bibliography("lit.bib", style: "ieee")\n'
    )
    await waitForSaved(page)
    const bib = await createFile(page, 'lit.bib')
    await replaceBuffer(
      page,
      bib,
      '@book{petrov2019,\n  title = {Night birds of the taiga},\n  author = {Petrov, Ivan},\n  publisher = {Nauka},\n  year = {2019},\n}\n\n@article{adams2021,\n  title = {Hawk migration routes},\n  author = {Adams, Clara},\n  journal = {Avian Studies},\n  year = {2021},\n}\n'
    )
    await waitForSaved(page)
    await selectFile(page, 'main.typ')
    const prose = exactRuns(page, 'I. Petrov [1]').first()
    await expect(prose).toBeVisible({ timeout: 30_000 })

    // "I. Petrov [1]" is generated by the call: no character of it is in the
    // source, so any click on it goes to the start of `#cite`.
    await clickText(page, prose, 'Petrov')
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(/Ln 4, Col 1\b/)
    await clickChar(page, prose, 'I. Petrov ['.length)
    await expect(cursor(page)).toHaveText(/Ln 4, Col 1\b/)

    // The equation number belongs to its equation, not to the paragraph after.
    await clickChar(page, exactRuns(page, '(1)').first(), 1)
    await expect(cursor(page)).toHaveText(/Ln 6, Col \d+\b/)

    // A caret resting inside the `#cite` call flashes the prose citation.
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(cursor(page)).toHaveText(/Ln 4, Col 3\b/)
    const pane = page.locator('#preview-container')
    await expect.poll(() => pane.evaluate(flashGap, 'I. Petrov [1]'), { timeout: 5_000 }).toBeLessThan(16)
  })

  test('three pictures in a #grid each jump to their own line, and the caret there flashes its picture', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Grid')
    const cm = await createFile(page, 'main.typ')
    await uploadPictures(page, ['blue.png', 'green.png', 'red.png'])
    const lines = [
      '= Grid',
      '',
      'Intro about kestrels.',
      '',
      '#grid(',
      '  columns: 3,',
      '  gutter: 1em,',
      '  image("assets/blue.png", width: 2cm),',
      '  image("assets/green.png", width: 2cm),',
      '  image("assets/red.png", width: 2cm),',
      ')',
      '',
      'After about herons.'
    ]
    await replaceBuffer(page, cm, lines.join('\n') + '\n')
    const pictures = page.locator('#typst-svg-output image')
    await expect(pictures).toHaveCount(3, { timeout: 30_000 })
    await expect(pictures.nth(2)).toBeVisible()

    // A picture has no character: the caret goes to the end of its line.
    for (const [k, line] of [[0, 8], [1, 9], [2, 10]]) {
      await pictures.nth(k).click()
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col ${lines[line - 1].length + 1}\\b`))
    }

    // Up to the green line: its picture flashes, not the first one.
    await page.keyboard.press('ArrowUp')
    await expect(cursor(page)).toHaveText(/Ln 9\b/)
    const pane = page.locator('#preview-container')
    const green = { selector: '#typst-svg-output image', nth: 1 }
    await expect.poll(() => pane.evaluate(flashGapNth, green), { timeout: 5_000 }).toBeLessThan(16)
  })

  test('a picture sharing a line with text stays on that line', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Inline Picture')
    const cm = await createFile(page, 'main.typ')
    await uploadPictures(page, ['blue.png', 'green.png'])
    const lines = [
      '= Table',
      '',
      'Intro about kestrels.',
      '',
      '#table(columns: 2,',
      '  [Blue], image("assets/blue.png", width: 1cm),',
      '  [Green], image("assets/green.png", width: 1cm),',
      ')',
      '',
      'A sentence ending with an icon #box(image("assets/blue.png", height: 1em))',
      '',
      'After about herons.'
    ]
    await replaceBuffer(page, cm, lines.join('\n') + '\n')
    const pictures = page.locator('#typst-svg-output image')
    await expect(pictures).toHaveCount(3, { timeout: 30_000 })
    await expect(run(page, 'herons')).toBeVisible()

    // Each table picture is on the line of its label, the icon on the line
    // of its sentence.
    for (const [k, line] of [[0, 6], [1, 7], [2, 10]]) {
      await pictures.nth(k).click()
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col ${lines[line - 1].length + 1}\\b`))
    }
    await clickChar(page, exactRuns(page, 'Green').first(), 0)
    await expect(cursor(page)).toHaveText(/Ln 7, Col 4\b/)
  })

  test('a deleted picture asset shows the missing-file error', async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    await createProjectAndOpenEditor(page, 'E2E Sync Deleted Asset')
    const cm = await createFile(page, 'main.typ')
    await uploadPictures(page, ['pic.png'])
    await replaceBuffer(page, cm, '= Gone\n\nIntro about kestrels.\n\n#image("assets/pic.png", width: 3cm)\n\nAfter about herons.\n')
    await expect(page.locator('#typst-svg-output image')).toBeVisible({ timeout: 30_000 })

    const row = page.locator('#asset-tree li').filter({ hasText: 'pic.png' })
    await row.hover()
    await row.locator('[phx-click="delete_asset"]').click({ force: true })
    await expect(row).toHaveCount(0)

    // The next compile no longer finds the file, as on a fresh page.
    await cm.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('More text about lynxes.\n')
    await expect(page.locator('#preview-error')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#preview-error')).toContainText('failed to load file')
    await expect(page.locator('#preview-error')).toContainText(/main\.typ\s*:\s*5\b/)
    await expect(page.locator('#typst-svg-output image')).not.toBeVisible()
  })

  test('a picture replaced by another of the same name and size shows the new one', async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    await createProjectAndOpenEditor(page, 'E2E Sync Replaced Asset')
    const cm = await createFile(page, 'main.typ')
    // Two 8×8 PNGs of the same byte size, one blue and one green.
    const blue = readFileSync(join(here, 'fixtures/blue.png'))
    const green = readFileSync(join(here, 'fixtures/green.png'))
    expect(blue.length).toBe(green.length)
    const upload = (buffer) =>
      page.locator('#dropped-upload-form input[type=file]').setInputFiles([{ name: 'pic.png', mimeType: 'image/png', buffer }])
    const row = page.locator('#asset-tree li').filter({ hasText: 'pic.png' })
    const picture = page.locator('#typst-svg-output image')
    const href = () => picture.evaluate((el) => el.getAttribute('href') || el.getAttribute('xlink:href') || '')

    await upload(blue)
    await expect(row).toHaveCount(1)
    await replaceBuffer(page, cm, '= Swap\n\nIntro about kestrels.\n\n#image("assets/pic.png", width: 3cm)\n')
    await expect(picture).toBeVisible({ timeout: 30_000 })
    const before = await href()
    expect(before).toContain(blue.toString('base64'))

    await row.hover()
    await row.locator('[phx-click="delete_asset"]').click({ force: true })
    await expect(row).toHaveCount(0)
    await upload(green)
    await expect(row).toHaveCount(1)

    // The next compile reads the new file, not the bytes kept for the old.
    await cm.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('\nAfter about lynxes.\n')
    await expect(run(page, 'lynxes')).toBeVisible({ timeout: 30_000 })
    await expect.poll(href, { timeout: 10_000 }).toContain(green.toString('base64'))
  })

  test("a deleted #include'd chapter shows the missing-file error", async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    await createProjectAndOpenEditor(page, 'E2E Sync Deleted Chapter')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, '= Main\n\nParagraph about kestrels.\n\n#include "ch1.typ"\n')
    await waitForSaved(page)
    const ch1 = await createFile(page, 'ch1.typ')
    await replaceBuffer(page, ch1, 'Chapter text about otters.\n')
    await waitForSaved(page)
    await selectFile(page, 'main.typ')
    await expect(run(page, 'otters')).toBeVisible({ timeout: 30_000 })

    // Deleting the chapter recompiles the document without it.
    const row = page.locator('#file-tree-main li').filter({ hasText: 'ch1.typ' }).first()
    await row.hover()
    await row.locator('[phx-click="delete_file"]').click({ force: true })
    await expect(page.locator('#file-tree-main li').filter({ hasText: 'ch1.typ' })).toHaveCount(0)
    await expect(page.locator('#preview-error')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#preview-error')).toContainText('failed to load file')
    await expect(page.locator('#preview-error')).toContainText(/main\.typ\s*:\s*5\b/)
    await expect(run(page, 'otters')).not.toBeVisible()
  })

  // The run right after the `k`-th run whose whole text is `text`: in a
  // printed table, the next cell of its row.
  async function cellAfter(page, text, k = 0) {
    const all = page.locator('#typst-svg-output .tsel')
    const i = await all.evaluateAll(
      (els, [t, k]) => els.map((e, i) => (e.textContent.trim() === t ? i : -1)).filter((i) => i >= 0)[k] ?? -1,
      [text, k]
    )
    expect(i, `run #${k} "${text}"`).toBeGreaterThanOrEqual(0)
    return all.nth(i + 1)
  }

  // A project with main.typ and data files, previewing main.typ.
  async function dataProject(page, name, mainText, files) {
    await createProjectAndOpenEditor(page, name)
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, mainText)
    await waitForSaved(page)
    for (const [path, text] of files) {
      const cm = await createFile(page, path)
      await replaceBuffer(page, cm, text)
      await waitForSaved(page)
    }
    await selectFile(page, 'main.typ')
  }

  test('repeated values in a long CSV table land on their own rows', async ({ page }) => {
    const rows = Array.from({ length: 40 }, (_, i) => `person${i + 1},${(i + 1) % 3 === 0 ? 'retired' : 'active'}`)
    await dataProject(page, 'E2E Sync Long Table', '= Members\n\n#table(columns: 2, ..csv("s.csv").flatten())\n\nAfter the table.\n', [
      ['s.csv', `name,status\n${rows.join('\n')}\n`]
    ])
    await expect(exactRuns(page, 'person40')).toBeAttached({ timeout: 30_000 })

    // Rows 25 and later hold the same values as the rows above them; each
    // cell still lands on its own row.
    for (const k of [27, 31, 40]) {
      await clickChar(page, await cellAfter(page, `person${k}`), 0)
      await expect(activeTab(page)).toContainText('s.csv')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${k + 1}, Col ${`person${k},`.length + 1}\\b`))
    }
  })

  test('a table followed by prose naming its columns keeps the prose and the header apart', async ({ page }) => {
    await dataProject(
      page,
      'E2E Sync Table Prose',
      '= Cities\n\n#table(columns: 3, ..csv("a.csv").flatten())\n\nOslo is the biggest city in the table and its country is Norway.\n\nThe pop column is in thousands.\n',
      [['a.csv', 'city,country,pop\nOslo,Norway,700\nBergen,Norway,285\n']]
    )
    await expect(run(page, 'in thousands')).toBeVisible({ timeout: 30_000 })

    await clickChar(page, run(page, 'Oslo is the biggest'), 0)
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(/Ln 5, Col 1\b/)
    await clickChar(page, exactRuns(page, 'city').first(), 0)
    await expect(activeTab(page)).toContainText('a.csv')
    await expect(cursor(page)).toHaveText(/Ln 1, Col 1\b/)
    await clickChar(page, exactRuns(page, 'pop').first(), 0)
    await expect(cursor(page)).toHaveText(/Ln 1, Col 14\b/)
    await clickChar(page, run(page, 'The pop column'), 0)
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(/Ln 7, Col 1\b/)
  })

  test('a CSV printed twice: the second copy walks its rows again', async ({ page }) => {
    await dataProject(
      page,
      'E2E Sync Table Twice',
      '= Twice\n\n#table(columns: 2, ..csv("s.csv").flatten())\n\nThe same table again.\n\n#table(columns: 2, ..csv("s.csv").flatten())\n\nAfter twice.\n',
      [['s.csv', 'name,status\nalpha,active\nbravo,retired\ncharlie,active\ndelta,retired\necho,active\n']]
    )
    await expect(exactRuns(page, 'echo')).toHaveCount(2, { timeout: 30_000 })

    // Each cell of the second copy lands on its own row, not on the first
    // row holding the same value.
    await clickChar(page, exactRuns(page, 'echo').nth(1), 0)
    await expect(activeTab(page)).toContainText('s.csv')
    await expect(cursor(page)).toHaveText(/Ln 6, Col 1\b/)
    await clickChar(page, await cellAfter(page, 'echo', 1), 0)
    await expect(cursor(page)).toHaveText(/Ln 6, Col 6\b/)
    await clickChar(page, await cellAfter(page, 'delta', 1), 0)
    await expect(cursor(page)).toHaveText(/Ln 5, Col 7\b/)
  })

  test('values printed from one CSV stay in that file when another holds the same text', async ({ page }) => {
    await dataProject(page, 'E2E Sync Two Files', '= Cities\n\n#table(columns: 3, ..csv("new.csv").flatten())\n\nAfter the table.\n', [
      ['aold.csv', 'city,country,pop\nOslo,Norway,690\nBergen,Norway,280\n'],
      ['new.csv', 'city,country,pop\nOslo,Norway,700\nBergen,Norway,285\n']
    ])
    await expect(exactRuns(page, 'Bergen')).toBeVisible({ timeout: 30_000 })

    await clickChar(page, exactRuns(page, 'Bergen').first(), 0)
    await expect(activeTab(page)).toContainText('new.csv')
    await expect(cursor(page)).toHaveText(/Ln 3, Col 1\b/)
    await clickChar(page, exactRuns(page, 'Norway').nth(1), 0)
    await expect(activeTab(page)).toContainText('new.csv')
    await expect(cursor(page)).toHaveText(/Ln 3, Col 8\b/)
    await clickChar(page, exactRuns(page, 'city').first(), 0)
    await expect(activeTab(page)).toContainText('new.csv')
    await expect(cursor(page)).toHaveText(/Ln 1, Col 1\b/)
  })

  test('a caret on a #table(..csv()) line flashes the table that line prints', async ({ page }) => {
    await dataProject(
      page,
      'E2E Sync Table Caret',
      '= Two tables\n\n#table(columns: 3, ..csv("new.csv").flatten())\n\nBetween the tables.\n\n#table(columns: 3, ..csv("b.csv").flatten())\n\nAfter both.\n',
      [
        ['new.csv', 'city,country,pop\nOslo,Norway,700\nBergen,Norway,285\n'],
        ['b.csv', 'city,river,len\nBergen,none,0\nCairo,Nile,6650\nOslo,Akerselva,8\n']
      ]
    )
    await expect(run(page, 'After both')).toBeVisible({ timeout: 30_000 })
    await clickChar(page, run(page, 'Between the tables'), 0)
    await expect(cursor(page)).toHaveText(/Ln 5, Col 1\b/)

    const pane = page.locator('#preview-container')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(cursor(page)).toHaveText(/Ln 3\b/)
    const first = { from: 'Two tables', to: 'Between the tables' }
    await expect.poll(() => pane.evaluate(flashBetween, first), { timeout: 5_000 }).toBe(true)

    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
    await expect(cursor(page)).toHaveText(/Ln 7\b/)
    const second = { from: 'Between the tables', to: 'After both' }
    await expect.poll(() => pane.evaluate(flashBetween, second), { timeout: 5_000 }).toBe(true)
  })

  test("a #for loop's later items land on the loop body, their values in the CSV", async ({ page }) => {
    const body = '  - #r.at(0) costs #r.at(1)'
    await dataProject(
      page,
      'E2E Sync Loop',
      `= Shout\n\n#let rows = csv("p.csv").slice(1)\n#for r in rows [\n${body}\n]\n\nAfter the loop.\n`,
      [['p.csv', 'item,price,qty\napple,1234.5678,1500\npear,2.5,20000\nmango,0.333,7\nplum,4,9\n']]
    )
    const plum = run(page, 'plum costs 4')
    await expect(plum).toBeVisible({ timeout: 30_000 })

    // The literal word of the last item is the loop body's.
    await clickText(page, plum, 'costs')
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 5, Col ${colOf(body, 'costs')}\\b`))
    await clickText(page, run(page, 'pear costs'), 'costs')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 5, Col ${colOf(body, 'costs')}\\b`))
    // Its value is that row's cell.
    await clickChar(page, plum, 1)
    await expect(activeTab(page)).toContainText('p.csv')
    await expect(cursor(page)).toHaveText(/Ln 5, Col 2\b/)
  })

  // Records written one field per line, a value repeated in two of them: each
  // item's values come from the record it prints, and a caret on a record's
  // line flashes that item, not the first one holding the same value.
  test('a #for over YAML records sends a repeated value to its own record, and its lines flash that item', async ({ page }) => {
    const yamlLines = ['- name: Agnes', '  job: geologist', '- name: Bruno', '  job: courier', '- name: Celia', '  job: geologist']
    await dataProject(
      page,
      'E2E Sync Yaml Loop',
      '#let team = yaml("team.yaml")\n= Team\n\n#for p in team [\n  + #p.name --- #p.job\n]\n\nThat is the team.\n',
      [['team.yaml', `${yamlLines.join('\n')}\n`]]
    )
    const first = run(page, 'Agnes')
    const third = run(page, 'Celia')
    await expect(third).toBeVisible({ timeout: 30_000 })

    // The number of an item is the list marker's, not a key of the file.
    await page.locator('#typst-svg-output .tsel').filter({ hasText: /^1\.$/ }).first().click()
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(/Ln 5, Col 1\b/)

    // The same job in the first and the third item opens its own record.
    for (const [item, line] of [[first, 2], [third, 6]]) {
      await clickText(page, item, 'geologist')
      await expect(activeTab(page)).toContainText('team.yaml')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col ${colOf(yamlLines[line - 1], 'geologist')}\\b`))
    }
    await clickText(page, third, 'Celia')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 5, Col ${colOf(yamlLines[4], 'Celia')}\\b`))

    // A caret on the first record's job flashes the first item; on the third
    // record's job, the third.
    const pane = page.locator('#preview-container')
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp')
    await expect(cursor(page)).toHaveText(/Ln 2\b/)
    await expect.poll(() => pane.evaluate(flashGap, 'Agnes'), { timeout: 5_000 }).toBeLessThan(16)
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
    await expect(cursor(page)).toHaveText(/Ln 6\b/)
    await expect.poll(() => pane.evaluate(flashGap, 'Celia'), { timeout: 5_000 }).toBeLessThan(16)
  })

  // A show rule printing each heading's body followed by text of its own: the
  // body lives at the heading, the added text in the rule, and a caret on a
  // heading flashes it.
  test('a heading shown through a rule adding text lands on the heading, the added text on the rule', async ({ page }) => {
    const rule = '#show heading: it => block[#it.body (Part)]'
    await createProjectAndOpenEditor(page, 'E2E Sync Heading Rule')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, `#show "km": "kilometres"\n${rule}\n= Harbour\n\nWe rowed 4 km across the bay.\n\n= Lighthouse\n\nThen 2 km back.\n`)
    await expect(run(page, 'Lighthouse')).toBeVisible({ timeout: 30_000 })

    for (const [title, line] of [['Harbour', 3], ['Lighthouse', 7]]) {
      const heading = run(page, `${title} (Part)`)
      await clickChar(page, heading, 1)
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col 4\\b`))
      await clickText(page, heading, 'Part')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln 2, Col ${colOf(rule, 'Part')}\\b`))
    }

    // From the rule's line the caret moves onto each heading in turn.
    const pane = page.locator('#preview-container')
    await page.keyboard.press('ArrowDown')
    await expect(cursor(page)).toHaveText(/Ln 3\b/)
    await expect.poll(() => pane.evaluate(flashGap, 'Harbour'), { timeout: 5_000 }).toBeLessThan(16)
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
    await expect(cursor(page)).toHaveText(/Ln 7\b/)
    await expect.poll(() => pane.evaluate(flashGap, 'Lighthouse'), { timeout: 5_000 }).toBeLessThan(16)
  })

  // Records printed through a local function whose fields the YAML file
  // lists in another order, a port and an hour repeated: each value opens
  // its own record, the function's own words its definition, and a caret on
  // a record's line flashes the item that record printed.
  test('records printed through a local function open their own record, the literal words the definition', async ({ page }) => {
    const yamlLines = ['- hour: 6', '  port: Bergen', '  name: Ingrid', '- hour: 9', '  port: Tromsø', '  name: Leif', '- hour: 6', '  port: Bergen', '  name: Maja']
    const def = '#let entry(m) = [#m.name sails from #m.port at #m.hour sharp.]'
    const total = 'In all #crew.len() sailors.'
    await dataProject(page, 'E2E Sync Function Records', `#let crew = yaml("crew.yaml")\n${def}\n= Crew\n\n#for m in crew [\n  #entry(m)\n\n]\n\n${total}\n`, [
      ['crew.yaml', `${yamlLines.join('\n')}\n`]
    ])
    const maja = run(page, 'Maja sails')
    await expect(maja).toBeVisible({ timeout: 30_000 })

    for (const [name, line] of [['Ingrid', 3], ['Maja', 9]]) {
      const item = run(page, `${name} sails`)
      await clickText(page, item, 'Bergen')
      await expect(activeTab(page)).toContainText('crew.yaml')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line - 1}, Col ${colOf(yamlLines[line - 2], 'Bergen')}\\b`))
      await clickText(page, item, '6')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line - 2}, Col ${colOf(yamlLines[line - 3], '6')}\\b`))
      await clickText(page, item, name)
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col ${colOf(yamlLines[line - 1], name)}\\b`))
    }
    for (const word of ['sails', 'sharp']) {
      await clickText(page, maja, word)
      await expect(activeTab(page)).toContainText('main.typ')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln 2, Col ${colOf(def, word)}\\b`))
    }
    const after = run(page, 'In all')
    await clickChar(page, after, 0)
    await expect(cursor(page)).toHaveText(/Ln 10, Col 1\b/)
    await clickText(page, after, 'sailors')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 10, Col ${colOf(total, 'sailors')}\\b`))

    // From the last record's name the caret moves up into the second
    // record, then into the first.
    const pane = page.locator('#preview-container')
    await clickText(page, maja, 'Maja')
    await expect(cursor(page)).toHaveText(/Ln 9\b/)
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp')
    await expect(cursor(page)).toHaveText(/Ln 6\b/)
    await expect.poll(() => pane.evaluate(flashGap, 'Leif'), { timeout: 5_000 }).toBeLessThan(16)
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp')
    await expect(cursor(page)).toHaveText(/Ln 3\b/)
    await expect.poll(() => pane.evaluate(flashGap, 'Ingrid'), { timeout: 5_000 }).toBeLessThan(16)
  })

  // A rule writing its text before each heading: the heading's words land
  // on the heading, the rule's word on the rule, for every heading, and a
  // caret on a heading flashes that heading.
  test('a rule writing text before three headings sends the text to the rule, each title to its heading', async ({ page }) => {
    const rule = '#show heading: it => [Chapter: #it.body]'
    await createProjectAndOpenEditor(page, 'E2E Sync Heading Prefix')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, `${rule}\n= Dunes\n\nSand shifts each night.\n\n= Marsh\n\nReeds bend in the wind.\n\n= Ridge\n\nStone holds the frost.\n`)
    await expect(run(page, 'Stone holds')).toBeVisible({ timeout: 30_000 })

    for (const [title, line] of [['Dunes', 2], ['Marsh', 6], ['Ridge', 10]]) {
      const heading = run(page, `Chapter: ${title}`)
      await clickText(page, heading, title)
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col 3\\b`))
      await clickText(page, heading, 'Chapter')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln 1, Col ${colOf(rule, 'Chapter')}\\b`))
      await clickChar(page, run(page, ['Sand', 'Reeds', 'Stone'][(line - 2) / 4]), 0)
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line + 2}, Col 1\\b`))
    }

    // From the last paragraph the caret moves up onto each heading in turn.
    const pane = page.locator('#preview-container')
    for (const [title, line] of [['Ridge', 10], ['Marsh', 6], ['Dunes', 2]]) {
      for (let i = 0; i < (line === 10 ? 2 : 4); i++) await page.keyboard.press('ArrowUp')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}\\b`))
      await expect.poll(() => pane.evaluate(flashGap, title), { timeout: 5_000 }).toBeLessThan(16)
    }
  })

  // A rule writing a two-word prefix before headings of several words:
  // every word of a title lands on its own column of the heading, not as
  // many characters early as the prefix is long, and the prefix on the rule.
  test('a rule writing text before multi-word headings sends each title word to its own column', async ({ page }) => {
    const rule = '#show heading: it => [Teil eins: #it.body]'
    const titles = [['Der alte Leuchtturm am Hafen', 2], ['Zwei kleine Boote', 6]]
    await createProjectAndOpenEditor(page, 'E2E Sync Heading Words')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, `${rule}\n= ${titles[0][0]}\n\nDie Flut steigt.\n\n= ${titles[1][0]}\n\nSie liegen still.\n`)
    await expect(run(page, 'liegen still')).toBeVisible({ timeout: 30_000 })

    for (const [title, line] of titles) {
      const heading = run(page, `Teil eins: ${title}`)
      const text = (await heading.textContent()).trim()
      for (const word of title.split(' ')) {
        // The word's first and last character, each on its own column.
        const at = text.indexOf(` ${word}`) + 1
        for (const k of [0, word.length - 1]) {
          await clickChar(page, heading, at + k)
          await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col ${3 + title.indexOf(word) + k}\\b`))
        }
      }
      for (const word of ['Teil', 'eins']) {
        await clickText(page, heading, word)
        await expect(cursor(page)).toHaveText(new RegExp(`Ln 1, Col ${colOf(rule, word)}\\b`))
      }
    }
  })

  // A footer on every page of a document with no header: both pages' footer
  // words land on the footer's definition, and a caret on that line flashes
  // the first footer.
  test('a footer on a document without a header lands on its definition from every page', async ({ page }) => {
    const line1 = '#set page(height: 8cm, footer: context [Sheet #counter(page).display() of 2])'
    const entries = Array.from({ length: 9 }, (_, i) => `Entry ${i + 1} notes the tide over the harbour mouth at dusk.`)
    await createProjectAndOpenEditor(page, 'E2E Sync Footer Only')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, `${line1}\n= Watch\n\n${entries.join('\n\n')}\n`)
    const second = run(page, 'Sheet 2')
    await expect(second).toBeAttached({ timeout: 30_000 })

    for (const footer of [second, run(page, 'Sheet 1')]) {
      await clickText(page, footer, 'Sheet')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln 1, Col ${colOf(line1, 'Sheet')}\\b`))
      await clickText(page, footer, 'of')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln 1, Col ${colOf(line1, 'of 2')}\\b`))
    }
    await clickChar(page, run(page, 'Entry 9'), 0)
    await expect(cursor(page)).toHaveText(/Ln 20, Col 1\b/)

    const pane = page.locator('#preview-container')
    await clickChar(page, run(page, 'Watch'), 0)
    await expect(cursor(page)).toHaveText(/Ln 2\b/)
    await page.keyboard.press('ArrowUp')
    await expect(cursor(page)).toHaveText(/Ln 1\b/)
    await expect.poll(() => pane.evaluate(flashGap, 'Sheet 1'), { timeout: 5_000 }).toBeLessThan(16)
  })

  // The template prints the title in the body as well, so the header's run
  // also matches that copy and the #show line around it. The title holds no
  // ligature, so every click aims at the glyph of its own character.
  test('a template header mixing its own words with the passed-in title sends each part to its source on every page', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Template Header')
    const mainLine2 = '#show: report.with(title: "Harbour cargo review")'
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(
      page,
      main,
      `#import "tpl/report.typ": report\n${mainLine2}\n\n= Overview\n\nShips arrived early this year.\n\n#pagebreak()\n\nCranes were idle on the second page.\n`
    )
    await waitForSaved(page)
    const line2 = '  set page(height: 7cm, header: [Field notes · #title])'
    const template = await createFile(page, 'tpl/report.typ')
    await replaceBuffer(
      page,
      template,
      `#let report(title: "Untitled", body) = {\n${line2}\n  align(center, text(16pt, strong(title)))\n  body\n}\n`
    )
    await waitForSaved(page)
    await selectFile(page, 'main.typ')
    const headers = page.locator('#typst-svg-output .tsel').filter({ hasText: 'Field notes' })
    await expect(headers).toHaveCount(2, { timeout: 30_000 })

    // The header's own words stay in the template on both pages; the title
    // it prints is the string main.typ passes in.
    for (const header of [headers.nth(1), headers.nth(0)]) {
      for (const word of ['Field', 'notes']) {
        await clickText(page, header, word)
        await expect(activeTab(page)).toContainText('report.typ')
        await expect(cursor(page)).toHaveText(new RegExp(`Ln 2, Col ${colOf(line2, word)}\\b`))
      }
      await clickText(page, header, 'cargo')
      await expect(activeTab(page)).toContainText('main.typ')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln 2, Col ${colOf(mainLine2, 'cargo')}\\b`))
    }

    // The title the template prints in the body, and the body itself, still
    // land on their own text.
    await clickText(page, exactRuns(page, 'Harbour cargo review').first(), 'review')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 2, Col ${colOf(mainLine2, 'review')}\\b`))
    await clickText(page, run(page, 'Cranes were idle'), 'idle')
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 10, Col ${colOf('Cranes were idle on the second page.', 'idle')}\\b`))
  })

  // The user's glossary project (#149), with glossarium's printing done by a
  // local function of the same shape: abbr-setup.typ reads the CSV as
  // dictionaries, abbreviations.typ defines and calls the printer (short
  // form, " --- ", long form, then ";" or "."), and main.typ includes it and
  // prints the same CSV raw.
  test('a glossary printed by a project function opens its CSV row, and its call flashes the list', async ({ page }) => {
    const csvRows = [
      'key,short,long,description',
      'vpp,ВПП,взлетно-посадочная полоса,"элемент конструкции аэродрома, предназначенный для взлета и посадки воздушных судов"',
      'etr,ЕЧР,Европейская часть России,"западная часть территории России, географически относящаяся к Европе"'
    ]
    const printer = [
      '#import "abbr-setup.typ": *',
      '',
      '#let custom-print-glossary(entries) = {',
      '  let txt = text.with(weight: 600)',
      '  for (i, entry) in entries.enumerate() {',
      '    txt(entry.short) + txt[ --- ] + entry.long',
      '    if i + 1 < entries.len() [;] else [.]',
      '    linebreak()',
      '  }',
      '}',
      '',
      '= Перечень сокращений',
      '',
      '#custom-print-glossary(my-glossary-entries)',
      ''
    ]
    await dataProject(
      page,
      'E2E Sync Glossary',
      '#include "abbreviations.typ"\n\n#csv("abbr-list.csv")\n\nClosing words about cranes.\n',
      [
        ['abbr-list.csv', `${csvRows.join('\n')}\n`],
        ['abbr-setup.typ', '#let my-glossary-entries = csv("abbr-list.csv", row-type: dictionary)\n'],
        ['abbreviations.typ', printer.join('\n')]
      ]
    )
    await expect(run(page, 'cranes')).toBeVisible({ timeout: 30_000 })

    // Each value of the list opens its own row of the CSV at the clicked
    // character, not the raw print in main.typ nor the template.
    const values = [
      ['ВПП', 2, 'ВПП'],
      ['взлетно-посадочная полоса', 2, 'посадочная'],
      ['ЕЧР', 3, 'ЧР'],
      ['Европейская часть России', 3, 'России']
    ]
    // A long form shares its run with the punctuation after it; the list
    // comes before the raw print, so the first run holding it is the list's.
    for (const [text, line, needle] of values) {
      const at = colOf(text, needle) - 1
      await clickChar(page, run(page, text), at)
      await expect(activeTab(page)).toContainText('abbr-list.csv')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col ${colOf(csvRows[line - 1], text) + at}\\b`))
    }

    // The dash the printer adds opens the printer's line.
    await exactRuns(page, '—').first().click()
    await expect(activeTab(page)).toContainText('abbreviations.typ')
    await expect(cursor(page)).toHaveText(/Ln 6\b/)

    // The caret on the call (main.typ stays the document) flashes the list,
    // which sits between the heading and the raw print.
    const pane = page.locator('#preview-container')
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown')
    await expect(cursor(page)).toHaveText(/Ln 14\b/)
    await expect(run(page, 'cranes')).toBeVisible()
    const list = { from: 'Перечень сокращений', to: 'key' }
    await expect.poll(() => pane.evaluate(flashBetween, list), { timeout: 5_000 }).toBe(true)
  })

  test('clicks after an escape, a dash and French quotes land on the clicked character', async ({ page }) => {
    const lines = [
      '= Checks',
      '',
      'The fee is \\$5 for kestrels today.',
      '',
      'A literal — dash before herons, and --- one before owls.',
      '',
      '#set text(lang: "fr")',
      '',
      'Plain line with "quoted words" inside it.'
    ]
    await createProjectAndOpenEditor(page, 'E2E Sync Click Columns')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, `${lines.join('\n')}\n`)
    await expect(run(page, 'inside it')).toBeVisible({ timeout: 30_000 })

    for (const [line, needle] of [[3, 'kestrels'], [5, 'herons'], [5, 'owls'], [9, 'words'], [9, 'inside']]) {
      await clickText(page, run(page, needle), needle)
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col ${colOf(lines[line - 1], needle)}\\b`))
    }
  })

  test('the PDF download keeps the entry name after a jump into a chapter', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Download')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, '= Main\n\nParagraph about kestrels.\n\n#include "ch1.typ"\n')
    await waitForSaved(page)
    const ch1 = await createFile(page, 'ch1.typ')
    await replaceBuffer(page, ch1, 'Chapter text about otters.\n')
    await waitForSaved(page)
    await selectFile(page, 'main.typ')
    await expect(run(page, 'otters')).toBeVisible({ timeout: 30_000 })
    await run(page, 'otters').click({ position: { x: 1, y: 4 } })
    await expect(activeTab(page)).toContainText('ch1.typ')

    const download = page.waitForEvent('download', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Download', exact: true }).click()
    const file = await download
    expect(file.suggestedFilename()).toBe('main.pdf')
    const bytes = readFileSync(await file.path())
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  })

  test('clicks in text typed decomposed (NFD) land on the clicked character', async ({ page }) => {
    // Every accented letter is typed as a base letter and combining marks,
    // so the source has more characters than the preview shows; a word after
    // them sits further right in the source than in the run.
    const lines = [
      '= Café notes',
      '',
      'Hélène ouvre le café à huit heures précises.',
      '',
      'Người Việt ăn phở mỗi sáng sớm.'
    ].map((l) => l.normalize('NFD'))
    await createProjectAndOpenEditor(page, 'E2E Sync NFD')
    const cm = await createFile(page, 'main.typ')
    await replaceBuffer(page, cm, `${lines.join('\n')}\n`)
    await expect(run(page, 'heures')).toBeVisible({ timeout: 30_000 })

    // The run may hold the text composed or not: the needle is looked up in
    // the run's own form, the column in the decomposed source.
    for (const [line, word, needle] of [
      [3, 'heures', 'heures'],
      [3, 'précises', 'précises'],
      [3, 'Hélène', 'ne'],
      [5, 'sớm', 'sớm'],
      [5, 'phở', 'phở'],
      [5, 'sáng', 'ng']
    ]) {
      const target = run(page, line === 3 ? 'huit' : 'Vi')
      const text = (await target.textContent()).trim()
      const form = text.includes(word.normalize('NFD')) ? 'NFD' : 'NFC'
      const start = text.indexOf(word.normalize(form))
      expect(start, `"${word}" in the run`).toBeGreaterThanOrEqual(0)
      await clickChar(page, target, start + word.normalize(form).indexOf(needle.normalize(form)))
      const src = lines[line - 1]
      const col = src.indexOf(word.normalize('NFD')) + word.normalize('NFD').indexOf(needle.normalize('NFD')) + 1
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col ${col}\\b`))
    }
  })

  test('a note shared by two chapters of a dynamic include loop opens the note from both copies', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Dynamic Include')
    // The loop includes zeta before alpha, and the files are created in yet
    // another order (the note first, the entry last): neither the listing
    // nor the alphabet, where the note's folder comes first, gives the order
    // of the document. One chapter names the note relative to itself, the
    // other from the project root.
    const files = [
      ['common/note.typ', 'Shared note about herons.\n'],
      ['parts/alpha.typ', '== Alpha chapter\n\nAlpha text about beavers.\n\n#include "../common/note.typ"\n'],
      ['parts/zeta.typ', '== Zeta chapter\n\nZeta text about otters.\n\n#include "/common/note.typ"\n'],
      ['main.typ', '= Book\n\n#for f in ("parts/zeta.typ", "parts/alpha.typ") { include f }\n\nClosing paragraph about kestrels.\n']
    ]
    for (const [path, text] of files) {
      const cm = await createFile(page, path)
      await replaceBuffer(page, cm, text)
      await waitForSaved(page)
    }
    await selectFile(page, 'main.typ')
    await expect(run(page, 'kestrels')).toBeVisible({ timeout: 30_000 })
    const notes = page.locator('#typst-svg-output .tsel').filter({ hasText: 'herons' })
    await expect(notes).toHaveCount(2)

    await clickText(page, run(page, 'otters'), 'otters')
    await expect(activeTab(page)).toContainText('zeta.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf('Zeta text about otters.', 'otters')}\\b`))
    for (const nth of [0, 1]) {
      await clickText(page, notes.nth(nth), 'herons')
      await expect(activeTab(page)).toContainText('note.typ')
      await expect(cursor(page)).toHaveText(new RegExp(`Ln 1, Col ${colOf('Shared note about herons.', 'herons')}\\b`))
    }
    await clickText(page, run(page, 'beavers'), 'beavers')
    await expect(activeTab(page)).toContainText('alpha.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf('Alpha text about beavers.', 'beavers')}\\b`))
    await clickText(page, run(page, 'Alpha chapter'), 'chapter')
    await expect(activeTab(page)).toContainText('alpha.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 1, Col ${colOf('== Alpha chapter', 'chapter')}\\b`))
    await clickText(page, run(page, 'kestrels'), 'kestrels')
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 5, Col ${colOf('Closing paragraph about kestrels.', 'kestrels')}\\b`))
  })
})

// Upload fixture `file` as `name` through the sidebar's picker and return the
// asset's id (the one its `/assets/<id>/raw` URL carries).
async function uploadAs(page, name, file, mimeType) {
  const buffer = readFileSync(join(here, 'fixtures', file))
  await page.locator('#dropped-upload-form input[type=file]').setInputFiles([{ name, mimeType, buffer }])
  const row = page.locator('#asset-tree li').filter({ hasText: name })
  await expect(row).toHaveCount(1)
  return row.locator('[phx-click="delete_asset"]').getAttribute('phx-value-id')
}

// The preview worker's requests for one asset's bytes.
function rawRequests(page, id) {
  const seen = []
  page.on('request', (req) => {
    if (req.url().includes(`/assets/${id}/raw`)) seen.push(req.url())
  })
  return seen
}

test.describe('Project files in the preview', () => {
  test('a JPEG and an SVG picture render, and each jumps to its own line', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Files Formats')
    const cm = await createFile(page, 'main.typ')
    await uploadAs(page, 'blue.jpg', 'blue.jpg', 'image/jpeg')
    await uploadAs(page, 'teal.svg', 'teal.svg', 'image/svg+xml')
    const lines = [
      '= Formats',
      '',
      'Intro about kestrels.',
      '',
      '#image("assets/blue.jpg", width: 2cm)',
      '',
      '#image("assets/teal.svg", width: 2cm)',
      '',
      'After about herons.'
    ]
    await replaceBuffer(page, cm, lines.join('\n') + '\n')
    const pictures = page.locator('#typst-svg-output image')
    await expect(pictures).toHaveCount(2, { timeout: 30_000 })
    await expect(page.locator('#preview-error')).not.toBeVisible()

    // A picture has no character: the caret goes to the end of its line.
    for (const [k, line] of [[0, 5], [1, 7]]) {
      await expect(pictures.nth(k)).toBeVisible()
      await pictures.nth(k).click()
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col ${lines[line - 1].length + 1}\\b`))
    }
  })

  test('a file whose bytes cannot be fetched shows the missing-file error and is asked for once', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Files Gone Object')
    const cm = await createFile(page, 'main.typ')
    const id = await uploadAs(page, 'gone.png', 'dot.png', 'image/png')
    // The asset row is still listed, but its stored object is gone, so the
    // app answers its URL with 404.
    const asked = []
    await page.route(`**/assets/${id}/raw`, (route) => {
      asked.push(route.request().url())
      return route.fulfill({ status: 404, body: 'Not Found' })
    })

    // Each version moves the #image line down a line, so the error naming the
    // new line proves another compile ran; none of them asks for the URL again.
    const body = '= Gone\n\nIntro about kestrels.\n\n#image("assets/gone.png", width: 3cm)\n'
    const error = page.locator('#preview-error')
    for (const extra of [0, 1, 2]) {
      await replaceBuffer(page, cm, 'Opening words.\n'.repeat(extra) + body)
      await expect(error).toContainText(new RegExp(`main\\.typ\\s*:\\s*${5 + extra}\\b`), { timeout: 30_000 })
      await expect(error).toContainText('failed to load file')
    }
    await expect(page.locator('#typst-svg-output image')).toHaveCount(0)
    expect(asked).toHaveLength(1)
  })

  test('a file no source names is not fetched while the document compiles without it', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Files Unreferenced')
    const cm = await createFile(page, 'main.typ')
    const kept = rawRequests(page, await uploadAs(page, 'kept.png', 'dot.png', 'image/png'))
    const idle = rawRequests(page, await uploadAs(page, 'idle.png', 'blue.png', 'image/png'))

    const pictures = page.locator('#typst-svg-output image')
    const body = '= Files\n\n#image("assets/kept.png", width: 2cm)\n\nText about kestrels.\n'
    await replaceBuffer(page, cm, body)
    await expect(pictures).toHaveCount(1, { timeout: 30_000 })
    await replaceBuffer(page, cm, body + '\nMore text about herons.\n')
    await expect(run(page, 'herons')).toBeVisible({ timeout: 30_000 })
    // The named file was fetched once and kept; the other one never.
    expect(kept).toHaveLength(1)
    expect(idle).toHaveLength(0)

    await replaceBuffer(page, cm, body + '\n#image("assets/idle.png", width: 2cm)\n')
    await expect(pictures).toHaveCount(2, { timeout: 30_000 })
    expect(idle).toHaveLength(1)
    expect(kept).toHaveLength(1)
  })

  test('a picture whose path is built at runtime renders, each file fetched once', async ({ page }) => {
    // The worker's first compile fails to load the files and its retry
    // renders them: a failure the retry fixes is not logged.
    const errors = []
    page.on('console', (m) => {
      if (m.type() === 'error' && /typst/i.test(m.text())) errors.push(m.text())
    })
    await createProjectAndOpenEditor(page, 'E2E Files Built Path')
    const cm = await createFile(page, 'main.typ')
    const green = rawRequests(page, await uploadAs(page, 'yesil.png', 'green.png', 'image/png'))
    const blue = rawRequests(page, await uploadAs(page, 'mavi.png', 'blue.png', 'image/png'))

    // No source spells either file name: the path is joined from pieces.
    const body = '#let foto(ad) = box(image("assets/" + ad + ".png", height: 1em))\n= Görseller\n\n#foto("mavi") ve #foto("yesil")\n'
    const pictures = page.locator('#typst-svg-output image')
    await replaceBuffer(page, cm, body + '\nSon.\n')
    await expect(pictures).toHaveCount(2, { timeout: 30_000 })
    await expect(page.locator('#preview-error')).not.toBeVisible()
    await replaceBuffer(page, cm, body + '\nSon about herons.\n')
    await expect(run(page, 'herons')).toBeVisible({ timeout: 30_000 })
    await expect(pictures).toHaveCount(2)
    expect(green).toHaveLength(1)
    expect(blue).toHaveLength(1)
    expect(errors).toEqual([])
  })

  test('pictures whose paths are built at runtime render, and each jumps to its own #image line', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Files Joined Path')
    const cm = await createFile(page, 'main.typ')
    await uploadAs(page, 'gruen.png', 'green.png', 'image/png')
    await uploadAs(page, 'blau.png', 'blue.png', 'image/png')
    // No source spells either file name: each path is joined from pieces.
    const lines = [
      '#let ordner = "assets/"',
      '= Bilder',
      '',
      'Vorher über Reiher.',
      '',
      '#image(ordner + "blau" + ".png", width: 2cm)',
      '',
      '#image(ordner + "gr" + "uen.png", width: 2cm)',
      '',
      'Danach über Otter.'
    ]
    await replaceBuffer(page, cm, lines.join('\n') + '\n')
    const pictures = page.locator('#typst-svg-output image')
    await expect(pictures).toHaveCount(2, { timeout: 30_000 })
    await expect(page.locator('#preview-error')).not.toBeVisible()

    // A picture has no character: the caret goes to the end of its line.
    for (const [k, line] of [[0, 6], [1, 8]]) {
      await pictures.nth(k).click()
      await expect(cursor(page)).toHaveText(new RegExp(`Ln ${line}, Col ${lines[line - 1].length + 1}\\b`))
    }
    await clickText(page, run(page, 'Otter'), 'Otter')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 10, Col ${colOf(lines[9], 'Otter')}\\b`))
  })
})

// Click at fraction `frac` of the advance of glyph `k` (the k-th <use>) of
// the run, the way a user aims at what is drawn rather than at the hidden
// text layer. The point is read until two reads agree, so a scroll still
// settling cannot move the target.
async function clickGlyph(page, loc, k, frac) {
  await loc.scrollIntoViewIfNeeded({ timeout: 5_000 })
  const point = () =>
    loc.evaluate((el, [k, frac]) => {
      const g = el.closest('.typst-text')
      const uses = [...g.children].filter((c) => c.tagName.toLowerCase() === 'use')
      const m = g.getScreenCTM()
      const fo = el.closest('foreignObject')
      const fm = fo.getScreenCTM()
      const x0 = m.a * +uses[k].getAttribute('x') + m.e
      const x1 = k + 1 < uses.length ? m.a * +uses[k + 1].getAttribute('x') + m.e : fm.a * (+fo.getAttribute('x') + +fo.getAttribute('width')) + fm.e
      const b = el.getBoundingClientRect()
      return { x: x0 + (x1 - x0) * frac, y: b.top + b.height / 2 }
    }, [k, frac])
  let pt = await point()
  for (let tries = 0; tries < 20; tries++) {
    await page.waitForTimeout(50)
    const again = await point()
    if (pt.x === again.x && pt.y === again.y) break
    pt = again
  }
  await page.mouse.click(pt.x, pt.y)
}

function glyphCount(loc) {
  return loc.evaluate((el) => [...el.closest('.typst-text').children].filter((c) => c.tagName.toLowerCase() === 'use').length)
}

test.describe('Clicks on drawn glyphs', () => {
  test('a click on the left part of a glyph lands on its character, ligatures and Cyrillic included', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Glyphs')
    const cm = await createFile(page, 'main.typ')
    const latin = 'The office staff fled the flat afire.'
    const cyrillic = 'Взлётная полоса закрыта.'
    await replaceBuffer(page, cm, `= Glyphs\n\n${latin}\n\n${cyrillic}\n`)
    const prose = exactRuns(page, latin)
    await expect(prose).toBeVisible({ timeout: 30_000 })

    // The default serif sets ffi, ff, fl (twice) and fi as single glyphs:
    // 37 characters in 31 glyphs. Without them this test proves nothing.
    expect(await glyphCount(prose)).toBe(31)
    // [glyph, fraction of its advance, column]. Inside a ligature each
    // character owns an equal share of the advance; a click on the left
    // part of a share lands on that character.
    const cases = [
      [4, 0.25, 5], // o of "office"
      [5, 1 / 12, 6], // f of the ffi ligature
      [5, 5 / 12, 7], // its second f
      [5, 9 / 12, 8], // its i
      [6, 0.25, 9], // c, after the ligature
      [22, 1 / 8, 27], // f of the fl in "flat"
      [22, 5 / 8, 28], // its l
      [23, 0.25, 29], // a
      [28, 0.25, 35] // r of "afire", after its fi
    ]
    for (const [k, frac, col] of cases) {
      await clickGlyph(page, prose, k, frac)
      await expect(cursor(page), `glyph ${k} at ${frac}`).toHaveText(new RegExp(`Ln 3, Col ${col}\\b`))
    }

    // One glyph per character: glyph k is column k + 1.
    const cyr = exactRuns(page, cyrillic)
    expect(await glyphCount(cyr)).toBe(Array.from(cyrillic).length)
    for (const k of [0, 3, 10, 17, 22]) {
      await clickGlyph(page, cyr, k, 0.25)
      await expect(cursor(page), `glyph ${k}`).toHaveText(new RegExp(`Ln 5, Col ${k + 1}\\b`))
    }
  })
})

// With live co-editing on, a buffer a preview jump opens starts empty and
// Yjs fills it in after mount: the jump waits for that text (the editor's
// `ready`) before it moves the caret, or the move would land on an empty
// buffer and be lost. Collab is off in the test env, so this needs a server
// booted with TYPSTER_COLLAB=1, like collab.spec.mjs:
//   MIX_ENV=test TYPSTER_COLLAB=1 PORT=4099 bunx playwright test e2e/preview_sync.spec.mjs -g collaborative --project=chromium-authenticated
test.describe('Preview jumps into a collaborative buffer', () => {
  test.skip(process.env.TYPSTER_COLLAB !== '1', 'collaboration disabled (set TYPSTER_COLLAB=1)')

  test('a click on included text lands on its character once the shared text arrives', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Collab')
    const line3 = 'Opening paragraph about kestrels.'
    const main = await createFile(page, 'main.typ')
    await expect(page.locator('#editor-container')).toHaveAttribute('data-collab', 'true')
    await replaceBuffer(page, main, `= Main file\n\n${line3}\n\n#include "ch1.typ"\n`)
    await waitForSaved(page)
    const chapter = 'Included paragraph about otters.'
    const ch1 = await createFile(page, 'ch1.typ')
    await replaceBuffer(page, ch1, `== Chapter one\n\n${chapter}\n`)
    await waitForSaved(page)
    await selectFile(page, 'main.typ')
    await expect(run(page, 'otters')).toBeVisible({ timeout: 30_000 })

    // Into the chapter: the caret lands on the clicked character of the text
    // the shared document brought in.
    await clickText(page, run(page, 'otters'), 'otters')
    await expect(activeTab(page)).toContainText('ch1.typ')
    await expect(page.locator('#editor-container .cm-content')).toContainText(chapter)
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf(chapter, 'otters')}\\b`))
    await expect(page.locator('#editor-container .cm-activeLine')).toContainText('otters')
    // Past the editor's 3 s grace for a buffer that never fills, the caret
    // has not moved again.
    await page.waitForTimeout(3_500)
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf(chapter, 'otters')}\\b`))

    // And back into the entry file, whose shared text arrives the same way.
    await clickText(page, run(page, 'kestrels'), 'kestrels')
    await expect(activeTab(page)).toContainText('main.typ')
    await expect(cursor(page)).toHaveText(new RegExp(`Ln 3, Col ${colOf(line3, 'kestrels')}\\b`))
    await expect(page.locator('#editor-container .cm-activeLine')).toContainText('kestrels')
  })
})
