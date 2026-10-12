// Rewrites preview-sync fixtures in one stable, compact layout: each file and
// each recorded run on its own line. Data is unchanged. With --check it only
// lists the files that differ; either way it exits 1 when one does.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/preview_sync')
const args = process.argv.slice(2)
const check = args.includes('--check')
const paths = args.filter((a) => a.endsWith('.json'))
const targets = paths.length ? paths : readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f))

const line = (value) => `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`
const list = (items) => (items.length ? `[\n${items.map((i) => `  ${line(i)}`).join(',\n')}\n ]` : '[]')

function format(fx) {
  const { shape, about, entry, files, runs, ...rest } = fx
  const head = { shape, about, entry, ...rest }
  const fields = Object.entries(head).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  fields.push(` "files": ${list(files.map(({ path, content, ...f }) => ({ path, content, ...f })))}`)
  fields.push(` "runs": ${list(runs.map(({ t, page, ...r }) => ({ t, page, ...r })))}`)
  return `{\n${fields.join(',\n')}\n}\n`
}

const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v)

let changed = 0
for (const path of targets) {
  const before = readFileSync(path, 'utf8')
  const after = format(JSON.parse(before))
  // Key order may move; the values must not.
  if (JSON.stringify(sorted(JSON.parse(after))) !== JSON.stringify(sorted(JSON.parse(before)))) throw new Error(`${path}: formatting changed the data`)
  if (after === before) continue
  changed++
  console.log(check ? `would reformat ${path}` : `reformatted ${path}`)
  if (!check) writeFileSync(path, after)
}
process.exit(changed ? 1 : 0)
