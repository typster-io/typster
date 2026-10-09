import { initEditor, updateEditorContent, destroyEditor } from "./editor"
import { initTypstWorker, destroyTypstWorker, compileTypst } from "./typst_worker"
import { installPreviewSync, syncPreviewToCursor } from "./preview_sync"

// How long the caret must rest before the preview follows it (#149).
const PREVIEW_SYNC_DELAY = 250

function parseContent(content) {
  return content || ""
}

function parseJsonDataset(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch (_error) {
    return fallback
  }
}

function editorOptions(element) {
  return {
    language: element.dataset.language || "typst",
    readonly: element.dataset.readonly === "true",
    collab: element.dataset.collab === "true",
    user: {
      name: element.dataset.userName || "Anonymous",
      color: element.dataset.userColor || ""
    },
    project: {
      // The active file's real project path — the compiler maps the buffer here
      // so files in subdirectories keep their directory and relative imports resolve.
      mainPath: element.dataset.fileName || "",
      sources: parseJsonDataset(element.dataset.projectSources, []),
      assets: parseJsonDataset(element.dataset.projectAssets, [])
    }
  }
}

// Breadcrumb symbol segment: show the nearest heading above the cursor as the
// final crumb (`folder / file.typ › Heading`), and light the same heading in
// the sidebar outline. Pure DOM — tracks every cursor move without a server
// round-trip.
const headingState = { outline: [], line: 1 }

function updateCrumbSymbol(outline, line) {
  headingState.outline = outline || []
  headingState.line = line
  let current = null
  for (const item of outline || []) {
    if (item.line <= line) current = item
    else break
  }

  const sym = document.getElementById("topbar-symbol")
  const sep = document.getElementById("topbar-symbol-sep")
  if (sym && sep) {
    sym.hidden = sep.hidden = !current
    if (current) sym.textContent = current.text
  }

  for (const li of document.querySelectorAll("#outline [data-line]")) {
    li.classList.toggle("is-active", !!current && Number(li.dataset.line) === current.line)
  }
}

// The outline list re-renders after the server streams parsed headings, which
// lands after the cursor callback ran: re-light the current heading whenever
// the list's rows change (a stream patch does not call the hook's `updated`).
export const OutlineList = {
  mounted() {
    const relight = () => updateCrumbSymbol(headingState.outline, headingState.line)
    this.observer = new MutationObserver(relight)
    this.observer.observe(this.el, { childList: true })
    relight()
  },
  destroyed() {
    if (this.observer) this.observer.disconnect()
  }
}

