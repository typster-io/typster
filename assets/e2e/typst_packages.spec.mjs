import { test, expect } from "@playwright/test"

// Coverage for #148: `#import "@preview/<pkg>:<ver>"` must resolve in the preview
// worker. The worker sets no registry itself; typst.ts' `$typst` snippet falls
// back to its fetch registry (packages.typst.org), so this guards that default.
//
// Same harness as typst_imports.spec.mjs: postMessage a compile job to the real
// worker and assert the rendered/errored outcome.
test.describe("Typst Universe package imports", () => {
  async function compile(page, content) {
    return page.evaluate(
      (content) =>
        new Promise((resolve) => {
          const worker = new Worker("/assets/js/typst_worker_impl.js", { type: "module" })
          let timer
          const done = (value) => {
            clearTimeout(timer)
            worker.terminate()
            resolve(value)
          }
          timer = setTimeout(() => done({ ok: false, message: "timeout" }), 40_000)
          worker.onmessage = (event) => {
            const { type, data } = event.data
            if (type === "render") done({ ok: true })
            else if (type === "error") done({ ok: false, message: (data && data.message) || "error" })
          }
          worker.onerror = (err) => done({ ok: false, message: String(err.message || err) })
          worker.postMessage({ type: "compile", content, project: {} })
        }),
      content
    )
  }

  test.beforeEach(async ({ page }) => {
    await page.goto("/")
  })

  test("a @preview package import compiles", async ({ page }) => {
    test.setTimeout(60_000)
    const result = await compile(page, '#import "@preview/oxifmt:0.2.1": strfmt\n#strfmt("{} + {}", 1, 2)')
    expect(result).toEqual({ ok: true })
  })

  test("an unknown package version yields a readable error, not a hang", async ({ page }) => {
    test.setTimeout(60_000)
    const result = await compile(page, '#import "@preview/oxifmt:99.0.0": strfmt')
    expect(result.ok).toBe(false)
    expect(result.message).not.toBe("timeout")
    expect(result.message).toContain("oxifmt")
  })
})
