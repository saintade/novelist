import { z } from 'zod'
import { isNovelUpdatesSeries, metadataReferenceSchema } from '../src/lib/extension/metadata'
import { publicPageUrl } from '../src/lib/scraper/contracts'
import {
  analysisModelSchema,
  addedNovelSchema,
  extensionConnectMessageSchema,
  CONTENTS_LINK_LIMIT,
} from '../src/lib/extension/contracts'
import {
  discoverContents,
  uniqueChapterLinks,
  selectChapterDownloads,
  canonicalChapterUrl,
  resolveChapterDestination,
} from '../src/lib/extension/contents'
import { exploreBrowser, scanChapterContents } from './navigation-runner'
import { BrowserAccessError, browserNavigation } from './navigation-browser'
import { navigationRecipeSchema, type NavigationPlanResult } from '../src/lib/extension/navigation'
import {
  libraryEntrySchema,
  pairedLibrarySourceSchema,
  matchSavedSource,
} from '../src/lib/extension/library-catalog'
import {
  DEFAULT_ORIGIN,
  localAppOrigin,
  panelMessageSchema,
  hasChapterJobs,
  type PanelState,
  type StoredState,
  type ChapterDownloadBatch,
} from './protocol'
import type {
  ExtensionConnection,
  ExtensionJob,
  ExtensionPageCapture,
  InspectionResult,
  ContentsCapture,
} from '../src/lib/extension/contracts'

const stored = async () => (await chrome.storage.session.get(null)) as StoredState
const downloadPacingSchema = z.record(z.string(), z.number().int().min(0).max(60)).catch({})
const downloadMethodsSchema = z.record(z.string(), z.enum(['browser', 'http'])).catch({})
let navigationTask: Promise<unknown> | undefined
let navigationStopped = false
let contentsStopped = false
let downloadTask: Promise<void> | undefined
let downloadsPaused = false
let connectionTask: Promise<void> | undefined
let connectionTimeout: ReturnType<typeof setTimeout> | undefined
let retryConnectionAt = 0
const origin = async () => {
  const value = (await chrome.storage.local.get('backendOrigin')).backendOrigin
  return localAppOrigin(typeof value === 'string' ? value : DEFAULT_ORIGIN)
}

async function panelState(): Promise<PanelState> {
  const state = await stored()
  const connection = state.connection
  delete state.connection
  delete state.connectionAttempt
  const preferences = await chrome.storage.local.get([
    'analysisModel',
    'autoConnectPaused',
    'downloadPacing',
    'downloadMethods',
  ])
  const preference = analysisModelSchema.safeParse(preferences.analysisModel)
  const pacing = downloadPacingSchema.parse(preferences.downloadPacing)
  const sourceOrigin = state.capture ? new URL(state.capture.page.url).origin : ''
  const transport =
    downloadMethodsSchema.parse(preferences.downloadMethods)[sourceOrigin] ?? 'browser'
  return {
    ...state,
    backendOrigin: await origin(),
    autoConnect: preferences.autoConnectPaused !== true,
    preferredAnalysisModel: preference.success ? preference.data : undefined,
    downloadDelaySeconds: Math.max(
      transport === 'http' ? 0 : 1,
      pacing[sourceOrigin] ?? (transport === 'http' ? 0 : 1),
    ),
    downloadTransport: transport,
    connected: Boolean(
      connection &&
      connection.expiresAt > Date.now() &&
      !state.connecting &&
      !state.connectionError,
    ),
    expiresAt: connection?.expiresAt,
  }
}

