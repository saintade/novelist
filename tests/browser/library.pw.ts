import { expect, test, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    elements: [...document.querySelectorAll('body *')]
      .filter((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.width > 0 && (bounds.right > innerWidth + 0.5 || bounds.left < -0.5)
      })
      .slice(0, 12)
      .map((element) => `${element.tagName}.${element.className}`),
  }))
  expect(overflow.width, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport)
}

async function expectFullHeightSettings(page: Page) {
  const panel = page.getByRole('dialog', { name: 'Reading settings', exact: true })
  await expect(panel).toBeVisible()
  await expect
    .poll(async () => {
      const bounds = await panel.boundingBox()
      return bounds ? { top: Math.round(bounds.y), height: Math.round(bounds.height) } : null
    })
    .toEqual({ top: 0, height: page.viewportSize()!.height })
}

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const repositoryPath = '/src/lib/library/repository.ts'
    const { getBooks, removeBook } = await import(repositoryPath)
    for (const book of await getBooks()) await removeBook(book.id)
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase, ensureSession } = await import(clientPath)
    const ownerId = await ensureSession()
    await supabase.from('glossary_entries').delete().eq('owner_id', ownerId)
    await supabase.from('style_profiles').delete().eq('owner_id', ownerId)
    await supabase.from('page_identifications').delete().eq('owner_id', ownerId)
    await supabase.from('ai_request_usage').delete().eq('owner_id', ownerId)
    await supabase.from('ai_budget_settings').delete().eq('owner_id', ownerId)
  })
})

test('translated reading resumes the latest chapter, version and position after leaving and reloading', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45000 })
  const saved = await page.evaluate(async () => {
    const clientPath = '/src/lib/supabase/client.ts'
    const sourcesPath = '/src/lib/extension/contents.ts'
    const { supabase, ensureSession } = await import(clientPath)
    const { discoverContents } = await import(sourcesPath)
    const owner = await ensureSession()
    const bookId = crypto.randomUUID().replaceAll('-', '')
    const sourceUrl = `https://reading.example.test/${bookId}`
    const book = await supabase.from('books').insert({ id: bookId, title: 'Reading progress fixture', format: 'WEB', original_path: null, file_size: 0, source_url: sourceUrl, source: 'Reading fixture', language: 'zh-Hant', import_state: 'ready' })
    if (book.error) throw new Error(book.error.message)
    const { data: source, error } = await supabase.from('novel_sources').select('id').eq('book_id', bookId).single()
    if (error) throw new Error(error.message)
    const contents = discoverContents({ url: sourceUrl, title: 'Contents', links: Array.from({ length: 130 }, (_, index) => ({ title: `Chapter ${index + 1}`, url: `${sourceUrl}/${index + 1}` })), truncated: false }, { chapterLinks: [], chapterCount: 130, indexUrl: sourceUrl })
    const inventory = await supabase.from('novel_sources').update({ contents_data: contents }).eq('id', source.id)
    if (inventory.error) throw new Error(inventory.error.message)
    const chapterUrl = `${sourceUrl}/125`
    const original = { title: 'Chapter 125', paragraphs: ['Original source chapter 125.'] }
    const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('')
    const content = JSON.stringify(original)
    const path = `${owner}/sources/${source.id}/125.json`
    const file = await supabase.storage.from('library').upload(path, new Blob([content], { type: 'application/json' }))
    if (file.error) throw new Error(file.error.message)
    const chapter = await supabase.from('source_chapters').insert({ source_id: source.id, url: chapterUrl, title: original.title, content_path: path, content_hash: await digest(content), word_count: 6 })
    if (chapter.error) throw new Error(chapter.error.message)
    const settings = await supabase.from('book_translation_settings').insert({ book_id: bookId, main_source_id: source.id, target_language: 'en' })
    if (settings.error) throw new Error(settings.error.message)
    const version = await supabase.from('book_translation_previews').insert({ book_id: bookId, kind: 'chapter', source_key: chapterUrl, target_language: 'en', result: { title: 'Translated chapter 125', paragraphs: Array.from({ length: 70 }, (_, index) => `Translated chapter 125, paragraph ${index + 1}. This original test prose provides enough text to verify a saved reading position.`), terminology: [] }, context: { source: { sourceId: source.id, hash: await digest(original.paragraphs.join('\n\n')) } }, model: 'fixture' }).select('id').single()
    if (version.error) throw new Error(version.error.message)
    const earlier = await supabase.rpc('save_source_reading_position', { target_source: source.id, chapter_url: `${sourceUrl}/122`, fraction: 0.4, observed_at: new Date(Date.now() - 20000).toISOString() })
    if (earlier.error) throw new Error(earlier.error.message)
    return { bookId, sourceId: source.id, sourceUrl, chapterUrl, versionId: version.data.id }
  })
  await page.goto(`/read-source/${saved.bookId}/${saved.sourceId}/124?translated=en&version=${saved.versionId}`)
  await expect(page.locator('.chapter-body')).toContainText('Translated chapter 125, paragraph 1.')
  const checkpoint = page.waitForResponse(response => {
    if (!response.url().endsWith('/rpc/save_source_reading_position') || response.request().method() !== 'POST') return false
    const input = response.request().postDataJSON()
    return input.language === 'en' && input.chapter_url === saved.chapterUrl && input.fraction > 0.55 && input.fraction < 0.7 && response.ok()
  })
  await page.evaluate(() => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * 0.62))
  await checkpoint
  const readingScroll = await page.evaluate(() => scrollY)
  await page.getByRole('button', { name: 'Table of contents', exact: true }).click()
  const contentsPanel = page.getByRole('dialog', { name: 'Contents', exact: true })
  await expect(contentsPanel.locator('.toc-entry[aria-current="location"]')).toContainText('125')
  await expect(contentsPanel.locator('.toc-entry[aria-current="location"]')).toBeInViewport()
  await expect(contentsPanel.locator('.pagination')).toContainText('3 / 3')
  await contentsPanel.getByRole('textbox', { name: 'Search chapters', exact: true }).fill('Chapter 2')
  await contentsPanel.getByRole('textbox', { name: 'Search chapters', exact: true }).fill('')
  await expect(contentsPanel.locator('.toc-entry[aria-current="location"]')).toBeInViewport()
  await page.getByRole('button', { name: 'Close contents', exact: true }).click()
  expect(await page.evaluate(() => scrollY)).toBe(readingScroll)
  await page.getByRole('link', { name: 'Back to book details', exact: true }).click()
  await page.reload()
  const resume = page.getByRole('link', { name: 'Continue reading', exact: true })
  await expect(page.locator('.book-overview .status-label')).toHaveCount(0)
  await expect(page.locator('.book-overview .format-tag')).toHaveCount(0)
  await expect(page.locator('.book-overview').getByRole('button', { name: 'Edit book details', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Downloads', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Downloads', exact: true })).toBeVisible()
  await page.evaluate(async saved => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    const { data: chapter } = await supabase.from('source_chapters').select('content_path,content_hash').eq('source_id', saved.sourceId).single()
    const rows = Array.from({ length: 124 }, (_, position) => ({ ...chapter, source_id: saved.sourceId, url: `${saved.sourceUrl}/${position + 1}`, title: `Chapter ${position + 1}`, word_count: 6 }))
    const result = await supabase.from('source_chapters').insert(rows)
    if (result.error) throw new Error(result.error.message)
    window.dispatchEvent(new Event('focus'))
  }, saved)
  await expect(page.getByRole('spinbutton', { name: 'From chapter', exact: true })).toHaveValue('126')
  await expect(page.getByRole('spinbutton', { name: 'To chapter', exact: true })).toHaveValue('130')
  await expect(page.locator('#book-downloads details')).toHaveCount(0)
  await expectNoOverflow(page)
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Downloads', exact: true })).toBeHidden()
  await expect(page.getByRole('link', { name: 'Open source', exact: true })).toHaveAttribute('href', saved.sourceUrl)
  await page.getByRole('button', { name: 'Actions for Reading progress fixture', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit book details', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(resume).toHaveAttribute('href', `/read-source/${saved.bookId}/${saved.sourceId}/124?translated=en&version=${saved.versionId}`)
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('novelist-position:')) localStorage.removeItem(key) })
  await resume.click()
  await expect(page.locator('.chapter-body')).toContainText('Translated chapter 125, paragraph 1.')
  await expect.poll(() => page.evaluate(() => scrollY / (document.documentElement.scrollHeight - innerHeight))).toBeGreaterThan(0.55)
  await expect(page.getByRole('button', { name: 'Translate', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.reader-footer')).not.toContainText('%')
  await expect(page.locator('.reader-footer .reader-location')).toHaveText('')
  await expect(page.locator('.reader-tools').getByRole('button', { name: 'Ask about chapter', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveCSS('scrollbar-width', 'none')
  await expect(page.locator('.reader-footer-tools').getByRole('button')).toHaveCount(1)
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  const appearance = page.getByRole('dialog', { name: 'Reading settings', exact: true })
  await appearance.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await appearance.getByRole('button', { name: 'Light', exact: true }).click()
  await page.keyboard.press('Escape')
  const immediateSave = page.waitForResponse(response => response.url().endsWith('/rpc/save_source_reading_position') && response.request().method() === 'POST' && response.request().postDataJSON().language === 'en' && response.request().postDataJSON().fraction > 0.74 && response.ok())
  await page.evaluate(() => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * 0.76))
  await page.getByRole('link', { name: 'Back to book details', exact: true }).click()
  await immediateSave
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('novelist-position:')) localStorage.removeItem(key) })
  await page.getByRole('link', { name: 'Continue reading', exact: true }).click()
  await expect.poll(() => page.evaluate(() => scrollY / (document.documentElement.scrollHeight - innerHeight))).toBeGreaterThan(0.74)
  const positions = await page.evaluate(async saved => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    return { original: (await supabase.from('source_reading_progress').select('chapter_url').eq('source_id', saved.sourceId).single()).data, latest: (await supabase.from('reading_progress').select('chapter,target_language,translation_version').eq('book_id', saved.bookId).single()).data }
  }, saved)
  expect(positions.original.chapter_url).toBe(`${saved.sourceUrl}/122`)
  expect(positions.latest).toMatchObject({ chapter: 124, target_language: 'en', translation_version: saved.versionId })
  const originalSaved = page.waitForResponse(response => response.url().endsWith('/rpc/save_source_reading_position') && response.request().method() === 'POST' && response.request().postDataJSON().language === null && response.ok())
  await page.getByRole('button', { name: 'Original', exact: true }).click()
  await originalSaved
  await page.getByRole('link', { name: 'Back to book details', exact: true }).click()
  await expect(resume).toHaveAttribute('href', `/read-source/${saved.bookId}/${saved.sourceId}/124`)
  await page.goto('/')
  await expect(page.locator('.reading-shelf').getByRole('link', { name: /Continue/ })).toHaveAttribute('href', `/read-source/${saved.bookId}/${saved.sourceId}/124`)
  await page.goto(`/books/${saved.bookId}/translation`)
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('combobox', { name: 'Target language', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Source chapter', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Preview translation context', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open book', exact: true })).toHaveAttribute('href', `/books/${saved.bookId}`)
  await page.getByRole('combobox', { name: 'Translation model', exact: true }).selectOption('gpt-4.1-mini')
  await page.getByRole('combobox', { name: 'Chat model', exact: true }).selectOption('gpt-4.1-nano')
  const savedModels = page.waitForResponse(response => response.url().endsWith('/rpc/set_reader_models') && response.ok())
  await page.getByRole('button', { name: 'Save models', exact: true }).click()
  await savedModels
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Translation model', exact: true })).toHaveValue('gpt-4.1-mini')
  await expect(page.getByRole('combobox', { name: 'Chat model', exact: true })).toHaveValue('gpt-4.1-nano')
  await expect(page.locator('.chapter-matches')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Previews and drafts', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Metadata source', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Preview source metadata', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Style Guide', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Current guide', exact: true })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Allow automatic billable guide updates', exact: true })).not.toBeChecked()
  await page.getByRole('spinbutton', { name: 'Recent translated chapters', exact: true }).fill('4')
  await page.getByRole('spinbutton', { name: 'Total context budget', exact: true }).fill('64000')
  await page.getByRole('textbox', { name: 'Guide request', exact: true }).fill('Preserve dialogue paragraph breaks.')
  await page.getByRole('button', { name: 'Save guide preferences', exact: true }).click()
  await expect.poll(() => page.evaluate(async bookId => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    return (await supabase.from('book_translation_settings').select('recent_chapters,context_tokens,guide_feedback').eq('book_id', bookId).single()).data
  }, saved.bookId)).toMatchObject({ recent_chapters: 4, context_tokens: 64000, guide_feedback: 'Preserve dialogue paragraph breaks.' })
  await page.reload()
  await expect(page.getByRole('spinbutton', { name: 'Recent translated chapters', exact: true })).toHaveValue('4')
  await page.route('**/api/ai/reading-guide', route => route.fulfill({ json: {
    profileId: 'new-guide', covered: 2, total: 2, remaining: 0, updated: false, instructions: 'Use natural dialogue.\n\nPreserve profile field breaks.', history: [
      { id: 'new-guide', instructions: 'Use natural dialogue.\n\nPreserve profile field breaks.', createdAt: '2026-09-11T12:00:00Z', feedback: 'Preserve paragraph breaks.' },
      { id: 'old-guide', instructions: 'Use formal dialogue.\n\nKeep sentences short.', createdAt: '2026-09-10T12:00:00Z', feedback: '' },
    ],
  } }))
  await page.reload()
  await page.getByRole('button', { name: 'Before / after', exact: true }).click()
  await expect(page.getByLabel('Before guide', { exact: true })).toContainText('formal dialogue')
  await expect(page.getByLabel('After guide', { exact: true })).toContainText('natural dialogue')
  await expect(page.locator('.guide-comparison del').first()).toBeVisible()
  await expect(page.locator('.guide-comparison ins').first()).toBeVisible()
  await expectNoOverflow(page)
})

