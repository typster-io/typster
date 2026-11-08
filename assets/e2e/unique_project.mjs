// The test database keeps the projects of earlier runs (and of runs going on
// beside this one), so every project gets a name no other row carries, and
// its row is found by its whole title: a name that is the start of another
// ("E2E Preview Render", "E2E Preview Render 2") must not match both.
export function uniqueProjectName(name) {
  return `${name} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function projectRow(page, unique) {
  const exact = new RegExp(`^\\s*${unique.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  return page.locator('.ts-list__row').filter({ has: page.locator('.ts-list__title', { hasText: exact }) })
}
