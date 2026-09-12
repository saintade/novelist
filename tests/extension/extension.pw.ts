import { test, expect, chromium, type BrowserContext } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { trainingFixtures } from '../../server/scraper/fixtures'
import { identificationCost } from '../../src/lib/ai/pricing'
import { discoverContents } from '../../src/lib/extension/contents'
import type { NovelInspection } from '../../src/lib/extension/contracts'
import type { LibraryEntry } from '../../src/lib/extension/library-catalog'

async function setup({
  autoConnect = false,
  browserAccess = false,
}: { autoConnect?: boolean; browserAccess?: boolean } = {}) {
  const requests: { path: string; body?: Record<string, unknown> }[] = []
  const inspection: NovelInspection = {
    classification: 'index',
    title: 'The River Ledger',
    originalTitle: '\u6cb3\u7554\u8d26\u518c',
    author: 'N. Vale',
    originalAuthor: null,
    language: 'zh-Hant',
    synopses: [
      {
        label: 'Synopsis',
        text: 'Two clerks mend a damaged ferry ledger.',
        originalText: '\u539f\u6587\u7b80\u4ecb',
      },
      {
        label: 'Alternate introduction',
        text: 'A missing page leads to the river.',
        originalText: null,
      },
    ],
    coverImage: { url: 'https://books.example.test/cover.png', alt: 'River Ledger cover' },
    genres: ['Fantasy'],
    tags: ['Adventure'],
    publicationStatus: 'Ongoing',
    chapterCount: 120,
    wordCount: null,
    updatedAt: null,
    additionalMetadata: [
      { field: 'Publisher', value: 'River Press', originalField: null, originalValue: null },
    ],
    reason: 'Novel heading and a chapter list are visible.',
    chapterLinks: [
      { title: '1. The Rain', url: trainingFixtures[1].page.url },
      { title: '2. The Crossing', url: 'https://books.example.test/river-ledger/2' },
    ],
    indexUrl: 'https://books.example.test/river-ledger/contents',
  }
  const jobs = new Map<string, unknown>()
  const downloadedUrls = new Map<string, Set<string>>()
  const downloadAliases = new Map<string, Record<string, string>>()
  let holdDownloads = false
  let modelChapter: string | null = null
  const heldDownloads: (() => void)[] = []
  let savedNavigation: unknown[] = []
  const library: LibraryEntry[] = [
    {
      id: 'e'.repeat(32),
      novelId: 'a1b2c3d4-e5f6-0a1b-2345-6789abcdef01',
      title: 'Accounts at Qinglan Crossing',
      originalTitle: '\u9752\u5c9a\u6e21\u53e3',
      author: 'N. Vale',
      language: 'zh',
      description: 'Two clerks mend a damaged ferry ledger.',
      aliases: [],
      sources: [
        {
          id: 'original-source',
          label: 'Chinese original',
          language: 'zh',
          role: 'original',
          url: 'https://original.example.test/crossing',
        },
      ],
    },
    {
      id: 'd'.repeat(32),
      novelId: '0a94c496-d456-499a-a9e7-2a87cf86f1d5',
      title: 'Alice in Wonderland',
      originalTitle: '',
      author: 'Lewis Carroll',
      language: 'en',
      description: 'An unrelated classic.',
      aliases: [],
      sources: [],
    },
  ]
  let failedTest = false
  let unavailableJobs = false
  let savedNovel = false
  let connectionInvalidated = false
  let backendAvailable = true
  let contentsSaveFailed = false
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Novelist-Extension-Id',
    )
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE')
    const path = request.url?.split('?')[0] || '/'
    const json = (body: unknown, status = 200) => {
      response.statusCode = status
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(body))
    }
    if (request.method === 'OPTIONS') {
      json({})
      return
    }
    if (path === '/extension/connect') {
      response.setHeader('Content-Type', 'text/html')
      response.end(
        '<!doctype html><html><body><h1>Connecting test extension</h1><script>(async () => { const parameters = new URLSearchParams(location.search); const id = parameters.get("extensionId"); const nonce = parameters.get("nonce"); const ready = await chrome.runtime.sendMessage(id, {type:"novelist-connect-ready",nonce}); if (!ready.ok) { document.querySelector("h1").textContent = ready.error; return; } const result = await chrome.runtime.sendMessage(id, {type:"novelist-pair",nonce,code:"a".repeat(64)}); document.querySelector("h1").textContent = result.ok ? "Connected" : result.error; })();</script></body></html>',
      )
      return
    }
    const buffers: Buffer[] = []
    for await (const part of request) buffers.push(Buffer.from(part))
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : undefined
    requests.push({ path, body })
    if (!backendAvailable) {
      json({ error: 'The local backend is temporarily offline.' }, 503)
      return
    }
    if (path === '/api/extension/ready') {
      json({ app: 'novelist', protocol: 1 })
      return
    }
    if (path === '/api/extension/connect') {
      connectionInvalidated = false
      json({ token: 'test-extension-token', expiresAt: Date.now() + 1_800_000 })
      return
    }
    if (connectionInvalidated || request.headers.authorization !== 'Bearer test-extension-token') {
      json({ error: 'Reconnect first.' }, 401)
      return
    }
    if (path === '/api/extension/status') {
      json({
        liveEnabled: true,
        model: 'mock-model',
        identificationModel: 'gpt-5-nano',
        expiresAt: Date.now() + 1_800_000,
      })
      return
    }
    if (path === '/api/extension/connection') {
      json({ disconnected: true })
      return
    }
    if (path === '/api/extension/navigation/site') {
      if (body.recipes) savedNavigation = body.recipes
      json({ recipes: savedNavigation })
      return
    }
    if (path === '/api/extension/library') {
      if (request.method === 'GET') {
        json({ books: library })
        return
      }
      if (body.title === 'Save failure') {
        json({ error: 'Library temporarily unavailable.' }, 503)
        return
      }
      const existingBook = library.find((book) => book.id === 'b'.repeat(32))
      if (!existingBook)
        library.push({
          id: 'b'.repeat(32),
          novelId: '8d8e803d-6f7e-4cd2-ae13-795f7430db28',
          title: body.title,
          originalTitle: '',
          author: body.author,
          language: 'zh',
          description: '',
          aliases: [],
          sources: [
            {
              id: 'new-source',
              url: trainingFixtures[0].page.url,
              contentsUrl: body.contents?.url || inspection.indexUrl,
              label: 'Original',
              role: 'original',
              language: 'zh',
            },
          ],
        })
      else if (body.overwrite) existingBook.title = body.title
      const savedBook = library.find((book) => book.id === 'b'.repeat(32))!
      if (
        body.novelUpdatesUrl &&
        !savedBook.sources.some((source) => source.url === body.novelUpdatesUrl)
      )
        savedBook.sources.push({
          id: crypto.randomUUID(),
          label: 'Novel Updates',
          url: body.novelUpdatesUrl,
          role: 'metadata',
          language: 'en',
        })
      json({
        bookId: 'b'.repeat(32),
        novelId: '8d8e803d-6f7e-4cd2-ae13-795f7430db28',
        alreadySaved: savedNovel,
        updated: savedNovel && body.overwrite,
      })
      savedNovel = true
      return
    }
    if (path === '/api/extension/library/catalog') {
      const book = library.find((entry) => entry.id === body.bookId)
      if (!book) {
        json({ error: 'Book not found.' }, 404)
        return
      }
      const existing = book.sources.find((source) => source.url === body.url)
      const sourceId = existing?.id ?? crypto.randomUUID()
      if (!existing)
        book.sources.push({
          id: sourceId,
          label: 'Novel Updates',
          url: body.url,
          role: 'metadata',
          language: 'en',
        })
      json({ sourceId })
      return
    }
    if (path === '/api/extension/library/source') {
      const book = library.find((entry) =>
        entry.sources.some((source) => source.url === body.url || source.contentsUrl === body.url),
      )
      json({
        book: book ?? null,
        ...(book
          ? {
              inspection: {
                inspection: {
                  ...inspection,
                  title: book.title,
                  indexUrl: body.url,
                  chapterLinks: [],
                },
                recordId: '195683d2-3a97-46e9-b0df-25f9991957cf',
                sourceUrl: body.url,
                sourceLanguage: book.language,
                outputLanguage: 'en',
                model: 'gpt-5-nano',
                inputTokens: 0,
                outputTokens: 0,
              },
            }
          : {}),
      })
      return
    }
    if (path === '/api/extension/library/contents') {
      if (contentsSaveFailed) {
        json({ error: 'The chapter inventory could not be saved.' }, 409)
        return
      }
      json({ saved: true, foundCount: body.contents.links.length })
      return
    }
    if (path === '/api/extension/library/downloaded') {
      json({
        urls: [...(downloadedUrls.get(body.sourceUrl) ?? [])],
        aliases: downloadAliases.get(body.sourceUrl) ?? {},
      })
      return
    }
    if (path === '/api/extension/library/chapter/start') {
      const chapterUrl = body.page?.url ?? body.requestedUrl
      const id = crypto.randomUUID()
      const job: {
        id: string
        operation: string
        state: string
        stage: string
        download?: unknown
      } = { id, operation: 'download', state: 'running', stage: 'Saving chapter' }
      jobs.set(id, job)
      if (body.page && body.requestedUrl && body.requestedUrl !== body.page.url)
        downloadAliases.set(body.sourceUrl, {
          ...(downloadAliases.get(body.sourceUrl) ?? {}),
          [body.requestedUrl]: body.page.url,
        })
      const complete = () => {
        job.state = 'completed'
        if (chapterUrl === modelChapter && !body.confirmed)
          job.download = { state: 'needs_scraper', message: 'This chapter needs a scraper repair.' }
        else {
          const saved = downloadedUrls.get(body.sourceUrl) ?? new Set<string>()
          job.download = {
            state: 'ready',
            title: 'Saved chapter',
            cached: saved.has(chapterUrl),
            canonicalUrl: chapterUrl,
          }
          saved.add(chapterUrl)
          downloadedUrls.set(body.sourceUrl, saved)
        }
      }
      if (holdDownloads) heldDownloads.push(complete)
      else complete()
      json({ id }, 202)
      return
    }
    if (path === '/api/extension/library/chapter') {
      json(
        body.confirmed
          ? { state: 'ready', title: 'Chapter 1', cached: false }
          : {
              state: 'needs_scraper',
              message: 'Confirm model use before generating the downloader.',
            },
      )
      return
    }
    if (path === '/api/extension/library/matches') {
      jobs.set('match-job', {
        id: 'match-job',
        operation: 'match',
        state: 'completed',
        stage: 'Complete',
        matches: {
          recordId: body.recordId,
          matches: [
            {
              bookId: library[0].id,
              score: 0,
              method: 'model',
              reason:
                'The supplied synopses share two clerks and a damaged ferry ledger; the translated titles differ.',
            },
          ],
          candidatesCompared: library.length,
          librarySize: library.length,
          model: body.model || 'gpt-5-nano',
          inputTokens: 600,
          outputTokens: 80,
        },
      })
      json({ id: 'match-job' }, 202)
      return
    }
    if (path === '/api/extension/library/pair') {
      if (body.label === 'Pair failure') {
        json({ error: 'Pairing temporarily unavailable.' }, 503)
        return
      }
      const book = library.find((entry) => entry.id === body.bookId)!
      const url = inspection.indexUrl!
      const alreadyPaired = book.sources.some((source) => source.url === url)
      const sourceId = 'a24cc7cc-4616-4e23-a2ab-6fe1fffb6b6f'
      if (!alreadyPaired)
        book.sources.push({
          id: sourceId,
          url,
          label: body.label,
          language: body.language,
          role: body.role,
        })
      json({ bookId: book.id, novelId: book.novelId, sourceId, url, alreadyPaired })
      return
    }
    if (path === '/api/extension/estimate') {
      json(
        identificationCost(
          body.model || 'gpt-5-nano',
          { inputTokens: 8000, cachedInputTokens: 0, outputTokens: 2000, reasoningTokens: 0 },
          {
            basis: 'preflight',
            capturedCharacters:
              body.page.html.length + (body.metadataReference?.page.html.length ?? 0),
          },
        ),
      )
      return
    }
    if (path === '/api/extension/inspect') {
      jobs.set('inspection-job', {
        id: 'inspection-job',
        operation: 'inspect',
        state: 'completed',
        stage: 'Complete',
        inspection: {
          inspection,
          schemaVersion: 3,
          sourceLanguage: inspection.language,
          outputLanguage: body.outputLanguage,
          sourceUrl: body.page.url,
          rawExtraction: inspection,
          referenceVersions: body.referenceVersions,
          metadataReference: body.metadataReference
            ? {
                url: body.metadataReference.page.url,
                title: body.metadataReference.title,
                capturedHtmlHash: 'f'.repeat(64),
              }
            : undefined,
          recordId: '195683d2-3a97-46e9-b0df-25f9991957cf',
          model: body.model || 'gpt-5-nano',
          inputTokens: 8000,
          outputTokens: 2000,
          cost: identificationCost(
            body.model || 'gpt-5-nano',
            { inputTokens: 8000, cachedInputTokens: 0, outputTokens: 2000, reasoningTokens: 300 },
            {
              basis: 'reported-usage',
              capturedCharacters:
                body.page.html.length + (body.metadataReference?.page.html.length ?? 0),
            },
          ),
        },
      })
      json({ id: 'inspection-job' }, 202)
      return
    }
    if (path === '/api/extension/test') {
      jobs.set(
        'scrape-job',
        failedTest
          ? {
              id: 'scrape-job',
              operation: 'test',
              state: 'failed',
              stage: 'Stopped',
              error: 'The model is unavailable. No scraping was completed.',
            }
          : {
              id: 'scrape-job',
              operation: 'test',
              state: 'completed',
              stage: 'Complete',
              scrape: {
                code: 'export default () => ({kind: "blocked", reason: "Test code only"})',
                sampledPages: (body.sampleUrls as string[]).map((url) => ({ url })),
                report: {
                  id: 'test-report',
                  adapter: {
                    origin: 'https://books.example.test',
                    codeHash: 'a'.repeat(64),
                    strategy: 'reused',
                  },
                  mode: 'fixture',
                  model: null,
                  status: 'needs_review',
                  attempts: [
                    {
                      number: 1,
                      inputTokens: 0,
                      outputTokens: 0,
                      checks: [
                        {
                          url: trainingFixtures[1].page.url,
                          passed: true,
                          issues: [],
                          output: trainingFixtures[1].expected,
                        },
                      ],
                    },
                  ],
                  inputTokens: 0,
                  outputTokens: 0,
                },
              },
            },
      )
      json({ id: 'scrape-job' }, 202)
      return
    }
    if (path.startsWith('/api/extension/jobs/')) {
      if (request.method === 'DELETE') {
        jobs.delete(path.split('/').at(-1)!)
        json({ removed: true })
        return
      }
      if (unavailableJobs) json({ error: 'The local connection was interrupted.' }, 503)
      else {
        const job = jobs.get(path.split('/').at(-1)!)
        json(job || { error: 'Unknown job' }, job ? 200 : 404)
      }
      return
    }
    json({ error: 'Unexpected mock request' }, 404)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server unavailable')
  const backendOrigin = `http://127.0.0.1:${address.port}`
  let context: BrowserContext
  const extensionPath = browserAccess
    ? await mkdtemp(resolve(tmpdir(), 'novelist-extension-test-'))
    : resolve('dist-extension')
  try {
    if (browserAccess) {
      await cp(resolve('dist-extension'), extensionPath, { recursive: true })
      const manifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8'))
      manifest.host_permissions.push('https://books.example.test/*')
      await writeFile(resolve(extensionPath, 'manifest.json'), JSON.stringify(manifest))
    }
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 390, height: 900 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
  } catch (failure) {
    server.close()
    if (browserAccess) await rm(extensionPath, { recursive: true, force: true })
    throw failure
  }
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'))
  const extensionId = new URL(worker.url()).hostname
  await worker.evaluate(
    async ({ backendOrigin, autoConnect }) => {
      await chrome.storage.local.set({ backendOrigin, autoConnectPaused: !autoConnect })
    },
    { backendOrigin, autoConnect },
  )
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extensionId}/panel.html`)
  return {
    context,
    worker,
    panel,
    backendOrigin,
    requests,
    inspection,
    library,
    downloadedUrls,
    holdDownloads: () => {
      holdDownloads = true
    },
    releaseDownloads: () => {
      holdDownloads = false
      heldDownloads.splice(0).forEach((complete) => complete())
    },
    requireChapterModel: (url: string) => {
      modelChapter = url
    },
    invalidateConnection: () => {
      connectionInvalidated = true
    },
    setBackendAvailable: (available: boolean) => {
      backendAvailable = available
    },
    setContentsSaveFailed: (failed: boolean) => {
      contentsSaveFailed = failed
    },
    failScrape: () => {
      failedTest = true
    },
    interruptJobs: () => {
      unavailableJobs = true
    },
    close: async () => {
      await context.close()
      await new Promise<void>((done) => server.close(() => done()))
      if (browserAccess) await rm(extensionPath, { recursive: true, force: true })
    },
  }
}

test('installed extension pairs, identifies a page, confirms selected chapter tests and shows results', async () => {
  const testInfo = test.info()
  const extension = await setup({ autoConnect: true, browserAccess: true })
  const { panel, context, worker, requests, backendOrigin } = extension
  await context.route('https://books.example.test/cover.png', (route) =>
    route.fulfill({ contentType: 'image/png', path: resolve('dist-extension/icon-128.png') }),
  )
  const failures: string[] = []
  panel.on('pageerror', (error) => failures.push(error.message))
  try {
    await expect(panel.getByText('Connected to Novelist', { exact: true })).toBeVisible()
    await expect
      .poll(
        () => context.pages().filter((page) => page.url().includes('/extension/connect')).length,
      )
      .toBe(0)
    expect(requests.some((request) => request.path === '/api/extension/connect')).toBe(true)
    const novelPage = await context.newPage()
    await novelPage.route(trainingFixtures[0].page.url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: trainingFixtures[0].page.html.replace(
          '</body>',
          '<form><input value="CAPTURE_SECRET" /></form><!-- COMMENT_SECRET --></body>',
        ),
      }),
    )
    await novelPage.goto(trainingFixtures[0].page.url)
    await novelPage.addScriptTag({ path: resolve('dist-extension/capture.js') })
    const capture = await novelPage.evaluate(() => {
      const scope = globalThis as typeof globalThis & { __novelistCapture: () => unknown }
      return scope.__novelistCapture()
    })
    expect(JSON.stringify(capture)).not.toContain('SECRET')
    expect(JSON.stringify(capture)).toContain('Two clerks mend a damaged ferry ledger.')
    await worker.evaluate(async (capture) => {
      const tabs = await chrome.tabs.query({ url: 'https://books.example.test/*' })
      await chrome.storage.session.set({
        capture: {
          ...(capture as Record<string, unknown>),
          tabId: tabs[0].id,
          capturedAt: 'fixture-capture',
        },
      })
    }, capture)
    await panel.bringToFront()
    await expect(panel.getByRole('button', { name: 'Analyze page' })).toBeEnabled()
    await expect(panel.getByRole('button', { name: 'Analyze page' })).toHaveCSS(
      'margin-top',
      '12px',
    )
    await expect(
      panel.getByRole('checkbox', { name: 'Send this page to OpenAI for identification.' }),
    ).toHaveCount(0)
    await panel.getByRole('tab', { name: 'Settings', exact: true }).click()
    const outputLanguage = panel.getByRole('combobox', { name: 'Output language' })
    await expect(outputLanguage).toHaveValue('en')
    const analysisModel = panel.getByRole('combobox', { name: 'Analysis model', exact: true })
    await expect(analysisModel).toHaveValue('')
    await analysisModel.selectOption('gpt-4.1-nano')
    await panel.getByRole('button', { name: 'Use as default', exact: true }).click()
    await panel.reload()
    await panel.getByRole('tab', { name: 'Settings', exact: true }).click()
    await expect(analysisModel).toHaveValue('gpt-4.1-nano')
    await analysisModel.selectOption('gpt-4o-mini')
    await expect(panel.getByRole('button', { name: 'Pair version', exact: true })).toHaveCount(0)
    await panel.getByRole('tab', { name: 'Metadata', exact: true }).click()
    await panel
      .getByRole('textbox', { name: 'Novel Updates URL', exact: true })
      .fill('https://www.novelupdates.com/series/river-ledger-fixture/')
    await panel.getByRole('button', { name: 'Link Novel Updates', exact: true }).click()
    await expect(panel.getByRole('link', { name: 'Novel Updates linked' })).toBeVisible()
    await panel.getByRole('tab', { name: 'Settings', exact: true }).click()
    await outputLanguage.selectOption('fr')
    await panel.getByRole('button', { name: 'Estimate costs' }).click()
    await expect(panel.getByRole('region', { name: 'Identification cost' })).toContainText(
      '8,000 input tokens',
    )
    expect(
      requests.find((request) => request.path === '/api/extension/estimate')?.body,
    ).toMatchObject({ outputLanguage: 'fr', model: 'gpt-4o-mini' })
    await outputLanguage.selectOption('en')
    expect(requests.filter((request) => request.path === '/api/extension/inspect')).toHaveLength(0)
    await panel.getByRole('button', { name: 'Analyze page' }).click()
    await expect(panel.locator('.novel-title')).toHaveText('The River Ledger')
    await panel.getByRole('tab', { name: 'Metadata', exact: true }).click()
    await expect(panel.getByText('N. Vale', { exact: true })).toBeVisible()
    expect(
      requests.find((request) => request.path === '/api/extension/inspect')?.body,
    ).toMatchObject({
      outputLanguage: 'en',
      model: 'gpt-4o-mini',
      referenceVersions: [],
    })
    expect(
      await worker.evaluate(
        async () => (await chrome.storage.local.get('analysisModel')).analysisModel,
      ),
    ).toBe('gpt-4.1-nano')
    expect(
      requests.find((request) => request.path === '/api/extension/inspect')?.body,
    ).not.toHaveProperty('sourceLanguage')
    await expect(panel.getByText('Traditional Chinese', { exact: true })).toBeVisible()
    await expect(panel.getByRole('heading', { name: 'Alternate introduction' })).toBeVisible()
    await expect(
      panel.getByText('A missing page leads to the river.', { exact: true }),
    ).toBeVisible()
    await expect(panel.getByText('Page evidence', { exact: true })).toHaveCount(0)
    await expect(panel.getByRole('img', { name: 'River Ledger cover' })).toBeVisible()
    await expect
      .poll(() =>
        panel
          .locator('.identification-cover')
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0)
    await expect(panel.getByText('River Press', { exact: true })).toBeVisible()
    await panel.getByText('Compare model costs', { exact: true }).click()
    await expect(panel.locator('.identification-costs tbody tr')).toHaveCount(8)
    const metadataDownload = panel.waitForEvent('download')
    await panel.getByRole('button', { name: 'Identification JSON' }).click()
    const metadataFile = await metadataDownload
    expect(metadataFile.suggestedFilename()).toBe(
      'novelist-identification-the-river-ledger-books-example-test-195683d2.json',
    )
    const metadata = JSON.parse(await readFile((await metadataFile.path())!, 'utf8'))
    expect(metadata).toMatchObject({
      sourceLanguage: 'zh-Hant',
      outputLanguage: 'en',
      recordId: '195683d2-3a97-46e9-b0df-25f9991957cf',
    })
    expect(metadata.rawExtraction.synopses).toHaveLength(2)
    await novelPage.route('https://books.example.test/river-ledger/contents', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><head><title>Contents</title></head><body><a href="/river-ledger/3">Chapter 3</a><a href="/river-ledger/2">Chapter 2</a><a href="/river-ledger/1">Chapter 1</a></body></html>',
      }),
    )
    await novelPage.goto('https://books.example.test/river-ledger/contents')
    await novelPage.addScriptTag({ path: resolve('dist-extension/capture.js') })
    const contentsCapture = await novelPage.evaluate(() =>
      (
        globalThis as typeof globalThis & { __novelistContents: () => unknown }
      ).__novelistContents(),
    )
    const discovery = discoverContents(
      contentsCapture as Parameters<typeof discoverContents>[0],
      metadata.inspection,
    )
    await worker.evaluate(
      async ({ contentsCapture, discovery }) => {
        const state = await chrome.storage.session.get('inspection')
        await chrome.storage.session.set({
          contentsCapture,
          inspection: { ...(state.inspection as Record<string, unknown>), contents: discovery },
        })
      },
      { contentsCapture, discovery },
    )
    await panel.bringToFront()
    await panel.getByRole('tab', { name: 'Chapters', exact: true }).click()
    await expect(panel.getByRole('region', { name: 'Discovered chapters' })).toContainText(
      '3 chapter links found',
    )
    await expect(panel.getByRole('region', { name: 'Discovered chapters' })).toContainText(
      'oldest first',
    )
    await expect(panel.getByRole('combobox', { name: 'Chapter' })).toHaveValue(
      'https://books.example.test/river-ledger/1',
    )
    await panel.getByRole('button', { name: 'Add book to library', exact: true }).click()
    const saveDialog = panel.getByRole('dialog', { name: 'Save novel to library' })
    await saveDialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Save failure')
    await saveDialog.getByRole('button', { name: 'Save to library', exact: true }).click()
    await expect(saveDialog.getByRole('alert')).toContainText('Library temporarily unavailable')
    await expect(saveDialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Save failure',
    )
    await saveDialog
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Reviewed River Ledger')
    await saveDialog.getByRole('button', { name: 'Save to library', exact: true }).click()
    await expect(
      panel.getByRole('link', { name: 'Open in Novelist', exact: true }),
    ).toHaveAttribute('href', `${backendOrigin}/books/${'b'.repeat(32)}`)
    const savedRequest = requests
      .filter((request) => request.path === '/api/extension/library' && request.body)
      .at(-1)!.body!
    expect(savedRequest).toMatchObject({
      title: 'Reviewed River Ledger',
      overwrite: false,
      referenceVersions: [],
      novelUpdatesUrl: 'https://www.novelupdates.com/series/river-ledger-fixture/',
    })
    expect((savedRequest.contents as { links: unknown[] }).links).toHaveLength(3)
    await expect(panel.getByRole('link', { name: 'Open in Novelist', exact: true })).toHaveCount(1)
    await panel.getByRole('tab', { name: 'Metadata', exact: true }).click()
    await panel.getByRole('button', { name: 'Edit saved metadata', exact: true }).click()
    await saveDialog
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Updated River Ledger')
    await saveDialog.getByRole('button', { name: 'Save to library', exact: true }).click()
    await expect(saveDialog).not.toBeVisible()
    expect(
      requests
        .filter((request) => request.path === '/api/extension/library' && request.body)
        .at(-1)!.body,
    ).toMatchObject({ title: 'Updated River Ledger', overwrite: true })
    expect(requests.filter((request) => request.path === '/api/extension/test')).toHaveLength(0)
    await panel.getByRole('tab', { name: 'Chapters', exact: true }).click()
    await novelPage.route(trainingFixtures[1].page.url, (route) =>
      route.fulfill({ contentType: 'text/html', body: trainingFixtures[1].page.html }),
    )
    await panel
      .getByRole('combobox', { name: 'Chapter' })
      .selectOption(trainingFixtures[1].page.url)
    await panel.evaluate(() => window.scrollTo(0, 0))
    await panel.screenshot({
      path: testInfo.outputPath('novel-inspection.png'),
      fullPage: true,
      animations: 'disabled',
    })
    await panel.getByRole('button', { name: 'Test chapter extraction', exact: true }).click()
    const confirmation = panel.getByRole('dialog', { name: 'Confirm scrape test' })
    await expect(
      confirmation.getByRole('button', { name: 'Test chapter', exact: true }),
    ).toBeDisabled()
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(requests.filter((request) => request.path === '/api/extension/test')).toHaveLength(0)
    await panel.getByRole('button', { name: 'Test chapter extraction', exact: true }).click()
    await confirmation
      .getByRole('checkbox', {
        name: 'I have permission to scrape and send these pages to OpenAI.',
        exact: true,
      })
      .check()
    await confirmation.getByRole('button', { name: 'Test chapter', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'Chapter extraction passed' })).toBeVisible()
    await expect(
      panel.getByText('Reused site scraper. No model call.', { exact: true }),
    ).toBeVisible()
    const submitted = requests.find((request) => request.path === '/api/extension/test')!.body!
    expect(submitted.sampleUrls).toEqual([])
    expect(submitted).toMatchObject({
      rightsConfirmed: true,
      sendToModelConfirmed: true,
      expectedKind: 'chapter',
      page: { url: trainingFixtures[1].page.url },
    })
    expect(submitted.contents).toBeUndefined()
    expect(submitted.browserPages).toBeUndefined()
    const browserUrl = novelPage.url()
    await panel
      .getByRole('combobox', { name: 'Chapter', exact: true })
      .selectOption('https://books.example.test/river-ledger/2')
    await panel.getByRole('button', { name: 'Test chapter extraction', exact: true }).click()
    await confirmation
      .getByRole('combobox', { name: 'Page access', exact: true })
      .selectOption('http')
    await confirmation
      .getByRole('checkbox', { name: 'Rebuild cached scraper', exact: true })
      .check()
    await confirmation
      .getByRole('checkbox', {
        name: 'I have permission to scrape and send these pages to OpenAI.',
        exact: true,
      })
      .check()
    await confirmation.getByRole('button', { name: 'Test chapter', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'Chapter extraction passed' })).toBeVisible()
    expect(novelPage.url()).toBe(browserUrl)
    const direct = requests
      .filter((request) => request.path === '/api/extension/test')
      .at(-1)!.body!
    expect(direct).toMatchObject({
      sampleUrls: ['https://books.example.test/river-ledger/2'],
      fetchOnly: true,
      forceRegenerate: true,
      expectedKind: 'chapter',
    })
    expect(direct.contents).toBeTruthy()
    await panel.locator('.page-result summary').click()
    await expect(panel.getByText('The rain stopped before dawn.', { exact: true })).toBeVisible()
    await panel.getByText('Extraction report', { exact: true }).click()
    const file = panel.waitForEvent('download')
    await panel.getByRole('button', { name: 'Scraper code', exact: true }).click()
    expect((await file).suggestedFilename()).toBe('novelist-scraper.mjs')
    await panel.evaluate(() => window.scrollTo(0, 0))
    await panel.screenshot({
      path: testInfo.outputPath('scrape-result.png'),
      fullPage: true,
      animations: 'disabled',
    })
    await panel.setViewportSize({ width: 300, height: 800 })
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    )
    await panel.reload()
    await expect(panel.getByRole('heading', { name: 'Chapter extraction passed' })).toBeVisible()
    await panel.screenshot({
      path: testInfo.outputPath('scrape-result-narrow.png'),
      fullPage: true,
    })
    expect(failures).toEqual([])
    const manifest = JSON.parse(await readFile(resolve('dist-extension/manifest.json'), 'utf8'))
    expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage', 'sidePanel'])
    expect(manifest.host_permissions).not.toContain('<all_urls>')
    const method = panel.getByRole('combobox', { name: 'Download method', exact: true })
    await expect(method).toHaveValue('http')
    await panel
      .getByRole('combobox', { name: 'Chapter', exact: true })
      .selectOption('https://books.example.test/river-ledger/2')
    await panel.getByRole('button', { name: 'Download chapter', exact: true }).click()
    await expect(
      panel.getByText('Chapter saved. Ready to read in Novelist.', { exact: true }),
    ).toBeVisible()
    expect(novelPage.url()).toBe(browserUrl)
    expect(
      requests.filter((request) => request.path.endsWith('/chapter/start')).at(-1)!.body,
    ).toMatchObject({ requestedUrl: 'https://books.example.test/river-ledger/2' })
    expect(
      requests.filter((request) => request.path.endsWith('/chapter/start')).at(-1)!.body,
    ).not.toHaveProperty('page')
    extension.holdDownloads()
    await panel.getByRole('button', { name: 'Download all', exact: true }).click()
    await expect
      .poll(() => requests.filter((request) => request.path.endsWith('/chapter/start')).length)
      .toBe(2)
    await panel.getByRole('tab', { name: 'Metadata', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Pause downloads', exact: true })).toBeHidden()
    await panel.getByRole('tab', { name: 'Chapters', exact: true }).click()
    await panel.getByRole('button', { name: 'Pause downloads', exact: true }).click()
    extension.releaseDownloads()
    const progress = panel.getByRole('region', { name: 'Batch download progress' })
    await expect(progress).toContainText('Paused.')
    expect(novelPage.url()).toBe(browserUrl)
    await novelPage.route('https://books.example.test/river-ledger/3', (route) =>
      route.fulfill({ contentType: 'text/html', body: trainingFixtures[1].page.html }),
    )
    await method.selectOption('browser')
    await panel.getByRole('button', { name: 'Resume downloads', exact: true }).click()
    await expect(progress).toContainText('Downloads complete.')
    await expect(progress).toContainText('3 / 3 processed / 2 saved / 1 already saved')
    expect(novelPage.url()).toBe('https://books.example.test/river-ledger/3')
    expect(
      requests.filter((request) => request.path.endsWith('/chapter/start')).at(-1)!.body,
    ).toHaveProperty('page')
    await method.selectOption('http')
    await panel.reload()
    await expect(method).toHaveValue('http')
    await panel.getByRole('button', { name: 'Download all', exact: true }).click()
    await expect(progress).toContainText('0 saved / 3 already saved')
    expect(requests.filter((request) => request.path.endsWith('/chapter/start'))).toHaveLength(3)
  } finally {
    await extension.close()
  }
})

test('auto-connect renews lost sessions, rejects unsolicited handshakes and respects Disconnect', async () => {
  const extension = await setup({ autoConnect: true })
  const { panel, worker, context, backendOrigin, requests } = extension
  const connections = () =>
    requests.filter((request) => request.path === '/api/extension/connect').length
  const sync = async () => panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'sync' }))
  try {
    await expect(panel.getByText('Connected to Novelist', { exact: true })).toBeVisible()
    await expect.poll(connections).toBe(1)
    await worker.evaluate(async (page) => {
      await chrome.storage.session.set({
        capture: {
          page,
          pageTitle: 'Retained capture',
          preview: 'Retained capture',
          tabId: 1,
          capturedAt: 'auto-connect-capture',
        },
      })
    }, trainingFixtures[0].page)
    const unsolicited = await context.newPage()
    await unsolicited.goto(
      `${backendOrigin}/extension/connect?extensionId=${new URL(worker.url()).hostname}&nonce=${crypto.randomUUID()}`,
    )
    await expect(unsolicited.getByRole('heading')).toContainText('not pending')
    expect(connections()).toBe(1)
    await unsolicited.close()
    const visibleState = await panel.evaluate(
      async () => (await chrome.runtime.sendMessage({ type: 'state' })).state,
    )
    expect(visibleState).not.toHaveProperty('connection')
    expect(visibleState).not.toHaveProperty('connectionAttempt')
    extension.setBackendAvailable(false)
    await sync()
    await expect(panel.getByText('Not connected', { exact: true })).toBeVisible()
    await expect(panel.getByRole('alert')).toContainText('temporarily offline')
    expect(connections()).toBe(1)
    extension.setBackendAvailable(true)
    await sync()
    await expect(panel.getByText('Connected to Novelist', { exact: true })).toBeVisible()
    await expect(panel.getByRole('alert')).toHaveCount(0)
    extension.invalidateConnection()
    await sync()
    await expect.poll(connections).toBe(2)
    await expect(panel.getByText('Connected to Novelist', { exact: true })).toBeVisible()
    await expect(
      panel.getByRole('heading', { name: 'Retained capture', exact: true }),
    ).toBeVisible()
    await worker.evaluate(async () => {
      const state = await chrome.storage.session.get('connection')
      await chrome.storage.session.set({
        connection: { ...state.connection, expiresAt: Date.now() - 1 },
      })
    })
    await panel.reload()
    await expect.poll(connections).toBe(3)
    await expect(panel.getByText('Connected to Novelist', { exact: true })).toBeVisible()
    await expect
      .poll(
        () => context.pages().filter((page) => page.url().includes('/extension/connect')).length,
      )
      .toBe(0)
    expect(
      requests.filter((request) => /\/(?:inspect|test|matches)$/.test(request.path)),
    ).toHaveLength(0)
    await panel.getByRole('button', { name: 'Connection settings' }).click()
    await panel.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(panel.getByText('Not connected', { exact: true })).toBeVisible()
    await panel.reload()
    await sync()
    await expect(panel.getByText('Automatic connection paused.', { exact: true })).toBeVisible()
    expect(connections()).toBe(3)
    await panel.getByRole('button', { name: 'Connect to Novelist', exact: true }).click()
    await expect.poll(connections).toBe(4)
    await expect(panel.getByText('Connected to Novelist', { exact: true })).toBeVisible()
    await expect(
      panel.getByRole('heading', { name: 'Retained capture', exact: true }),
    ).toBeVisible()
    expect(
      await worker.evaluate(
        async () => (await chrome.storage.local.get('autoConnectPaused')).autoConnectPaused,
      ),
    ).toBe(false)
  } finally {
    await extension.close()
  }
})

test('library browsing identifies source books and offers attachment only for Novel Updates', async () => {
  const extension = await setup()
  const { panel, worker, backendOrigin, requests, library } = extension
  const catalogUrl = 'https://www.novelupdates.com/series/river-ledger-fixture/'
  try {
    await worker.evaluate(
      async ({ backendOrigin, page }) => {
        await chrome.storage.local.set({ backendOrigin })
        await chrome.storage.session.set({
          connection: { token: 'test-extension-token', expiresAt: Date.now() + 100_000 },
          capture: {
            page,
            pageTitle: 'An independent reading source',
            preview: 'Captured fixture',
            tabId: 1,
            capturedAt: 'library-capture',
          },
        })
      },
      { backendOrigin, page: trainingFixtures[0].page },
    )
    await panel.reload()
    await panel.getByRole('tab', { name: 'Your library', exact: true }).click()
    await expect(panel.locator('.catalog-books > article')).toHaveCount(2)
    await expect(panel.getByRole('button', { name: 'Compare across languages' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Pair', exact: true })).toHaveCount(0)
    await expect(
      panel.getByRole('button', { name: 'Attach Novel Updates', exact: true }),
    ).toHaveCount(0)
    await panel.getByRole('textbox', { name: 'Search your library' }).fill('original.example.test')
    await expect(panel.locator('.catalog-books > article')).toHaveCount(1)
    await expect(panel.locator('.catalog-source-url')).toHaveText(
      'https://original.example.test/crossing',
    )
    await panel.locator('.catalog-books summary').click()
    await expect(panel.getByRole('link', { name: 'Chinese original' })).toHaveAttribute(
      'href',
      'https://original.example.test/crossing',
    )
    await worker.evaluate(async (catalogUrl) => {
      await chrome.storage.session.remove(['inspection', 'savedSource'])
      await chrome.storage.session.set({
        capture: {
          page: { url: catalogUrl, html: '<h1>Catalog</h1>' },
          pageTitle: 'Catalog',
          preview: '',
          tabId: 1,
          capturedAt: 'catalog-attachment',
        },
      })
    }, catalogUrl)
    await panel.reload()
    await panel.getByRole('tab', { name: 'Your library', exact: true }).click()
    const firstBook = panel
      .locator('.catalog-books > article')
      .filter({ hasText: 'Accounts at Qinglan Crossing' })
    const secondBook = panel
      .locator('.catalog-books > article')
      .filter({ hasText: 'Alice in Wonderland' })
    await firstBook.getByRole('button', { name: 'Attach Novel Updates', exact: true }).click()
    await expect(firstBook.locator('.catalog-linked')).toContainText('Linked')
    await secondBook.getByRole('button', { name: 'Attach Novel Updates', exact: true }).click()
    await expect(secondBook.locator('.catalog-linked')).toContainText('Linked')
    expect(library).toHaveLength(2)
    expect(
      library.every((book) =>
        book.sources.some((source) => source.role === 'metadata' && source.url === catalogUrl),
      ),
    ).toBe(true)
    expect(
      requests
        .filter((request) => request.path.endsWith('/library/catalog'))
        .map((request) => request.body),
    ).toEqual([
      { bookId: 'e'.repeat(32), url: catalogUrl },
      { bookId: 'd'.repeat(32), url: catalogUrl },
    ])
    expect(
      requests.filter((request) => /\/(?:inspect|matches|pair)$/.test(request.path)),
    ).toHaveLength(0)
    await panel.setViewportSize({ width: 300, height: 800 })
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    )
    await panel.evaluate(() => window.scrollTo(0, 0))
    await panel.screenshot({
      path: test.info().outputPath('source-books-narrow.png'),
      fullPage: true,
      animations: 'disabled',
    })
    await panel.reload()
    await panel.getByRole('tab', { name: 'Your library', exact: true }).click()
    await expect(panel.locator('.catalog-linked')).toHaveCount(2)
  } finally {
    await extension.close()
  }
})

test('reopening an existing source restores its novel and saves contents without adding a duplicate', async () => {
  const extension = await setup()
  const { panel, worker, backendOrigin, requests } = extension
  const url = 'https://original.example.test/crossing'
  try {
    await worker.evaluate(
      async ({ backendOrigin, url }) => {
        await chrome.storage.local.set({ backendOrigin })
        await chrome.storage.session.set({
          connection: { token: 'test-extension-token', expiresAt: Date.now() + 100_000 },
          capture: {
            page: { url, html: '<h1>A differently rendered title</h1>' },
            pageTitle: 'A differently rendered title',
            preview: 'Captured fixture',
            tabId: 1,
            capturedAt: 'existing-source',
          },
        })
      },
      { backendOrigin, url },
    )
    await panel.reload()
    const existing = panel.getByRole('region', { name: 'Existing library novel' })
    await expect(existing).toContainText('In your library')
    await panel.getByRole('tab', { name: 'Settings', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Analyze again', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Add to Novelist', exact: true })).toHaveCount(0)
    expect(requests.filter((request) => request.path.endsWith('/inspect'))).toHaveLength(0)
    await expect(panel.getByRole('button', { name: 'Explore contents', exact: true })).toHaveCount(
      0,
    )
    await worker.evaluate(async (url) => {
      const state = await chrome.storage.session.get('inspection')
      await chrome.storage.session.set({
        contentsSaveError: 'Temporary save failure',
        inspection: {
          ...state.inspection,
          contents: {
            url,
            foundCount: 2,
            numberedCount: 2,
            reportedCount: 2,
            pageOrder: 'oldest-first',
            chapters: [],
            nextContentsUrls: [],
            truncated: false,
          },
        },
        contentsCapture: {
          url,
          title: 'Contents',
          truncated: false,
          links: [1, 2, 1].map((position, index) => ({
            title: `Chapter ${position}`,
            url: `https://original.example.test/read/${position}${index === 2 ? '#top' : ''}`,
          })),
        },
      })
    }, url)
    await panel.getByRole('tab', { name: 'Chapters', exact: true }).click()
    await panel.getByRole('button', { name: 'Retry saving', exact: true }).click()
    await expect(panel.getByRole('region', { name: 'Discovered chapters' })).toContainText(
      '2 links saved to Novelist',
    )
    expect(
      requests.find((request) => request.path.endsWith('/library/contents'))?.body,
    ).toMatchObject({
      bookId: 'e'.repeat(32),
      sourceUrl: url,
      contents: {
        links: [
          { title: 'Chapter 1', url: 'https://original.example.test/read/1' },
          { title: 'Chapter 2', url: 'https://original.example.test/read/2' },
        ],
      },
    })
    expect(
      requests.filter((request) => request.path === '/api/extension/library' && request.body),
    ).toHaveLength(0)
    await worker.evaluate(async () => {
      await chrome.storage.session.remove(['savedSource', 'inspection'])
      await chrome.storage.session.set({
        capture: {
          page: {
            url: 'https://original.example.test/another-novel',
            html: '<h1>Another novel</h1>',
          },
          pageTitle: 'Another novel',
          preview: '',
          tabId: 1,
          capturedAt: 'another-source',
        },
      })
    })
    await panel.reload()
    await expect(existing).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Analyze page', exact: true })).toBeVisible()
  } finally {
    await extension.close()
  }
})

