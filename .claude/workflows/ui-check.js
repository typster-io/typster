export const meta = {
  name: 'ui-check',
  description: 'Check a Typster UI behaviour on the real app: independent gates, optional fix rounds until they pass',
  whenToUse: 'Verifying or hardening any editor/preview/UI behaviour end to end. args: {goal, scenarios[], mode: verify|fix, rounds, gates[], baseline, issue, files[], scratch, collab, commit}',
  phases: [{ title: 'Fix' }, { title: 'Tests' }, { title: 'Gate' }, { title: 'Commit' }],
}

// args:
//   goal       what behaviour is checked (required), e.g. 'preview <-> source sync (#149)'
//   scenarios  the user's own steps, each run on the real UI and judged by what the user sees
//   mode       'verify' (gates only, default) or 'fix' (fix -> tests -> gates, repeated)
//   rounds     max fix rounds (default 2); each round is about 6 agents
//   gates      subset of ['user', 'suite', 'design'] (default all three)
//   baseline   git ref regressions are compared against (default 'origin/main')
//   issue      GitHub issue number, used in commit messages
//   files      paths the change is expected to touch, to focus the agents
//   scratch    directory for harness scripts, screenshots and backups (pass the session scratchpad)
//   collab     true to also run the collab specs on a temporary TYPSTER_COLLAB=1 server
//   commit     in fix mode, commit each round whose suite gate passes (default true, never pushes)
const A = args || {}
if (!A.goal) throw new Error('ui-check needs args.goal')
const MODE = A.mode === 'fix' ? 'fix' : 'verify'
const ROUNDS = MODE === 'fix' ? A.rounds || 2 : 0
const GATES = A.gates && A.gates.length ? A.gates : ['user', 'suite', 'design']
const BASE = A.baseline || 'origin/main'
const S = A.scratch || '/tmp/typster-ui-check'
const SCEN = (A.scenarios || []).map((s, i) => `${i + 1}. ${s}`).join('\n') || '(none given: derive them from the goal and the linked issue)'

