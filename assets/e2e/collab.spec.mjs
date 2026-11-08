import { test, expect } from '@playwright/test'
import { uniqueProjectName, projectRow } from './unique_project.mjs'

// Live collaborative editing (Yjs over a Phoenix channel). Two editor pages in
// one authenticated context are two distinct Yjs clients on the same server
// document: an edit in one must appear in the other, and each must paint the
// other's remote caret. Requires the server booted with TYPSTER_COLLAB=1.
//
// Collab is off by default in the test env (it makes Y.Text the editor's source
// of truth, which the other editor specs don't expect), so this spec self-skips
// unless the server was booted with the flag. Run it with:
//   MIX_ENV=test TYPSTER_COLLAB=1 PORT=4099 bunx playwright test e2e/collab.spec.mjs --project=chromium-authenticated
test.skip(process.env.TYPSTER_COLLAB !== '1', 'collaboration disabled (set TYPSTER_COLLAB=1)')

async function createProjectAndOpenEditor(page, name) {
  name = uniqueProjectName(name)
  await page.goto('/projects')
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
  await page.locator('#new-project-button').click()
  await expect(page.locator('.ts-dialog')).toBeVisible()
  await page.locator('.ts-dialog input[name="name"]').fill(name)
  await page.locator('.ts-dialog button[type="submit"]').click()
  await expect(page.locator('.ts-dialog')).not.toBeVisible()

  const row = projectRow(page, name)
  await expect(row).toBeVisible()
  await row.getByRole('link', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/projects\/.+\/edit/)
}

async function addMainFile(page) {
  await page.locator('#create-main-file-button').click()
  const draftInput = page.locator('#new-file-form input[name="path"]')
  await expect(draftInput).toBeVisible()
  await draftInput.fill('main.typ')
  await draftInput.press('Enter')
  await expect(page.locator('#editor-container .cm-content')).toBeVisible({ timeout: 10_000 })
}

// A fresh browser context logged in as `email` (separate session = separate
// user), mirroring auth.setup's dev test-login form submission.
async function loginAs(browser, email) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/')
  const csrf = await page.evaluate(
    () => document.querySelector('meta[name="csrf-token"]')?.content ?? ''
  )
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 15_000 }),
    page.evaluate(({ email, csrf }) => {
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = '/dev/test-login'
      const add = (n, v) => {
        const i = document.createElement('input')
        i.type = 'hidden'
        i.name = n
        i.value = v
        form.appendChild(i)
      }
      add('email', email)
      add('_csrf_token', csrf)
      document.body.appendChild(form)
      form.submit()
    }, { email, csrf }),
  ])
  if (!page.url().includes('/projects')) await page.goto('/projects')
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
  return { context, page }
}

test('live co-editing syncs both ways and renders remote cursors', async ({ context }) => {
  test.setTimeout(120_000)

  // Editor A creates the project + file.
  const a = await context.newPage()
  await createProjectAndOpenEditor(a, 'collab')
  await addMainFile(a)
  // The editor must be in collab mode for this test to mean anything.
  await expect(a.locator('#editor-container')).toHaveAttribute('data-collab', 'true')
  const editorUrl = a.url()

  // Editor B opens the same file (same session = authorized; distinct Yjs client).
  const b = await context.newPage()
  await b.goto(editorUrl)
  await expect(b.locator('#editor-container .cm-content')).toBeVisible({ timeout: 15_000 })

  const aContent = a.locator('#editor-container .cm-content')
  const bContent = b.locator('#editor-container .cm-content')

  // A → B.
  await aContent.click()
  await a.keyboard.type('HELLO_FROM_A')
  await expect(bContent).toContainText('HELLO_FROM_A', { timeout: 15_000 })

  // B → A (append, so we exercise a concurrent insert at a different offset).
  await bContent.click()
  await b.keyboard.press('Control+End')
  await b.keyboard.type(' PLUS_FROM_B')
  await expect(aContent).toContainText('PLUS_FROM_B', { timeout: 15_000 })

  // Remote presence: each editor paints the other client's caret.
  await expect(a.locator('.cm-ySelectionCaret').first()).toBeVisible({ timeout: 10_000 })
  await expect(b.locator('.cm-ySelectionCaret').first()).toBeVisible({ timeout: 10_000 })
})

// The real-world scenario: two *different* accounts (separate sessions) on one
// shared file — the owner and an invited collaborator. Exercises cross-user
// channel authorization (Files.get_file! must admit the collaborator) on top of
// the binding itself.
test('two different users co-edit a shared file in real time', async ({ browser }) => {
  test.setTimeout(120_000)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const emailA = `collab-a-${stamp}@typster.test`
  const emailB = `collab-b-${stamp}@typster.test`

  // Owner A creates a project + file.
  const A = await loginAs(browser, emailA)
  await createProjectAndOpenEditor(A.page, 'shared')
  await addMainFile(A.page)
  await expect(A.page.locator('#editor-container')).toHaveAttribute('data-collab', 'true')

  // A invites B as an editor; read B's invite id off the People list.
  await A.page.locator('.ts-tb__share').click()
  await expect(A.page.locator('.share-shell')).toBeVisible()
  await A.page.locator('.share-tabs button[phx-value-tab="people"]').click()
  await A.page.locator('#invite-form input[name="invite[email]"]').fill(emailB)
  await A.page.locator('#invite-form button[type="submit"]').click()
  const removeBtn = A.page.locator('.people-list button[phx-value-id]').first()
  await expect(removeBtn).toBeVisible({ timeout: 10_000 })
  const collabId = await removeBtn.getAttribute('phx-value-id')
  await A.page.locator('.share-head .x').click() // close the modal

  // B accepts the invite (links the account), landing in the same editor.
  const B = await loginAs(browser, emailB)
  await B.page.goto(`/invites/${collabId}`)
  await expect(B.page).toHaveURL(/\/projects\/.+\/edit/, { timeout: 15_000 })
  await expect(B.page.locator('#editor-container')).toHaveAttribute('data-collab', 'true')
  await expect(B.page.locator('#editor-container .cm-content')).toBeVisible({ timeout: 15_000 })

  const aContent = A.page.locator('#editor-container .cm-content')
  const bContent = B.page.locator('#editor-container .cm-content')

  // Owner → collaborator.
  await aContent.click()
  await A.page.keyboard.type('OWNER_EDIT')
  await expect(bContent).toContainText('OWNER_EDIT', { timeout: 15_000 })

  // Collaborator → owner.
  await bContent.click()
  await B.page.keyboard.press('Control+End')
  await B.page.keyboard.type(' COLLAB_EDIT')
  await expect(aContent).toContainText('COLLAB_EDIT', { timeout: 15_000 })

  // Each sees the other's caret, in the other user's colour.
  await expect(A.page.locator('.cm-ySelectionCaret').first()).toBeVisible({ timeout: 10_000 })
  await expect(B.page.locator('.cm-ySelectionCaret').first()).toBeVisible({ timeout: 10_000 })
})