test('Novel Updates URL attachment validates links and never analyzes or merges reading books', async () => {
  const extension = await setup()
  const { panel, worker, backendOrigin, requests, library } = extension
  const sourceUrl = 'https://original.example.test/crossing'
  const catalogUrl = 'https://www.novelupdates.com/series/river-ledger-fixture/'
  try {
    await worker.evaluate(
      async ({ backendOrigin, sourceUrl }) => {
        await chrome.storage.local.set({ backendOrigin })
        await chrome.storage.session.set({
          connection: { token: 'test-extension-token', expiresAt: Date.now() + 100_000 },
          capture: {
            page: { url: sourceUrl, html: '<h1>Reading book</h1>' },
            pageTitle: 'Reading book',
            preview: '',
            tabId: 1,
            capturedAt: 'catalog-url-input',
          },
        })
      },
      { backendOrigin, sourceUrl },
    )
    await panel.reload()
    await expect(panel.getByText('In your library', { exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: 'Metadata', exact: true }).click()
    const url = panel.getByRole('textbox', { name: 'Novel Updates URL', exact: true })
    await url.fill('https://freewebnovel.com/novel/another-source')
    await panel.getByRole('button', { name: 'Link Novel Updates', exact: true }).click()
    await expect(panel.getByRole('alert').first()).toContainText('Novel Updates series URL')
    expect(requests.filter((request) => request.path.endsWith('/library/catalog'))).toHaveLength(0)
    await url.fill(catalogUrl)
    await panel.getByRole('button', { name: 'Link Novel Updates', exact: true }).click()
    await expect(panel.getByRole('link', { name: 'Novel Updates linked' })).toHaveAttribute(
      'href',
      catalogUrl,
    )
    expect(library[0].sources.filter((source) => source.role === 'metadata')).toHaveLength(1)
    expect(library[0].sources.find((source) => source.role === 'original')?.url).toBe(sourceUrl)
    await panel.reload()
    await panel.getByRole('tab', { name: 'Metadata', exact: true }).click()
    await expect(url).toHaveValue(catalogUrl)
    await panel.getByRole('button', { name: 'Link Novel Updates', exact: true }).click()
    await expect(panel.getByRole('link', { name: 'Novel Updates linked' })).toBeVisible()
    expect(library[0].sources.filter((source) => source.role === 'metadata')).toHaveLength(1)
    expect(
      requests.filter((request) => /\/(?:inspect|matches|pair)$/.test(request.path)),
    ).toHaveLength(0)
    await panel.setViewportSize({ width: 300, height: 800 })
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    )
    await panel.evaluate(() => window.scrollTo(0, 0))
    await panel.screenshot({
      path: test.info().outputPath('catalog-link-narrow.png'),
      fullPage: true,
      animations: 'disabled',
    })
  } finally {
    await extension.close()
  }
})