export const CodeMirror = {
  editorCallbacks() {
    return {
      onCursor: (line, col, viaEdit) => {
        const el = document.getElementById("status-cursor")
        if (el) el.textContent = `Ln ${line}, Col ${col}`
        this.lastCursorLine = line
        updateCrumbSymbol(this.lastOutline, line)
        // Follow a resting caret in the preview. Edits and the caret move a
        // preview click just caused are skipped: the first would drag the
        // preview while typing, the second would answer a click with a scroll.
        clearTimeout(this.previewSyncTimer)
        if (viaEdit) return
        if (this.suppressPreviewSync) {
          this.suppressPreviewSync = false
          return
        }
        this.previewSyncTimer = setTimeout(() => {
          syncPreviewToCursor({ file: this.mainPath, line, col })
        }, PREVIEW_SYNC_DELAY)
      },
      onOutline: (items) => {
        this.lastOutline = items
        this.pushEvent("outline_parsed", { items })
        updateCrumbSymbol(items, this.lastCursorLine || 1)
      }
    }
  },

  setupCommandHandler() {
    this.commandHandler = (event) => {
      if (!this.editorInstance) return
      const { cmd, line, col, file, source } = event.detail || {}
      if (cmd === "compile") {
        this.editorInstance.compile()
      } else if (cmd === "download") {
        this.editorInstance.download()
      } else if (cmd === "search") {
        this.editorInstance.openSearch()
      } else if (cmd === "goto") {
        this.gotoLocation({ file, line, col, source })
      } else if (cmd) {
        this.editorInstance.runCommand(cmd, { line })
      }
    }
    window.addEventListener("phx:editor-command", this.commandHandler)

    // The Typst worker emits diagnostics for the compiled buffer (reported as
    // "main.typ"); highlight those in the active editor and clear on success.
    this.diagnosticsHandler = (event) => {
      if (!this.editorInstance) return
      const all = (event.detail && event.detail.diagnostics) || []
      // Only surface diagnostics for the file open in *this* editor. The worker
      // labels them by real path now, so match the active path (falling back to
      // the historical "main.typ" sentinel).
      const active = (this.mainPath || "main.typ").replace(/^\/+/, "")
      const own = all.filter((d) => {
        const file = d.location && d.location.file
        return !file || file.replace(/^\/+/, "") === active
      })
      this.editorInstance.setDiagnostics(own)
    }
    window.addEventListener("typst:diagnostics", this.diagnosticsHandler)
  },

  // Move the caret to `line`/`col`, in another project file when `file` names
  // one: the server is asked to open it and the move completes once its
  // buffer has mounted (the preview click path, #149).
  gotoLocation({ file, line, col, source }) {
    // The caret move this goto causes must not scroll the preview back to
    // where the click came from: skip exactly that one cursor callback.
    if (source === "preview") {
      this.suppressPreviewSync = true
      clearTimeout(this.suppressTimer)
      this.suppressTimer = setTimeout(() => {
        this.suppressPreviewSync = false
      }, 1000)
    }
    const target = file ? file.replace(/^\/+/, "") : null
    const active = this.mainPath.replace(/^\/+/, "")
    if (!target || target === active) {
      this.editorInstance.runCommand("goto", { line, col })
      return
    }
    // A read-only view (a shared project) has no file switching to offer.
    if (this.readonly) return
    // Switching buffers destroys this editor; a save still waiting on its
    // debounce would be lost, so push it ahead of the switch.
    this.editorInstance.flushAutosave()
    this.pendingGoto = { path: target, line, col }
    this.pushEvent("open_path", { path: target })
  },

  // The file the preview compiles: a deliberate selection (tree, tab, a new
  // file) of a Typst file makes it the document; a jump from the preview, a
  // closed tab, a deleted file, or opening a data file (CSV, BibTeX, a note)
  // keep the current one as long as it is a Typst file that still exists.
  chooseEntry(reason) {
    const sources = (this.currentOptions && this.currentOptions.project.sources) || []
    const clean = (p) => String(p || "").replace(/^\/+/, "")
    const current = clean(this.entryPath)
    const keepable =
      current &&
      /\.typ$/i.test(current) &&
      (current === clean(this.mainPath) || sources.some((src) => clean(src.path) === current))
    const chosen = reason === "select" || reason === "create"
    if (!keepable || (chosen && /\.typ$/i.test(clean(this.mainPath)))) return this.mainPath
    return this.entryPath
  },

  mounted() {
    const container = this.el
    const rawContent = this.el.dataset.content || ""
    const content = parseContent(rawContent)
    const fileId = this.el.dataset.fileId || null
    const options = { ...editorOptions(this.el), ...this.editorCallbacks() }
    // Track the open file's path so worker diagnostics (now labelled by real
    // path) can be matched back to this editor.
    this.mainPath = options.project.mainPath || "main.typ"
    // The file the preview compiles. It follows the file the user opens, but
    // a jump from the preview into an `#include`d file leaves it alone, so the
    // preview keeps showing the document rather than the chapter on its own.
    this.entryPath = this.mainPath
    this.readonly = options.readonly
    this.collab = options.collab
    // The element is `phx-update="ignore"`, so `data-project-assets` is frozen
    // at mount. The server pushes `assets_updated` on every upload/delete;
    // keep the latest list here and apply it whenever options are rebuilt.
    this.projectAssets = null
    this.currentOptions = options

    if (!container) return

    this.previousFileId = fileId
    this.setupCommandHandler()

    if (fileId) {
      this.editorInstance = initEditor(
        container,
        content,
        this,
        fileId,
        options
      )
    }

    this.handleEvent("content_updated", ({ content }) => {
      // When collab is on, the Yjs doc owns the buffer; writing here too
      // double-inserts (and compounds across reloads).
      if (this.editorInstance && !this.collab) {
        updateEditorContent(this.editorInstance, content)
      }
    })

    this.handleEvent("assets_updated", ({ assets }) => {
      this.projectAssets = Array.isArray(assets) ? assets : []
      // The editor closes over this very object, so mutate it in place and
      // recompile: a new font registers, a deleted one drops out.
      if (this.currentOptions && this.currentOptions.project) {
        this.currentOptions.project.assets = this.projectAssets
      }
      if (this.editorInstance && typeof this.editorInstance.compile === "function") {
        this.editorInstance.compile()
      }
    })

    this.handleEvent("file_changed", ({ file_id, content, language, path, reason }) => {
      const newFileId = file_id || null
      const newContent = parseContent(content || "")
      const options = { ...editorOptions(this.el), ...this.editorCallbacks() }
      options.language = language || options.language
      // The editor element is `phx-update="ignore"`, so its `data-file-name` is
      // frozen at mount — take the switched-to file's path from the event instead.
      options.project.mainPath = path || options.project.mainPath
      if (this.projectAssets) options.project.assets = this.projectAssets
      this.mainPath = options.project.mainPath || "main.typ"
      const pending = this.pendingGoto
      const viaPreview = !!pending && pending.path === this.mainPath.replace(/^\/+/, "")
      if (!viaPreview) this.pendingGoto = null
      const entryBefore = this.entryPath
      this.entryPath = this.chooseEntry(reason || (viaPreview ? "jump" : "select"))
      options.project.entryPath = this.entryPath

      this.el.style.display = newFileId ? "" : "none"

      if (this.previousFileId !== newFileId) {
        this.currentOptions = options
        this.previousFileId = newFileId
        this.cleanupThemeHandlers()
        if (this.editorInstance) {
          // A save still waiting on its debounce belongs to the buffer being
          // torn down; the server stores it even though it is no longer
          // the current file.
          this.editorInstance.flushAutosave()
          destroyEditor(this.editorInstance)
          this.editorInstance = null
        }
        if (newFileId) {
          this.editorInstance = initEditor(
            container,
            newContent,
            this,
            newFileId,
            options
          )
          this.setupThemeHandlers()
        }
      } else if (this.editorInstance) {
        // Same buffer: the editor keeps its options object, so refresh it in
        // place. Re-opening the active file from the tree makes it the
        // previewed document again, which needs a compile.
        Object.assign(this.currentOptions.project, options.project)
        updateEditorContent(this.editorInstance, newContent)
        if (language && this.editorInstance.updateLanguage) {
          this.editorInstance.updateLanguage(language)
        }
        if (this.entryPath !== entryBefore) this.editorInstance.compile()
      }

      if (viaPreview && this.editorInstance) {
        this.pendingGoto = null
        // A collaborative buffer fills in asynchronously; wait for its text.
        const instance = this.editorInstance
        instance.ready.then(() => {
          if (this.editorInstance === instance) instance.runCommand("goto", { line: pending.line, col: pending.col })
        })
      }
    })

    // The server re-renders `data-project-sources` on every change to the
    // project's files (a save, a new, moved or deleted file), and LiveView
    // merges data attributes even on this ignored element. Keep the compile
    // options current, and if the previewed document vanished, or a sibling
    // the document reads changed, compile again.
    this.sourcesObserver = new MutationObserver(() => {
      if (!this.currentOptions || !this.editorInstance) return
      const sources = parseJsonDataset(this.el.dataset.projectSources, [])
      const active = this.mainPath.replace(/^\/+/, "")
      const others = (list) => JSON.stringify(list.filter((src) => String(src.path || "").replace(/^\/+/, "") !== active))
      const changed = others(sources) !== others(this.currentOptions.project.sources || [])
      this.currentOptions.project.sources = sources
      const entryBefore = this.entryPath
      this.entryPath = this.chooseEntry("refresh")
      this.currentOptions.project.entryPath = this.entryPath
      if (changed || this.entryPath !== entryBefore) this.editorInstance.compile()
    })
    this.sourcesObserver.observe(this.el, { attributes: true, attributeFilter: ["data-project-sources"] })

    this.themeChangeHandler = () => {
      if (this.editorInstance && this.editorInstance.updateTheme) {
        this.editorInstance.updateTheme()
      }
    }

    window.addEventListener("phx:set-theme", this.themeChangeHandler)

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes" && mutation.attributeName === "data-theme") {
          if (this.editorInstance && this.editorInstance.updateTheme) {
            this.editorInstance.updateTheme()
          }
        }
      })
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"]
    })

    this.themeObserver = observer
  },

  setupThemeHandlers() {
    this.themeChangeHandler = () => {
      if (this.editorInstance && this.editorInstance.updateTheme) {
        this.editorInstance.updateTheme()
      }
    }

    window.addEventListener("phx:set-theme", this.themeChangeHandler)

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes" && mutation.attributeName === "data-theme") {
          if (this.editorInstance && this.editorInstance.updateTheme) {
            this.editorInstance.updateTheme()
          }
        }
      })
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"]
    })

    this.themeObserver = observer
  },

  cleanupThemeHandlers() {
    if (this.themeChangeHandler) {
      window.removeEventListener("phx:set-theme", this.themeChangeHandler)
      this.themeChangeHandler = null
    }
    if (this.themeObserver) {
      this.themeObserver.disconnect()
      this.themeObserver = null
    }
  },

  updated() {},

  destroyed() {
    this.cleanupThemeHandlers()
    clearTimeout(this.previewSyncTimer)
    clearTimeout(this.suppressTimer)
    if (this.sourcesObserver) this.sourcesObserver.disconnect()
    if (this.commandHandler) {
      window.removeEventListener("phx:editor-command", this.commandHandler)
      this.commandHandler = null
    }
    if (this.diagnosticsHandler) {
      window.removeEventListener("typst:diagnostics", this.diagnosticsHandler)
      this.diagnosticsHandler = null
    }
    if (this.editorInstance) {
      destroyEditor(this.editorInstance)
      this.editorInstance = null
    }
  }
}

