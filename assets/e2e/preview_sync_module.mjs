// preview_sync.js for Node specs. assets/js is not an ES module package (the
// bundler reads it; Node would take it for CommonJS) and the module imports
// nothing, so its source is loaded as an ES module from a temporary .mjs
// copy. PREVIEW_SYNC_SOURCE swaps in another copy of the module
// (preview_sync_mutants.mjs).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const copy = join(mkdtempSync(join(tmpdir(), 'preview-sync-')), 'preview_sync.mjs')
writeFileSync(copy, readFileSync(process.env.PREVIEW_SYNC_SOURCE || join(here, '../js/preview_sync.js'), 'utf8'))

export default await import(pathToFileURL(copy).href)