test('scan expands all chapter links, imports the novel and tests exactly one selected chapter', async () => {
  const extension = await setup({ browserAccess: true })
  const { panel, worker, context, backendOrigin, requests, inspection } = extension
  inspection.indexUrl = null
  inspection.classification = 'catalog'
  inspection.chapterLinks = []
  inspection.chapterCount = 754
  try {
    const novelPage = await context.newPage()
    await novelPage.route('https://books.example.test/dynamic', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><head><title>A dynamic novel</title></head><body><h1>A dynamic novel</h1><a id="expand" href="javascript:expand()">Expand all 754 chapters</a><div id="contents"><a href="/river-ledger/1">Chapter 1</a><a href="/river-ledger/2">Chapter 2</a></div><script>function expand() { document.getElementById("contents").innerHTML = Array.from({length:754}, (_, index) => `<a href="/river-ledger/${index+1}">Chapter ${index+1}</a>`).join(""); document.getElementById("expand").remove() }</script></body></html>',
      }),
    )
    await novelPage.goto('https://books.example.test/dynamic')
    await novelPage.addScriptTag({ path: resolve('dist-extension/capture.js') })
    const observed = await novelPage.evaluate(() => {
      const api = (
        globalThis as typeof globalThis & {
          __novelistNavigation: ReturnType<
            typeof import('../../src/lib/extension/navigation-dom').createNavigationDOM
          >
        }
      ).__novelistNavigation
      const before = api.observe()
      const captured = api.capture()
      const control = before.controls.find((entry) => entry.label.includes('Expand all'))!
      api.act(before.id, {
        action: 'click',
        controlId: control.id,
        value: null,
        intent: 'load_more',
        pageType: 'contents',
        repeat: false,
        reason: 'Expand the chapter index.',
      })
      return { captured, before, control }
    })
    await expect(novelPage.locator('#contents a')).toHaveCount(754)
    const batches = await novelPage.evaluate(() => {
      const api = (
        globalThis as typeof globalThis & {
          __novelistNavigation: ReturnType<
            typeof import('../../src/lib/extension/navigation-dom').createNavigationDOM
          >
        }
      ).__novelistNavigation
      const snapshot = api.observe()
      const counts: number[] = []
      let cursor: number | null = 0
      while (cursor !== null) {
        const batch = api.links(snapshot.id, cursor)
        counts.push(batch.links.length)
        cursor = batch.next
      }
      return { chapterCount: snapshot.chapterLinkCount, counts }
    })
    expect(observed.before.chapterLinkCount).toBe(2)
    expect(observed.control.url).toBeNull()
    expect(JSON.stringify(observed.before)).not.toContain('javascript:')
    expect(batches.chapterCount).toBe(754)
    expect(batches.counts).toEqual([500, 254])
    const landingUrl = 'https://books.example.test/landing'
    await novelPage.route(landingUrl, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body:
          '<html><head><title>A dynamic novel</title></head><body><h1>A dynamic novel</h1><a href="/dynamic">Complete directory</a><section>' +
          [749, 750, 751, 752, 753, 754]
            .map((position) => `<a href="/river-ledger/${position}">Chapter ${position}</a>`)
            .join('') +
          '</section></body></html>',
      }),
    )
    await novelPage.goto(landingUrl)
    await novelPage.addScriptTag({ path: resolve('dist-extension/capture.js') })
    const landingCapture = await novelPage.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __novelistNavigation: ReturnType<
            typeof import('../../src/lib/extension/navigation-dom').createNavigationDOM
          >
        }
      ).__novelistNavigation.capture(),
    )
    const chapterUrl = 'https://books.example.test/river-ledger/700'
    await novelPage.route(chapterUrl, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<h1>Chapter 700</h1><p>Rendered fixture prose for the selected chapter only.</p>',
      }),
    )
    await worker.evaluate(
      async ({ backendOrigin, captured, inspection }) => {
        const tabs = await chrome.tabs.query({ url: 'https://books.example.test/*' })
        await chrome.storage.local.set({ backendOrigin })
        await chrome.storage.session.set({
          connection: { token: 'test-extension-token', expiresAt: Date.now() + 100_000 },
          liveEnabled: true,
          capture: {
            page: captured,
            pageTitle: 'A dynamic novel',
            preview: 'Captured fixture',
            tabId: tabs[0].id,
            capturedAt: 'navigation-capture',
          },
          inspection: {
            inspection,
            recordId: '195683d2-3a97-46e9-b0df-25f9991957cf',
            sourceUrl: captured.url,
            outputLanguage: 'en',
            model: 'gpt-5-nano',
            inputTokens: 0,
            outputTokens: 0,
          },
        })
      },
      { backendOrigin, captured: landingCapture, inspection },
    )
    await panel.bringToFront()
    await panel.getByRole('button', { name: 'Scan & save chapters', exact: true }).click()
    const contents = panel.getByRole('region', { name: 'Discovered chapters' })
    await expect
      .poll(async () => ({
        links: await novelPage.locator('#contents a').count(),
        errors: await panel.getByRole('alert').allTextContents(),
      }))
      .toEqual({ links: 754, errors: [] })
    await expect(contents).toContainText('754 links saved to Novelist')
    await expect(contents).not.toContainText('Partial list')
    await expect(panel.getByRole('combobox', { name: 'Chapter' }).locator('option')).toHaveCount(
      754,
    )
    await expect(panel.getByRole('link', { name: 'Open in Novelist', exact: true })).toHaveCount(1)
    await expect(panel.getByRole('button', { name: 'Capture reading samples' })).toHaveCount(0)
    const savedRequest = requests.find(
      (request) => request.path === '/api/extension/library' && request.body,
    )!.body!
    expect(savedRequest.contents).toMatchObject({
      url: 'https://books.example.test/dynamic',
      links: expect.any(Array),
      truncated: false,
    })
    expect(
      (savedRequest.contents as { links: { url: string }[] }).links.filter((link) =>
        link.url.includes('/river-ledger/'),
      ),
    ).toHaveLength(754)
    expect(
      await worker.evaluate(
        async () => (await chrome.storage.session.get('contentsScan')).contentsScan.actions,
      ),
    ).toBe(2)
    await panel.setViewportSize({ width: 300, height: 800 })
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    )
    await panel.evaluate(() => window.scrollTo(0, 0))
    await panel.screenshot({
      path: test.info().outputPath('simple-chapter-workflow.png'),
      fullPage: true,
      animations: 'disabled',
    })
    expect(
      requests.filter((request) => /\/navigation\/(start|plan)$/.test(request.path)),
    ).toHaveLength(0)
    expect(
      requests
        .filter(
          (request) => request.path === '/api/extension/navigation/site' && request.body?.recipes,
        )
        .at(-1)?.body?.recipes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ intent: 'contents' }),
        expect.objectContaining({ intent: 'load_more' }),
      ]),
    )
    await panel.getByRole('textbox', { name: 'Find a chapter' }).fill('700')
    await panel.getByRole('combobox', { name: 'Chapter' }).selectOption(chapterUrl)
    await panel.getByRole('button', { name: 'Test chapter extraction', exact: true }).click()
    const scrape = panel.getByRole('dialog', { name: 'Confirm scrape test' })
    await expect(scrape).toContainText('Only this chapter is tested')
    await expect(scrape.getByRole('button', { name: 'Test chapter', exact: true })).toBeDisabled()
    expect(requests.filter((request) => request.path.endsWith('/test'))).toHaveLength(0)
    await scrape
      .getByRole('checkbox', {
        name: 'I have permission to scrape and send these pages to OpenAI.',
        exact: true,
      })
      .check()
    await scrape.getByRole('button', { name: 'Test chapter', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'Chapter extraction passed' })).toBeVisible()
    const submitted = requests.find((request) => request.path.endsWith('/test'))!.body!
    expect(submitted.sampleUrls).toEqual([])
    expect(submitted.page).toMatchObject({
      url: chapterUrl,
      html: expect.stringContaining('Rendered fixture prose for the selected chapter only.'),
    })
    expect(submitted.browserPages).toBeUndefined()
    expect(submitted.contents).toBeUndefined()
  } finally {
    await extension.close()
  }
})