export const Preview = {
  mounted() {
    initTypstWorker(this)
    this.uninstallSync = installPreviewSync(this.el)

    const editorContainer = document.getElementById("editor-container")
    if (editorContainer) {
      const rawContent = editorContainer.dataset.content || ""
      const content = parseContent(rawContent)
      const language = editorContainer.dataset.language || "typst"
      const project = editorOptions(editorContainer).project
      if (content && language === "typst") {
        setTimeout(() => compileTypst(content, project), 100)
      }
    }
  },

  updated() {
    if (this.pushEvent) {
      initTypstWorker(this)
    }
  },

  destroyed() {
    if (this.uninstallSync) this.uninstallSync()
    destroyTypstWorker()
  }
}

export const SaveStatus = {
  updated() {}
}

// Editor shell: captures ⌘K / Ctrl+K (and ⌘P, the sidebar's "Find file" hint)
// to open the command palette, and
// re-initializes lucide icons after LiveView patches (the format toolbar and
// palette render <i data-lucide> nodes that need svg upgrading on each patch).
export const CommandPalette = {
  mounted() {
    if (window.mkIcons) window.mkIcons(this.el)

    this.keyHandler = (event) => {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && (key === "k" || key === "p")) {
        event.preventDefault()
        this.pushEvent("open_palette", {})
      }
    }
    window.addEventListener("keydown", this.keyHandler)

    // The shell is the file drop target, so LiveView lights it on dragenter
    // anywhere over the window. LiveView only clears it when a dragleave's
    // coordinates fall outside the shell, which a drag that exits the window
    // (or the browser chrome) does not guarantee: clear it ourselves when the
    // drag leaves the document, ends, drops, or simply stops moving.
    const clear = () => {
      clearTimeout(this.dragTimer)
      this.el.classList.remove("phx-drop-target-active")
    }
    this.dragHandlers = {
      dragover: () => {
        clearTimeout(this.dragTimer)
        this.dragTimer = setTimeout(clear, 1500)
      },
      dragleave: (event) => { if (event.relatedTarget === null) clear() },
      drop: clear,
      dragend: clear
    }
    for (const [type, handler] of Object.entries(this.dragHandlers)) {
      window.addEventListener(type, handler)
    }
  },

  updated() {
    if (window.mkIcons) window.mkIcons(this.el)
  },

  destroyed() {
    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler)
    clearTimeout(this.dragTimer)
    for (const [type, handler] of Object.entries(this.dragHandlers || {})) {
      window.removeEventListener(type, handler)
    }
  }
}

