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

// Drag-to-insert (#97): a dragged row drops its Typst snippet, with the path
// relative to the open file, at the drop position.
test.describe("Drag a file or asset into the editor", () => {
  test("dropping a file row inserts an include with its relative path", async ({ page }) => {
    const cm = await openEditor(page, `File Drag ${Date.now()}`)

    await page.locator("#create-main-file-button").click()
    const draft = page.locator('#new-file-form input[name="path"]')
    await draft.fill("chapters/intro.typ")
    await draft.press("Enter")

    const tree = page.locator("#file-tree-main")
    await tree.locator("li[data-insert]").filter({ hasText: "main.typ" }).click()
    await expect(tree.locator("li.is-active")).toContainText("main.typ")

    await cm.click()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type("= Title\n")

    await tree.locator("li[data-insert]").filter({ hasText: "intro.typ" }).dragTo(cm.locator(".cm-line").last())

    await expect(cm.locator(".cm-line")).toHaveText(["= Title", '#include "chapters/intro.typ"'])
  })

  // Browser CI has no object storage to upload to, so this adds an asset row
  // shaped like the server's (see FileTree.tree_rows) to the real assets list.
  test("dropping an asset row inserts an image() call", async ({ page }) => {
    const cm = await openEditor(page, `Asset Drag ${Date.now()}`)
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type("= Title\n")

    await page.locator("#asset-tree").evaluate((ul) => {
      const li = document.createElement("li")
      li.id = "asset-entry-e2e"
      li.className = "ts-tree__item is-asset"
      li.draggable = true
      li.dataset.insert = '#image("assets/logo.png")'
      li.textContent = "logo.png"
      ul.appendChild(li)
    })

    await page.locator("#asset-entry-e2e").dragTo(cm.locator(".cm-line").last())

    await expect(cm.locator(".cm-line")).toHaveText(["= Title", '#image("assets/logo.png")'])
  })
})
