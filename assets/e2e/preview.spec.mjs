import { test, expect } from '@playwright/test'

test.setTimeout(60_000)

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

async function createFileAndOpenEditor(page) {
  await page.locator('#create-main-file-button').click()
  const draftInput = page.locator('#new-file-form input[name="path"]')
  await expect(draftInput).toBeVisible()
  await draftInput.fill('main.typ')
  await draftInput.press('Enter')
  const cm = page.locator('#editor-container .cm-content')
  await expect(cm).toBeVisible({ timeout: 10_000 })
  return cm
}

test.describe('Preview pane', () => {
  test('renders SVG after typing valid typst content', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Preview Render')
    const cm = await createFileAndOpenEditor(page)

    await cm.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('= Hello\n\nWorld')

    await expect(page.locator('#preview-container svg')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#preview-placeholder')).not.toBeVisible()
  })

  test('status bar shows the word count of the compiled document', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Word Count')
    const cm = await createFileAndOpenEditor(page)

    await cm.click()
    await page.keyboard.press('Control+a')
    // Code and markup do not count; the heading and the sentence do: 1 + 7 = 8.
    await page.keyboard.type('#set text(size: 12pt)\n= Title\n\nHello wonderful world, here are seven words.')

    await expect(page.locator('#preview-container svg')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#status-words')).toHaveText(/\b8 words\b/, { timeout: 15_000 })
    await expect(page.locator('#status-words')).toHaveAttribute('title', /characters, not counting spaces/)
  })

  test('preview SVG persists through autosave re-renders', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Preview Persistence')
    const cm = await createFileAndOpenEditor(page)

    await cm.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('= Persistence\n\nFirst save.')

    // Wait for the first full save cycle
    await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saving/, { timeout: 8_000 })
    await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saved/, { timeout: 10_000 })

    // SVG should be visible after first save
    await expect(page.locator('#preview-container svg')).toBeVisible({ timeout: 30_000 })

    // Type more to trigger a second server round-trip
    await cm.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Updated.')

    await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saving/, { timeout: 8_000 })
    await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saved/, { timeout: 10_000 })

    // SVG must still be visible — LiveView re-render must not wipe the preview
    await expect(page.locator('#preview-container svg')).toBeVisible()
    await expect(page.locator('#preview-placeholder')).not.toBeVisible()
  })

  test('shows error for invalid typst and hides placeholder', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Preview Error')
    const cm = await createFileAndOpenEditor(page)

    await cm.click()
    await page.keyboard.press('Control+a')
    // #import of a non-existent file is a reliable compile-time error
    await page.keyboard.type('#import "does-not-exist.typ": *')

    await expect(page.locator('#preview-container #preview-error')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#preview-placeholder')).not.toBeVisible()
    await expect(page.locator('#preview-container svg')).not.toBeVisible()
  })

  test('recovers from error to SVG when content is fixed', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Preview Recovery')
    const cm = await createFileAndOpenEditor(page)

    // First: invalid content → error
    await cm.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('#import "does-not-exist.typ": *')
    await expect(page.locator('#preview-container #preview-error')).toBeVisible({ timeout: 30_000 })

    // Then: replace with valid content → SVG, error gone
    await cm.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('= Recovered\n\nAll good.')
    await expect(page.locator('#preview-container svg')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#preview-container #preview-error')).not.toBeVisible()
  })
})
