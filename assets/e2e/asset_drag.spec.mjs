import { test, expect } from "@playwright/test"

// Opens a fresh project's editor with an empty main.typ ready for typing.
async function openEditor(page, name) {
  await page.goto("/projects")
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
  await page.locator("#new-project-button").click()
  await page.locator('.ts-dialog input[name="name"]').fill(name)
  await page.locator('.ts-dialog button[type="submit"]').click()
  const row = page.locator(".ts-list__row").filter({ hasText: name })
  await row.getByRole("link", { name: "Open" }).click()
  await page.locator("#create-main-file-button").click()
  const draft = page.locator('#new-file-form input[name="path"]')
  await draft.fill("main.typ")
  await draft.press("Enter")
  const cm = page.locator("#editor-container .cm-content")
  await cm.click({ timeout: 10_000 })
  return cm
}

// Asset drag-to-insert (#97). Browser CI has no object storage to upload to,
// so the spec adds a row shaped like the server's (see FileTree.tree_rows)
// to the real assets list; the AssetDrag hook and CodeMirror do the rest.
test.describe("Assets panel drag into the editor", () => {
  test("dropping an image asset inserts an image() call", async ({ page }) => {
    const cm = await openEditor(page, `Asset Drag ${Date.now()}`)
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type("= Title\n")

    await page.locator("#asset-tree").evaluate((ul) => {
      const li = document.createElement("li")
      li.id = "asset-entry-e2e"
      li.className = "ts-tree__item is-asset"
      li.draggable = true
      li.dataset.assetInsert = '#image("/assets/logo.png")'
      li.textContent = "logo.png"
      ul.appendChild(li)
    })

    await page.locator("#asset-entry-e2e").dragTo(cm.locator(".cm-line").last())

    await expect(cm.locator(".cm-line")).toHaveText(["= Title", '#image("/assets/logo.png")'])
  })
})
