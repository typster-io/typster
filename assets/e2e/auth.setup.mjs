import { test as setup, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const authFile = path.join(__dirname, '.auth/session.json')

setup('authenticate', async ({ page }) => {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@typster.test`

  // The dev server has no /dev/test-login route (it is compiled in only for
  // MIX_ENV=test), so there the account signs in through its magic link from
  // the dev mailbox.
  const testLogin = await page.request.post('/dev/test-login', { maxRedirects: 0, failOnStatusCode: false })
  if (testLogin.status() === 404) {
    await page.goto('/users/register')
    await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
    await page.fill('#registration_form input[type=email]', email)
    await page.click('#registration_form button[type=submit]')
    let link
    for (let i = 0; i < 50 && !link; i++) {
      const { data } = await (await page.request.get('/dev/mailbox/json')).json()
      link = data.find((m) => m.to.includes(email))?.text_body.match(/http\S+\/users\/log-in\/\S+/)?.[0]
      if (!link) await page.waitForTimeout(200)
    }
    expect(link, 'magic link in /dev/mailbox').toBeTruthy()
    await page.goto(new URL(link).pathname)
    // The link page may sign in on its own; otherwise press its first button.
    const signedIn = page.waitForURL((url) => !url.pathname.startsWith('/users/log-in'), { timeout: 10_000 })
    await Promise.race([signedIn, page.locator('#confirmation_form button, #login_form button').first().click().catch(() => {})])
    await signedIn
    await page.goto('/projects')
    await page.waitForURL(/\/projects/, { timeout: 10_000 })
    await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
    fs.mkdirSync(path.dirname(authFile), { recursive: true })
    await page.context().storageState({ path: authFile })
    return
  }

  await page.goto('/')
  const csrfToken = await page.evaluate(
    () => document.querySelector('meta[name="csrf-token"]')?.content ?? ''
  )

  // Submit the form via the browser so the resulting session cookie lands
  // directly in the browser context.
  //
  // Start watching for navigation BEFORE triggering submit so we don't miss
  // the redirect that immediately follows the POST response.
  const [_response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 15_000 }),
    page.evaluate(({ email, csrfToken }) => {
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = '/dev/test-login'

      const addField = (name, value) => {
        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = name
        input.value = value
        form.appendChild(input)
      }

      addField('email', email)
      addField('_csrf_token', csrfToken)
      document.body.appendChild(form)
      form.submit()
    }, { email, csrfToken }),
  ])

  // The controller should redirect to /projects, but if anything in the
  // session caused a different redirect, navigate there explicitly.
  // The session cookie is established regardless of where we landed.
  if (!page.url().includes('/projects')) {
    await page.goto('/projects', { waitUntil: 'load', timeout: 10_000 })
  }

  await page.waitForURL(/\/projects/, { timeout: 10_000 })
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })

  fs.mkdirSync(path.dirname(authFile), { recursive: true })
  await page.context().storageState({ path: authFile })
})
