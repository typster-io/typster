import { test, expect } from '@playwright/test'
import { uniqueProjectName, projectRow } from './unique_project.mjs'

// Custom CodeMirror find & replace panel (.ts-cm-search). Verifies the panel
// opens from the toolbar, the live match count reflects the query (and the case
// toggle), invalid regex is surfaced, replace-all mutates the document, and
// Escape closes it.

async function createProjectAndOpenEditor(page, name) {
  name = uniqueProjectName(name)
  await page.goto('/projects')
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
  await page.locator('#new-project-button').click()
  await expect(page.locator('.ts-dialog')).toBeVisible()
  await page.locator('.ts-dialog input[name="name"]').fill(name)
  await page.locator('.ts-dialog button[type="submit"]').click()
  await expect(page.locator('.ts-dialog')).not.toBeVisible()

  const row = projectRow(page, name)
  await expect(row).toBeVisible()
  await row.getByRole('link', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/projects\/.+\/edit/)
}

// New files seed a default template, so clear the doc before typing our own.
async function addMainFileWith(page, text) {
  await page.locator('#create-main-file-button').click()
  const draftInput = page.locator('#new-file-form input[name="path"]')
  await expect(draftInput).toBeVisible()
  await draftInput.fill('main.typ')
  await draftInput.press('Enter')

  const cm = page.locator('#editor-container .cm-content')
  await expect(cm).toBeVisible({ timeout: 10_000 })
  await cm.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
  await expect(cm).toContainText(text)
  return cm
}

test.describe('Editor search panel', () => {
  test('finds, counts, toggles case, replaces, and closes', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Search Panel E2E')
    const cm = await addMainFileWith(page, 'foo foo foo Foo')

    const panel = page.locator('.ts-cm-search')
    const find = panel.locator('.ts-cm-search__input[aria-label="Find"]')
    const count = panel.locator('.ts-cm-search__count')

    // Open from the toolbar Find button; the find input takes focus.
    await page.getByRole('button', { name: 'Find & replace' }).click()
    await expect(panel).toBeVisible()
    await expect(find).toBeFocused()

    // Case-insensitive "foo" matches all four (foo, foo, foo, Foo).
    await find.fill('foo')
    await expect(count).toContainText('4')

    // Next advances to a match → the count gains a current index.
    await panel.locator('.ts-cm-search__btn[aria-label^="Next match"]').click()
    await expect(count).toContainText('of 4')

    // Match case excludes "Foo" → three matches, and the toggle reads pressed.
    const caseToggle = panel.locator('[aria-label="Match case"]')
    await caseToggle.click()
    await expect(caseToggle).toHaveClass(/is-active/)
    await expect(count).toContainText('3')
    await expect(count).not.toContainText('4')
    await caseToggle.click() // back to case-insensitive

    // A term that doesn't exist reports no results.
    await find.fill('zzz')
    await expect(count).toHaveText('No results')

    // Invalid regular expression is surfaced.
    await panel.locator('[aria-label="Regular expression"]').click()
    await find.fill('fo(')
    await expect(panel).toHaveClass(/ts-cm-search--invalid/)
    await expect(count).toHaveText('Invalid regex')
    await panel.locator('[aria-label="Regular expression"]').click() // back to plain text

    // Replace all rewrites every match.
    await find.fill('foo')
    await expect(count).toContainText('4')
    await panel.locator('.ts-cm-search__input[aria-label="Replace with"]').fill('bar')
    await panel.getByRole('button', { name: 'Replace all matches' }).click()
    await expect(cm).toContainText('bar bar bar bar')
    await expect(count).toHaveText('No results')

    // Escape closes the panel.
    await find.click()
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
  })
})
