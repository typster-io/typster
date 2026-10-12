// Preview-sync fixtures: fixtures/preview_sync/<shape>.json names the
// document's source files, which live as real files under <shape>/, and
// holds the runs the Typst worker rendered for it, grouped by page:
// {"page": 0, "t": [...]} lists the page's runs in order, each a string, a
// [text, count] pair for a run repeated in a row (an outline's leader dots)
// or {"image": true} for a picture.
//
// Run as a script it rewrites the given fixtures (all without arguments) in
// one stable layout and checks every named source exists; it exits 1 when it
// changed or would change (--check) a file. It also takes runs as recorded,
// one {"t", "page"} or {"page", "image": true} object per run.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/preview_sync')

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// One {t, page} or {page, image} object per run.
function expandRuns(runs) {
  return runs.flatMap((group) => {
    if (!Array.isArray(group.t)) return [{ ...group }]
    const { page } = group
    return group.t.flatMap((item) => {
      if (typeof item === 'string') return [{ t: item, page }]
      if (Array.isArray(item)) return Array.from({ length: item[1] }, () => ({ t: item[0], page }))
      return [{ page, image: true }]
    })
  })
}

// The fixture as the tests use it: sources with their content, runs expanded.
export function loadFixture(shape) {
  const fx = JSON.parse(readFileSync(join(dir, `${shape}.json`), 'utf8'))
  const files = fx.files.map((path) => ({ path, content: readFileSync(join(dir, shape, path), 'utf8') }))
  return { ...fx, files, runs: expandRuns(fx.runs) }
}

// Runs grouped by page, a run repeated in a row as [text, count].
function groupRuns(runs) {
  const groups = []
  for (const run of expandRuns(runs)) {
    let group = groups[groups.length - 1]
    if (!group || group.page !== run.page) groups.push((group = { page: run.page, t: [] }))
    const last = group.t[group.t.length - 1]
    if (run.image) group.t.push({ image: true })
    else if (last === run.t) group.t[group.t.length - 1] = [run.t, 2]
    else if (Array.isArray(last) && last[0] === run.t) last[1]++
    else group.t.push(run.t)
  }
  return groups
}

const item = (value) => (Array.isArray(value) ? `[${JSON.stringify(value[0])}, ${value[1]}]` : value.image ? '{"image": true}' : JSON.stringify(value))

export function formatFixture(fx) {
  const { shape, about, entry, files, runs, ...rest } = fx
  const fields = Object.entries({ shape, about, entry, ...rest }).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  fields.push(` "files": ${JSON.stringify(files).replace(/","/g, '", "')}`)
  const groups = groupRuns(runs).map(({ page, t }) => `  {"page": ${page}, "t": [\n${t.map((v) => `   ${item(v)}`).join(',\n')}\n  ]}`)
  fields.push(` "runs": ${groups.length ? `[\n${groups.join(',\n')}\n ]` : '[]'}`)
  return `{\n${fields.join(',\n')}\n}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const paths = args.filter((a) => a.endsWith('.json'))
  const targets = paths.length ? paths : readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f))
  let changed = 0
  for (const path of targets) {
    const shape = basename(path, '.json')
    const before = readFileSync(path, 'utf8')
    const fx = JSON.parse(before)
    const missing = fx.files.filter((f) => !existsSync(join(dirname(path), shape, f)))
    if (missing.length) throw new Error(`${path}: missing ${missing.map((f) => `${shape}/${f}`).join(', ')}`)
    const after = formatFixture(fx)
    if (!same(expandRuns(JSON.parse(after).runs), expandRuns(fx.runs))) throw new Error(`${path}: formatting changed the runs`)
    if (after === before) continue
    changed++
    console.log(check ? `would reformat ${path}` : `reformatted ${path}`)
    if (!check) writeFileSync(path, after)
  }
  process.exit(changed ? 1 : 0)
}
