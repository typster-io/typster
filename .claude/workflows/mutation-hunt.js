export const meta = {
  name: 'mutation-hunt',
  description: 'Kill surviving mutants of preview_sync.js: per function group, sort survivors, write tests, verify suspected bugs, fix the confirmed ones',
  whenToUse: 'After `node assets/e2e/preview_sync_mutants.mjs --out file.json` leaves survivors. args: {groups: [{name, survivors, lines}], scratch, fix}',
  phases: [{ title: 'Hunt' }, { title: 'Verify' }, { title: 'Fix' }],
}

// args:
//   groups   one entry per group of functions, each worked by one agent:
//            name       short slug; the agent's tests go to assets/e2e/preview_sync_<name>.spec.mjs
//            survivors  path of a JSON file {ranges: [{fn, lines}], survivors: [{fn, line, from, to, code}]}
//            lines      the group's line ranges for --lines, e.g. '289-830' or '872-1119,3483-3564'
//   scratch  directory for the agents' mutation reports (pass the session scratchpad)
//   fix      fix the confirmed defects in preview_sync.js (default true)
const A = args || {}
if (!A.groups || !A.groups.length) throw new Error('mutation-hunt needs args.groups')
const S = A.scratch || '/tmp/typster-mutation-hunt'
const FIX = A.fix !== false

const CTX = `Work from the repository root. assets/js/preview_sync.js aligns the Typst preview's text runs with the sources (preview <-> source sync, #149); docs/preview-sync.md explains how.
Its Node specs, assets/e2e/preview_sync_*.spec.mjs (not the browser one, preview_sync.spec.mjs), load the module through assets/e2e/preview_sync_module.mjs (\`import sync from './preview_sync_module.mjs'\`; public functions plus lexTypst are exported) and run with Playwright's test/expect: cd assets && ./node_modules/.bin/playwright test e2e/<file> --project=chromium.
assets/e2e/preview_sync_align.spec.mjs is the main spec: read its align() / fixture() helpers and copy the style of its tests, including building documents inline (align([{ path, content }], 'main.typ', runs)).
The mutation check: cd assets && node e2e/preview_sync_mutants.mjs --lines <ranges> --specs <comma-separated spec files> --jobs 2 --out <file.json> changes one operator or number at a time and reports which mutants the specs catch. A mutant caught only by the 120-page frame-budget test is load noise, not a catch.
Rules:
- Tests check behaviour a user would notice (where a run lands, where a click goes, which run a caret finds, which characters the lexer treats as text), never a mutant's literal value. No hardcoding for particular documents or words in the module.
- Documents in tests are synthetic and inline; do not add or edit fixture files under assets/e2e/fixtures (they are being reformatted concurrently).
- Do not commit, push or publish. Do not touch port 4000 or 4002 servers.`

