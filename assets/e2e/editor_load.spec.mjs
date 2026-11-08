import { test, expect } from '@playwright/test'
import { uniqueProjectName, projectRow } from './unique_project.mjs'

// Creates a project via the projects page dialog and opens its editor.
// Returns after the editor URL is confirmed.
async function createProjectAndOpenEditor(page, name) {
  name = uniqueProjectName(name)
  await page.goto('/projects')
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
  await page.locator('#new-project-button').click()
  await expect(page.locator('.ts-dialog')).toBeVisible()

  await page.locator('.ts-dialog input[name="name"]').fill(name)
  await page.locator('.ts-dialog button[type="submit"]').click()

  await expect(page.locator('.ts-dialog')).not.toBeVisible()

  // Find the newly created project row and open it
  const row = projectRow(page, name)
  await expect(row).toBeVisible()
  await row.getByRole('link', { name: 'Open' }).click()

  await expect(page).toHaveURL(/\/projects\/.+\/edit/)
}

test.describe('Typster Editor Workflow', () => {
  test('should create a project and load the editor with a file', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Smoke Test')

    // Click the "+" sidebar button — reveals the inline new-file draft row
    await page.locator('#create-main-file-button').click()
    const draftInput = page.locator('#new-file-form input[name="path"]')
    await expect(draftInput).toBeVisible()
    await draftInput.fill('main.typ')
    await draftInput.press('Enter')

    // main.typ should appear in the file tree
    await expect(
      page.locator('.ts-tree__item').filter({ hasText: 'main.typ' })
    ).toBeVisible()

    // Editor container should be mounted and CodeMirror visible
    await expect(page.locator('#editor-container')).toBeVisible()
    await expect(page.locator('#editor-container .cm-content')).toBeVisible({ timeout: 10_000 })
  })

  test('should edit content in CodeMirror, autosave, and persist after reload', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'E2E Autosave Test')

    // Create main.typ via the inline new-file draft row
    await page.locator('#create-main-file-button').click()
    const draftInput = page.locator('#new-file-form input[name="path"]')
    await expect(draftInput).toBeVisible()
    await draftInput.fill('main.typ')
    await draftInput.press('Enter')

    // Wait for CodeMirror to initialize inside the container
    const cmContent = page.locator('#editor-container .cm-content')
    await expect(cmContent).toBeVisible({ timeout: 10_000 })
    await cmContent.click()

    const testText = 'Hello from E2E autosave test!'
    await page.keyboard.type(testText)

    // Wait for the save cycle: saving → saved
    await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saving/, { timeout: 8_000 })
    await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saved/, { timeout: 10_000 })

    // Reload and verify the content persisted
    await page.reload()

    // main.typ is the initial_file so the editor loads automatically
    await expect(page.locator('#editor-container')).toBeVisible()
    await expect(page.locator('#editor-container .cm-content')).toContainText(testText)
  })
})
