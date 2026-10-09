import { test, expect } from '@playwright/test'

// Preview ↔ source sync (#149): a click in the rendered preview moves the
// editor's caret to the matching source line (switching files when the text
// came from an `#include`d file), and a resting caret scrolls the preview to
// its run and flashes it.
test.setTimeout(90_000)

async function createProjectAndOpenEditor(page, name) {
  await page.goto('/projects')
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
  await page.locator('#new-project-button').click()
  await expect(page.locator('.ts-dialog')).toBeVisible({ timeout: 10_000 })
  await page.locator('.ts-dialog input[name="name"]').fill(name)
  await page.locator('.ts-dialog button[type="submit"]').click()
  await expect(page.locator('.ts-dialog')).not.toBeVisible()
  const row = page.locator('.ts-list__row').filter({ hasText: name })
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
async function replaceBuffer(page, cm, text) {
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

    await run(page, 'herons').click()

    await expect(page.locator('#status-cursor')).toHaveText(/Ln 7, Col 1\b/)
    await expect(page.locator('#editor-container .cm-activeLine')).toContainText('herons')

    // A heading maps onto its own line, past the `== ` marker.
    await run(page, 'Beta section').click()
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 5, Col 4\b/)
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

    await run(page, 'otters').click()

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

  test('generated text lands on the call that produced it', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Lorem')
    const cm = await createFile(page, 'main.typ')
    // Lorem has no source text to match; the paragraph belongs to `#lorem`.
    await replaceBuffer(page, cm, '= Filler\n\nA real sentence about kestrels.\n\n#lorem(60)\n\n== After\n\nAnother real sentence about herons.\n')
    await expect(run(page, 'herons')).toBeVisible({ timeout: 30_000 })

    await run(page, 'ipsum').click()
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 5, Col 1\b/)

    // A later line of the same paragraph maps to the same call, not to the
    // heading that follows it.
    await page.locator('#typst-svg-output .tsel').filter({ hasText: /\b(?:tempor|labore|dolore|magna|aliqua)\b/ }).last().click()
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 5, Col 1\b/)
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

    // The generated "1." in front of the heading belongs to the heading line.
    await page.locator('#typst-svg-output .tsel').filter({ hasText: /^1\.$/ }).first().click()
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 2, Col 1\b/)

    // The second bullet glyph belongs to the second item's line.
    await page.locator('#typst-svg-output .tsel').filter({ hasText: /^•$/ }).nth(1).click()
    await expect(page.locator('#status-cursor')).toHaveText(/Ln 5, Col 1\b/)
  })

  test('the previewed document survives a data file, a closed tab and a quick jump', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Sync Entry')
    const main = await createFile(page, 'main.typ')
    await replaceBuffer(page, main, '= Main file\n\nOpening paragraph about kestrels.\n\n#include "ch1.typ"\n')
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
    await run(page, 'kestrels').click()
    await expect(page.locator('.ts-formatbar__hint')).toContainText('main.typ')
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
})