test('direct download ranges run concurrently and can continue past a blocked chapter', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45000 })
  const fixture = await page.evaluate(async () => {
    const clientPath = '/src/lib/supabase/client.ts'
    const contentsPath = '/src/lib/extension/contents.ts'
    const { supabase, ensureSession } = await import(clientPath)
    const { discoverContents } = await import(contentsPath)
    const owner = await ensureSession()
    const bookId = crypto.randomUUID().replaceAll('-', '')
    const sourceUrl = `https://parallel-app.example.test/${bookId}`
    const book = await supabase.from('books').insert({ id: bookId, title: 'Parallel app downloads', format: 'WEB', source_url: sourceUrl, language: 'en', file_size: 0, import_state: 'ready' })
    if (book.error) throw new Error(book.error.message)
    const source = await supabase.from('novel_sources').select('id').eq('book_id', bookId).single()
    if (source.error) throw new Error(source.error.message)
    const contents = discoverContents({ url: sourceUrl, title: 'Contents', truncated: false, links: [1, 2, 3, 4].map(number => ({ title: `Chapter ${number}`, url: `${sourceUrl}/${number}` })) }, { chapterLinks: [], chapterCount: 4, indexUrl: sourceUrl })
    const saved = await supabase.from('novel_sources').update({ contents_data: contents }).eq('id', source.data.id)
    if (saved.error) throw new Error(saved.error.message)
    return { bookId, sourceId: source.data.id, owner }
  })
  let release!: () => void
  const firstWave = new Promise<void>(resolve => { release = resolve })
  const requests: string[] = []
  await page.route('**/api/ai/source-chapter', async route => {
    const input = route.request().postDataJSON()
    requests.push(input.url)
    if (requests.length === 3) release()
    await firstWave
    if (input.url.endsWith('/1')) {
      await route.fulfill({ json: { state: 'needs_browser', message: 'Manual browser access required for chapter one.' } })
      return
    }
    const result = await page.evaluate(async ({ input, fixture }) => {
      const clientPath = '/src/lib/supabase/client.ts'
      const { supabase } = await import(clientPath)
      const chapter = { title: 'Chapter', paragraphs: [`Original ${input.url}.`] }
      const serialized = JSON.stringify(chapter)
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))].map(value => value.toString(16).padStart(2, '0')).join('')
      const path = `${fixture.owner}/sources/${fixture.sourceId}/${hash}.json`
      const upload = await supabase.storage.from('library').upload(path, new Blob([serialized], { type: 'application/json' }))
      if (upload.error) throw new Error(upload.error.message)
      const record = await supabase.from('source_chapters').insert({ source_id: fixture.sourceId, url: input.url, title: chapter.title, content_path: path, content_hash: hash, word_count: 2 }).select('*').single()
      if (record.error) throw new Error(record.error.message)
      return { state: 'ready', cached: false, chapter, record: record.data }
    }, { input, fixture })
    await route.fulfill({ json: result })
  })
  try {
    await page.goto(`/books/${fixture.bookId}?tab=downloads`)
    const downloads = page.getByRole('region', { name: 'Chapter downloads', exact: true })
    await expect(downloads.getByLabel('Concurrent downloads', { exact: true })).toHaveValue('3')
    await downloads.getByRole('button', { name: 'Download all', exact: true }).click()
    await expect(downloads.getByRole('alert')).toContainText('Manual browser access required')
    expect(requests).toHaveLength(3)
    await expect(downloads.locator('.download-summary')).toContainText('2 / 4 chapters saved')
    await expect(downloads.getByRole('button', { name: 'Retry direct download', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('concurrent-download-recovery.png'), fullPage: true })
    await downloads.getByRole('button', { name: 'Skip chapter & continue', exact: true }).click()
    await expect(downloads.locator('.download-summary')).toContainText('3 / 4 chapters saved')
    await expect(downloads.getByRole('status')).toContainText('skipped chapters remain unsaved')
    expect(requests).toHaveLength(4)
    await expectNoOverflow(page)
  } finally { release() }
})

test('admin usage shows quota failures, monthly alerts and one cost per grouped request', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45000 })
  await page.evaluate(async () => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    const usage = await supabase.from('ai_request_usage').insert([
      { operation: 'translation_group', model: 'gpt-5.6-luna', group_size: 10, state: 'completed', input_tokens: 1000, output_tokens: 2000, estimated_usd: 6, created_at: new Date(Date.now() - 1000).toISOString() },
      { operation: 'translation', model: 'gpt-5.6-luna', state: 'failed', error_code: 'quota' },
    ], { defaultToNull: false })
    if (usage.error) throw new Error(usage.error.message)
  })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('link', { name: 'Admin & usage', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Admin & usage', exact: true })).toBeVisible()
  await expect(page.getByText('Provider quota or billing limit reached', { exact: true })).toBeVisible()
  await expect(page.locator('.admin-metrics')).toContainText('$6.00')
  await expect(page.locator('.admin-metrics')).toContainText('Provider requests2')
  await page.getByLabel('Monthly alert budget (USD)', { exact: true }).fill('5')
  await page.getByRole('button', { name: 'Save alert', exact: true }).click()
  await expect(page.getByText('Monthly alert budget reached', { exact: true })).toBeVisible()
  await expect(page.getByText('Spending alert saved.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Monthly alert budget (USD)', { exact: true })).toHaveValue('5')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('admin-usage.png'), fullPage: true })
  await page.route('**/api/ai/admin', async route => {
    const input = route.request().postDataJSON()
    if (input.action === 'overview' && input.month === '2001-01') {
      await route.fulfill({ status: 503, json: { error: 'Usage for this month is temporarily unavailable.' } })
    } else await route.fallback()
  })
  await page.getByLabel('Month (UTC)', { exact: true }).fill('2001-01')
  await expect(page.getByText('Usage for this month is temporarily unavailable.', { exact: true })).toBeVisible()
  await expect(page.locator('.admin-metrics')).toHaveCount(0)
})

test('a completed translation never pulls the reader away from another book', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45000 })
  const fixture = await page.evaluate(async () => {
    const clientPath = '/src/lib/supabase/client.ts'
    const libraryPath = '/src/lib/library/repository.ts'
    const contentsPath = '/src/lib/extension/contents.ts'
    const { supabase, ensureSession } = await import(clientPath)
    const { getBooks } = await import(libraryPath)
    const { discoverContents } = await import(contentsPath)
    const owner = await ensureSession()
    const otherId = (await getBooks()).find(book => book.format === 'EPUB').id
    const bookId = crypto.randomUUID().replaceAll('-', '')
    const sourceUrl = `https://background.example.test/${bookId}`
    const chapterUrl = `${sourceUrl}/1`
    const inserted = await supabase.from('books').insert({ id: bookId, title: 'Background translation fixture', format: 'WEB', file_size: 0, source_url: sourceUrl, language: 'zh', import_state: 'ready' })
    if (inserted.error) throw new Error(inserted.error.message)
    const { data: source, error } = await supabase.from('novel_sources').select('id').eq('book_id', bookId).single()
    if (error) throw new Error(error.message)
    const contents = discoverContents({ url: sourceUrl, title: 'Contents', links: [{ title: 'Chapter 1', url: chapterUrl }], truncated: false }, { chapterLinks: [], chapterCount: 1, indexUrl: sourceUrl })
    const inventory = await supabase.from('novel_sources').update({ contents_data: contents }).eq('id', source.id)
    if (inventory.error) throw new Error(inventory.error.message)
    const original = { title: 'Chapter 1', paragraphs: ['Original background chapter. '.repeat(80)] }
    const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('')
    const content = JSON.stringify(original)
    const path = `${owner}/sources/${source.id}/1.json.gz`
    const compressed = await new Response(new Blob([content]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
    const upload = await supabase.storage.from('library').upload(path, new Blob([compressed], { type: 'application/gzip' }))
    if (upload.error) throw new Error(upload.error.message)
    const chapter = await supabase.from('source_chapters').insert({ source_id: source.id, url: chapterUrl, title: original.title, content_path: path, content_hash: await digest(content), word_count: 3 })
    if (chapter.error) throw new Error(chapter.error.message)
    const settings = await supabase.from('book_translation_settings').insert({ book_id: bookId, main_source_id: source.id, target_language: 'en' })
    if (settings.error) throw new Error(settings.error.message)
    return { bookId, otherId, sourceId: source.id, chapterUrl, sourceHash: await digest(original.paragraphs.join('\n\n')), ownerId: owner, contentHash: await digest(content) }
  })
  let submissions = 0
  let resumes = 0
  let batchId = ''
  await page.route('**/api/ai/book-translation', async route => {
    const input = route.request().postDataJSON()
    if (input.action !== 'translate') { await route.fallback(); return }
    expect(input.background).toBe(true)
    submissions += 1
    batchId = input.requestId
    const job = await page.evaluate(async ({ input, fixture }) => {
      const clientPath = '/src/lib/supabase/client.ts'
      const { supabase } = await import(clientPath)
      const created = await supabase.rpc('create_reader_translation_batch', { request_id: input.requestId, target_book: fixture.bookId, chapter_position: 1, expected_revision: input.expectedRevision, chosen_model: 'fixture', cost_estimate: {}, new_version: false })
      if (created.error) throw new Error(created.error.message)
      const worker = crypto.randomUUID()
      const claimed = await supabase.rpc('claim_translation_batch', { target_batch: input.requestId, worker_key: worker })
      if (claimed.error) throw new Error(claimed.error.message)
      const chapter = await supabase.rpc('claim_translation_batch_chapter', { target_batch: input.requestId, worker_key: worker })
      if (chapter.error) throw new Error(chapter.error.message)
      return { batch: (await supabase.from('translation_batches').select('*').eq('id', input.requestId).single()).data, chapters: chapter.data }
    }, { input, fixture })
    await route.fulfill({ status: 202, json: { job } })
  })
  await page.route('**/api/ai/translation-batch', async route => {
    const input = route.request().postDataJSON()
    if (input.action !== 'resume') { await route.fallback(); return }
    expect(input.batchId).toBe(batchId)
    expect(input.confirmed && input.retryFailed).toBe(true)
    resumes += 1
    await page.evaluate(async batchId => {
      const clientPath = '/src/lib/supabase/client.ts'
      const { supabase } = await import(clientPath)
      const worker = crypto.randomUUID()
      const claim = await supabase.rpc('claim_translation_batch', { target_batch: batchId, worker_key: worker, retry_failed: true })
      if (claim.error) throw new Error(claim.error.message)
      const chapter = await supabase.rpc('claim_translation_batch_chapter', { target_batch: batchId, worker_key: worker })
      if (chapter.error) throw new Error(chapter.error.message)
    }, batchId)
    await route.fulfill({ json: {} })
  })
  const staleKey = `novelist-translation-job:${JSON.stringify([fixture.ownerId, fixture.bookId, fixture.sourceId, fixture.chapterUrl, fixture.contentHash])}`
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ id: crypto.randomUUID(), language: 'en' })), staleKey)
  await page.goto(`/read-source/${fixture.bookId}/${fixture.sourceId}/0`)
  await expect(page.getByText('Translation batch not found in this book.', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), staleKey)).toBeNull()
  await page.getByRole('button', { name: 'Translate', exact: true }).click()
  await expect(page.getByText('Translation queued. You can keep reading.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Translate', exact: true })).toBeDisabled()
  await expect(page.locator('.chapter-body')).toContainText('Original background chapter.')
  await page.evaluate(async batchId => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    const batch = await supabase.from('translation_batches').select('worker_id').eq('id', batchId).single()
    const failed = await supabase.rpc('fail_translation_batch', { target_batch: batchId, worker_key: batch.data.worker_id, failure_message: 'Fixture interrupted before completion.' })
    if (failed.error) throw new Error(failed.error.message)
  }, batchId)
  await page.reload()
  const recovery = page.getByRole('dialog', { name: 'Resume chapter translation', exact: true })
  await expect(recovery.getByRole('button', { name: 'Resume translation', exact: true })).toBeDisabled()
  await recovery.getByRole('checkbox').check()
  await recovery.getByRole('button', { name: 'Resume translation', exact: true }).click()
  await expect(recovery).toBeHidden()
  await page.getByRole('link', { name: 'Back to book details', exact: true }).click()
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await page.locator(`a[href="/books/${fixture.otherId}"]`).first().click()
  await page.evaluate(async ({ fixture, batchId }) => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    const translation = { title: 'Translated chapter 1', paragraphs: ['Background translation is ready.'], terminology: [] }
    const saved = await supabase.from('book_translation_previews').insert({ book_id: fixture.bookId, kind: 'chapter', source_key: fixture.chapterUrl, target_language: 'en', result: translation, context: { source: { sourceId: fixture.sourceId, hash: fixture.sourceHash } } }).select('id').single()
    if (saved.error) throw new Error(saved.error.message)
    const chapter = await supabase.from('translation_batch_chapters').update({ state: 'completed', preview_id: saved.data.id }).eq('batch_id', batchId)
    if (chapter.error) throw new Error(chapter.error.message)
    const batch = await supabase.from('translation_batches').update({ state: 'completed', worker_id: null, lease_expires_at: null }).eq('id', batchId)
    if (batch.error) throw new Error(batch.error.message)
  }, { fixture, batchId })
  await expect(page).toHaveURL(new RegExp(`/books/${fixture.otherId}$`))
  await page.reload()
  await expect(page).toHaveURL(new RegExp(`/books/${fixture.otherId}$`))
  await page.goto(`/read-source/${fixture.bookId}/${fixture.sourceId}/0`)
  await expect(page.locator('.chapter-body')).toContainText('Background translation is ready.')
  await expect(page).toHaveURL(/translated=en&version=/)
  expect(submissions).toBe(1)
  expect(resumes).toBe(1)
})

