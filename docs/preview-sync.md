# Preview ↔ source sync

Click a spot in the rendered preview to move the editor caret to its source
line; rest the caret in the editor to scroll the preview to the matching text
and flash it. Works across `#include`d files. Issue: typster-io/typster#149.

## How it works

- `assets/js/preview_sync.js` owns both directions. The worker protocol is
  unchanged except that a `compile` message carries a `requestId` the worker
  echoes in its `render` reply, so the SVG is paired with the exact sources
  that produced it.
- The SVG carries each text run's laid-out text in a hidden selection layer
  (`.typst-text > foreignObject .tsel`), in document order.
- The sources are flattened into a *virtual document*: the entry file with
  each `#include "x.typ"` file spliced in after its include line (cycle- and
  depth-guarded), then every other text source (CSV data, `#import`ed
  modules) as an appendix. Offsets in it map back to `{file, line, col}`.
  Matches in the appendix never move the reading position, so text a
  glossary pulls from a CSV resolves to its row without derailing the body.
- Runs are walked in order and each one's text is searched for near the
  current reading position (ahead first, a bounded distance behind for
  footnotes). The search is a regex built from the run that accepts the
  source however it spells things: any whitespace run (an indented
  continuation line, a tab, `~`) for a space, straight or curly quotes,
  `---` or an em dash, soft hyphens anywhere. A run that still misses drops a
  generated label ("Figure 1: ", "1.2 ") and tries again, then falls back to
  its longest word, which must match a whole word ahead of the position.
  Short runs may only match right where the previous run ended. A short run
  found far ahead (a table-of-contents entry) is a *weak* match: it neither
  claims the text, nor moves the reading position, nor bounds the placement
  of its neighbours, so the body's own heading still finds its line. Regex
  metacharacters and astral characters (emoji) in a run are escaped per code
  point; soft hyphens are dropped from the search text with an offset map.
- The same text rendered again with its source already taken (a running
  header, a footer) is a copy of the first occurrence and does not bound the
  placement of its neighbours.
- Source text claimed by an earlier run is not handed out again, so a
  sentence rendered twice (a running header, a value printed twice) does not
  send every copy to the first occurrence. The single-word fallback only
  accepts whole words ahead of the reading position.
- Runs with nothing to match (bullets, numbering, math glyphs, page numbers,
  `#lorem` output) are placed gap by gap between their matched neighbours: a
  source line in that stretch sharing a word with the run claims it
  (`#lorem(400)` for a "Lorem ipsum …" paragraph), the runs after it stay
  there until another run claims a later line, and runs before any claim take
  the first line able to produce content (not blank, a comment, a closing
  bracket, or a `#set`/`#show`/`#let`/`#import`/`#include`). A marker with no
  line of its own (a bullet, a heading number) belongs to the start of the
  next run's line. A placed run spans its whole line, so a caret anywhere on
  `#lorem(400)` finds the paragraph.
- Preview → source dispatches the existing `phx:editor-command` goto with
  `{file, line, col}`, where the column is the character under the pointer
  (the text layer's characters map one-to-one onto the matched source, give
  or take collapsed whitespace); a run placed on a line rather than matched
  (generated text) sends the caret to that line's end, a marker to its start. The CodeMirror hook moves the caret directly for the
  active file, otherwise pushes `open_path` and completes the move once the
  new buffer mounts.
- The preview keeps compiling the file you were previewing (the *entry*):
  a jump into an `#include`d chapter or a data file sends `project.entryPath`
  with every compile, the worker maps the live buffer at its own path and
  compiles the entry from the saved sources, and edits in the jumped-to
  buffer (even a CSV) re-render the whole document. Every `file_changed`
  carries a `reason`: a selection from the tree or a tab ("select") or a new
  file ("create") makes that file the entry when it is a Typst file; a jump
  ("jump"), a closed tab ("close"), a deleted file ("delete") or opening a
  data file (CSV, BibTeX, a note) keep the current entry while it is a
  `.typ` file that still exists. Opening a CSV from the tree therefore keeps
  previewing the document, and editing the CSV re-renders it. The hook also
  watches `data-project-sources` (LiveView merges it on every save, create,
  move or delete) and recompiles when a sibling source changed or the entry
  vanished. The PDF download is the entry document and takes its name.
- A pending autosave is flushed before any buffer switch, and the server
  stores a save for a file that is no longer current, so the last edits
  before a jump or a tree click are not lost. Re-selecting the active file
  pushes the pending save instead of taking the server's older copy. Moving
  the open buffer in the tree sends `file_moved`, which updates the path the
  compiler maps it at without re-creating the editor.
- The Problems drawer's rows and "Jump to first" carry the diagnostic's file,
  so an error in another file opens it.
- Source → preview runs 250 ms after a caret move that is not an edit, scrolls
  the pane only when the run is out of view, and flashes `.ts-preview__flash`
  only when the target run changed. A click beside the text picks the run on
  the same line first. A caret on a line whose own text matched nothing (a
  `#csv(...)` whose rows resolved to the data file) finds the runs placed in
  the stretch of lines around it, the one sharing a word with the line first.

## Why text alignment, not spans

The bundled typst.ts (0.8.0-rc3) exposes no span resolver to JavaScript: the
renderer's `source_span` reads page source mappings that the incremental
server no longer packs into the artifact, and the web compiler has no
`resolve_span`. Text alignment needs nothing from the compiler and follows
unsaved buffers.

## Known limits

- Text generated at compile time (numbering, references, code that prints
  strings) has no source text to match and is placed by its neighbours; text
  read from a project data file resolves to that file instead of the call.
- A phrase repeated within a few lines can match the earlier occurrence.
- Content pulled in through `#import`ed functions maps to the call site at
  best; only `#include` is spliced.
- Between a keystroke and the next compile the preview still reflects the
  previous buffer, so line numbers can drift by the edit until it recompiles.
- A paragraph interrupted by a line comment (`text // note` then a
  continuation line) matches only by its longest word.