// Focus a search input when "/" is pressed outside of any text field.
export const SlashFocus = {
  mounted() {
    this.handler = (event) => {
      const tag = document.activeElement && document.activeElement.tagName
      if (event.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        event.preventDefault()
        this.el.focus()
      }
    }
    window.addEventListener("keydown", this.handler)
  },

  destroyed() {
    if (this.handler) window.removeEventListener("keydown", this.handler)
  }
}

// Focus an input and select its prefilled text once, when it mounts (the copy
// modal's "{Project} (copy)" name, so typing replaces it outright).
export const SelectOnMount = {
  mounted() {
    this.el.focus()
    this.el.select()
  }
}

// Command palette keyboard navigation. Mounted only while the palette is open;
// owns active-item highlighting and Enter-to-activate (clicks the focused row,
// triggering whatever phx-click / JS.dispatch it carries).
export const Palette = {
  items() {
    return Array.from(this.el.querySelectorAll(".ts-palette__item"))
  },

  setActive(idx) {
    const items = this.items()
    if (!items.length) return
    this.active = (idx + items.length) % items.length
    items.forEach((el, i) => el.classList.toggle("is-active", i === this.active))
    items[this.active].scrollIntoView({ block: "nearest" })
  },

  mounted() {
    if (window.mkIcons) window.mkIcons(this.el)
    this.active = 0
    this.setActive(0)

    const input = this.el.querySelector("#palette-input")
    if (input) input.focus()

    this.keyHandler = (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        this.setActive(this.active + 1)
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        this.setActive(this.active - 1)
      } else if (event.key === "Enter") {
        const items = this.items()
        if (items[this.active]) {
          event.preventDefault()
          items[this.active].click()
        }
      }
    }
    this.el.addEventListener("keydown", this.keyHandler)
  },

  updated() {
    if (window.mkIcons) window.mkIcons(this.el)
    this.setActive(this.active || 0)
  },

  destroyed() {
    if (this.keyHandler) this.el.removeEventListener("keydown", this.keyHandler)
  }
}