test('bulk translation confirms costs, skips saved chapters and resumes a persistent queue with averages', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45000 })
  const fixture = await page.evaluate(async () => {
    const clientPath = '/src/lib/supabase/client.ts'
    const contentsPath = '/src/lib/extension/contents.ts'
    const { supabase, ensureSession } = await import(clientPath)
    const { discoverContents } = await import(contentsPath)
    const owner = await ensureSession()
    const bookId = crypto.randomUUID().replaceAll('-', '')
    const sourceUrl = `https://bulk.example.test/${bookId}`
    const inserted = await supabase.from('books').insert({ id: bookId, title: 'Bulk translation fixture', format: 'WEB', original_path: null, file_size: 0, source_url: sourceUrl, language: 'zh', import_state: 'ready' })
    if (inserted.error) throw new Error(inserted.error.message)
    const { data: source, error } = await supabase.from('novel_sources').select('id').eq('book_id', bookId).single()
    if (error) throw new Error(error.message)
    const contents = discoverContents({ url: sourceUrl, title: 'Contents', truncated: false, links: [1, 2, 3, 4].map(number => ({ title: `Chapter ${number}`, url: `${sourceUrl}/${number}` })) }, { chapterCount: 4, chapterLinks: [], indexUrl: sourceUrl })
    const updated = await supabase.from('novel_sources').update({ contents_data: contents }).eq('id', source.id)
    if (updated.error) throw new Error(updated.error.message)
    const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('')
    const hashes: string[] = []
    for (const number of [1, 2, 3]) {
      const text = `Original chapter ${number}.`
      hashes.push(await digest(text))
      const json = JSON.stringify({ title: `Chapter ${number}`, paragraphs: [text] })
      const path = `${owner}/sources/${source.id}/${number}.json`
      const uploaded = await supabase.storage.from('library').upload(path, new Blob([json], { type: 'application/json' }))
      if (uploaded.error) throw new Error(uploaded.error.message)
      const saved = await supabase.from('source_chapters').insert({ source_id: source.id, url: `${sourceUrl}/${number}`, title: `Chapter ${number}`, content_path: path, content_hash: await digest(json), word_count: 4 })
      if (saved.error) throw new Error(saved.error.message)
    }
    const preferences = await supabase.from('book_translation_settings').insert({ book_id: bookId, main_source_id: source.id, target_language: 'en', translation_model: 'gpt-4.1-mini' })
    if (preferences.error) throw new Error(preferences.error.message)
    const existing = await supabase.from('book_translation_previews').insert({ book_id: bookId, kind: 'chapter', source_key: `${sourceUrl}/1`, target_language: 'en', model: 'gpt-4.1-mini', input_tokens: 1000, output_tokens: 200, result: { title: 'Chapter 1', paragraphs: ['Existing first translation.'], terminology: [] }, context: { targetLanguage: 'en', source: { key: `${sourceUrl}/1`, sourceId: source.id, language: 'zh', text: 'Original chapter 1.', hash: hashes[0] }, timings: { preparationMs: 100, guideMs: 0, modelMs: 1900 } } }).select('*').single()
    if (existing.error) throw new Error(existing.error.message)
    const manual = await supabase.from('book_translation_previews').insert({ book_id: bookId, kind: 'chapter', source_key: `${sourceUrl}/1`, target_language: 'en', model: 'manual edit', result: existing.data.result, context: { ...existing.data.context, manualEdit: { parentVersion: existing.data.id } } }).select('id').single()
    if (manual.error) throw new Error(manual.error.message)
    return { bookId, sourceId: source.id, sourceUrl, hashes, previewId: manual.data.id, workerId: crypto.randomUUID() }
  })
  let starts = 0
  let resumes = 0
  await page.route('**/api/ai/translation-batch', async route => {
    const input = route.request().postDataJSON()
    if (!['start', 'pause', 'resume'].includes(input.action)) { await route.fallback(); return }
    if (input.action === 'start') { expect(input.confirmed).toBe(true); expect(input.chaptersPerRequest).toBe(3); starts++ }
    if (input.action === 'resume') { expect(input.confirmed).toBe(true); resumes++ }
    const response = await page.evaluate(async ({ input, fixture, resumes }) => {
      const clientPath = '/src/lib/supabase/client.ts'
      const { supabase } = await import(clientPath)
      const batchId = input.batchId || input.requestId
      const rpc = async (name: string, parameters: unknown) => { const result = await supabase.rpc(name, parameters); if (result.error) throw new Error(result.error.message); return result.data }
      const claim = () => rpc('claim_translation_batch_chapter', { target_batch: batchId, worker_key: fixture.workerId })
      const complete = async (position: number) => {
        const guideMs = position === 1 ? 200 : 0
        const { data: stored } = await supabase.from('source_chapters').select('content_hash').eq('source_id', fixture.sourceId).eq('url', `${fixture.sourceUrl}/${position + 1}`).single()
        return rpc('complete_batch_translation', { target_batch: batchId, chapter_position: position, worker_key: fixture.workerId, consumed_input: 1000, consumed_output: 200, draft: { title: `Chapter ${position + 1}`, paragraphs: [`Bulk translated chapter ${position + 1}.`], terminology: [] }, snapshot: { targetLanguage: 'en', source: { key: `${fixture.sourceUrl}/${position + 1}`, sourceId: fixture.sourceId, language: 'zh', text: `Original chapter ${position + 1}.`, hash: fixture.hashes[position], storageHash: stored.content_hash }, timings: { preparationMs: 100, guideMs, modelMs: (position + 2) * 1000 - 100 - guideMs } } })
      }
      if (input.action === 'start') {
        await rpc('create_grouped_translation_batch', { request_id: batchId, target_book: fixture.bookId, range_start: input.from, range_end: input.to, expected_revision: input.expectedRevision, chosen_model: 'gpt-4.1-mini', cost_estimate: {}, maximum_group_size: input.chaptersPerRequest })
        await rpc('claim_translation_batch', { target_batch: batchId, worker_key: fixture.workerId })
        await claim()
        await rpc('skip_batch_translation', { target_batch: batchId, chapter_position: 0, worker_key: fixture.workerId, saved_preview: fixture.previewId })
        await claim()
      } else if (input.action === 'pause') {
        await rpc('control_translation_batch', { target_batch: batchId, command: 'pause' })
        await complete(1)
        await claim()
      } else {
        await rpc('claim_translation_batch', { target_batch: batchId, worker_key: fixture.workerId, retry_failed: input.retryFailed })
        await claim()
        if (resumes === 1) await rpc('fail_translation_batch', { target_batch: batchId, worker_key: fixture.workerId, failure_message: 'Fixture provider timeout. Review before retrying.' })
        else { await complete(2); await claim() }
      }
      const batch = await supabase.from('translation_batches').select('*').eq('id', batchId).single()
      const chapters = await supabase.from('translation_batch_chapters').select('*').eq('batch_id', batchId).order('position')
      return { status: { batch: batch.data, chapters: chapters.data } }
    }, { input, fixture, resumes })
    await route.fulfill({ json: response })
  })
  await page.goto(`/books/${fixture.bookId}?tab=translate`)
  const panel = page.getByRole('region', { name: 'Bulk translation', exact: true })
  await expect(panel.getByRole('spinbutton', { name: 'Chapters per request (maximum)', exact: true })).toHaveValue('10')
  await panel.getByRole('spinbutton', { name: 'Chapters per request (maximum)', exact: true }).fill('3')
  await expect(panel.getByRole('spinbutton', { name: 'From chapter', exact: true })).toHaveValue('2')
  await panel.getByRole('spinbutton', { name: 'From chapter', exact: true }).fill('1')
  await panel.getByRole('spinbutton', { name: 'To chapter', exact: true }).fill('4')
  await panel.getByRole('button', { name: 'Review translation range', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Translate chapter range', exact: true })
  await expect(review).toContainText('1 chapter needs downloading first')
  await expect(review.getByRole('button', { name: 'Start translations', exact: true })).toBeDisabled()
  expect(starts).toBe(0)
  await review.getByRole('button', { name: 'Back', exact: true }).click()
  await panel.getByRole('spinbutton', { name: 'To chapter', exact: true }).fill('3')
  await panel.getByRole('button', { name: 'Translate untranslated', exact: true }).click()
  const wholeBook = page.getByRole('dialog', { name: 'Translate untranslated chapters', exact: true })
  await expect(wholeBook).toContainText('Chapters 1-4 / 3 chapters')
  await expect(wholeBook).toContainText('3 downloaded chapters selected. 1 undownloaded chapter excluded.')
  await expect(wholeBook.getByRole('button', { name: 'Start translations', exact: true })).toBeDisabled()
  await wholeBook.getByRole('checkbox').check()
  await expect(wholeBook.getByRole('button', { name: 'Start translations', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('downloaded-only-translation.png'), fullPage: true })
  expect(starts).toBe(0)
  await wholeBook.getByRole('button', { name: 'Back', exact: true }).click()
  await panel.getByRole('button', { name: 'Review translation range', exact: true }).click()
  await expect(review).toContainText('Normal API pricing')
  await expect(review).toContainText('Up to 3 / adaptive')
  await expect(review).toContainText('32,768 tokens')
  await expect(review).toContainText('1 chapter has a saved version')
  await expect(review.locator('.check-label')).toHaveCSS('flex-direction', 'row')
  await expect(review.getByRole('button', { name: 'Start translations', exact: true })).toBeDisabled()
  await review.getByRole('checkbox').check()
  await expectNoOverflow(page)
  await page.screenshot({ path: testInfo.outputPath('bulk-translation-review.png') })
  await review.getByRole('button', { name: 'Start translations', exact: true }).click()
  const queue = page.getByRole('region', { name: 'Translation queue', exact: true })
  await expect(queue).toContainText('up to 3 chapters per request')
  await expect(queue).toContainText('1 already saved')
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await page.getByRole('tab', { name: 'Translate', exact: true }).click()
  await queue.getByRole('button', { name: 'Pause translations', exact: true }).click()
  await expect(queue.locator('.queue-state')).toHaveText('Paused')
  await page.reload()
  await expect(queue.locator('.queue-state')).toHaveText('Paused')
  expect(starts).toBe(1)
  await queue.getByRole('button', { name: 'Resume translations', exact: true }).click()
  const resume = page.getByRole('dialog', { name: 'Resume translation queue', exact: true })
  await resume.getByRole('checkbox', { name: /Authorize the remaining/ }).check()
  await resume.getByRole('button', { name: 'Resume queue', exact: true }).click()
  await expect(queue.getByRole('alert').first()).toContainText('Fixture provider timeout')
  await queue.getByRole('button', { name: 'Resume translations', exact: true }).click()
  await resume.getByRole('checkbox', { name: /Authorize the remaining/ }).check()
  await expect(resume.getByRole('button', { name: 'Resume queue', exact: true })).toBeDisabled()
  await resume.getByRole('checkbox', { name: /Retry failed or interrupted/ }).check()
  await resume.getByRole('button', { name: 'Resume queue', exact: true }).click()
  await expect(queue.locator('.queue-state')).toHaveText('Completed')
  await expect(queue).toContainText('2 translated')
  await expect(queue.getByRole('link', { name: 'Read', exact: true })).toHaveCount(3)
  await expect(panel.locator('.translation-range-summary')).toContainText('3 with saved translations')
  await expect(panel.getByRole('spinbutton', { name: 'From chapter', exact: true })).toHaveValue('4')
  expect(resumes).toBe(2)
  await expectNoOverflow(page)
  await page.screenshot({ path: testInfo.outputPath('bulk-translation-completed.png'), fullPage: true })
  await page.evaluate(async sourceId => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    const { data: source } = await supabase.from('novel_sources').select('contents_data').eq('id', sourceId).single()
    const chapters = source.contents_data.chapters
    const changed = await supabase.from('novel_sources').update({ contents_data: { ...source.contents_data, chapters: [chapters[1], chapters[0], ...chapters.slice(2)] } }).eq('id', sourceId)
    if (changed.error) throw new Error(changed.error.message)
    window.dispatchEvent(new Event('focus'))
  }, fixture.sourceId)
  await expect(queue.getByRole('link', { name: 'Read', exact: true }).first()).toHaveAttribute('href', `/read-source/${fixture.bookId}/${fixture.sourceId}/1?translated=en&version=${fixture.previewId}`)
  await page.goto(`/books/${fixture.bookId}/translation?tab=settings`)
  const models = page.getByRole('region', { name: 'Reader models', exact: true })
  await expect(models).toContainText('3 measured translations')
  await expect(models).toContainText('3.0s average per chapter')
  await expect(models.locator('.translation-timings > li')).toHaveCount(1)
})

test('glossary searches every page, alias, note and evidence field', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45000 })
  const bookId = await page.evaluate(async () => {
    const libraryPath = '/src/lib/library/repository.ts'
    const translationPath = '/src/lib/translation/repository.ts'
    const clientPath = '/src/lib/supabase/client.ts'
    const { getBooks } = await import(libraryPath)
    const { saveGlossaryEntry } = await import(translationPath)
    const { supabase } = await import(clientPath)
    const book = (await getBooks()).find((book: { title: string }) => book.title.includes('Qinglan'))!
    await Promise.all(Array.from({ length: 52 }, (_, position) => saveGlossaryEntry(book, { sourceTerm: `Pagination ${String(position).padStart(3, '0')}`, targetTerm: `Preferred term ${position}`, targetLanguage: 'en', scope: 'novel', category: 'technique', chapter: 0, sense: position === 49 ? 'Off-page meaning' : '', notes: position === 50 ? 'Off-page note' : '', aliases: position === 51 ? ['Off-page alias'] : [] })))
    const evidence = await supabase.from('glossary_entries').update({ evidence: 'Off-page evidence' }).eq('novel_id', book.novelId).eq('source_term', 'Pagination 051')
    if (evidence.error) throw new Error(evidence.error.message)
    return book.id
  })
  await page.goto(`/books/${bookId}/translation?tab=glossary`)
  const search = page.getByRole('textbox', { name: 'Search glossary', exact: true })
  await search.fill('Pagination')
  await expect(page.locator('.glossary-row')).toHaveCount(25)
  await page.getByRole('button', { name: 'Next glossary page', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Glossary pages', exact: true })).toContainText('2 / 3')
  await page.getByRole('button', { name: 'Next glossary page', exact: true }).click()
  await expect(page.locator('.glossary-row')).toHaveCount(2)
  for (const query of ['Off-page alias', 'Off-page note', 'Off-page evidence', 'Off-page meaning']) {
    await search.fill(query)
    await expect(page.locator('.glossary-row')).toHaveCount(1)
  }
  await search.fill('Pagination')
  await expect(page.getByRole('navigation', { name: 'Glossary pages', exact: true })).toContainText('1 / 3')
  await expectNoOverflow(page)
})

test('glossary source selection shows language pairs and reuses only the chosen translation language', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45000 })
  const fixture = await page.evaluate(async () => {
    const repositoryPath = '/src/lib/library/repository.ts'
    const booksPath = '/src/lib/books.ts'
    const translationPath = '/src/lib/translation/repository.ts'
    const { getBooks, saveBook } = await import(repositoryPath)
    const { importBook } = await import(booksPath)
    const { saveGlossaryEntry, saveTranslationSettings } = await import(translationPath)
    const book = (await getBooks()).find((entry: { title: string }) => entry.title.includes('Qinglan'))!
    const reference = (await saveBook(await importBook(new File(['Chapter 1\n林遥到达渡口。'], 'Glossary reference.txt')))).book
    for (const language of ['en', 'es']) await saveGlossaryEntry({ ...reference, language: 'zh' }, { sourceTerm: '林遥', targetTerm: language === 'en' ? 'Selected English name' : 'Nombre elegido', targetLanguage: language, scope: 'novel', category: 'person', chapter: 0, sense: '', notes: '', aliases: [] })
    await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, metadataSource: null, referenceBookId: null, referenceSourceId: null, referenceMode: 'continuation' }, 0)
    return { bookId: book.id, referenceId: reference.id }
  })
  await page.goto(`/books/${fixture.bookId}/translation`)
  const sources = page.getByRole('region', { name: 'Glossary sources', exact: true })
  const english = sources.getByRole('checkbox', { name: /Glossary reference.*Chinese.*English/ })
  const spanish = sources.getByRole('checkbox', { name: /Glossary reference.*Chinese.*Spanish/ })
  await expect(english).toBeEnabled()
  await expect(spanish).toBeDisabled()
  await english.check()
  await page.getByRole('button', { name: 'Save glossary sources', exact: true }).click()
  await expect.poll(() => page.evaluate(async bookId => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    return (await supabase.from('book_translation_settings').select('glossary_sources').eq('book_id', bookId).single()).data.glossary_sources
  }, fixture.bookId)).toEqual([{ bookId: fixture.referenceId, sourceLanguage: 'zh', targetLanguage: 'en' }])
  await page.reload()
  await expect(english).toBeChecked()
  const glossary = await page.evaluate(async bookId => {
    const clientPath = '/src/lib/ai/client.ts'
    const { bookTranslationTask } = await import(clientPath)
    return (await bookTranslationTask({ bookId, sourceKey: 'local:0', action: 'context' })).context.glossary
  }, fixture.bookId)
  expect(glossary).toContainEqual({ source: '林遥', target: 'Selected English name', sense: '', aliases: [] })
  expect(JSON.stringify(glossary)).not.toContain('Nombre elegido')
  await expectNoOverflow(page)
})

