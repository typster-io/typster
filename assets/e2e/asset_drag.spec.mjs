import { test, expect } from "@playwright/test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const fontBytes = readFileSync(join(here, "fixtures/NotoSansLycian-Regular.ttf"))

// Opens a fresh project's editor with an empty main.typ ready for typing.
async function openEditor(page, name) {
  await page.goto("/projects")
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
  await page.locator("#new-project-button").click()
  await page.locator('.ts-dialog input[name="name"]').fill(name)
  await page.locator('.ts-dialog button[type="submit"]').click()
  const row = page.locator(".ts-list__row").filter({ hasText: name })
  await row.getByRole("link", { name: "Open" }).click()
  await createFile(page, "main.typ")
  const cm = page.locator("#editor-container .cm-content")
  await cm.click({ timeout: 10_000 })
  return cm
}

// Creates a text file through the Files panel; the editor switches to it.
async function createFile(page, path) {
  await page.locator("#create-main-file-button").click()
  const draft = page.locator('#new-file-form input[name="path"]')
  await draft.fill(path)
  await draft.press("Enter")
  await expect(page.locator("#file-tree-main li.is-active")).toContainText(path.split("/").pop())
}

// The draggable row whose label is exactly `name`, inside `tree`.
function row(page, tree, name) {
  return page.locator(`${tree} li[data-insert]`).filter({ has: page.getByText(name, { exact: true }) })
}

async function openFile(page, name) {
  await page.locator("#file-tree-main li").filter({ has: page.getByText(name, { exact: true }) }).click()
  await expect(page.locator("#file-tree-main li.is-active")).toContainText(name)
}

// Empties the editor, drops `source` into it and expects exactly `snippet`.
async function expectDrop(page, cm, source, snippet) {
  await cm.click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.press("Backspace")
  await source.dragTo(cm.locator(".cm-line").first())
  await expect(cm.locator(".cm-line")).toHaveText([snippet])
}

async function uploadAssets(page, files) {
  await page.locator("#asset-upload-form input[type=file]").setInputFiles(
    files.map(([name, mimeType, buffer]) => ({ name, mimeType, buffer }))
  )
  await page.locator("#upload-asset-button").click()
  for (const [name] of files) {
    await expect(page.locator("#asset-tree li").filter({ has: page.getByText(name, { exact: true }) })).toHaveCount(1)
  }
}

// Drag-to-insert (#97): a dragged row drops its Typst snippet, with the path
// relative to the open file, at the drop position.
test.describe("Drag a file or asset into the editor", () => {
  test("every text file type in the Files tree, and a pinned file", async ({ page }) => {
    test.setTimeout(90_000)
    const cm = await openEditor(page, `File Drag ${Date.now()}`)

    const cases = [
      ["chapters/intro.typ", "intro.typ", '#include "chapters/intro.typ"'],
      ["refs.bib", "refs.bib", '#bibliography("refs.bib")'],
      ["data.csv", "data.csv", '#csv("data.csv")'],
      ["conf.yaml", "conf.yaml", '#yaml("conf.yaml")'],
      ["meta.yml", "meta.yml", '#yaml("meta.yml")'],
      ["table.tsv", "table.tsv", '#read("table.tsv")'],
      ["notes.md", "notes.md", '#read("notes.md")'],
      ["paper.tex", "paper.tex", '#read("paper.tex")'],
      ["old.latex", "old.latex", '#read("old.latex")'],
      ["style.sty", "style.sty", '#read("style.sty")'],
      ["thesis.cls", "thesis.cls", '#read("thesis.cls")']
    ]
    for (const [path] of cases) await createFile(page, path)
    await openFile(page, "main.typ")

    for (const [, label, snippet] of cases) {
      await test.step(label, () => expectDrop(page, cm, row(page, "#file-tree-main", label), snippet))
    }

    // The open file carries no snippet: it can't include itself.
    await expect(row(page, "#file-tree-main", "main.typ")).toHaveCount(0)

    await test.step("pinned file", async () => {
      const bib = page.locator("#file-tree-main li").filter({ has: page.getByText("refs.bib", { exact: true }) })
      await bib.hover()
      await bib.locator('button[phx-click="toggle_pin"]').click()
      await expectDrop(page, cm, row(page, "#pinned-tree", "refs.bib"), '#bibliography("refs.bib")')
    })

    await test.step("from a file in a subfolder", async () => {
      await openFile(page, "intro.typ")
      await expectDrop(page, cm, row(page, "#file-tree-main", "main.typ"), '#include "../main.typ"')
      await expectDrop(page, cm, row(page, "#file-tree-main", "data.csv"), '#csv("../data.csv")')
    })
  })

  test("every uploadable asset type", async ({ page }) => {
    test.setTimeout(120_000)
    const cm = await openEditor(page, `Asset Drag ${Date.now()}`)
    const stub = Buffer.from("stub")

    // The upload form takes five files at a time.
    await uploadAssets(page, [
      ["logo.png", "image/png", stub],
      ["photo.jpg", "image/jpeg", stub],
      ["scan.jpeg", "image/jpeg", stub],
      ["diagram.svg", "image/svg+xml", stub],
      ["banner.webp", "image/webp", stub]
    ])
    await uploadAssets(page, [
      ["paper.pdf", "application/pdf", stub],
      ["Lycian.ttf", "font/ttf", fontBytes],
      ["LycianAlt.otf", "font/otf", fontBytes],
      ["Sans.woff", "font/woff", stub],
      ["Mono.woff2", "font/woff2", stub]
    ])
    await openFile(page, "main.typ")

    for (const [label, snippet] of [
      ["logo.png", '#image("assets/logo.png")'],
      ["photo.jpg", '#image("assets/photo.jpg")'],
      ["scan.jpeg", '#image("assets/scan.jpeg")'],
      ["diagram.svg", '#image("assets/diagram.svg")'],
      ["banner.webp", '#image("assets/banner.webp")'],
      ["paper.pdf", '#image("assets/paper.pdf")']
    ]) {
      await test.step(label, () => expectDrop(page, cm, row(page, "#asset-tree", label), snippet))
    }

    // A font becomes draggable once the preview reports its family name.
    for (const label of ["Lycian.ttf", "LycianAlt.otf"]) {
      await test.step(label, async () => {
        await expect(row(page, "#asset-tree", label)).toHaveCount(1, { timeout: 60_000 })
        await expectDrop(page, cm, row(page, "#asset-tree", label), '#set text(font: "Noto Sans Lycian")')
      })
    }

    // Typst can't read web fonts, so their rows have nothing to drag.
    for (const label of ["Sans.woff", "Mono.woff2"]) {
      const li = page.locator("#asset-tree li").filter({ has: page.getByText(label, { exact: true }) })
      await expect(li).toHaveCount(1)
      await expect(li).not.toHaveAttribute("data-insert")
      await expect(li).not.toHaveAttribute("draggable")
    }

    await test.step("from a file in a subfolder", async () => {
      await createFile(page, "chapters/intro.typ")
      await expectDrop(page, cm, row(page, "#asset-tree", "logo.png"), '#image("../assets/logo.png")')
    })
  })
})

