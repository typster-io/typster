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
    const gap = await pane.evaluate((el) => {
      const flash = el.querySelector('.ts-preview__flash').getBoundingClientRect()
      const sel = [...el.querySelectorAll('.tsel')].find((n) => n.textContent.includes('wombats'))
      const text = sel.getBoundingClientRect()
      return Math.abs(flash.top - text.top) + Math.abs(flash.left - text.left)
    })
    expect(gap).toBeLessThan(16)
  })
})
