import { join } from 'node:path'
import { z } from 'zod'
import { scraperRequestSchema } from '../../src/lib/scraper/contracts.ts'
import { acquireAILibrary, ExperimentError, type AIConfiguration } from '../ai/experiments.ts'
import { runScraperExperiment } from './experiment.ts'
import { generateScraper } from './generator.ts'
import { prepareCapturedPage } from './validate.ts'
import { findSiteScraper, saveSiteScraper } from './cache.ts'
import type { GenerationContext } from './generator.ts'

export const scraperToolDefinition = {
  name: 'generate_book_scraper',
  description:
    'Reuse a tested site scraper or generate and test JavaScript from 1-3 same-origin HTML captures. Saved adapters are revalidated in the sandbox before any model call. Requires permission and model-use confirmation for generation/repair, which uses at most three model requests. Returns code and review-required diagnostics, never auto-imports or fetches pages. A browser plugin must call through a trusted authenticated bridge, not execute returned code in a content script.',
  inputSchema: z.toJSONSchema(scraperRequestSchema),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
}

let activeExperiments = 0

export async function runScraperTool(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
  generationConfirmed = true,
) {
  const input = scraperRequestSchema.parse(payload)
  const { client, ownerId, reserveRequests, release } = await acquireAILibrary(
    token,
    configuration,
    0,
  )
  if (activeExperiments >= 2) {
    release()
    throw new ExperimentError(
      'Two scraper experiments are already running. Try again when one finishes.',
      429,
    )
  }
  activeExperiments++
  try {
    const training = input.pages.map((page) => ({ page: prepareCapturedPage(page) }))
    const origin = new URL(training[0].page.url).origin
    const artifactRoot = join(configuration.root, '.novelist', 'scraper', ownerId)
    const kind = input.expectedKind ?? 'chapter'
    const cached = await findSiteScraper(client, origin, kind, artifactRoot)
    let previous: GenerationContext['previous']
    if (cached && !input.forceRegenerate) {
      const tested = await runScraperExperiment({
        training,
        artifactRoot,
        mode: 'provided-code',
        model: null,
        expectedKind: input.expectedKind,
        strategy: 'reused',
        generate: async () => ({
          adapter: {
            code: cached,
            explanation: 'Reusing a tested site adapter.',
            limitations: ['Revalidated on the current pages; other layouts may differ.'],
          },
          inputTokens: 0,
          outputTokens: 0,
        }),
      })
      if (tested.report.status === 'needs_review') {
        await saveSiteScraper(client, origin, cached, tested.report).catch(() => {
          tested.report.persistenceWarning =
            'Extraction passed, but the reusable adapter could not be saved.'
        })
        return { report: tested.report, code: cached }
      }
      previous = {
        code: cached,
        failures: tested.report.attempts.flatMap((attempt) =>
          attempt.checks
            .filter((check) => !check.passed)
            .map(({ url, issues }) => ({ url, issues })),
        ),
      }
    }
    if (!generationConfirmed)
      throw new ExperimentError(
        'This page needs scraper generation or repair. Confirm up to three model requests before continuing.',
        402,
      )
    if (!configuration.liveEnabled || !configuration.apiKey)
      throw new ExperimentError(
        'No saved scraper passed for this page. Enable live AI to generate or repair it.',
        403,
      )
    reserveRequests(3)
    const model = configuration.scraperModel || configuration.model
    const result = await runScraperExperiment({
      training,
      artifactRoot,
      mode: 'live',
      model,
      previous,
      expectedKind: input.expectedKind,
      strategy: previous ? 'repaired' : 'generated',
      generate: (context) => generateScraper(context, { apiKey: configuration.apiKey, model }),
    })
    if (result.code)
      await saveSiteScraper(client, origin, result.code, result.report).catch(() => {
        result.report.persistenceWarning =
          'Extraction passed, but the reusable adapter could not be saved.'
      })
    return { report: result.report, code: result.code }
  } catch (failure) {
    if (failure instanceof ExperimentError) throw failure
    if (failure instanceof Error && failure.message.includes('scraper sandbox is unavailable'))
      throw new ExperimentError(failure.message, 503)
    throw new ExperimentError(
      'The scraper experiment could not complete. Check Docker and the local artifact directory.',
      502,
    )
  } finally {
    activeExperiments--
    release()
  }
}
