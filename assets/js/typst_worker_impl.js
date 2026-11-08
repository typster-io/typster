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

// ── Project files ──────────────────────────────────────────────────────────
//
// Every asset that is not a registrable font arrives with a `url` served by
// the app and is mapped as a shadow file at its reference path, so
// `#image("assets/logo.png")`, an image of a PDF page or `#csv("assets/t.csv")`
// resolves. No extension list decides what is readable: Typst does, and a file
// it cannot use is reported by the compiler like any other bad input.
//
// Bytes are cached by URL. The URL names the asset row, and every upload is a
// new row, so a replaced file with the same name and size is fetched afresh. A
// URL that failed is not retried until the asset list changes, so a broken
// file costs one request per manifest rather than one per keystroke. A file is
// fetched eagerly once its name occurs in some source text, so a large upload
// that nothing references is not downloaded while the document compiles
// without it. A path built at runtime from pieces (`"img/" + name + ".png"`)
// names no file in the text: when a compile fails to load a file, every file
// not tried yet is fetched and the compile runs once more.

const fileBytesCache = new Map()
const failedFileUrls = new Set()
let fileManifest = ""

function projectFiles(project) {
  const assets = Array.isArray(project && project.assets) ? project.assets : []
  return assets.filter(
    (a) => a && a.kind !== "font" && typeof a.url === "string" && typeof a.reference_path === "string"
  )
}

// A new asset list forgives earlier failures (the file may have been
// re-uploaded or storage recovered) and drops the bytes of files that left it.
function syncFileManifest(files) {
  const manifest = files.map((a) => `${a.reference_path}|${a.url}`).sort().join("\n")
  if (manifest === fileManifest) return
  fileManifest = manifest
  failedFileUrls.clear()
  const urls = new Set(files.map((a) => a.url))
  for (const url of fileBytesCache.keys()) if (!urls.has(url)) fileBytesCache.delete(url)
}

async function fetchFileBytes(asset) {
  const response = await fetch(asset.url)
  if (!response.ok) throw new Error(`Failed to fetch ${asset.reference_path}: ${response.status}`)
  fileBytesCache.set(asset.url, new Uint8Array(await response.arrayBuffer()))
}

// Fetch, in parallel, the files some text names (every file when `texts` is
// null) and that are neither cached nor known to fail, then return the files
// whose bytes are available.
async function loadFiles(project, texts) {
  const files = projectFiles(project)
  syncFileManifest(files)

  const wanted = files.filter((asset) => {
    if (fileBytesCache.has(asset.url) || failedFileUrls.has(asset.url)) return false
    const name = asset.reference_path.split("/").pop()
    return !texts || texts.some((text) => text.includes(name))
  })
  await Promise.all(
    wanted.map((asset) =>
      fetchFileBytes(asset).catch((error) => {
        failedFileUrls.add(asset.url)
        console.error("typst file fetch failed:", error)
      })
    )
  )

  return files.filter((asset) => fileBytesCache.has(asset.url))
}

// Whether fetching the files not tried yet, named in no source, made any of
// them available.
async function loadUnnamedFiles(project) {
  const before = fileBytesCache.size
  await loadFiles(project, null)
  return fileBytesCache.size > before
}

const FILE_LOAD_ERROR = /failed to load file|file not found/i

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
  const mapped = new Set([buffer])

  for (const source of sources) {
    const path = vfsPath(source.path)
    if (path !== buffer) {
      await $typst.addSource(path, source.content || "")
      mapped.add(path)
    }
  }

  const texts = [content || "", ...sources.map((s) => s.content || "")]
  for (const asset of await loadFiles(project, texts)) {
    const path = vfsPath(asset.reference_path)
    await $typst.mapShadow(path, fileBytesCache.get(asset.url))
    mapped.add(path)
  }

  await unmapStale(mapped)
  return main
}

// The compiler's file system outlives a compile, so a source or file that left
// the project would keep resolving until a reload. Unmap every path the
// previous load mapped and this one did not, so the compiler reports it
// missing just as it would on a fresh page.
let mappedPaths = new Set()

async function unmapStale(mapped) {
  for (const path of mappedPaths) {
    if (mapped.has(path)) continue
    try {
      await $typst.unmapShadow(path)
    } catch (error) {
      console.error("typst unmap failed:", error)
    }
  }
  mappedPaths = mapped
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

// `retry` allows one more compile after a failed file load fetched files no
// source names, so a document never compiles more than twice per request.
async function compile(content, project, requestId, myId, retry) {
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

    // A file the compile could not load may be one whose path the document
    // builds at runtime: compile again once the files no source names are in.
    // The failure is logged only when no retry follows (the retry logs its
    // own), so a document that loads on the second try logs nothing.
    if (retry && structured && structured.some((d) => FILE_LOAD_ERROR.test(d.message)) && (await loadUnnamedFiles(project))) {
      if (myId !== latestCompileId) return
      return compile(content, project, requestId, myId, false)
    }
    console.error("typst compile failed (raw):", error)

    const message = (structured && structured[0] && structured[0].message) || formatError(error)
    self.postMessage({ type: "error", data: { message, diagnostics: structured, requestId } })
  }
}

async function handleMessage(event, myId) {
  const { type, content, project, requestId } = event.data

  if (type === "compile") {
    // Superseded while queued: a newer keystroke is already waiting.
    if (myId !== latestCompileId) return
    await compile(content, project, requestId, myId, true)
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
