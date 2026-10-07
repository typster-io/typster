import { test, expect } from '@playwright/test'

async function createProjectAndOpenEditor(page, name) {
  await page.goto('/projects')
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
  await page.locator('#new-project-button').click()
  await expect(page.locator('.ts-dialog')).toBeVisible()
  await page.locator('.ts-dialog input[name="name"]').fill(name)
  await page.locator('.ts-dialog button[type="submit"]').click()
  await expect(page.locator('.ts-dialog')).not.toBeVisible()

  const row = page.locator('.ts-list__row').filter({ hasText: name })
  await expect(row).toBeVisible()
  await row.getByRole('link', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/projects\/.+\/edit/)
}

async function addMainFile(page) {
  await page.locator('#create-main-file-button').click()
  const draftInput = page.locator('#new-file-form input[name="path"]')
  await expect(draftInput).toBeVisible()
  await draftInput.fill('main.typ')
  await draftInput.press('Enter')
  await expect(page.locator('#editor-container .cm-content')).toBeVisible({ timeout: 10_000 })
}

test.describe('Fork flow — make a copy on /p/:slug', () => {
  test('copy modal: entry, escape, inline error, and the full happy path', async ({ page }) => {
    test.setTimeout(120_000)
    await createProjectAndOpenEditor(page, 'fork-me')
    await addMainFile(page)

    // Owner enables copying on the share link.
    await page.locator('.ts-tb__share').click()
    const modal = page.locator('.share-shell')
    await expect(modal).toBeVisible({ timeout: 5000 })
    await modal.locator('#share-toggle-fork').click()
    await expect(modal.locator('#share-toggle-fork')).toHaveClass(/\bon\b/)
    // Navigate by relative path: the copyable link carries the endpoint's
    // configured host, which differs from the test origin (and would drop
    // the session cookie — turning the signed-in visitor anonymous).
    const path = (await modal.locator('.link-box .path').textContent()).trim()
    const token = path.match(/key=([\w-]+)/)[1]

    // Visit the public page: copy is the main action, the read-only pill
    // demotes to icon-only, the source pane carries the view-only hint.
    await page.goto(`/p/fork-me?key=${token}`)
    const openBtn = page.locator('#shared-fork-open')
    await expect(openBtn).toBeVisible({ timeout: 10_000 })
    await expect(openBtn).toHaveClass(/ts-btn--primary/)
    await expect(page.locator('.ro-pill--compact')).toBeVisible()
    await expect(page.locator('.fk-lock-hint')).toBeVisible()

    // Below 720px the file name hides and the copy button goes icon-only,
    // its label moving into the tooltip.
    const wide = page.viewportSize()
    await page.setViewportSize({ width: 700, height: wide.height })
    await expect(page.locator('.embed-bar .file')).toBeHidden()
    await expect(openBtn.locator('.lbl')).toBeHidden()
    await expect(openBtn).toHaveAttribute('title', /\S/)

    // Phone width: one pane at a time, picked by the Preview | Source switch.
    await page.setViewportSize({ width: 390, height: wide.height })
    await expect(page.locator('#shared-pane-switch')).toBeVisible()
    await expect(page.locator('.embed-preview')).toBeVisible()
    await expect(page.locator('.embed-source')).toBeHidden()
    await page.locator('#shared-pane-source').click()
    await expect(page.locator('.embed-source')).toBeVisible()
    await expect(page.locator('.embed-preview')).toBeHidden()
    await page.locator('#shared-pane-preview').click()
    await expect(page.locator('.embed-preview')).toBeVisible()

    await page.setViewportSize(wide)
    await expect(page.locator('#shared-pane-switch')).toBeHidden()
    await expect(openBtn.locator('.lbl')).toBeVisible()

    // Escape closes the modal.
    await openBtn.click()
    await expect(page.locator('.fk-modal')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.fk-modal')).not.toBeVisible()

    // Empty name → inline error, modal stays.
    await openBtn.click()
    const nameInput = page.locator('#shared-fork-form input[name="fork[name]"]')
    await expect(nameInput).toHaveValue(/fork-me/)
    // Prefilled name is focused and fully selected, so typing replaces it.
    await expect(nameInput).toBeFocused()
    expect(
      await nameInput.evaluate((el) => el.selectionStart === 0 && el.selectionEnd === el.value.length)
    ).toBe(true)
    await expect(page.locator('.fk-meta')).toBeVisible()
    await nameInput.fill('')
    await page.locator('#shared-fork-form button[type="submit"]').click()
    await expect(page.locator('#shared-fork-error')).toBeVisible()
    await expect(page.locator('.fk-modal')).toBeVisible()

    // Real name → redirect into the copy's editor with the success flash.
    await nameInput.fill('fork-me (e2e copy)')
    await page.locator('#shared-fork-form button[type="submit"]').click()
    await expect(page).toHaveURL(/\/projects\/.+\/edit/, { timeout: 15_000 })
    await expect(page.locator('#flash-info')).toContainText('yours now')
  })
})