test('JavaScript table pagination updates an already-paired edition and reuses its Next rule', async () => {
  const extension = await setup({ browserAccess: true })
  const { panel, worker, context, backendOrigin, requests, inspection, library } = extension
  const url = 'https://books.example.test/novel/english-edition'
  inspection.indexUrl = url
  inspection.chapterLinks = []
  inspection.chapterCount = 122
  inspection.language = 'en'
  library[0].sources.push({
    id: 'english-source',
    label: 'English edition',
    language: 'en',
    role: 'reference',
    url,
  })
  try {
    const novelPage = await context.newPage()
    await novelPage.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><head><title>English edition</title></head><body>
        <h1>English edition</h1><div id="latest"></div>
        <section><h2>Chapter List</h2><ul id="idData"></ul>
          <div class="page" id="barcon"><a id="nextBtn" href="javascript:;" data-page-action="next">Next</a></div>
        </section><button id="comments">Load More Comments</button>
        <script>
          let offset = 0;
          const link = number => '<li><a href="/novel/english-edition/chapter-' + number + '">Chapter ' + number + '</a></li>';
          document.getElementById('latest').innerHTML = Array.from({ length: 6 }, (_, index) => link(122 - index)).join('');
          function render() {
            document.getElementById('idData').innerHTML = Array.from({ length: Math.min(40, 122 - offset) }, (_, index) => link(offset + index + 1)).join('');
            if (offset + 40 >= 122) document.getElementById('nextBtn').textContent = 'None';
          }
          document.getElementById('nextBtn').addEventListener('click', () => {
            if (offset + 40 < 122) { offset += 40; setTimeout(render, 100); }
          });
          document.getElementById('comments').addEventListener('click', () => { document.body.dataset.commentsClicked = 'true'; });
          render();
        </script></body></html>`,
      }),
    )
    await novelPage.goto(url)
    await expect(novelPage.locator('a[href*="/chapter-"]')).toHaveCount(46)
    await worker.evaluate(
      async ({ backendOrigin, url }) => {
        const tabs = await chrome.tabs.query({ url })
        await chrome.storage.local.set({ backendOrigin })
        await chrome.storage.session.set({
          connection: { token: 'test-extension-token', expiresAt: Date.now() + 100_000 },
          capture: {
            page: { url, html: '<h1>English edition</h1>' },
            pageTitle: 'English edition',
            preview: '',
            tabId: tabs[0].id,
            capturedAt: 'paired-pagination',
          },
        })
      },
      { backendOrigin, url },
    )
    await panel.reload()
    await expect(panel.getByText('In your library', { exact: true })).toBeVisible()
    for (const scan of [1, 2]) {
      if (scan === 2) await novelPage.reload()
      await panel.getByRole('button', { name: 'Scan & save chapters', exact: true }).click()
      await expect(
        panel.getByRole('button', { name: 'Scan & save chapters', exact: true }),
      ).toBeEnabled()
      const contents = panel.getByRole('region', { name: 'Discovered chapters' })
      await expect(contents).toContainText('122 links saved to Novelist')
      await expect(contents).not.toContainText('Partial list')
      await expect(panel.getByRole('combobox', { name: 'Chapter' }).locator('option')).toHaveCount(
        122,
      )
      await expect(novelPage.locator('#nextBtn')).toHaveText('None')
      await expect(novelPage.locator('body')).not.toHaveAttribute('data-comments-clicked', 'true')
      expect(
        await worker.evaluate(
          async () => (await chrome.storage.session.get('contentsScan')).contentsScan.actions,
        ),
      ).toBe(3)
      const saves = requests.filter((request) => request.path === '/api/extension/library/contents')
      expect(saves).toHaveLength(scan)
      expect(saves.at(-1)?.body).toMatchObject({
        bookId: 'e'.repeat(32),
        sourceUrl: url,
        contents: { url, truncated: false, links: expect.any(Array) },
      })
      expect((saves.at(-1)!.body!.contents as { links: unknown[] }).links).toHaveLength(122)
      expect(
        requests.filter(
          (request) => request.path === '/api/extension/navigation/site' && !request.body?.recipes,
        ),
      ).toHaveLength(scan)
      expect(
        requests.filter(
          (request) => request.path === '/api/extension/navigation/site' && request.body?.recipes,
        ),
      ).toHaveLength(scan)
    }
    expect(
      requests.filter((request) => request.path === '/api/extension/navigation/site').at(-1)?.body
        ?.recipes,
    ).toEqual([{ label: 'next', role: 'link', value: null, intent: 'next_page' }])
    expect(
      requests.filter((request) => request.path === '/api/extension/library' && request.body),
    ).toHaveLength(0)
    expect(
      requests.filter((request) => /\/(inspect|test|pair|start|plan)$/.test(request.path)),
    ).toHaveLength(0)
    expect(library).toHaveLength(2)
    const chapterUrl = 'https://books.example.test/novel/english-edition/chapter-1'
    await novelPage.route(chapterUrl, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<h1>Chapter 1</h1><main>Rendered English reference text.</main>',
      }),
    )
    await panel.getByRole('combobox', { name: 'Chapter', exact: true }).selectOption(chapterUrl)
    await expect(
      panel.getByRole('button', { name: 'Download chapter', exact: true }),
    ).toHaveAttribute('title', /selected method/)
    await expect(
      panel.getByRole('button', { name: 'Test chapter extraction', exact: true }),
    ).toHaveAttribute('title', /without saving/)
    await panel.getByRole('button', { name: 'Download chapter', exact: true }).click()
    await panel.getByRole('button', { name: 'Review model use', exact: true }).click()
    const download = panel.getByRole('dialog', { name: 'Confirm chapter download', exact: true })
    await expect(
      download.getByRole('button', { name: 'Generate scraper & download', exact: true }),
    ).toBeDisabled()
    await download.getByRole('checkbox').check()
    await download.getByRole('button', { name: 'Generate scraper & download', exact: true }).click()
    await expect(
      panel.getByText('Chapter saved. Ready to read in Novelist.', { exact: true }),
    ).toBeVisible()
    const chapterRequests = requests.filter(
      (request) => request.path === '/api/extension/library/chapter',
    )
    expect(chapterRequests.map((request) => request.body?.confirmed)).toEqual([false, true])
    expect(chapterRequests[1].body).toMatchObject({
      bookId: 'e'.repeat(32),
      sourceUrl: url,
      page: { url: chapterUrl, html: expect.stringContaining('Rendered English reference text.') },
    })
    await expect(
      panel.getByRole('link', { name: 'Open in Novelist', exact: true }),
    ).toHaveAttribute('href', `${backendOrigin}/books/${'e'.repeat(32)}`)
  } finally {
    await extension.close()
  }
})

test('linked catalog-shaped directories save observed links before downloading an interactive chapter', async () => {
  const extension = await setup({ browserAccess: true })
  const { context, panel, worker, inspection, library, requests, backendOrigin } = extension
  const sourceUrl = 'https://books.example.test/0214633001/dir'
  const chapterUrl = 'https://books.example.test/0214633001/8095_1.html'
  inspection.classification = 'catalog'
  inspection.chapterLinks = []
  inspection.chapterCount = null
  inspection.indexUrl = sourceUrl
  library[0].sources.push({
    id: 'new-directory',
    url: sourceUrl,
    role: 'original',
    language: 'zh',
    label: 'Novel543-shaped source',
  })
  let releaseImage!: () => void
  const imageGate = new Promise<void>((resolve) => {
    releaseImage = resolve
  })
  try {
    const sourcePage = await context.newPage()
    await sourcePage.route(sourceUrl, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body:
          '<h1>Chapter directory</h1>' +
          Array.from(
            { length: 754 },
            (_, index) => `<a href="/0214633001/8095_${index + 1}.html">Chapter ${index + 1}</a>`,
          ).join(''),
      }),
    )
    await sourcePage.route(chapterUrl, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<h1>Chapter 1</h1><main>Rendered chapter text.</main><img src="/slow-image.png">',
      }),
    )
    await sourcePage.route('https://books.example.test/slow-image.png', async (route) => {
      await imageGate
      await route.abort().catch(() => undefined)
    })
    await sourcePage.goto(sourceUrl)
    await worker.evaluate(
      async ({ backendOrigin, sourceUrl }) => {
        const tabs = await chrome.tabs.query({ url: sourceUrl })
        await chrome.storage.local.set({ backendOrigin })
        await chrome.storage.session.set({
          connection: { token: 'test-extension-token', expiresAt: Date.now() + 100_000 },
          capture: {
            page: { url: sourceUrl, html: '<h1>Directory</h1>' },
            pageTitle: 'Directory',
            preview: '',
            tabId: tabs[0].id,
            capturedAt: 'linked-catalog',
          },
        })
      },
      { backendOrigin, sourceUrl },
    )
    await panel.reload()
    await expect(
      panel.getByRole('combobox', { name: 'Chapter', exact: true }).locator('option'),
    ).toHaveCount(754)
    await expect(panel.getByRole('button', { name: 'Download chapter', exact: true })).toBeEnabled()
    expect(requests.filter((request) => request.path.endsWith('/library/contents'))).toHaveLength(0)
    extension.setContentsSaveFailed(true)
    await panel.getByRole('button', { name: 'Download chapter', exact: true }).click()
    await expect(
      panel.getByText('The chapter inventory could not be saved.', { exact: true }).first(),
    ).toBeVisible()
    expect(requests.filter((request) => request.path.endsWith('/library/chapter'))).toHaveLength(0)
    expect(sourcePage.url()).toBe(sourceUrl)
    extension.setContentsSaveFailed(false)
    await panel.getByRole('button', { name: 'Download chapter', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Review model use', exact: true })).toBeVisible()
    expect(await sourcePage.evaluate(() => document.readyState)).toBe('interactive')
    const saveIndex = requests.findIndex((request) => request.path.endsWith('/library/contents'))
    const downloadIndex = requests.findIndex((request) => request.path.endsWith('/library/chapter'))
    expect(saveIndex).toBeGreaterThan(-1)
    expect(saveIndex).toBeLessThan(downloadIndex)
    expect((requests[saveIndex].body!.contents as { links: unknown[] }).links).toHaveLength(754)
    expect(requests[downloadIndex].body).toMatchObject({
      sourceUrl,
      requestedUrl: chapterUrl,
      page: { url: chapterUrl, html: expect.stringContaining('Rendered chapter text.') },
      confirmed: false,
    })
    expect(requests.filter((request) => request.path.endsWith('/inspect'))).toHaveLength(0)
    releaseImage()
    await panel.getByRole('button', { name: 'Review model use', exact: true }).click()
    const dialog = panel.getByRole('dialog', { name: 'Confirm chapter download' })
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Generate scraper & download', exact: true }).click()
    await expect(
      panel.getByText('Chapter saved. Ready to read in Novelist.', { exact: true }),
    ).toBeVisible()
  } finally {
    releaseImage()
    await extension.close()
  }
})

test('bulk downloads follow indexed canonical redirects and remove their duplicate queue entries', async () => {
  const extension = await setup({ browserAccess: true })
  const { context, panel, worker, inspection, library, backendOrigin, requests } = extension
  const sourceUrl = 'https://books.example.test/canonical'
  const alias = `${sourceUrl}/chapter-1`
  const canonical = `${alias}.html`
  const second = `${sourceUrl}/chapter-2.html`
  inspection.indexUrl = sourceUrl
  inspection.chapterCount = 2
  inspection.chapterLinks = [
    { title: 'Chapter 1', url: alias },
    { title: 'Chapter 1', url: canonical },
    { title: 'Chapter 2', url: second },
  ]
  library[0].sources.push({
    id: 'canonical-source',
    role: 'original',
    language: 'zh',
    label: 'Canonical source',
    url: sourceUrl,
  })
  try {
    const sourcePage = await context.newPage()
    await sourcePage.route('https://books.example.test/canonical**', (route) =>
      route.request().url() === alias
        ? route.fulfill({
            contentType: 'text/html',
            body: `<script>location.replace(${JSON.stringify(canonical)})</script>`,
          })
        : route.fulfill({
            contentType: 'text/html',
            body: `<h1>Chapter</h1><main>Rendered ${route.request().url()}</main>${route.request().url() === sourceUrl ? inspection.chapterLinks.map((chapter) => `<a href="${chapter.url}">${chapter.title}</a>`).join('') : ''}`,
          }),
    )
    await sourcePage.goto(sourceUrl)
    await worker.evaluate(
      async ({ sourceUrl, inspection, backendOrigin }) => {
        const tabs = await chrome.tabs.query({ url: sourceUrl })
        await chrome.storage.local.set({ backendOrigin })
        await chrome.storage.session.set({
          connection: { token: 'test-extension-token', expiresAt: Date.now() + 100_000 },
          capture: {
            page: { url: sourceUrl, html: '<h1>Book</h1>' },
            pageTitle: 'Book',
            preview: '',
            tabId: tabs[0].id,
            capturedAt: 'canonical-capture',
          },
          inspection: {
            inspection,
            sourceUrl,
            recordId: '195683d2-3a97-46e9-b0df-25f9991957cf',
            model: 'test-only',
            inputTokens: 0,
            outputTokens: 0,
          },
        })
      },
      { sourceUrl, inspection, backendOrigin },
    )
    await panel.reload()
    await expect(panel.getByText('In your library', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Download all', exact: true }).click()
    const progress = panel.getByRole('region', { name: 'Batch download progress' })
    await expect(progress).toContainText('Downloads complete.')
    await expect(progress).toContainText('2 / 2 processed')
    await expect(
      panel.getByRole('combobox', { name: 'Chapter', exact: true }).locator('option'),
    ).toHaveCount(2)
    const downloads = requests.filter((request) => request.path.endsWith('/chapter/start'))
    expect(downloads.map((request) => (request.body!.page as { url: string }).url)).toEqual([
      canonical,
      second,
    ])
    expect(downloads[0].body).toMatchObject({ requestedUrl: alias, confirmed: false })
    await panel.getByRole('button', { name: 'Download all', exact: true }).click()
    await expect(progress).toContainText('2 already saved')
    expect(requests.filter((request) => request.path.endsWith('/chapter/start'))).toHaveLength(2)
  } finally {
    await extension.close()
  }
})

test('bulk downloads pause on browser verification and resume without losing the chapter', async () => {
  const extension = await setup({ browserAccess: true })
  const { panel, worker, context, backendOrigin, inspection, library, requests } = extension
  const sourceUrl = 'https://books.example.test/access-check'
  const urls = [1, 2, 3].map((number) => `${sourceUrl}/chapter-${number}`)
  inspection.indexUrl = sourceUrl
  inspection.chapterCount = 3
  inspection.chapterLinks = urls.map((url, index) => ({ url, title: `Chapter ${index + 1}` }))
  library[0].sources.push({
    id: 'challenged-source',
    label: 'Challenged source',
    url: sourceUrl,
    language: 'zh',
    role: 'original',
  })
  try {
    const sourcePage = await context.newPage()
    await sourcePage.route('https://books.example.test/access-check**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body:
          route.request().url() === urls[1]
            ? '<title>Just a moment...</title><h1>Verify you are human</h1>'
            : `<title>Chapter</title><h1>Chapter</h1><main>Permitted fixture content.</main>${route.request().url() === sourceUrl ? inspection.chapterLinks.map((chapter) => `<a href="${chapter.url}">${chapter.title}</a>`).join('') : ''}`,
      }),
    )
    await sourcePage.goto(sourceUrl)
    await worker.evaluate(
      async ({ backendOrigin, sourceUrl, inspection }) => {
        const tabs = await chrome.tabs.query({ url: sourceUrl })
        await chrome.storage.local.set({ backendOrigin })
        await chrome.storage.session.set({
          connection: { token: 'test-extension-token', expiresAt: Date.now() + 100_000 },
          capture: {
            page: { url: sourceUrl, html: '<h1>Book</h1>' },
            pageTitle: 'Book',
            preview: '',
            tabId: tabs[0].id,
            capturedAt: 'challenge-test',
          },
          inspection: {
            inspection,
            sourceUrl,
            recordId: '195683d2-3a97-46e9-b0df-25f9991957cf',
            model: 'fixture',
            inputTokens: 0,
            outputTokens: 0,
          },
        })
      },
      { backendOrigin, sourceUrl, inspection },
    )
    await panel.reload()
    await expect(panel.getByText('In your library', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Download all', exact: true }).click()
    const progress = panel.getByRole('region', { name: 'Batch download progress' })
    await expect(progress).toContainText('source requires browser verification')
    await expect(progress).toContainText('1 / 3 processed')
    await expect(progress).toContainText('Pacing increased to 5s')
    await expect(pageRequests()).resolves.toHaveLength(1)
    await panel.reload()
    await expect(
      panel.getByRole('spinbutton', { name: 'Seconds between chapters', exact: true }),
    ).toHaveValue('5')
    await sourcePage.setContent(
      '<title>Chapter 2</title><h1>Chapter 2</h1><main>Manually restored fixture content.</main>',
    )
    await panel.getByRole('button', { name: 'Resume downloads', exact: true }).click()
    await expect(progress).toContainText('Downloads complete.', { timeout: 20_000 })
    const submitted = requests.filter((request) => request.path.endsWith('/chapter/start'))
    expect(submitted.map((request) => (request.body!.page as { url: string }).url)).toEqual(urls)
    expect(submitted.every((request) => request.body!.confirmed === false)).toBe(true)
    const batch = await worker.evaluate(
      async () => (await chrome.storage.session.get('chapterBatch')).chapterBatch,
    )
    expect(batch.accessChallenges).toBe(1)
    expect(batch.timing.browserPages).toBe(3)
    expect(batch.timing.processingJobs).toBe(3)
    expect(batch.timing.browserMs).toBeGreaterThan(0)
    async function pageRequests() {
      return requests.filter((request) => request.path.endsWith('/chapter/start'))
    }
  } finally {
    await extension.close()
  }
})

test('bulk downloads use unique URLs, resume ranges and skip saved chapters', async () => {
  const extension = await setup({ browserAccess: true })
  const { context, panel, worker, inspection, library, backendOrigin, requests } = extension
  const sourceUrl = 'https://books.example.test/bulk'
  const chapterUrls = [1, 2, 3, 4].map((number) => `${sourceUrl}/chapter-${number}`)
  inspection.indexUrl = sourceUrl
  inspection.chapterCount = 4
  inspection.chapterLinks = [
    { title: 'Read first', url: `${chapterUrls[0]}#top` },
    { title: 'Chapter 1', url: chapterUrls[0] },
    { title: 'Chapter 2', url: chapterUrls[1] },
    { title: 'Chapter 2 duplicate', url: `${chapterUrls[1]}#bottom` },
    { title: 'Chapter 3', url: chapterUrls[2] },
    { title: 'Chapter 4', url: chapterUrls[3] },
  ]
  library[0].sources.push({
    id: 'bulk-source',
    role: 'original',
    language: 'zh',
    label: 'Bulk source',
    url: sourceUrl,
  })
  extension.downloadedUrls.set(sourceUrl, new Set([chapterUrls[0]]))
  extension.requireChapterModel(chapterUrls[2])
  extension.holdDownloads()
  try {
    const sourcePage = await context.newPage()
    await sourcePage.route('https://books.example.test/bulk**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<h1>Chapter</h1><main>Rendered chapter ${route.request().url()}</main>${route.request().url() === sourceUrl ? inspection.chapterLinks.map((chapter) => `<a href="${chapter.url}">${chapter.title}</a>`).join('') : ''}`,
      }),
    )
    await sourcePage.goto(sourceUrl)
    await worker.evaluate(
      async ({ backendOrigin, sourceUrl, inspection }) => {
        const tabs = await chrome.tabs.query({ url: sourceUrl })
        await chrome.storage.local.set({ backendOrigin })
        await chrome.storage.session.set({
          connection: { token: 'test-extension-token', expiresAt: Date.now() + 100_000 },
          capture: {
            page: { url: sourceUrl, html: '<h1>Book</h1>' },
            pageTitle: 'Book',
            preview: '',
            tabId: tabs[0].id,
            capturedAt: 'bulk-capture',
          },
          inspection: {
            inspection,
            sourceUrl,
            recordId: '195683d2-3a97-46e9-b0df-25f9991957cf',
            model: 'test-only',
            inputTokens: 0,
            outputTokens: 0,
          },
        })
      },
      { backendOrigin, sourceUrl, inspection },
    )
    await panel.reload()
    await expect(panel.getByText('In your library', { exact: true })).toBeVisible()
    await expect(
      panel.getByRole('combobox', { name: 'Chapter', exact: true }).locator('option'),
    ).toHaveCount(4)
    await expect(
      panel.getByRole('combobox', { name: 'Chapter', exact: true }).locator('option').first(),
    ).toHaveText('Chapter 1')
    await panel.getByRole('spinbutton', { name: 'Download from chapter', exact: true }).fill('2')
    await panel.getByRole('spinbutton', { name: 'Download to chapter', exact: true }).fill('5')
    await expect(panel.getByRole('button', { name: 'Download range', exact: true })).toBeDisabled()
    await panel.getByRole('spinbutton', { name: 'Download to chapter', exact: true }).fill('3')
    await panel.getByRole('button', { name: 'Download range', exact: true }).click()
    const progress = panel.getByRole('region', { name: 'Batch download progress' })
    await expect
      .poll(() => requests.filter((request) => request.path.endsWith('/chapter/start')).length)
      .toBe(1)
    await panel.getByRole('button', { name: 'Pause downloads', exact: true }).click()
    extension.releaseDownloads()
    await expect(progress).toContainText('Paused.')
    await expect(progress).toContainText('1 / 2 processed')
    await panel.reload()
    await expect(progress).toContainText('1 / 2 processed')
    await panel.getByRole('button', { name: 'Resume downloads', exact: true }).click()
    await panel.getByRole('button', { name: 'Review model use for chapter', exact: true }).click()
    const confirmation = panel.getByRole('dialog', { name: 'Confirm batch chapter', exact: true })
    await expect(confirmation).toContainText('chapter 3')
    await expect(
      confirmation.getByRole('button', { name: 'Generate & resume', exact: true }),
    ).toBeDisabled()
    await confirmation.getByRole('checkbox').check()
    await confirmation.getByRole('button', { name: 'Generate & resume', exact: true }).click()
    await expect(progress).toContainText('Downloads complete.')
    expect(
      requests
        .filter((request) => request.path.endsWith('/chapter/start'))
        .map((request) => [(request.body!.page as { url: string }).url, request.body!.confirmed]),
    ).toEqual([
      [chapterUrls[1], false],
      [chapterUrls[2], false],
      [chapterUrls[2], true],
    ])
    await panel.getByRole('textbox', { name: 'Find a chapter', exact: true }).fill('2')
    await panel.getByRole('button', { name: 'Download all', exact: true }).click()
    await expect(progress).toContainText('4 / 4 processed')
    await expect(progress).toContainText('1 saved')
    await expect(progress).toContainText('3 already saved')
    await expect(progress).toContainText('Downloads complete.')
    expect(requests.filter((request) => request.path.endsWith('/chapter/start'))).toHaveLength(4)
    await panel.getByRole('button', { name: 'Download all', exact: true }).click()
    await expect(progress).toContainText('0 saved')
    await expect(progress).toContainText('4 already saved')
    expect(requests.filter((request) => request.path.endsWith('/chapter/start'))).toHaveLength(4)
    expect(extension.downloadedUrls.get(sourceUrl)).toEqual(new Set(chapterUrls))
    await worker.evaluate(async () => {
      const { chapterBatch } = await chrome.storage.session.get('chapterBatch')
      await chrome.storage.session.set({
        chapterBatch: {
          ...chapterBatch,
          state: 'running',
          next: 3,
          skipped: 3,
          jobId: 'lost-server-job',
        },
      })
    })
    await panel.reload()
    await expect(progress).toContainText('The extension restarted')
    await panel.getByRole('button', { name: 'Resume downloads', exact: true }).click()
    await expect(progress).toContainText('no paid request was replayed')
    await panel.getByRole('button', { name: 'Resume downloads', exact: true }).click()
    await expect(progress).toContainText('Downloads complete.')
    expect(requests.filter((request) => request.path.endsWith('/chapter/start'))).toHaveLength(4)
    expect(library).toHaveLength(2)
    await panel.setViewportSize({ width: 300, height: 800 })
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    )
    await expect(panel.locator('.batch-downloads > h2 span')).toHaveCSS(
      'color',
      'rgb(102, 102, 110)',
    )
    await panel.evaluate(() => window.scrollTo(0, 0))
    await panel.screenshot({
      path: test.info().outputPath('bulk-downloads.png'),
      fullPage: true,
      animations: 'disabled',
    })
  } finally {
    extension.releaseDownloads()
    await extension.close()
  }
})