// Starts a drag on the row labelled `name` in `tree` and returns what the hook
// handed to setDragImage. The real drag image is a native bitmap Playwright
// can't see, so a spy on the DataTransfer stands in for it.
async function dragImageOf(page, tree, name) {
  return page.evaluate(
    async ([tree, name]) => {
      const li = [...document.querySelectorAll(`${tree} li`)].find(
        (l) => l.querySelector(".truncate")?.textContent.trim() === name
      )
      const dt = new DataTransfer()
      let image = null
      dt.setDragImage = (el, x, y) => {
        image = {
          chip: el.querySelector(".ts-filechip")?.className || null,
          name: el.querySelector(".ts-dragghost__name")?.textContent || null,
          snippet: el.querySelector(".ts-dragghost__snippet")?.textContent || null,
          inApp: !!el.closest(".ts-app"),
          offset: [x, y]
        }
      }
      li.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }))
      li.dispatchEvent(new DragEvent("dragend", { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { image, leftover: document.querySelectorAll(".ts-dragghost").length }
    },
    [tree, name]
  )
}

test.describe("Drag image while dragging a row", () => {
  test("shows the row's chip, name and the snippet a drop inserts", async ({ page }) => {
    await openEditor(page, `Drag Image ${Date.now()}`)
    await createFile(page, "refs.bib")
    await openFile(page, "main.typ")

    const fromTree = await dragImageOf(page, "#file-tree-main", "refs.bib")
    expect(fromTree.image).toEqual({
      chip: "ts-filechip ts-filechip--bib",
      name: "refs.bib",
      snippet: '#bibliography("refs.bib")',
      inApp: true,
      offset: [12, 12]
    })
    // The ghost is only there for the browser's snapshot.
    expect(fromTree.leftover).toBe(0)

    // The open file has no snippet, but moving it still shows chip and name.
    const openOne = await dragImageOf(page, "#file-tree-main", "main.typ")
    expect(openOne.image).toMatchObject({ chip: "ts-filechip ts-filechip--typ", name: "main.typ", snippet: null })

    const bib = page.locator("#file-tree-main li").filter({ has: page.getByText("refs.bib", { exact: true }) })
    await bib.hover()
    await bib.locator('button[phx-click="toggle_pin"]').click()
    await expect(page.locator("#pinned-tree li[data-insert]")).toHaveCount(1)

    const fromPinned = await dragImageOf(page, "#pinned-tree", "refs.bib")
    expect(fromPinned.image).toMatchObject({ name: "refs.bib", snippet: '#bibliography("refs.bib")' })
    expect(fromPinned.leftover).toBe(0)
  })
})
