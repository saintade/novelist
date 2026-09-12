import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { ZodError } from 'zod'
import { authenticateAILibrary, ExperimentError, localAILimits, runTermExperiment, type AIConfiguration } from './experiments.ts'
import { runReadingGuide, runStyleInference } from './styles.ts'
import { editBookTranslationTerm, runBookTranslation, suggestBookTranslationTerm } from './translation.ts'
import { runScraperTool, scraperToolDefinition } from '../scraper/tool.ts'
import { extensionBridgeMiddleware } from '../extension/bridge.ts'
import { downloadSourceChapter, testSourceExtraction } from '../sources/chapters.ts'
import { analyzeSourceChapters } from '../sources/analysis.ts'
import { runReaderChat } from './reader-chat.ts'
import { runReaderIndex } from './reader-retrieval.ts'
import { TranslationBatchManager } from './translation-batches.ts'
import { runAIAdmin } from './admin.ts'

async function requestBody(request: IncomingMessage, maximumBytes = 4096): Promise<unknown> {
  const parts: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > maximumBytes) throw new ExperimentError('Request too large.', 413)
    parts.push(buffer)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

export function createAIMiddleware(configuration: AIConfiguration, translationBatches: TranslationBatchManager) {
      return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
        const pathname = request.url?.split('?')[0]
        if (!pathname?.startsWith('/api/ai/')) {
          next()
          return
        }
        const respond = (status: number, body: unknown) => {
          response.statusCode = status
          response.setHeader('Content-Type', 'application/json')
          response.setHeader('Cache-Control', 'no-store')
          response.end(JSON.stringify(body))
        }
        const handle = async (request: IncomingMessage, _response: ServerResponse) => {
          const host = (request.headers.host ?? '').split(':')[0]
          const origin = configuration.publicOrigin ?? `http://${request.headers.host}`
          if (configuration.hosted && (!configuration.publicOrigin || !configuration.allowedUserId))
            throw new ExperimentError('Private hosting is not configured.', 503)
          if (configuration.publicOrigin ? request.headers.host !== new URL(configuration.publicOrigin).host : !['127.0.0.1', 'localhost'].includes(host))
            throw new ExperimentError('AI experiments are restricted to local development.', 403)
          if (request.headers.origin && request.headers.origin !== origin)
            throw new ExperimentError('Cross-origin AI requests are not allowed.', 403)
          if (pathname === '/api/ai/status' && request.method === 'GET') {
            respond(200, {
              liveEnabled: configuration.liveEnabled && Boolean(configuration.apiKey),
              model: configuration.model,
              translationModel: configuration.translationModel || configuration.model,
              matchingModel: configuration.identificationModel || 'gpt-5-nano',
              chatModel: configuration.chatModel || configuration.translationModel || configuration.model,
              limits: localAILimits(configuration),
            })
            return
          }
          if (pathname === '/api/ai/scraper-tool' && request.method === 'GET') {
            if (configuration.hosted) throw new ExperimentError('Scraper operations run on the local Mac bridge.', 404)
            respond(200, scraperToolDefinition)
            return
          }
          if (
            ![
              '/api/ai/extract-terms',
              '/api/ai/infer-style',
              '/api/ai/reading-guide',
              '/api/ai/generate-scraper',
              '/api/ai/book-translation',
              '/api/ai/translation-term',
              '/api/ai/term-suggestion',
              '/api/ai/source-chapter',
              '/api/ai/source-extraction',
              '/api/ai/source-analysis',
              '/api/ai/reader-chat',
              '/api/ai/reader-index',
              '/api/ai/translation-batch',
              '/api/ai/session',
              '/api/ai/admin',
            ].includes(pathname!) ||
            request.method !== 'POST'
          )
            throw new ExperimentError('Endpoint not found.', 404)
          if (!request.headers['content-type']?.startsWith('application/json'))
            throw new ExperimentError('A JSON request is required.', 415)
          const authorization = request.headers.authorization
          if (!authorization?.startsWith('Bearer '))
            throw new ExperimentError('A library session is required.', 401)
          if (pathname === '/api/ai/session') {
            respond(200, await translationBatches.refreshAuthorization(authorization.slice(7)))
            return
          }
          if (configuration.hosted) {
            await authenticateAILibrary(authorization.slice(7), configuration)
            if (['/api/ai/generate-scraper', '/api/ai/source-extraction', '/api/ai/source-analysis'].includes(pathname!))
              throw new ExperimentError('Scraper operations run on the local Mac bridge.', 404)
            if (pathname === '/api/ai/source-chapter') {
              respond(200, { state: 'needs_browser', message: 'This chapter is not downloaded. Use the Novelist extension on your Mac to save it to this library, then return here.' })
              return
            }
          }
          if (pathname === '/api/ai/translation-batch') {
            respond(200, await translationBatches.handle(authorization.slice(7), await requestBody(request)))
            return
          }
          if (pathname === '/api/ai/admin') {
            respond(200, await runAIAdmin(authorization.slice(7), await requestBody(request), configuration))
            return
          }
          const operation =
            pathname === '/api/ai/term-suggestion'
              ? suggestBookTranslationTerm
              : pathname === '/api/ai/reader-index'
              ? runReaderIndex
              : pathname === '/api/ai/reader-chat'
              ? runReaderChat
              : pathname === '/api/ai/translation-term'
              ? editBookTranslationTerm
              : pathname === '/api/ai/source-extraction'
                ? testSourceExtraction
                : pathname === '/api/ai/reading-guide'
                  ? runReadingGuide
                  : pathname === '/api/ai/source-analysis'
                    ? analyzeSourceChapters
                    : pathname === '/api/ai/source-chapter'
                      ? downloadSourceChapter
                      : pathname === '/api/ai/book-translation'
                        ? runBookTranslation
                        : pathname === '/api/ai/generate-scraper'
                          ? runScraperTool
                          : pathname === '/api/ai/infer-style'
                            ? runStyleInference
                            : runTermExperiment
          const payload = await requestBody(
              request,
              ['/api/ai/generate-scraper', '/api/ai/source-chapter'].includes(pathname!)
                ? 1_000_000
                : ['/api/ai/source-analysis', '/api/ai/reader-chat', '/api/ai/term-suggestion'].includes(pathname!)
                  ? 16_384
                  : 4096,
            )
          if (pathname === '/api/ai/book-translation' && payload && typeof payload === 'object' && 'background' in payload && payload.background === true) {
            const result = await translationBatches.startChapter(authorization.slice(7), payload)
            respond(202, { job: result.status })
            return
          }
          const result = await operation(
            authorization.slice(7),
            payload,
            configuration,
          )
          respond(200, result)
        }
        void handle(request, response).catch((failure: unknown) => {
          if (failure instanceof ExperimentError)
            respond(failure.status, { error: failure.message })
          else if (failure instanceof ZodError || failure instanceof SyntaxError)
            respond(400, { error: 'Invalid AI request.' })
          else respond(500, { error: 'The AI request could not be completed.' })
        })
      }
}

export function developmentTranslationBatches(configuration: AIConfiguration) {
  const key = Symbol.for('novelist.development.translation-workers')
  const shared = globalThis as unknown as Record<symbol, Map<string, { signature: string; manager: TranslationBatchManager }>>
  const managers = shared[key] ??= new Map()
  const signature = JSON.stringify(configuration)
  const previous = managers.get(configuration.root)
  if (previous?.signature === signature && previous.manager.constructor === TranslationBatchManager) return previous.manager
  if (previous && previous.signature !== signature) previous.manager.stop()
  const manager = new TranslationBatchManager(configuration, 5000, previous?.signature === signature ? previous.manager : undefined)
  managers.set(configuration.root, { signature, manager })
  return manager
}

export function aiExperimentPlugin(configuration: AIConfiguration): Plugin {
  return {
    name: 'novelist-local-ai-experiments',
    apply: 'serve',
    configureServer(server) {
      const translationBatches = developmentTranslationBatches(configuration)
      server.middlewares.use(extensionBridgeMiddleware(configuration))
      server.middlewares.use(createAIMiddleware(configuration, translationBatches))
    },
  }
}