// Client-side zoom for the rendered Typst SVG. Owns its own DOM
// (phx-update="ignore") so LiveView patches to the preview bar don't reset it.
export const PreviewZoom = {
  mounted() {
    this.zoom = 100
    this.label = this.el.querySelector("#zoom-level")

    this.apply = () => {
      const svg = document.querySelector("#typst-svg-output")
      if (svg) {
        svg.style.transformOrigin = "top center"
        svg.style.transform = `scale(${this.zoom / 100})`
      }
      if (this.label) this.label.textContent = `${this.zoom}%`
    }

    this.clickHandler = (event) => {
      const button = event.target.closest("[data-zoom]")
      if (!button) return
      const dir = button.dataset.zoom
      if (dir === "in") this.zoom = Math.min(this.zoom + 10, 300)
      else if (dir === "out") this.zoom = Math.max(this.zoom - 10, 30)
      else this.zoom = 100
      this.apply()
    }

    this.el.addEventListener("click", this.clickHandler)
  },

  destroyed() {
    if (this.clickHandler) this.el.removeEventListener("click", this.clickHandler)
  }
}

// Re-render lucide `<i data-lucide>` icons inside a container that LiveView
// patches (the file tree and tab bar). The global mkIcons() only runs on full
// page loads, so without this, icons inside diffed regions would not paint.
export const LucideIcons = {
  mounted() { window.mkIcons?.(this.el) },
  updated() { window.mkIcons?.(this.el) }
}

// Copy `data-clipboard` to the clipboard on click; flashes `.copied` briefly.
export const Clipboard = {
  mounted() {
    this.handler = () => {
      const text = this.el.dataset.clipboard || ""
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
      this.el.classList.add("copied")
      setTimeout(() => this.el.classList.remove("copied"), 1200)
    }
    this.el.addEventListener("click", this.handler)
  },
  destroyed() {
    this.el.removeEventListener("click", this.handler)
  }
}

