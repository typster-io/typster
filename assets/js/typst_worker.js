import { previewRendered } from "./preview_sync"

let worker = null
let previewContainer = null
let pushEvent = null
let compileStartedAt = null
let pdfRequestSeq = 0
const pendingPdfRequests = new Map()
// Sources of each in-flight compile, keyed by its id: the worker echoes the id
// with the SVG, so the preview sync aligns against exactly what was compiled.
let compileRequestSeq = 0
const pendingCompiles = new Map()

// Typst diagnostics arrive as one multi-line string (the same text the CLI
// prints). Parse it into structured items so the preview can show a readable
// list (severity, file:line:col, message, hint) instead of a raw dump.
const DIAG_LOC = /([\w./-]+\.(?:typ|bib|md|tex|latex|sty|cls|csv|tsv|ya?ml)):(\d+):(\d+)/i

export function parseTypstDiagnostics(message) {
  const text = String(message || "").trim()
  if (!text) return [{ severity: "error", message: "Typst preview failed", location: null }]

  const diags = []
  let current = null

  for (const line of text.split("\n")) {
    const head = line.match(/^\s*(error|warning):\s*(.*)$/i)
    if (head) {
      if (current) diags.push(current)
      current = { severity: head[1].toLowerCase(), message: head[2].trim(), location: null, hint: null }
      continue
    }
    if (!current) continue
    const loc = line.match(DIAG_LOC)
    if (loc && !current.location) {
      current.location = { file: loc[1], line: Number(loc[2]), col: Number(loc[3]) }
    }
    const hint = line.match(/^\s*hint:\s*(.*)$/i)
    if (hint && !current.hint) current.hint = hint[1].trim()
  }
  if (current) diags.push(current)

  if (diags.length === 0) {
    const loc = text.match(DIAG_LOC)
    diags.push({
      severity: "error",
      message: text.split("\n")[0],
      location: loc && { file: loc[1], line: Number(loc[2]), col: Number(loc[3]) },
      hint: null
    })
  }

  return diags
}

// Let the editor highlight (or clear) the error locations in the gutter/text.
function dispatchEditorDiagnostics(diags) {
  window.dispatchEvent(new CustomEvent("typst:diagnostics", { detail: { diagnostics: diags } }))
}

