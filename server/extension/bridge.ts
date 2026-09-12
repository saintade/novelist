import { randomUUID } from 'node:crypto'
import { load } from 'cheerio'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { z, ZodError } from 'zod'
import {
  extensionIdSchema,
  estimatePageRequestSchema,
  inspectPageRequestSchema,
  testScrapeRequestSchema,
  type ExtensionJob,
} from '../../src/lib/extension/contracts.ts'
import { MAX_TOTAL_CAPTURE_CHARACTERS, publicPageUrl } from '../../src/lib/scraper/contracts.ts'
import { acquireAILibrary, ExperimentError, type AIConfiguration } from '../ai/experiments.ts'
import { runScraperTool } from '../scraper/tool.ts'
import { isAccessChallenge } from '../../src/lib/extension/navigation.ts'
import { prepareCapturedPage } from '../scraper/validate.ts'
import { inspectNovelPage, estimateIdentification } from './inspect.ts'
import { IDENTIFICATION_MODEL } from '../../src/lib/ai/pricing.ts'
import { ExtensionPairing, type PairedLibrary } from './pairing.ts'
import { approvedSampleUrl, fetchChapterSample } from './sample.ts'
import {
  addIdentifiedNovel,
  attachNovelUpdates,
  connectedLibrary,
  pairIdentifiedEdition,
  savedSourceContext,
  saveSourceContents,
  saveRenderedSourceChapter,
  downloadedSourceUrls,
} from './library.ts'
import { NavigationSessions, planNavigation, siteNavigation } from './navigation.ts'
import { navigationPlanSchema } from '../../src/lib/extension/navigation.ts'
import { libraryMatchRequestSchema } from '../../src/lib/extension/library-catalog.ts'
import { compareLibrary } from './library-match.ts'
import { isNovelUpdatesSeries } from '../../src/lib/extension/metadata.ts'

async function readBody(request: IncomingMessage, maximumBytes = 1_000_000): Promise<unknown> {
  const parts: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > maximumBytes) throw new ExperimentError('The captured page is too large.', 413)
    parts.push(buffer)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

