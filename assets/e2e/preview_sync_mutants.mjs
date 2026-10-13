// Mutation check for preview_sync.js: makes one small change at a time (a
// flipped comparison, a swapped operator, a number off by one), runs
// the Node specs of the module (preview_sync_*.spec.mjs but the browser one,
// preview_sync.spec.mjs) against each changed copy and reports which tests
// and fixtures catch it. A fixture whose tests catch nothing the other
// tests miss adds no checking power.
//
//   node e2e/preview_sync_mutants.mjs [--jobs 8] [--lines 100-400,900-950] [--specs a.spec.mjs,b.spec.mjs] [--out file.json]
//
// The spec runs in plain Node, one process per mutant, with a stand-in for
// Playwright's `test` (the real `expect`); a change on code the spec never
// runs is counted as survived without a run.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { Session } from 'node:inspector/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const self = fileURLToPath(import.meta.url)
const assets = join(dirname(self), '..')
const specs = (process.env.PREVIEW_SYNC_SPECS || '').split(',').filter(Boolean)

// Child mode: run the spec once and print each test's outcome as JSON
// (with --coverage, also the module's executed byte ranges).
if (process.argv[2] === '--child') {
  const tests = []
  const path = []
  const test = (title, fn) => tests.push({ title: [...path, title].join(' › '), fn })
  test.describe = (title, fn) => {
    path.push(title)
    fn()
    path.pop()
  }
  const { expect } = await import('@playwright/test')
  globalThis.__previewSyncTest = { test, expect }
  register(`data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === '@playwright/test') return { url: 'data:text/javascript,const t = globalThis.__previewSyncTest; export const test = t.test, expect = t.expect', shortCircuit: true }
      return next(specifier, context)
    }`)}`)
  const session = new Session()
  const coverage = process.argv.includes('--coverage')
  if (coverage) {
    session.connect()
    await session.post('Profiler.enable')
    await session.post('Profiler.startPreciseCoverage', { detailed: true })
  }
  for (const spec of specs) await import(pathToFileURL(join(assets, 'e2e', spec)).href)
  const outcome = []
  for (const t of tests) {
    try {
      await t.fn()
      outcome.push({ title: t.title, ok: true })
    } catch {
      outcome.push({ title: t.title, ok: false })
    }
  }
  let ranges = null
  if (coverage) {
    const { result } = await session.post('Profiler.takePreciseCoverage')
    ranges = result.find((s) => /preview-sync-[^/]+\/preview_sync\.mjs$/.test(s.url)).functions.flatMap((f) => f.ranges)
  }
  process.stdout.write(JSON.stringify({ outcome, ranges }))
  process.exit(0)
}

const source = readFileSync(join(assets, 'js/preview_sync.js'), 'utf8')
const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const jobs = Number(opt('jobs', 8))
const lineRanges = opt('lines', '1-1e9').split(',').map((r) => r.split('-').map(Number))
const out = opt('out', null)
if (!specs.length) {
  specs.push(...(opt('specs', null)?.split(',') ?? readdirSync(join(assets, 'e2e')).filter((f) => /^preview_sync_.+\.spec\.mjs$/.test(f))))
}

// Code tokens with their offsets; strings, templates, comments and regex
// literals are skipped whole, so mutations touch only operators and numbers.
function tokens(src) {
  const list = []
  let i = 0
  let prev = null
  const regexAllowed = () => !prev || (prev.kind === 'punct' && !/^[)\]}]$/.test(prev.text)) || /^(return|typeof|case|in|of|new|delete|void|throw|else|do)$/.test(prev.text)
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (src.startsWith('//', i)) { i = src.indexOf('\n', i); if (i < 0) break; continue }
    if (src.startsWith('/*', i)) { i = src.indexOf('*/', i) + 2; continue }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let depth = 0
      while (j < src.length && !(src[j] === c && depth === 0)) {
        if (src[j] === '\\') j++
        else if (c === '`' && src.startsWith('${', j)) { depth++; j++ }
        else if (c === '`' && depth && src[j] === '}') depth--
        j++
      }
      prev = { kind: 'str', text: src.slice(i, j + 1) }
      i = j + 1
      continue
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1
      let cls = false
      while (j < src.length && (src[j] !== '/' || cls)) {
        if (src[j] === '\\') j++
        else if (src[j] === '[') cls = true
        else if (src[j] === ']') cls = false
        j++
      }
      j++
      while (/[a-z]/.test(src[j])) j++
      prev = { kind: 'regex', text: src.slice(i, j) }
      i = j
      continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64))
    if (word) { prev = { kind: 'word', text: word[0], at: i }; list.push(prev); i += word[0].length; continue }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i, i + 32))
    if (num) { prev = { kind: 'num', text: num[0], at: i }; list.push(prev); i += num[0].length; continue }
    const punct = /^(===|!==|\.\.\.|\?\?=|\|\|=|&&=|\*\*|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*=|\/=|[-+*/%<>=!?:;,.(){}[\]&|^~])/.exec(src.slice(i, i + 4))
    prev = { kind: 'punct', text: punct ? punct[0] : c, at: i }
    list.push(prev)
    i += prev.text.length
  }
  return list
}

const swaps = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<': '<=', '<=': '<', '>': '>=', '>=': '>', '&&': '||', '||': '&&', '+': '-', '-': '+', '++': '--', '--': '++', true: 'false', false: 'true', max: 'min', min: 'max' }
const lineOf = (at) => source.slice(0, at).split('\n').length

