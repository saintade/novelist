import { expect, test, type Page } from '@playwright/test'

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
}

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const repositoryPath = '/src/lib/library/repository.ts'
    const { getBooks, removeBook } = await import(repositoryPath)
    for (const book of await getBooks()) await removeBook(book.id)
  })
})

test('library has one import action, one theme control and no workspace clutter', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(3, { timeout: 45_000 })
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /import/i })).toHaveCount(1)
  await expect(page.getByRole('button', { name: /Switch to .* mode/ })).toHaveCount(1)
  await page.getByRole('button', { name: 'Reading preferences', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Reading settings', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Increase text size' }).click()
  await expect(page.getByRole('slider', { name: /^Text size/ })).toHaveValue('20')
  await page.getByRole('button', { name: 'Close reading settings' }).click()
  const navigation = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(navigation.getByRole('link')).toHaveCount(2)
  await expect(navigation.getByRole('link', { name: 'Bookmarks', exact: true })).toBeVisible()
  await expect(
    page.locator('.workspace-header, .workspace-footer, .avatar, .personal-space, .import-tile'),
  ).toHaveCount(0)
  await expect(
    page.getByText(
      /^(Workspace|Your personal collection|Personal collection|Local library|Local Supabase|Preferences|My space|Personal library|Saved locally)$/i,
    ),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'Import book', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Import a book', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close import a book' }).click()
  await navigation.getByRole('link', { name: 'Bookmarks', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bookmarks', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Switch to .* mode/ })).toHaveCount(1)
  await navigation.getByRole('link', { name: 'Library', exact: true }).click()
  await page.getByRole('tab', { name: /^Finished/ }).click()
  await expect(page.getByRole('heading', { name: 'Nothing on this shelf yet' })).toBeVisible()
  await expect(page.getByRole('button', { name: /import/i })).toHaveCount(1)
  await page.getByRole('button', { name: 'View all books' }).click()
  await expect(page.locator('.book-tile')).toHaveCount(3)
  await expectNoOverflow(page)
})