test('reader chat keeps cited conversations and scroll position without sending on open', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45000 })
  await page.locator('.tile-title').filter({ hasText: "Alice's Adventures in Wonderland" }).click()
  const bookId = page.url().split('/books/')[1]
  await page.getByRole('link', { name: 'Start reading', exact: true }).click()
  await expect(page.locator('.chapter-body')).toBeVisible()
  await page.route('**/api/ai/status', route => route.fulfill({ json: { liveEnabled: true, model: 'test-only', chatModel: 'test-only' } }))
  let requests = 0
  await page.route('**/api/ai/reader-chat', async route => {
    requests++
    const input = route.request().postDataJSON()
    expect(input.confirmed).toBe(true)
    expect(input.scope).toBe('retrieval')
    const turn = await page.evaluate(async input => {
      const clientPath = '/src/lib/supabase/client.ts'
      const { supabase } = await import(clientPath)
      const result = await supabase.from('reader_chat_turns').insert({ id: input.requestId, book_id: input.bookId, source_key: input.sourceKey, chapter_position: 0, scope: input.scope, question: input.question, answer: '**Alice** is curious about what she sees.\n\nThe answer stays within the current chapter.', status: 'completed', model: 'test-only', citations: [{ sourceId: 'original', sourceKey: 'local:0', title: 'Down the Rabbit-Hole', quote: 'Alice' }] }).select('*').single()
      if (result.error) throw new Error(result.error.message)
      return result.data
    }, input)
    await route.fulfill({ json: turn })
  })
  await expect(page.locator('.reader')).toHaveAttribute('data-reading-ready', 'true')
  await page.evaluate(() => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * 0.4))
  await page.getByRole('button', { name: 'Ask about chapter', exact: true }).click()
  const chat = page.getByRole('dialog', { name: 'Reading chat', exact: true })
  await expect(chat).toBeVisible()
  await expect(chat.getByRole('button', { name: 'This chapter', exact: true })).toHaveCount(0)
  await expect(chat.getByRole('button', { name: 'Recent chapters', exact: true })).toHaveCount(0)
  await expect(chat.locator('.chat-index-status')).toContainText('1 chapter searchable')
  expect(requests).toBe(0)
  await chat.getByRole('textbox', { name: 'Ask about this chapter', exact: true }).fill('Why is Alice curious?')
  await chat.getByRole('button', { name: 'Send question', exact: true }).click()
  await expect(chat.locator('.chat-answer strong')).toHaveText('Alice')
  await expect(chat.locator('.chat-citation')).toContainText('Down the Rabbit-Hole')
  expect(requests).toBe(1)
  await expectNoOverflow(page)
  await page.screenshot({ path: testInfo.outputPath('reading-chat.png') })
  await chat.getByRole('button', { name: 'Close reading chat', exact: true }).click()
  await page.reload()
  await expect(page.locator('.chapter-body')).toBeVisible()
  await expect.poll(() => page.evaluate(() => scrollY / (document.documentElement.scrollHeight - innerHeight))).toBeGreaterThan(0.35)
  await page.getByRole('button', { name: 'Ask about chapter', exact: true }).click()
  await expect(chat.locator('.chat-answer strong')).toHaveText('Alice')
  expect(requests).toBe(1)
  await chat.getByRole('button', { name: 'Clear chapter conversation', exact: true }).click()
  await chat.getByRole('button', { name: 'Clear conversation', exact: true }).click()
  await expect(chat).toContainText('No questions yet.')
  expect((await page.evaluate(async bookId => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    return (await supabase.from('reader_chat_turns').select('id').eq('book_id', bookId)).data
  }, bookId))).toEqual([])
})