function mutants() {
  const list = []
  const toks = tokens(source)
  toks.forEach((t, k) => {
    const before = toks[k - 1]
    const operand = before && (before.kind !== 'punct' || /^[)\]]$/.test(before.text))
    let to = null
    if (t.kind === 'num' && /^\d+$/.test(t.text)) to = String(Number(t.text) + 1)
    else if (t.kind === 'punct' && (t.text === '+' || t.text === '-') && !operand) to = null
    else if (t.kind === 'punct' && t.text === '!' && !operand) to = ''
    else if (t.kind === 'punct' && (t.text === '<' || t.text === '>') && before?.kind === 'word' && /^[A-Z]/.test(before.text)) to = null
    else if (t.text in swaps && (t.kind === 'punct' || (t.kind === 'word' && (t.text === 'true' || t.text === 'false' || before?.text === '.')))) to = swaps[t.text]
    if (to === null) return
    const line = lineOf(t.at)
    if (!lineRanges.some(([from, to]) => line >= from && line <= to)) return
    list.push({ at: t.at, line, from: t.text, to, code: source.slice(0, t.at) + to + source.slice(t.at + t.text.length) })
  })
  return list
}

// The fixtures each test reads: the fixture names quoted in its body.
const shapes = readdirSync(join(assets, 'e2e/fixtures/preview_sync')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
const fixturesOf = new Map(specs.flatMap((spec) => {
  const text = readFileSync(join(assets, 'e2e', spec), 'utf8')
  const starts = [...text.matchAll(/\btest\((['"`])(.*?)\1,/g)]
  return starts.map((m, k) => {
    const body = text.slice(m.index, starts[k + 1]?.index ?? text.length)
    return [m[2], shapes.filter((shape) => body.includes(`'${shape}'`))]
  })
}))
const fixturesOfTest = (title) => fixturesOf.get(title.split(' › ').at(-1)) ?? []

// Runs the spec against one copy of the module; null when the run broke
// (a syntax error, a hang), which every test counts as catching.
function runSpec(file, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [self, '--child', ...extra], { cwd: assets, env: { ...process.env, PREVIEW_SYNC_SOURCE: file, PREVIEW_SYNC_SPECS: specs.join(','), TMPDIR: dir } })
    let json = ''
    child.stdout.on('data', (d) => (json += d))
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('close', () => {
      clearTimeout(kill)
      try {
        resolve(JSON.parse(json))
      } catch {
        resolve(null)
      }
    })
  })
}

const dir = mkdtempSync(join(tmpdir(), 'preview-sync-mutants-'))
const original = join(dir, 'original.mjs')
writeFileSync(original, source)
// Coverage slows the module down, which the frame-budget test notices, so
// the outcomes come from a plain run and the ranges from a second one.
const { outcome: baseline } = await runSpec(original)
const { ranges } = await runSpec(original, ['--coverage'])
const failing = baseline.filter((t) => !t.ok)
if (!baseline.length || failing.length) {
  console.error('the spec must pass unchanged first:', failing.map((t) => t.title))
  process.exit(1)
}

// The innermost covered range around an offset tells whether it ran.
const ran = (at) => {
  let best = null
  for (const r of ranges) if (r.startOffset <= at && at < r.endOffset && (!best || r.endOffset - r.startOffset <= best.endOffset - best.startOffset)) best = r
  return best?.count > 0
}
const results = []
const all = mutants().filter((m, k) => {
  if (!ran(m.at)) {
    results.push({ line: m.line, from: m.from, to: m.to, caught: [], unrun: true })
    return false
  }
  const file = join(dir, `m${k}.mjs`)
  writeFileSync(file, m.code)
  m.file = file
  return spawnSync(process.execPath, ['--check', file]).status === 0
})
console.error(`${all.length} mutants to run, ${results.length} on code the spec never runs, ${baseline.length} tests, ${jobs} at a time`)

let next = 0
let done = 0
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < all.length) {
    const m = all[next++]
    const run = await runSpec(m.file)
    const caught = (run?.outcome ?? baseline.map((t) => ({ ...t, ok: false }))).filter((t) => !t.ok).map((t) => t.title)
    results.push({ line: m.line, from: m.from, to: m.to, caught })
    if (++done % 50 === 0) console.error(`${done}/${all.length}`)
  }
}))
results.sort((a, b) => a.line - b.line)
rmSync(dir, { recursive: true, force: true })

// A fixture's own catches: mutants only the tests reading it catch.
const reads = (title, shape) => fixturesOfTest(title).includes(shape)
const report = shapes.map((shape) => ({
  shape,
  tests: baseline.filter((t) => reads(t.title, shape)).length,
  caught: results.filter((m) => m.caught.some((t) => reads(t, shape))).length,
  own: results.filter((m) => m.caught.length && m.caught.every((t) => reads(t, shape))).length
}))
const survived = results.filter((m) => !m.caught.length)
const summary = { mutants: results.length, caught: results.length - survived.length, unrun: results.filter((m) => m.unrun).length, fixtures: report }
if (out) writeFileSync(out, JSON.stringify({ summary, baseline, results }, null, 1))
console.log(`caught ${summary.caught} of ${summary.mutants} mutants (${Math.round((100 * summary.caught) / summary.mutants)}%), ${summary.unrun} on code the spec never runs`)
for (const f of report.sort((a, b) => a.own - b.own)) console.log(`${String(f.own).padStart(4)} own ${String(f.caught).padStart(5)} caught  ${f.shape}`)
