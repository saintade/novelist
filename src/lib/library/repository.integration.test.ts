// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { createHash, webcrypto } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { Client } from 'pg'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { importBook } from '../books'
import { supabase, ensureSession } from '../supabase/client'
import {
  addNovelSource,
  assignStyleProfile,
  getTranslationWorkspace,
  uploadStyleExample,
  removeStyleExample,
  saveGlossaryEntry,
  saveStyleProfile,
  saveTranslationSettings,
  saveChapterReferencePair,
  applyMetadataPreview,
  setGlossaryStatus,
  removeNovelSource,
} from '../translation/repository'
import { resolveGlossary } from '../translation/glossary'
import { readDownloadedChapter, saveSourceProgress } from '../sources/repository'
import {
  compatibleReadingGuide,
  runReadingGuide,
  runStyleInference,
} from '../../../server/ai/styles'
import { editBookTranslationTerm, lockTranslationChapters, runBookTranslation, suggestBookTranslationTerm } from '../../../server/ai/translation'
import { siteNavigation } from '../../../server/extension/navigation'
import { downloadSourceChapter, testSourceExtraction } from '../../../server/sources/chapters'
import { analyzeSourceChapters } from '../../../server/sources/analysis'
import { acquireAILibrary, ExperimentError, type AIConfiguration } from '../../../server/ai/experiments'
import { TranslationBatchManager } from '../../../server/ai/translation-batches'
import { trackModelResponse } from '../../../server/ai/usage'
import { createProductionApp } from '../../../server/http'
import { createLibraryManifest, compareLibraryManifests } from '../../../scripts/library-manifest'
import { runReaderChat } from '../../../server/ai/reader-chat'
import { runReaderIndex, retrieveReaderPassages } from '../../../server/ai/reader-retrieval'
import { discoverContents } from '../extension/contents'
import { persistIdentification } from '../../../server/extension/inspect'
import {
  addIdentifiedNovel,
  connectedLibrary,
  downloadedSourceUrls,
  savedSourceContext,
  saveSourceContents,
  saveRenderedSourceChapter,
  pairIdentifiedEdition,
} from '../../../server/extension/library'
import type { InspectionResult } from '../extension/contracts'
import type { Json } from '../supabase/database.types'
import {
  getBooks,
  getChapter,
  getOriginalFile,
  removeBook,
  saveBook,
  updateBook,
  getLibraryFolders,
  saveLibraryFolder,
  removeLibraryFolder,
} from './repository'

const { inferProvider } = vi.hoisted(() => ({ inferProvider: vi.fn() }))
const { downloadFetch, downloadScraper } = vi.hoisted(() => ({
  downloadFetch: vi.fn(),
  downloadScraper: vi.fn(),
}))
vi.mock('../../../server/extension/sample', () => ({ fetchChapterSample: downloadFetch }))
vi.mock('../../../server/scraper/tool', () => ({ runScraperTool: downloadScraper }))
vi.mock('openai', () => ({
  default: class {
    responses = { parse: inferProvider, create: async (request: unknown) => {
      const response = await inferProvider(request)
      return { ...response, output_text: response.output_text ?? (response.output_parsed ? JSON.stringify(response.output_parsed) : '') }
    } }
  },
}))

vi.stubGlobal('File', NodeFile)
vi.stubGlobal('Blob', NodeBlob)
vi.stubGlobal('crypto', webcrypto)

