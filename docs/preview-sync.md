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
- The sources are flattened into a *virtual document*: the main file with
  each `#include "x.typ"` file spliced in after its include line (cycle- and
  depth-guarded). Offsets in it map back to `{file, line, col}`.
- Runs are walked in order and each one's text is searched for near the
  current reading position (ahead first, a bounded distance behind for
  running headers and footnotes). Typst's typography (curly quotes, dashes,
  ellipsis, soft hyphens) is undone before matching; a run that still misses
  falls back to its longest word. Short runs may only match right where the
  previous run ended.
- Runs with too little text to search for (bullets, numbering, math glyphs,
  page numbers) take the first non-blank source line between their matched
  neighbours, so an equation or figure lands on its own line.
- Preview → source dispatches the existing `phx:editor-command` goto with
  `{file, line, col}`. The CodeMirror hook moves the caret directly for the
  active file, otherwise pushes `open_path` and completes the move once the
  new buffer mounts.
- Source → preview runs 250 ms after a caret move that is not an edit, scrolls
  the pane only when the run is out of view, and flashes `.ts-preview__flash`
  only when the target run changed.

## Why text alignment, not spans

The bundled typst.ts (0.8.0-rc3) exposes no span resolver to JavaScript: the
renderer's `source_span` reads page source mappings that the incremental
server no longer packs into the artifact, and the web compiler has no
`resolve_span`. Text alignment needs nothing from the compiler and follows
unsaved buffers.

## Known limits

- Text generated at compile time (numbering, references, `#lorem`, code that
  prints strings) has no source text to match and inherits a neighbour's
  position.
- A phrase repeated within a few lines can match the earlier occurrence.
- Content pulled in through `#import`ed functions maps to the call site at
  best; only `#include` is spliced.
- Between a keystroke and the next compile the preview still reflects the
  previous buffer, so line numbers can drift by the edit until it recompiles.
