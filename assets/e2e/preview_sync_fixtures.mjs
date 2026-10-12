// Preview-sync fixtures: fixtures/preview_sync/<shape>.json names the
// document's source files, which live as real files under <shape>/, and
// holds the runs the Typst worker rendered for it. A run repeated in a row
// (an outline's leader dots) is stored once with its count in "x".
//
// Run as a script it rewrites the given fixtures (all without arguments) in
// one stable layout and checks every named source exists; it exits 1 when it
// changed or would change (--check) a file.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/preview_sync')

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// The fixture as the tests use it: sources with their content, runs expanded.
export function loadFixture(shape) {
  const fx = JSON.parse(readFileSync(join(dir, `${shape}.json`), 'utf8'))
  const files = fx.files.map((path) => ({ path, content: readFileSync(join(dir, shape, path), 'utf8') }))
  const runs = fx.runs.flatMap(({ x = 1, ...run }) => Array.from({ length: x }, () => ({ ...run })))
  return { ...fx, files, runs }
}

const collapse = (runs) => {
  const out = []
  for (const { x = 1, ...run } of runs) {
    const last = out[out.length - 1]
    if (last && same({ ...last, x: undefined }, { ...run, x: undefined })) last.x = (last.x || 1) + x
    else out.push(x > 1 ? { ...run, x } : run)
  }
  return out
}

const line = (value) => `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`

export function formatFixture(fx) {
  const { shape, about, entry, files, runs, ...rest } = fx
  const fields = Object.entries({ shape, about, entry, ...rest }).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  fields.push(` "files": ${JSON.stringify(files).replace(/","/g, '", "')}`)
  const items = collapse(runs).map(({ t, page, x, ...r }) => line({ t, page, ...r, x }))
  fields.push(` "runs": ${items.length ? `[\n${items.map((i) => `  ${i}`).join(',\n')}\n ]` : '[]'}`)
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
    const expand = (f) => f.runs.flatMap(({ x = 1, ...r }) => Array(x).fill(JSON.stringify(r, Object.keys(r).sort())))
    if (!same(expand(JSON.parse(after)), expand(fx))) throw new Error(`${path}: formatting changed the runs`)
    if (after === before) continue
    changed++
    console.log(check ? `would reformat ${path}` : `reformatted ${path}`)
    if (!check) writeFileSync(path, after)
  }
  process.exit(changed ? 1 : 0)
}