// Persist the auto-recompile debounce (read by editor.js' compileDelay()).
export const CompileDelay = {
  mounted() {
    const stored = localStorage.getItem("typster:compile_delay")
    if (stored !== null) this.el.value = stored
    this.el.addEventListener("change", () => {
      localStorage.setItem("typster:compile_delay", this.el.value)
    })
  }
}

// Drag image for a sidebar row: its file chip, its name and the snippet a drop
// inserts, instead of the browser's faint snapshot of the whole row. Mounted
// inside .ts-app so it takes the user's accent; the browser snapshots it
// synchronously, so it is removed on the next tick.
function setRowDragImage(e, li) {
  const ghost = document.createElement("div")
  ghost.className = "ts-dragghost"
  const chip = li.querySelector(".ts-filechip")
  if (chip) ghost.appendChild(chip.cloneNode(true))
  const name = document.createElement("span")
  name.className = "ts-dragghost__name"
  name.textContent = li.querySelector(".truncate")?.textContent.trim() || ""
  ghost.appendChild(name)
  if (li.dataset.insert) {
    const snippet = document.createElement("code")
    snippet.className = "ts-dragghost__snippet"
    snippet.textContent = li.dataset.insert
    ghost.appendChild(snippet)
  }
  ;(li.closest(".ts-app") || document.body).appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, 12, 12)
  setTimeout(() => ghost.remove(), 0)
}

// Drag a file row onto a folder row (or the empty tree area = project root) to
// move it. Listeners are delegated on the <ul>, so they survive LiveView
// re-renders without managing any child DOM (no phx-update="ignore" needed).
// Internal moves are tracked via this.dragId; external file drags (which have
// no dragId) are ignored so the asset-upload drop target keeps working.
export const FileTreeDnD = {
  mounted() {
    this.dragId = null
    const root = this.el

    const clearOver = () =>
      root.querySelectorAll(".is-dnd-over").forEach((n) => n.classList.remove("is-dnd-over"))

    // A row drags its Typst snippet as text, so dropping it into the editor
    // inserts a reference (#97); dropping it on a folder here moves it.
    root.addEventListener("dragstart", (e) => {
      const li = e.target.closest("[data-dnd-file], [data-insert]")
      if (!li) return
      this.dragId = li.dataset.dndFile || null
      e.dataTransfer.effectAllowed = this.dragId ? "copyMove" : "copy"
      e.dataTransfer.setData("text/plain", li.dataset.insert || "")
      setRowDragImage(e, li)
      li.classList.add("is-dnd-dragging")
    })

    root.addEventListener("dragend", () => {
      root.querySelectorAll(".is-dnd-dragging").forEach((n) => n.classList.remove("is-dnd-dragging"))
      clearOver()
      this.dragId = null
    })

    root.addEventListener("dragover", (e) => {
      if (!this.dragId) return // not our drag (e.g. a file from the OS)
      e.preventDefault()
      e.dataTransfer.dropEffect = "move"
      clearOver()
      const dir = e.target.closest("[data-dnd-dir]")
      if (dir) dir.classList.add("is-dnd-over")
    })

    root.addEventListener("drop", (e) => {
      if (!this.dragId) return
      e.preventDefault()
      const dir = e.target.closest("[data-dnd-dir]")
      this.pushEvent("move_file", { id: this.dragId, dir: dir ? dir.dataset.dndDir : "" })
      clearOver()
      this.dragId = null
    })
  }
}

// Drag a file or asset row into the editor to insert its Typst snippet (#97).
// The row carries the snippet, with its path relative to the open file, in
// `data-insert`; CodeMirror's built-in drop handler inserts dropped
// `text/plain` at the drop position. Delegated on the <ul>, so rows LiveView
// re-renders need no re-binding.
export const InsertDrag = {
  mounted() {
    this.el.addEventListener("dragstart", (e) => {
      const li = e.target.closest("[data-insert]")
      if (!li) return
      e.dataTransfer.effectAllowed = "copy"
      e.dataTransfer.setData("text/plain", li.dataset.insert)
      setRowDragImage(e, li)
      li.classList.add("is-dnd-dragging")
    })
    this.el.addEventListener("dragend", () => {
      this.el.querySelectorAll(".is-dnd-dragging").forEach((n) => n.classList.remove("is-dnd-dragging"))
    })
  }
}
