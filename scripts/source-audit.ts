import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { createServer, loadEnv, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { aiExperimentPlugin } from '../server/ai/plugin.ts'
import { discoverContents } from '../src/lib/extension/contents.ts'
import { novelInspectionSchema } from '../src/lib/extension/contracts.ts'
import { isAccessChallenge } from '../src/lib/extension/navigation.ts'

const candidates = [
  { site: 'novel543', url: 'https://www.novel543.com/0214633001/dir' },
  { site: '101kks', url: 'https://101kks.com/book/11508.html' },
  { site: '69shuba', url: 'https://www.69shuba.com/book/90442/' },
  { site: 'twkan', url: 'https://twkan.com/book/93323/index.html' },
]

async function challenge(page: Page) {
  for (const frame of page.frames()) {
    const text = await frame.locator('body').innerText({ timeout: 3000 }).catch(() => '')
    if (isAccessChallenge(await frame.title().catch(() => ''), text.slice(0, 20000)) ||
        /\u62d6\u52d5\u4e0b\u65b9\u6ed1\u584a|\u62d6\u52a8\u4e0b\u65b9\u6ed1\u5757|\u5b89\u5168\u9a8c\u8bc1|\u5b89\u5168\u9a57\u8b49/.test(text)) return true
  }
  return false
}

async function batchState(worker: Worker) {
  return worker.evaluate(async () => (await chrome.storage.session.get('chapterBatch')).chapterBatch as {
    state: string; saved: number; message?: string; urls: string[]; next: number
  } | undefined)
}

async function main() {
  const { values } = parseArgs({ options: { site: { type: 'string' }, 'allow-model': { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help) {
    console.log('node --experimental-strip-types scripts/source-audit.ts [--site novel543|101kks|69shuba|twkan] [--allow-model]\nUses an isolated local account and headed Chromium with the unpacked extension. At most three sample chapters/site. New extractor generation is off unless explicitly enabled; at most three generation operations, each capped at three model calls. No translation, Cloudflare solving or hosted-library writes.')
    return
  }
  const selected = values.site ? candidates.filter(candidate => candidate.site === values.site) : candidates
  if (!selected.length) throw new Error('Unknown audit site.')
  const environment = { ...loadEnv('development', process.cwd(), ''), ...process.env }
  const local = JSON.parse(execFileSync('npx', ['supabase', 'status', '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  if (new URL(local.API_URL).hostname !== '127.0.0.1') throw new Error('Audit requires local Supabase.')
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const client = createClient(local.API_URL, local.ANON_KEY, options)
  const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, options)
  const signedIn = await client.auth.signInAnonymously()
  if (signedIn.error || !signedIn.data.session) throw new Error('Could not create an isolated audit account.')
  const owner = signedIn.data.user!.id
  const directory = resolve(`.novelist/source-audits/${new Date().toISOString().replaceAll(':', '-')}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const extensionPath = resolve(directory, 'extension')
  await cp(resolve('dist-extension'), extensionPath, { recursive: true })
  const manifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8'))
  manifest.host_permissions.push(...selected.map(candidate => `${new URL(candidate.url).origin}/*`))
  await writeFile(resolve(extensionPath, 'manifest.json'), JSON.stringify(manifest))
  let server: ViteDevServer | undefined
  let context: BrowserContext | undefined
  const results: Record<string, unknown>[] = []
  let generations = 0
  try {
    server = await createServer({
      configFile: false,
      plugins: [react(), aiExperimentPlugin({
        root: process.cwd(), supabaseUrl: local.API_URL, publishableKey: local.ANON_KEY,
        apiKey: values['allow-model'] ? environment.OPENAI_API_KEY || '' : '',
        liveEnabled: Boolean(values['allow-model'] && environment.OPENAI_API_KEY),
        model: environment.OPENAI_EXTRACTION_MODEL || 'gpt-5.6-luna',
        scraperModel: environment.OPENAI_SCRAPER_MODEL || environment.OPENAI_EXTRACTION_MODEL || 'gpt-5.6-luna',
        maxConcurrentRequests: 8, maxRequestsPerHour: 9,
      })],
      define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(local.API_URL),
        'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(local.ANON_KEY), 'import.meta.env.VITE_AUTH_MODE': JSON.stringify('local') },
      server: { host: '127.0.0.1', port: 0, strictPort: true, fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.novelist/**'] } },
      logLevel: 'error',
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Audit backend is unavailable.')
    const backendOrigin = `http://127.0.0.1:${address.port}`
    context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
      channel: 'chromium', headless: false, viewport: { width: 1100, height: 850 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
    await context.addInitScript(({ backendOrigin, session }) => {
      if (location.origin === backendOrigin) localStorage.setItem('sb-127-auth-token', JSON.stringify(session))
    }, { backendOrigin, session: signedIn.data.session })
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
    const extensionId = new URL(worker.url()).hostname
    await worker.evaluate(async backendOrigin => { await chrome.storage.local.set({ backendOrigin, autoConnectPaused: true }) }, backendOrigin)
    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${extensionId}/panel.html`)
    await panel.getByRole('button', { name: 'Connect to Novelist', exact: true }).click()
    await expect(panel.getByText('Connected to Novelist', { exact: true })).toBeVisible({ timeout: 45000 })
    for (const candidate of selected) {
      const sourcePage = await context.newPage()
      const result: Record<string, unknown> = { site: candidate.site, directoryUrl: candidate.url, savedChapters: 0 }
      let generationConfirmed = false
      results.push(result)
      try {
        await sourcePage.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 25000 })
        if (await challenge(sourcePage)) {
          result.outcome = 'verification-required'; await sourcePage.goto('about:blank'); continue
        }
        const captured = await sourcePage.evaluate(() => ({ url: location.href, title: document.title,
          links: [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].map(link => ({ title: (link.textContent || '').trim().slice(0, 500), url: link.href })).filter(link => /^https?:/.test(link.url)).slice(0, 20000), truncated: false }))
        if (new URL(captured.url).origin !== new URL(candidate.url).origin) throw new Error('Source redirected to another origin; audit stopped for this site.')
        const contents = discoverContents(captured, { chapterLinks: [], chapterCount: null, indexUrl: captured.url })
        result.discoveredChapters = contents.foundCount
        if (!contents.chapters.length) { result.outcome = 'no-observed-chapter-links'; continue }
        const title = await sourcePage.locator('h1').first().textContent().catch(() => captured.title)
        const inspection = novelInspectionSchema.parse({ classification: 'index', title: (title || captured.title).trim().slice(0, 500), originalTitle: null,
          author: 'Unknown author', originalAuthor: null, language: 'zh', synopses: [], coverImage: null, genres: [], tags: [],
          publicationStatus: 'Unknown', chapterCount: contents.foundCount, wordCount: null, updatedAt: null, additionalMetadata: [],
          reason: 'Audit metadata registered from visible page headings and links; model identification was not tested.',
          chapterLinks: contents.chapters.slice(0, 3).map(({ title, url }) => ({ title, url })), indexUrl: captured.url })
        const identification = await client.from('page_identifications').insert({ source_url: captured.url, source_language: 'zh', output_language: 'en',
          title: inspection.title, author: inspection.author, model: 'manual-observed-audit', prompt_version: 'manual-audit-v1',
          captured_html_hash: createHash('sha256').update(await sourcePage.content()).digest('hex'), metadata: inspection, raw_extraction: inspection }).select('id').single()
        if (identification.error) throw new Error(identification.error.message)
        const bookId = randomUUID().replaceAll('-', '')
        const book = await client.from('books').insert({ id: bookId, title: inspection.title, author: inspection.author, format: 'WEB', original_path: null,
          file_size: 0, source_url: captured.url, source: new URL(captured.url).hostname, language: 'zh', import_state: 'ready',
          identification_id: identification.data.id, catalog_metadata: { canonicalUrl: captured.url, contents } })
        if (book.error) throw new Error(book.error.message)
        const source = await client.from('novel_sources').select('id').eq('book_id', bookId).single()
        if (source.error) throw new Error(source.error.message)
        const inventory = await client.from('novel_sources').update({ contents_data: contents, identification_id: identification.data.id }).eq('id', source.data.id)
        if (inventory.error) throw new Error(inventory.error.message)
        const cached = await admin.from('site_scrapers').select('origin,page_kind,code,code_hash,contract_version,report_id,validated_at')
          .eq('owner_id', '28fd9dab-36c4-46b4-a96a-53583f44ff50').eq('origin', new URL(captured.url).origin).eq('page_kind', 'chapter').maybeSingle()
        if (cached.error) throw new Error('Saved adapter lookup failed.')
        if (cached.data) {
          const copied = await client.from('site_scrapers').upsert(cached.data, { onConflict: 'owner_id,origin,page_kind' })
          if (copied.error) throw new Error('Could not reuse the existing adapter in the audit account.')
        }
        result.reusedExistingAdapter = Boolean(cached.data)
        result.bookId = bookId
        result.sourceId = source.data.id
        await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'sync', refreshLibrary: true }) })
        await sourcePage.bringToFront()
        const capture = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'capture' }))
        if (capture?.ok === false) throw new Error(capture.error)
        await panel.reload()
        await expect(panel.getByRole('button', { name: 'Download range', exact: true })).toBeVisible({ timeout: 20000 })
        await panel.getByRole('spinbutton', { name: 'Download to chapter', exact: true }).fill(String(Math.min(3, contents.chapters.length)))
        await panel.getByRole('button', { name: 'Download range', exact: true }).click()
        await expect.poll(async () => Boolean((await batchState(worker))?.state), { timeout: 15000 }).toBe(true)
        for (;;) {
          await expect.poll(async () => (await batchState(worker))?.state, { timeout: 240000, intervals: [500, 1000, 2000] }).not.toBe('running')
          const batch = await batchState(worker)
          if (!batch) throw new Error('The extension did not create a batch.')
          if (batch.state === 'needs_scraper' && values['allow-model'] && !generationConfirmed && generations < 3) {
            generationConfirmed = true
            generations += 1
            console.log(`${candidate.site}: confirmed extractor operation ${generations}/3 (up to three model calls).`)
            await panel.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'resume-downloads', confirmed: true, delaySeconds: 1, concurrency: 1 }) })
            continue
          }
          result.outcome = batch.state
          result.message = batch.message
          result.savedChapters = batch.saved
          break
        }
        const records = await client.from('source_chapters').select('url,content_path,content_hash').eq('source_id', source.data.id)
        if (records.error) throw new Error('Could not verify saved sample chapters.')
        const samples = []
        for (const chapter of records.data) {
          const stored = await client.storage.from('library').download(chapter.content_path)
          if (stored.error || !stored.data) throw new Error('Saved sample file is unavailable.')
          const encoded = Buffer.from(await stored.data.arrayBuffer())
          const bytes = encoded[0] === 31 && encoded[1] === 139 ? gunzipSync(encoded) : encoded
          if (createHash('sha256').update(bytes).digest('hex') !== chapter.content_hash) throw new Error('Saved sample hash does not match.')
          const text = JSON.parse(bytes.toString('utf8'))
          if (!Array.isArray(text.paragraphs) || !text.paragraphs.length) throw new Error('Saved sample has no paragraphs.')
          samples.push({ url: chapter.url, paragraphs: text.paragraphs.length, characters: text.paragraphs.join('\n\n').length, sha256: chapter.content_hash })
        }
        result.savedChapters = samples.length
        result.samples = samples
        await panel.screenshot({ path: resolve(directory, `${candidate.site}-extension.png`), fullPage: true })
        if (await challenge(sourcePage)) await sourcePage.goto('about:blank')
      } catch (failure) {
        result.outcome = 'failed'
        result.message = failure instanceof Error ? failure.message.split('\n')[0].slice(0, 220) : 'Site test failed.'
        result.extensionState = await worker.evaluate(async () => {
          const state = await chrome.storage.session.get(['inspection', 'savedSource', 'error', 'sourceLookupError'])
          return { hasInspection: Boolean(state.inspection), hasSavedSource: Boolean(state.savedSource), error: state.error, sourceLookupError: state.sourceLookupError }
        }).catch(() => undefined)
        await panel.screenshot({ path: resolve(directory, `${candidate.site}-failure.png`), fullPage: true }).catch(() => undefined)
        await sourcePage.goto('about:blank').catch(() => undefined)
      } finally {
        console.log(JSON.stringify(result))
        await sourcePage.close()
        await writeFile(resolve(directory, 'results.json'), JSON.stringify({ createdAt: new Date().toISOString(), ownerId: owner, generationOperations: generations, maximumAuthorizedModelCalls: values['allow-model'] ? 9 : 0, results }, null, 2), { mode: 0o600 })
      }
    }
    const reports = []
    const artifacts = resolve('.novelist/scraper', owner)
    for (const entry of await readdir(artifacts).catch(() => [])) {
      const report = JSON.parse(await readFile(resolve(artifacts, entry, 'report.json'), 'utf8').catch(() => 'null'))
      if (report) reports.push({ origin: report.adapter?.origin, mode: report.mode, attempts: report.mode === 'live' ? report.attempts.length : 0, inputTokens: report.inputTokens, outputTokens: report.outputTokens })
    }
    await writeFile(resolve(directory, 'results.json'), JSON.stringify({ createdAt: new Date().toISOString(), ownerId: owner, generationOperations: generations,
      maximumAuthorizedModelCalls: values['allow-model'] ? 9 : 0, modelCalls: reports.reduce((total, report) => total + report.attempts, 0), reports, results }, null, 2), { mode: 0o600 })
    console.log(`Audit results: ${directory}; ${results.filter(result => Number(result.savedChapters) > 0).length}/${selected.length} sites saved sample chapters.`)
  } finally {
    await context?.close()
    await server?.close()
    await client.auth.signOut()
  }
}

void main().catch(() => {
  console.error('Source audit stopped. No hosted library data was changed and no access challenge was bypassed.')
  process.exitCode = 1
})