const CTX = `Work from the repository root (Typster: Phoenix 1.8 + LiveView, CodeMirror 6, typst.ts preview in a Web Worker, Playwright specs in assets/e2e).
Goal under check: ${A.goal}${A.issue ? ` (issue #${A.issue})` : ''}.
${A.files && A.files.length ? `Expected files: ${A.files.join(', ')}.\n` : ''}User scenarios, judged by what the user sees on screen:
${SCEN}
Environment rules:
- The MIX_ENV=test server on port 4002 serves the app for browser checks. If it is down, start it (MIX_ENV=test PHX_SERVER=true PORT=4002 mix phx.server, in the background) and say so. Never stop it, never touch port 4000 (the user's dev server), never run ecto.reset or mix precommit.
- Login state: assets/e2e/.auth/session.json; refresh with: cd assets && PORT=4002 ./node_modules/.bin/playwright test --project=setup.
- After any JS/CSS edit rebuild the served bundle: mix bun js && mix bun worker && mix tailwind typster. After .ex/.heex edits the 4002 server needs a restart by PID (check its cmdline first).
- Full browser suite: cd assets && PORT=4002 ./node_modules/.bin/playwright test. Create projects with unique names (assets/e2e/unique_project.mjs).
- No hardcoding for particular documents, words, file names or the user's project: every rule must follow from the syntax, the data or the rendered output.
- Keep the style of the surrounding code. No inline SVG anywhere. User-facing copy goes through gettext with en and ru filled.
- Do not commit, push or publish anything. Do not use real user projects as committed fixtures; invent synthetic content.
- Put every scratch file, harness script, screenshot and backup under ${S}/.`

const ITEM = { type: 'object', properties: { item: { type: 'string' }, reason: { type: 'string' } }, required: ['item', 'reason'] }
const CHANGE = { type: 'object', properties: { file: { type: 'string' }, what: { type: 'string' } }, required: ['file', 'what'] }
const DEFECT = { type: 'object', properties: {
  title: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] },
  steps: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' },
  preexisting: { type: 'boolean', description: `true when ${BASE} shows the same wrong result` } },
  required: ['title', 'severity', 'steps', 'expected', 'actual', 'preexisting'] }
const GATE_SCHEMA = { type: 'object', properties: {
  pass: { type: 'boolean' },
  checks: { type: 'array', items: { type: 'object', properties: { check: { type: 'string' }, ok: { type: 'boolean' }, observed: { type: 'string' } }, required: ['check', 'ok', 'observed'] } },
  newDefects: { type: 'array', items: DEFECT },
  harness: { type: 'string', description: 'paths of the scripts and screenshots this gate left under the scratch dir, so the next round can re-run them' } },
  required: ['pass', 'checks', 'newDefects', 'harness'] }

const GATE_PROMPTS = {
  user: (r) => `${CTX}

You are an independent gate${r ? ` for fix round ${r}` : ''}. Do not edit source files. Confirm first that the served bundle equals a fresh build of the current sources.
1. Run every user scenario above on the real UI on 4002 with Playwright, in light and dark theme, and save a screenshot of each result under ${S}/gate-user${r ? `-r${r}` : ''}/. Judge by the visible outcome, not by internal state. Collect browser console errors and failed requests.
2. Adversarial pass: build at least 5 NEW inputs or document shapes that differ from the scenarios and from each other (other languages and scripts, other file names and formats, nested includes, large files, empty and edge cases) and check the same behaviour on each.
3. Hardcode audit: read the changed code (git diff ${BASE}) and look for any rule that only works for specific words, file names, languages or projects.
4. Re-run every harness script earlier rounds left: ${A.harness || '(none yet)'}.
For each wrong result run the same steps on ${BASE} and set preexisting accordingly.
pass = every scenario right, no console errors caused by the change, no non-preexisting medium/high defect.`,
  suite: (r) => `${CTX}

You are an independent gate${r ? ` for fix round ${r}` : ''}. Do not edit source files.
1. Full Playwright suite twice in a row without a DB reset; report counts, flaky tests and skipped test names.
2. mix test (whole suite). A failure caused only by leftover e2e rows in the shared typster_test DB is expected: prove that cause by re-running the failing file, or with MIX_TEST_PARTITION=2 (drop typster_test2 afterwards).
3. Regressions: for every test file and harness the diff against ${BASE} touches, confirm what passed on ${BASE} still passes.
4. mix compile --warnings-as-errors, mix format --check-formatted, cd assets && bun run lint:css.${A.collab ? `
5. Start a temporary MIX_ENV=test TYPSTER_COLLAB=1 PHX_SERVER=true PORT=4003 server, run the collab specs 3 times, then stop it by PID after checking its cmdline.` : ''}
pass = all of the above green, except the documented expected DB-leftover cause.`,
  design: (r) => `${CTX}

You are an independent design and accessibility gate${r ? ` for fix round ${r}` : ''}. Do not edit source files. Read docs/landing-style.md (section 'Product UI') and docs/landing-redesign-guide.md first.
On 4002 with Playwright, for every screen the goal touches: light and dark theme, every accent ([data-accent]), prefers-reduced-motion, 390px phone width (no horizontal scroll) and 1440px desktop, keyboard-only use (focus visible, every action reachable), contrast >= 4.5:1 for body text and >= 3:1 for UI, both locales (en and ru: no missing or overflowing strings). Save screenshots under ${S}/gate-design${r ? `-r${r}` : ''}/.
In the diff against ${BASE}: colours, radii and shadows come from --mk-* tokens, no inline style except custom properties, no inline SVG, every animation has a reduced-motion counterpart.
pass = no non-preexisting medium/high defect.`,
}

const runGates = (r) => parallel(GATES.map((g) => () =>
  agent(GATE_PROMPTS[g](r), { label: `gate:${g}${r ? `:r${r}` : ''}`, phase: 'Gate', model: 'opus', effort: 'high', schema: GATE_SCHEMA })
    .then((res) => res && { gate: g, ...res })))

const open = (gates) => gates.filter(Boolean).flatMap((g) => g.newDefects.filter((d) => !d.preexisting).map((d) => ({ gate: g.gate, ...d })))

if (MODE === 'verify') {
  phase('Gate')
  const gates = await runGates(0)
  const missing = GATES.filter((g, i) => !gates[i])
  if (missing.length) log(`gates that returned nothing: ${missing.join(', ')}`)
  return { mode: MODE, pass: !missing.length && gates.every((g) => g && g.pass), gates, open: open(gates) }
}

const rounds = []
let todo = A.defects || []
let harness = A.harness || ''
for (let r = 1; r <= ROUNDS; r++) {
  phase('Fix')
  const fix = await agent(`${CTX}

Fix round ${r}. First copy every file you will edit to ${S}/backup-r${r}/ (same relative paths) so later rounds can compare against it.
${todo.length ? `Fix these defects found by the gates, with general rules only:\n${JSON.stringify(todo, null, 1)}` : 'Make every user scenario above work as described; first reproduce each one on 4002 and note which fail.'}
Add or update unit/ExUnit tests for each change. Rebuild, run the tests you touched and the Playwright specs of the area. Update docs that describe the changed behaviour.
Return what changed, what is left and why, and the test results with counts.`, {
    label: `fix:r${r}`, phase: 'Fix', model: 'opus', effort: 'high',
    schema: { type: 'object', properties: {
      changes: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, what: { type: 'string' }, resolves: { type: 'string' } }, required: ['file', 'what', 'resolves'] } },
      hardcodeAudit: { type: 'string' }, left: { type: 'array', items: ITEM }, tests: { type: 'string' } },
      required: ['changes', 'hardcodeAudit', 'left', 'tests'] },
  })
  if (!fix) { log(`round ${r}: fix agent returned nothing, stopping`); break }

  phase('Tests')
  const tests = await agent(`${CTX}

Fix round ${r} just landed: ${JSON.stringify(fix).slice(0, 6000)}
Tests only, plus the rebuild:
1. Rebuild the bundle.
2. Add browser e2e tests in assets/e2e that drive each user scenario and each fixed defect the way the user does. Prove each new test fails on the pre-round files (${S}/backup-r${r}/): swap them in, rebuild, run, then restore byte-identical (compare checksums) and rebuild.
3. Run the specs of the area and report counts.
Return the changes, results with counts, and anything left with reasons.`, {
    label: `tests:r${r}`, phase: 'Tests', model: 'opus', effort: 'high',
    schema: { type: 'object', properties: { changes: { type: 'array', items: CHANGE }, results: { type: 'string' }, left: { type: 'array', items: ITEM } }, required: ['changes', 'results', 'left'] },
  })

  phase('Gate')
  const gates = await runGates(r)
  harness = [harness, ...gates.filter(Boolean).map((g) => g.harness)].filter(Boolean).join('; ')
  todo = open(gates)
  const suite = gates.find((g) => g && g.gate === 'suite')
  let commit = null
  if (A.commit !== false && (!GATES.includes('suite') || (suite && suite.pass))) {
    phase('Commit')
    commit = await agent(`${CTX}

Exception to the no-commit rule, for this step only: commit the work of fix round ${r} on the current branch, without pushing.
Changes: ${JSON.stringify({ fix: fix.changes, tests: tests && tests.changes }).slice(0, 4000)}
Stage only files this round changed (check git status; leave anything else alone). One Conventional Commit per logical change: 'type(scope): summary', one imperative sentence, at most 69 characters, no body, no AI credit, using the configured git identity. Return the commit hashes and messages.`, { label: `commit:r${r}`, phase: 'Commit', model: 'sonnet', effort: 'low' })
  } else log(`round ${r}: suite gate not green, round left uncommitted`)
  rounds.push({ round: r, fix, tests, gates, commit })
  log(`round ${r}: ${todo.length} open defect(s)`)
  if (!todo.length && gates.every((g) => g && g.pass)) break
}
if (todo.length) log(`stopped after ${rounds.length} round(s) with ${todo.length} open defect(s)`)
return { mode: MODE, pass: !todo.length && rounds.length > 0 && rounds[rounds.length - 1].gates.every((g) => g && g.pass), rounds, open: todo, harness }
