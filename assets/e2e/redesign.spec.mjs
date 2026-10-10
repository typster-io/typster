import { test, expect } from '@playwright/test'

async function createProjectAndOpenEditor(page, name) {
  await page.goto('/projects')
  await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })
  await page.locator('#new-project-button').click()
  await expect(page.locator('.ts-dialog')).toBeVisible()
  await page.locator('.ts-dialog input[name="name"]').fill(name)
  await page.locator('.ts-dialog button[type="submit"]').click()
  await expect(page.locator('.ts-dialog')).not.toBeVisible()

  const row = page.locator('.ts-list__row').filter({ hasText: name })
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

test.describe('Product UI redesign', () => {
  test('share modal: real link, invite, and a public read-only view', async ({ page }) => {
    test.setTimeout(120_000)
    await createProjectAndOpenEditor(page, 'quarterly-report')
    await addMainFile(page)

    await page.locator('.ts-tb__share').click()
    const modal = page.locator('.share-shell')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // A real, copyable link with a token.
    const url = (await modal.locator('.link-box .path').textContent()).trim()
    expect(url).toMatch(/\/p\/quarterly-report\?key=.+/)

    // Pro features are gated.
    await expect(modal.locator('.perm-card.tone-write.gated .pro-badge')).toBeVisible()
    await expect(modal.locator('.locked-section .lock-shield')).toBeVisible()

    // Invite a collaborator → they appear in the access list.
    await modal.locator('.share-tabs .tab').filter({ hasText: 'People' }).click()
    await modal.locator('input[name="invite[email]"]').fill('newperson@studio.io')
    await modal.locator('button[type="submit"]').filter({ hasText: 'Send invite' }).click()
    await expect(modal.locator('.people-list')).toContainText('newperson@studio.io')

    // The link opens a public, read-only view that compiles client-side.
    await page.goto(url)
    await expect(page.locator('.share-public')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#preview-container')).toBeVisible()
  })

  test('redesigned embed view + clickable-but-locked Pro write card', async ({ page }) => {
    test.setTimeout(120_000)
    await createProjectAndOpenEditor(page, 'embed-look')
    await addMainFile(page)

    await page.locator('.ts-tb__share').click()
    const modal = page.locator('.share-shell')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // Pro write-scope card is clickable but NOT usable: clicking activates it
    // and reveals the upsell inline — it never selects a real write scope.
    const writeCard = modal.locator('.perm-card.tone-write')
    await expect(writeCard).not.toHaveClass(/\bactive\b/)
    await writeCard.click()
    await expect(writeCard).toHaveClass(/\bactive\b/)
    await expect(writeCard.locator('.upgrade-banner')).toBeVisible()

    // Pull the link token and open the cross-origin-framable embed view.
    const path = (await modal.locator('.link-box .path').textContent()).trim()
    const token = path.match(/key=([\w-]+)/)[1]
    await page.goto(`/embed/${token}`)

    // Redesigned embed chrome: identity bar, read-only pill, real read-only
    // source + live preview, and the single footer CTA.
    await expect(page.locator('.share-public--embed .embed-comp')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.embed-bar .slug')).toContainText('embed-look')
    await expect(page.locator('.ro-pill')).toBeVisible()
    await expect(page.locator('.embed-source #editor-container .cm-content')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('#preview-container')).toBeVisible()
    await expect(page.locator('.embed-foot__cta')).toBeVisible()
  })

  test('autocomplete suggests local #let and imported symbols', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'LocalImport E2E')
    await addMainFile(page)

    const cm = page.locator('#editor-container .cm-content')
    const pop = page.locator('.cm-tooltip-autocomplete')
    await cm.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')

    const line = async (t) => {
      await page.keyboard.type(t)
      await page.keyboard.press('Escape')
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
    }
    await line('#let mylocalfn(x) = x')
    await line('#import "lib.typ": importedfn')
    await line('#for myloopvar in xs [ ]')

    // The user's own local function is suggested.
    await page.keyboard.type('#mylo')
    await expect(pop).toBeVisible({ timeout: 5_000 })
    await expect(pop.locator('.cm-completionLabel').filter({ hasText: 'mylocalfn' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')

    // A symbol imported in this buffer is suggested too.
    await page.keyboard.type('#importedf')
    await expect(pop).toBeVisible({ timeout: 5_000 })
    await expect(
      pop.locator('.cm-completionLabel').filter({ hasText: 'importedfn' })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')

    // A `#for` loop variable is offered too.
    await page.keyboard.type('#myloop')
    await expect(pop).toBeVisible({ timeout: 5_000 })
    await expect(
      pop.locator('.cm-completionLabel').filter({ hasText: 'myloopvar' })
    ).toBeVisible()
  })

  test('autocomplete resolves a wildcard import from a project file', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Wildcard E2E')

    const newFile = async (name) => {
      await page.locator('#create-main-file-button').click()
      const draft = page.locator('#new-file-form input[name="path"]')
      await expect(draft).toBeVisible()
      await draft.fill(name)
      await draft.press('Enter')
      await expect(page.locator('#editor-container .cm-content')).toBeVisible({ timeout: 10_000 })
    }

    const cm = page.locator('#editor-container .cm-content')
    const pop = page.locator('.cm-tooltip-autocomplete')

    // A sibling module with an exported function.
    await newFile('lib.typ')
    await cm.click()
    await page.keyboard.type('#let libwildfn(a) = a')
    await page.waitForTimeout(1200) // let it autosave into project sources

    // Import everything from it and complete one of its exports.
    await newFile('main.typ')
    await cm.click()
    await page.keyboard.type('#import "lib.typ": *')
    await page.keyboard.press('Escape')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('#libwild')

    await expect(pop).toBeVisible({ timeout: 5_000 })
    await expect(
      pop.locator('.cm-completionLabel').filter({ hasText: 'libwildfn' })
    ).toBeVisible()
  })

  test('brackets and Typst math auto-close their pairs', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Autoclose E2E')
    await addMainFile(page)

    const cm = page.locator('#editor-container .cm-content')
    await cm.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('(') // -> ()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('$') // -> $$ (Typst math)

    await expect(cm).toContainText('()')
    await expect(cm).toContainText('$$')
  })

  test('accent picker persists on the user record', async ({ page }) => {
    await page.goto('/users/settings')
    await page.waitForFunction(() => window.liveSocket?.isConnected?.(), null, { timeout: 10_000 })

    await page.locator('#accent-violet').click()
    await expect(page.locator('#accent-violet')).toHaveClass(/is-active/)
    await expect(page.locator('.ts-app')).toHaveAttribute('data-accent', 'violet')

    // survives a full reload (DB-backed, server-rendered)
    await page.reload()
    await expect(page.locator('.ts-app')).toHaveAttribute('data-accent', 'violet')
    await expect(page.locator('#accent-indigo')).toBeVisible()

    // reset so the run is idempotent
    await page.locator('#accent-indigo').click()
    await expect(page.locator('.ts-app')).toHaveAttribute('data-accent', 'indigo')
  })

  test('command palette opens and filters', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Palette E2E')
    await addMainFile(page)

    await page.getByRole('button', { name: 'Open command palette' }).click()
    await expect(page.locator('#command-palette')).toBeVisible()
    await expect(page.locator('#palette-input')).toBeFocused()

    await page.locator('#palette-input').fill('settings')
    await expect(page.locator('.ts-palette__item').filter({ hasText: 'Settings' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('#command-palette')).not.toBeVisible()
  })

  test('sidebar: Find file opens the palette, ⌘P too, and the outline tracks the cursor', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Sidebar E2E')
    await addMainFile(page)

    await page.locator('#sidebar-find-file').click()
    await expect(page.locator('#command-palette')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#command-palette')).not.toBeVisible()

    const cm = page.locator('#editor-container .cm-content')
    await cm.click()
    await page.keyboard.press('ControlOrMeta+p')
    await expect(page.locator('#command-palette')).toBeVisible()
    await page.keyboard.press('Escape')

    await cm.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('= Title\n\n== Alpha\ntext\n\n== Beta\nmore')
    const outline = page.locator('#outline .ts-outline__item')
    await expect(outline).toHaveCount(3)
    // The caret sits on the last line, under "Beta".
    await expect(outline.filter({ hasText: 'Beta' })).toHaveClass(/is-active/)
    await expect(outline.filter({ hasText: 'Alpha' })).not.toHaveClass(/is-active/)

    // Moving the caret onto "text" (line 4) lights Alpha instead.
    await cm.locator('.cm-line').nth(3).click()
    await expect(outline.filter({ hasText: 'Alpha' })).toHaveClass(/is-active/)
    await expect(outline.filter({ hasText: 'Beta' })).not.toHaveClass(/is-active/)

    // Outline sits at the sidebar's foot, under the files.
    const files = await page.locator('#file-tree-main').boundingBox()
    const outlineBox = await page.locator('.ts-side__outline').boundingBox()
    expect(outlineBox.y).toBeGreaterThan(files.y + files.height)
  })

  test('the editor never scrolls as a page; only its panes scroll', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Viewport E2E')
    await addMainFile(page)
    const cm = page.locator('#editor-container .cm-content')
    await cm.click()
    await page.keyboard.type('= Long\n' + 'line\n'.repeat(80))

    for (const [width, height] of [[1280, 720], [900, 560]]) {
      await page.setViewportSize({ width, height })
      const m = await page.evaluate(() => {
        window.scrollTo(0, 99999)
        const scroller = document.querySelector('.cm-scroller')
        const status = document.querySelector('.ts-statusbar').getBoundingClientRect()
        return {
          pageScroll: document.documentElement.scrollHeight - innerHeight,
          scrollY: window.scrollY,
          statusBottom: status.bottom,
          paneScrolls: scroller.scrollHeight > scroller.clientHeight,
          topbar: document.querySelector('.ts-tb').getBoundingClientRect().height
        }
      })
      expect(m.pageScroll, `${width}x${height} page scroll`).toBeLessThanOrEqual(0)
      expect(m.scrollY).toBe(0)
      expect(m.statusBottom).toBeLessThanOrEqual(height)
      expect(m.paneScrolls).toBe(true)
      if (height <= 760) expect(m.topbar).toBeLessThan(44)
      if (height <= 600) await expect(page.locator('#sidebar-upload')).toBeHidden()
      else await expect(page.locator('#sidebar-upload')).toBeVisible()
    }
  })

  test('dragging a file anywhere over the window lights the sidebar as the drop target', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Drop Light E2E')
    await addMainFile(page)
    const shell = page.locator('#editor-shell')
    const side = page.locator('#editor-sidebar')
    const preview = page.locator('.ts-preview')
    const row = page.locator('#sidebar-upload')
    await expect(row).toHaveText(/Upload file/)

    // LiveView lights a drop target on dragenter only when the drag carries files.
    const dt = await page.evaluateHandle(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'drop.png', { type: 'image/png' }))
      return dt
    })
    const zone = page.locator('#sidebar-dropzone')
    await expect(zone).toBeHidden()
    // Entering over the preview, far from the sidebar, is enough.
    await preview.dispatchEvent('dragenter', { dataTransfer: dt })
    await expect(shell).toHaveClass(/phx-drop-target-active/)
    // The overlay covers the whole panel, not just the row.
    await expect(zone).toBeVisible()
    await expect(zone).toHaveText(/Drop to add/)
    const [sideBox, zoneBox] = await Promise.all([side.boundingBox(), zone.boundingBox()])
    expect(Math.abs(zoneBox.height - sideBox.height)).toBeLessThan(2)
    await expect(row).toHaveText(/Upload file/)
    // The rest of the editor sits under a scrim while the panel is live.
    const scrim = () => page.evaluate(() => getComputedStyle(document.querySelector('.ts-editor'), '::after').position)
    expect(await scrim()).toBe('fixed')

    // Leaving the window (no related target) clears everything.
    await shell.dispatchEvent('dragleave', { dataTransfer: dt, relatedTarget: null, clientX: 0, clientY: 0 })
    await expect(shell).not.toHaveClass(/phx-drop-target-active/)
    await expect(zone).toBeHidden()
    expect(await scrim()).not.toBe('fixed')
  })

  test('command shortcut hint adapts to the OS (⌘ on Mac, Ctrl elsewhere)', async ({ page }) => {
    // Force a Windows-class platform before any script runs.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgentData', {
        value: { platform: 'Windows' },
        configurable: true
      })
    })

    await createProjectAndOpenEditor(page, 'Shortcut OS E2E')
    await addMainFile(page)

    await expect(page.locator('html')).not.toHaveClass(/is-mac/)
    // Non-mac: "Ctrl K" shown in the merged top-bar omnibox, ⌘ variant hidden.
    await expect(page.locator('.ts-tb__omni-key .ts-other')).toBeVisible()
    await expect(page.locator('.ts-tb__omni-key .ts-other')).toHaveText('Ctrl K')
    await expect(page.locator('.ts-tb__omni-key .ts-mac')).toBeHidden()

    // The button still opens the palette regardless of platform labelling.
    await page.getByRole('button', { name: 'Open command palette' }).click()
    await expect(page.locator('#command-palette')).toBeVisible()
  })

  test('applies Shiki Typst syntax highlighting', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Highlight E2E')
    await addMainFile(page)

    // Shiki initializes asynchronously, then paints colored token spans.
    const colored = page.locator('#editor-container .cm-line span[style*="color"]')
    await expect(colored.first()).toBeVisible({ timeout: 15_000 })
    expect(await colored.count()).toBeGreaterThan(0)
  })

  test('a line comment holding a second // does not swallow the file', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Highlight Comment E2E')
    await addMainFile(page)

    const cm = page.locator('#editor-container .cm-content')
    await cm.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Delete')
    await page.keyboard.insertText('// === start === // of the block\n= Heading <label>\n#let x = 1\n')

    // The heading and the `#let` keep their own colours instead of the
    // comment grey the first line gets.
    const heading = page.locator('#editor-container .cm-line', { hasText: 'Heading' })
    await expect(heading.locator('span[style*="color"]').first()).toBeVisible({ timeout: 15_000 })
    const commentColor = await page
      .locator('#editor-container .cm-line', { hasText: 'start' })
      .locator('span[style*="color"]')
      .first()
      .evaluate((el) => el.style.color)
    const headingColors = await heading.locator('span[style*="color"]').evaluateAll((els) => els.map((el) => el.style.color))
    expect(headingColors.length).toBeGreaterThan(0)
    expect(headingColors).not.toContain(commentColor)
  })

  test('formatting toolbar inserts markup into the editor', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Toolbar E2E')
    await addMainFile(page)

    const cm = page.locator('#editor-container .cm-content')
    await cm.click()
    await page.getByRole('button', { name: 'Bold' }).click()

    await expect(cm).toContainText('*')
  })

  test('autocomplete completes a function to #name() with the caret inside', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Autocomplete E2E')
    await addMainFile(page)

    const cm = page.locator('#editor-container .cm-content')
    await cm.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('#figu')

    const pop = page.locator('.cm-tooltip-autocomplete')
    await expect(pop).toBeVisible({ timeout: 5_000 })
    await expect(pop.locator('.cm-completionLabel').first()).toContainText('figure')

    // Accepting inserts "#figure()" with the caret between the parens.
    await pop.locator('li').filter({ hasText: 'figure' }).first().click()
    await page.keyboard.type('image')
    await expect(cm).toContainText('#figure(image)')
  })

  test('selecting text shows the quick-action bubble and Bold wraps it', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Bubble E2E')
    await addMainFile(page)

    const cm = page.locator('#editor-container .cm-content')
    await cm.click()
    // Put the prose on its own fresh line so the selection is exactly it.
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Some prose to select.')
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')

    const bubble = page.locator('.cm-qa')
    await expect(bubble).toBeVisible({ timeout: 5_000 })
    await expect(bubble.locator('.cm-qa__btn.is-primary')).toContainText('Heading')

    await bubble.locator('button[title^="Bold"]').click()
    await expect(cm).toContainText('*Some prose to select.*')
  })

  test('download button exports the compiled document as a PDF', async ({ page }) => {
    await createProjectAndOpenEditor(page, 'Download E2E')
    await addMainFile(page)

    // Wait for the first preview render so the Typst worker WASM is initialized.
    await expect(page.locator('#typst-svg-output')).toBeVisible({ timeout: 20_000 })

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Download' }).click()

    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('main.pdf')
  })
})