export function extensionBridgeMiddleware(configuration: AIConfiguration) {
  const pairing = new ExtensionPairing()
  const navigationSessions = new NavigationSessions()
  const jobs = new Map<string, { connectionId: string; expiresAt: number; job: ExtensionJob }>()
  let samplingQueue: Promise<unknown> = Promise.resolve()
  let lastSampleStarted = 0

  const startJob = (
    connection: PairedLibrary,
    operation: ExtensionJob['operation'],
    payload: unknown,
  ) => {
    for (const [key, value] of jobs)
      if (value.expiresAt < Date.now() && value.job.state !== 'running') jobs.delete(key)
    const running = [...jobs.values()].filter((value) => value.job.state === 'running')
    if (running.some((value) => value.connectionId === connection.connectionId))
      throw new ExperimentError('A page operation is already running.', 409)
    if (running.length >= 2 || jobs.size >= 100)
      throw new ExperimentError('The local extension queue is busy. Try again shortly.', 429)
    const job: ExtensionJob = {
      id: randomUUID(),
      operation,
      state: 'running',
      stage:
        operation === 'inspect'
          ? 'Identifying the page'
          : operation === 'match'
            ? 'Comparing possible editions'
            : 'Checking selected links',
    }
    jobs.set(job.id, {
      connectionId: connection.connectionId,
      expiresAt: Date.now() + 10 * 60_000,
      job,
    })
    const execute = async () => {
      if (operation === 'inspect') {
        job.inspection = await inspectNovelPage(connection.libraryToken, payload, configuration)
      } else if (operation === 'match') {
        job.matches = await compareLibrary(connection.libraryToken, payload, configuration)
      } else if (operation === 'download') {
        job.stage = 'Extracting and saving chapter'
        job.download = await saveRenderedSourceChapter(
          connection.libraryToken,
          payload,
          configuration,
        )
      } else if (operation === 'navigate') {
        const input = navigationPlanSchema.parse(payload)
        const session = navigationSessions.take(
          connection.connectionId,
          input.runId,
          input.snapshot,
        )
        try {
          job.navigation = await planNavigation(
            connection.libraryToken,
            input.snapshot,
            { goal: session.goal, history: input.history },
            configuration,
            session.model,
          )
        } finally {
          session.release()
        }
      } else {
        const input = testScrapeRequestSchema.parse(payload)
        if (
          input.fetchOnly &&
          (input.sampleUrls.length !== 1 ||
            input.browserPages?.length ||
            input.expectedKind !== 'chapter')
        )
          throw new ExperimentError(
            'A direct test requires exactly one observed chapter URL and no browser samples.',
          )
        if (
          [input.page, ...(input.browserPages ?? [])].some((page) => isNovelUpdatesSeries(page.url))
        )
          throw new ExperimentError(
            'Novel Updates is a metadata catalog. Open the original or translation site before testing chapter extraction.',
          )
        const page = prepareCapturedPage(input.page)
        let navigationPage = page
        if (input.contents) {
          if (new URL(publicPageUrl(input.contents.url)).origin !== new URL(page.url).origin)
            throw new ExperimentError('Contents must belong to the captured site.')
          const navigation = load('<nav></nav>')
          for (const link of input.contents.links)
            navigation('nav').append(navigation('<a></a>').attr('href', link.url).text(link.title))
          navigationPage = { url: input.contents.url, html: navigation.html() }
        }
        const sampleUrls = input.sampleUrls.map(
          (candidate) => approvedSampleUrl(navigationPage, candidate).href,
        )
        if (input.browserPages?.length && input.sampleUrls.length)
          throw new ExperimentError(
            'Choose rendered browser samples or server-fetched links, not both.',
          )
        const pages = input.fetchOnly
          ? []
          : [page, ...(input.browserPages ?? []).map(prepareCapturedPage)]
        const sampledPages: { url: string; error?: string }[] = (input.browserPages ?? []).map(
          (entry) => ({ url: entry.url }),
        )
        if (pages.some((entry) => new URL(entry.url).origin !== new URL(page.url).origin))
          throw new ExperimentError('Rendered samples must belong to the approved site.')
        if (
          pages.reduce((total, entry) => total + entry.html.length, 0) >
          MAX_TOTAL_CAPTURE_CHARACTERS
        )
          throw new ExperimentError('The rendered samples exceed the text budget.')
        for (const [index, url] of sampleUrls.entries()) {
          job.stage = `Sampling chapter link ${index + 1} of ${sampleUrls.length}`
          try {
            const operation = samplingQueue
              .catch(() => undefined)
              .then(async () => {
                const wait = 1000 - (Date.now() - lastSampleStarted)
                if (wait > 0) await delay(wait)
                lastSampleStarted = Date.now()
                return fetchChapterSample(navigationPage, url)
              })
            samplingQueue = operation.catch(() => undefined)
            const sample = await operation
            if (input.fetchOnly) {
              const document = load(sample.html)
              if (isAccessChallenge(document('title,h1').text(), document('body').text()))
                throw new Error(
                  'Direct fetch returned an access or verification page. Use the rendered browser page instead.',
                )
            }
            if (
              pages.reduce((total, entry) => total + entry.html.length, sample.html.length) >
              MAX_TOTAL_CAPTURE_CHARACTERS
            )
              throw new Error('This sample exceeds the combined capture budget.')
            pages.push(sample)
            sampledPages.push({ url })
          } catch (failure) {
            if (input.fetchOnly)
              throw new ExperimentError(
                `Direct fetch failed: ${failure instanceof Error ? failure.message : 'Page unavailable.'} No model request was made.`,
                422,
              )
            sampledPages.push({
              url,
              error: failure instanceof Error ? failure.message : 'This page could not be sampled.',
            })
          }
        }
        job.stage = 'Testing site scraper'
        const result = await runScraperTool(
          connection.libraryToken,
          {
            pages,
            rightsConfirmed: true,
            sendToModelConfirmed: true,
            expectedKind: input.expectedKind,
            forceRegenerate: input.forceRegenerate,
          },
          configuration,
        )
        if (
          input.expectedKind === 'chapter' &&
          !result.report.attempts
            .at(-1)
            ?.checks.some((check) => check.passed && check.output?.kind === 'chapter')
        )
          throw new ExperimentError(
            'The selected page did not produce readable chapter text. No chapter was imported.',
            422,
          )
        job.scrape = { ...result, sampledPages }
      }
      job.state = 'completed'
      job.stage = 'Complete'
    }
    void execute().catch((failure: unknown) => {
      job.state = 'failed'
      job.stage = 'Stopped'
      job.error =
        failure instanceof ExperimentError
          ? failure.message
          : 'The page operation could not finish. Reconnect or retry with another page.'
    })
    return { id: job.id }
  }

  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const pathname = request.url?.split('?')[0]
    if (!pathname?.startsWith('/api/extension/')) {
      next()
      return
    }
    const respond = (status: number, body: unknown) => {
      response.statusCode = status
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Vary', 'Origin')
      response.end(JSON.stringify(body))
    }
    const handle = async () => {
      const localOrigin = `http://${request.headers.host}`
      if (!['localhost', '127.0.0.1'].includes(new URL(localOrigin).hostname))
        throw new ExperimentError('The extension bridge is localhost-only.', 403)
      const origin = request.headers.origin
      const isPairing = pathname === '/api/extension/pair'
      if (isPairing) {
        if (origin && origin !== localOrigin)
          throw new ExperimentError('Approve connections from the Novelist app.', 403)
      } else if (origin) {
        if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
          throw new ExperimentError('This origin cannot use the extension bridge.', 403)
        response.setHeader('Access-Control-Allow-Origin', origin)
      }
      if (request.method === 'OPTIONS' && !isPairing) {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE')
        response.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, X-Novelist-Extension-Id',
        )
        respond(200, {})
        return
      }
      if (
        request.method === 'POST' &&
        !request.headers['content-type']?.startsWith('application/json')
      )
        throw new ExperimentError('A JSON request is required.', 415)
      const authorization = request.headers.authorization
      if (isPairing && request.method === 'POST') {
        if (!authorization?.startsWith('Bearer '))
          throw new ExperimentError('A library session is required.', 401)
        const body = z
          .object({ extensionId: extensionIdSchema })
          .strict()
          .parse(await readBody(request))
        const libraryToken = authorization.slice(7)
        const { ownerId, release } = await acquireAILibrary(libraryToken, configuration, 0)
        release()
        respond(200, pairing.create(body.extensionId, ownerId, libraryToken))
        return
      }
      const extensionId = extensionIdSchema.parse(request.headers['x-novelist-extension-id'])
      if (origin && origin !== `chrome-extension://${extensionId}`)
        throw new ExperimentError('Extension origin mismatch.', 403)
      if (pathname === '/api/extension/ready' && request.method === 'GET') {
        respond(200, { app: 'novelist', protocol: 1 })
        return
      }
      if (pathname === '/api/extension/connect' && request.method === 'POST') {
        const body = z
          .object({ code: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(await readBody(request))
        respond(200, pairing.exchange(extensionId, body.code))
        return
      }
      if (!authorization?.startsWith('Bearer '))
        throw new ExperimentError('Connect the extension to Novelist first.', 401)
      const token = authorization.slice(7)
      const connection = pairing.authorize(extensionId, token)
      if (pathname === '/api/extension/connection' && request.method === 'DELETE') {
        pairing.revoke(extensionId, token)
        respond(200, { disconnected: true })
        return
      }
      if (pathname === '/api/extension/status' && request.method === 'GET') {
        respond(200, {
          liveEnabled: configuration.liveEnabled && Boolean(configuration.apiKey),
          model: configuration.scraperModel || configuration.model,
          identificationModel: configuration.identificationModel || IDENTIFICATION_MODEL,
          expiresAt: connection.expiresAt,
        })
        return
      }
      if (pathname === '/api/extension/estimate' && request.method === 'POST') {
        const input = estimatePageRequestSchema.parse(await readBody(request))
        respond(
          200,
          estimateIdentification(
            input.page,
            input.outputLanguage,
            input.model || configuration.identificationModel || IDENTIFICATION_MODEL,
            input.referenceVersions,
            input.metadataReference,
          ),
        )
        return
      }
      if (pathname === '/api/extension/library' && request.method === 'GET') {
        respond(200, { books: await connectedLibrary(connection.libraryToken, configuration) })
        return
      }
      if (pathname === '/api/extension/library/source' && request.method === 'POST') {
        respond(
          200,
          await savedSourceContext(connection.libraryToken, await readBody(request), configuration),
        )
        return
      }
      if (pathname === '/api/extension/library/contents' && request.method === 'POST') {
        respond(
          200,
          await saveSourceContents(
            connection.libraryToken,
            await readBody(request, 8_000_000),
            configuration,
          ),
        )
        return
      }
      if (pathname === '/api/extension/library/downloaded' && request.method === 'POST') {
        respond(
          200,
          await downloadedSourceUrls(
            connection.libraryToken,
            await readBody(request),
            configuration,
          ),
        )
        return
      }
      if (pathname === '/api/extension/library/chapter/start' && request.method === 'POST') {
        respond(202, startJob(connection, 'download', await readBody(request)))
        return
      }
      if (pathname === '/api/extension/library/chapter' && request.method === 'POST') {
        respond(
          200,
          await saveRenderedSourceChapter(
            connection.libraryToken,
            await readBody(request),
            configuration,
          ),
        )
        return
      }
      if (pathname === '/api/extension/library/catalog' && request.method === 'POST') {
        respond(
          200,
          await attachNovelUpdates(connection.libraryToken, await readBody(request), configuration),
        )
        return
      }
      if (pathname === '/api/extension/library/pair' && request.method === 'POST') {
        respond(
          200,
          await pairIdentifiedEdition(
            connection.libraryToken,
            await readBody(request),
            configuration,
          ),
        )
        return
      }
      if (pathname === '/api/extension/library/matches' && request.method === 'POST') {
        if (!configuration.liveEnabled || !configuration.apiKey)
          throw new ExperimentError('Live AI is disabled.', 403)
        respond(
          202,
          startJob(connection, 'match', libraryMatchRequestSchema.parse(await readBody(request))),
        )
        return
      }
      if (pathname === '/api/extension/library' && request.method === 'POST') {
        respond(
          200,
          await addIdentifiedNovel(
            connection.libraryToken,
            await readBody(request, 8_000_000),
            configuration,
          ),
        )
        return
      }
      if (request.method === 'GET' && pathname.startsWith('/api/extension/jobs/')) {
        const record = jobs.get(pathname.slice('/api/extension/jobs/'.length))
        if (!record || record.connectionId !== connection.connectionId)
          throw new ExperimentError('This page operation is no longer available.', 404)
        respond(200, record.job)
        return
      }
      if (request.method === 'DELETE' && pathname.startsWith('/api/extension/jobs/')) {
        const id = pathname.slice('/api/extension/jobs/'.length)
        const record = jobs.get(id)
        if (!record || record.connectionId !== connection.connectionId)
          throw new ExperimentError('This page operation is no longer available.', 404)
        if (record.job.state === 'running')
          throw new ExperimentError('Wait for the current chapter to finish.', 409)
        jobs.delete(id)
        respond(200, { removed: true })
        return
      }
      if (pathname === '/api/extension/navigation/start' && request.method === 'POST') {
        if (!configuration.liveEnabled || !configuration.apiKey)
          throw new ExperimentError('Enable live AI before starting browser exploration.', 403)
        respond(
          200,
          navigationSessions.start(
            connection.connectionId,
            await readBody(request),
            configuration.identificationModel || IDENTIFICATION_MODEL,
          ),
        )
        return
      }
      if (pathname === '/api/extension/navigation/site' && request.method === 'POST') {
        respond(
          200,
          await siteNavigation(connection.libraryToken, await readBody(request), configuration),
        )
        return
      }
      if (pathname === '/api/extension/navigation/plan' && request.method === 'POST') {
        if (!configuration.liveEnabled || !configuration.apiKey)
          throw new ExperimentError('Live AI is disabled.', 403)
        respond(
          202,
          startJob(connection, 'navigate', navigationPlanSchema.parse(await readBody(request))),
        )
        return
      }
      if (pathname.startsWith('/api/extension/navigation/') && request.method === 'DELETE') {
        navigationSessions.stop(
          connection.connectionId,
          pathname.slice('/api/extension/navigation/'.length),
        )
        respond(200, { stopped: true })
        return
      }
      if (
        request.method === 'POST' &&
        ['/api/extension/inspect', '/api/extension/test'].includes(pathname)
      ) {
        if (pathname.endsWith('/inspect') && (!configuration.liveEnabled || !configuration.apiKey))
          throw new ExperimentError(
            'Live AI is disabled. Configure the server key and restart Novelist.',
            403,
          )
        const operation = pathname.endsWith('/inspect') ? 'inspect' : 'test'
        const input =
          operation === 'inspect'
            ? inspectPageRequestSchema.parse(await readBody(request))
            : testScrapeRequestSchema.parse(await readBody(request, 8_000_000))
        publicPageUrl(input.page.url)
        respond(202, startJob(connection, operation, input))
        return
      }
      throw new ExperimentError('Extension endpoint not found.', 404)
    }
    void handle().catch((failure: unknown) => {
      if (failure instanceof ExperimentError) respond(failure.status, { error: failure.message })
      else if (failure instanceof ZodError || failure instanceof SyntaxError)
        respond(400, { error: 'Invalid extension request or page capture.' })
      else respond(500, { error: 'The local extension bridge could not complete this request.' })
    })
  }
}
