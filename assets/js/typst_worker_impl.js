import { setImportWasmModule as setCompilerWasmModule } from "@myriaddreamin/typst-ts-web-compiler"
import { setImportWasmModule as setRendererWasmModule } from "@myriaddreamin/typst-ts-renderer"
import { $typst } from "@myriaddreamin/typst.ts/contrib/snippet"
import { createTypstFontBuilder } from "@myriaddreamin/typst.ts/compiler"
import { loadFonts } from "@myriaddreamin/typst.ts/options.init"

// Both the compiler and renderer have independent WASM loaders that throw by default.
// Override both to fetch from the known static path instead of relying on import.meta.url,
// which breaks in bundled worker contexts (Chrome: "Cannot import wasm module without importer").
const wasmLoader = async (wasmName) => {
  const response = await fetch(`/assets/js/${wasmName}`)
  if (!response.ok) throw new Error(`Failed to fetch ${wasmName}: ${response.status}`)
  return response.arrayBuffer()
}
setCompilerWasmModule(wasmLoader)
setRendererWasmModule(wasmLoader)

let initialized = false
let latestCompileId = 0

// typst.ts doesn't always throw a standard Error — a compile failure may surface
// as a plain string (the formatted diagnostic), an array of diagnostics, or an
// object. Coerce any of these into readable text so the message is never lost.
function formatError(error) {
  if (error == null) return "Typst preview failed"
  if (typeof error === "string") return error

  if (Array.isArray(error)) {
    const parts = error.map(formatError).filter(Boolean)
    if (parts.length) return parts.join("\n")
  }

  if (typeof error.message === "string" && error.message) return error.message

  if (typeof error.toString === "function") {
    const str = error.toString()
    if (str && str !== "[object Object]") return str
  }

  try {
    const json = JSON.stringify(error)
    if (json && json !== "{}") return json
  } catch (_ignored) {
    // fall through
  }

  return "Typst preview failed"
}

// `diagnostics: 'full'` returns DiagnosticMessage objects:
//   { package, path: "/main.typ", severity, range: "2:9-3:15", message }
// Turn them into structured items the preview can render directly (clean path,
// numeric line/col), rather than re-parsing formatted text.
function structureDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return null

  return diagnostics.map((d) => {
    const file = String((d && d.path) || "").replace(/^\/+/, "") || null
    const severity = String((d && d.severity) || "error").toLowerCase().includes("warn")
      ? "warning"
      : "error"
    // range is "line:col" or "line:col-endline:endcol", 0-based - shift to
    // the 1-based line/col humans and the editor goto expect.
    const m = String((d && d.range) || "").match(/(\d+):(\d+)(?:-(\d+):(\d+))?/)
    const location = file
      ? {
          file,
          line: m ? Number(m[1]) + 1 : null,
          col: m ? Number(m[2]) + 1 : null,
          endLine: m && m[3] ? Number(m[3]) + 1 : null,
          endCol: m && m[4] ? Number(m[4]) + 1 : null
        }
      : null

    return { severity, location, message: (d && d.message) || "Compilation error" }
  })
}

async function ensureInitialized() {
  if (initialized) return
  initialized = true
  await $typst.svg({ mainContent: "" }).catch(() => {})
}

// ── Project fonts ──────────────────────────────────────────────────────────
//
// Fonts uploaded as project assets arrive in `project.assets` with
// `kind: "font"` and a presigned `url`. The compiler's `set_fonts` replaces
// its font resolver wholesale, so each time the project's font set changes we
// build a fresh resolver holding Typst's default text fonts (re-added through
// the same `loadFonts` loader the compiler used at init; the browser caches
// those files) plus every project font, then swap it in. Font bytes are
// cached by reference path + size, so a re-signed URL never refetches.

const fontBytesCache = new Map()
let registeredFontSet = ""

function projectFonts(project) {
  const assets = Array.isArray(project && project.assets) ? project.assets : []
  return assets.filter(
    (a) => a && a.kind === "font" && typeof a.url === "string" && typeof a.reference_path === "string"
  )
}

function fontCacheKey(asset) {
  return `${asset.reference_path}|${asset.size || 0}`
}