const HUNT = {
  type: 'object',
  properties: {
    spec: { type: 'string', description: 'the spec file written' },
    tests: { type: 'number', description: 'tests added' },
    survivorsBefore: { type: 'number' },
    survivorsAfter: { type: 'number', description: 'survivors in the group lines after, by the measured --out report' },
    equivalent: { type: 'array', items: { type: 'object', properties: { line: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' }, why: { type: 'string' } }, required: ['line', 'why'] } },
    untestable: { type: 'array', items: { type: 'object', properties: { line: { type: 'number' }, why: { type: 'string' } }, required: ['line', 'why'] } },
    suspicious: {
      type: 'array',
      description: 'code that looks wrong or dead: a defect a user could hit, or a branch that never changes the result',
      items: { type: 'object', properties: { line: { type: 'number' }, kind: { type: 'string', enum: ['bug', 'dead'] }, what: { type: 'string' }, evidence: { type: 'string', description: 'a concrete input and the wrong result, or why the branch never matters' } }, required: ['line', 'kind', 'what', 'evidence'] },
    },
    notes: { type: 'string' },
  },
  required: ['spec', 'tests', 'survivorsBefore', 'survivorsAfter', 'equivalent', 'suspicious'],
}

const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reproduction: { type: 'string', description: 'the input and result you ran, or why it is not real' },
    fix: { type: 'string', description: 'the smallest change that fixes it, if real' },
  },
  required: ['real', 'reproduction'],
}

phase('Hunt')
const results = await pipeline(
  A.groups,
  (g) =>
    agent(
      `${CTX}

Your group: ${g.name}. Survivors (mutants no test catches) are listed in ${g.survivors}: each with the function, line, the change (from -> to) and the source line. The group's lines: ${g.lines}.

1. Read the functions and sort every survivor: equivalent (the change cannot alter any result; say why), testable (some input gives a different result), untestable from outside without exporting more (say why), or suspicious (the code itself looks wrong, or a branch that never changes the result: dead code).
2. Write assets/e2e/preview_sync_${g.name}.spec.mjs (only this file; do not edit preview_sync.js or any other file) with tests that catch the testable survivors through behaviour. Each test must pass on the unchanged module.
3. Measure: cd assets && node e2e/preview_sync_mutants.mjs --lines ${g.lines} --specs preview_sync_align.spec.mjs,preview_sync_${g.name}.spec.mjs --jobs 2 --out ${S}/hunt-${g.name}.json, and add tests for what still survives while it pays off. Run the spec once more through Playwright at the end.
4. A suspected defect goes into "suspicious" with a concrete input; do not fix it.`,
      { label: `hunt:${g.name}`, phase: 'Hunt', schema: HUNT, model: 'opus', effort: 'high' },
    ),
  (r, g) =>
    parallel(
      (r?.suspicious || []).map((f) => () =>
        agent(
          `${CTX}

Another agent suspects a ${f.kind === 'dead' ? 'dead branch' : 'defect'} in assets/js/preview_sync.js at line ${f.line} (group ${g.name}): ${f.what}
Its evidence: ${f.evidence}
Try to refute it. For a defect, build the input in a throwaway script under ${S} (import the module through assets/e2e/preview_sync_module.mjs) and run it; it is real only if the result is wrong by what a user would expect from the docs and the existing tests. For a dead branch, it is real only if no input reaches it or it never changes the result. Default to real=false when unsure. Edit no repo file.`,
          { label: `verify:${g.name}:${f.line}`, phase: 'Verify', schema: VERDICT, model: 'opus', effort: 'high' },
        ).then((v) => ({ ...f, group: g.name, verdict: v })),
      ),
    ).then((vs) => ({ group: g.name, hunt: r, findings: vs.filter(Boolean) })),
)

const done = results.filter(Boolean)
const confirmed = done.flatMap((d) => d.findings.filter((f) => f.verdict && f.verdict.real))
log(`${done.length}/${A.groups.length} groups done, ${confirmed.length} confirmed findings`)

let fixed = null
if (FIX && confirmed.length) {
  phase('Fix')
  fixed = await agent(
    `${CTX}

Confirmed findings in assets/js/preview_sync.js:
${confirmed.map((f, i) => `${i + 1}. line ${f.line} (${f.kind}): ${f.what}\n   reproduction: ${f.verdict.reproduction}\n   suggested fix: ${f.verdict.fix || '-'}`).join('\n')}

Fix each in preview_sync.js with the smallest change that follows from Typst syntax or the rendered output (remove a dead branch only if it is truly dead), and add a test for each defect to the matching assets/e2e/preview_sync_<group>.spec.mjs. Then run every Node spec: cd assets && ./node_modules/.bin/playwright test e2e/preview_sync_align.spec.mjs ${done.map((d) => `e2e/preview_sync_${d.group}.spec.mjs`).join(' ')} --project=chromium. All must pass. Report each finding as fixed or not, with why.`,
    { label: 'fix', phase: 'Fix', model: 'opus', effort: 'high' },
  )
}

return {
  groups: done.map((d) => ({
    group: d.group,
    spec: d.hunt && d.hunt.spec,
    tests: d.hunt && d.hunt.tests,
    before: d.hunt && d.hunt.survivorsBefore,
    after: d.hunt && d.hunt.survivorsAfter,
    equivalent: d.hunt ? d.hunt.equivalent.length : 0,
    untestable: d.hunt && d.hunt.untestable ? d.hunt.untestable.length : 0,
    notes: d.hunt && d.hunt.notes,
    findings: d.findings.map((f) => ({ line: f.line, kind: f.kind, what: f.what, real: f.verdict && f.verdict.real, reproduction: f.verdict && f.verdict.reproduction })),
  })),
  fixed,
}