test('library folders group books, persist moves and never delete their contents', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45_000 })
  const folderFilter = page.getByRole('combobox', { name: 'Folder', exact: true })
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New folder', exact: true })
  await create.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Related editions')
  await create.getByRole('button', { name: 'Create folder', exact: true }).click()
  await expect(create).not.toBeVisible()
  const folderId = new URL(page.url()).searchParams.get('folder')!
  await expect(page.locator('.book-tile')).toHaveCount(0)
  await expect(page.locator('.reading-shelf')).toBeVisible()
  await folderFilter.selectOption('')
  for (const title of ["Alice's Adventures in Wonderland", 'The Time Machine']) {
    await page.getByRole('button', { name: `Actions for ${title}`, exact: true }).click()
    await page.getByRole('button', { name: 'Move to folder', exact: true }).click()
    const move = page.getByRole('dialog', { name: 'Move to folder', exact: true })
    await expect(
      move.getByRole('combobox', { name: 'Destination folder', exact: true }).locator('option'),
    ).toHaveCount(2)
    await move
      .getByRole('combobox', { name: 'Destination folder', exact: true })
      .selectOption(folderId)
    await move.getByRole('button', { name: 'Move book', exact: true }).click()
    await expect(move).not.toBeVisible()
  }
  await folderFilter.selectOption(folderId)
  await expect(page.locator('.book-tile')).toHaveCount(2)
  await page.getByRole('tab', { name: /^To read/ }).click()
  await expect(folderFilter).toHaveValue(folderId)
  await expect(page.locator('.book-tile')).toHaveCount(2)
  await page.getByRole('button', { name: 'Rename folder', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename folder', exact: true })
  const longName = 'Different editions and translation references in the same reading collection'
  await rename.getByRole('textbox', { name: 'Folder name', exact: true }).fill(longName)
  await rename.getByRole('button', { name: 'Rename folder', exact: true }).click()
  await expect(rename).not.toBeVisible()
  await page.reload()
  await expect(folderFilter).toHaveValue(folderId)
  await expect(folderFilter.locator('option:checked')).toContainText(longName)
  await expect(page.locator('.book-tile')).toHaveCount(2)
  await expectNoOverflow(page)
  await page.screenshot({
    path: testInfo.outputPath('library-folders.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await folderFilter.selectOption('unfiled')
  await expect(page.locator('.book-tile')).toHaveCount(2)
  await folderFilter.selectOption(folderId)
  await page.getByRole('button', { name: 'Delete folder', exact: true }).click()
  const remove = page.getByRole('dialog', { name: 'Delete folder?', exact: true })
  await expect(remove).toContainText('No books, downloads, or translations will be deleted')
  await remove.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.book-tile')).toHaveCount(2)
  await page.getByRole('button', { name: 'Delete folder', exact: true }).click()
  await remove.getByRole('button', { name: 'Delete folder', exact: true }).click()
  await expect(remove).not.toBeVisible()
  await expect(page.locator('.book-tile')).toHaveCount(4)
  await folderFilter.selectOption('unfiled')
  await expect(page.locator('.book-tile')).toHaveCount(4)
  await page.reload()
  await expect(folderFilter.locator('option')).toHaveCount(2)
  await expect(page.locator('.book-tile')).toHaveCount(4)
})

test('independent source books support reading, context translation and catalog links', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45_000 })
  const saved = await page.evaluate(async () => {
    const clientPath = '/src/lib/supabase/client.ts'
    const contentsPath = '/src/lib/extension/contents.ts'
    const { supabase } = await import(clientPath)
    const { discoverContents } = await import(contentsPath)
    const inspection = {
      classification: 'index',
      title: 'A Web Novel',
      originalTitle: null,
      author: 'Test Author',
      originalAuthor: null,
      language: 'zh',
      synopses: [{ label: 'Synopsis', text: 'A saved web novel.', originalText: null }],
      coverImage: null,
      genres: ['Fantasy'],
      tags: [],
      publicationStatus: 'Ongoing',
      chapterCount: 3,
      wordCount: 1000,
      updatedAt: null,
      additionalMetadata: [],
      reason: 'Test fixture',
      chapterLinks: [{ title: 'Chapter 3', url: 'https://books.example.test/novel/3' }],
      indexUrl: 'https://books.example.test/contents',
    }
    const record = await supabase
      .from('page_identifications')
      .insert({
        source_url: 'https://books.example.test/novel',
        source_language: 'zh',
        output_language: 'en',
        title: inspection.title,
        model: 'test-only',
        prompt_version: 'test',
        captured_html_hash: 'a'.repeat(64),
        metadata: inspection,
        raw_extraction: inspection,
      })
      .select('id')
      .single()
    if (record.error) throw record.error
    const contents = discoverContents(
      {
        url: inspection.indexUrl,
        title: 'Contents',
        links: [3, 2, 1].map((number) => ({
          title: `Chapter ${number}`,
          url: `https://books.example.test/novel/${number}`,
        })),
        truncated: false,
      },
      inspection,
    )
    const result = await supabase.rpc('add_identified_novel', {
      identification: record.data.id,
      reviewed_title:
        'A Web Novel With A Deliberately Long Title That Must Not Resize Its Library Card',
      reviewed_author: 'Test Author',
      contents_data: contents,
      reference_sources: [
        { label: 'English edition', language: 'en', url: 'https://english.example.test/contents' },
      ],
      overwrite_existing: false,
    })
    if (result.error) throw result.error
    const sources = await supabase
      .from('novel_sources')
      .select('*')
      .eq('novel_id', result.data.novelId)
    if (sources.error) throw sources.error
    const original = sources.data.find((source) => source.role === 'original')!
    const reference = sources.data.find((source) => source.role === 'reference')!
    const english = discoverContents(
      {
        url: reference.url,
        title: 'English contents',
        truncated: false,
        links: [1, 2].map((number) => ({
          title: `Chapter ${number}`,
          url: `https://english.example.test/novel/${number}`,
        })),
      },
      { chapterCount: 2, chapterLinks: [], indexUrl: null },
    )
    const updated = await supabase
      .from('novel_sources')
      .update({ contents_data: english })
      .eq('id', reference.id)
    if (updated.error) throw updated.error
    const promoted = await supabase.rpc('materialize_source_book', { target_source: reference.id })
    if (promoted.error) throw promoted.error
    window.dispatchEvent(new Event('focus'))
    return {
      ...result.data,
      sourceId: original.id,
      referenceId: reference.id,
      referenceBookId: promoted.data,
    }
  })
  await expect(page.locator('.book-tile')).toHaveCount(6)
  await expect(
    page.locator('.tile-source').filter({ hasText: 'english.example.test' }),
  ).toHaveCount(1)
  await expect(page.locator('.tile-source').filter({ hasText: 'books.example.test' })).toHaveCount(
    1,
  )
  const heights = await page
    .locator('.book-tile')
    .evaluateAll((tiles) => tiles.map((tile) => Math.round(tile.getBoundingClientRect().height)))
  expect(new Set(heights).size).toBe(1)
  await expect(page.locator('.book-tile .genre-label')).toHaveCount(0)
  expect(
    await page.locator('.book-tile .cover-fallback').evaluateAll((covers) =>
      covers.every((cover) => {
        const bounds = cover.getBoundingClientRect()
        return [...cover.children].every((child) => {
          const rect = child.getBoundingClientRect()
          return (
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom &&
            rect.left >= bounds.left &&
            rect.right <= bounds.right
          )
        })
      }),
    ),
  ).toBe(true)
  await page.screenshot({
    path: testInfo.outputPath('uniform-library.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.locator(`.tile-title[href="/books/${saved.bookId}"]`).click()
  await expect(page).toHaveURL(new RegExp(`/books/${saved.bookId}$`))
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Open source', exact: true })).toHaveAttribute(
    'href',
    'https://books.example.test/novel',
  )
  await expect(page.getByRole('link', { name: 'Start reading', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download original book' })).toHaveCount(0)
  await expect(page.getByText('0 of 3 chapters downloaded', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Reading source' })).toHaveCount(0)
  await page.goto(`/books/${saved.referenceBookId}`)
  await expect(page.locator('.chapter-list-item')).toHaveCount(2)
  await expect(page.locator('.book-source-identity')).toContainText('english.example.test')
  await page.goto(`/books/${saved.bookId}`)
  await expect(page.locator('.chapter-list-item')).toHaveCount(3)
  await expect(page.locator('.chapter-list-item').first()).toHaveAttribute(
    'href',
    `/read-source/${saved.bookId}/${saved.sourceId}/0`,
  )
  await page.evaluate(async (bookId) => {
    const clientPath = '/src/lib/supabase/client.ts'
    const contentsPath = '/src/lib/extension/contents.ts'
    const { supabase } = await import(clientPath)
    const { discoverContents } = await import(contentsPath)
    const contents = discoverContents(
      {
        url: 'https://books.example.test/contents',
        title: 'Expanded contents',
        truncated: false,
        links: [4, 3, 2, 1].map((position) => ({
          title: `Chapter ${position}`,
          url: `https://books.example.test/novel/${position}`,
        })),
      },
      { chapterCount: 3, chapterLinks: [], indexUrl: null },
    )
    const result = await supabase.rpc('save_source_contents', {
      target_book: bookId,
      source_url: 'https://books.example.test/novel',
      contents,
    })
    if (result.error) throw result.error
    window.dispatchEvent(new Event('focus'))
  }, saved.bookId)
  await expect(page.locator('.chapter-list-item')).toHaveCount(4)
  await expect(page.locator('.chapter-list-item').last()).toHaveAttribute(
    'href',
    `/read-source/${saved.bookId}/${saved.sourceId}/3`,
  )
  await expect(page.getByRole('heading', { name: /^A Web Novel With/ })).toBeVisible()
  await expectNoOverflow(page)
  await page.screenshot({
    path: testInfo.outputPath('web-novel.png'),
    fullPage: true,
    animations: 'disabled',
  })
  const storeChapter = (input: { sourceId: string; url: string }) =>
    page.evaluate(async (input) => {
      const clientPath = '/src/lib/supabase/client.ts'
      const { supabase, ensureSession } = await import(clientPath)
      const owner = await ensureSession()
      const existing = await supabase
        .from('source_chapters')
        .select('*')
        .eq('source_id', input.sourceId)
        .eq('url', input.url)
        .maybeSingle()
      const chapter = {
        title: `Chapter ${input.url.split('/').at(-1)}`,
        paragraphs: [
          input.url.includes('english')
            ? 'Qinglan Crossing. An English reference chapter.'
            : '\u9752\u5c9a\u6e21\u53e3\u3002 Original chapter text for comparison. 荒石蠱蟲。战斗局与作战局。',
        ],
      }
      if (existing.data) return { state: 'ready', record: existing.data, chapter, cached: true }
      const text = JSON.stringify(chapter)
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
      ]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
      const path = `${owner}/sources/${input.sourceId}/${crypto.randomUUID()}.json`
      const file = await supabase.storage
        .from('library')
        .upload(path, new Blob([text], { type: 'application/json' }))
      if (file.error) throw new Error(file.error.message)
      const row = await supabase
        .from('source_chapters')
        .insert({
          source_id: input.sourceId,
          url: input.url,
          title: chapter.title,
          word_count: 20,
          content_path: path,
          content_hash: hash,
          provenance: { fixture: true },
        })
        .select('*')
        .single()
      if (row.error) throw new Error(row.error.message)
      return { state: 'ready', record: row.data, chapter, cached: false }
    }, input)
  let blockedRequests = 0
  await page.route('**/api/ai/source-chapter', async (route) => {
    const input = route.request().postDataJSON()
    if (
      input.sourceId === saved.sourceId &&
      ['https://books.example.test/novel/1', 'https://books.example.test/novel/2'].includes(
        input.url,
      )
    ) {
      blockedRequests++
      await route.fulfill({
        json: {
          state: 'needs_browser',
          message:
            'This page is unavailable for a public preview (HTTP 403). Open this chapter with the connected extension to capture its rendered text.',
        },
      })
      return
    }
    await route.fulfill({ json: await storeChapter(input) })
  })
  await page.locator('.chapter-list-item').first().click()
  await expect(page).toHaveURL(new RegExp(`/read-source/${saved.bookId}/${saved.sourceId}/0$`))
  await expect(page.getByRole('alert')).toContainText('403')
  await expect(
    page.getByRole('link', { name: 'Open source in browser', exact: true }),
  ).toHaveAttribute('href', 'https://books.example.test/novel')
  await expect(
    page.getByRole('link', { name: 'Open source in browser', exact: true }),
  ).toHaveAttribute('title', /Download chapter/)
  await expect(page.getByRole('button', { name: 'Retry download', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Check saved chapter', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Chapter not saved yet')
  expect(blockedRequests).toBe(1)
  await expectNoOverflow(page)
  await page.screenshot({
    path: testInfo.outputPath('browser-download-fallback.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await storeChapter({ sourceId: saved.referenceId, url: 'https://english.example.test/novel/1' })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(
    page.getByRole('link', { name: 'Open source in browser', exact: true }),
  ).toBeVisible()
  await storeChapter({ sourceId: saved.sourceId, url: 'https://books.example.test/novel/1' })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.chapter-body')).toContainText('Original chapter text')
  expect(blockedRequests).toBe(1)
  await page.getByRole('link', { name: 'Back to book details' }).click()
  await expect(page.getByText('1 of 4 chapters downloaded', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Translation', exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Context book', exact: true })
    .selectOption(`source:${saved.referenceId}`)
  await expect(page.getByRole('combobox', { name: 'Context use', exact: true })).toHaveValue(
    'continuation',
  )
  const preferencesSaved = page.waitForResponse(response => response.url().endsWith('/rpc/set_source_translation_settings') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click()
  expect((await preferencesSaved).ok()).toBe(true)
  await expect(
    page.locator('.translation-preferences button').filter({ hasText: 'Save preferences' }),
  ).toBeDisabled()
  await page.goto(`/books/${saved.bookId}?tab=downloads`)
  await page.getByRole('button', { name: 'Download range', exact: true }).click()
  const downloads = page.getByRole('region', { name: 'Chapter downloads', exact: true })
  await expect(downloads.getByRole('alert')).toContainText('403')
  await expect(
    downloads.getByRole('link', { name: 'Open source in browser', exact: true }),
  ).toHaveAttribute('href', 'https://books.example.test/novel')
  expect(blockedRequests).toBe(2)
  await downloads.getByRole('button', { name: 'Resume downloads', exact: true }).click()
  await expect(downloads.getByRole('status')).toContainText('Chapter not saved yet')
  expect(blockedRequests).toBe(2)
  await storeChapter({ sourceId: saved.sourceId, url: 'https://books.example.test/novel/2' })
  await downloads.getByRole('button', { name: 'Resume downloads', exact: true }).click()
  await expect(page.getByText('Selected chapters downloaded.', { exact: true })).toBeVisible()
  expect(blockedRequests).toBe(2)
  await page.goto(`/books/${saved.bookId}/translation`)
  await expect(page.getByRole('combobox', { name: 'Source chapter', exact: true })).toHaveCount(0)
  await expect(page.locator('.chapter-matches')).toHaveCount(0)
  const earlierContext = await page.evaluate(async bookId => {
    const clientPath = '/src/lib/ai/client.ts'
    const { bookTranslationTask } = await import(clientPath)
    return (await bookTranslationTask({ bookId, sourceKey: 'https://books.example.test/novel/2', action: 'context' })).context
  }, saved.bookId)
  expect(earlierContext.references).toHaveLength(1)
  await page.goto(`/read-source/${saved.bookId}/${saved.sourceId}/1`)
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Read matched context', exact: true })).toHaveCount(0)
  await page.goto(`/read-source/${saved.referenceBookId}/${saved.referenceId}/0`)
  await expect(page.locator('.chapter-body')).toContainText('English reference chapter')
  await page.getByRole('link', { name: 'Back to book details' }).click()
  await expect(page.getByRole('link', { name: 'Continue reading', exact: true })).toHaveAttribute(
    'href',
    `/read-source/${saved.referenceBookId}/${saved.referenceId}/0`,
  )
  await page.goto(`/books/${saved.bookId}/translation`)
  await expect(page.getByRole('link', { name: 'Open book', exact: true })).toBeVisible()
  await expectNoOverflow(page)
  await page.screenshot({
    path: testInfo.outputPath('translation-settings.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.getByRole('tab', { name: 'Style Guide', exact: true }).click()
  await page.getByRole('tab', { name: 'Examples', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'English style source' })).toHaveValue(
    saved.referenceId,
  )
  await page
    .getByRole('checkbox', { name: 'Use Chapter 1 as a style example', exact: true })
    .check()
  await page.getByRole('button', { name: 'Use as style examples', exact: true }).click()
  await expect(page.getByText('Style examples saved.', { exact: true })).toBeVisible()
  await expect(page.locator('.style-example-row')).toHaveCount(1)
  await page.reload()
  await page.getByRole('tab', { name: 'Examples', exact: true }).click()
  await expect(page.locator('.style-example-row')).toHaveCount(1)
  await page.route('**/api/ai/infer-style', async (route) => {
    const input = route.request().postDataJSON()
    const profile = await page.evaluate(async (input) => {
      const clientPath = '/src/lib/supabase/client.ts'
      const { supabase } = await import(clientPath)
      const result = {
        instructions: 'Use clear, restrained sentences and natural dialogue.',
        observations: [
          {
            exampleId: input.exampleIds[0],
            quote: 'An English reference chapter.',
            pattern: 'Concise declarative sentences.',
          },
        ],
        warnings: [],
      }
      const { data, error } = await supabase.rpc('create_inferred_style', {
        target_book: input.bookId,
        expected_profile: input.expectedProfileId,
        example_ids: input.exampleIds,
        style_instructions: result.instructions,
        style_metadata: { model: 'mock', result },
      })
      if (error) throw new Error(error.message)
      return data
    }, input)
    await route.fulfill({ json: { profileId: profile } })
  })
  await page.getByRole('checkbox', { name: /Use english.example.test.*for style/ }).check()
  await page.getByRole('button', { name: 'Infer style', exact: true }).click()
  const styleDialog = page.getByRole('dialog', { name: 'Infer translation style', exact: true })
  await styleDialog.getByRole('checkbox').check()
  await styleDialog.getByRole('button', { name: 'Infer style', exact: true }).click()
  await expect(
    page.getByText('Style guide saved and selected for future translations.', { exact: true }),
  ).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: 'Examples', exact: true }).click()
  await expect(page.locator('.style-profile-text')).toContainText('Use clear, restrained sentences')
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  const retrieved = await page.evaluate(async bookId => {
    const clientPath = '/src/lib/ai/client.ts'
    const { bookTranslationTask } = await import(clientPath)
    return (await bookTranslationTask({ bookId, sourceKey: 'https://books.example.test/novel/1', action: 'context' })).context
  }, saved.bookId)
  expect(retrieved.style).toBe('Use clear, restrained sentences and natural dialogue.')
  let paidTranslationRequests = 0
  await page.route('**/api/ai/book-translation', async (route) => {
    const input = route.request().postDataJSON()
    if (input.action !== 'translate') {
      await route.fallback()
      return
    }
    expect(input.confirmed).toBe(true)
    paidTranslationRequests++
    const savedDraft = await page.evaluate(
      async ({ input, context }) => {
        const clientPath = '/src/lib/supabase/client.ts'
        const { supabase } = await import(clientPath)
        const translation = {
          title: 'Chapter 1',
          paragraphs: ['Qinglan Crossing. Translated chapter text. Desolate Stone Gu Worms waited beside the Combat Bureau.'],
          terminology: [
            {
              source: '\u9752\u5c9a\u6e21\u53e3',
              target: 'Qinglan Crossing',
              category: 'place',
              sense: 'Place name',
              evidenceQuote: '\u9752\u5c9a\u6e21\u53e3\u3002',
            },
            { source: '荒石蠱蟲', target: 'Desolate Stone Gu Worm', category: 'concept', sense: 'Named species', evidenceQuote: '荒石蠱蟲。' },
            { source: '战斗局', target: 'Combat Bureau', category: 'organization', sense: 'First name', evidenceQuote: '战斗局与作战局。' },
            { source: '作战局', target: 'Combat Bureau', category: 'organization', sense: 'Second name', evidenceQuote: '战斗局与作战局。' },
          ],
        }
        const result = await supabase.rpc('complete_chapter_translation', {
          target_book: input.bookId,
          chapter_key: input.sourceKey,
          expected_revision: context.settingsRevision,
          translation_model: 'mock',
          snapshot: context,
          draft: translation,
          consumed_input: 0,
          consumed_output: 0,
        })
        if (result.error) throw new Error(result.error.message)
        return { ...result.data, translation, context }
      },
      { input, context: retrieved },
    )
    await route.fulfill({ json: savedDraft })
  })
  await page.goto(`/read-source/${saved.bookId}/${saved.sourceId}/0`)
  await page.getByRole('button', { name: 'Translate', exact: true }).click()
  await expect(page.locator('.chapter-body')).toContainText(
    'Qinglan Crossing. Translated chapter text.',
  )
  await expect(page.getByRole('dialog', { name: 'Translate & read', exact: true })).toHaveCount(0)
  const pluralTerm = page.locator('.chapter-body').getByRole('button', { name: 'Desolate Stone Gu Worms', exact: true })
  await expect(pluralTerm).toHaveCSS('text-decoration-style', 'dotted')
  await pluralTerm.click()
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Original term', exact: true })).toHaveValue('荒石蠱蟲')
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Preferred translation', exact: true })).toHaveValue('Desolate Stone Gu Worm')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.locator('.chapter-body').getByRole('button', { name: 'Combat Bureau', exact: true }).click()
  const chapterTerms = page.getByRole('dialog', { name: 'Chapter terms', exact: true })
  await expect(chapterTerms.locator('.chapter-term-row')).toHaveCount(2)
  await chapterTerms.getByRole('button', { name: 'Review 战斗局', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Suggest translation term', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save term and update chapter', exact: true })).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Original', exact: true }).click()
  await page.locator('.chapter-body').getByRole('button', { name: '荒石蠱蟲', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Preferred translation', exact: true })).toHaveValue('Desolate Stone Gu Worm')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Translate', exact: true }).click()
  const readingSwitch = await page
    .getByRole('group', { name: 'Reading version', exact: true })
    .boundingBox()
  expect(
    Math.abs(readingSwitch!.x + readingSwitch!.width / 2 - page.viewportSize()!.width / 2),
  ).toBeLessThan(2)
  await expect(
    page.locator('.reader-footer').getByRole('button', { name: 'Translate', exact: true }),
  ).toBeVisible()
  await expect(page.locator('.reader-tools button')).toHaveCount(2)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: testInfo.outputPath('saved-translation-guide.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.goto(`/books/${saved.bookId}/translation`)
  await page.getByRole('tab', { name: 'Glossary', exact: true }).click()
  await expect(page.locator('.glossary-row').filter({ hasText: 'Qinglan Crossing' })).toContainText('proposed')
  await page.goto(`/read-source/${saved.bookId}/${saved.sourceId}/0`)
  await page.getByRole('button', { name: 'Translate', exact: true }).click()
  await expect(page.locator('.chapter-body')).toContainText(
    'Qinglan Crossing. Translated chapter text.',
  )
  await expect(page).toHaveURL(/translated=en/)
  await page.reload()
  await expect(page.locator('.chapter-body')).toContainText(
    'Qinglan Crossing. Translated chapter text.',
  )
  await page.goto(`/read-source/${saved.bookId}/${saved.sourceId}/0?translated=fr`)
  await expect(page.getByRole('button', { name: 'Translate', exact: true })).toBeVisible()
  await expect(page.locator('.chapter-body')).toContainText('Original chapter text')
  await expect(page.getByRole('button', { name: 'Original', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(paidTranslationRequests).toBe(1)
  await page.goto(`/read-source/${saved.bookId}/${saved.sourceId}/0?translated=en`)
  await expect(page.locator('.chapter-body')).toContainText(
    'Qinglan Crossing. Translated chapter text.',
  )
  await page.getByRole('button', { name: 'Next chapter', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Translate', exact: true })).toBeVisible()
  await expect(page.locator('.chapter-body')).toContainText('Original chapter text')
  await expect(page.getByRole('button', { name: 'Original', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('button', { name: 'Next chapter', exact: true })).toBeVisible()
  let paidGuideRequests = 0
  await page.route('**/api/ai/reading-guide', async (route) => {
    const input = route.request().postDataJSON()
    if (!input.confirmed) {
      await route.fallback()
      return
    }
    paidGuideRequests++
    const profileId = await page.evaluate(
      async ({ input, referenceId }) => {
        const clientPath = '/src/lib/supabase/client.ts'
        const { supabase } = await import(clientPath)
        const { data: settings } = await supabase
          .from('book_translation_settings')
          .select('*')
          .eq('book_id', input.bookId)
          .single()
        const { data: book } = await supabase
          .from('books')
          .select('novel_id')
          .eq('id', input.bookId)
          .single()
        const { data: novel } = await supabase
          .from('novels')
          .select('style_profile_id')
          .eq('id', book.novel_id)
          .single()
        const { data: chapter } = await supabase
          .from('source_chapters')
          .select('url,content_hash')
          .eq('source_id', referenceId)
          .eq('url', 'https://english.example.test/novel/1')
          .single()
        const result = await supabase.rpc('save_continuation_style', {
          target_book: input.bookId,
          reference_source: referenceId,
          expected_revision: settings.revision,
          expected_profile: novel.style_profile_id,
          style_instructions: 'Use restrained narration and concise dialogue.',
          style_metadata: {
            kind: 'continuation',
            bookId: input.bookId,
            feedback: settings.guide_feedback,
            referenceSourceId: referenceId,
            targetLanguage: settings.target_language,
            chapters: [{ url: chapter.url, hash: chapter.content_hash }],
          },
        })
        if (result.error) throw new Error(result.error.message)
        return result.data
      },
      { input, referenceId: saved.referenceId },
    )
    await route.fulfill({ json: { profileId, covered: 1, total: 1, remaining: 0, updated: true } })
  })
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  await page.getByRole('link', { name: 'Style guide', exact: true }).click()
  await expect(page.locator('.guide-panel')).toContainText('0 of 1 eligible chapters covered')
  expect(paidGuideRequests).toBe(0)
  await page.getByRole('button', { name: 'Update guide', exact: true }).click()
  const guideDialog = page.getByRole('dialog', { name: 'Update reading guide', exact: true })
  await expect(guideDialog.getByRole('button', { name: 'Update guide', exact: true })).toBeDisabled()
  await guideDialog.getByRole('checkbox', { name: 'Allow this guide request', exact: true }).check()
  await guideDialog.getByRole('button', { name: 'Update guide', exact: true }).click()
  await expect(guideDialog).toBeHidden()
  await expect(page.locator('.guide-panel')).toContainText('1 of 1 eligible chapters covered')
  await expect(
    page.getByRole('checkbox', {
      name: 'Allow automatic billable guide updates',
      exact: true,
    }),
  ).not.toBeChecked()
  expect(paidGuideRequests).toBe(1)
  await page
    .getByRole('checkbox', { name: 'Allow automatic billable guide updates', exact: true })
    .check()
  await page
    .getByRole('spinbutton', { name: 'Update every (new chapters)', exact: true })
    .fill('4')
  await page
    .getByRole('textbox', { name: 'Guide request', exact: true })
    .fill('Keep profile fields on separate lines and dialogue concise.')
  const refreshedGuide = page.waitForResponse(response => response.url().endsWith('/api/ai/reading-guide') && response.request().method() === 'POST' && !response.request().postDataJSON().confirmed)
  await page.getByRole('button', { name: 'Save guide preferences', exact: true }).click()
  await refreshedGuide
  await expect(
    page.getByRole('button', { name: 'Save guide preferences', exact: true }),
  ).toBeDisabled()
  const guideSettings = await page.evaluate(async (bookId) => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    return (
      await supabase
        .from('book_translation_settings')
        .select('guide_auto_update,guide_interval,guide_feedback,context_tokens,recent_chapters')
        .eq('book_id', bookId)
        .single()
    ).data
  }, saved.bookId)
  expect(guideSettings).toMatchObject({
    guide_auto_update: true,
    guide_interval: 4,
    guide_feedback: 'Keep profile fields on separate lines and dialogue concise.',
    context_tokens: 128000,
    recent_chapters: 3,
  })
  expect(paidGuideRequests).toBe(1)
  await expect(page.getByLabel('Guide instructions', { exact: true })).toContainText('Use restrained narration and concise dialogue.')
  await expectNoOverflow(page)
  await page.screenshot({
    path: testInfo.outputPath('reading-guide.png'),
    fullPage: true,
    animations: 'disabled',
  })
  const readingContext = await page.evaluate(async (bookId) => {
    const clientPath = '/src/lib/ai/client.ts'
    const { bookTranslationTask } = await import(clientPath)
    return (
      await bookTranslationTask({
        bookId,
        sourceKey: 'https://books.example.test/novel/2',
        action: 'context',
        continuation: true,
      })
    ).context
  }, saved.bookId)
  expect(readingContext).toMatchObject({
    style: 'Use restrained narration and concise dialogue.',
    mode: 'continuation',
    basis: 'preceding',
  })
  expect(readingContext.references.map((chapter: { url: string }) => chapter.url)).toEqual([
    'https://english.example.test/novel/1',
  ])
  await page.route('**/api/ai/book-translation', async (route) => {
    const input = route.request().postDataJSON()
    if (input.sourceKey !== 'https://books.example.test/novel/2' || input.action !== 'translate') {
      await route.fallback()
      return
    }
    expect(input.continuation).toBe(true)
    expect(input.confirmed).toBe(true)
    paidTranslationRequests++
    const reply = await page.evaluate(
      async ({ input, context, version }) => {
        const clientPath = '/src/lib/supabase/client.ts'
        const { supabase } = await import(clientPath)
        const translation = {
          title: 'Chapter 2 translated',
          paragraphs:
            version > 2
              ? [
                  'A revised continuation is ready.',
                  'The next paragraph keeps its spacing.\nA deliberate line break.',
                ]
              : ['The continuation is ready to read.', 'A separate paragraph follows.'],
          terminology: [],
        }
        const saved = await supabase.rpc('complete_chapter_translation', {
          target_book: input.bookId,
          chapter_key: input.sourceKey,
          expected_revision: context.settingsRevision,
          translation_model: 'fixture',
          snapshot: context,
          draft: translation,
          consumed_input: 0,
          consumed_output: 0,
        })
        if (saved.error) throw new Error(saved.error.message)
        return { ...saved.data, translation }
      },
      { input, context: readingContext, version: paidTranslationRequests },
    )
    await route.fulfill({ json: reply })
  })
  await page.goto(`/read-source/${saved.bookId}/${saved.sourceId}/1`)
  await page.getByRole('button', { name: 'Translate', exact: true }).click()
  await expect(page.locator('.chapter-body')).toContainText('The continuation is ready to read.')
  expect(paidTranslationRequests).toBe(2)
  await page.reload()
  await expect(page.locator('.chapter-body')).toContainText('The continuation is ready to read.')
  expect(paidTranslationRequests).toBe(2)
  await expect(page.locator('.chapter-body > p')).toHaveCount(2)
  await expect(page.locator('.chapter-meta')).toHaveCount(0)
  await expect(page.getByText(/AI translation \/ en/)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Source link', exact: true })).toHaveCount(0)
  const firstVersion = new URL(page.url()).searchParams.get('version')!
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  await page.getByRole('button', { name: 'Retranslate chapter', exact: true }).click()
  const retranslation = page.getByRole('dialog', { name: 'Retranslate chapter', exact: true })
  await expect(retranslation.locator('.translation-budget')).toContainText('estimated input tokens')
  expect(paidTranslationRequests).toBe(2)
  await retranslation
    .getByRole('button', { name: 'Retranslate & save new version', exact: true })
    .click()
  await expect(page.locator('.chapter-body')).toContainText('A revised continuation is ready.')
  expect(paidTranslationRequests).toBe(3)
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  const versionPicker = page.getByRole('combobox', { name: 'Translation version', exact: true })
  await expect(versionPicker.locator('option')).toHaveCount(2)
  await expect(page.locator('.chapter-body > p').last()).toHaveCSS('white-space', 'pre-wrap')
  expect(
    await page
      .locator('.chapter-body > p')
      .first()
      .evaluate((paragraph) => parseFloat(getComputedStyle(paragraph).marginBottom)),
  ).toBeGreaterThan(0)
  await versionPicker.selectOption(firstVersion)
  await expect(page.locator('.chapter-body')).toContainText('The continuation is ready to read.')
  await page.reload()
  await expect(page.locator('.chapter-body')).toContainText('The continuation is ready to read.')
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  await expect(versionPicker.locator('option')).toHaveCount(2)
  await page.getByRole('button', { name: 'Close reading settings', exact: true }).click()
  expect(paidTranslationRequests).toBe(3)
  await expectNoOverflow(page)
  await page.screenshot({
    path: testInfo.outputPath('translation-reader.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.getByRole('button', { name: 'Original', exact: true }).click()
  await expect(page.locator('.chapter-body')).toContainText('Original chapter text')
  await page
    .locator('.chapter-body > p')
    .first()
    .evaluate((paragraph) => {
      const text = paragraph.firstChild!
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 4)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
  await page.getByRole('button', { name: 'Suggest term', exact: true }).click()
  const termDialog = page.getByRole('dialog', { name: 'Suggest translation term', exact: true })
  await expect(termDialog.getByRole('textbox', { name: 'Original term', exact: true })).toHaveValue(
    '\u9752\u5c9a\u6e21\u53e3',
  )
  await termDialog
    .getByRole('textbox', { name: 'Preferred translation', exact: true })
    .fill('Qinglan Ferry')
  await termDialog.getByRole('combobox', { name: 'Use in', exact: true }).selectOption('global')
  await termDialog.getByRole('combobox', { name: 'Category', exact: true }).selectOption('place')
  await page.screenshot({
    path: testInfo.outputPath('reader-term-suggestion.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await termDialog.getByRole('button', { name: 'Save preferred term', exact: true }).click()
  await expect(termDialog).not.toBeVisible()
  const preferred = await page.evaluate(async (bookId) => {
    const clientPath = '/src/lib/ai/client.ts'
    const { bookTranslationTask } = await import(clientPath)
    return (
      await bookTranslationTask({
        bookId,
        sourceKey: 'https://books.example.test/novel/2',
        action: 'context',
        continuation: true,
      })
    ).context
  }, saved.bookId)
  expect(preferred.glossary).toContainEqual(
    expect.objectContaining({ source: '\u9752\u5c9a\u6e21\u53e3', target: 'Qinglan Ferry' }),
  )
  expect(paidTranslationRequests).toBe(3)
  await expect(page.locator('.chapter-body')).toContainText('Original chapter text')
  await page.goto(`/read-source/${saved.bookId}/${saved.sourceId}/0?translated=en`)
  const annotated = page
    .locator('.chapter-body')
    .getByRole('button', { name: 'Qinglan Crossing', exact: true })
  await expect(annotated).toHaveCSS('text-decoration-style', 'dotted')
  let termSuggestions = 0
  await page.route('**/api/ai/term-suggestion', route => {
    termSuggestions++
    const input = route.request().postDataJSON()
    expect(input.source).toBe('\u9752\u5c9a\u6e21\u53e3')
    expect(input.readerContext).toBe('Keep the place name consistent with earlier chapters.')
    expect(input.confirmed).toBe(true)
    return route.fulfill({ json: { suggestion: { source: input.source, target: 'Qinglan Crossing Revised', category: 'place', sense: 'Place name', aliases: [], evidenceQuote: '\u9752\u5c9a\u6e21\u53e3\u3002', explanation: 'A proposed name rendering for review.', alternatives: [{ target: 'Qinglan Crossing', explanation: 'Keep the previous rendering.' }], warnings: [] }, model: 'test-only', existingChoices: [], usage: { inputTokens: 100, outputTokens: 50 } } })
  })
  await annotated.click()
  const inlineEditor = page.getByRole('dialog', { name: 'Edit translation term', exact: true })
  await expect(
    inlineEditor.getByRole('textbox', { name: 'Original term', exact: true }),
  ).toBeDisabled()
  expect(termSuggestions).toBe(0)
  await inlineEditor.getByRole('textbox', { name: 'Context for this term', exact: true }).fill('Keep the place name consistent with earlier chapters.')
  await inlineEditor.getByRole('button', { name: 'Suggest with AI', exact: true }).click()
  await expect(inlineEditor.getByRole('heading', { name: 'Qinglan Crossing Revised', exact: true })).toBeVisible()
  await expect(inlineEditor.getByRole('textbox', { name: 'Preferred translation', exact: true })).toHaveValue('Qinglan Crossing')
  await inlineEditor.getByRole('button', { name: 'Use suggestion', exact: true }).click()
  await expect(inlineEditor.getByRole('textbox', { name: 'Preferred translation', exact: true })).toHaveValue('Qinglan Crossing Revised')
  expect(termSuggestions).toBe(1)
  await expectNoOverflow(page)
  await page.screenshot({ path: testInfo.outputPath('noun-ai-suggestion.png') })
  await inlineEditor
    .getByRole('button', { name: 'Save term and update chapter', exact: true })
    .click()
  await expect(
    page
      .locator('.chapter-body')
      .getByRole('button', { name: 'Qinglan Crossing Revised', exact: true }),
  ).toBeVisible()
  expect(paidTranslationRequests).toBe(3)
  await page.reload()
  await expect(page.locator('.chapter-body')).toContainText('Qinglan Crossing Revised')
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  await expect(
    page.getByRole('combobox', { name: 'Translation version', exact: true }).locator('option'),
  ).toHaveCount(2)
  await page.getByRole('button', { name: 'Close reading settings', exact: true }).click()
  await page.getByRole('link', { name: 'Back to book details', exact: true }).click()
  await page.getByRole('tab', { name: 'Downloads', exact: true }).click()
  const extractionRequests: {
    confirmed?: boolean
    forceRegenerate?: boolean
    sourceId: string
    url: string
  }[] = []
  await page.route('**/api/ai/source-extraction', async (route) => {
    const input = route.request().postDataJSON()
    extractionRequests.push(input)
    await route.fulfill({
      json: input.confirmed
        ? {
            state: 'ready',
            url: input.url,
            title: 'Chapter 1',
            paragraphs: ['Verified direct extraction preview.'],
            characters: 8000,
            htmlCharacters: 10000,
            strategy: 'generated',
            nextPageUrl: null,
          }
        : {
            state: 'needs_scraper',
            message:
              'Direct fetch worked. Confirm model use to generate an extractor for the fetched HTML.',
          },
    })
  })
  await expect(page.getByRole('heading', { name: 'Extraction tools', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Test direct fetch', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Direct fetch worked')
  expect(extractionRequests).toEqual([
    {
      sourceId: saved.sourceId,
      url: 'https://books.example.test/novel/1',
      confirmed: false,
      forceRegenerate: false,
    },
  ])
  await page.getByRole('button', { name: 'Rebuild scraper', exact: true }).click()
  const rebuild = page.getByRole('dialog', { name: 'Rebuild chapter scraper', exact: true })
  await expect(rebuild.getByRole('button', { name: 'Rebuild scraper', exact: true })).toBeDisabled()
  expect(extractionRequests).toHaveLength(1)
  await rebuild.getByRole('checkbox').check()
  await rebuild.getByRole('button', { name: 'Rebuild scraper', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Direct extraction result' })).toContainText(
    'Direct fetch and extraction passed',
  )
  expect(extractionRequests[1]).toMatchObject({
    sourceId: saved.sourceId,
    url: 'https://books.example.test/novel/1',
    forceRegenerate: true,
    confirmed: true,
  })
  await expect(page.getByRole('region', { name: 'Direct extraction result' })).toContainText(
    'Verified direct extraction preview.',
  )
  await expectNoOverflow(page)
  await page.screenshot({
    path: testInfo.outputPath('direct-extraction.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.evaluate(async (sourceId) => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    const removed = await supabase
      .from('source_chapters')
      .delete()
      .eq('source_id', sourceId)
      .in('url', ['https://books.example.test/novel/3', 'https://books.example.test/novel/4'])
    if (removed.error) throw new Error(removed.error.message)
    window.dispatchEvent(new Event('focus'))
  }, saved.sourceId)
  await expect(page.getByRole('heading', { name: '2 / 4 chapters saved', exact: true })).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'From chapter', exact: true })).toHaveValue('3')
  let releaseThird!: () => void
  const thirdGate = new Promise<void>((resolve) => {
    releaseThird = resolve
  })
  const directDownloads: string[] = []
  await page.route('**/api/ai/source-chapter', async (route) => {
    const input = route.request().postDataJSON()
    directDownloads.push(input.url)
    if (input.url.endsWith('/3')) await thirdGate
    await route.fulfill({ json: await storeChapter(input) })
  })
  await page.getByLabel('Concurrent downloads', { exact: true }).fill('1')
  await page.getByRole('button', { name: 'Download all', exact: true }).click()
  await expect.poll(() => directDownloads.length).toBe(1)
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await page.getByRole('tab', { name: 'Downloads', exact: true }).click()
  await page.getByRole('button', { name: 'Stop after current downloads', exact: true }).click()
  releaseThird()
  await expect(
    page.getByRole('status').filter({ hasText: 'Paused. Completed chapters are kept.' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Resume downloads', exact: true }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Selected chapters downloaded.' }),
  ).toBeVisible()
  expect(directDownloads).toEqual([
    'https://books.example.test/novel/3',
    'https://books.example.test/novel/4',
  ])
  await page.getByRole('button', { name: 'Download all', exact: true }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Selected chapters downloaded.' }),
  ).toBeVisible()
  expect(directDownloads).toHaveLength(2)
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Sources', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search saved sources' }).fill('english.example.test')
  await expect(page.locator('.source-directory-row')).toHaveCount(1)
  await expect(page.locator('.source-directory-row > a')).toHaveAttribute(
    'href',
    'https://english.example.test/contents',
  )
  await expectNoOverflow(page)
  await page.screenshot({
    path: testInfo.outputPath('source-directory.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.goto(`/books/${saved.referenceBookId}/translation`)
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  const englishSource = page
    .locator('.source-row')
    .filter({ hasText: 'https://english.example.test/contents' })
  await englishSource.getByRole('button', { name: /^Delete source/ }).click()
  const removeSource = page.getByRole('dialog', { name: 'Delete source?', exact: true })
  await expect(removeSource).toContainText(
    'other sources, imported book files, glossary and saved translations are kept',
  )
  await removeSource.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(englishSource).toBeVisible()
  await englishSource.getByRole('button', { name: /^Delete source/ }).click()
  await page.screenshot({
    path: testInfo.outputPath('delete-source.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await removeSource.getByRole('button', { name: 'Delete source', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Source deleted')
  await expect(englishSource).toHaveCount(0)
  const retained = await page.evaluate(async (saved) => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    const { data: book } = await supabase
      .from('books')
      .select('novel_id')
      .eq('id', saved.bookId)
      .single()
    const alignments = await supabase
      .from('source_chapter_alignments')
      .select('source_id')
      .eq('reference_source_id', saved.referenceId)
    if (alignments.error) throw new Error(alignments.error.message)
    return {
      settings: (
        await supabase
          .from('book_translation_settings')
          .select('reference_source_id')
          .eq('book_id', saved.bookId)
          .single()
      ).data,
      novel: (
        await supabase.from('novels').select('style_profile_id').eq('id', book.novel_id).single()
      ).data,
      downloaded: (
        await supabase.from('source_chapters').select('source_id').eq('source_id', saved.sourceId)
      ).data,
      alignments: alignments.data,
      drafts: (
        await supabase.from('book_translation_previews').select('id').eq('book_id', saved.bookId)
      ).data,
    }
  }, saved)
  expect(retained.settings.reference_source_id).toBeNull()
  expect(retained.novel.style_profile_id).toBeNull()
  expect(retained.downloaded).toHaveLength(4)
  expect(retained.alignments).toHaveLength(0)
  expect(retained.drafts.length).toBeGreaterThan(0)
  await page.reload()
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await expect(englishSource).toHaveCount(0)
  await page.goto(`/books/${saved.bookId}/translation`)
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  const originalSource = page
    .locator('.source-row')
    .filter({ hasText: 'https://books.example.test/novel' })
  await originalSource.getByRole('button', { name: /^Delete source/ }).click()
  await removeSource.getByRole('button', { name: 'Delete source', exact: true }).click()
  await expect(originalSource).toHaveCount(0)
  const catalog = await page.evaluate(async (bookId) => {
    const clientPath = '/src/lib/supabase/client.ts'
    const catalogPath = '/src/lib/library/catalog.ts'
    const { supabase } = await import(clientPath)
    const { readLibraryCatalog } = await import(catalogPath)
    return (await readLibraryCatalog(supabase)).find((book: { id: string }) => book.id === bookId)
  }, saved.bookId)
  expect(catalog.sources).toEqual([])
  await page.goto(`/books/${saved.bookId}`)
  await expect(page.getByText('0 chapter links found', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: /^A Web Novel With/ })).toBeVisible()
  await expectNoOverflow(page)
})

test('extension pairing connects automatically only for a valid extension-started handshake', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const browserWindow = window as Window & { chrome?: { runtime?: unknown } }
    browserWindow.chrome ??= {}
    browserWindow.chrome.runtime = {
      sendMessage: async (_identifier: string, message: { nonce: string }) =>
        message.nonce === '00000000-0000-4000-8000-000000000000'
          ? { ok: false, error: 'This handshake is not pending in the extension.' }
          : { ok: true },
    }
  })
  const pairingRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/api/extension/pair')) pairingRequests.push(request.url())
  })
  await page.goto('/extension/connect?extensionId=invalid')
  await expect(page.getByRole('alert')).toContainText('invalid')
  await expect(page.getByRole('button', { name: 'Approve connection' })).toHaveCount(0)
  await page.goto(`/extension/connect?extensionId=${'a'.repeat(32)}`)
  await expect(page.getByRole('alert')).toContainText('invalid')
  await page.goto(
    `/extension/connect?extensionId=${'a'.repeat(32)}&nonce=00000000-0000-4000-8000-000000000000`,
  )
  await expect(page.getByRole('alert')).toContainText('not pending')
  expect(pairingRequests).toHaveLength(0)
  await page.goto(`/extension/connect?extensionId=${'a'.repeat(32)}&nonce=${crypto.randomUUID()}`)
  await expect(page.getByRole('heading', { name: 'Extension connected' })).toBeVisible()
  expect(pairingRequests).toHaveLength(1)
  await expect(page.getByRole('button', { name: 'Approve connection' })).toHaveCount(0)
  await expectNoOverflow(page)
})

test('library has one import action, one top-right settings control and no workspace clutter', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45_000 })
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /import/i })).toHaveCount(1)
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
  await expect(page.locator('.settings-control > button')).toHaveCount(1)
  await expect(page.locator('.sidebar-bottom')).toHaveCount(0)
  await expect(settingsButton).toHaveCSS('border-radius', '6px')
  await expect(page.getByRole('button', { name: /Switch to .* mode/ })).toHaveCount(0)
  await expect(settingsButton).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(settingsButton).toHaveAttribute('aria-expanded', 'false')
  const settingsBounds = await settingsButton.boundingBox()
  expect(settingsBounds!.width).toBeGreaterThanOrEqual(44)
  expect(settingsBounds!.height).toBeGreaterThanOrEqual(44)
  const viewport = page.viewportSize()!
  expect(settingsBounds!.x).toBeGreaterThan(viewport.width / 2)
  expect(settingsBounds!.y).toBeLessThan(80)
  await settingsButton.click()
  const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
  await expect(preferences).toBeVisible()
  await expect(settingsButton).toHaveAttribute('aria-expanded', 'true')
  await preferences.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await preferences.getByRole('button', { name: 'Light', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await preferences.getByRole('button', { name: 'Reading preferences', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Reading settings', exact: true })).toBeVisible()
  await expectFullHeightSettings(page)
  await expect(preferences).not.toBeVisible()
  await page.getByRole('button', { name: 'Increase text size' }).click()
  await expect(page.getByRole('slider', { name: /^Text size/ })).toHaveValue('20')
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Close reading settings' }).click()
  await expect(settingsButton).toBeFocused()
  await settingsButton.press('Enter')
  await preferences.getByRole('button', { name: 'Reading preferences', exact: true }).click()
  await expect(page.getByRole('slider', { name: /^Text size/ })).toHaveValue('20')
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'Close reading settings' }).click()
  const navigation = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(navigation.getByRole('link')).toHaveCount(3)
  await expect(navigation.getByRole('link', { name: 'Bookmarks', exact: true })).toBeVisible()
  await expect(
    page.locator('.workspace-header, .workspace-footer, .avatar, .personal-space, .import-tile'),
  ).toHaveCount(0)
  await expect(
    page.getByText(
      /^(Workspace|Your personal collection|Personal collection|Local library|Local Supabase|Preferences|My space|Personal library|Saved locally)$/i,
    ),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Import book', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Import a book', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close import a book' }).click()
  await navigation.getByRole('link', { name: 'Bookmarks', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bookmarks', exact: true })).toBeVisible()
  await expect(settingsButton).toBeVisible()
  await expect(page.locator('.settings-control > button')).toHaveCount(1)
  await navigation.getByRole('link', { name: 'Library', exact: true }).click()
  await page.getByRole('tab', { name: /^Finished/ }).click()
  await expect(page.getByRole('heading', { name: 'Nothing on this shelf yet' })).toBeVisible()
  await expect(page.getByRole('button', { name: /import/i })).toHaveCount(1)
  await page.getByRole('button', { name: 'View all books' }).click()
  await expect(page.locator('.book-tile')).toHaveCount(4)
  await expectNoOverflow(page)
})

test('translation setup uses independent source books and a 150-chapter context book', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45_000 })
  const fixture = await page.evaluate(async () => {
    const repoPath = '/src/lib/library/repository.ts'
    const booksPath = '/src/lib/books.ts'
    const clientPath = '/src/lib/supabase/client.ts'
    const { getBooks, saveBook } = await import(repoPath)
    const { importBook } = await import(booksPath)
    const { supabase } = await import(clientPath)
    const original = (await getBooks()).find(
      (book: { title: string }) => book.title === 'Qinglan Crossing (test novel)',
    )
    const reference = await saveBook(
      await importBook(
        new File(
          [
            Array.from(
              { length: 150 },
              (_, index) =>
                `Chapter ${index + 1}\nEnglish reference chapter ${index + 1} at the crossing.`,
            ).join('\n\n'),
          ],
          'English Reference.txt',
        ),
      ),
    )
    const inspection = {
      classification: 'catalog',
      title: 'Qinglan Crossing',
      originalTitle: null,
      author: 'Reference Author',
      originalAuthor: null,
      language: 'en',
      synopses: [
        {
          label: 'Synopsis',
          text: 'A catalog synopsis for the main book page.',
          originalText: null,
        },
      ],
      coverImage: null,
      genres: ['Fantasy'],
      tags: [],
      publicationStatus: 'Complete',
      chapterCount: 150,
      wordCount: null,
      updatedAt: null,
      additionalMetadata: [],
      reason: 'Synthetic catalog fixture.',
      chapterLinks: [],
      indexUrl: null,
    }
    const record = await supabase
      .from('page_identifications')
      .insert({
        source_url: 'https://www.novelupdates.com/series/reference-fixture/',
        source_language: 'en',
        output_language: 'en',
        title: inspection.title,
        model: 'fixture',
        prompt_version: 'fixture',
        captured_html_hash: 'a'.repeat(64),
        metadata: inspection,
        raw_extraction: inspection,
      })
      .select('id')
      .single()
    if (record.error) throw record.error
    const catalog = await supabase
      .from('novel_sources')
      .insert({
        novel_id: original.novelId,
        label: 'Novel Updates',
        url: 'https://www.novelupdates.com/series/reference-fixture/',
        language: 'en',
        role: 'metadata',
        identification_id: record.data.id,
      })
      .select('id')
      .single()
    if (catalog.error) throw catalog.error
    const alternate = await supabase
      .from('novel_sources')
      .insert({
        novel_id: original.novelId,
        label: 'Split Chinese edition',
        url: 'https://source.example.test/novel',
        language: 'zh',
        role: 'original',
        contents_data: {
          url: 'https://source.example.test/contents',
          foundCount: 4,
          numberedCount: 4,
          reportedCount: 4,
          pageOrder: 'oldest-first',
          nextContentsUrls: [],
          truncated: false,
          chapters: [1, 2, 3, 4].map((number) => ({
            url: `https://source.example.test/chapter/${number}`,
            title: `Chapter ${number}`,
            sourceTitle: `Chapter ${number}`,
            number,
          })),
        },
      })
      .select('id')
      .single()
    if (alternate.error) throw alternate.error
    const alternateBook = await supabase.rpc('materialize_source_book', {
      target_source: alternate.data.id,
    })
    if (alternateBook.error) throw alternateBook.error
    return {
      bookId: original.id,
      referenceId: reference.book.id,
      catalogId: catalog.data.id,
      alternateBookId: alternateBook.data,
    }
  })
  await page.goto(`/books/${fixture.bookId}/translation`)
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('combobox', { name: 'Target language', exact: true })).toHaveValue(
    'en',
  )
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Metadata source', exact: true })).toHaveValue(
    fixture.catalogId,
  )
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Context book', exact: true })
    .selectOption(`book:${fixture.referenceId}`)
  await page.getByRole('combobox', { name: 'Context use', exact: true }).selectOption('continuation')
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save preferences', exact: true })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: 'Source chapter', exact: true })).toHaveCount(0)
  await expect(page.getByRole('listbox', { name: 'Reference chapters', exact: true })).toHaveCount(0)
  const context = await page.evaluate(async bookId => {
    const clientPath = '/src/lib/ai/client.ts'
    const { bookTranslationTask } = await import(clientPath)
    return (await bookTranslationTask({ bookId, sourceKey: 'local:2', action: 'context' })).context
  }, fixture.bookId)
  expect(context.references).toHaveLength(2)
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await page.getByRole('button', { name: 'Preview source metadata', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Metadata review' })).toContainText(
    'A catalog synopsis for the main book page.',
  )
  await page.getByRole('button', { name: 'Apply to book page', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply to book page', exact: true })).toBeDisabled()
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Target language', exact: true }).selectOption('fr')
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save preferences', exact: true })).toBeDisabled()
  await expect(page.getByRole('link', { name: 'Open book', exact: true })).toHaveAttribute('href', `/books/${fixture.bookId}`)
  await page.goto(`/books/${fixture.alternateBookId}`)
  await expect(page.locator('.book-source-identity')).toContainText('source.example.test')
  await expect(page.locator('.chapter-list-item')).toHaveCount(4)
  await page.getByRole('link', { name: 'Translation', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Source chapter', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Translate & read', exact: true })).toHaveCount(0)
  await expect(
    page.getByRole('combobox', { name: 'Main chapter source', exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Target language', exact: true })).toHaveValue(
    'en',
  )
  await page.goto(`/books/${fixture.bookId}/translation`)
  await expect(page.getByRole('combobox', { name: 'Target language', exact: true })).toHaveValue(
    'fr',
  )
  await expectNoOverflow(page)
  await page.screenshot({
    path: testInfo.outputPath('translation-setup.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.getByRole('tab', { name: 'Glossary', exact: true }).click()
  await page.getByRole('button', { name: 'Add term', exact: true }).click()
  await page.getByLabel('Source term', { exact: true }).fill('crossing')
  await page.getByLabel('French term', { exact: true }).fill('passage')
  await page.getByRole('dialog').getByRole('button', { name: 'Save term', exact: true }).click()
  await expect(page.locator('.glossary-row')).toContainText('passage')
  expect(
    await page.evaluate(async () => {
      const { supabase } = await import('/src/lib/supabase/client.ts')
      const { data, error } = await supabase
        .from('glossary_entries')
        .select('target_language')
        .eq('source_term', 'crossing')
        .single()
      if (error) throw error
      return data.target_language
    }),
  ).toBe('fr')
  await page.getByRole('link', { name: 'Back to book', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Qinglan Crossing', exact: true })).toBeVisible()
  await expect(
    page.getByText('A catalog synopsis for the main book page.', { exact: true }),
  ).toBeVisible()
})

test('translation workspace persists sources, glossary proposals, overrides and style profiles', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45_000 })
  await page.locator('.tile-title').filter({ hasText: 'Qinglan Crossing (test novel)' }).click()
  await page.getByRole('link', { name: 'Translation', exact: true }).click()
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await expect(page.getByText('No source URLs yet.', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Experiments', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Link Novel Updates', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(1)
  await page
    .getByLabel('Novel Updates URL', { exact: true })
    .fill('https://www.novelupdates.com/series/novelist-fixture/')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Link Novel Updates', exact: true })
    .click()
  await expect(page.locator('.source-row')).toHaveCount(1)
  await expect(page.locator('.source-url')).toHaveAttribute(
    'href',
    'https://www.novelupdates.com/series/novelist-fixture/',
  )

  await page.route('**/api/ai/status', (route) =>
    route.fulfill({ json: { liveEnabled: false, model: 'test-only' } }),
  )
  await page.getByRole('tab', { name: 'Style Guide', exact: true }).click()
  await page.getByRole('tab', { name: 'Examples', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New profile', exact: true })).toHaveCount(0)
  const exampleInput = page.getByLabel('Upload chapter examples', { exact: true })
  await exampleInput.setInputFiles({
    name: 'empty.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(''),
  })
  await expect(page.getByRole('alert')).toContainText('empty')
  const exampleFile = {
    name: 'English chapter.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'The rain eased. "Keep the ledger," she said. He nodded, and closed the door.',
    ),
  }
  await exampleInput.setInputFiles(exampleFile)
  await expect(page.locator('.style-example-row')).toHaveCount(1)
  await exampleInput.setInputFiles(exampleFile)
  await expect(page.locator('.style-example-row')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Infer style', exact: true })).toBeDisabled()
  await expect(page.locator('.style-profile-text')).toContainText('No inferred style yet.')
  await page.reload()
  await page.getByRole('tab', { name: 'Examples', exact: true }).click()
  await expect(page.locator('.style-example-row')).toContainText('English chapter.txt')
  await page.getByRole('checkbox', { name: 'Use English chapter.txt for style' }).check()
  await page.screenshot({ path: testInfo.outputPath('translation-style.png'), fullPage: true })
  await expectNoOverflow(page)

  await page.unroute('**/api/ai/status')
  await page.route('**/api/ai/status', (route) =>
    route.fulfill({ json: { liveEnabled: true, model: 'test-only' } }),
  )
  await page.route('**/api/ai/infer-style', (route) =>
    route.fulfill({ status: 503, json: { error: 'Test provider unavailable.' } }),
  )
  await page.reload()
  await page.getByRole('tab', { name: 'Examples', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Use English chapter.txt for style' }).check()
  await page.getByRole('button', { name: 'Infer style', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'Infer translation style', exact: true })
  await expect(
    confirmation.getByRole('button', { name: 'Infer style', exact: true }),
  ).toBeDisabled()
  await confirmation.getByRole('checkbox').check()
  await confirmation.getByRole('button', { name: 'Infer style', exact: true }).click()
  await expect(confirmation.getByRole('alert')).toContainText('Test provider unavailable.')
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.style-profile-text')).toContainText('No inferred style yet.')
  await page.getByRole('button', { name: 'Remove English chapter.txt', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove example', exact: true })
    .click()
  await expect(page.locator('.style-example-row')).toHaveCount(0)

  const extracted = await page.evaluate(async () => {
    const clientPath = '/src/lib/ai/client.ts'
    const { extractTerms } = await import(clientPath)
    const bookId = location.pathname.split('/')[2]
    await extractTerms(bookId, 0, 'fixture')
    return extractTerms(bookId, 0, 'fixture')
  })
  expect(extracted.terms).toBe(6)
  await expect(page.getByRole('button', { name: 'Refresh translation workspace', exact: true })).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('tab', { name: 'Glossary', exact: true }).click()
  await expect(page.locator('.glossary-row')).toHaveCount(6)
  await page.getByRole('button', { name: 'Approve 林遥', exact: true }).click()
  await expect(page.locator('.glossary-row').filter({ hasText: 'Lin Yao' })).toContainText(
    'approved',
  )
  await page.getByRole('button', { name: 'Edit 林遥', exact: true }).click()
  await page.getByLabel('English term', { exact: true }).fill('Lin Yao (approved)')
  await page.getByRole('button', { name: 'Save term', exact: true }).click()
  await expect(page.locator('.glossary-row')).toContainText(['Lin Yao (approved)'])
  await page.getByRole('button', { name: 'Add term', exact: true }).click()
  await page.getByLabel('Source term', { exact: true }).fill('林遥')
  await page.getByLabel('English term', { exact: true }).fill('A-Yao')
  await page.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('chapter')
  await page.getByRole('button', { name: 'Save term', exact: true }).click()
  await expect(page.locator('.glossary-row')).toHaveCount(7)
  await page.screenshot({ path: testInfo.outputPath('translation-glossary.png'), fullPage: true })
  await expectNoOverflow(page)
  await page.reload()
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await expect(page.locator('.source-url')).toHaveAttribute(
    'href',
    'https://www.novelupdates.com/series/novelist-fixture/',
  )
  await page.getByRole('tab', { name: 'Glossary', exact: true }).click()
  await expect(page.locator('.glossary-row')).toHaveCount(7)
  const runs = await page.evaluate(async () => {
    const clientPath = '/src/lib/supabase/client.ts'
    const { supabase } = await import(clientPath)
    const { data, error } = await supabase
      .from('translation_runs')
      .select('status,mode,input_tokens')
      .eq('book_id', location.pathname.split('/')[2])
    if (error) throw error
    return data
  })
  expect(runs).toEqual(
    Array.from({ length: 2 }, () => ({ status: 'completed', mode: 'fixture', input_tokens: 0 })),
  )
  const anonymous = await page.request.post('/api/ai/extract-terms', {
    data: { bookId: '0'.repeat(32), chapter: 0, mode: 'fixture' },
  })
  expect(anonymous.status()).toBe(401)
  const scraperTool = await page.request.get('/api/ai/scraper-tool')
  expect((await scraperTool.json()).name).toBe('generate_book_scraper')
  const scraperAnonymous = await page.request.post('/api/ai/generate-scraper', { data: {} })
  expect(scraperAnonymous.status()).toBe(401)
  const scraperCrossOrigin = await page.request.post('/api/ai/generate-scraper', {
    headers: { Origin: 'https://untrusted.example', Authorization: 'Bearer invalid' },
    data: {},
  })
  expect(scraperCrossOrigin.status()).toBe(403)
  const artifactRoot = join(process.cwd(), '.novelist')
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  const privateDirectory = await mkdtemp(join(artifactRoot, 'http-check-'))
  try {
    const privatePath = join(privateDirectory, 'private.json')
    await writeFile(privatePath, JSON.stringify({ private: 'test-only artifact' }), { mode: 0o600 })
    expect(
      (await page.request.get(`/.novelist/${basename(privateDirectory)}/private.json`)).status(),
    ).toBe(403)
    expect((await page.request.get(`/@fs/${privatePath}`)).status()).toBe(403)
  } finally {
    await rm(privateDirectory, { recursive: true, force: true })
  }
})

test('reader preserves chapters, bookmarks, appearance and reading position', async ({
  page,
}, testInfo) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  await page.goto('/')
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45_000 })
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Preferences', exact: true })
    .getByRole('button', { name: 'Dark', exact: true })
    .click()
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: testInfo.outputPath('library-dark.png'), fullPage: true })
  await page.locator('.tile-title').filter({ hasText: "Alice's Adventures in Wonderland" }).click()
  await expect(page.getByRole('heading', { name: 'Synopsis' })).toBeVisible()
  await expect(page.locator('.synopsis-section button')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit book details', exact: true })).toHaveCount(0)
  await expect(page.locator('.chapter-list-item')).toHaveCount(12)
  await expectNoOverflow(page)
  await page.screenshot({ path: testInfo.outputPath('book-details.png'), fullPage: true })
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click()
  await page.getByRole('button', { name: "Actions for Alice's Adventures in Wonderland", exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit book details', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  const fileDetails = await page.locator('.file-details').boundingBox()
  const contentSection = await page.locator('.contents-section').boundingBox()
  expect(fileDetails!.width).toBeCloseTo(contentSection!.width, 0)
  await expect(page.locator('.file-details > div')).toHaveCount(7)
  await expect(page.locator('.file-details dt').filter({ hasText: /^Genre$/ })).toBeVisible()
  await expect(page.locator('.overview-top .genre-label')).toHaveCount(0)
  await expectNoOverflow(page)
  await page.screenshot({ path: testInfo.outputPath('file-details.png'), fullPage: true })
  await page.getByRole('link', { name: 'Start reading', exact: true }).click()
  await expect(page.locator('.chapter-body')).toContainText('Alice')
  await expect(page.getByRole('button', { name: 'Previous chapter', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Next chapter', exact: true })).toHaveCount(1)
  await expect(page.locator('.reader-chapter-navigation button')).toHaveCount(4)
  const navigationAppearance = await page.locator('.reader-chapter-navigation').evaluateAll(navigations => navigations.map(navigation => [...navigation.querySelectorAll('button')].map(button => {
    const style = getComputedStyle(button)
    const bounds = button.getBoundingClientRect()
    return { text: button.textContent?.trim(), width: bounds.width, height: bounds.height, border: style.border, radius: style.borderRadius, font: style.font, iconSize: button.querySelector('svg')?.getAttribute('width') }
  })))
  expect(navigationAppearance[0]).toEqual(navigationAppearance[1])
  await expect(
    page.locator('.reader-footer').getByRole('button', { name: 'Next chapter', exact: true }),
  ).toHaveCount(0)
  await expect(page.locator('.reader-tools button')).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('reader-dark.png') })
  await expectNoOverflow(page)

  await page.locator('.reader-location').click()
  await expect(page.getByRole('dialog', { name: 'Contents', exact: true })).toBeVisible()
  await page.locator('.toc-entry').nth(1).click()
  await expect(page).toHaveURL(/\/read\/[^/]+\/1$/)
  await expect(page.locator('.chapter-heading h1')).toHaveText('The Pool of Tears')
  await page.getByRole('button', { name: 'Previous chapter at top', exact: true }).click()
  await expect(page).toHaveURL(/\/read\/[^/]+\/0$/)
  await expect(page.getByRole('button', { name: 'Previous chapter at top', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Next chapter at top', exact: true }).click()
  await expect(page.locator('.chapter-heading h1')).toHaveText('The Pool of Tears')
  await page.getByLabel('Next chapter', { exact: true }).click()
  await expect(page).toHaveURL(/\/read\/[^/]+\/2$/)
  await expect(page.locator('.chapter-body')).toBeVisible()
  await page.getByRole('button', { name: 'Previous chapter', exact: true }).click()
  await expect(page.locator('.chapter-heading h1')).toHaveText('The Pool of Tears')
  await expect(page.locator('.reader')).toHaveAttribute('data-reading-ready', 'true')

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
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  await page.getByRole('button', { name: 'Bookmark this position', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remove bookmark', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator('.chapter-body')).toBeVisible()
  await expect(page.locator('.reader-location')).toHaveAttribute('title', /40%/)
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remove bookmark', exact: true })).toBeVisible()

  await page.goto('/')
  const recentBook = page.getByRole('region', { name: 'Continue reading', exact: true })
  await expect(recentBook.getByRole('heading', { level: 3 })).toHaveText(
    "Alice's Adventures in Wonderland",
  )
  const resumeLink = recentBook.getByRole('link', { name: 'Continue reading', exact: true })
  const resumeUrl = await resumeLink.getAttribute('href')
  const recentProgress = await recentBook.getByRole('progressbar').getAttribute('aria-valuenow')
  for (const shelf of [
    { name: /^Reading/, count: 1 },
    { name: /^To read/, count: 3 },
    { name: /^Finished/, count: 0 },
    { name: /^All books/, count: 4 },
  ]) {
    await page.getByRole('tab', { name: shelf.name }).click()
    await expect(page.getByRole('tab', { name: shelf.name })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(recentBook).toBeVisible()
    await expect(recentBook.getByRole('heading', { level: 3 })).toHaveText(
      "Alice's Adventures in Wonderland",
    )
    await expect(resumeLink).toHaveAttribute('href', resumeUrl!)
    await expect(recentBook.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      recentProgress!,
    )
    await expect(page.locator('.book-tile')).toHaveCount(shelf.count)
  }
  await resumeLink.click()
  await expect(page.locator('.reader-location')).toHaveAttribute('title', /40%/)

  await page.getByRole('button', { name: 'Reading settings', exact: true }).click()
  await expectFullHeightSettings(page)
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
  await expect(page.locator('tbody tr')).toHaveCount(4)
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
  await expect(page.locator('.book-tile')).toHaveCount(4, { timeout: 45_000 })
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
  await expect(page.locator('.book-tile')).toHaveCount(5)
  await page.getByRole('button', { name: 'Import book', exact: true }).click()
  await page.getByLabel('Import EPUB or text files').setInputFiles(file)
  await expect(page.getByRole('dialog', { name: 'Import a book', exact: true })).not.toBeVisible({
    timeout: 45_000,
  })
  await expect(page.locator('.book-tile')).toHaveCount(5)
  await page.locator('.tile-title').filter({ hasText: 'A quiet morning' }).click()
  await expect(page.locator('.chapter-list-item')).toHaveCount(50)
  await page.getByRole('textbox', { name: 'Search table of contents' }).fill('105')
  await expect(page.locator('.chapter-list-item')).toHaveCount(1)
  await page.locator('.chapter-list-item').click()
  await expect(page.locator('.chapter-body')).toContainText('This is section 105.')
  await page.getByRole('link', { name: 'Back to book details' }).click()
  await page.getByRole('button', { name: 'Actions for A quiet morning', exact: true }).click()
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
  await expect(page.locator('tbody tr')).toHaveCount(4)
  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(4)
  await expectNoOverflow(page)
})