function diagnosticSummary(diags) {
  const errors = diags.filter((d) => d.severity === "error").length
  const warnings = diags.filter((d) => d.severity === "warning").length
  const parts = []
  if (errors) parts.push(`${errors} error${errors === 1 ? "" : "s"}`)
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`)
  return { errors, warnings, label: parts.join(" · ") || "Compile failed" }
}

// Build the diagnostics panel with the DOM API (textContent everywhere, so
// compiler output can never inject markup).
function renderDiagnostics(errEl, diags) {
  errEl.textContent = ""
  const { label } = diagnosticSummary(diags)

  const head = document.createElement("div")
  head.className = "ts-diag__head"
  head.textContent = label
  errEl.appendChild(head)

  const list = document.createElement("div")
  list.className = "ts-diag__list"

  for (const d of diags) {
    const item = document.createElement("div")
    item.className = "ts-diag__item"

    const dot = document.createElement("span")
    dot.className = `ts-diag__dot ts-diag__dot--${d.severity === "warning" ? "warn" : "error"}`
    item.appendChild(dot)

    const body = document.createElement("div")
    body.className = "ts-diag__body"

    if (d.location && d.location.file) {
      const file = String(d.location.file).replace(/^\/+/, "")
      const loc = document.createElement("div")
      loc.className = "ts-diag__loc"
      loc.textContent =
        d.location.line != null
          ? `${file} : ${d.location.line} : ${d.location.col}`
          : file
      body.appendChild(loc)
    }

    const msg = document.createElement("div")
    msg.className = "ts-diag__msg"
    msg.textContent = d.message
    body.appendChild(msg)

    if (d.hint) {
      const hint = document.createElement("div")
      hint.className = "ts-diag__hint"
      hint.textContent = `hint: ${d.hint}`
      body.appendChild(hint)
    }

    item.appendChild(body)
    list.appendChild(item)
  }

  errEl.appendChild(list)
}

function triggerBrowserDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoke on the next tick so the click-initiated navigation has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function pdfFilename(rawName) {
  const base = (rawName || "").split("/").pop() || "document"
  const stem = base.replace(/\.typ$/i, "") || "document"
  return `${stem}.pdf`
}

function countPages(svg) {
  const matches = svg.match(/class="typst-page"/g)
  return matches ? matches.length : 1
}

// Word and character counts of the *compiled* document. typst.ts renders a
// hidden text-selection layer (`.tsel` nodes inside each page's
// foreignObject) that carries the laid-out text as real characters, so the
// numbers reflect what the reader sees — code, comments and markup are
// already gone. Only top-level `.tsel` nodes are read, so nested spans are
// not counted twice. Words are runs of letters/digits, with inner
// apostrophes and hyphens kept ("don't", "state-of-the-art" are one word).
const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu

function countText(container) {
  const lines = []
  for (const node of container.querySelectorAll(".tsel")) {
    if (node.parentElement && node.parentElement.closest(".tsel")) continue
    lines.push(node.textContent || "")
  }
  const text = lines.join("\n")
  const words = text.match(WORD_RE)
  return { words: words ? words.length : 0, chars: text.replace(/\s/g, "").length }
}

export function initTypstWorker(hook) {
  if (typeof Worker !== "undefined") {
    if (hook && typeof hook.pushEvent === "function") {
      pushEvent = hook.pushEvent.bind(hook)
    }

    previewContainer = hook ? hook.el : document.getElementById("preview-container")

    if (!worker) {
      worker = new Worker("/assets/js/typst_worker_impl.js", { type: "module" })

      worker.onmessage = (event) => {
        const { type, data } = event.data

        if (type === "render") {
          if (previewContainer && data.svg) {
            const errEl = previewContainer.querySelector("#preview-error")
            if (errEl) errEl.style.display = "none"

            let svgContainer = previewContainer.querySelector("#typst-svg-output")
            if (!svgContainer) {
              svgContainer = document.createElement("div")
              svgContainer.id = "typst-svg-output"
              // No own overflow: the page stack must scroll in its parent
              // (`.ts-preview__scroll`), which owns the padding + centering.
              // A second scroll container here put the scrollbar inside the
              // padding and split it from the pane edge.
              svgContainer.style.cssText = "width:100%;"
              previewContainer.appendChild(svgContainer)
            }
            svgContainer.style.display = ""

            const placeholder = previewContainer.querySelector("#preview-placeholder")
            if (placeholder) placeholder.style.display = "none"

            svgContainer.innerHTML = data.svg

            // Pair the SVG with its sources; a newer compile may still be in
            // flight, so only older entries are dropped.
            const compiled = pendingCompiles.get(data.requestId)
            for (const id of pendingCompiles.keys()) if (id <= data.requestId) pendingCompiles.delete(id)
            if (compiled) previewRendered(svgContainer, compiled.content, compiled.project)

            dispatchEditorDiagnostics([])

            if (pushEvent) {
              const ms = compileStartedAt ? Math.round(performance.now() - compileStartedAt) : null
              const { words, chars } = countText(svgContainer)
              pushEvent("update_preview", { ms, pages: countPages(data.svg), words, chars })
            }
          }
        } else if (type === "fonts") {
          // Family names the compiler read from the project's font files —
          // the Assets panel shows them next to each font.
          if (pushEvent) pushEvent("fonts_registered", { fonts: Array.isArray(data.fonts) ? data.fonts : [] })
        } else if (type === "error") {
          if (previewContainer) {
            let errEl = previewContainer.querySelector("#preview-error")
            if (!errEl) {
              errEl = document.createElement("div")
              errEl.id = "preview-error"
              errEl.className = "ts-diag"
              previewContainer.appendChild(errEl)
            }
            const diags =
              Array.isArray(data.diagnostics) && data.diagnostics.length
                ? data.diagnostics
                : parseTypstDiagnostics(data.message)
            renderDiagnostics(errEl, diags)
            dispatchEditorDiagnostics(diags)
            errEl.style.display = ""

            const svgContainer = previewContainer.querySelector("#typst-svg-output")
            if (svgContainer) svgContainer.style.display = "none"

            const placeholder = previewContainer.querySelector("#preview-placeholder")
            if (placeholder) placeholder.style.display = "none"

            if (pushEvent) {
              const { errors, warnings } = diagnosticSummary(diags)
              pushEvent("preview_error", {
                message: data.message || "Typst preview failed",
                errors: errors,
                warnings: warnings,
                diagnostics: diags
              })
            }
          } else if (pushEvent) {
            pushEvent("preview_error", { message: data.message || "Typst preview failed" })
          }
          console.error("Typst compilation error:", data)
        } else if (type === "pdf") {
          const pending = pendingPdfRequests.get(data.requestId)
          pendingPdfRequests.delete(data.requestId)
          triggerBrowserDownload(data.pdf, (pending && pending.filename) || "document.pdf")
        } else if (type === "pdf-error") {
          pendingPdfRequests.delete(data.requestId)
          if (pushEvent) pushEvent("preview_error", { message: data.message || "PDF export failed" })
          console.error("Typst PDF export error:", data)
        }
      }

      worker.onerror = (error) => {
        console.error("Typst worker error:", error)
      }

      window.typstWorker = worker
    }

    return worker
  } else {
    console.warn("Web Workers are not supported in this browser")
    return null
  }
}

export function compileTypst(content, project = {}) {
  if (!worker) {
    const container = document.getElementById("preview-container")
    if (container) {
      const hook = container.__liveSocketHook || null
      if (hook && typeof hook.pushEvent === "function") {
        initTypstWorker(hook)
      } else {
        initTypstWorker(null)
      }
    } else {
      initTypstWorker(null)
    }
  }

  if (!pushEvent && previewContainer) {
    const hook = previewContainer.__liveSocketHook || null
    if (hook && typeof hook.pushEvent === "function") {
      pushEvent = hook.pushEvent.bind(hook)
    }
  }

  if (worker) {
    compileStartedAt = performance.now()
    const requestId = ++compileRequestSeq
    pendingCompiles.set(requestId, { content, project })
    worker.postMessage({
      type: "compile",
      content: content,
      project: project,
      requestId
    })
  }
}

export function downloadTypstPdf(content, project = {}, fileName = null) {
  if (!worker) initTypstWorker(null)
  if (!worker) return

  const requestId = ++pdfRequestSeq
  pendingPdfRequests.set(requestId, { filename: pdfFilename(fileName) })
  worker.postMessage({ type: "pdf", content, project, requestId })
}

export function destroyTypstWorker() {
  if (worker) {
    worker.terminate()
    worker = null
    previewContainer = null
    pushEvent = null
    pendingCompiles.clear()
    window.typstWorker = null
  }
}