class LocalRequestError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function api(path: string, method = 'GET', body?: unknown, useConnection = true) {
  const connection = (await stored()).connection
  if (useConnection && (!connection || connection.expiresAt <= Date.now()))
    throw new Error('Connect the extension to your local Novelist app.')
  let response: Response
  try {
    response = await fetch(`${await origin()}/api/extension/${path}`, {
      method,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
      headers: {
        'Content-Type': 'application/json',
        'X-Novelist-Extension-Id': chrome.runtime.id,
        ...(useConnection ? { Authorization: `Bearer ${connection!.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new Error('Novelist is unreachable. Start the local app and check its address.')
  }
  const result = await response.json()
  if (!response.ok) {
    if (response.status === 401) await chrome.storage.session.remove('connection')
    throw new LocalRequestError(
      typeof result.error === 'string' ? result.error : 'The local request failed.',
      response.status,
    )
  }
  return result
}

async function captureTab(tab: chrome.tabs.Tab) {
  if (
    downloadTask ||
    (await stored()).job?.state === 'running' ||
    (await stored()).scanningContents ||
    navigationTask
  )
    throw new Error('Wait for the current page operation to finish before capturing another page.')
  if (!tab.id || !tab.url)
    throw new Error('Select a book page and click the Novelist toolbar icon.')
  publicPageUrl(tab.url)
  await chrome.storage.session.set({ capturing: true, error: '' })
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] })
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const scope = globalThis as typeof globalThis & { __novelistCapture?: () => unknown }
        const result = scope.__novelistCapture?.()
        delete scope.__novelistCapture
        return result
      },
    })
    const capture = results[0]?.result as Omit<ExtensionPageCapture, 'tabId'> | undefined
    if (!capture?.page) throw new Error('The page capture was unavailable.')
    if (publicPageUrl(capture.page.url) !== publicPageUrl(tab.url))
      throw new Error('The page navigated during capture. Capture it again.')
    await chrome.storage.session.remove([
      'inspection',
      'job',
      'estimate',
      'contentsCapture',
      'contentsScan',
      'referenceVersions',
      'addedNovel',
      'navigation',
      'libraryMatches',
      'pairedSource',
      'savedSource',
      'novelUpdatesUrl',
      'sourceLookupError',
      'contentsSaved',
      'contentsSaveError',
      'chapterDownload',
      'chapterBatch',
    ])
    await chrome.storage.session.set({
      capture: { ...capture, tabId: tab.id, capturedAt: new Date().toISOString() },
      useMetadataReference: false,
      error: '',
    })
    await restoreSavedSource()
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : 'Page capture failed.'
    throw new Error(
      message.includes('Cannot access')
        ? 'Click the Novelist toolbar icon on the book page to grant access to that tab.'
        : message,
    )
  } finally {
    await chrome.storage.session.set({ capturing: false })
  }
}

const pauseDownload = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

async function rememberDownloadPacing(sourceUrl: string, seconds: number) {
  const { downloadPacing = {} } = await chrome.storage.local.get('downloadPacing')
  await chrome.storage.local.set({
    downloadPacing: {
      ...downloadPacingSchema.parse(downloadPacing),
      [new URL(sourceUrl).origin]: seconds,
    },
  })
}

async function rememberDownloadMethod(sourceUrl: string, transport: 'browser' | 'http') {
  const { downloadMethods } = await chrome.storage.local.get('downloadMethods')
  await chrome.storage.local.set({
    downloadMethods: {
      ...downloadMethodsSchema.parse(downloadMethods),
      [new URL(sourceUrl).origin]: transport,
    },
  })
}

async function rememberChapterAliases(sourceUrl: string, aliases: unknown) {
  if (!aliases || typeof aliases !== 'object' || !Object.keys(aliases).length) return
  const current = await stored()
  if (current.savedSource?.url !== sourceUrl || !current.inspection || !current.capture) return
  const rewrite = <Entry extends { title: string; url: string }>(
    baseUrl: string,
    entries: Entry[],
  ) =>
    uniqueChapterLinks(
      baseUrl,
      entries.map((entry) => ({ ...entry, url: canonicalChapterUrl(entry.url, aliases) })),
    )
  const metadata = {
    ...current.inspection.inspection,
    chapterLinks: rewrite(sourceUrl, current.inspection.inspection.chapterLinks),
  }
  const contents = current.inspection.contents
  await chrome.storage.session.set({
    inspection: {
      ...current.inspection,
      inspection: metadata,
      ...(contents
        ? {
            contents: discoverContents(
              {
                url: contents.url,
                title: current.capture.pageTitle,
                links: rewrite(
                  contents.url,
                  contents.chapters.map((chapter) => ({
                    title: chapter.sourceTitle || chapter.title,
                    url: chapter.url,
                  })),
                ),
                truncated: contents.truncated,
              },
              metadata,
            ),
          }
        : {}),
    },
    ...(current.contentsCapture
      ? {
          contentsCapture: {
            ...current.contentsCapture,
            links: rewrite(current.contentsCapture.url, current.contentsCapture.links),
          },
        }
      : {}),
  })
}

function canonicalizeBatch(batch: ChapterDownloadBatch, aliases: unknown) {
  const completed = new Set(
    (batch.completedUrls ?? batch.urls.slice(0, batch.next)).map((url) =>
      canonicalChapterUrl(url, aliases),
    ),
  )
  const pendingUrls = Object.keys(batch.jobs ?? {})
  if (batch.jobId && batch.urls[batch.next]) pendingUrls.push(batch.urls[batch.next])
  for (const url of pendingUrls) completed.delete(canonicalChapterUrl(url, aliases))
  batch.urls = [...new Set(batch.urls.map((url) => canonicalChapterUrl(url, aliases)))]
  batch.completedUrls = [...completed]
  const next = batch.urls.findIndex((url) => !completed.has(url))
  batch.next = next < 0 ? batch.urls.length : next
}

function completeBatchChapter(batch: ChapterDownloadBatch, url: string, cached: boolean) {
  const completed = new Set(batch.completedUrls ?? batch.urls.slice(0, batch.next))
  if (!completed.has(url)) {
    completed.add(url)
    if (cached) batch.skipped++
    else batch.saved++
  }
  batch.completedUrls = [...completed]
  const next = batch.urls.findIndex((chapter) => !completed.has(chapter))
  batch.next = next < 0 ? batch.urls.length : next
}

async function pollDownloadJob(jobId: string): Promise<ExtensionJob> {
  const deadline = Date.now() + 240_000
  for (;;) {
    const job = (await api(`jobs/${encodeURIComponent(jobId)}`)) as ExtensionJob
    if (job.state !== 'running') return job
    if (Date.now() >= deadline)
      throw new Error(
        'This chapter is still processing. Resume to check the existing job; no new model request will be sent.',
      )
    await pauseDownload(500)
  }
}

async function runDirectChapterBatch(batch: ChapterDownloadBatch, confirmed: boolean) {
  batch.timing ??= { browserMs: 0, browserPages: 0, processingMs: 0, processingJobs: 0 }
  batch.jobs ??= {}
  if (batch.jobId) {
    batch.jobs[batch.urls[batch.next]] = batch.jobId
    delete batch.jobId
  }
  let publications = Promise.resolve()
  const publish = () => {
    const snapshot = structuredClone(batch)
    publications = publications.then(async () => {
      const current = (await chrome.storage.session.get('chapterBatch')).chapterBatch as
        ChapterDownloadBatch | undefined
      if (current?.id === batch.id) await chrome.storage.session.set({ chapterBatch: snapshot })
    })
    return publications
  }
  let halted = false
  const failures: {
    url: string
    state: 'paused' | 'needs_browser' | 'needs_scraper'
    message: string
  }[] = []
  try {
    const approvedUrl = confirmed ? batch.urls[batch.next] : undefined
    const cached: { urls: string[]; aliases?: unknown } = hasChapterJobs(batch)
      ? { urls: [] }
      : await api('library/downloaded', 'POST', {
          bookId: batch.bookId,
          sourceUrl: batch.sourceUrl,
        })
    let aliases = cached.aliases
    canonicalizeBatch(batch, aliases)
    await rememberChapterAliases(batch.sourceUrl, aliases)
    const state = await stored()
    const choices =
      state.inspection?.contents?.chapters ?? state.inspection?.inspection.chapterLinks ?? []
    for (const url of cached.urls)
      if (batch.urls.includes(url)) completeBatchChapter(batch, url, true)
    await publish()
    let nextStart = Date.now()
    const download = async (requestedUrl: string, allowGeneration = false) => {
      const url = canonicalChapterUrl(requestedUrl, aliases)
      let jobId = batch.jobs![requestedUrl]
      if (!jobId && (batch.completedUrls?.includes(url) || halted || downloadsPaused)) return
      try {
        if (!jobId) {
          const startAt = Math.max(Date.now(), nextStart)
          nextStart = startAt + (batch.delaySeconds ?? 0) * 1000
          while (Date.now() < startAt && !halted && !downloadsPaused)
            await pauseDownload(Math.min(250, startAt - Date.now()))
          if (halted || downloadsPaused) return
          batch.message = `Downloading chapter ${batch.from + batch.urls.indexOf(url)}`
          const operation = await api('library/chapter/start', 'POST', {
            bookId: batch.bookId,
            sourceUrl: batch.sourceUrl,
            requestedUrl: url,
            confirmed: allowGeneration,
          })
          jobId = operation.id as string
          batch.jobs![requestedUrl] = jobId
          await publish()
        }
        const started = Date.now()
        const job = await pollDownloadJob(jobId)
        batch.timing!.processingMs += Date.now() - started
        batch.timing!.processingJobs++
        delete batch.jobs![requestedUrl]
        await api(`jobs/${encodeURIComponent(jobId)}`, 'DELETE').catch(() => undefined)
        if (job.state === 'failed' || !job.download)
          throw new Error(job.error || 'Chapter extraction did not return a result.')
        const canonical = job.download.canonicalUrl ?? url
        if (canonical !== url) {
          resolveChapterDestination(url, canonical, choices)
          aliases = { ...(aliases && typeof aliases === 'object' ? aliases : {}), [url]: canonical }
          canonicalizeBatch(batch, aliases)
          await rememberChapterAliases(batch.sourceUrl, { [url]: canonical })
        }
        if (job.download.state !== 'ready') {
          halted = true
          const firstChallenge =
            job.download.state === 'needs_browser' &&
            !failures.some((failure) => failure.state === 'needs_browser')
          failures.push({ url, state: job.download.state, message: job.download.message })
          if (firstChallenge) {
            batch.accessChallenges = (batch.accessChallenges ?? 0) + 1
            batch.delaySeconds = Math.min(60, Math.max(5, (batch.delaySeconds ?? 0) * 2))
            await rememberDownloadPacing(batch.sourceUrl, batch.delaySeconds)
          }
        } else completeBatchChapter(batch, canonical, job.download.cached)
      } catch (failure) {
        halted = true
        if (jobId && failure instanceof LocalRequestError && failure.status === 404)
          delete batch.jobs![requestedUrl]
        failures.push({
          url,
          state: 'paused',
          message:
            failure instanceof Error
              ? failure.message
              : 'The direct download stopped. Saved chapters are kept.',
        })
      }
      await publish()
    }
    if (approvedUrl) await download(approvedUrl, true)
    const entries = [
      ...new Set([
        ...Object.keys(batch.jobs),
        ...batch.urls.filter((url) => !batch.completedUrls?.includes(url)),
      ]),
    ]
    let cursor = 0
    const concurrency = Math.max(1, Math.min(3, batch.concurrency ?? 3))
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < entries.length && !halted && !downloadsPaused)
          await download(entries[cursor++])
      }),
    )
    const failure = failures.length
      ? failures.sort(
          (first, second) => batch.urls.indexOf(first.url) - batch.urls.indexOf(second.url),
        )[0]
      : undefined
    batch.state = failure?.state ?? (batch.next === batch.urls.length ? 'completed' : 'paused')
    batch.message =
      failure?.message ??
      (batch.state === 'completed' ? 'Downloads complete.' : 'Paused. Saved chapters are kept.')
  } catch (failure) {
    batch.state = 'paused'
    batch.message =
      failure instanceof Error
        ? failure.message
        : 'Direct downloads stopped. Saved chapters are kept.'
  }
  await publish()
}

async function runChapterBatch(batch: ChapterDownloadBatch, confirmed: boolean) {
  if (batch.transport === 'http') return runDirectChapterBatch(batch, confirmed)
  const publish = () => chrome.storage.session.set({ chapterBatch: { ...batch } })
  batch.timing ??= { browserMs: 0, browserPages: 0, processingMs: 0, processingJobs: 0 }
  const browser = browserNavigation(
    batch.tabId,
    new URL(batch.sourceUrl).origin,
    async () => downloadsPaused,
  )
  try {
    const cached: { urls: string[]; aliases?: unknown } = batch.jobId
      ? { urls: [] }
      : await api('library/downloaded', 'POST', {
          bookId: batch.bookId,
          sourceUrl: batch.sourceUrl,
        })
    canonicalizeBatch(batch, cached.aliases)
    await rememberChapterAliases(batch.sourceUrl, cached.aliases)
    const state = await stored()
    const choices =
      state.inspection?.contents?.chapters ?? state.inspection?.inspection.chapterLinks ?? []
    const storedUrls = new Set(cached.urls.map((url) => publicPageUrl(url)))
    while (batch.next < batch.urls.length) {
      if (downloadsPaused) break
      const url = batch.urls[batch.next]
      if (!batch.jobId && storedUrls.has(url)) {
        confirmed = false
        completeBatchChapter(batch, url, true)
        await publish()
        continue
      }
      batch.message = `Downloading chapter ${batch.from + batch.next}`
      await publish()
      if (!batch.jobId) {
        const navigationStarted = Date.now()
        await browser.open(url)
        const page = await browser.capture()
        batch.timing.browserMs += Date.now() - navigationStarted
        batch.timing.browserPages++
        if (downloadsPaused) break
        resolveChapterDestination(url, page.url, choices)
        const operation = await api('library/chapter/start', 'POST', {
          bookId: batch.bookId,
          sourceUrl: batch.sourceUrl,
          requestedUrl: url,
          page,
          confirmed,
        })
        confirmed = false
        batch.jobId = operation.id
        await publish()
      }
      let job: ExtensionJob
      const processingStarted = Date.now()
      const deadline = Date.now() + 240_000
      for (;;) {
        job = (await api(`jobs/${encodeURIComponent(batch.jobId!)}`)) as ExtensionJob
        if (job.state !== 'running') break
        if (Date.now() >= deadline)
          throw new Error(
            'This chapter is still processing. Resume to check its result; no new model request will be sent.',
          )
        await pauseDownload(1000)
      }
      const completedId = batch.jobId
      batch.timing.processingMs += Date.now() - processingStarted
      batch.timing.processingJobs++
      delete batch.jobId
      await api(`jobs/${encodeURIComponent(completedId!)}`, 'DELETE').catch(() => undefined)
      if (job.state === 'failed' || !job.download)
        throw new Error(job.error || 'Chapter extraction did not return a result.')
      const canonical = job.download.canonicalUrl ?? url
      if (canonical !== url) {
        resolveChapterDestination(url, canonical, choices)
        const alreadyProcessed = batch.completedUrls?.includes(canonical)
        canonicalizeBatch(batch, { [url]: canonical })
        await rememberChapterAliases(batch.sourceUrl, { [url]: canonical })
        if (alreadyProcessed && job.download.state === 'ready') {
          await publish()
          continue
        }
      }
      if (job.download.state !== 'ready') {
        batch.state = job.download.state
        batch.message = job.download.message
        await publish()
        return
      }
      completeBatchChapter(batch, canonical, job.download.cached)
      storedUrls.add(canonical)
      await publish()
      if (batch.next < batch.urls.length && !downloadsPaused) {
        const delaySeconds = batch.delaySeconds ?? 1
        batch.message = `Waiting ${delaySeconds}s before the next chapter`
        await publish()
        const until = Date.now() + delaySeconds * 1000
        while (Date.now() < until && !downloadsPaused)
          await pauseDownload(Math.min(250, until - Date.now()))
      }
    }
    batch.state = batch.next === batch.urls.length ? 'completed' : 'paused'
    batch.message =
      batch.state === 'completed' ? 'Downloads complete.' : 'Paused. Saved chapters are kept.'
  } catch (failure) {
    batch.state = 'paused'
    if (failure instanceof BrowserAccessError) {
      batch.state = 'needs_browser'
      batch.accessChallenges = (batch.accessChallenges ?? 0) + 1
      batch.delaySeconds = Math.min(60, Math.max(5, (batch.delaySeconds ?? 1) * 2))
      batch.message = `${failure.message} Pacing increased to ${batch.delaySeconds}s between chapters.`
      await rememberDownloadPacing(batch.sourceUrl, batch.delaySeconds)
    } else if (batch.jobId && failure instanceof LocalRequestError && failure.status === 404) {
      delete batch.jobId
      batch.message =
        'The local job is no longer available. Resume to check saved chapters first; no paid request was replayed.'
    } else
      batch.message = downloadsPaused
        ? 'Paused. Saved chapters are kept.'
        : failure instanceof Error
          ? failure.message
          : 'Downloads paused. Saved chapters are kept.'
  }
  await publish()
}

function launchChapterBatch(batch: ChapterDownloadBatch, confirmed = false) {
  if (downloadTask) throw new Error('A chapter batch is already running.')
  downloadsPaused = false
  batch.state = 'running'
  batch.message = 'Checking saved chapters'
  downloadTask = (async () => {
    await chrome.storage.session.set({ chapterBatch: batch })
    await runChapterBatch(batch, confirmed)
  })()
    .catch(async (failure) => {
      await chrome.storage.session.set({
        error: failure instanceof Error ? failure.message : 'The download batch stopped.',
      })
    })
    .finally(() => {
      downloadTask = undefined
    })
}

async function scanContents() {
  const state = await stored()
  if (!state.capture || !state.inspection)
    throw new Error('Identify a page before scanning its contents.')
  if (state.job?.state === 'running' || state.scanningContents || navigationTask)
    throw new Error('Wait for the current operation to finish.')
  const target = publicPageUrl(state.inspection.inspection.indexUrl || state.capture.page.url)
  if (new URL(target).origin !== new URL(state.capture.page.url).origin)
    throw new Error('Contents must belong to the same site.')
  contentsStopped = false
  await chrome.storage.session.remove(['contentsSaved', 'contentsSaveError', 'navigation'])
  await chrome.storage.session.set({
    scanningContents: true,
    contentsScan: { actions: 0, reason: 'Opening contents' },
  })
  try {
    const origin = new URL(target).origin
    const browser = browserNavigation(state.capture.tabId, origin, async () => contentsStopped)
    const recipeResult = await api('navigation/site', 'POST', { url: target }).catch(() => ({
      recipes: [],
    }))
    const savedRecipes = z.array(navigationRecipeSchema).parse(recipeResult.recipes)
    await browser.open(target)
    const result = await scanChapterContents(
      origin,
      state.inspection.inspection,
      { ...browser, stopped: async () => contentsStopped },
      async (contentsCapture, actions) => {
        const contents = discoverContents(contentsCapture, state.inspection!.inspection)
        await chrome.storage.session.set({
          contentsCapture,
          contentsScan: { actions, reason: 'Collecting chapter links' },
          inspection: { ...state.inspection!, contents },
        })
      },
      savedRecipes,
    )
    const contents = discoverContents(result.capture, state.inspection.inspection)
    await chrome.storage.session.set({
      contentsCapture: result.capture,
      contentsScan: { actions: result.actions, reason: result.reason },
      inspection: { ...state.inspection, contents },
    })
    if (!contentsStopped && contents.foundCount) await importScannedContents(result.capture)
    if (
      !contentsStopped &&
      !result.capture.truncated &&
      contents.foundCount &&
      result.recipes.length
    )
      await api('navigation/site', 'POST', { url: target, recipes: result.recipes }).catch(
        () => undefined,
      )
    else if (result.invalidated)
      await api('navigation/site', 'POST', { url: target, recipes: [] }).catch(() => undefined)
  } finally {
    await chrome.storage.session.set({ scanningContents: false })
  }
}

async function importScannedContents(contents: ContentsCapture) {
  contents = { ...contents, links: uniqueChapterLinks(contents.url, contents.links) }
  const state = await stored()
  if (state.savedSource) {
    await persistContents(contents)
    return
  }
  if (!state.inspection?.recordId)
    throw new Error('Analyze the page before saving its chapter list.')
  try {
    const saved = addedNovelSchema.parse(
      await api('library', 'POST', {
        recordId: state.inspection.recordId,
        title: state.inspection.inspection.title || state.capture?.pageTitle || 'Untitled novel',
        author: state.inspection.inspection.author || 'Unknown author',
        overwrite: false,
        contents,
        referenceVersions: [],
        novelUpdatesUrl: state.novelUpdatesUrl,
        confirmed: true,
      }),
    )
    await chrome.storage.session.set({
      addedNovel: {
        ...saved,
        title: state.inspection.inspection.title || '',
        author: state.inspection.inspection.author || '',
      },
      contentsSaved: {
        bookId: saved.bookId,
        saved: true,
        foundCount: discoverContents(contents, state.inspection.inspection).foundCount,
      },
      contentsSaveError: '',
    })
    await refreshLibraryAfterSave()
    if ((await stored()).savedSource) await persistContents(contents)
  } catch (failure) {
    await chrome.storage.session.set({
      contentsSaveError:
        failure instanceof Error ? failure.message : 'The chapter list could not be saved.',
    })
  }
}

async function restoreSavedSource() {
  const state = await stored()
  if (
    !state.capture ||
    !(await panelState()).connected ||
    state.job?.state === 'running' ||
    navigationTask
  )
    return
  const capturedAt = state.capture.capturedAt
  const url = state.capture.page.url
  const local = matchSavedSource([url], state.library ?? [])
  if (!local) {
    await chrome.storage.session.remove('savedSource')
    return
  }
  await chrome.storage.session.set({ savedSource: { book: local, url } })
  try {
    const context = (await api('library/source', 'POST', { url })) as {
      book: unknown
      inspection?: InspectionResult
    }
    const current = await stored()
    if (current.capture?.capturedAt !== capturedAt || current.capture.page.url !== url) return
    if (!context.book) {
      await chrome.storage.session.remove('savedSource')
      return
    }
    const book = libraryEntrySchema.parse(context.book)
    await chrome.storage.session.set({
      savedSource: { book, url },
      sourceLookupError: '',
      ...(book.sources.find(
        (source) => source.role === 'metadata' && isNovelUpdatesSeries(source.url),
      )
        ? {
            novelUpdatesUrl: book.sources.find(
              (source) => source.role === 'metadata' && isNovelUpdatesSeries(source.url),
            )!.url,
          }
        : {}),
      ...(!current.inspection && context.inspection ? { inspection: context.inspection } : {}),
    })
    await observeLinkedContents().catch(() => undefined)
  } catch {
    await chrome.storage.session.set({
      sourceLookupError:
        'This URL is in your library, but its saved page details could not be loaded. Refresh your library to retry.',
    })
  }
}

async function observeLinkedContents() {
  const state = await stored()
  if (
    !state.capture ||
    !state.savedSource ||
    !state.inspection ||
    state.inspection.contents?.foundCount ||
    state.scanningContents ||
    downloadTask ||
    navigationTask ||
    state.job?.state === 'running'
  )
    return
  if (state.savedSource.url !== state.capture.page.url) return
  const browser = browserNavigation(
    state.capture.tabId,
    new URL(state.capture.page.url).origin,
    async () => false,
  )
  const snapshot = await browser.observe()
  if (snapshot.blocked || snapshot.url !== publicPageUrl(state.capture.page.url)) return
  const contentsCapture = await browser.collect(snapshot)
  const contents = discoverContents(contentsCapture, {
    ...state.inspection.inspection,
    chapterLinks: [],
  })
  if (!contents.foundCount) return
  const current = await stored()
  if (
    current.capture?.capturedAt !== state.capture.capturedAt ||
    current.savedSource?.url !== state.savedSource.url ||
    current.scanningContents ||
    downloadTask ||
    navigationTask ||
    current.job?.state === 'running'
  )
    return
  await chrome.storage.session.set({
    contentsCapture,
    inspection: { ...current.inspection!, contents },
  })
}

async function ensureDownloadContents() {
  await observeLinkedContents()
  const state = await stored()
  if (!state.savedSource || !state.capture || state.savedSource.url !== state.capture.page.url)
    throw new Error('Pair this reading source before downloading.')
  if (state.contentsCapture) {
    await persistContents(state.contentsCapture)
    const saved = await stored()
    if (saved.contentsSaveError) throw new Error(saved.contentsSaveError)
    if (!saved.contentsSaved)
      throw new Error('No chapter links were saved. Scan & save chapters before downloading.')
  } else if (!state.inspection?.contents?.foundCount) {
    throw new Error(
      'The source has not saved its chapter list yet. Use Scan & save chapters before downloading.',
    )
  }
}

async function persistContents(contents: ContentsCapture) {
  contents = { ...contents, links: uniqueChapterLinks(contents.url, contents.links) }
  const state = await stored()
  if (!state.savedSource || !state.capture || state.savedSource.url !== state.capture.page.url)
    return
  if (
    !discoverContents(contents, { chapterLinks: [], chapterCount: null, indexUrl: null }).foundCount
  )
    return
  try {
    const saved = await api('library/contents', 'POST', {
      bookId: state.savedSource.book.id,
      sourceUrl: state.savedSource.url,
      contents,
    })
    await chrome.storage.session.set({
      contentsSaved: { ...saved, bookId: state.savedSource.book.id },
      contentsSaveError: '',
    })
  } catch (failure) {
    await chrome.storage.session.set({
      contentsSaveError:
        failure instanceof Error
          ? failure.message
          : 'Contents could not be saved. Your captured links are retained.',
    })
  }
}

async function refreshLibrary() {
  const result = z.object({ books: z.array(libraryEntrySchema) }).parse(await api('library'))
  await chrome.storage.session.set({ library: result.books, libraryError: '' })
  await restoreSavedSource()
}

async function refreshLibraryAfterSave() {
  await refreshLibrary().catch(() =>
    chrome.storage.session.set({
      libraryError: 'The library list could not be refreshed. The completed save is retained.',
    }),
  )
}

async function finishConnection(nonce?: string, error = '') {
  const attempt = (await stored()).connectionAttempt
  if (nonce && attempt?.nonce !== nonce) return
  clearTimeout(connectionTimeout)
  connectionTimeout = undefined
  await chrome.storage.session.remove('connectionAttempt')
  await chrome.storage.session.set({ connecting: false, connectionError: error })
  if (attempt?.tabId) await chrome.tabs.remove(attempt.tabId).catch(() => undefined)
  if (error) retryConnectionAt = Date.now() + 30_000
}

async function beginConnection() {
  if (connectionTask) return connectionTask
  connectionTask = (async () => {
    const previous = (await stored()).connectionAttempt
    if (previous && previous.expiresAt > Date.now()) return
    if (previous) await finishConnection(previous.nonce)
    await chrome.storage.session.set({ connecting: true, connectionError: '' })
    try {
      const available = await api('ready', 'GET', undefined, false)
      if (available.app !== 'novelist' || available.protocol !== 1)
        throw new Error('This address is not a compatible local Novelist backend.')
      const attempt = {
        nonce: crypto.randomUUID(),
        origin: await origin(),
        expiresAt: Date.now() + 20_000,
      }
      await chrome.storage.session.set({ connectionAttempt: attempt })
      const tab = await chrome.tabs.create({
        url: `${attempt.origin}/extension/connect?extensionId=${chrome.runtime.id}&nonce=${attempt.nonce}`,
        active: false,
      })
      if (!tab.id) throw new Error('The local library connection tab could not be opened.')
      const current = (await stored()).connectionAttempt
      if (current?.nonce !== attempt.nonce) {
        await chrome.tabs.remove(tab.id).catch(() => undefined)
        return
      }
      await chrome.storage.session.set({ connectionAttempt: { ...current, tabId: tab.id } })
      connectionTimeout = setTimeout(
        () => {
          void finishConnection(
            attempt.nonce,
            'The local library did not connect. Check that Novelist and Supabase are running.',
          ).catch(() => undefined)
        },
        Math.max(0, attempt.expiresAt - Date.now()),
      )
    } catch (failure) {
      await finishConnection(
        undefined,
        failure instanceof Error ? failure.message : 'The automatic connection failed.',
      )
    }
  })().finally(() => {
    connectionTask = undefined
  })
  return connectionTask
}

async function syncStatus() {
  const state = await stored()
  if (state.chapterBatch?.state === 'running' && !downloadTask)
    await chrome.storage.session.set({
      chapterBatch: {
        ...state.chapterBatch,
        state: 'paused',
        message: 'The extension restarted. Resume to continue from the saved checkpoint.',
      },
    })
  if (state.connectionAttempt && state.connectionAttempt.expiresAt <= Date.now())
    await finishConnection(state.connectionAttempt.nonce)
  else if (state.connecting && !state.connectionAttempt && !connectionTask)
    await chrome.storage.session.set({ connecting: false })
  if (state.navigation?.state === 'running' && !navigationTask)
    await chrome.storage.session.set({
      navigation: {
        ...state.navigation,
        state: 'stopped',
        stage: 'Exploration stopped',
        reason:
          'The extension restarted. Completed captures are kept; start a new exploration to continue.',
      },
    })
  const automatic = (await chrome.storage.local.get('autoConnectPaused')).autoConnectPaused !== true
  if (!state.connection || state.connection.expiresAt <= Date.now()) {
    if (automatic && Date.now() >= retryConnectionAt) await beginConnection()
    return
  }
  let status: { liveEnabled: boolean; model?: string; identificationModel?: string }
  try {
    status = await api('status')
  } catch (failure) {
    if (automatic && !(await stored()).connection && Date.now() >= retryConnectionAt)
      await beginConnection()
    else
      await chrome.storage.session.set({
        connectionError:
          failure instanceof Error ? failure.message : 'The local backend is unavailable.',
      })
    return
  }
  await chrome.storage.session.set({
    liveEnabled: status.liveEnabled === true,
    model: status.model,
    identificationModel: status.identificationModel,
    connectionError: '',
  })
  if (
    automatic &&
    state.connection.expiresAt - Date.now() < 5 * 60_000 &&
    state.job?.state !== 'running' &&
    !downloadTask &&
    !navigationTask &&
    Date.now() >= retryConnectionAt
  ) {
    await beginConnection()
    return
  }
  if (!state.library)
    await refreshLibrary().catch(() =>
      chrome.storage.session.set({
        libraryError: 'The library list could not be loaded. Refresh to retry.',
      }),
    )
}

async function handlePanel(value: unknown) {
  const message = panelMessageSchema.parse(value)
  if (message.type === 'state') return panelState()
  if (downloadTask && !['sync', 'poll', 'show-tab', 'pause-downloads'].includes(message.type))
    throw new Error('Pause chapter downloads before starting another operation.')
  if (
    (await stored()).scanningContents &&
    !['sync', 'poll', 'show-tab', 'stop-contents'].includes(message.type)
  )
    throw new Error('Stop the contents scan before starting another operation.')
  if (navigationTask && !['sync', 'poll', 'show-tab', 'stop-navigation'].includes(message.type))
    throw new Error('Stop browser exploration before starting another page operation.')
  await chrome.storage.session.set({ error: '' })
  switch (message.type) {
    case 'link-novelupdates': {
      if (!isNovelUpdatesSeries(message.url)) throw new Error('Use a Novel Updates series URL.')
      const state = await stored()
      const bookId = message.bookId ?? state.savedSource?.book.id ?? state.addedNovel?.bookId
      if (bookId) {
        await api('library/catalog', 'POST', { bookId, url: message.url })
        await refreshLibraryAfterSave()
      }
      await chrome.storage.session.set({ novelUpdatesUrl: message.url })
      break
    }
    case 'set-download-transport': {
      const state = await stored()
      if (!state.capture) throw new Error('Capture a source first.')
      if (state.job?.state === 'running' || hasChapterJobs(state.chapterBatch))
        throw new Error('Wait for the current chapter job before switching download method.')
      await rememberDownloadMethod(state.capture.page.url, message.transport)
      if (state.chapterBatch && state.chapterBatch.sourceUrl === state.savedSource?.url) {
        await chrome.storage.session.set({
          chapterBatch: {
            ...state.chapterBatch,
            transport: message.transport,
            delaySeconds: Math.max(
              message.transport === 'http' ? 0 : 1,
              state.chapterBatch.delaySeconds ?? 0,
            ),
          },
        })
      }
      break
    }
    case 'pause-downloads':
      downloadsPaused = true
      break
    case 'download-chapters': {
      await ensureDownloadContents()
      const state = await stored()
      if (
        !state.capture ||
        !state.inspection ||
        !state.savedSource ||
        state.savedSource.url !== state.capture.page.url
      )
        throw new Error('Scan and save, or pair this source before downloading.')
      if (state.job?.state === 'running' || state.capturing)
        throw new Error('Wait for the current operation to finish.')
      if (hasChapterJobs(state.chapterBatch))
        throw new Error('Resume the pending chapter job before starting a new batch.')
      if (message.mode === 'range' && (message.from === undefined || message.to === undefined))
        throw new Error('Choose a download range.')
      const choices = selectChapterDownloads(
        state.capture.page.url,
        state.inspection.contents?.chapters ?? state.inspection.inspection.chapterLinks,
        message.mode === 'range' ? message.from : 1,
        message.mode === 'range' ? message.to : undefined,
      )
      if (choices.length > CONTENTS_LINK_LIMIT)
        throw new Error('The chapter list exceeds the download queue limit.')
      const pacing = await panelState()
      const delaySeconds = Math.max(
        pacing.downloadTransport === 'http' ? 0 : 1,
        message.delaySeconds ?? pacing.downloadDelaySeconds ?? 0,
      )
      await rememberDownloadPacing(state.savedSource.url, delaySeconds)
      launchChapterBatch({
        id: crypto.randomUUID(),
        bookId: state.savedSource.book.id,
        sourceUrl: state.savedSource.url,
        backendOrigin: await origin(),
        tabId: state.capture.tabId,
        capturedAt: state.capture.capturedAt,
        urls: choices.map((chapter) => chapter.url),
        from: message.mode === 'range' ? message.from! : 1,
        next: 0,
        saved: 0,
        skipped: 0,
        state: 'running',
        message: '',
        delaySeconds,
        concurrency: message.concurrency ?? 3,
        transport: pacing.downloadTransport ?? 'browser',
      })
      break
    }
    case 'resume-downloads': {
      const state = await stored()
      const batch = state.chapterBatch
      if (!batch || batch.state === 'completed')
        throw new Error('No paused download batch is available.')
      if (
        batch.backendOrigin !== (await origin()) ||
        batch.bookId !== state.savedSource?.book.id ||
        batch.sourceUrl !== state.savedSource.url ||
        batch.capturedAt !== state.capture?.capturedAt ||
        batch.tabId !== state.capture.tabId
      )
        throw new Error(
          'This batch belongs to a different source or library. Start a new batch from the selected source.',
        )
      if (state.job?.state === 'running' || state.capturing)
        throw new Error('Wait for the current operation to finish.')
      if (message.confirmed && batch.state !== 'needs_scraper')
        throw new Error('No chapter is waiting for model confirmation.')
      if (message.delaySeconds !== undefined) {
        batch.delaySeconds = Math.max(batch.transport === 'http' ? 0 : 1, message.delaySeconds)
        await rememberDownloadPacing(batch.sourceUrl, batch.delaySeconds)
      }
      if (message.concurrency !== undefined) batch.concurrency = message.concurrency
      launchChapterBatch(batch, message.confirmed)
      break
    }
    case 'stop-contents':
      contentsStopped = true
      break
    case 'download-chapter':
    case 'test-chapter': {
      if (message.type === 'download-chapter') await ensureDownloadContents()
      const state = await stored()
      if (!state.capture || !state.inspection) throw new Error('Scan the chapter list first.')
      if (message.type === 'download-chapter' && !state.savedSource)
        throw new Error('Scan and save, or pair this source before downloading.')
      if (state.job?.state === 'running' || navigationTask)
        throw new Error('Wait for the current operation to finish.')
      const url = publicPageUrl(message.url)
      const choices = uniqueChapterLinks(
        state.capture.page.url,
        state.inspection.contents?.chapters ?? state.inspection.inspection.chapterLinks,
      )
      if (!choices.some((chapter) => chapter.url === url))
        throw new Error('Select a chapter from the discovered list.')
      if (
        message.type === 'download-chapter' &&
        (await panelState()).downloadTransport === 'http'
      ) {
        const result = await api('library/chapter/start', 'POST', {
          bookId: state.savedSource!.book.id,
          sourceUrl: state.savedSource!.url,
          requestedUrl: url,
          confirmed: message.confirmed,
        })
        await chrome.storage.session.set({
          singleDownload: { jobId: result.id, sourceUrl: state.savedSource!.url, url },
          job: {
            id: result.id,
            operation: 'download',
            state: 'running',
            stage: 'Fetching and saving chapter directly',
          } satisfies ExtensionJob,
        })
        break
      }
      if (message.type === 'test-chapter' && message.transport === 'http') {
        const result = await api('test', 'POST', {
          page: state.capture.page,
          contents: state.contentsCapture,
          sampleUrls: [url],
          expectedKind: 'chapter',
          fetchOnly: true,
          forceRegenerate: message.forceRegenerate,
          rightsConfirmed: true,
          sendToModelConfirmed: true,
        })
        await chrome.storage.session.set({
          directTest: { jobId: result.id, sourceUrl: state.capture.page.url },
          job: {
            id: result.id,
            operation: 'test',
            state: 'running',
            stage: 'Fetching selected chapter URL',
          } satisfies ExtensionJob,
        })
        break
      }
      contentsStopped = false
      const browser = browserNavigation(
        state.capture.tabId,
        new URL(state.capture.page.url).origin,
        async () => contentsStopped,
      )
      await chrome.storage.session.set({
        scanningContents: true,
        contentsScan: { actions: 0, reason: 'Opening selected chapter' },
      })
      try {
        await browser.open(url)
        const page = await browser.capture()
        if (contentsStopped) throw new Error('Chapter test cancelled before sending to OpenAI.')
        resolveChapterDestination(url, page.url, choices)
        if (message.type === 'download-chapter') {
          const result = await api('library/chapter', 'POST', {
            bookId: state.savedSource!.book.id,
            sourceUrl: state.savedSource!.url,
            requestedUrl: url,
            page,
            confirmed: message.confirmed,
          })
          await chrome.storage.session.set({ chapterDownload: { url, ...result } })
          if (result.canonicalUrl && result.canonicalUrl !== url)
            await rememberChapterAliases(state.savedSource!.url, { [url]: result.canonicalUrl })
        } else {
          const result = await api('test', 'POST', {
            page,
            sampleUrls: [],
            rightsConfirmed: true,
            sendToModelConfirmed: true,
            expectedKind: 'chapter',
            forceRegenerate: message.forceRegenerate,
          })
          await chrome.storage.session.set({
            job: {
              id: result.id,
              operation: 'test',
              state: 'running',
              stage: 'Testing selected chapter',
            } satisfies ExtensionJob,
          })
        }
      } finally {
        await chrome.storage.session.set({ scanningContents: false })
      }
      break
    }
    case 'keep-metadata-reference': {
      const capture = (await stored()).capture
      if (!capture) throw new Error('Capture the complete Novel Updates series page first.')
      const metadataReference = metadataReferenceSchema.parse({
        page: capture.page,
        title: capture.pageTitle,
      })
      await chrome.storage.session.remove('estimate')
      await chrome.storage.session.set({ metadataReference, useMetadataReference: false })
      break
    }
    case 'remove-metadata-reference':
      await chrome.storage.session.remove(['metadataReference', 'useMetadataReference', 'estimate'])
      break
    case 'use-metadata-reference': {
      const state = await stored()
      if (
        message.enabled &&
        (!state.metadataReference || state.metadataReference.page.url === state.capture?.page.url)
      )
        throw new Error(
          'Select a separate primary source page before including this metadata reference.',
        )
      await chrome.storage.session.remove('estimate')
      await chrome.storage.session.set({ useMetadataReference: message.enabled })
      break
    }
    case 'library':
      await refreshLibrary()
      break
    case 'save-contents': {
      const state = await stored()
      if (state.job?.state === 'running' || state.scanningContents)
        throw new Error('Wait for the current page operation to finish.')
      if (state.contentsCapture) await importScannedContents(state.contentsCapture)
      break
    }
    case 'pair-book': {
      const state = await stored()
      if (state.job?.state === 'running' || state.scanningContents)
        throw new Error('Wait for the current page operation to finish.')
      if (message.recordId !== state.inspection?.recordId)
        throw new Error(
          'The captured identification changed. Review this page again before pairing.',
        )
      const pairedSource = pairedLibrarySourceSchema.parse(
        await api('library/pair', 'POST', {
          bookId: message.bookId,
          recordId: message.recordId,
          label: message.label,
          language: message.language,
          role: message.role,
          confirmed: true,
        }),
      )
      await chrome.storage.session.remove('addedNovel')
      await chrome.storage.session.set({ pairedSource })
      await refreshLibraryAfterSave()
      const current = await stored()
      if (current.contentsCapture) await persistContents(current.contentsCapture)
      break
    }
    case 'match-library': {
      const state = await stored()
      if (state.job?.state === 'running' || state.scanningContents)
        throw new Error('Wait for the current page operation to finish.')
      if (message.recordId !== state.inspection?.recordId)
        throw new Error('Analyze the current page before comparing editions.')
      const result = await api('library/matches', 'POST', {
        recordId: message.recordId,
        model: message.model,
        confirmed: true,
      })
      await chrome.storage.session.remove('libraryMatches')
      await chrome.storage.session.set({
        job: {
          id: result.id,
          operation: 'match',
          state: 'running',
          stage: 'Comparing possible editions',
        } satisfies ExtensionJob,
      })
      break
    }
    case 'show-tab': {
      const capture = (await stored()).capture
      if (!capture) throw new Error('Capture a book page first.')
      try {
        const tab = await chrome.tabs.update(capture.tabId, { active: true })
        if (tab) await chrome.windows.update(tab.windowId, { focused: true })
      } catch {
        throw new Error(
          'The captured tab is closed. Open the book and click the Novelist toolbar icon again.',
        )
      }
      break
    }
    case 'navigate': {
      const state = await stored()
      if (!state.capture) throw new Error('Use this tab to capture a book page first.')
      if (state.job?.state === 'running' || navigationTask || state.scanningContents)
        throw new Error('Wait for the current operation to finish.')
      const captured = state.capture
      const allowedOrigin = new URL(captured.page.url).origin
      const tab = await chrome.tabs.get(captured.tabId)
      if (!tab.url || new URL(tab.url).origin !== allowedOrigin)
        throw new Error(
          'The captured tab changed sites. Select the novel and click the Novelist toolbar icon again.',
        )
      const session = await api('navigation/start', 'POST', {
        url: tab.url,
        goal: message.goal,
        model: message.model,
        confirmed: true,
      })
      navigationStopped = false
      const stopped = async () => navigationStopped
      await chrome.storage.session.set({
        contentsSaveError: '',
        navigation: {
          id: session.id,
          sourceUrl: captured.page.url,
          pageTitle: state.inspection?.inspection.title || captured.pageTitle,
          model: session.model,
          goal: message.goal,
          state: 'running',
          stage: 'Observing the page',
          actions: 0,
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          pages: [],
          activity: [],
        },
      })
      const browser = browserNavigation(captured.tabId, allowedOrigin, stopped)
      navigationTask = exploreBrowser(session.id, message.goal, allowedOrigin, {
        ...browser,
        stopped,
        decide: async (snapshot, history) => {
          const started = await api('navigation/plan', 'POST', {
            runId: session.id,
            snapshot,
            history: history.map(({ action, outcome }) => ({ action, outcome })),
          })
          const deadline = Date.now() + 60_000
          while (Date.now() < deadline) {
            if (navigationStopped) throw new Error('Navigation stopped.')
            const job = (await api(`jobs/${encodeURIComponent(started.id)}`)) as ExtensionJob
            if (job.state === 'failed') throw new Error(job.error || 'Navigation planning failed.')
            if (job.state === 'completed' && job.navigation)
              return job.navigation as NavigationPlanResult
            await new Promise<void>((resolve) => setTimeout(resolve, 750))
          }
          throw new Error('The navigation model timed out. No further action was taken.')
        },
        progress: async (navigation, inventory) => {
          const current = await stored()
          const discovery =
            inventory && current.inspection
              ? discoverContents(inventory, current.inspection.inspection)
              : null
          await chrome.storage.session.set({
            navigation: {
              ...navigation,
              sourceUrl: captured.page.url,
              pageTitle: state.inspection?.inspection.title || captured.pageTitle,
              model: session.model,
            },
            ...(inventory ? { contentsCapture: inventory } : {}),
            ...(discovery ? { inspection: { ...current.inspection!, contents: discovery } } : {}),
          })
          if (
            message.goal === 'contents' &&
            navigation.state !== 'running' &&
            inventory &&
            navigation.state !== 'failed'
          )
            await persistContents(inventory)
        },
      })
        .catch(async (failure: unknown) => {
          const current = (await stored()).navigation
          if (current)
            await chrome.storage.session.set({
              navigation: {
                ...current,
                state: 'failed',
                stage: 'Exploration stopped',
                reason:
                  failure instanceof Error ? failure.message : 'The navigation could not finish.',
              },
            })
        })
        .finally(() => {
          navigationTask = undefined
          void api(`navigation/${session.id}`, 'DELETE').catch(() => undefined)
        })
      break
    }
    case 'stop-navigation':
      navigationStopped = true
      break
    case 'pair-version': {
      const versions = (await stored()).referenceVersions ?? []
      const referenceVersions = [
        ...versions.filter(
          (source) =>
            source.url !== message.source.url || source.language !== message.source.language,
        ),
        message.source,
      ]
      if (referenceVersions.length > 5) throw new Error('Pair up to five translated versions.')
      await chrome.storage.session.remove('estimate')
      await chrome.storage.session.set({ referenceVersions })
      break
    }
    case 'remove-version': {
      const versions = (await stored()).referenceVersions ?? []
      await chrome.storage.session.remove('estimate')
      await chrome.storage.session.set({
        referenceVersions: versions.filter((_, index) => index !== message.index),
      })
      break
    }
    case 'add-book': {
      const state = await stored()
      if (!state.inspection?.recordId)
        throw new Error('Analyze and save an identification before adding the novel.')
      const saved = addedNovelSchema.parse(
        await api('library', 'POST', {
          recordId: state.inspection.recordId,
          title: message.title,
          author: message.author,
          overwrite: message.overwrite,
          confirmed: true,
          referenceVersions: [],
          novelUpdatesUrl: state.novelUpdatesUrl,
          contents: state.contentsCapture
            ? {
                ...state.contentsCapture,
                links: uniqueChapterLinks(state.contentsCapture.url, state.contentsCapture.links),
              }
            : undefined,
        }),
      )
      await chrome.storage.session.set({
        addedNovel: { ...saved, title: message.title, author: message.author },
      })
      await refreshLibraryAfterSave()
      break
    }
    case 'save-model-default':
      if (message.model) await chrome.storage.local.set({ analysisModel: message.model })
      else await chrome.storage.local.remove('analysisModel')
      break
    case 'connect': {
      const backendOrigin = localAppOrigin(message.origin)
      await finishConnection()
      await chrome.storage.local.set({ backendOrigin, autoConnectPaused: false })
      retryConnectionAt = 0
      await chrome.storage.session.remove([
        'connection',
        'library',
        'libraryError',
        'libraryMatches',
        'pairedSource',
        'inspection',
        'job',
        'addedNovel',
        'estimate',
        'savedSource',
        'sourceLookupError',
        'contentsSaved',
        'contentsSaveError',
        'chapterBatch',
      ])
      await beginConnection()
      break
    }
    case 'disconnect':
      navigationStopped = true
      await chrome.storage.local.set({ autoConnectPaused: true })
      await finishConnection()
      try {
        await api('connection', 'DELETE')
      } finally {
        await chrome.storage.session.remove([
          'connection',
          'job',
          'liveEnabled',
          'model',
          'library',
          'libraryError',
          'libraryMatches',
          'pairedSource',
          'inspection',
          'addedNovel',
          'savedSource',
          'sourceLookupError',
          'contentsSaved',
          'contentsSaveError',
          'chapterBatch',
        ])
      }
      break
    case 'sync':
      await syncStatus()
      if (
        message.refreshLibrary &&
        (await panelState()).connected &&
        (await stored()).job?.state !== 'running' &&
        !downloadTask &&
        !navigationTask
      )
        await refreshLibrary()
      break
    case 'capture': {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (!tab) throw new Error('No active page is available.')
      await captureTab(tab)
      break
    }
    case 'contents':
      await scanContents()
      break
    case 'inspect':
    case 'test': {
      const state = await stored()
      if (!state.capture) throw new Error('Capture a page first.')
      if (state.job?.state === 'running' || navigationTask)
        throw new Error('A page operation is already running.')
      const operation = message.type
      if (operation === 'inspect')
        await chrome.storage.session.remove(['libraryMatches', 'pairedSource'])
      const browserPages =
        operation === 'test' && message.useBrowserSamples ? (state.navigation?.pages ?? []) : []
      if (operation === 'test' && message.useBrowserSamples && !browserPages.length)
        throw new Error('Capture reading samples with browser exploration first.')
      const result = await api(operation, 'POST', {
        page: browserPages[0] ?? state.capture.page,
        sendToModelConfirmed: true,
        ...(operation === 'test'
          ? {
              rightsConfirmed: true,
              sampleUrls: browserPages.length ? [] : message.sampleUrls,
              browserPages: browserPages.length ? browserPages.slice(1) : undefined,
              contents: browserPages.length ? undefined : state.contentsCapture,
            }
          : {
              outputLanguage: message.outputLanguage,
              model: message.model,
              referenceVersions: state.referenceVersions ?? [],
              metadataReference: state.useMetadataReference ? state.metadataReference : undefined,
            }),
      })
      await chrome.storage.session.set({
        job: {
          id: result.id,
          operation,
          state: 'running',
          stage: operation === 'inspect' ? 'Identifying the page' : 'Checking selected links',
        } satisfies ExtensionJob,
      })
      break
    }
    case 'estimate': {
      const state = await stored()
      const capture = state.capture
      if (!capture) throw new Error('Capture a page first.')
      const cost = await api('estimate', 'POST', {
        page: capture.page,
        outputLanguage: message.outputLanguage,
        model: message.model,
        referenceVersions: (await stored()).referenceVersions ?? [],
        metadataReference: state.useMetadataReference ? state.metadataReference : undefined,
      })
      await chrome.storage.session.set({
        estimate: { cost, outputLanguage: message.outputLanguage, capturedAt: capture.capturedAt },
      })
      break
    }
    case 'poll': {
      const state = await stored()
      const job = state.job
      if (job?.state !== 'running') break
      const result = (await api(`jobs/${encodeURIComponent(job.id)}`)) as ExtensionJob
      if (result.state !== 'running' && state.directTest?.jobId === result.id) {
        if (result.state === 'completed' && result.scrape?.report.status === 'needs_review')
          await rememberDownloadMethod(state.directTest.sourceUrl, 'http')
        await chrome.storage.session.remove('directTest')
      }
      if (result.state !== 'running' && state.singleDownload?.jobId === result.id) {
        if (result.download && state.savedSource?.url === state.singleDownload.sourceUrl) {
          await chrome.storage.session.set({
            chapterDownload: { url: state.singleDownload.url, ...result.download },
          })
          if (
            result.download.canonicalUrl &&
            result.download.canonicalUrl !== state.singleDownload.url
          )
            await rememberChapterAliases(state.singleDownload.sourceUrl, {
              [state.singleDownload.url]: result.download.canonicalUrl,
            })
        }
        await chrome.storage.session.remove('singleDownload')
        await api(`jobs/${encodeURIComponent(result.id)}`, 'DELETE').catch(() => undefined)
      }
      await chrome.storage.session.set({
        job: result,
        ...(result.inspection ? { inspection: result.inspection } : {}),
        ...(result.matches ? { libraryMatches: result.matches } : {}),
      })
      break
    }
  }
  return panelState()
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')))
    return false
  void handlePanel(message)
    .then((state) => respond({ ok: true, state }))
    .catch(async (failure: unknown) => {
      const error = failure instanceof Error ? failure.message : 'The extension action failed.'
      const job = (await stored()).job
      if (message?.type === 'poll' && job?.state === 'running')
        await chrome.storage.session.set({
          job: { ...job, state: 'failed', stage: 'Connection interrupted', error },
        })
      await chrome.storage.session.set({ error })
      respond({ ok: false, error })
    })
  return true
})

chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  void (async () => {
    const expectedOrigin = await origin()
    const senderUrl = new URL(sender.url || '')
    if (
      senderUrl.origin !== expectedOrigin ||
      senderUrl.pathname !== '/extension/connect' ||
      sender.frameId !== 0
    )
      throw new Error('Connections must come from the local Novelist connection page.')
    const input = extensionConnectMessageSchema.parse(message)
    const attempt = (await stored()).connectionAttempt
    if (
      !attempt ||
      attempt.nonce !== input.nonce ||
      attempt.origin !== expectedOrigin ||
      attempt.expiresAt <= Date.now() ||
      !sender.tab?.id ||
      (attempt.tabId !== undefined && attempt.tabId !== sender.tab.id)
    )
      throw new Error('This connection attempt is not pending. Open the Novelist extension again.')
    if (attempt.tabId === undefined)
      await chrome.storage.session.set({ connectionAttempt: { ...attempt, tabId: sender.tab.id } })
    if (input.type === 'novelist-connect-ready') {
      respond({ ok: true })
      return
    }
    const connection = (await api(
      'connect',
      'POST',
      { code: input.code },
      false,
    )) as ExtensionConnection
    if ((await stored()).connectionAttempt?.nonce !== input.nonce)
      throw new Error('This connection attempt was cancelled.')
    await chrome.storage.session.set({
      connection,
      connecting: false,
      error: '',
      connectionError: '',
    })
    respond({ ok: true })
    await finishConnection(input.nonce)
    await chrome.storage.session.remove(['library', 'libraryError'])
    await syncStatus()
  })().catch((failure: unknown) =>
    respond({
      ok: false,
      error: failure instanceof Error ? failure.message : 'The automatic connection failed.',
    }),
  )
  return true
})

chrome.action.onClicked.addListener((tab) => {
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() =>
    chrome.storage.session.set({
      error: 'The side panel could not be opened. Click the Novelist toolbar icon again.',
    }),
  )
  void captureTab(tab).catch((failure: unknown) =>
    chrome.storage.session.set({
      error: failure instanceof Error ? failure.message : 'This page cannot be captured.',
    }),
  )
})

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
})
