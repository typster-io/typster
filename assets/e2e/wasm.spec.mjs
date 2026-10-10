import { test, expect } from '@playwright/test'
import { uniqueProjectName, projectRow } from './unique_project.mjs'

const WASM_FILES = [
  'typst_ts_web_compiler_bg.wasm',
  'typst_ts_renderer_bg.wasm',
]

test.describe('WASM assets', () => {
  for (const filename of WASM_FILES) {
    test(`serves ${filename} with correct content-type`, async ({ request }) => {
      const response = await request.get(`/assets/js/${filename}`)
      expect(response.status()).toBe(200)
      // Browsers require application/wasm for WebAssembly.instantiate to work
      expect(response.headers()['content-type']).toContain('application/wasm')
    })
  }
})

test.describe('Typst WASM compilation pipeline', () => {
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

  test('compiles typst content and renders preview without WASM errors', async ({ page }) => {
    test.setTimeout(60_000)
    const wasmErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && msg.text().includes('wasm')) {
        wasmErrors.push(msg.text())
      }
    })
    page.on('pageerror', (err) => {
      if (err.message.includes('wasm')) {
        wasmErrors.push(err.message)
      }
    })

    await createProjectAndOpenEditor(page, 'E2E WASM Test')
    await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })

    await page.locator('#create-main-file-button').click()
    const draftInput = page.locator('#new-file-form input[name="path"]')
    await expect(draftInput).toBeVisible()
    await draftInput.fill('main.typ')
    await draftInput.press('Enter')

    const cmContent = page.locator('#editor-container .cm-content')
    await expect(cmContent).toBeVisible({ timeout: 10_000 })
    await cmContent.click()

    // Select all default content and replace with a minimal typst document
    await page.keyboard.press('Control+a')
    await page.keyboard.type('= Hello\n\nWorld')

    // Wait for save cycle
    await expect(page.locator('#save-status')).toHaveClass(/ts-savestat--saved/, { timeout: 15_000 })

    // Preview iframe or SVG should appear — no error card, no WASM console errors
    await expect(page.locator('#preview-error')).not.toBeVisible({ timeout: 30_000 })

    // The SVG canvas element (or rendered output) must appear in the preview pane
    const previewScroll = page.locator('#preview-container')
    await expect(previewScroll.locator('svg, canvas')).toBeVisible({ timeout: 30_000 })

    expect(wasmErrors).toEqual([])
  })
})