async function fetchFontBytes(asset) {
  const key = fontCacheKey(asset)
  if (fontBytesCache.has(key)) return fontBytesCache.get(key)

  const response = await fetch(asset.url)
  if (!response.ok) throw new Error(`Failed to fetch font ${asset.reference_path}: ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  fontBytesCache.set(key, bytes)
  return bytes
}

// typst.ts returns the font's info cache; its exact shape has moved between
// versions, so collect every `family` string up to two levels deep rather
// than depending on one layout.
function familiesFromInfo(info) {
  const out = new Set()
  const visit = (value, depth) => {
    if (!value || depth > 2) return
    if (Array.isArray(value)) return value.forEach((v) => visit(v, depth + 1))
    if (typeof value !== "object") return
    if (typeof value.family === "string" && value.family) out.add(value.family)
    for (const k of Object.keys(value)) if (k !== "family") visit(value[k], depth + 1)
  }
  visit(info, 0)
  return [...out]
}

// Returns a per-font report when the resolver was rebuilt, or null when the
// project's font set is unchanged since the last registration. Jobs run one
// at a time (see the queue in onmessage), so there is never a second sync in
// flight: the wasm compiler must not be touched from two interleaved tasks.
async function syncProjectFonts(project) {
  const fonts = projectFonts(project)
  const fontSet = fonts.map(fontCacheKey).sort().join("\n")
  if (fontSet === registeredFontSet) return null

  const loaded = []
  for (const asset of fonts) {
    try {
      loaded.push({ asset, bytes: await fetchFontBytes(asset), error: null })
    } catch (error) {
      console.error("typst font fetch failed:", error)
      loaded.push({ asset, bytes: null, error: formatError(error) })
    }
  }

  const fontBuilder = createTypstFontBuilder()
  await fontBuilder.init()

  // The loader hands `fonts` (our buffers first, then the default assets'
  // URLs) to `ref.loadFonts(builder, fonts)`; feed them all into the builder.
  const ref = {
    setFetcher() {},
    async loadFonts(builder, entries) {
      for (const entry of entries) {
        if (entry instanceof Uint8Array) {
          await builder.addFontData(entry)
        } else if (typeof entry === "string") {
          const response = await fetch(entry)
          if (!response.ok) throw new Error(`Failed to fetch default font ${entry}: ${response.status}`)
          await builder.addFontData(new Uint8Array(await response.arrayBuffer()))
        }
      }
    }
  }
  const userBytes = loaded.filter((l) => l.bytes).map((l) => l.bytes)
  await loadFonts(userBytes, { assets: ["text"] })(undefined, { ref, builder: fontBuilder })

  // Read family names before build(): the wasm builder is spent afterwards.
  const report = []
  for (const { asset, bytes, error } of loaded) {
    let families = []
    if (bytes) {
      try {
        families = familiesFromInfo(await fontBuilder.getFontInfo(bytes))
      } catch (infoError) {
        console.error("typst font info failed:", infoError)
      }
    }
    report.push({ reference_path: asset.reference_path, families, error })
  }

  const compiler = await $typst.getCompiler()
  await fontBuilder.build(async (resolver) => compiler.setFonts(resolver))
  registeredFontSet = fontSet
  return report
}

// Register fonts without ever failing the compile: a broken font file or an
// unreachable URL is reported, and the document still renders with the
// fonts the compiler already has.
async function registerFonts(project) {
  try {
    const report = await syncProjectFonts(project)
    if (report) self.postMessage({ type: "fonts", data: { fonts: report } })
  } catch (error) {
    console.error("typst font registration failed:", error)
    self.postMessage({
      type: "fonts",
      data: { fonts: projectFonts(project).map((a) => ({ reference_path: a.reference_path, families: [], error: formatError(error) })) }
    })
  }
}

// Map a project-relative path ("chapters/ch1.typ") to the compiler's rooted VFS
// path. Collapsing leading slashes keeps "/x.typ" and "x.typ" in agreement, and
// the fallback is the conventional entrypoint when no path is supplied.
function vfsPath(path) {
  const clean = String(path || "").replace(/^\/+/, "").trim()
  return `/${clean || "main.typ"}`
}

// Mirror the project into the compiler's virtual filesystem and return the VFS
// path of the entrypoint. The active buffer is mapped at its *real* path rather
// than a flattened "/main.typ", so files in subdirectories keep their directory
// and relative `#import`s resolve. The buffer's twin in `sources` (the persisted
// copy) is skipped so the live, possibly-unsaved buffer wins.
//
// `project.entryPath` names the file to compile when it is not the buffer: a
// jump from the preview into an `#include`d chapter keeps rendering the
// document that chapter belongs to (#149). It is only honoured when that file
// is among the sources; otherwise the buffer is the entrypoint as before.
async function loadSources(content, project) {
  const buffer = vfsPath(project?.mainPath)
  const sources = Array.isArray(project?.sources) ? project.sources : []
  const entry = project?.entryPath ? vfsPath(project.entryPath) : buffer
  const main = entry !== buffer && sources.some((s) => vfsPath(s.path) === entry) ? entry : buffer
  $typst.setMainFilePath(main)
  await $typst.addSource(buffer, content || "")

  for (const source of sources) {
    const path = vfsPath(source.path)
    if (path !== buffer) {
      await $typst.addSource(path, source.content || "")
    }
  }

  return main
}

// Jobs run strictly one after another. typst.ts wraps a single wasm compiler
// and wasm-bindgen refuses re-entrant access ("recursive use of an object
// detected which would lead to unsafe aliasing"): a compile that is still
// awaiting a font fetch or `setFonts` must not be interleaved with the next
// keystroke's compile. Stale compiles still bail out early via latestCompileId.
let jobQueue = Promise.resolve()

self.onmessage = function (event) {
  if (event.data && event.data.type === "compile") latestCompileId++
  const myId = latestCompileId
  jobQueue = jobQueue.then(() => handleMessage(event, myId)).catch((error) => {
    console.error("typst worker job failed:", error)
  })
}

async function handleMessage(event, myId) {
  const { type, content, project, requestId } = event.data

  if (type === "compile") {
    // Superseded while queued: a newer keystroke is already waiting.
    if (myId !== latestCompileId) return
    try {
      await ensureInitialized()
      if (myId !== latestCompileId) return

      await registerFonts(project)
      if (myId !== latestCompileId) return

      const main = await loadSources(content, project)
      if (myId !== latestCompileId) return

      const svg = await $typst.svg({ mainFilePath: main })
      if (myId !== latestCompileId) return

      // Echo the compile's id so the client can pair the SVG with the exact
      // sources it was built from (preview-to-source sync, #149).
      self.postMessage({ type: "render", data: { svg, requestId } })
    } catch (error) {
      if (myId !== latestCompileId) return
      console.error("typst compile failed (raw):", error)

      // The high-level svg() suppresses diagnostics, so the caught error is
      // opaque. Recompile once with full diagnostics to recover the real
      // error text (sources are re-mapped first in case state was reset).
      let structured = null
      try {
        const main = await loadSources(content, project)
        const compiler = await $typst.getCompiler()
        const { diagnostics } = await compiler.compile({
          mainFilePath: main,
          diagnostics: "full"
        })
        structured = structureDiagnostics(diagnostics)
      } catch (diagError) {
        console.error("typst diagnostics recompile failed:", diagError)
      }

      const message = (structured && structured[0] && structured[0].message) || formatError(error)
      self.postMessage({ type: "error", data: { message, diagnostics: structured, requestId } })
    }
  } else if (type === "pdf") {
    // Export bypasses latestCompileId: a download is an explicit one-off and must
    // not be cancelled by a concurrent live-preview compile.
    try {
      await ensureInitialized()
      await registerFonts(project)
      const main = await loadSources(content, project)

      const pdf = await $typst.pdf({ mainFilePath: main })
      self.postMessage({ type: "pdf", data: { pdf, requestId } }, [pdf.buffer])
    } catch (error) {
      self.postMessage({ type: "pdf-error", data: { message: formatError(error), requestId } })
    }
  }
}