test('reader preserves chapters, bookmarks, appearance and reading position', async ({
  page,
}, testInfo) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(3, { timeout: 45_000 })
  await expectNoOverflow(page)
  const filters = await page.locator('.collection-top .filter-tabs').boundingBox()
  const viewControls = await page.locator('.view-switch').boundingBox()
  expect(filters!.x + filters!.width).toBeLessThanOrEqual(viewControls!.x)
  expect(
    await page
      .locator('.book-cover img')
      .evaluateAll((images) =>
        images.every(
          (image) =>
            (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
        ),
      ),
  ).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('library-light.png'), fullPage: true })
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: testInfo.outputPath('library-dark.png'), fullPage: true })
  await page.locator('.tile-title').filter({ hasText: "Alice's Adventures in Wonderland" }).click()
  await expect(page.getByRole('heading', { name: 'Synopsis' })).toBeVisible()
  await expect(page.locator('.chapter-list-item')).toHaveCount(12)
  await expectNoOverflow(page)
  await page.screenshot({ path: testInfo.outputPath('book-details.png'), fullPage: true })
  await page.getByRole('link', { name: 'Start reading', exact: true }).click()
  await expect(page.locator('.chapter-body')).toContainText('Alice')
  await expect(page.getByRole('button', { name: 'Previous chapter', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('reader-dark.png') })
  await expectNoOverflow(page)

  await page.locator('.reader-location').click()
  await expect(page.getByRole('dialog', { name: 'Contents', exact: true })).toBeVisible()
  await page.locator('.toc-entry').nth(1).click()
  await expect(page).toHaveURL(/\/read\/[^/]+\/1$/)
  await expect(page.locator('.chapter-heading h1')).toHaveText('The Pool of Tears')
  await page.getByLabel('Next chapter', { exact: true }).click()
  await expect(page).toHaveURL(/\/read\/[^/]+\/2$/)
  await expect(page.locator('.chapter-body')).toBeVisible()
  await page.getByRole('button', { name: 'Previous chapter', exact: true }).click()
  await expect(page.locator('.chapter-heading h1')).toHaveText('The Pool of Tears')

  const progressSaved = page.waitForResponse((response) => {
    if (
      !response.url().includes('/rest/v1/reading_progress') ||
      response.request().method() !== 'POST'
    )
      return false
    const payload = response.request().postDataJSON()
    return payload.fraction > 0.35 && payload.fraction < 0.45 && response.ok()
  })
  await page.evaluate(() =>
    window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * 0.4),
  )
  await progressSaved
  await page.getByRole('button', { name: 'Bookmark this position', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remove bookmark', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator('.chapter-body')).toBeVisible()
  await expect(page.locator('.reader-location')).toContainText('40%')
  await expect(page.getByRole('button', { name: 'Remove bookmark', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  await page.getByRole('button', { name: 'Increase text size' }).click()
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('reader-settings.png') })
  await page.getByRole('button', { name: 'Close reading settings' }).click()
  await expect(page.locator('.chapter-body')).toHaveCSS('font-size', '20px')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('.chapter-body')).toHaveCSS('font-size', '20px')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'Find in chapter', exact: true }).click()
  await page.getByRole('textbox', { name: 'Find in chapter', exact: true }).fill('Alice')
  await expect(page.locator('mark').first()).toBeVisible()
  await page.getByRole('button', { name: 'Next match', exact: true }).click()
  await expect(page.locator('.reader-find')).toContainText('2 /')
  await page.getByRole('button', { name: 'Close search', exact: true }).click()
  await expect(page.locator('mark')).toHaveCount(0)

  await page.locator('.reader-location').click()
  await page.locator('.toc-entry').last().click()
  await expect(page).toHaveURL(/\/read\/[^/]+\/11$/)
  await expect(page.getByLabel('Next chapter', { exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Finish book', exact: true }).click()
  await expect(page.locator('.overview-progress')).toContainText('100% complete')
  await page.reload()
  await expect(page.locator('.overview-progress')).toContainText('100% complete')
  await page.getByRole('link', { name: 'Back to library', exact: true }).click()
  await page.getByRole('button', { name: 'Table view', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(3)
  await expectNoOverflow(page)
  await page.getByRole('textbox', { name: 'Search library', exact: true }).fill('Wells')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody')).toContainText('The Time Machine')
  expect(failures).toEqual([])
})

test('imports a chaptered file, handles duplicates, edits metadata and deletes it', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(3, { timeout: 45_000 })
  await page.getByRole('button', { name: 'Import book', exact: true }).click()
  await page
    .getByLabel('Import EPUB or text files')
    .setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.from('') })
  await expect(page.getByRole('alert')).toContainText('empty')
  const text = Array.from(
    { length: 105 },
    (_, index) =>
      `CHAPTER ${index + 1}. A quiet morning ${index + 1}\n\nThe library was quiet that morning. A reader opened a book and found the place they had saved. This is section ${index + 1}.`,
  ).join('\n\n')
  const file = { name: 'A quiet morning.txt', mimeType: 'text/plain', buffer: Buffer.from(text) }
  await page.getByLabel('Import EPUB or text files').setInputFiles(file)
  await expect(page.getByRole('dialog', { name: 'Import a book', exact: true })).not.toBeVisible({
    timeout: 45_000,
  })
  await expect(page.locator('.book-tile')).toHaveCount(4)
  await page.getByRole('button', { name: 'Import book', exact: true }).click()
  await page.getByLabel('Import EPUB or text files').setInputFiles(file)
  await expect(page.getByRole('dialog', { name: 'Import a book', exact: true })).not.toBeVisible({
    timeout: 45_000,
  })
  await expect(page.locator('.book-tile')).toHaveCount(4)
  await page.locator('.tile-title').filter({ hasText: 'A quiet morning' }).click()
  await expect(page.locator('.chapter-list-item')).toHaveCount(50)
  await page.getByRole('textbox', { name: 'Search table of contents' }).fill('105')
  await expect(page.locator('.chapter-list-item')).toHaveCount(1)
  await page.locator('.chapter-list-item').click()
  await expect(page.locator('.chapter-body')).toContainText('This is section 105.')
  await page.getByRole('link', { name: 'Back to book details' }).click()
  await page.getByRole('button', { name: 'Edit book details' }).click()
  await page.getByLabel('Title', { exact: true }).fill('A quieter morning')
  await page.getByLabel('Synopsis', { exact: true }).fill('A small book for a quiet morning.')
  await page.route(
    '**/rest/v1/books*',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Temporarily unavailable' }),
      }),
    { times: 1 },
  )
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('could not be saved')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A quieter morning')
  await expect(page.locator('.synopsis-text')).toContainText('A small book')
  await page.getByRole('link', { name: 'Back to library', exact: true }).click()
  await page.getByRole('button', { name: 'Table view', exact: true }).click()
  await page.getByRole('button', { name: 'Actions for A quieter morning' }).click()
  await page.screenshot({ path: testInfo.outputPath('library-table-menu.png') })
  await page.getByRole('button', { name: 'Remove book', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove book', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(3)
  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(3)
  await expectNoOverflow(page)
})
