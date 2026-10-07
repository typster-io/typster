import { test, expect } from "@playwright/test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// Custom fonts (#153): a project font arrives in `project.assets` with
// `kind: "font"` and a URL; the worker fetches it, registers it with the
// compiler alongside the default text fonts and reports the family names it
// read. We drive the real worker like the editor does. The fixture is Noto
// Sans Lycian (SIL OFL 1.1, see fixtures/OFL.txt), 4.5 kB, and travels as a
// data: URL so the spec needs neither object storage nor network.
const here = dirname(fileURLToPath(import.meta.url))
const fontBase64 = readFileSync(join(here, "fixtures/NotoSansLycian-Regular.ttf")).toString("base64")
const fontUrl = `data:font/ttf;base64,${fontBase64}`

async function compileWithFonts(page, project, content) {
  return page.evaluate(
    ([project, content]) =>
      new Promise((resolve) => {
        const worker = new Worker("/assets/js/typst_worker_impl.js", { type: "module" })
        const out = { fonts: null, render: false, error: null }
        let timer
        const done = () => {
          clearTimeout(timer)
          worker.terminate()
          resolve(out)
        }
        timer = setTimeout(() => {
          out.error = out.error || "timeout"
          done()
        }, 40_000)
        worker.onmessage = (event) => {
          const { type, data } = event.data
          if (type === "fonts") out.fonts = data.fonts
          else if (type === "render") {
            out.render = true
            out.svg = data.svg
            done()
          } else if (type === "error") {
            out.error = (data && data.message) || "error"
            done()
          }
        }
        worker.onerror = (err) => {
          out.error = String(err.message || err)
          done()
        }
        worker.postMessage({ type: "compile", content, project })
      }),
    [project, content]
  )
}

test.describe("Project fonts in the preview", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
  })

  test("an uploaded TTF is registered and its family name reported", async ({ page }) => {
    test.setTimeout(90_000)
    const content = '#set text(font: "Noto Sans Lycian")\n= Lycian\n𐊀𐊁𐊂'
    const result = await compileWithFonts(
      page,
      {
        mainPath: "main.typ",
        sources: [],
        assets: [
          { filename: "NotoSansLycian-Regular.ttf", reference_path: "assets/NotoSansLycian-Regular.ttf", kind: "font", size: 4556, url: fontUrl },
          { filename: "logo.png", reference_path: "assets/logo.png", kind: "image", size: 128 }
        ]
      },
      content
    )

    expect(result.error).toBeNull()
    expect(result.render).toBe(true)
    expect(result.fonts).toEqual([
      { reference_path: "assets/NotoSansLycian-Regular.ttf", families: ["Noto Sans Lycian"], error: null }
    ])

    // The glyphs only exist in the uploaded font: without it the compiler
    // has nothing to draw for the Lycian letters, so the rendered output
    // differs and the with-font SVG carries the extra glyph outlines.
    const bare = await compileWithFonts(page, { mainPath: "main.typ", sources: [], assets: [] }, content)
    expect(bare.render).toBe(true)
    expect(result.svg).not.toEqual(bare.svg)
    expect(result.svg.length).toBeGreaterThan(bare.svg.length)
  })

  test("a font that cannot be fetched is reported without failing the compile", async ({ page }) => {
    test.setTimeout(90_000)
    const result = await compileWithFonts(
      page,
      {
        mainPath: "main.typ",
        sources: [],
        assets: [{ filename: "Missing.ttf", reference_path: "assets/Missing.ttf", kind: "font", size: 10, url: "/assets/no-such-font.ttf" }]
      },
      "= Still renders"
    )

    expect(result.render).toBe(true)
    expect(result.fonts).toHaveLength(1)
    expect(result.fonts[0].reference_path).toBe("assets/Missing.ttf")
    expect(result.fonts[0].families).toEqual([])
    expect(result.fonts[0].error).toMatch(/404|Failed to fetch/)
  })

  test("a project without fonts keeps the default fonts and reports nothing", async ({ page }) => {
    test.setTimeout(60_000)
    const result = await compileWithFonts(page, { mainPath: "main.typ", sources: [], assets: [] }, "= Hi")
    expect(result.error).toBeNull()
    expect(result.render).toBe(true)
    expect(result.fonts).toBeNull()
  })
})