describe.runIf(
  import.meta.env.VITE_SUPABASE_URL?.includes('127.0.0.1') &&
    process.env.RUN_SUPABASE_TESTS === '1',
)('local Supabase repository', () => {
  it('translates a persisted range with saved skips, pause, explicit retries and rolling context', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nOriginal first.\n\nChapter 2\nOriginal second.\n\nChapter 3\nOriginal third.'], `Batch-worker-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '', translationMaxAttempts: 1 }
    const manager = new TranslationBatchManager(configuration)
    let finishSecond!: () => void
    const secondGate = new Promise<void>(resolve => { finishSecond = resolve })
    let markStarted!: () => void
    const secondStarted = new Promise<void>(resolve => { markStarted = resolve })
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let batchId = ''
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      const firstContext = await runBookTranslation(token, { bookId: book.id, action: 'context', sourceKey: 'local:0' }, configuration)
      const existing = await supabase.from('book_translation_previews').insert({ book_id: book.id, kind: 'chapter', source_key: 'local:0', target_language: 'en', result: { title: 'Chapter 1', paragraphs: ['Saved first translation.'], terminology: [] }, context: firstContext.context as unknown as Json }).select('id').single()
      expect(existing.error).toBeNull()
      let failThird = true
      const contexts: { source: { key: string }; recentTranslations: { text: string }[] }[] = []
      inferProvider.mockReset().mockImplementation(async request => {
        const context = JSON.parse(request.input.find((message: { role: string }) => message.role === 'user').content)
        contexts.push(context)
        if (context.source.key === 'local:1') { markStarted(); await secondGate }
        if (context.source.key === 'local:2' && failThird) return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"title":' }
        return { status: 'completed', output_parsed: { title: context.source.title, paragraphs: [context.source.key === 'local:1' ? 'Saved second translation.' : 'Saved third translation.'], terminology: [] }, usage: { input_tokens: 1000, output_tokens: 200 } }
      })
      const planned = await manager.handle(token, { action: 'plan', bookId: book.id, from: 1, to: 3 })
      expect(planned.plan).toMatchObject({ count: 3, missingCount: 0, savedCandidates: 1, maxModelRequests: 3 })
      expect(inferProvider).not.toHaveBeenCalled()
      const requestId = crypto.randomUUID()
      const start = { action: 'start', requestId, bookId: book.id, from: 1, to: 3, expectedRevision: 1, confirmed: true, allUntranslated: true }
      const launched = await manager.handle(token, start)
      batchId = launched.status!.batch!.id
      await secondStarted
      expect(inferProvider).toHaveBeenCalledTimes(1)
      expect((await manager.handle(token, start)).status?.batch?.id).toBe(batchId)
      await manager.handle(token, { action: 'pause', bookId: book.id, batchId })
      finishSecond()
      await manager.wait(batchId)
      const paused = (await manager.handle(token, { action: 'status', bookId: book.id, batchId })).status!
      expect(paused.batch?.state).toBe('paused')
      expect(paused.chapters.map(chapter => chapter.state)).toEqual(['skipped', 'completed', 'pending'])
      expect(paused.chapters[0].preview_id).toBe(existing.data!.id)
      expect(contexts[0].recentTranslations.map(chapter => chapter.text)).toEqual(['Saved first translation.'])
      await manager.handle(token, { action: 'resume', bookId: book.id, batchId, confirmed: true })
      await manager.wait(batchId)
      const failed = (await manager.handle(token, { action: 'status', bookId: book.id, batchId })).status!
      expect(failed.batch?.state).toBe('failed')
      expect(failed.chapters[2].error).toContain('output limit')
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', book.id).eq('source_key', 'local:2')).data).toEqual([])
      await expect(manager.handle(token, { action: 'resume', bookId: book.id, batchId, confirmed: true })).rejects.toThrow('Confirm retrying')
      failThird = false
      await manager.handle(token, { action: 'resume', bookId: book.id, batchId, confirmed: true, retryFailed: true })
      await manager.wait(batchId)
      const completed = (await manager.handle(token, { action: 'status', bookId: book.id, batchId })).status!
      expect(completed.batch?.state).toBe('completed')
      expect(completed.chapters.map(chapter => chapter.state)).toEqual(['skipped', 'completed', 'completed'])
      expect(contexts.at(-1)?.recentTranslations.map(chapter => chapter.text)).toEqual(['Saved first translation.', 'Saved second translation.'])
      expect(inferProvider).toHaveBeenCalledTimes(3)
      const previews = await supabase.from('book_translation_previews').select('context').eq('book_id', book.id).eq('source_key', 'local:1')
      expect(previews.data).toHaveLength(1)
      expect(previews.data![0].context).toMatchObject({ batch: { id: batchId, position: 1 }, generation: { status: 'completed' } })
      expect((await getChapter(book.id, 1))?.html).toContain('Original second.')
      expect((await getBooks()).find(entry => entry.id === book.id)?.status).toBe('unread')
    } finally { finishSecond(); manager.stop(); if (batchId) await manager.wait(batchId); logged.mockRestore(); await removeBook(book.id) }
  }, 30000)

  it('automatically retries timeouts but stops at its attempt cap, provider quota and user pause', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nRetry boundary fixture.'], `Retry-limits-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
    const manager = new TranslationBatchManager(configuration, 0)
    const logging = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      for (const mode of ['timeout', 'quota', 'pause', 'cancel']) {
        const requestId = crypto.randomUUID()
        inferProvider.mockReset().mockImplementation(async () => {
          if (mode === 'pause' || mode === 'cancel') await manager.handle(token, { action: mode, bookId: book.id, batchId: requestId })
          throw mode === 'quota' ? { status: 429, code: 'insufficient_quota' } : { name: 'APIConnectionTimeoutError' }
        })
        await manager.handle(token, { action: 'start', bookId: book.id, from: 1, to: 1, requestId, expectedRevision: 1, confirmed: true })
        await manager.drain()
        const result = (await manager.handle(token, { action: 'status', bookId: book.id, batchId: requestId })).status!
        expect(inferProvider).toHaveBeenCalledTimes(mode === 'timeout' ? 3 : 1)
        expect(result.chapters[0].attempts).toBe(mode === 'timeout' ? 3 : 1)
        expect(result.batch!.state).toBe(mode === 'pause' ? 'paused' : mode === 'cancel' ? 'cancelled' : 'failed')
        expect(result.batch!.last_error_code).toBe(mode === 'quota' ? 'quota' : 'timeout')
        expect(result.batch!.retry_at).toBeNull()
        if (mode !== 'cancel') await manager.handle(token, { action: 'cancel', bookId: book.id, batchId: requestId })
      }
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', book.id)).data).toEqual([])
    } finally { manager.stop(); await manager.drain(); logging.mockRestore(); await removeBook(book.id) }
  }, 30000)

  it('recovers automatically after server suspension but never overrides a manual pause', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nFirst source.\n\nChapter 2\nSecond source.'], `Reconnect-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
    const original = new TranslationBatchManager(configuration, 0)
    const replacement = new TranslationBatchManager(configuration, 0)
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      inferProvider.mockReset().mockImplementation(async request => {
        const context = JSON.parse(request.input.find((message: { role: string }) => message.role === 'user').content)
        if (context.source.key === 'local:0') original.stop()
        return { status: 'completed', output_parsed: { title: context.source.title, paragraphs: [`Saved ${context.source.key}.`], terminology: [] } }
      })
      const request = { action: 'start', bookId: book.id, from: 1, to: 2, requestId: crypto.randomUUID(), expectedRevision: 1, confirmed: true }
      await original.handle(token, request)
      await original.drain()
      expect((await supabase.from('translation_batches').select('state,resume_automatically,last_error_code').eq('id', request.requestId).single()).data).toMatchObject({ state: 'paused', resume_automatically: true, last_error_code: 'server_restart' })
      expect(await replacement.refreshAuthorization(token)).toEqual({ resumed: 1 })
      await replacement.drain()
      expect((await replacement.handle(token, { action: 'status', bookId: book.id, batchId: request.requestId })).status!.batch!.state).toBe('completed')
      expect(inferProvider).toHaveBeenCalledTimes(2)
      const pausedId = crypto.randomUUID()
      expect((await supabase.rpc('create_translation_batch', { request_id: pausedId, target_book: book.id, range_start: 1, range_end: 2, expected_revision: 1, chosen_model: 'test-only', cost_estimate: {} })).error).toBeNull()
      expect((await supabase.rpc('control_translation_batch', { target_batch: pausedId, command: 'pause' })).error).toBeNull()
      expect(await replacement.refreshAuthorization(token)).toEqual({ resumed: 0 })
      expect((await supabase.from('translation_batches').select('state,resume_automatically').eq('id', pausedId).single()).data).toEqual({ state: 'paused', resume_automatically: false })
      expect((await supabase.from('translation_batch_chapters').update({ state: 'failed', attempts: 1 }).eq('batch_id', pausedId).eq('position', 0)).error).toBeNull()
      expect((await supabase.from('translation_batches').update({ last_error_code: 'worker_interrupted' }).eq('id', pausedId)).error).toBeNull()
      await expect(replacement.handle(token, { action: 'resume', bookId: book.id, batchId: pausedId, confirmed: true })).rejects.toThrow('Confirm retrying')
      expect((await supabase.from('translation_batches').select('state,resume_automatically').eq('id', pausedId).single()).data).toEqual({ state: 'paused', resume_automatically: false })
      const recovery = { target_batch: pausedId, worker_key: crypto.randomUUID(), retry_failed: true, automatic_resume: true }
      expect((await supabase.rpc('claim_translation_worker', recovery)).error?.message).toContain('no longer permits automatic recovery')
      expect(await replacement.refreshAuthorization(token)).toEqual({ resumed: 0 })
      expect((await supabase.from('translation_batches').update({ resume_automatically: true }).eq('id', pausedId)).error).toBeNull()
      expect((await supabase.from('translation_batch_chapters').update({ attempts: 3 }).eq('batch_id', pausedId).eq('position', 0)).error).toBeNull()
      expect((await supabase.rpc('claim_translation_worker', recovery)).error?.message).toContain('no longer permits automatic recovery')
      expect(inferProvider).toHaveBeenCalledTimes(2)
    } finally { original.stop(); replacement.stop(); await original.drain(); await replacement.drain(); await removeBook(book.id) }
  }, 15000)

  it('preserves AI concurrency and hourly limits across module reloads', async () => {
    const client = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: crypto.randomUUID() } })
    const session = await client.auth.signInAnonymously()
    expect(session.error).toBeNull()
    const token = session.data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: '', liveEnabled: false, model: 'test-only', root: '', maxConcurrentRequests: 1, maxRequestsPerHour: 1 }
    const occupied = await acquireAILibrary(token, configuration)
    const lockedBook = crypto.randomUUID().replaceAll('-', '')
    const unlock = lockTranslationChapters(session.data.user!.id, lockedBook, ['local:0'])
    let unexpected: Awaited<ReturnType<typeof acquireAILibrary>> | undefined
    let unexpectedUnlock: (() => void) | undefined
    try {
      vi.resetModules()
      const reloaded = await import('../../../server/ai/experiments')
      const translation = await import('../../../server/ai/translation')
      expect(() => { unexpectedUnlock = translation.lockTranslationChapters(session.data.user!.id, lockedBook, ['local:0']) }).toThrow('already being translated')
      await expect(reloaded.acquireAILibrary(token, configuration, 0).then(access => { unexpected = access; return 'unexpectedly granted' })).rejects.toMatchObject({ code: 'local_capacity' })
      occupied.release()
      await expect(reloaded.acquireAILibrary(token, configuration).then(access => { unexpected = access; return 'unexpectedly granted' })).rejects.toThrow('1 requests per hour')
      unlock()
      unexpectedUnlock = translation.lockTranslationChapters(session.data.user!.id, lockedBook, ['local:0'])
    } finally { occupied.release(); unexpected?.release(); unlock(); unexpectedUnlock?.() }
  })

  it('waits for local AI capacity without failing or spending a chapter attempt', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nA capacity fixture.'], `Capacity-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '', maxConcurrentRequests: 1 }
    const manager = new TranslationBatchManager(configuration)
    const occupied = await acquireAILibrary(token, configuration, 0)
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      inferProvider.mockReset().mockResolvedValue({ status: 'completed', output_parsed: { title: 'Chapter 1', paragraphs: ['A completed capacity fixture.'], terminology: [] } })
      const queued = (await manager.handle(token, { action: 'start', bookId: book.id, from: 1, to: 1, requestId: crypto.randomUUID(), expectedRevision: 1, confirmed: true })).status!
      const waiting = (await manager.handle(token, { action: 'status', bookId: book.id, batchId: queued.batch!.id })).status!
      expect(waiting.batch!.state).toBe('running')
      expect(waiting.chapters[0]).toMatchObject({ state: 'pending', attempts: 0 })
      expect(inferProvider).not.toHaveBeenCalled()
      occupied.release()
      await manager.drain()
      expect((await manager.handle(token, { action: 'status', bookId: book.id, batchId: queued.batch!.id })).status!.batch!.state).toBe('completed')
      expect(inferProvider).toHaveBeenCalledTimes(1)
    } finally { occupied.release(); manager.stop(); await manager.drain(); await removeBook(book.id) }
  }, 15000)

  it('plans every untranslated chapter and persists whole-book jobs beyond one thousand chapters', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nFirst source.'], `Whole-book-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: '', liveEnabled: false, model: 'test-only', root: '' }
    const manager = new TranslationBatchManager(configuration)
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      const chapter = (await supabase.from('chapters').select('*').eq('book_id', book.id).single()).data!
      const added = await supabase.from('chapters').insert(Array.from({ length: 1004 }, (_, index) => ({ ...chapter, position: index + 1, title: `Chapter ${index + 2}` })))
      expect(added.error).toBeNull()
      const plan = (await manager.handle(token, { action: 'plan', bookId: book.id, allUntranslated: true, chaptersPerRequest: 10 })).plan!
      expect(plan).toMatchObject({ allUntranslated: true, from: 1, to: 1005, count: 1005, missingCount: 0 })
      await expect(manager.handle(token, { action: 'plan', bookId: book.id, from: 1, to: 1005 })).rejects.toThrow('1,000')
      const batchId = crypto.randomUUID()
      const args = { request_id: batchId, target_book: book.id, chapter_count: plan.to, expected_revision: plan.revision, chosen_model: plan.model, cost_estimate: plan as unknown as Json, maximum_group_size: 10 }
      expect((await supabase.rpc('create_untranslated_translation_batch', args)).error).toBeNull()
      expect((await supabase.rpc('create_untranslated_translation_batch', args)).data).toBe(batchId)
      const result = (await manager.handle(token, { action: 'status', bookId: book.id, batchId })).status!
      expect(result.batch).toMatchObject({ range_start: 1, range_end: 1005, all_untranslated: true, request_kind: 'bulk', state: 'paused' })
      expect(result.chapters).toHaveLength(1005)
      expect(result.chapters.at(-1)?.position).toBe(1004)
    } finally { manager.stop(); await removeBook(book.id) }
  }, 30000)

  it('queues only downloaded chapters for whole-book translation while preserving inventory positions', async () => {
    await ensureSession()
    const bookId = crypto.randomUUID().replaceAll('-', '')
    const sourceUrl = `https://downloaded-only.example.test/${bookId}`
    expect((await supabase.from('books').insert({ id: bookId, novel_id: null as unknown as string, title: 'Downloaded-only fixture', format: 'WEB', file_size: 0, source_url: sourceUrl, language: 'zh', import_state: 'ready' })).error).toBeNull()
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: '', liveEnabled: false, model: 'test-only', root: '' }
    const manager = new TranslationBatchManager(configuration)
    try {
      const source = (await supabase.from('novel_sources').select('*').eq('book_id', bookId).single()).data!
      const contents = discoverContents({ url: sourceUrl, title: 'Contents', links: [1, 2, 3, 4].map(number => ({ title: `Chapter ${number}`, url: `${sourceUrl}/${number}` })), truncated: false }, { chapterLinks: [], chapterCount: 4, indexUrl: sourceUrl })
      expect((await supabase.from('novel_sources').update({ contents_data: contents as unknown as Json }).eq('id', source.id)).error).toBeNull()
      const ownerId = await ensureSession()
      for (const number of [2, 4]) {
        const serialized = JSON.stringify({ title: `Chapter ${number}`, paragraphs: [`Original ${number}.`] })
        const path = `${ownerId}/sources/${source.id}/${number}.json`
        const hash = createHash('sha256').update(serialized).digest('hex')
        expect((await supabase.storage.from('library').upload(path, new TextEncoder().encode(serialized), { contentType: 'application/json' })).error).toBeNull()
        expect((await supabase.from('source_chapters').insert({ source_id: source.id, url: `${sourceUrl}/${number}`, title: `Chapter ${number}`, content_path: path, content_hash: hash, word_count: 2 })).error).toBeNull()
      }
      await saveTranslationSettings(bookId, { targetLanguage: 'en', mainSource: source.id, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      const plan = (await manager.handle(token, { action: 'plan', bookId, allUntranslated: true, chaptersPerRequest: 10 })).plan!
      expect(plan).toMatchObject({ from: 1, to: 4, count: 2, missingCount: 0, undownloadedCount: 2 })
      const manual = (await manager.handle(token, { action: 'plan', bookId, from: 1, to: 4 })).plan!
      expect(manual.missingCount).toBe(2)
      const batchId = crypto.randomUUID()
      const changed = await supabase.rpc('create_untranslated_translation_batch', { request_id: crypto.randomUUID(), target_book: bookId, chapter_count: 4, expected_revision: plan.revision, chosen_model: plan.model, cost_estimate: { ...plan, count: 3 } as unknown as Json, maximum_group_size: 10 })
      expect(changed.error?.message).toContain('downloaded chapters changed')
      const created = await supabase.rpc('create_untranslated_translation_batch', { request_id: batchId, target_book: bookId, chapter_count: 4, expected_revision: plan.revision, chosen_model: plan.model, cost_estimate: plan as unknown as Json, maximum_group_size: 10 })
      expect(created.error).toBeNull()
      const queued = (await manager.handle(token, { action: 'status', bookId, batchId })).status!
      expect(queued.chapters.map(chapter => chapter.position)).toEqual([1, 3])
      expect(queued.chapters.map(chapter => chapter.source_key)).toEqual([`${sourceUrl}/2`, `${sourceUrl}/4`])
      expect(queued.chapters.every(chapter => chapter.attempts === 0)).toBe(true)
    } finally { manager.stop(); await removeBook(bookId) }
  })

  it('starts durable reader jobs before generation finishes and preserves retranslation versions', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nOriginal reader chapter.'], `Reader-job-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
    const manager = new TranslationBatchManager(configuration)
    let release!: () => void
    let started!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const generating = new Promise<void>(resolve => { started = resolve })
    let batchId = ''
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      let version = 0
      inferProvider.mockReset().mockImplementation(async () => {
        version += 1
        if (version === 1) { started(); await pending }
        return { status: 'completed', output_parsed: { title: 'Chapter 1', paragraphs: [`Reader translation version ${version}.`], terminology: [] }, usage: { input_tokens: 100, output_tokens: 50 } }
      })
      const request = { action: 'translate', background: true, bookId: book.id, sourceKey: 'local:0', requestId: crypto.randomUUID(), expectedRevision: 1, confirmed: true }
      const queued = await manager.startChapter(token, request)
      batchId = queued.status!.batch!.id
      await generating
      expect(queued.status!.batch!.state).toBe('running')
      expect((await manager.startChapter(token, request)).status!.batch!.id).toBe(batchId)
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', book.id)).data).toEqual([])
      release()
      await manager.wait(batchId)
      const original = (await supabase.from('book_translation_previews').select('id,result').eq('book_id', book.id).single()).data!
      batchId = (await manager.startChapter(token, { ...request, requestId: crypto.randomUUID() })).status!.batch!.id
      await manager.wait(batchId)
      expect(inferProvider).toHaveBeenCalledTimes(1)
      batchId = (await manager.startChapter(token, { ...request, requestId: crypto.randomUUID(), retranslate: true })).status!.batch!.id
      await manager.wait(batchId)
      expect(inferProvider).toHaveBeenCalledTimes(2)
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', book.id)).data).toHaveLength(2)
      expect((await supabase.from('book_translation_previews').select('id,result').eq('id', original.id).single()).data).toEqual(original)
      await expect(manager.startChapter(token, { ...request, requestId: batchId, retranslate: false })).rejects.toThrow('different range')
    } finally { release(); manager.stop(); if (batchId) await manager.wait(batchId); await removeBook(book.id) }
  }, 30000)

  it('runs reader and bulk jobs independently while sharing overlapping chapters', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nFirst source.\n\nChapter 2\nSecond source.\n\nChapter 3\nThird source.'], `Independent-jobs-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
    const manager = new TranslationBatchManager(configuration)
    let releaseReader!: () => void
    let markReader!: () => void
    let markBulk!: () => void
    let releaseBulk!: () => void
    const readerGate = new Promise<void>(resolve => { releaseReader = resolve })
    const bulkGate = new Promise<void>(resolve => { releaseBulk = resolve })
    const readerStarted = new Promise<void>(resolve => { markReader = resolve })
    const bulkStarted = new Promise<void>(resolve => { markBulk = resolve })
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      const generated: string[] = []
      inferProvider.mockReset().mockImplementation(async request => {
        const context = JSON.parse(request.input.find((message: { role: string }) => message.role === 'user').content)
        if (context.chapters) {
          generated.push(...context.chapters.map((chapter: { sourceKey: string }) => chapter.sourceKey))
          markBulk()
          await bulkGate
          return { status: 'completed', output_parsed: { chapters: context.chapters.map((chapter: { sourceKey: string; sourceHash: string; title: string; paragraphs: { sourceParagraphId: number }[] }) => ({ sourceKey: chapter.sourceKey, sourceHash: chapter.sourceHash, title: chapter.title, paragraphs: chapter.paragraphs.map(paragraph => ({ sourceParagraphId: paragraph.sourceParagraphId, text: `Translated ${chapter.sourceKey}.` })), terminology: [], completion: 'complete' })) } }
        }
        generated.push(context.source.key)
        if (context.source.key === 'local:1') { markReader(); await readerGate } else markBulk()
        return { status: 'completed', output_parsed: { title: context.source.title, paragraphs: [`Translated ${context.source.key}.`], terminology: [] } }
      })
      const readerRequest = { action: 'translate', background: true, bookId: book.id, sourceKey: 'local:1', requestId: crypto.randomUUID(), expectedRevision: 1, confirmed: true }
      const reader = (await manager.startChapter(token, readerRequest)).status!.batch!
      await readerStarted
      const bulk = (await manager.handle(token, { action: 'start', bookId: book.id, from: 1, to: 3, requestId: crypto.randomUUID(), expectedRevision: 1, chaptersPerRequest: 10, confirmed: true })).status!.batch!
      await bulkStarted
      expect(reader.request_kind).toBe('reader')
      expect(bulk.request_kind).toBe('bulk')
      expect((await manager.startChapter(token, { ...readerRequest, requestId: crypto.randomUUID() })).status!.batch!.id).toBe(reader.id)
      expect((await manager.startChapter(token, { ...readerRequest, sourceKey: 'local:0', requestId: crypto.randomUUID() })).status!.batch!.id).toBe(bulk.id)
      expect((await manager.handle(token, { action: 'status', bookId: book.id })).status!.batch!.id).toBe(bulk.id)
      releaseReader()
      releaseBulk()
      await manager.drain()
      const completed = (await manager.handle(token, { action: 'status', bookId: book.id, batchId: bulk.id })).status!
      expect(completed.batch!.state).toBe('completed')
      expect(completed.chapters[1].state).toBe('skipped')
      expect(generated.sort()).toEqual(['local:0', 'local:1', 'local:2'])
      expect(inferProvider).toHaveBeenCalledTimes(2)
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', book.id)).data).toHaveLength(3)
    } finally { releaseReader(); releaseBulk(); manager.stop(); await manager.drain(); await removeBook(book.id) }
  }, 30000)

  it('saves complete grouped chapters from truncated output and retries only unfinished work', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nOriginal first.\n\nChapter 2\nOriginal second.\n\nChapter 3\nOriginal third.'], `Grouped-worker-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', groupOutputLimit: 32768, root: '' }
    const manager = new TranslationBatchManager(configuration, 0)
    let batchId = ''
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      const submitted: string[][] = []
      let truncated = true
      inferProvider.mockReset().mockImplementation(async request => {
        const prompt = JSON.parse(request.input.find((message: { role: string }) => message.role === 'user').content)
        submitted.push(prompt.chapters.map((chapter: { sourceKey: string }) => chapter.sourceKey))
        const results = prompt.chapters.map((chapter: { sourceKey: string; sourceHash: string; title: string; paragraphs: { sourceParagraphId: number }[] }) => ({ sourceKey: chapter.sourceKey, sourceHash: chapter.sourceHash, title: chapter.title, paragraphs: chapter.paragraphs.map(paragraph => ({ sourceParagraphId: paragraph.sourceParagraphId, text: `Translated ${chapter.sourceKey}.` })), terminology: [], completion: 'complete' }))
        if (truncated) {
          truncated = false
          return { id: 'partial-group', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: `{"chapters":[${JSON.stringify(results[0])},${JSON.stringify(results[1])},{"sourceKey":"local:2","title":"cut off`, usage: { input_tokens: 3000, output_tokens: 900 } }
        }
        expect(prompt.recentTranslations.map((chapter: { text: string }) => chapter.text)).toEqual(['Translated local:0.', 'Translated local:1.'])
        return { id: 'retry-group', status: 'completed', output_parsed: { chapters: results }, usage: { input_tokens: 1000, output_tokens: 200 } }
      })
      const request = { action: 'start', requestId: crypto.randomUUID(), bookId: book.id, from: 1, to: 3, expectedRevision: 1, chaptersPerRequest: 10, confirmed: true }
      batchId = (await manager.handle(token, request)).status!.batch!.id
      await manager.wait(batchId)
      const partial = (await manager.handle(token, { action: 'status', bookId: book.id, batchId })).status!
      expect(partial.batch?.state).toBe('completed')
      expect(partial.chapters.map(chapter => chapter.state)).toEqual(['completed', 'completed', 'completed'])
      expect(partial.chapters.map(chapter => chapter.attempts)).toEqual([1, 1, 2])
      expect((await supabase.from('book_translation_previews').select('context').eq('book_id', book.id).eq('source_key', 'local:0').single()).data?.context).toMatchObject({ generation: { recovered: true, chapterComplete: true, status: 'incomplete', groupSize: 3 } })
      expect((await manager.handle(token, { action: 'status', bookId: book.id, batchId })).status?.batch?.state).toBe('completed')
      expect(submitted).toEqual([['local:0', 'local:1', 'local:2'], ['local:2']])
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', book.id)).data).toHaveLength(3)
      expect((await getChapter(book.id, 0))?.html).toContain('Original first.')
    } finally { manager.stop(); if (batchId) await manager.wait(batchId); await removeBook(book.id) }
  }, 30000)

  it('adapts groups and refuses duplicate or structurally incomplete chapter results', async () => {
    const { book } = await saveBook(await importBook(new File([Array.from({ length: 6 }, (_, index) => `Chapter ${index + 1}\nOriginal ${index + 1}.`).join('\n\n')], `Grouped-validation-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'gpt-4o-mini', root: '', translationMaxAttempts: 1 }
    const manager = new TranslationBatchManager(configuration)
    let batchId = ''
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      inferProvider.mockReset().mockImplementationOnce(async request => {
        const prompt = JSON.parse(request.input.find((message: { role: string }) => message.role === 'user').content)
        expect(prompt.chapters.length).toBeLessThan(6)
        expect(request.max_output_tokens).toBeLessThanOrEqual(16384)
        const results = prompt.chapters.map((chapter: { sourceKey: string; sourceHash: string; title: string; paragraphs: { sourceParagraphId: number }[] }) => ({ sourceKey: chapter.sourceKey, sourceHash: chapter.sourceHash, title: chapter.title, paragraphs: chapter.paragraphs.map(paragraph => ({ sourceParagraphId: paragraph.sourceParagraphId, text: 'Complete translation.' })), terminology: [], completion: 'complete' }))
        results[2].paragraphs[0].sourceParagraphId = 99
        return { status: 'completed', output_parsed: { chapters: [results[0], ...results] } }
      })
      batchId = (await manager.handle(token, { action: 'start', bookId: book.id, requestId: crypto.randomUUID(), from: 1, to: 6, chaptersPerRequest: 10, expectedRevision: 1, confirmed: true })).status!.batch!.id
      await manager.wait(batchId)
      const result = (await manager.handle(token, { action: 'status', bookId: book.id, batchId })).status!
      expect(result.chapters[0].state).toBe('failed')
      expect(result.chapters[1].state).toBe('completed')
      expect(result.chapters[2].state).toBe('failed')
      expect(result.chapters.at(-1)).toMatchObject({ state: 'pending', attempts: 0 })
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', book.id).in('source_key', ['local:0', 'local:2'])).data).toEqual([])
      expect(inferProvider).toHaveBeenCalledTimes(1)
    } finally { manager.stop(); if (batchId) await manager.wait(batchId); await removeBook(book.id) }
  }, 30000)

  it('pauses bulk translation on source or preference changes and cancels without replaying work', async () => {
    const ownerId = await ensureSession()
    const bookId = crypto.randomUUID().replaceAll('-', '')
    const sourceUrl = `https://batch-integrity.example.test/${bookId}`
    expect((await supabase.from('books').insert({ id: bookId, novel_id: null as unknown as string, title: 'Bulk integrity', format: 'WEB', original_path: null, file_size: 0, source_url: sourceUrl, language: 'zh', import_state: 'ready' })).error).toBeNull()
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const manager = new TranslationBatchManager(configuration)
    let batchId = ''
    try {
      const source = (await supabase.from('novel_sources').select('*').eq('book_id', bookId).single()).data!
      const contents = discoverContents({ url: sourceUrl, title: 'Contents', truncated: false, links: [1, 2].map(number => ({ title: `Chapter ${number}`, url: `${sourceUrl}/${number}` })) }, { chapterLinks: [], chapterCount: 2, indexUrl: sourceUrl })
      expect((await supabase.from('novel_sources').update({ contents_data: contents as unknown as Json }).eq('id', source.id)).error).toBeNull()
      const hashes: string[] = []
      for (const number of [1, 2]) {
        const json = JSON.stringify({ title: `Chapter ${number}`, paragraphs: [`Original ${number}.`] })
        const path = `${ownerId}/sources/${source.id}/${number}.json`
        hashes.push(createHash('sha256').update(json).digest('hex'))
        expect((await supabase.storage.from('library').upload(path, new TextEncoder().encode(json), { contentType: 'application/json' })).error).toBeNull()
        expect((await supabase.from('source_chapters').insert({ source_id: source.id, url: `${sourceUrl}/${number}`, title: `Chapter ${number}`, content_path: path, content_hash: hashes[number - 1], word_count: 2 })).error).toBeNull()
      }
      await saveTranslationSettings(bookId, { targetLanguage: 'en', mainSource: source.id, referenceSourceId: null, referenceBookId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      const request = { action: 'start', bookId, requestId: crypto.randomUUID(), from: 1, to: 2, expectedRevision: 1, confirmed: true, chaptersPerRequest: 2 }
      inferProvider.mockReset().mockImplementationOnce(async request => {
        const prompt = JSON.parse(request.input.find((message: { role: string }) => message.role === 'user').content)
        expect((await supabase.from('source_chapters').update({ content_hash: 'a'.repeat(64) }).eq('source_id', source.id).eq('url', `${sourceUrl}/1`)).error).toBeNull()
        return { status: 'completed', output_parsed: { chapters: prompt.chapters.map((chapter: { sourceKey: string; sourceHash: string; title: string }) => ({ sourceKey: chapter.sourceKey, sourceHash: chapter.sourceHash, title: chapter.title, paragraphs: [{ sourceParagraphId: 1, text: 'A stale response.' }], terminology: [], completion: 'complete' })) } }
      })
      batchId = (await manager.handle(token, request)).status!.batch!.id
      await manager.wait(batchId)
      const stopped = (await manager.handle(token, { action: 'status', bookId, batchId })).status!
      expect(stopped.batch).toMatchObject({ state: 'failed', error: expect.stringContaining('source changed while translating') })
      expect(stopped.chapters.map(chapter => chapter.state)).toEqual(['failed', 'failed'])
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', bookId)).data).toEqual([])
      expect(inferProvider).toHaveBeenCalledTimes(1)
      await manager.handle(token, { action: 'cancel', bookId, batchId })
      expect((await manager.handle(token, { action: 'status', bookId, batchId })).status?.batch?.state).toBe('cancelled')
      expect((await supabase.from('source_chapters').update({ content_hash: hashes[0] }).eq('source_id', source.id).eq('url', `${sourceUrl}/1`)).error).toBeNull()
      const pausedId = crypto.randomUUID()
      expect((await supabase.rpc('create_translation_batch', { request_id: pausedId, target_book: bookId, range_start: 1, range_end: 2, expected_revision: 1, chosen_model: 'test-only', cost_estimate: {} })).error).toBeNull()
      await saveTranslationSettings(bookId, { targetLanguage: 'fr', mainSource: source.id, referenceSourceId: null, referenceBookId: null, metadataSource: null, referenceMode: 'continuation' }, 1)
      await expect(manager.handle(token, { action: 'resume', bookId, batchId: pausedId, confirmed: true })).rejects.toThrow('preferences changed')
      expect(inferProvider).toHaveBeenCalledTimes(1)
      await manager.handle(token, { action: 'cancel', bookId, batchId: pausedId })
      const ended = (await manager.handle(token, { action: 'status', bookId, batchId: pausedId })).status!
      expect(ended.chapters.every(chapter => chapter.state === 'cancelled' && chapter.attempts === 0)).toBe(true)
      expect((await supabase.from('source_chapters').select('url').eq('source_id', source.id)).data).toHaveLength(2)
    } finally { manager.stop(); if (batchId) await manager.wait(batchId); await removeBook(bookId) }
  }, 30000)

  it('claims bounded translation groups without allowing another worker or replaying failed chapters', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nOne.\n\nChapter 2\nTwo.\n\nChapter 3\nThree.'], `Grouped-state-${crypto.randomUUID()}.txt`)))
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      const batchId = crypto.randomUUID()
      expect((await supabase.rpc('create_translation_batch', { request_id: batchId, target_book: book.id, range_start: 1, range_end: 3, expected_revision: 1, chosen_model: 'test-only', cost_estimate: {} })).error).toBeNull()
      expect((await supabase.from('translation_batches').update({ chapters_per_request: 3 }).eq('id', batchId)).error).toBeNull()
      const workerId = crypto.randomUUID()
      expect((await supabase.rpc('claim_translation_batch', { target_batch: batchId, worker_key: workerId })).error).toBeNull()
      const group = await supabase.rpc('claim_translation_batch_group', { target_batch: batchId, worker_key: workerId, maximum_chapters: 2 })
      expect(group.error).toBeNull()
      expect(group.data?.map(chapter => chapter.position).sort()).toEqual([0, 1])
      expect((await supabase.rpc('claim_translation_batch_group', { target_batch: batchId, worker_key: workerId, maximum_chapters: 2 })).error).not.toBeNull()
      expect((await supabase.rpc('claim_translation_batch_group', { target_batch: batchId, worker_key: crypto.randomUUID(), maximum_chapters: 2 })).data).toEqual([])
      expect((await supabase.from('translation_batches').update({ lease_expires_at: new Date(Date.now() + 10000).toISOString() }).eq('id', batchId)).error).toBeNull()
      expect((await supabase.rpc('renew_translation_batch_lease', { target_batch: batchId, worker_key: workerId })).data).toBe(true)
      expect(Date.parse((await supabase.from('translation_batches').select('lease_expires_at').eq('id', batchId).single()).data!.lease_expires_at!)).toBeGreaterThan(Date.now() + 240000)
      expect((await supabase.rpc('renew_translation_batch_lease', { target_batch: batchId, worker_key: crypto.randomUUID() })).error).not.toBeNull()
      expect((await supabase.rpc('control_translation_batch', { target_batch: batchId, command: 'pause' })).error).toBeNull()
      expect((await supabase.rpc('renew_translation_batch_lease', { target_batch: batchId, worker_key: workerId })).data).toBe(false)
      expect((await supabase.from('translation_batches').update({ state: 'running', lease_expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', batchId)).error).toBeNull()
      expect((await supabase.rpc('renew_translation_batch_lease', { target_batch: batchId, worker_key: workerId })).error?.message).toContain('expired or changed')
      expect((await supabase.rpc('fail_translation_batch', { target_batch: batchId, worker_key: workerId, failure_message: 'Unfinished group' })).error).toBeNull()
      expect((await supabase.from('translation_batch_chapters').select('state').eq('batch_id', batchId).order('position')).data?.map(chapter => chapter.state)).toEqual(['failed', 'failed', 'pending'])
      expect((await supabase.rpc('claim_translation_batch', { target_batch: batchId, worker_key: crypto.randomUUID() })).error?.message).toContain('Confirm retrying')
    } finally { await removeBook(book.id) }
  })

  it('records per-request usage and quota errors without duplicating grouped cost or exposing another owner', async () => {
    const ownerId = await ensureSession()
    const trackedIds: string[] = []
    try {
      const responseId = crypto.randomUUID()
      await trackModelResponse('gpt-5.6-luna', { client: supabase, operation: 'translation_group', groupSize: 10 }, async () => ({ id: responseId, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1000, output_tokens: 2000, input_tokens_details: { cached_tokens: 200 } } }))
      const group = (await supabase.from('ai_request_usage').select('*').eq('response_id', responseId).single()).data!
      trackedIds.push(group.id)
      expect(group).toMatchObject({ owner_id: ownerId, group_size: 10, input_tokens: 1000, output_tokens: 2000, state: 'incomplete', error_code: 'output_limit' })
      expect(Number(group.estimated_usd)).toBeCloseTo(0.002564, 8)
      await expect(trackModelResponse('gpt-5.6-luna', { client: supabase, operation: 'quota_fixture' }, async () => { throw { status: 429, code: 'insufficient_quota' } })).rejects.toMatchObject({ code: 'insufficient_quota' })
      const quota = (await supabase.from('ai_request_usage').select('*').eq('operation', 'quota_fixture').single()).data!
      trackedIds.push(quota.id)
      expect(quota).toMatchObject({ state: 'failed', error_code: 'quota', estimated_usd: null, input_tokens: null })
      const month = new Date().toISOString().slice(0, 7) + '-01'
      const summary = await supabase.rpc('ai_usage_overview', { month_start: month })
      expect(summary.error).toBeNull()
      expect(summary.data).toMatchObject({ providerSignal: { errorCode: 'quota' } })
      const outsider = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: crypto.randomUUID() } })
      await outsider.auth.signInAnonymously()
      expect((await outsider.from('ai_request_usage').select('id').in('id', trackedIds)).data).toEqual([])
      expect((await outsider.rpc('ai_usage_overview', { month_start: month })).data).toMatchObject({ totals: { requests: 0 } })
    } finally { if (trackedIds.length) await supabase.from('ai_request_usage').delete().in('id', trackedIds) }
  })

  it('keeps private hosting opt-in locally and denies other owners once enabled', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nPrivate content.'], `Private-policy-${crypto.randomUUID()}.txt`)))
    const ownerId = await ensureSession()
    try {
      expect((await supabase.rpc('library_access_status')).data).toEqual({ restricted: false, allowed: true })
      expect((await supabase.rpc('configure_private_library', { allowed_user: ownerId })).error).not.toBeNull()
      const outsider = crypto.randomUUID()
      const outsiderBook = crypto.randomUUID().replaceAll('-', '')
      const query = `begin;
        insert into auth.users(id,is_anonymous,email_confirmed_at) values ('${outsider}',false,now());
        insert into storage.objects(bucket_id,name) values ('library','${outsider}/policy-fixture.txt');
        set local role authenticated;
        select set_config('request.jwt.claims','{"sub":"${outsider}","is_anonymous":false}',true);
        insert into public.books(id,title,format,file_size,source_url,import_state) values ('${outsiderBook}','Policy fixture','WEB',0,'https://policy.example.test/${outsiderBook}','ready');
        select 'own-before=' || count(*) from public.books where id = '${outsiderBook}';
        select 'files-before=' || count(*) from storage.objects where bucket_id='library' and name='${outsider}/policy-fixture.txt';
        reset role;
        insert into novelist_private.access_owner(singleton,user_id) values (true,'${ownerId}');
        set local role authenticated;
        select set_config('request.jwt.claims','{"sub":"${ownerId}","is_anonymous":false}',true);
        select 'owner=' || count(*) from public.books where id = '${book.id}';
        select 'owner-files=' || (count(*) > 0) from storage.objects where bucket_id='library' and starts_with(name,'${ownerId}/');
        select set_config('request.jwt.claims','{"sub":"${outsider}","is_anonymous":false}',true);
        select 'outsider=' || count(*) from public.books where id in ('${book.id}','${outsiderBook}');
        select 'files-after=' || count(*) from storage.objects where bucket_id='library' and name='${outsider}/policy-fixture.txt';
        select set_config('request.jwt.claims','{"sub":"${ownerId}","is_anonymous":true}',true);
        select 'anonymous=' || count(*) from public.books where id = '${book.id}';
        rollback;`
      const output = execFileSync('docker', ['exec', 'supabase_db_translator', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' })
      expect(output).toContain('own-before=1')
      expect(output).toContain('files-before=1')
      expect(output).toContain('owner=1')
      expect(output).toContain('owner-files=true')
      expect(output).toContain('outsider=0')
      expect(output).toContain('files-after=0')
      expect(output).toContain('anonymous=0')
      expect((await supabase.rpc('library_access_status')).data).toEqual({ restricted: false, allowed: true })
    } finally { await removeBook(book.id) }
  })

  it('allows only the configured permanent account through the hosted API', async () => {
    await ensureSession()
    const configuration: AIConfiguration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: '', liveEnabled: false, model: 'test-only', root: '', hosted: true, publicOrigin: 'https://127.0.0.1', allowedUserId: crypto.randomUUID() }
    const accounts: { id: string; token: string }[] = []
    const { app, batches } = createProductionApp(configuration)
    const server = createServer(app)
    try {
      for (const label of ['owner', 'other']) {
        const client = createClient(configuration.supabaseUrl, configuration.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: `host-test-${label}-${crypto.randomUUID()}` } })
        const result = await client.auth.signUp({ email: `novelist-${label}-${crypto.randomUUID()}@example.test`, password: crypto.randomUUID() })
        if (result.data.user) accounts.push({ id: result.data.user.id, token: result.data.session?.access_token ?? '' })
        expect(result.error).toBeNull()
        expect(result.data.user?.is_anonymous).toBe(false)
        expect(result.data.session).not.toBeNull()
      }
      configuration.allowedUserId = accounts[0].id
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      configuration.publicOrigin = `https://127.0.0.1:${address.port}`
      const headers = { Origin: configuration.publicOrigin, 'Content-Type': 'application/json' }
      const endpoint = `http://127.0.0.1:${address.port}/api/ai/source-chapter`
      const request = (token: string) => fetch(endpoint, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: '{}' })
      expect((await request(accounts[0].token)).status).toBe(200)
      expect((await request(accounts[1].token)).status).toBe(403)
      expect((await request((await supabase.auth.getSession()).data.session!.access_token)).status).toBe(403)
      expect((await fetch(endpoint, { method: 'POST', headers, body: '{}' })).status).toBe(401)
    } finally {
      batches.stop()
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      if (accounts.length) execFileSync('docker', ['exec', 'supabase_db_translator', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `delete from auth.users where id in (${accounts.map(account => `'${account.id}'::uuid`).join(',')})`], { stdio: 'ignore' })
    }
  })

  it('fingerprints only the selected owner and compares actual private file bytes', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nManifest fixture.'], `Manifest-${crypto.randomUUID()}.txt`)))
    const ownerId = await ensureSession()
    const database = new Client({ host: '127.0.0.1', port: 55322, user: 'postgres', password: 'postgres', database: 'postgres' })
    try {
      await database.connect()
      const source = await createLibraryManifest(database, supabase, ownerId)
      expect(source.ownerId).toBe(ownerId)
      expect(source.tables.books.count).toBeGreaterThanOrEqual(1)
      expect(source.objects.some(object => object.path.includes(book.id))).toBe(true)
      expect(source.objects.every(object => object.path.startsWith(`${ownerId}/`) && object.bytes > 0 && object.sha256.length === 64)).toBe(true)
      const target = await createLibraryManifest(database, supabase, ownerId)
      expect(compareLibraryManifests(source, target)).toEqual([])
      target.objects[0].sha256 = 'a'.repeat(64)
      expect(compareLibraryManifests(source, target)).toEqual([`Storage object differs: ${target.objects[0].path}`])
      expect((await database.query('show transaction_read_only')).rows[0].transaction_read_only).toBe('off')
    } finally { await database.end(); await removeBook(book.id) }
  }, 30000)

  it('stores private translation queues and never automatically retries an interrupted chapter', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nOne.\n\nChapter 2\nTwo.\n\nChapter 3\nThree.'], `Batch-state-${crypto.randomUUID()}.txt`)))
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      const batchId = crypto.randomUUID()
      const input = { request_id: batchId, target_book: book.id, range_start: 1, range_end: 3, expected_revision: 1, chosen_model: 'test-only', cost_estimate: {} }
      expect((await supabase.rpc('create_translation_batch', input)).error).toBeNull()
      expect((await supabase.rpc('create_translation_batch', input)).data).toBe(batchId)
      expect((await supabase.rpc('create_translation_batch', { ...input, request_id: crypto.randomUUID() })).error).not.toBeNull()
      const worker = crypto.randomUUID()
      expect((await supabase.rpc('claim_translation_batch', { target_batch: batchId, worker_key: worker })).error).toBeNull()
      expect((await supabase.rpc('claim_translation_batch', { target_batch: batchId, worker_key: crypto.randomUUID() })).error).not.toBeNull()
      const first = await supabase.rpc('claim_translation_batch_chapter', { target_batch: batchId, worker_key: worker })
      expect(first.error).toBeNull()
      expect(first.data).toMatchObject([{ position: 0, source_key: 'local:0', attempts: 1, state: 'running' }])
      expect((await supabase.rpc('claim_translation_batch_chapter', { target_batch: batchId, worker_key: worker })).error).not.toBeNull()
      expect((await supabase.rpc('control_translation_batch', { target_batch: batchId, command: 'pause' })).error).toBeNull()
      expect((await supabase.from('translation_batches').select('state').eq('id', batchId).single()).data?.state).toBe('pausing')
      expect((await supabase.from('translation_batches').update({ lease_expires_at: new Date(Date.now() - 10000).toISOString() }).eq('id', batchId)).error).toBeNull()
      expect((await supabase.rpc('control_translation_batch', { target_batch: batchId, command: 'status' })).error).toBeNull()
      expect((await supabase.from('translation_batch_chapters').select('state,attempts').eq('batch_id', batchId).eq('position', 0).single()).data).toEqual({ state: 'failed', attempts: 1 })
      expect((await supabase.rpc('claim_translation_batch', { target_batch: batchId, worker_key: crypto.randomUUID() })).error?.message).toContain('Confirm retrying')
      const resumed = crypto.randomUUID()
      expect((await supabase.rpc('claim_translation_batch', { target_batch: batchId, worker_key: resumed, retry_failed: true })).error).toBeNull()
      const retried = await supabase.rpc('claim_translation_batch_chapter', { target_batch: batchId, worker_key: resumed })
      expect(retried.data?.[0]).toMatchObject({ position: 0, attempts: 2 })
      expect((await supabase.rpc('control_translation_batch', { target_batch: batchId, command: 'cancel' })).error).toBeNull()
      expect((await supabase.rpc('fail_translation_batch', { target_batch: batchId, worker_key: resumed, failure_message: 'Fixture failure' })).error).toBeNull()
      expect((await supabase.from('translation_batch_chapters').select('state').eq('batch_id', batchId).order('position')).data?.map(chapter => chapter.state)).toEqual(['failed', 'cancelled', 'cancelled'])
      const outsider = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
      await outsider.auth.signInAnonymously()
      expect((await outsider.from('translation_batches').select('*').eq('id', batchId)).data).toEqual([])
      expect((await outsider.rpc('control_translation_batch', { target_batch: batchId, command: 'cancel' })).error).not.toBeNull()
      await outsider.auth.signOut()
      expect((await supabase.rpc('control_translation_batch', { target_batch: batchId, command: 'cancel' })).error).toBeNull()
      expect((await supabase.from('translation_batches').select('state').eq('id', batchId).single()).data?.state).toBe('cancelled')
      expect((await getChapter(book.id, 0))?.html).toContain('One.')
    } finally { await removeBook(book.id) }
  })

  it('resumes translated chapter 125 without being overwritten by chapter 122 or a delayed save', async () => {
    const ownerId = await ensureSession()
    const bookId = crypto.randomUUID().replaceAll('-', '')
    const url = `https://resume.example.test/${bookId}`
    expect((await supabase.from('books').insert({ id: bookId, novel_id: null as unknown as string, title: 'Translated resume', format: 'WEB', original_path: null, file_size: 0, source_url: url, import_state: 'ready' })).error).toBeNull()
    try {
      const source = await supabase.from('novel_sources').select('id').eq('book_id', bookId).single()
      expect(source.error).toBeNull()
      const sourceId = source.data!.id
      const contents = discoverContents({ url, title: 'Contents', links: Array.from({ length: 130 }, (_, position) => ({ title: `Chapter ${position + 1}`, url: `${url}/${position + 1}` })), truncated: false }, { chapterLinks: [], chapterCount: 130, indexUrl: url })
      expect((await supabase.from('novel_sources').update({ contents_data: contents as unknown as Json }).eq('id', sourceId)).error).toBeNull()
      const version = await supabase.from('book_translation_previews').insert({ book_id: bookId, kind: 'chapter', source_key: `${url}/125`, target_language: 'en', result: { title: 'Chapter 125', paragraphs: ['Stored translation.'], terminology: [] }, context: { source: { sourceId } } }).select('id').single()
      expect(version.error).toBeNull()
      const older = new Date(Date.now() - 10000).toISOString()
      const newer = new Date(Date.now() - 5000).toISOString()
      await saveSourceProgress(sourceId, `${url}/122`, 0.3, { observedAt: older })
      await saveSourceProgress(sourceId, `${url}/125`, 0.65, { language: 'en', versionId: version.data!.id, observedAt: newer })
      await saveSourceProgress(sourceId, `${url}/122`, 0.4, { observedAt: older })
      expect((await supabase.from('reading_progress').select('*').eq('book_id', bookId).single()).data).toMatchObject({ chapter: 124, source_chapter_url: `${url}/125`, target_language: 'en', translation_version: version.data!.id, fraction: 0.65 })
      expect((await supabase.from('source_reading_progress').select('*').eq('source_id', sourceId).single()).data?.chapter_url).toBe(`${url}/122`)
      expect((await supabase.from('source_translation_progress').select('*').eq('source_id', sourceId).single()).data).toMatchObject({ chapter_url: `${url}/125`, fraction: 0.65, target_language: 'en' })
      await expect(saveSourceProgress(sourceId, `${url}/126`, 0.2, { language: 'en', versionId: version.data!.id })).rejects.toMatchObject({ message: 'Translation version does not match this chapter' })
      const outsider = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
      await outsider.auth.signInAnonymously()
      expect((await outsider.rpc('save_source_reading_position', { target_source: sourceId, chapter_url: `${url}/125`, fraction: 0.1 })).error).not.toBeNull()
      expect((await outsider.from('source_translation_progress').select('*').eq('owner_id', ownerId)).data).toEqual([])
      await outsider.auth.signOut()
    } finally { await removeBook(bookId) }
  })

  it('permits concurrent AI tasks and releases each local slot exactly once', async () => {
    await ensureSession()
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: '', liveEnabled: false, model: 'test-only', root: '', maxConcurrentRequests: 2 }
    const tasks = await Promise.all([acquireAILibrary(token, configuration, 0), acquireAILibrary(token, configuration, 0)])
    try {
      await expect(acquireAILibrary(token, configuration, 0)).rejects.toThrow('All 2 local AI slots are busy')
      tasks[0].release()
      tasks[0].release()
      const replacement = await acquireAILibrary(token, configuration, 0)
      tasks.push(replacement)
      await expect(acquireAILibrary(token, configuration, 0)).rejects.toThrow('All 2 local AI slots are busy')
    } finally { tasks.forEach(task => task.release()) }
    const available = await acquireAILibrary(token, configuration, 0)
    available.release()
  })

  it('answers reading questions with exact citations, no future text and durable private history', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nThe lamp was green.\n\nChapter 2\nFuture secret not yet read.'], `Reading-chat-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
    const input = { requestId: crypto.randomUUID(), bookId: book.id, sourceKey: 'local:0', question: 'What color is the lamp?', confirmed: true }
    try {
      inferProvider.mockReset().mockResolvedValue({ status: 'completed', output_parsed: { answer: 'The lamp is green.', citations: [{ sourceId: 'original', quote: 'The lamp was green.' }] }, usage: { input_tokens: 50, output_tokens: 20 } })
      const reply = await runReaderChat(token, input, configuration)
      expect(reply).toMatchObject({ status: 'completed', answer: 'The lamp is green.', input_tokens: 50 })
      const prompt = JSON.parse(inferProvider.mock.calls[0][0].input.at(-1).content)
      expect(prompt.sources).toHaveLength(1)
      expect(JSON.stringify(prompt)).not.toContain('Future secret')
      expect(reply.citations).toEqual([{ sourceId: 'original', sourceKey: 'local:0', title: expect.any(String), quote: 'The lamp was green.' }])
      expect(await runReaderChat(token, input, configuration)).toMatchObject({ id: input.requestId })
      expect(inferProvider).toHaveBeenCalledTimes(1)
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceBookId: null, referenceSourceId: null, referenceMode: 'continuation', metadataSource: null }, 0)
      expect((await supabase.rpc('set_reader_models', { target_book: book.id, expected_revision: 1, translation_choice: 'gpt-4.1-mini', chat_choice: 'gpt-4.1-nano' })).error).toBeNull()
      inferProvider.mockResolvedValueOnce({ status: 'completed', output_parsed: { answer: 'Unsupported.', citations: [{ sourceId: 'original', quote: 'Future secret' }] } })
      await expect(runReaderChat(token, { ...input, requestId: crypto.randomUUID() }, configuration)).rejects.toThrow('unsupported quotation')
      expect(inferProvider.mock.lastCall?.[0].model).toBe('gpt-4.1-nano')
      expect(inferProvider.mock.lastCall?.[0]).not.toHaveProperty('reasoning')
      expect((await supabase.from('reader_chat_turns').select('status').eq('book_id', book.id)).data?.map(turn => turn.status).sort()).toEqual(['completed', 'failed'])
      await expect(runReaderChat(token, { ...input, requestId: crypto.randomUUID(), confirmed: false }, configuration)).rejects.toThrow('confirmation')
      const outsider = createClient(configuration.supabaseUrl, configuration.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
      await outsider.auth.signInAnonymously()
      expect((await outsider.from('reader_chat_turns').select('*').eq('book_id', book.id)).data).toEqual([])
      await expect(runReaderChat((await outsider.auth.getSession()).data.session!.access_token, { ...input, requestId: crypto.randomUUID() }, configuration)).rejects.toThrow('Book not found')
      await outsider.auth.signOut()
      inferProvider.mockResolvedValueOnce({ status: 'completed', output_parsed: { title: 'Chapter 1', paragraphs: ['Chapter 1', 'The lamp was green.'], terminology: [] } })
      const translation = await runBookTranslation(token, { bookId: book.id, sourceKey: 'local:0', action: 'translate', confirmed: true }, configuration)
      expect(inferProvider.mock.lastCall?.[0].model).toBe('gpt-4.1-mini')
      if (!('timings' in translation)) throw new Error('Translation timings were not returned.')
      expect(translation.timings?.preparationMs).toBeGreaterThanOrEqual(0)
      expect(translation.timings?.guideMs).toBe(0)
      expect((await supabase.from('book_translation_previews').select('context').eq('id', translation.previewId!).single()).data?.context).toMatchObject({ timings: translation.timings })
      expect((await getChapter(book.id, 0))?.html).toContain('The lamp was green.')
    } finally { await removeBook(book.id) }
  })

  it('retrieves distant saved passages, excludes future chapters and replaces stale translation indexes', async () => {
    const { book } = await saveBook(await importBook(new File([Array.from({ length: 12 }, (_, position) => `Chapter ${position + 1}\n${position === 0 ? 'The crystal compass points toward the hidden harbor. 照月灯是渡口的信物。' : position === 11 ? 'The future compass secret must not be retrieved.' : 'A quiet journey continues along the road.'}`).join('\n\n')], `Retrieval-${crypto.randomUUID()}.txt`)))
    let glossaryBookId: string | undefined
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
    const input = { bookId: book.id, sourceKey: 'local:10' }
    try {
      const first = await runReaderIndex(token, input, configuration)
      expect(first).toMatchObject({ chapters: 11, indexedChapters: 11, remaining: 0 })
      expect(first.estimatedBytes).toBeGreaterThan(0)
      expect(first.estimatedBytes).toBeLessThan(100000)
      expect(await runReaderIndex(token, input, configuration)).toEqual(first)
      expect((await supabase.from('reader_search_documents').update({ chapter_position: 999, title: 'Stale title' }).eq('book_id', book.id).eq('source_key', 'local:0')).error).toBeNull()
      await runReaderIndex(token, input, configuration)
      expect((await supabase.from('reader_search_documents').select('chapter_position,title').eq('book_id', book.id).eq('source_key', 'local:0').single()).data).toMatchObject({ chapter_position: 0, title: expect.not.stringMatching('Stale title') })
      const access = await acquireAILibrary(token, configuration, 0)
      try {
        const hits = await retrieveReaderPassages(access, input, 'What does the crystal compass point toward?')
        expect(hits.some(hit => hit.position === 0 && hit.text.includes('hidden harbor'))).toBe(true)
        expect(hits.every(hit => hit.position < 10)).toBe(true)
        expect(JSON.stringify(hits)).not.toContain('future compass')
      } finally { access.release() }
      inferProvider.mockReset().mockImplementation(async request => {
        const prompt = JSON.parse(request.input.at(-1).content)
        const evidence = prompt.sources.find((source: { text: string }) => source.text.includes('hidden harbor'))
        expect(evidence).toBeTruthy()
        expect(JSON.stringify(prompt)).not.toContain('future compass')
        return { status: 'completed', output_parsed: { answer: 'It points toward the hidden harbor.', citations: [{ sourceId: evidence.id, quote: 'The crystal compass points toward the hidden harbor.' }] } }
      })
      const answer = await runReaderChat(token, { ...input, requestId: crypto.randomUUID(), question: 'Where does the crystal compass point?', confirmed: true }, configuration)
      expect(answer.status).toBe('completed')
      expect(inferProvider).toHaveBeenCalledTimes(1)
      const sourceId = (await supabase.from('novel_sources').select('id').eq('book_id', book.id).single()).data!.id
      const version = await supabase.from('book_translation_previews').insert({ book_id: book.id, kind: 'chapter', source_key: 'local:0', target_language: 'en', result: { title: 'Chapter 1', paragraphs: ['The obsolete astrolabe points north.'], terminology: [] }, context: { source: { sourceId } } }).select('id').single()
      expect(version.error).toBeNull()
      await runReaderIndex(token, input, configuration)
      const previousIndex = await supabase.from('reader_search_documents').select('id').eq('book_id', book.id).eq('variant', 'translation:en').single()
      expect(previousIndex.error).toBeNull()
      expect((await supabase.from('book_translation_previews').insert({ book_id: book.id, kind: 'chapter', source_key: 'local:0', target_language: 'en', result: { title: 'Chapter 1', paragraphs: ['The corrected compass points north.'], terminology: [] }, context: { source: { sourceId } } })).error).toBeNull()
      await runReaderIndex(token, input, configuration)
      expect((await supabase.from('reader_search_documents').select('id').eq('book_id', book.id).eq('variant', 'translation:en')).data).toHaveLength(1)
      expect((await supabase.rpc('search_reader_passages', { document_ids: [previousIndex.data!.id], query_terms: ['obsolete', 'astrolabe'] })).data).toEqual([])
      const outsider = createClient(configuration.supabaseUrl, configuration.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
      await outsider.auth.signInAnonymously()
      expect((await outsider.rpc('search_reader_passages', { document_ids: [previousIndex.data!.id], query_terms: ['compass'] })).data).toEqual([])
      await outsider.auth.signOut()
      const glossaryBook = (await saveBook(await importBook(new File(['Chapter 1\n照月灯。'], `Search-glossary-${crypto.randomUUID()}.txt`)))).book
      glossaryBookId = glossaryBook.id
      await saveGlossaryEntry({ ...glossaryBook, language: 'zh' }, { sourceTerm: '照月灯', targetTerm: 'Moonlit Lantern', targetLanguage: 'en', category: 'item', scope: 'novel', chapter: 0, aliases: [], sense: '', notes: '' })
      expect((await supabase.from('novel_sources').update({ language: 'zh-Hant' }).eq('id', sourceId)).error).toBeNull()
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: sourceId, referenceBookId: null, referenceSourceId: null, referenceMode: 'continuation', metadataSource: null }, 0)
      const searchAccess = await acquireAILibrary(token, configuration, 0)
      try {
        expect(await retrieveReaderPassages(searchAccess, input, 'Moonlit Lantern')).toEqual([])
        expect((await supabase.rpc('set_glossary_sources', { target_book: book.id, expected_revision: 1, selected_sources: [{ bookId: glossaryBook.id, sourceLanguage: 'zh', targetLanguage: 'en' }] })).error).toBeNull()
        const chinese = await retrieveReaderPassages(searchAccess, input, 'Moonlit Lantern')
        expect(chinese.some(passage => passage.position === 0 && passage.text.includes('照月灯是渡口的信物'))).toBe(true)
      } finally { searchAccess.release() }
    } finally { await removeBook(book.id); if (glossaryBookId) await removeBook(glossaryBookId) }
  }, 30000)

  it('never saves incomplete translations and reports provider failures without discarding valid prose for bad terms', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\n林遥提着照月灯。\n\n他等着。'], `Translation-completion-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
    const input = { bookId: book.id, sourceKey: 'local:0', action: 'translate', confirmed: true }
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceSourceId: null, referenceBookId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      inferProvider.mockReset().mockResolvedValueOnce({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"title":"Chapter' })
      await expect(runBookTranslation(token, input, configuration)).rejects.toThrow('16,384-token output limit')
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', book.id)).data).toEqual([])
      expect(inferProvider).toHaveBeenCalledTimes(1)
      inferProvider.mockRejectedValueOnce(Object.assign(new Error('provider private detail'), { name: 'APIConnectionTimeoutError' }))
      await expect(runBookTranslation(token, input, configuration)).rejects.toThrow('timed out')
      inferProvider.mockRejectedValueOnce({ status: 429, code: 'rate_limit_exceeded' })
      await expect(runBookTranslation(token, input, configuration)).rejects.toThrow('rate-limited')
      inferProvider.mockResolvedValueOnce({ id: 'response-complete', status: 'completed', output_parsed: { title: 'Chapter 1', paragraphs: ['Lin Yao carried the Moonlit Lantern.', 'He waited.'], terminology: [{ source: '林遥', target: 'Lin Yao', category: 'person', sense: '', evidenceQuote: '林遥提着照月灯。' }, { source: '照月灯', target: 'Moonlit Lantern', category: 'item', sense: '', evidenceQuote: 'An invented quote.' }] }, usage: { input_tokens: 100, output_tokens: 120 } })
      const result = await runBookTranslation(token, input, configuration)
      expect('translation' in result && result.translation?.paragraphs).toHaveLength(2)
      expect('translation' in result && result.translation?.terminology).toHaveLength(1)
      const previews = await supabase.from('book_translation_previews').select('context').eq('book_id', book.id)
      expect(previews.data).toHaveLength(1)
      expect(previews.data![0].context).toMatchObject({ generation: { responseId: 'response-complete', status: 'completed', outputLimit: 16384, outputTokens: 120 }, warnings: expect.arrayContaining([expect.stringContaining('照月灯')]) })
      expect(inferProvider).toHaveBeenCalledTimes(4)
      expect((await getChapter(book.id, 0))?.html).toContain('林遥提着照月灯')
    } finally { logged.mockRestore(); await removeBook(book.id) }
  })

  it('suggests a noun translation from structured source evidence without applying it', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\n林遥提着照月灯。'], `Noun-suggestion-${crypto.randomUUID()}.txt`)))
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
    try {
      expect((await supabase.from('novel_sources').update({ language: 'zh' }).eq('book_id', book.id)).error).toBeNull()
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: null, referenceSourceId: null, referenceBookId: null, metadataSource: null, referenceMode: 'continuation' }, 0)
      await saveGlossaryEntry({ ...book, language: 'zh' }, { sourceTerm: '照月灯', targetTerm: 'Moonlit Lantern', targetLanguage: 'en', category: 'item', scope: 'novel', sense: '', chapter: 0, aliases: [], notes: '' })
      await saveGlossaryEntry({ ...book, language: 'zh' }, { sourceTerm: '照月宝灯', targetTerm: 'Moonlit Lanterne', targetLanguage: 'en', category: 'item', scope: 'novel', sense: 'A different named item', chapter: 0, aliases: [], notes: '' })
      const suggestion = { source: '照月灯', target: 'Moon-Illuminating Lantern', category: 'item', sense: 'Named lantern', aliases: [], evidenceQuote: '林遥提着照月灯。', explanation: 'The proposed wording emphasizes illumination.', alternatives: [{ target: 'Moonlit Lantern', explanation: 'Retains the established glossary rendering.' }], warnings: [] }
      inferProvider.mockReset().mockResolvedValueOnce({ status: 'completed', output_parsed: suggestion })
      const input = { bookId: book.id, sourceKey: 'local:0', source: '照月灯', currentTarget: 'Moonlit Lantern', targetLanguage: 'en', readerContext: 'Emphasize the literal meaning; do not invent an ability.', confirmed: true }
      expect(await suggestBookTranslationTerm(token, input, configuration)).toMatchObject({ suggestion, model: 'test-only' })
      const request = inferProvider.mock.calls[0][0]
      expect(request.text.format).toMatchObject({ type: 'json_schema', strict: true })
      const prompt = JSON.parse(request.input.at(-1).content)
      expect(prompt.readerContext).toContain('literal meaning')
      expect(prompt.approvedChoices[0].target).toBe('Moonlit Lantern')
      expect(prompt.currentChapter.originalText).toContain('林遥提着照月灯。')
      expect(prompt.relatedGlossary).toContainEqual(expect.objectContaining({ source: '照月宝灯', target: 'Moonlit Lanterne', via: 'current translation', status: 'approved', match: 'similar' }))
      expect((await supabase.from('glossary_entries').select('target_term').eq('novel_id', book.novelId!).eq('source_term', '照月灯').single()).data?.target_term).toBe('Moonlit Lantern')
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', book.id)).data).toEqual([])
      await expect(suggestBookTranslationTerm(token, { ...input, source: '不存在' }, configuration)).rejects.toThrow('must occur exactly')
      expect(inferProvider).toHaveBeenCalledTimes(1)
      inferProvider.mockResolvedValueOnce({ status: 'completed', output_parsed: { ...suggestion, evidenceQuote: 'Not in the chapter.' } })
      await expect(suggestBookTranslationTerm(token, input, configuration)).rejects.toThrow('no exact evidence')
      const { context } = await runBookTranslation(token, { bookId: book.id, sourceKey: 'local:0', action: 'context' }, configuration)
      const preview = await supabase.from('book_translation_previews').insert({ book_id: book.id, kind: 'chapter', source_key: 'local:0', target_language: 'en', context: context as unknown as Json, result: { title: 'Chapter 1', paragraphs: ['Lin Yao carried the Moonlit Lantern.', 'The current translation adds context for review.'], terminology: [] } }).select('id').single()
      expect(preview.error).toBeNull()
      inferProvider.mockResolvedValueOnce({ status: 'completed', output_parsed: suggestion })
      const contextual = await suggestBookTranslationTerm(token, { ...input, previewId: preview.data!.id }, configuration)
      expect(contextual.context.translatedCharacters).toBeGreaterThan(0)
      expect(JSON.parse(inferProvider.mock.lastCall![0].input.at(-1).content).currentChapter.translatedText).toContain('The current translation adds context for review.')
      expect((await supabase.from('book_translation_previews').select('id').eq('book_id', book.id)).data).toEqual([{ id: preview.data!.id }])
    } finally { await removeBook(book.id) }
  })

  it('groups books in private folders and removes folders without removing their books', async () => {
    const { book } = await saveBook(
      await importBook(
        new File(['Chapter 1\nKept in the library.'], `Folders-${crypto.randomUUID()}.txt`),
      ),
    )
    const folder = await saveLibraryFolder(`Vampire editions ${crypto.randomUUID()}`)
    try {
      const moved = await updateBook(book.id, (current) => ({ ...current, folderId: folder.id }))
      expect(moved.folderId).toBe(folder.id)
      expect((await getBooks()).find((entry) => entry.id === book.id)?.folderId).toBe(folder.id)
      expect((await getLibraryFolders()).some((entry) => entry.id === folder.id)).toBe(true)
      await expect(saveLibraryFolder(folder.name.toUpperCase())).rejects.toThrow('already exists')
      const renamed = await saveLibraryFolder(`${folder.name} renamed`, folder.id)
      expect(renamed.name).toContain('renamed')
      const outsider = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      await outsider.auth.signInAnonymously()
      expect((await outsider.from('library_folders').select('*').eq('id', folder.id)).data).toEqual(
        [],
      )
      const foreignFolder = await outsider
        .from('library_folders')
        .insert({ name: 'Private foreign folder' })
        .select('id')
        .single()
      expect(foreignFolder.error).toBeNull()
      expect(
        (
          await supabase
            .from('books')
            .update({ folder_id: foreignFolder.data!.id })
            .eq('id', book.id)
        ).error?.code,
      ).toBe('23503')
      expect(
        (await outsider.from('library_folders').delete().eq('id', folder.id).select('id')).data,
      ).toEqual([])
      await outsider.from('library_folders').delete().eq('id', foreignFolder.data!.id)
      await outsider.auth.signOut()
      await removeLibraryFolder(folder.id)
      expect((await getBooks()).find((entry) => entry.id === book.id)?.folderId).toBeUndefined()
      expect((await getChapter(book.id, 0))?.html).toContain('Kept in the library.')
    } finally {
      await supabase.from('library_folders').delete().eq('id', folder.id)
      await removeBook(book.id)
    }
  })

  it('materializes a reading source as an independent book without moving downloaded files', async () => {
    const { book } = await saveBook(
      await importBook(
        new File(['Chapter 1\nOriginal copy.'], `Source-books-${crypto.randomUUID()}.txt`),
      ),
    )
    const base = (await getTranslationWorkspace(book)).sources[0]
    const sourceId = crypto.randomUUID()
    const sourceUrl = `https://reference.example.test/${sourceId}`
    const chapterUrl = `${sourceUrl}/chapter-1`
    const contents = discoverContents(
      {
        url: sourceUrl,
        title: 'Reference',
        links: [{ title: 'Chapter 1', url: chapterUrl }],
        truncated: false,
      },
      { chapterLinks: [], chapterCount: 1, indexUrl: sourceUrl },
    )
    const path = `${base.owner_id}/sources/${sourceId}/chapter.json`
    const text = JSON.stringify({
      title: 'Chapter 1',
      paragraphs: ['An independent reference copy.'],
    })
    let referenceBookId: string | undefined
    try {
      expect(
        (
          await supabase
            .from('novel_sources')
            .insert({
              ...base,
              id: sourceId,
              book_id: null,
              url: sourceUrl,
              contents_data: contents as unknown as Json,
              label: 'Reference edition',
              role: 'reference',
              language: 'en',
            })
        ).error,
      ).toBeNull()
      expect(
        (
          await supabase.storage
            .from('library')
            .upload(path, new TextEncoder().encode(text), { contentType: 'application/json' })
        ).error,
      ).toBeNull()
      const chapter = await supabase
        .from('source_chapters')
        .insert({
          source_id: sourceId,
          url: chapterUrl,
          title: 'Chapter 1',
          content_path: path,
          content_hash: createHash('sha256').update(text).digest('hex'),
          word_count: 5,
        })
        .select('*')
        .single()
      expect(chapter.error).toBeNull()
      expect(
        (
          await supabase
            .from('source_reading_progress')
            .insert({ source_id: sourceId, chapter_url: chapterUrl, fraction: 0.4 })
        ).error,
      ).toBeNull()
      await saveTranslationSettings(
        book.id,
        {
          targetLanguage: 'en',
          mainSource: base.id,
          referenceSourceId: sourceId,
          referenceBookId: null,
          referenceMode: 'same_novel',
          metadataSource: null,
        },
        0,
      )
      const created = await supabase.rpc('materialize_source_book', { target_source: sourceId })
      expect(created.error).toBeNull()
      referenceBookId = created.data!
      expect(
        (await supabase.rpc('materialize_source_book', { target_source: sourceId })).data,
      ).toBe(referenceBookId)
      const reference = (await getBooks()).find((entry) => entry.id === referenceBookId)!
      expect(reference).toMatchObject({ format: 'WEB', sourceUrl, language: 'en' })
      expect(reference.novelId).not.toBe(book.novelId)
      await saveTranslationSettings(
        book.id,
        {
          targetLanguage: 'en',
          mainSource: base.id,
          referenceSourceId: sourceId,
          referenceBookId: null,
          referenceMode: 'style_only',
          metadataSource: null,
        },
        1,
      )
      const context = await runBookTranslation(
        (await supabase.auth.getSession()).data.session!.access_token,
        { bookId: book.id, sourceKey: 'local:0', action: 'context' },
        {
          supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
          publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          apiKey: '',
          liveEnabled: false,
          model: 'test-only',
          root: '',
        },
      )
      expect(context.context?.references).toMatchObject([
        { sourceId, text: 'An independent reference copy.' },
      ])
      const catalogUrl = 'https://www.novelupdates.com/series/shared-catalog/'
      const originalCatalog = await supabase.rpc('attach_novelupdates', {
        target_book: book.id,
        catalog_url: catalogUrl,
      })
      const referenceCatalog = await supabase.rpc('attach_novelupdates', {
        target_book: reference.id,
        catalog_url: catalogUrl,
      })
      expect(originalCatalog.error).toBeNull()
      expect(referenceCatalog.error).toBeNull()
      expect(originalCatalog.data).not.toBe(referenceCatalog.data)
      expect(
        (
          await supabase.rpc('attach_novelupdates', {
            target_book: book.id,
            catalog_url: sourceUrl,
          })
        ).error?.message,
      ).toContain('Novel Updates')
      expect(
        (await getTranslationWorkspace(book)).sources
          .filter((source) => source.role !== 'metadata')
          .map((source) => source.id),
      ).toEqual([base.id])
      expect(
        (await getTranslationWorkspace(reference)).sources.filter(
          (source) => source.role !== 'metadata',
        ),
      ).toMatchObject([{ id: sourceId, book_id: referenceBookId }])
      expect(
        (await supabase.from('source_chapters').select('*').eq('source_id', sourceId).single())
          .data,
      ).toEqual(chapter.data)
      expect(
        (
          await supabase
            .from('source_reading_progress')
            .select('fraction')
            .eq('source_id', sourceId)
            .single()
        ).data?.fraction,
      ).toBe(0.4)
      expect(await (await supabase.storage.from('library').download(path)).data?.text()).toBe(text)
      const outsider = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      await outsider.auth.signInAnonymously()
      expect(
        (await outsider.rpc('materialize_source_book', { target_source: sourceId })).error,
      ).not.toBeNull()
      await outsider.auth.signOut()
    } finally {
      if (referenceBookId) await removeBook(referenceBookId)
      await removeBook(book.id)
      await supabase.storage.from('library').remove([path])
    }
  }, 15_000)

  it('removes only the selected source, clears preferences and deletes its downloaded files', async () => {
    const { book } = await saveBook(
      await importBook(
        new File(
          ['Chapter 1\nRetained imported book.'],
          `Remove-source-${crypto.randomUUID()}.txt`,
        ),
      ),
    )
    const base = (await getTranslationWorkspace(book)).sources[0]
    const sourceId = crypto.randomUUID()
    const sourceUrl = 'https://delete-source.example.test/book'
    const chapterUrl = `${sourceUrl}/1`
    const path = `${base.owner_id}/sources/${sourceId}/chapter.json`
    const text = JSON.stringify({ title: 'Chapter 1', paragraphs: ['Removable source text.'] })
    try {
      expect(
        (
          await supabase.from('novel_sources').insert({
            ...base,
            id: sourceId,
            book_id: null,
            url: sourceUrl,
            role: 'reference',
            language: 'en',
          })
        ).error,
      ).toBeNull()
      expect(
        (
          await supabase.storage
            .from('library')
            .upload(path, new TextEncoder().encode(text), { contentType: 'application/json' })
        ).error,
      ).toBeNull()
      expect(
        (
          await supabase.from('source_chapters').insert({
            source_id: sourceId,
            url: chapterUrl,
            title: 'Chapter 1',
            content_path: path,
            content_hash: createHash('sha256').update(text).digest('hex'),
            word_count: 4,
          })
        ).error,
      ).toBeNull()
      expect(
        (
          await supabase
            .from('source_reading_progress')
            .insert({ source_id: sourceId, chapter_url: chapterUrl, fraction: 0.5 })
        ).error,
      ).toBeNull()
      await saveTranslationSettings(
        book.id,
        {
          targetLanguage: 'en',
          mainSource: base.id,
          referenceSourceId: sourceId,
          referenceBookId: null,
          referenceMode: 'same_novel',
          metadataSource: sourceId,
        },
        0,
      )
      const outsider = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      await outsider.auth.signInAnonymously()
      expect(
        (
          await outsider.rpc('remove_novel_source', {
            target_book: book.id,
            target_source: sourceId,
          })
        ).error,
      ).not.toBeNull()
      await outsider.auth.signOut()
      expect(await removeNovelSource(book, sourceId)).toEqual({})
      const workspace = await getTranslationWorkspace(book)
      expect(workspace.sources.map((source) => source.id)).toEqual([base.id])
      expect(workspace.translationSettings).toMatchObject({
        main_source_id: base.id,
        reference_source_id: null,
        metadata_source_id: null,
        revision: 2,
      })
      expect(
        (await supabase.from('source_chapters').select('*').eq('source_id', sourceId)).data,
      ).toEqual([])
      expect(
        (await supabase.from('source_reading_progress').select('*').eq('source_id', sourceId)).data,
      ).toEqual([])
      expect((await supabase.storage.from('library').download(path)).error).not.toBeNull()
      expect((await getChapter(book.id, 0))?.html).toContain('Retained imported book.')
      await expect(removeNovelSource(book, sourceId)).rejects.toThrow('Source not found')
    } finally {
      await supabase.storage.from('library').remove([path])
      await removeBook(book.id)
    }
  }, 15_000)

  it('builds a reading guide from earlier downloaded chapters in bounded resumable batches', async () => {
    const { book } = await saveBook(
      await importBook(
        new File(['Chapter 1\nOriginal fixture.'], `Guide-${crypto.randomUUID()}.txt`),
      ),
    )
    const base = (await getTranslationWorkspace(book)).sources[0]
    const sourceId = crypto.randomUUID()
    const referenceId = crypto.randomUUID()
    const sourceUrl = 'https://guide-source.example.test/book'
    const referenceUrl = 'https://guide-english.example.test/book'
    const inventory = (url: string) =>
      discoverContents(
        {
          url,
          title: 'Directory',
          truncated: false,
          links: Array.from({ length: 124 }, (_, index) => ({
            title: `Chapter ${index + 1}`,
            url: `${url}/${index + 1}`,
          })),
        },
        { chapterLinks: [], chapterCount: 124, indexUrl: null },
      ) as unknown as Json
    const configuration = {
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
      publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      apiKey: 'test-only',
      liveEnabled: true,
      model: 'test-only',
      root: '',
    }
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const profiles: string[] = []
    const paths: string[] = []
    try {
      expect(
        (
          await supabase.from('novel_sources').insert([
            {
              ...base,
              id: sourceId,
              book_id: null,
              url: sourceUrl,
              language: 'zh',
              role: 'original',
              contents_data: inventory(sourceUrl),
            },
            {
              ...base,
              id: referenceId,
              book_id: null,
              url: referenceUrl,
              language: 'en',
              role: 'reference',
              contents_data: inventory(referenceUrl),
            },
          ])
        ).error,
      ).toBeNull()
      const chapters = [1, 2, 3, 4, 5, 6, 7, 8, 9, 120, 121, 122, 123, 124].map((number) => ({
        number,
        id: referenceId,
        url: referenceUrl,
      }))
      chapters.push({ number: 123, id: sourceId, url: sourceUrl })
      for (const { number, id, url } of chapters) {
        const text = JSON.stringify({
          title: `Chapter ${number}`,
          paragraphs: [`The rain eased. Chapter ${number} continued quietly.`],
        })
        const path = `${base.owner_id}/sources/${id}/${number}.json`
        paths.push(path)
        expect(
          (
            await supabase.storage
              .from('library')
              .upload(path, new TextEncoder().encode(text), { contentType: 'application/json' })
          ).error,
        ).toBeNull()
        expect(
          (
            await supabase.from('source_chapters').insert({
              source_id: id,
              url: `${url}/${number}`,
              title: `Chapter ${number}`,
              content_path: path,
              content_hash: createHash('sha256').update(text).digest('hex'),
              word_count: 8,
            })
          ).error,
        ).toBeNull()
      }
      await saveTranslationSettings(
        book.id,
        {
          targetLanguage: 'en',
          mainSource: sourceId,
          referenceSourceId: referenceId,
          referenceBookId: null,
          referenceMode: 'continuation',
          metadataSource: null,
        },
        0,
      )
      const input = { bookId: book.id, sourceKey: `${sourceUrl}/123` }
      inferProvider.mockReset().mockImplementation(async (request) => {
        const { examples, readerPreferences } = JSON.parse(
          request.input.find((message: { role: string }) => message.role === 'user').content,
        )
        if (!examples)
          return {
            status: 'completed',
            output_parsed: {
              title: 'Translated chapter',
              paragraphs: ['A translated chapter with careful spacing.'],
              terminology: [],
            },
          }
        return {
          status: 'completed',
          output_parsed: {
            instructions: readerPreferences
              ? 'Use concise dialogue and preserve profile field breaks.'
              : 'Use concise narration and natural dialogue.',
            observations: examples.map((example: { id: string }) => ({
              exampleId: example.id,
              quote: 'The rain eased.',
              pattern: 'Short declarative narration.',
            })),
            warnings: [],
          },
        }
      })
      expect(await runReadingGuide(token, input, configuration)).toMatchObject({
        covered: 0,
        total: 12,
        remaining: 12,
        updated: false,
      })
      expect(inferProvider).not.toHaveBeenCalled()
      const first = await runReadingGuide(token, { ...input, confirmed: true }, configuration)
      profiles.push(first.profileId!)
      expect(first).toMatchObject({ covered: 8, total: 12, remaining: 4, updated: true })
      expect(JSON.parse(inferProvider.mock.calls[0][0].input.at(-1).content).examples).toHaveLength(
        8,
      )
      const second = await runReadingGuide(token, { ...input, confirmed: true }, configuration)
      profiles.push(second.profileId!)
      expect(second).toMatchObject({ covered: 12, remaining: 0, updated: true })
      const batch = JSON.parse(inferProvider.mock.calls[1][0].input.at(-1).content)
      expect(batch.previousGuide).toBe('Use concise narration and natural dialogue.')
      expect(batch.examples.map((example: { fileName: string }) => example.fileName)).toEqual([
        'Chapter 9',
        'Chapter 120',
        'Chapter 121',
        'Chapter 122',
      ])
      expect(
        await runReadingGuide(
          token,
          { ...input, confirmed: true },
          { ...configuration, apiKey: '' },
        ),
      ).toMatchObject({ covered: 12, updated: false })
      expect(inferProvider).toHaveBeenCalledTimes(2)
      const context = await runBookTranslation(
        token,
        { ...input, action: 'context' },
        configuration,
      )
      expect(context.context).toMatchObject({
        mode: 'continuation',
        basis: 'preceding',
        style: 'Use concise narration and natural dialogue.',
        source: { text: 'The rain eased. Chapter 123 continued quietly.' },
      })
      expect(context.context?.references.map((chapter) => chapter.url)).toEqual(
        [120, 121, 122].map((number) => `${referenceUrl}/${number}`),
      )
      const early = await runBookTranslation(
        token,
        { ...input, sourceKey: `${sourceUrl}/2`, action: 'context', continuation: true },
        configuration,
      )
      expect(early.context?.style).toBe('')
      expect(early.context?.references.map((chapter) => chapter.url)).toEqual([`${referenceUrl}/1`])
      expect(inferProvider).toHaveBeenCalledTimes(2)
      const profile = await supabase
        .from('style_profiles')
        .select('inference')
        .eq('id', second.profileId!)
        .single()
      const metadata = profile.data!.inference as { chapters: { url: string; hash: string }[] }
      const eligible = metadata.chapters.map((chapter) => ({
        key: chapter.url,
        hash: chapter.hash,
      }))
      expect(
        compatibleReadingGuide(profile.data!.inference, referenceId, 'en', eligible),
      ).toBeTruthy()
      expect(
        compatibleReadingGuide(profile.data!.inference, referenceId, 'fr', eligible),
      ).toBeNull()
      expect(compatibleReadingGuide(profile.data!.inference, sourceId, 'en', eligible)).toBeNull()
      expect(
        compatibleReadingGuide(profile.data!.inference, referenceId, 'en', eligible.slice(1)),
      ).toBeNull()
      expect(
        await runReadingGuide(token, { ...input, sourceKey: `${sourceUrl}/2` }, configuration),
      ).toMatchObject({ covered: 0, total: 1, remaining: 1 })
      expect(
        (
          await supabase.rpc('save_continuation_style', {
            target_book: book.id,
            reference_source: referenceId,
            expected_revision: 1,
            expected_profile: first.profileId!,
            style_instructions: 'Stale guide.',
            style_metadata: {},
          })
        ).error?.message,
      ).toContain('Selected style changed')
      expect(
        (
          await supabase.rpc('save_continuation_style', {
            target_book: book.id,
            reference_source: referenceId,
            expected_revision: 0,
            expected_profile: second.profileId!,
            style_instructions: 'Stale settings.',
            style_metadata: {},
          })
        ).error?.message,
      ).toContain('settings changed')
      const outsider = createClient(configuration.supabaseUrl, configuration.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      await outsider.auth.signInAnonymously()
      await expect(
        runReadingGuide(
          (await outsider.auth.getSession()).data.session!.access_token,
          input,
          configuration,
        ),
      ).rejects.toThrow('Book not found')
      await outsider.auth.signOut()
      await runBookTranslation(
        token,
        { ...input, action: 'translate', confirmed: true, continuation: true },
        configuration,
      )
      expect(inferProvider).toHaveBeenCalledTimes(3)
      expect(
        (
          await supabase
            .from('book_translation_settings')
            .select('guide_auto_update,guide_chapters_since_update')
            .eq('book_id', book.id)
            .single()
        ).data,
      ).toMatchObject({ guide_auto_update: false, guide_chapters_since_update: 1 })
      expect(
        (
          await supabase.rpc('set_context_preferences', {
            target_book: book.id,
            expected_revision: 1,
            token_budget: 128000,
            recent_count: 3,
            auto_guide: true,
            update_interval: 1,
            feedback: 'Keep dialogue concise and preserve profile field breaks.',
          })
        ).error,
      ).toBeNull()
      const automatic = await runBookTranslation(
        token,
        { ...input, action: 'translate', confirmed: true, continuation: true },
        configuration,
      )
      expect(automatic.context?.style).toBe(
        'Use concise dialogue and preserve profile field breaks.',
      )
      expect(automatic.context?.warnings).toContain(
        'The reading guide was updated automatically before this translation.',
      )
      expect(inferProvider).toHaveBeenCalledTimes(5)
      const updatedGuide = await runReadingGuide(token, input, configuration)
      profiles.push(updatedGuide.profileId!)
      expect(updatedGuide.history?.[0].feedback).toContain('profile field breaks')
      expect(updatedGuide.instructions).toBe(
        'Use concise dialogue and preserve profile field breaks.',
      )
      expect(
        (
          await supabase
            .from('book_translation_settings')
            .select('guide_chapters_since_update')
            .eq('book_id', book.id)
            .single()
        ).data?.guide_chapters_since_update,
      ).toBe(0)
      await runBookTranslation(
        token,
        { ...input, action: 'translate', confirmed: true, continuation: true },
        configuration,
      )
      expect(inferProvider).toHaveBeenCalledTimes(6)
      const oversized = JSON.stringify({
        title: 'Chapter 1',
        paragraphs: Array.from({ length: 4 }, () => 'a'.repeat(8000)),
      })
      expect(
        (
          await supabase.storage
            .from('library')
            .update(paths[0], new TextEncoder().encode(oversized), {
              contentType: 'application/json',
            })
        ).error,
      ).toBeNull()
      expect(
        (
          await supabase
            .from('source_chapters')
            .update({ content_hash: createHash('sha256').update(oversized).digest('hex') })
            .eq('source_id', referenceId)
            .eq('url', `${referenceUrl}/1`)
        ).error,
      ).toBeNull()
      await expect(
        runReadingGuide(token, { ...input, confirmed: true }, configuration),
      ).rejects.toThrow('32,000-character')
      expect(
        (await supabase.from('novels').select('style_profile_id').eq('id', base.novel_id).single())
          .data?.style_profile_id,
      ).toBe(updatedGuide.profileId)
      expect(
        (
          await supabase
            .from('source_chapters')
            .update({ content_hash: 'a'.repeat(64) })
            .eq('source_id', referenceId)
            .eq('url', `${referenceUrl}/1`)
        ).error,
      ).toBeNull()
      expect(await runReadingGuide(token, input, configuration)).toMatchObject({
        covered: 0,
        remaining: 12,
      })
      await expect(
        runReadingGuide(token, { ...input, confirmed: true }, configuration),
      ).rejects.toThrow('integrity')
      expect(inferProvider).toHaveBeenCalledTimes(6)
    } finally {
      await supabase.storage.from('library').remove(paths)
      await removeBook(book.id)
      if (profiles.length) await supabase.from('style_profiles').delete().in('id', profiles)
    }
  }, 30_000)

  it('evolves a guide from older generated translations without a reference source', async () => {
    const { book } = await saveBook(await importBook(new File(['Chapter 1\nOriginal fixture.'], `Generated-guide-${crypto.randomUUID()}.txt`)))
    const base = (await getTranslationWorkspace(book)).sources[0]
    const sourceId = crypto.randomUUID()
    const sourceUrl = `https://generated-guide.example.test/${book.id}`
    const paths: string[] = []
    const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const translated = (number: number) => ({ title: `Chapter ${number}`, paragraphs: [`The rain eased. Generated chapter ${number} continued quietly.`], terminology: [] })
    const insertTranslation = async (number: number) => {
      const result = await supabase.from('book_translation_previews').insert({ book_id: book.id, kind: 'chapter', source_key: `${sourceUrl}/${number}`, target_language: 'en', context: { source: { sourceId } }, result: translated(number) }).select('id').single()
      expect(result.error).toBeNull()
      return result.data!.id
    }
    try {
      const inventory = discoverContents({ url: sourceUrl, title: 'Directory', truncated: false, links: Array.from({ length: 132 }, (_, position) => ({ title: `Chapter ${position + 1}`, url: `${sourceUrl}/${position + 1}` })) }, { chapterLinks: [], chapterCount: 132, indexUrl: sourceUrl })
      expect((await supabase.from('novel_sources').insert({ ...base, id: sourceId, book_id: null, url: sourceUrl, language: 'zh', role: 'original', contents_data: inventory as unknown as Json })).error).toBeNull()
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: sourceId, referenceSourceId: null, referenceBookId: null, referenceMode: 'continuation', metadataSource: null }, 0)
      for (const number of [128, 129, 130]) {
        const text = JSON.stringify({ title: `Chapter ${number}`, paragraphs: [`Original chapter ${number} continued quietly.`] })
        const path = `${base.owner_id}/sources/${sourceId}/${number}.json`
        paths.push(path)
        expect((await supabase.storage.from('library').upload(path, new TextEncoder().encode(text), { contentType: 'application/json' })).error).toBeNull()
        expect((await supabase.from('source_chapters').insert({ source_id: sourceId, url: `${sourceUrl}/${number}`, title: `Chapter ${number}`, content_path: path, content_hash: createHash('sha256').update(text).digest('hex'), word_count: 6 })).error).toBeNull()
      }
      const oldVersion = await insertTranslation(123)
      for (const number of [124, 125, 126, 127]) await insertTranslation(number)
      inferProvider.mockReset().mockImplementation(async request => {
        const input = JSON.parse(request.input.find((message: { role: string }) => message.role === 'user').content)
        return { status: 'completed', output_parsed: input.examples ? {
          instructions: 'Keep concise narration and preserve dialogue paragraph breaks.',
          observations: input.examples.map((example: { id: string }) => ({ exampleId: example.id, quote: 'The rain eased.', pattern: 'Short declarative narration.' })), warnings: [],
        } : translated(129) }
      })
      const input = { bookId: book.id, sourceKey: `${sourceUrl}/128` }
      expect(await runReadingGuide(token, input, configuration)).toMatchObject({ covered: 0, total: 2, remaining: 2, updated: false })
      expect(inferProvider).not.toHaveBeenCalled()
      const first = await runReadingGuide(token, { ...input, confirmed: true }, configuration)
      expect(first).toMatchObject({ covered: 2, total: 2, remaining: 0, updated: true })
      const batch = JSON.parse(inferProvider.mock.calls[0][0].input.at(-1).content)
      expect(batch.examples.map((example: { fileName: string }) => example.fileName)).toEqual(['Generated translation / Chapter 123', 'Generated translation / Chapter 124'])
      const profile = (await supabase.from('style_profiles').select('inference').eq('id', first.profileId!).single()).data!
      expect(profile.inference).toMatchObject({ referenceSourceId: null, sourceId, chapters: [{ kind: 'translation', versionId: oldVersion, position: 122 }, { kind: 'translation', position: 123 }] })
      const context = await runBookTranslation(token, { ...input, action: 'context' }, configuration)
      expect(context.context?.style).toBe(first.instructions)
      expect(context.context?.recentTranslations?.map(chapter => chapter.url)).toEqual([125, 126, 127].map(number => `${sourceUrl}/${number}`))
      expect(await runReadingGuide(token, { ...input, confirmed: true }, { ...configuration, apiKey: '' })).toMatchObject({ updated: false, covered: 2 })
      expect((await supabase.rpc('set_context_preferences', { target_book: book.id, expected_revision: 1, token_budget: 128000, recent_count: 3, auto_guide: true, update_interval: 1, feedback: '' })).error).toBeNull()
      await insertTranslation(128)
      const automatic = await runBookTranslation(token, { bookId: book.id, sourceKey: `${sourceUrl}/129`, action: 'translate', confirmed: true }, configuration)
      expect(automatic.context?.warnings).toContain('The reading guide was updated automatically before this translation.')
      expect(inferProvider).toHaveBeenCalledTimes(3)
      const nextBatch = JSON.parse(inferProvider.mock.calls[1][0].input.at(-1).content)
      expect(nextBatch.previousGuide).toBe(first.instructions)
      expect(nextBatch.examples.map((example: { fileName: string }) => example.fileName)).toEqual(['Generated translation / Chapter 125'])
      expect(automatic.context?.recentTranslations?.map(chapter => chapter.url)).toEqual([126, 127, 128].map(number => `${sourceUrl}/${number}`))
      expect((await runReadingGuide(token, { bookId: book.id, sourceKey: `${sourceUrl}/130` }, configuration)).history).toHaveLength(2)
      const newerVersion = await insertTranslation(123)
      expect(newerVersion).not.toBe(oldVersion)
      const stale = await runReadingGuide(token, { bookId: book.id, sourceKey: `${sourceUrl}/130` }, configuration)
      expect(stale).toMatchObject({ covered: 0, total: 4, remaining: 4, updated: false, instructions: '' })
      expect((await runBookTranslation(token, { ...input, action: 'context' }, configuration)).context?.style).toBe('')
      expect(inferProvider).toHaveBeenCalledTimes(3)
      expect((await supabase.from('book_translation_previews').select('id').eq('id', oldVersion).single()).data?.id).toBe(oldVersion)
    } finally {
      if (paths.length) await supabase.storage.from('library').remove(paths)
      await removeBook(book.id)
      await supabase.from('style_profiles').delete().eq('inference->>bookId', book.id)
    }
  }, 30000)

  it('includes all approved source occurrences and aliases across compatible glossary languages', async () => {
    const terms = Array.from({ length: 105 }, (_, position) => `能力${String(position).padStart(3, '0')}`)
    const { book } = await saveBook(await importBook(new File([`Chapter 1\n阿遥使用了${terms.join('，')}。`], `Glossary-context-${crypto.randomUUID()}.txt`)))
    try {
      const source = (await getTranslationWorkspace(book)).sources[0]
      expect((await supabase.from('novel_sources').update({ language: 'zh-Hant' }).eq('id', source.id)).error).toBeNull()
      await saveTranslationSettings(book.id, { targetLanguage: 'en', mainSource: source.id, referenceSourceId: null, referenceBookId: null, referenceMode: 'continuation', metadataSource: null }, 0)
      await Promise.all([...terms.map((term, position) => ({ term, target: `Ability ${position}`, aliases: [] as string[] })), { term: '林遥', target: 'Lin Yao', aliases: ['阿遥'] }].map(entry => saveGlossaryEntry({ ...book, language: 'zh' }, { sourceTerm: entry.term, targetTerm: entry.target, targetLanguage: 'en-US', scope: 'novel', category: 'technique', chapter: 0, sense: '', notes: '', aliases: entry.aliases })))
      inferProvider.mockReset()
      const context = await runBookTranslation((await supabase.auth.getSession()).data.session!.access_token, { bookId: book.id, sourceKey: 'local:0', action: 'context' }, { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: '', liveEnabled: false, model: 'test-only', root: '' })
      expect(context.context?.source.language).toBe('zh-Hant')
      expect(context.context?.glossary).toHaveLength(106)
      expect(context.context?.glossary).toContainEqual({ source: '林遥', target: 'Lin Yao', sense: '', aliases: ['阿遥'] })
      expect(context.context?.glossary.some(term => term.source === terms[104])).toBe(true)
      expect(inferProvider).not.toHaveBeenCalled()
    } finally { await removeBook(book.id) }
  })

  it('downloads independent chapters concurrently and reuses a duplicate in-flight chapter', async () => {
    await ensureSession()
    const bookId = crypto.randomUUID().replaceAll('-', '')
    const sourceUrl = `https://parallel-downloads.example.test/${bookId}`
    expect((await supabase.from('books').insert({ id: bookId, novel_id: null as unknown as string, title: 'Parallel downloads', format: 'WEB', file_size: 0, source_url: sourceUrl, language: 'en', import_state: 'ready' })).error).toBeNull()
    let releaseFirst!: () => void
    const firstWave = new Promise<void>(resolve => { releaseFirst = resolve })
    let work: Promise<PromiseSettledResult<Awaited<ReturnType<typeof downloadSourceChapter>>>[]> | undefined
    try {
      const source = (await supabase.from('novel_sources').select('*').eq('book_id', bookId).single()).data!
      const contents = discoverContents({ url: sourceUrl, title: 'Contents', links: [1, 2, 3, 4].map(number => ({ title: `Chapter ${number}`, url: `${sourceUrl}/${number}` })), truncated: false }, { chapterLinks: [], chapterCount: 4, indexUrl: sourceUrl })
      expect((await supabase.from('novel_sources').update({ contents_data: contents as unknown as Json }).eq('id', source.id)).error).toBeNull()
      let active = 0
      let maximum = 0
      const started: string[] = []
      downloadFetch.mockReset().mockImplementation(async (_page, url) => {
        started.push(url)
        active += 1
        maximum = Math.max(maximum, active)
        if (started.length <= 3) await firstWave
        active -= 1
        return { url, html: '<h1>Chapter</h1><main>Complete source text.</main>' }
      })
      downloadScraper.mockReset().mockImplementation(async (_token, input) => ({ report: { id: crypto.randomUUID(), status: 'needs_review', adapter: { strategy: 'fixture' }, attempts: [{ checks: [{ url: input.pages[0].url, passed: true, output: { kind: 'chapter', title: 'Chapter', paragraphs: ['Complete source text.'], nextPageUrl: null, nextChapterUrl: null } }] }] } }))
      const token = (await supabase.auth.getSession()).data.session!.access_token
      const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: '', liveEnabled: false, model: 'test-only', root: '' }
      work = Promise.allSettled([1, 2, 3, 4, 1].map(number => downloadSourceChapter(token, { sourceId: source.id, url: `${sourceUrl}/${number}` }, configuration)))
      await expect.poll(() => started.length).toBe(3)
      expect(maximum).toBe(3)
      releaseFirst()
      const results = await work
      expect(results.every(result => result.status === 'fulfilled' && result.value.state === 'ready')).toBe(true)
      expect(started).toHaveLength(4)
      expect(new Set(started).size).toBe(4)
      expect(downloadScraper).toHaveBeenCalledTimes(4)
      expect((await supabase.from('source_chapters').select('url').eq('source_id', source.id)).data).toHaveLength(4)
    } finally { releaseFirst(); if (work) await work; await removeBook(bookId) }
  }, 15000)

  it('stores compressible downloads as gzip and verifies the original text on both read paths', async () => {
    await ensureSession()
    const bookId = crypto.randomUUID().replaceAll('-', '')
    const sourceUrl = `https://compressed.example.test/${bookId}`
    const chapterUrl = `${sourceUrl}/1`
    const inserted = await supabase.from('books').insert({ id: bookId, novel_id: null as unknown as string, title: 'Compression fixture', format: 'WEB', file_size: 0, source_url: sourceUrl, language: 'en', import_state: 'ready' })
    expect(inserted.error).toBeNull()
    try {
      const source = (await supabase.from('novel_sources').select('*').eq('book_id', bookId).single()).data!
      const contents = discoverContents({ url: sourceUrl, title: 'Contents', truncated: false, links: [{ title: 'Chapter 1', url: chapterUrl }] }, { chapterLinks: [], chapterCount: 1, indexUrl: sourceUrl })
      expect((await supabase.from('novel_sources').update({ contents_data: contents as unknown as Json }).eq('id', source.id)).error).toBeNull()
      const original = { title: 'Chapter 1', paragraphs: ['The original chapter text is kept exactly. '.repeat(120)] }
      downloadFetch.mockReset().mockResolvedValue({ url: chapterUrl, html: `<h1>Chapter 1</h1><main>${original.paragraphs[0]}</main>` })
      downloadScraper.mockReset().mockResolvedValue({ report: { id: crypto.randomUUID(), status: 'needs_review', adapter: { strategy: 'fixture' }, attempts: [{ checks: [{ url: chapterUrl, passed: true, output: { kind: 'chapter', ...original, nextPageUrl: null, nextChapterUrl: null } }] }] } })
      const token = (await supabase.auth.getSession()).data.session!.access_token
      const configuration = { supabaseUrl: import.meta.env.VITE_SUPABASE_URL, publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiKey: 'test-only', liveEnabled: true, model: 'test-only', root: '' }
      const saved = await downloadSourceChapter(token, { sourceId: source.id, url: chapterUrl, confirmed: true }, configuration)
      if (saved.state !== 'ready') throw new Error('Compressed fixture was not saved')
      expect(saved.record.content_path).toMatch(/\.json\.gz$/)
      expect(saved.record.content_hash).toBe(createHash('sha256').update(JSON.stringify(original)).digest('hex'))
      const stored = await supabase.storage.from('library').download(saved.record.content_path)
      expect(stored.error).toBeNull()
      expect(stored.data!.size).toBeLessThan(Buffer.byteLength(JSON.stringify(original)) * 0.9)
      expect(await readDownloadedChapter(saved.record)).toEqual(original)
      expect(await downloadSourceChapter(token, { sourceId: source.id, url: chapterUrl }, configuration)).toMatchObject({ state: 'ready', cached: true, chapter: original })
      expect(downloadScraper).toHaveBeenCalledTimes(1)
    } finally { await removeBook(bookId) }
  })

  it('downloads and caches original and translated source chapters without conflating editions', async () => {
    const imported = await saveBook(
      await importBook(
        new File(['Chapter 1\nAn imported copy.'], `Downloads-${crypto.randomUUID()}.txt`),
      ),
    )
    const base = (await getTranslationWorkspace(imported.book)).sources[0]
    const sourceId = crypto.randomUUID()
    const referenceId = crypto.randomUUID()
    const catalogId = crypto.randomUUID()
    const sourceUrl = 'https://download.example.test/original'
    const referenceUrl = 'https://english.example.test/translation'
    const chapterUrl = `${sourceUrl}/chapter-1`
    const referenceChapterUrl = `${referenceUrl}/chapter-1`
    const contents = (url: string) =>
      discoverContents(
        {
          url,
          title: 'Contents',
          links: [{ title: 'Chapter 1', url: `${url}/chapter-1` }],
          truncated: false,
        },
        { chapterLinks: [], chapterCount: 1, indexUrl: null },
      ) as unknown as Json
    const config = {
      root: '',
      apiKey: 'test-only',
      liveEnabled: true,
      model: 'gpt-5-nano',
      translationModel: 'gpt-5.6-luna',
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
      publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    }
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const paths: string[] = []
    let referenceBookId: string | undefined
    try {
      const inserted = await supabase.from('novel_sources').insert([
        {
          ...base,
          id: sourceId,
          book_id: null,
          url: sourceUrl,
          contents_data: contents(sourceUrl),
          language: 'zh',
          role: 'original',
        },
        {
          ...base,
          id: referenceId,
          book_id: null,
          url: referenceUrl,
          contents_data: contents(referenceUrl),
          language: 'en',
          role: 'reference',
        },
        {
          ...base,
          id: catalogId,
          book_id: null,
          url: 'https://www.novelupdates.com/series/test/',
          role: 'metadata',
        },
      ])
      expect(inserted.error).toBeNull()
      downloadFetch.mockReset().mockImplementation(async (_page, url) => ({
        url,
        html: '<h1>Chapter 1</h1><main>Verified chapter text.</main>',
      }))
      downloadScraper.mockReset().mockImplementation(async (_token, input, _config, confirmed) => {
        if (!confirmed) throw new ExperimentError('Confirm scraper generation.', 402)
        return {
          report: {
            id: crypto.randomUUID(),
            status: 'needs_review',
            attempts: [
              {
                checks: [
                  {
                    url: input.pages[0].url,
                    passed: true,
                    output: {
                      kind: 'chapter',
                      title: 'Chapter 1',
                      paragraphs: [
                        input.pages[0].url.includes('english')
                          ? 'Translated text.'
                          : 'Original text.',
                      ],
                      nextPageUrl: null,
                      nextChapterUrl: null,
                    },
                  },
                ],
              },
            ],
            adapter: { strategy: 'generated' },
          },
        }
      })
      expect(
        (await downloadSourceChapter(token, { sourceId, url: chapterUrl }, config)).state,
      ).toBe('needs_scraper')
      expect(
        (await supabase.from('source_chapters').select('*').eq('source_id', sourceId)).data,
      ).toEqual([])
      const callsBeforeFailure = downloadScraper.mock.calls.length
      downloadFetch.mockRejectedValueOnce(new Error('HTTP 403'))
      expect(
        await downloadSourceChapter(token, { sourceId, url: chapterUrl }, config),
      ).toMatchObject({ state: 'needs_browser', message: expect.stringContaining('403') })
      downloadFetch.mockResolvedValueOnce({
        url: chapterUrl,
        html: '<title>Just a moment</title><h1>Verify you are human</h1>',
      })
      expect(
        (await downloadSourceChapter(token, { sourceId, url: chapterUrl, confirmed: true }, config))
          .state,
      ).toBe('needs_browser')
      expect(downloadScraper).toHaveBeenCalledTimes(callsBeforeFailure)
      downloadScraper.mockResolvedValueOnce({
        report: {
          id: crypto.randomUUID(),
          status: 'needs_review',
          adapter: { strategy: 'generated' },
          attempts: [
            {
              checks: [
                {
                  url: chapterUrl,
                  passed: true,
                  output: {
                    kind: 'chapter',
                    title: 'Chapter 1',
                    paragraphs: ['First page only.'],
                    nextPageUrl: `${chapterUrl}?page=2`,
                    nextChapterUrl: null,
                  },
                },
              ],
            },
          ],
        },
      })
      expect(
        (await downloadSourceChapter(token, { sourceId, url: chapterUrl, confirmed: true }, config))
          .state,
      ).toBe('needs_scraper')
      expect(downloadScraper.mock.lastCall?.[3]).toBe(false)
      expect(
        (await supabase.from('source_chapters').select('*').eq('source_id', sourceId)).data,
      ).toEqual([])
      const original = await downloadSourceChapter(
        token,
        { sourceId, url: chapterUrl, confirmed: true },
        config,
      )
      const translated = await downloadSourceChapter(
        token,
        { sourceId: referenceId, url: referenceChapterUrl, confirmed: true },
        config,
      )
      expect(original.state).toBe('ready')
      expect(translated.state).toBe('ready')
      if (original.state !== 'ready' || translated.state !== 'ready')
        throw new Error('Expected downloaded text')
      paths.push(original.record.content_path, translated.record.content_path)
      expect(original.chapter.paragraphs).toEqual(['Original text.'])
      expect(translated.chapter.paragraphs).toEqual(['Translated text.'])
      const beforeProbe = await supabase
        .from('source_chapters')
        .select('*')
        .eq('source_id', sourceId)
      const beforeProbeFetch = downloadFetch.mock.calls.length
      expect(
        await testSourceExtraction(token, { sourceId, url: chapterUrl }, config),
      ).toMatchObject({
        state: 'needs_scraper',
        message: expect.stringContaining('Direct fetch worked'),
      })
      expect(downloadFetch).toHaveBeenCalledTimes(beforeProbeFetch + 1)
      await expect(
        testSourceExtraction(token, { sourceId, url: chapterUrl, forceRegenerate: true }, config),
      ).rejects.toThrow('Confirm model use')
      const rebuilt = await testSourceExtraction(
        token,
        { sourceId, url: chapterUrl, forceRegenerate: true, confirmed: true },
        config,
      )
      expect(rebuilt).toMatchObject({
        state: 'ready',
        paragraphs: ['Original text.'],
        characters: 14,
      })
      expect(downloadScraper.mock.lastCall?.[1]).toMatchObject({
        forceRegenerate: true,
        expectedKind: 'chapter',
        pages: [{ url: chapterUrl, html: expect.stringContaining('Verified chapter text.') }],
      })
      expect(
        (await supabase.from('source_chapters').select('*').eq('source_id', sourceId)).data,
      ).toEqual(beforeProbe.data)
      const beforeBlocked = downloadScraper.mock.calls.length
      downloadFetch.mockResolvedValueOnce({
        url: chapterUrl,
        html: '<title>Just a moment</title><h1>Verify you are human</h1>',
      })
      expect(
        await testSourceExtraction(
          token,
          { sourceId, url: chapterUrl, forceRegenerate: true, confirmed: true },
          config,
        ),
      ).toMatchObject({ state: 'needs_browser' })
      expect(downloadScraper).toHaveBeenCalledTimes(beforeBlocked)
      await expect(
        testSourceExtraction(token, { sourceId, url: `${sourceUrl}/unlisted` }, config),
      ).rejects.toThrow('saved contents')
      await expect(
        testSourceExtraction(token, { sourceId: catalogId, url: chapterUrl }, config),
      ).rejects.toThrow('Catalogs')
      expect(
        await saveRenderedSourceChapter(
          token,
          { bookId: imported.book.id, sourceUrl, requestedUrl: chapterUrl },
          config,
        ),
      ).toMatchObject({ state: 'ready', cached: true, canonicalUrl: chapterUrl })
      expect(downloadFetch).toHaveBeenCalledTimes(beforeProbeFetch + 3)
      await expect(
        saveRenderedSourceChapter(
          token,
          { bookId: imported.book.id, sourceUrl, requestedUrl: `${sourceUrl}/unlisted` },
          config,
        ),
      ).rejects.toThrow('saved contents')
      await expect(
        saveRenderedSourceChapter(token, { bookId: imported.book.id, sourceUrl }, config),
      ).rejects.toThrow('Select a chapter URL')
      const fetchCount = downloadFetch.mock.calls.length
      expect(
        await downloadSourceChapter(token, { sourceId, url: chapterUrl }, config),
      ).toMatchObject({ state: 'ready', cached: true })
      expect(downloadFetch).toHaveBeenCalledTimes(fetchCount)
      const aliasUrl = `${sourceUrl}/chapter-2`
      const canonicalUrl = `${aliasUrl}.html`
      const aliasContents = {
        url: sourceUrl,
        title: 'Contents',
        truncated: false,
        links: [
          { title: 'Chapter 1', url: chapterUrl },
          { title: 'Chapter 2', url: aliasUrl },
          { title: 'Chapter 2', url: canonicalUrl },
        ],
      }
      await saveSourceContents(
        token,
        { bookId: imported.book.id, sourceUrl, contents: aliasContents },
        config,
      )
      const redirected = await saveRenderedSourceChapter(
        token,
        {
          bookId: imported.book.id,
          sourceUrl,
          requestedUrl: aliasUrl,
          page: { url: canonicalUrl, html: '<h1>Chapter 2</h1><main>Original text.</main>' },
          confirmed: true,
        },
        config,
      )
      expect(redirected).toMatchObject({ state: 'ready', canonicalUrl })
      const canonicalSource = await supabase
        .from('novel_sources')
        .select('contents_data,url_aliases')
        .eq('id', sourceId)
        .single()
      expect(canonicalSource.data?.url_aliases).toEqual({ [aliasUrl]: canonicalUrl })
      expect(canonicalSource.data?.contents_data).toMatchObject({
        foundCount: 2,
        chapters: [{ url: chapterUrl }, { url: canonicalUrl }],
      })
      expect(
        await saveSourceContents(
          token,
          { bookId: imported.book.id, sourceUrl, contents: aliasContents },
          config,
        ),
      ).toMatchObject({ saved: true, foundCount: 2 })
      expect(await downloadSourceChapter(token, { sourceId, url: aliasUrl }, config)).toMatchObject(
        { state: 'ready', cached: true, record: { url: canonicalUrl } },
      )
      expect(downloadFetch).toHaveBeenCalledTimes(fetchCount)
      const independentReference = await supabase.rpc('materialize_source_book', {
        target_source: referenceId,
      })
      expect(independentReference.error).toBeNull()
      referenceBookId = independentReference.data!
      expect(
        (await supabase.from('novel_sources').select('novel_id').eq('id', referenceId).single())
          .data?.novel_id,
      ).not.toBe(base.novel_id)
      const earlierBook = (await getBooks()).find((book) => book.id === referenceBookId)!
      await saveGlossaryEntry(
        { ...earlierBook, language: 'zh-Hans' },
        {
          sourceTerm: 'Original',
          targetTerm: 'Earlier translation',
          targetLanguage: 'en',
          category: 'concept',
          scope: 'novel',
          sense: '',
          chapter: 0,
          aliases: [],
          notes: 'Earlier book terminology.',
        },
      )
      await saveTranslationSettings(
        imported.book.id,
        {
          targetLanguage: 'en',
          mainSource: sourceId,
          referenceSourceId: referenceId,
          referenceBookId: null,
          referenceMode: 'same_novel',
          metadataSource: null,
        },
        0,
      )
      const analysisOutput = {
        matches: [{ url: referenceChapterUrl, reason: 'The same fixture event.' }],
        reason: 'A proposed correspondence.',
        terms: [
          {
            sourceTerm: 'Original',
            targetTerm: 'Translated',
            category: 'concept',
            sense: 'Fixture term',
            aliases: [],
            evidenceQuote: 'Original text.',
            referenceQuote: 'Translated text.',
          },
        ],
      }
      inferProvider.mockResolvedValueOnce({
        status: 'completed',
        output_parsed: analysisOutput,
        usage: { input_tokens: 100, output_tokens: 50 },
      })
      const analyzed = await analyzeSourceChapters(
        token,
        {
          bookId: imported.book.id,
          sourceUrl: chapterUrl,
          referenceUrls: [referenceChapterUrl],
          confirmed: true,
        },
        config,
      )
      expect(analyzed.result.matches[0].url).toBe(referenceChapterUrl)
      expect(inferProvider.mock.lastCall?.[0].model).toBe('gpt-5-nano')
      const unreviewed = await runBookTranslation(
        token,
        { bookId: imported.book.id, sourceKey: chapterUrl, action: 'context' },
        config,
      )
      expect(unreviewed.context?.source.text).toBe('Original text.')
      expect(unreviewed.context?.references).toEqual([])
      expect(unreviewed.context?.glossary).toEqual([])
      expect(unreviewed.context?.terminologyMemory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'Original',
            target: 'Translated',
            match: 'exact',
            status: 'proposed',
            novelId: base.novel_id,
          }),
        ]),
      )
      expect(unreviewed.context?.terminologyMemory?.some(term => term.novelId === earlierBook.novelId)).toBe(false)
      expect(
        (
          await supabase.rpc('set_context_preferences', {
            target_book: imported.book.id,
            expected_revision: 1,
            token_budget: 128000,
            recent_count: 3,
            auto_guide: false,
            update_interval: 5,
            feedback: '',
          })
        ).error,
      ).toBeNull()
      expect(
        (
          await supabase.rpc('set_context_preferences', {
            target_book: imported.book.id,
            expected_revision: 1,
            token_budget: 128000,
            recent_count: 3,
            auto_guide: true,
            update_interval: 5,
            feedback: '',
          })
        ).error?.code,
      ).toBe('40001')
      const pairing = await supabase.rpc('review_source_alignment', {
        target_source: sourceId,
        chapter_url: chapterUrl,
        reference_source: referenceId,
        paired_urls: [referenceChapterUrl],
        decision: 'confirmed',
      })
      expect(pairing.error).toBeNull()
      const proposal = await supabase
        .from('glossary_entries')
        .select('*')
        .eq('novel_id', imported.book.novelId!)
        .eq('source_term', 'Original')
        .single()
      expect(proposal.error).toBeNull()
      expect(proposal.data?.status).toBe('proposed')
      await setGlossaryStatus(proposal.data!, 'approved')
      const reviewed = await runBookTranslation(
        token,
        { bookId: imported.book.id, sourceKey: chapterUrl, action: 'context' },
        config,
      )
      expect(reviewed.context).toMatchObject({
        referenceSource: { id: referenceId },
        basis: 'confirmed',
        references: [{ text: 'Translated text.', url: referenceChapterUrl }],
        glossary: [{ source: 'Original', target: 'Translated' }],
      })
      const translatedDraft = {
        title: 'Draft chapter',
        paragraphs: ['Translated prose.'],
        terminology: [
          {
            source: 'Original',
            target: 'Translated',
            category: 'concept',
            sense: 'Fixture term',
            evidenceQuote: 'Original text.',
          },
          {
            source: 'text',
            target: 'prose',
            category: 'concept',
            sense: 'Literary form',
            evidenceQuote: 'Original text.',
          },
        ],
      }
      inferProvider.mockResolvedValueOnce({
        status: 'completed',
        output_parsed: translatedDraft,
        usage: { input_tokens: 100, output_tokens: 50 },
      })
      expect(
        (
          await runBookTranslation(
            token,
            {
              bookId: imported.book.id,
              sourceKey: chapterUrl,
              action: 'translate',
              confirmed: true,
            },
            config,
          )
        ).previewId,
      ).toBeTruthy()
      expect(inferProvider.mock.lastCall?.[0].model).toBe('gpt-5.6-luna')
      expect(
        (
          await supabase
            .from('glossary_entries')
            .select('status,target_term')
            .eq('novel_id', imported.book.novelId!)
            .eq('source_term', 'text')
        ).data,
      ).toEqual([{ status: 'proposed', target_term: 'prose' }])
      inferProvider.mockResolvedValueOnce({ status: 'completed', output_parsed: translatedDraft })
      const repeated = await runBookTranslation(
        token,
        { bookId: imported.book.id, sourceKey: chapterUrl, action: 'translate', confirmed: true },
        config,
      )
      expect(repeated).toMatchObject({ termsSaved: 0 })
      const requestsBeforeEdit = inferProvider.mock.calls.length
      const edited = await editBookTranslationTerm(
        token,
        {
          previewId: repeated.previewId!,
          source: 'Original',
          previous: 'Translated',
          preferred: 'Preferred',
          scope: 'novel',
          category: 'concept',
          sense: 'Fixture term',
        },
        config,
      )
      expect(edited.translation.paragraphs).toEqual(['Preferred prose.'])
      expect(edited.previewId).not.toBe(repeated.previewId)
      expect(
        (
          await supabase
            .from('book_translation_previews')
            .select('result')
            .eq('id', repeated.previewId!)
            .single()
        ).data?.result,
      ).toMatchObject({ paragraphs: ['Translated prose.'] })
      expect(
        (
          await supabase
            .from('glossary_entries')
            .select('target_term,status')
            .eq('novel_id', imported.book.novelId!)
            .eq('source_term', 'Original')
            .single()
        ).data,
      ).toEqual({ target_term: 'Preferred', status: 'approved' })
      expect(inferProvider).toHaveBeenCalledTimes(requestsBeforeEdit)
      expect(
        (
          await supabase
            .from('book_translation_settings')
            .select('guide_chapters_since_update')
            .eq('book_id', imported.book.id)
            .single()
        ).data?.guide_chapters_since_update,
      ).toBe(1)
      const continued = await runBookTranslation(
        token,
        {
          bookId: imported.book.id,
          sourceKey: canonicalUrl,
          action: 'context',
          continuation: true,
        },
        config,
      )
      expect(continued.context?.recentTranslations).toMatchObject([
        { url: chapterUrl, text: 'Preferred prose.', truncated: false },
      ])
      expect(continued.budget).toMatchObject({
        contextLimit: 128000,
        inputLimit: 111616,
        outputReserve: 16384,
      })
      const previewCount = (
        await supabase
          .from('book_translation_previews')
          .select('id')
          .eq('book_id', imported.book.id)
      ).data!.length
      const invalidDraft = {
        ...translatedDraft,
        terminology: [{ ...translatedDraft.terminology[1], evidenceQuote: 'Invented quotation.' }],
      }
      const rejected = await supabase.rpc('complete_chapter_translation', {
        target_book: imported.book.id,
        chapter_key: chapterUrl,
        expected_revision: 2,
        translation_model: 'test',
        snapshot: reviewed.context as unknown as Json,
        draft: invalidDraft as unknown as Json,
        consumed_input: 0,
        consumed_output: 0,
      })
      expect(rejected.error?.message).toContain('evidence')
      expect(
        (
          await supabase
            .from('book_translation_previews')
            .select('id')
            .eq('book_id', imported.book.id)
        ).data,
      ).toHaveLength(previewCount)
      expect(
        (
          await supabase.rpc('review_source_alignment', {
            target_source: sourceId,
            chapter_url: chapterUrl,
            reference_source: referenceId,
            paired_urls: [],
            decision: 'rejected',
          })
        ).error,
      ).toBeNull()
      inferProvider.mockResolvedValueOnce({
        status: 'completed',
        output_parsed: analysisOutput,
        usage: { input_tokens: 100, output_tokens: 50 },
      })
      await analyzeSourceChapters(
        token,
        {
          bookId: imported.book.id,
          sourceUrl: chapterUrl,
          referenceUrls: [referenceChapterUrl],
          confirmed: true,
        },
        config,
      )
      expect(
        (
          await supabase
            .from('source_chapter_alignments')
            .select('status')
            .eq('source_id', sourceId)
            .single()
        ).data?.status,
      ).toBe('rejected')
      expect(
        (
          await supabase
            .from('glossary_entries')
            .select('status')
            .eq('novel_id', imported.book.novelId!)
            .eq('source_term', 'Original')
        ).data,
      ).toEqual([{ status: 'approved' }])
      await expect(
        downloadSourceChapter(token, { sourceId, url: referenceChapterUrl }, config),
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        downloadSourceChapter(token, { sourceId: catalogId, url: chapterUrl }, config),
      ).rejects.toThrow('Catalogs')
      expect((await getChapter(imported.book.id, 0))?.html).toContain('An imported copy.')
      const outsider = createClient(config.supabaseUrl, config.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      await outsider.auth.signInAnonymously()
      const outsiderToken = (await outsider.auth.getSession()).data.session!.access_token
      expect(
        await downloadedSourceUrls(token, { bookId: imported.book.id, sourceUrl }, config),
      ).toEqual({ urls: [chapterUrl, canonicalUrl], aliases: { [aliasUrl]: canonicalUrl } })
      expect(
        await downloadedSourceUrls(
          token,
          { bookId: referenceBookId!, sourceUrl: referenceUrl },
          config,
        ),
      ).toEqual({ urls: [referenceChapterUrl], aliases: {} })
      await expect(
        downloadedSourceUrls(outsiderToken, { bookId: imported.book.id, sourceUrl }, config),
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        downloadSourceChapter(outsiderToken, { sourceId, url: chapterUrl }, config),
      ).rejects.toMatchObject({ status: 404 })
      expect(
        (await outsider.from('source_chapters').select('*').eq('source_id', sourceId)).data,
      ).toEqual([])
      expect(
        (await outsider.storage.from('library').download(original.record.content_path)).error,
      ).toBeTruthy()
      await outsider.auth.signOut()
    } finally {
      if (paths.length) await supabase.storage.from('library').remove(paths)
      if (referenceBookId) await removeBook(referenceBookId)
      await removeBook(imported.book.id)
    }
  }, 15_000)
  it('uses a designated reference, editable chapter pairs and target metadata without replacing original text', async () => {
    const source = await saveBook(
      await importBook(
        new File(
          ['Chapter 1\nOriginal chapter text.\n\nChapter 2\nA later chapter.'],
          `Original-${crypto.randomUUID()}.txt`,
        ),
      ),
    )
    const reference = await saveBook(
      await importBook(
        new File(
          ['Chapter 1\nReference chapter text.\n\nChapter 2\nMore reference text.'],
          `Reference-${crypto.randomUUID()}.txt`,
        ),
      ),
    )
    const token = (await supabase.auth.getSession()).data.session!.access_token
    const config = {
      root: '',
      apiKey: 'test-only',
      liveEnabled: true,
      model: 'gpt-5-nano',
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
      publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    }
    try {
      await saveTranslationSettings(
        source.book.id,
        {
          targetLanguage: 'fr',
          referenceBookId: reference.book.id,
          referenceMode: 'same_novel',
          mainSource: null,
          metadataSource: null,
        },
        0,
      )
      await saveChapterReferencePair(source.book.id, 'local:0', reference.book.id, [0, 1], 1)
      const retrieved = await runBookTranslation(
        token,
        { bookId: source.book.id, action: 'context', sourceKey: 'local:0' },
        config,
      )
      expect(retrieved.context).toMatchObject({
        targetLanguage: 'fr',
        basis: 'confirmed',
        referenceBook: { id: reference.book.id },
      })
      expect(retrieved.context?.references).toHaveLength(2)
      expect(retrieved.context?.references[0].text).toContain('Reference chapter text')
      await expect(
        saveChapterReferencePair(source.book.id, 'local:999', reference.book.id, [0], 1),
      ).rejects.toThrow('Source chapter not found')
      await expect(
        saveTranslationSettings(
          source.book.id,
          {
            targetLanguage: 'en',
            referenceBookId: reference.book.id,
            referenceMode: 'style_only',
            mainSource: null,
            metadataSource: null,
          },
          0,
        ),
      ).rejects.toThrow('changed')
      await expect(
        runBookTranslation(
          token,
          { bookId: source.book.id, action: 'translate', sourceKey: 'local:0' },
          config,
        ),
      ).rejects.toMatchObject({ status: 403 })
      inferProvider.mockResolvedValueOnce({
        status: 'completed',
        output_parsed: { title: 'Chapitre un', paragraphs: ['Texte traduit.'], terminology: [] },
        usage: { input_tokens: 500, output_tokens: 50 },
      })
      const draft = await runBookTranslation(
        token,
        { bookId: source.book.id, action: 'translate', sourceKey: 'local:0', confirmed: true },
        config,
      )
      expect(draft.previewId).toBeTruthy()
      expect(JSON.stringify(inferProvider.mock.lastCall)).toContain('Reference chapter text')
      expect((await getChapter(source.book.id, 0))?.html).toContain('Original chapter text')
      inferProvider.mockResolvedValueOnce({
        status: 'completed',
        output_parsed: {
          title: 'Titre traduit',
          author: 'Auteur',
          synopsis: 'Synopsis traduit.',
          coverAlt: '',
        },
        usage: { input_tokens: 100, output_tokens: 40 },
      })
      const preview = await runBookTranslation(
        token,
        { bookId: source.book.id, action: 'metadata', translateMetadata: true, confirmed: true },
        config,
      )
      const authorEdit = await supabase
        .from('books')
        .update({ author: 'New author edit' })
        .eq('id', source.book.id)
      expect(authorEdit.error).toBeNull()
      await expect(applyMetadataPreview(preview.previewId!)).rejects.toThrow('changed')
      const coverEdit = await supabase
        .from('books')
        .update({
          author: source.book.author,
          source_cover_url: 'https://images.example.test/new-cover.jpg',
        })
        .eq('id', source.book.id)
      expect(coverEdit.error).toBeNull()
      await expect(applyMetadataPreview(preview.previewId!)).rejects.toThrow('changed')
      const restored = await supabase
        .from('books')
        .update({ source_cover_url: null })
        .eq('id', source.book.id)
      expect(restored.error).toBeNull()
      await applyMetadataPreview(preview.previewId!)
      const updated = (await getBooks()).find((book) => book.id === source.book.id)!
      expect(updated.title).toBe('Titre traduit')
      expect(updated.description).toBe('Synopsis traduit.')
      expect(updated.language).toBe(source.book.language)
      await expect(applyMetadataPreview(preview.previewId!)).rejects.toThrow('already applied')
      const unchanged = await runBookTranslation(
        token,
        { bookId: source.book.id, action: 'metadata' },
        config,
      )
      await applyMetadataPreview(unchanged.previewId!)
      await expect(applyMetadataPreview(unchanged.previewId!)).rejects.toThrow('already applied')
      const outsider = createClient(config.supabaseUrl, config.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      await outsider.auth.signInAnonymously()
      const outsiderToken = (await outsider.auth.getSession()).data.session!.access_token
      await expect(
        runBookTranslation(
          outsiderToken,
          { bookId: source.book.id, action: 'context', sourceKey: 'local:0' },
          config,
        ),
      ).rejects.toMatchObject({ status: 404 })
      expect(
        (await outsider.from('book_translation_previews').select('*').eq('book_id', source.book.id))
          .data,
      ).toEqual([])
      const navigationUrl = `https://navigation-${crypto.randomUUID()}.example.test/book/1`
      const recipes = [
        { label: 'reveal # entries', role: 'button', value: null, intent: 'load_more' },
      ]
      expect(await siteNavigation(token, { url: navigationUrl, recipes }, config)).toEqual({
        recipes,
      })
      expect(
        await siteNavigation(token, { url: navigationUrl.replace('/1', '/2') }, config),
      ).toEqual({ recipes })
      expect(await siteNavigation(outsiderToken, { url: navigationUrl }, config)).toEqual({
        recipes: [],
      })
      await supabase.from('site_navigation').delete().eq('origin', new URL(navigationUrl).origin)
      await outsider.auth.signOut()
    } finally {
      await removeBook(source.book.id)
      await removeBook(reference.book.id)
    }
  })

  it('stores translated identification fields and full extraction JSON with owner isolation', async () => {
    const ownerId = await ensureSession()
    const page = { url: 'https://books.example.test/metadata', html: '<h1>Original book</h1>' }
    const inspection = {
      classification: 'index' as const,
      title: 'English book title',
      originalTitle: 'Original book',
      author: 'Romanized author',
      originalAuthor: null,
      language: 'zh-Hant',
      synopses: [
        { label: 'Introduction', text: 'An English introduction.', originalText: 'Original text.' },
        { label: 'Alternate', text: 'Another version.', originalText: null },
      ],
      coverImage: { url: 'https://images.example.test/cover.jpg', alt: 'Book cover' },
      genres: ['Fantasy'],
      tags: ['Adventure'],
      publicationStatus: 'Ongoing',
      chapterCount: 120,
      wordCount: null,
      updatedAt: null,
      additionalMetadata: [
        { field: 'Publisher', value: 'Example Press', originalField: null, originalValue: null },
        {
          field: 'Aliases',
          value: ['A loose English alias', 'An original-language alias'],
          originalField: 'Associated Names',
          originalValue: null,
        },
      ],
      reason: 'A book page.',
      chapterLinks: [],
      indexUrl: null,
    }
    const result: InspectionResult = {
      inspection,
      rawExtraction: inspection,
      sourceLanguage: 'zh-Hant',
      outputLanguage: 'en',
      model: 'gpt-5-nano',
      inputTokens: 100,
      outputTokens: 50,
      metadataReference: {
        url: 'https://www.novelupdates.com/series/metadata-fixture/',
        title: 'Novel Updates metadata fixture',
        capturedHtmlHash: 'f'.repeat(64),
      },
    }
    const ids: string[] = []
    let webBookId: string | undefined
    let otherBookId: string | undefined
    const contextBookIds: string[] = []
    try {
      ids.push(await persistIdentification(supabase, page, result))
      ids.push(await persistIdentification(supabase, page, result))
      expect(ids[0]).not.toBe(ids[1])
      const stored = await supabase
        .from('page_identifications')
        .select('*')
        .eq('id', ids[0])
        .single()
      expect(stored.error).toBeNull()
      expect(stored.data).toMatchObject({
        source_language: 'zh-Hant',
        output_language: 'en',
        title: 'English book title',
        metadata: expect.objectContaining({
          ...inspection,
          aliases: ['A loose English alias', 'An original-language alias'],
          metadataReference: result.metadataReference,
        }),
        raw_extraction: inspection,
      })
      expect(stored.data?.captured_html_hash).toMatch(/^[a-f0-9]{64}$/)
      const token = (await supabase.auth.getSession()).data.session!.access_token
      const configuration = {
        root: '',
        apiKey: '',
        liveEnabled: false,
        model: 'test',
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      }
      const reviewed = {
        recordId: ids[0],
        title: 'Reviewed title',
        author: 'Reviewed author',
        referenceVersions: [
          {
            label: 'English edition',
            language: 'en',
            url: 'https://english.example.test/contents',
          },
        ],
        confirmed: true,
      }
      const added = await addIdentifiedNovel(token, reviewed, configuration)
      webBookId = added.bookId
      const separateReference = (await getBooks()).find(
        (book) => book.sourceUrl === reviewed.referenceVersions[0].url,
      )!
      expect(separateReference).toBeTruthy()
      contextBookIds.push(separateReference.id)
      expect(separateReference.novelId).not.toBe(added.novelId)
      const webBook = (await getBooks()).find((book) => book.id === added.bookId)!
      expect(webBook.format).toBe('WEB')
      expect(webBook.title).toBe('Reviewed title')
      expect(webBook.chapters).toHaveLength(0)
      expect(webBook.catalog?.inspection.synopses).toHaveLength(2)
      const initiallySaved = (await connectedLibrary(token, configuration)).find(
        (book) => book.id === added.bookId,
      )!
      expect(initiallySaved.aliases).toEqual(
        expect.arrayContaining(['A loose English alias', 'An original-language alias']),
      )
      expect(initiallySaved.sources.filter((source) => source.role === 'metadata')).toEqual([
        expect.objectContaining({ url: result.metadataReference!.url }),
      ])
      expect(await getOriginalFile(webBook.id)).toBeUndefined()
      const duplicate = await addIdentifiedNovel(
        token,
        { ...reviewed, title: 'Do not overwrite yet' },
        configuration,
      )
      expect(duplicate.alreadySaved).toBe(true)
      expect((await getBooks()).find((book) => book.id === added.bookId)?.title).toBe(
        'Reviewed title',
      )
      expect(
        (
          await addIdentifiedNovel(
            token,
            { ...reviewed, title: 'Explicitly updated', overwrite: true },
            configuration,
          )
        ).updated,
      ).toBe(true)
      expect((await getBooks()).find((book) => book.id === added.bookId)?.title).toBe(
        'Explicitly updated',
      )
      expect(
        (await getTranslationWorkspace(webBook)).sources.filter(
          (source) => source.role === 'reference',
        ),
      ).toHaveLength(0)
      const refreshedId = await persistIdentification(supabase, page, {
        ...result,
        sourceLanguage: 'zh-Hans',
        inspection: { ...inspection, language: 'zh-Hans', genres: ['Science fiction'] },
      })
      ids.push(refreshedId)
      await addIdentifiedNovel(
        token,
        { ...reviewed, recordId: refreshedId, overwrite: true },
        configuration,
      )
      const refreshedBook = (await getBooks()).find((entry) => entry.id === added.bookId)!
      expect(refreshedBook.language).toBe('zh-Hans')
      expect(refreshedBook.genre).toBe('Science fiction')
      const englishId = await persistIdentification(
        supabase,
        {
          url: 'https://translation.example.test/novel',
          html: '<h1>A different translated title</h1>',
        },
        {
          ...result,
          sourceLanguage: 'en',
          inspection: { ...inspection, title: 'A different translated title', language: 'en' },
        },
      )
      ids.push(englishId)
      const pairRequest = {
        bookId: added.bookId,
        recordId: englishId,
        label: 'English edition',
        language: 'en',
        role: 'reference',
        confirmed: true,
      }
      await expect(pairIdentifiedEdition(token, pairRequest, configuration)).rejects.toThrow(
        'separate library books',
      )
      const englishBook = await addIdentifiedNovel(
        token,
        {
          ...reviewed,
          recordId: englishId,
          title: 'A different translated title',
          referenceVersions: [],
        },
        configuration,
      )
      contextBookIds.push(englishBook.bookId)
      expect(englishBook.bookId).not.toBe(added.bookId)
      const context = await savedSourceContext(
        token,
        { url: 'https://translation.example.test/novel' },
        configuration,
      )
      expect(context.book?.id).toBe(englishBook.bookId)
      expect(context.inspection?.recordId).toBe(englishId)
      expect(
        (
          await savedSourceContext(
            token,
            { url: 'https://translation.example.test/another-book' },
            configuration,
          )
        ).book,
      ).toBeNull()
      const duplicateSource = await addIdentifiedNovel(
        token,
        { ...reviewed, recordId: englishId },
        configuration,
      )
      expect(duplicateSource).toMatchObject({
        bookId: englishBook.bookId,
        alreadySaved: true,
        updated: false,
      })
      const discovered = {
        url: 'https://translation.example.test/contents',
        title: 'Contents',
        truncated: false,
        links: [1, 2].map((position) => ({
          title: `Chapter ${position}`,
          url: `https://translation.example.test/read/${position}`,
        })),
      }
      expect(
        await saveSourceContents(
          token,
          {
            bookId: englishBook.bookId,
            sourceUrl: 'https://translation.example.test/novel',
            contents: {
              ...discovered,
              links: [
                ...discovered.links,
                { title: 'Duplicate', url: discovered.links[0].url + '#top' },
                ...discovered.links,
              ],
            },
          },
          configuration,
        ),
      ).toMatchObject({ saved: true, foundCount: 2 })
      const savedInventory = (
        await savedSourceContext(token, { url: discovered.url }, configuration)
      ).inspection?.contents
      expect(savedInventory?.chapters.map((chapter) => chapter.url)).toEqual(
        discovered.links.map((chapter) => chapter.url),
      )
      expect(
        await saveSourceContents(
          token,
          {
            bookId: englishBook.bookId,
            sourceUrl: 'https://translation.example.test/novel',
            contents: { ...discovered, links: discovered.links.slice(0, 1) },
          },
          configuration,
        ),
      ).toMatchObject({ saved: false })
      expect(
        (await savedSourceContext(token, { url: discovered.url }, configuration)).book?.id,
      ).toBe(englishBook.bookId)
      const catalog = await connectedLibrary(token, configuration)
      expect(catalog.find((book) => book.id === added.bookId)).toMatchObject({
        title: refreshedBook.title,
        language: 'zh-Hans',
        aliases: expect.arrayContaining(['A loose English alias']),
      })
      expect(
        catalog
          .find((book) => book.id === englishBook.bookId)
          ?.sources.filter((source) => source.url === 'https://translation.example.test/novel'),
      ).toHaveLength(1)
      expect((await getBooks()).find((book) => book.id === added.bookId)).toEqual(refreshedBook)
      expect(
        catalog
          .find((book) => book.id === added.bookId)
          ?.sources.filter((source) => source.url === result.metadataReference!.url),
      ).toHaveLength(1)
      const catalogIdentification = await persistIdentification(
        supabase,
        {
          url: 'https://www.novelupdates.com/series/another-fixture/',
          html: '<h1>A metadata-only fixture</h1>',
        },
        {
          ...result,
          metadataReference: undefined,
          sourceLanguage: 'en',
          inspection: { ...inspection, classification: 'catalog', language: 'en' },
        },
      )
      ids.push(catalogIdentification)
      const metadataPair = await pairIdentifiedEdition(
        token,
        {
          ...pairRequest,
          recordId: catalogIdentification,
          role: 'metadata',
          label: 'Novel Updates catalog',
        },
        configuration,
      )
      const metadataSource = await supabase
        .from('novel_sources')
        .select('role,identification_id')
        .eq('id', metadataPair.sourceId)
        .single()
      expect(metadataSource.data).toEqual({
        role: 'metadata',
        identification_id: catalogIdentification,
      })
      expect((await getBooks()).find((book) => book.id === added.bookId)).toEqual(refreshedBook)
      const otherIdentification = await persistIdentification(
        supabase,
        { url: 'https://other.example.test/novel', html: '<h1>An unrelated book</h1>' },
        result,
      )
      ids.push(otherIdentification)
      otherBookId = (
        await addIdentifiedNovel(
          token,
          {
            ...reviewed,
            recordId: otherIdentification,
            title: 'An unrelated book',
            referenceVersions: [],
          },
          configuration,
        )
      ).bookId
      await expect(
        pairIdentifiedEdition(token, { ...pairRequest, bookId: otherBookId }, configuration),
      ).rejects.toThrow('separate library books')
      expect(
        (await connectedLibrary(token, configuration))
          .find((book) => book.id === otherBookId)
          ?.sources.some((source) => source.url === 'https://translation.example.test/novel'),
      ).toBe(false)
      const outsider = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      expect((await outsider.auth.signInAnonymously()).error).toBeNull()
      const outsiderToken = (await outsider.auth.getSession()).data.session!.access_token
      await expect(
        pairIdentifiedEdition(
          outsiderToken,
          { ...pairRequest, recordId: catalogIdentification, role: 'metadata' },
          configuration,
        ),
      ).rejects.toMatchObject({ status: 404 })
      expect(await connectedLibrary(outsiderToken, configuration)).toEqual([])
      const originalContents = {
        url: page.url,
        title: 'Saved contents',
        truncated: false,
        links: [3, 2, 1].map((position) => ({
          title: `Chapter ${position}`,
          url: `https://books.example.test/read/${position}`,
        })),
      }
      await expect(
        saveSourceContents(
          outsiderToken,
          { bookId: added.bookId, sourceUrl: page.url, contents: originalContents },
          configuration,
        ),
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        saveSourceContents(
          token,
          {
            bookId: added.bookId,
            sourceUrl: page.url,
            contents: { ...originalContents, url: 'https://wrong-site.example/contents' },
          },
          configuration,
        ),
      ).rejects.toMatchObject({ status: 400 })
      expect(
        (
          await saveSourceContents(
            token,
            { bookId: added.bookId, sourceUrl: page.url, contents: originalContents },
            configuration,
          )
        ).saved,
      ).toBe(true)
      const afterContents = (await getBooks()).find((book) => book.id === added.bookId)!
      expect(afterContents).toMatchObject({
        title: refreshedBook.title,
        language: refreshedBook.language,
        chapters: [],
        progress: refreshedBook.progress,
      })
      expect(afterContents.catalog?.contents).toMatchObject({ foundCount: 3, reportedCount: 120 })
      expect(afterContents.catalog?.contents?.chapters.map((chapter) => chapter.number)).toEqual([
        1, 2, 3,
      ])
      expect(
        (await savedSourceContext(token, { url: page.url }, configuration)).inspection?.contents
          ?.foundCount,
      ).toBe(3)
      const beforeDuplicate = (await getBooks()).length
      const rawDuplicate = await supabase.rpc('add_identified_novel', {
        identification: englishId,
        reviewed_title: 'Duplicate source',
        reviewed_author: 'Test Author',
        contents_data: {},
        reference_sources: [],
        overwrite_existing: false,
      })
      expect(rawDuplicate.error).toBeNull()
      expect(rawDuplicate.data).toMatchObject({ bookId: englishBook.bookId, alreadySaved: true })
      expect((await getBooks()).length).toBe(beforeDuplicate)
      await expect(
        addIdentifiedNovel(
          (await outsider.auth.getSession()).data.session!.access_token,
          reviewed,
          configuration,
        ),
      ).rejects.toMatchObject({ status: 404 })
      expect(
        (await outsider.from('page_identifications').select('*').eq('owner_id', ownerId)).data,
      ).toEqual([])
      expect(
        (
          await outsider.from('page_identifications').insert({
            owner_id: ownerId,
            source_url: page.url,
            output_language: 'en',
            model: 'test',
            prompt_version: 'test',
            captured_html_hash: 'a'.repeat(64),
            metadata: {},
            raw_extraction: {},
          })
        ).error,
      ).not.toBeNull()
      await outsider.auth.signOut()
    } finally {
      for (const bookId of contextBookIds) await removeBook(bookId)
      if (otherBookId) await removeBook(otherBookId)
      if (webBookId) await removeBook(webBookId)
      if (ids.length) await supabase.from('page_identifications').delete().in('id', ids)
    }
  })

  it('persists files and metadata, prevents cross-session access, and removes its own data', async () => {
    const imported = await importBook(
      new File([`A book stored in Supabase. ${crypto.randomUUID()}`], 'Local.txt'),
    )
    const owner = await ensureSession()
    try {
      const saved = await saveBook(imported)
      expect(saved.duplicate).toBe(false)
      expect((await getChapter(saved.book.id, 0))?.html).toContain('stored in Supabase')
      expect(await (await getOriginalFile(saved.book.id))?.text()).toContain('stored in Supabase')
      await Promise.all([
        updateBook(saved.book.id, (book) => ({
          ...book,
          status: 'reading',
          progress: { chapter: 0, offset: 0.4 },
        })),
        updateBook(saved.book.id, (book) => ({
          ...book,
          bookmarks: [
            {
              id: crypto.randomUUID(),
              chapter: 0,
              offset: 0.4,
              title: 'A saved place',
              createdAt: Date.now(),
            },
          ],
        })),
      ])
      const duplicate = await saveBook(imported)
      expect(duplicate.duplicate).toBe(true)
      expect(duplicate.book.progress.offset).toBe(0.4)
      expect(duplicate.book.bookmarks).toHaveLength(1)
      expect((await getBooks()).find((book) => book.id === saved.book.id)?.status).toBe('reading')
      const outsider = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      const signedIn = await outsider.auth.signInAnonymously()
      expect(signedIn.error).toBeNull()
      const foreignBooks = await outsider.from('books').select('id').eq('id', saved.book.id)
      expect(foreignBooks.data).toEqual([])
      const foreignFile = await outsider.storage
        .from('library')
        .download(`${owner}/${saved.book.id}/original.txt`)
      expect(foreignFile.error).not.toBeNull()
      const foreignInsert = await outsider
        .from('reading_progress')
        .insert({ owner_id: owner, book_id: saved.book.id, chapter: 0, fraction: 0.9 })
      expect(foreignInsert.error).not.toBeNull()
      await outsider.auth.signOut()
    } finally {
      await removeBook(imported.book.id)
    }
    expect(await getChapter(imported.book.id, 0)).toBeUndefined()
    expect(
      (await supabase.storage.from('library').list(`${owner}/${imported.book.id}/chapters`)).data,
    ).toEqual([])
  }, 30_000)

  it('stores private style examples, rejects invalid files, and atomically selects inferred profiles', async () => {
    const imported = await importBook(
      new File([`A style test ${crypto.randomUUID()}`], 'Style test.txt'),
    )
    const { book } = await saveBook(imported)
    const ownerId = await ensureSession()
    const profiles: string[] = []
    try {
      await expect(uploadStyleExample(book, new File([''], 'empty.txt'))).rejects.toThrow('empty')
      await expect(uploadStyleExample(book, new File(['text'], 'chapter.pdf'))).rejects.toThrow(
        '.txt',
      )
      await expect(
        uploadStyleExample(book, new File([new Uint8Array([255, 254])], 'invalid.txt')),
      ).rejects.toThrow('UTF-8')
      await expect(
        uploadStyleExample(book, new File(['a'.repeat(1_000_001)], 'large.txt')),
      ).rejects.toThrow('1 MB')
      const text = 'The rain eased. "Keep the ledger," she said. He nodded, and closed the door.'
      const example = await uploadStyleExample(book, new File([text], 'Chapter one.txt'))
      expect((await uploadStyleExample(book, new File([text], 'Same chapter.txt'))).id).toBe(
        example.id,
      )
      expect((await getTranslationWorkspace(book)).examples).toHaveLength(1)
      expect(
        await (await supabase.storage.from('library').download(example.content_path)).data?.text(),
      ).toBe(text)
      const original = await saveStyleProfile({
        name: `Existing ${crypto.randomUUID()}`,
        instructions: 'Existing instructions.',
      })
      profiles.push(original.id)
      await assignStyleProfile(book, original.id)
      const argumentsForStyle = {
        target_book: book.id,
        expected_profile: original.id,
        example_ids: [example.id],
        style_instructions: 'Use concise narration and natural dialogue.',
        style_metadata: {
          model: 'test-only',
          examples: [{ id: example.id, hash: example.content_hash }],
        },
      }
      const configuration = {
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        apiKey: 'test-only',
        liveEnabled: true,
        model: 'test-only',
        root: '',
      }
      const payload = {
        bookId: book.id,
        exampleIds: [example.id],
        expectedProfileId: original.id,
        rightsConfirmed: true,
      }
      const token = (await supabase.auth.getSession()).data.session!.access_token
      await expect(
        runStyleInference(token, payload, { ...configuration, apiKey: '' }),
      ).rejects.toThrow('server API key')
      inferProvider.mockResolvedValueOnce({
        status: 'completed',
        output_parsed: {
          instructions: argumentsForStyle.style_instructions,
          observations: [
            {
              exampleId: example.id,
              quote: 'The rain eased.',
              pattern: 'Concise declarative narration.',
            },
          ],
          warnings: [],
        },
        usage: { input_tokens: 100, output_tokens: 60 },
      })
      const inferred = await runStyleInference(token, payload, configuration)
      profiles.push(inferred.profileId)
      expect((await getTranslationWorkspace(book)).novel.style_profile_id).toBe(inferred.profileId)
      expect(
        (
          await supabase
            .from('style_profiles')
            .select('instructions')
            .eq('id', original.id)
            .single()
        ).data?.instructions,
      ).toBe('Existing instructions.')
      expect(
        (await supabase.rpc('create_inferred_style', argumentsForStyle)).error?.message,
      ).toContain('selected style changed')

      const outsider = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      expect((await outsider.auth.signInAnonymously()).error).toBeNull()
      expect(
        (await outsider.from('style_examples').select('*').eq('owner_id', ownerId)).data,
      ).toEqual([])
      expect(
        (await outsider.storage.from('library').download(example.content_path)).error,
      ).not.toBeNull()
      expect(
        (
          await outsider.rpc('create_inferred_style', {
            ...argumentsForStyle,
            expected_profile: inferred.profileId,
          })
        ).error,
      ).not.toBeNull()
      await expect(
        runStyleInference(
          (await outsider.auth.getSession()).data.session!.access_token,
          payload,
          configuration,
        ),
      ).rejects.toThrow('Book not found')
      await outsider.auth.signOut()
      await supabase.storage
        .from('library')
        .update(example.content_path, new TextEncoder().encode('Tampered text.'), {
          contentType: 'text/plain',
        })
      await expect(
        runStyleInference(
          token,
          { ...payload, expectedProfileId: inferred.profileId },
          configuration,
        ),
      ).rejects.toThrow('changed in storage')
      expect(inferProvider).toHaveBeenCalledTimes(1)
      await removeStyleExample(example)
      expect((await getTranslationWorkspace(book)).examples).toHaveLength(0)
      expect(
        (await supabase.storage.from('library').download(example.content_path)).error,
      ).not.toBeNull()
      expect(
        (
          await supabase.rpc('create_inferred_style', {
            ...argumentsForStyle,
            expected_profile: inferred.profileId,
          })
        ).error?.message,
      ).toContain('selected examples changed')
    } finally {
      await removeBook(book.id)
      if (profiles.length) await supabase.from('style_profiles').delete().in('id', profiles)
    }
  }, 30_000)

  it('links source editions and versions scoped glossary/style records without leaking ownership', async () => {
    const imported = await importBook(
      new File(
        [
          `CHAPTER 1. Arrival\n\n林遥来到青岚渡。 ${crypto.randomUUID()}\n\nCHAPTER 2. Return\n\n林遥打开账册。`,
        ],
        'terms.txt',
      ),
    )
    imported.book.language = 'zh'
    const { book } = await saveBook(imported)
    const ownerId = await ensureSession()
    let profileId: string | undefined
    let globalId: string | undefined
    try {
      let workspace = await getTranslationWorkspace(book)
      expect(workspace.sources).toHaveLength(1)
      expect(workspace.novel.id).toBe(book.novelId)
      await addNovelSource(book, {
        label: 'Reference link',
        url: 'https://example.com/reference',
        language: 'en',
        role: 'reference',
        edition: 'Test edition',
      })
      const base = {
        sourceTerm: `林遥-${crypto.randomUUID()}`,
        targetTerm: 'Lin Yao',
        category: 'person' as const,
        scope: 'global' as const,
        chapter: 0,
        sense: '',
        notes: '',
        aliases: [],
      }
      await saveGlossaryEntry(book, base)
      workspace = await getTranslationWorkspace(book)
      const global = workspace.glossary.find((entry) => entry.source_term === base.sourceTerm)!
      globalId = global.id
      await saveGlossaryEntry(book, { ...base, scope: 'novel', targetTerm: 'Novel name' })
      await saveGlossaryEntry(book, {
        ...base,
        scope: 'chapter',
        chapter: 1,
        targetTerm: 'Chapter name',
      })
      workspace = await getTranslationWorkspace(book)
      expect(
        resolveGlossary(workspace.glossary, {
          novelId: book.novelId!,
          bookId: book.id,
          chapter: 1,
          sourceLanguage: 'zh',
          targetLanguage: 'en',
        }).find((entry) => entry.source_term === base.sourceTerm)?.target_term,
      ).toBe('Chapter name')
      await expect(saveGlossaryEntry(book, { ...base, scope: 'novel' })).rejects.toThrow(
        'already exists',
      )
      await saveGlossaryEntry(book, { ...base, targetTerm: 'Updated global' }, global)
      await expect(
        saveGlossaryEntry(book, { ...base, targetTerm: 'Stale edit' }, global),
      ).rejects.toThrow('changed elsewhere')
      const profile = await saveStyleProfile({
        name: `Style ${crypto.randomUUID()}`,
        instructions: 'Preserve names and natural dialogue.',
      })
      profileId = profile.id
      const updated = await saveStyleProfile(
        {
          name: profile.name,
          instructions: 'Preserve names, natural dialogue, and exact numbers.',
        },
        profile,
      )
      expect(updated.version).toBe(2)
      await assignStyleProfile(book, profile.id)
      workspace = await getTranslationWorkspace(book)
      expect(workspace.novel.style_profile_id).toBe(profile.id)
      expect(workspace.sources).toHaveLength(2)
      const run = await supabase
        .from('translation_runs')
        .insert({
          owner_id: ownerId,
          novel_id: book.novelId!,
          book_id: book.id,
          chapter_position: 0,
          kind: 'extract_terms',
          mode: 'fixture',
          model: 'transaction-test',
          prompt_version: 'test-v1',
          input_hash: 'test-hash',
        })
        .select('id')
        .single()
      expect(run.error).toBeNull()
      const partial = await supabase.rpc('complete_term_extraction', {
        extraction_id: run.data!.id,
        extraction_result: {
          terms: [
            {
              sourceTerm: '临时词',
              targetTerm: 'Temporary term',
              category: 'concept',
              sense: '',
              aliases: [],
              evidenceQuote: '临时词',
            },
            {
              sourceTerm: '错误词',
              targetTerm: 'Invalid term',
              category: 'invalid-category',
              sense: '',
              aliases: [],
              evidenceQuote: '错误词',
            },
          ],
          warnings: [],
        },
        consumed_input: 0,
        consumed_output: 0,
      })
      expect(partial.error).not.toBeNull()
      expect(
        (await supabase.from('glossary_entries').select('id').eq('run_id', run.data!.id)).data,
      ).toEqual([])
      expect(
        (await supabase.from('translation_runs').select('status').eq('id', run.data!.id).single())
          .data?.status,
      ).toBe('running')
      const outsider = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      expect((await outsider.auth.signInAnonymously()).error).toBeNull()
      for (const table of [
        'novels',
        'novel_sources',
        'glossary_entries',
        'style_profiles',
        'translation_runs',
      ]) {
        expect((await outsider.from(table).select('*').eq('owner_id', ownerId)).data).toEqual([])
      }
      expect(
        (
          await outsider.rpc('complete_term_extraction', {
            extraction_id: run.data!.id,
            extraction_result: { terms: [], warnings: [] },
            consumed_input: 0,
            consumed_output: 0,
          })
        ).error,
      ).not.toBeNull()
      const crossOwnerSource = await outsider
        .from('novel_sources')
        .insert({ novel_id: book.novelId, label: 'Invalid link', language: 'zh' })
      expect(crossOwnerSource.error).not.toBeNull()
      await outsider.auth.signOut()
    } finally {
      await removeBook(book.id)
      if (globalId) await supabase.from('glossary_entries').delete().eq('id', globalId)
      if (profileId) await supabase.from('style_profiles').delete().eq('id', profileId)
    }
    expect((await supabase.from('novels').select('id').eq('id', book.novelId!)).data).toEqual([])
  }, 30_000)
})