test('installed extension shows model failures and can disconnect without losing the captured page', async () => {
  const extension = await setup({ browserAccess: true })
  const { panel, worker, context, backendOrigin } = extension
  try {
    const chapterUrl = 'https://books.example.test/chapter/1'
    const novelPage = await context.newPage()
    await novelPage.route(chapterUrl, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<h1>Chapter 1</h1><p>Original chapter fixture.</p>',
      }),
    )
    await novelPage.goto(chapterUrl)
    await worker.evaluate(
      async ({ backendOrigin, page }) => {
        const tabs = await chrome.tabs.query({ url: 'https://books.example.test/*' })
        await chrome.storage.local.set({ backendOrigin })
        await chrome.storage.session.set({
          connection: { token: 'test-extension-token', expiresAt: Date.now() + 100_000 },
          liveEnabled: true,
          capture: {
            page,
            pageTitle: 'The River Ledger',
            preview: 'Captured fixture',
            tabId: tabs[0].id,
            capturedAt: 'failure-capture',
          },
          inspection: {
            inspection: {
              classification: 'uncertain',
              title: null,
              author: null,
              language: null,
              synopsis: null,
              reason: 'The captured page is uncertain.',
              evidenceQuote: '',
              chapterLinks: [{ title: 'Chapter 1', url: 'https://books.example.test/chapter/1' }],
              indexUrl: null,
            },
            model: 'mock-model',
            inputTokens: 0,
            outputTokens: 0,
          },
        })
      },
      { backendOrigin, page: trainingFixtures[0].page },
    )
    extension.failScrape()
    await panel.bringToFront()
    await panel.getByRole('button', { name: 'Test chapter extraction' }).click()
    const confirmation = panel.getByRole('dialog')
    await confirmation
      .getByRole('checkbox', {
        name: 'I have permission to scrape and send these pages to OpenAI.',
        exact: true,
      })
      .check()
    await confirmation.getByRole('button', { name: 'Test chapter', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('The model is unavailable')
    extension.interruptJobs()
    await panel.getByRole('button', { name: 'Test chapter extraction' }).click()
    await confirmation
      .getByRole('checkbox', {
        name: 'I have permission to scrape and send these pages to OpenAI.',
        exact: true,
      })
      .check()
    await confirmation.getByRole('button', { name: 'Test chapter', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('The local connection was interrupted')
    expect(
      await worker.evaluate(async () => (await chrome.storage.session.get('job')).job),
    ).toMatchObject({ state: 'failed', stage: 'Connection interrupted' })
    await panel.getByRole('button', { name: 'Connection settings' }).click()
    await panel.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(panel.getByText('Not connected', { exact: true })).toBeVisible()
    await expect(
      panel.getByRole('heading', { name: 'The River Ledger', exact: true }),
    ).toBeVisible()
  } finally {
    await extension.close()
  }
})
