import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  scraperCodeSchema,
  scraperRequestSchema,
  SCRAPER_CONTRACT_VERSION,
  type PageCheck,
  type CapturedPage,
  type ScrapedPage,
  type ScraperReport,
} from '../../src/lib/scraper/contracts.ts'
import {
  SCRAPER_PROMPT_VERSION,
  type GeneratedAdapter,
  type GenerationContext,
} from './generator.ts'
import { runAdapter, sandboxImageId } from './sandbox.ts'
import { checkScrapedPage } from './validate.ts'

export interface EvaluationPage {
  page: CapturedPage
  expected?: ScrapedPage
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

async function evaluate(
  code: string,
  pages: EvaluationPage[],
  expectedKind?: 'chapter' | 'index',
): Promise<PageCheck[]> {
  const checks: PageCheck[] = []
  for (const { page, expected } of pages) {
    try {
      const check = checkScrapedPage(await runAdapter(code, page), page, expected)
      if (expectedKind && check.output?.kind !== expectedKind) {
        check.passed = false
        check.issues.push(
          `Expected ${expectedKind} extraction, not ${check.output?.kind ?? 'unknown'} content.`,
        )
      }
      checks.push(check)
    } catch (failure) {
      checks.push({
        url: page.url,
        passed: false,
        issues: [failure instanceof Error ? failure.message : 'Adapter execution failed.'],
      })
    }
  }
  return checks
}

export async function runScraperExperiment(options: {
  training: EvaluationPage[]
  heldOut?: EvaluationPage[]
  mode: ScraperReport['mode']
  model: string | null
  artifactRoot: string
  generate: (context: GenerationContext) => Promise<GeneratedAdapter>
  previous?: GenerationContext['previous']
  expectedKind?: 'chapter' | 'index'
  strategy?: 'generated' | 'reused' | 'repaired'
}): Promise<{ report: ScraperReport; code: string | null; artifactDirectory: string }> {
  const pages = scraperRequestSchema.parse({
    pages: options.training.map((entry) => entry.page),
    rightsConfirmed: true,
    sendToModelConfirmed: true,
  }).pages
  const heldOut = options.heldOut ?? []
  if (heldOut.length) {
    scraperRequestSchema.parse({
      pages: heldOut.map((entry) => entry.page),
      rightsConfirmed: true,
      sendToModelConfirmed: true,
    })
    if (
      heldOut.some(
        (entry) =>
          new URL(entry.page.url).origin !== new URL(pages[0].url).origin ||
          pages.some((page) => page.url === entry.page.url),
      )
    )
      throw new Error('Held-out pages must be distinct captures from the training origin.')
  }
  const image = await sandboxImageId()
  const started = Date.now()
  const id = randomUUID()
  const artifactDirectory = join(options.artifactRoot, id)
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 })
  const save = (name: string, value: string) =>
    writeFile(join(artifactDirectory, name), value, { mode: 0o600, flag: 'wx' })
  await save('captures.json', JSON.stringify(pages, null, 2))
  if (heldOut.length) await save('held-out.json', JSON.stringify(heldOut, null, 2))
  const report: ScraperReport = {
    id,
    mode: options.mode,
    model: options.model,
    contractVersion: SCRAPER_CONTRACT_VERSION,
    promptVersion: SCRAPER_PROMPT_VERSION,
    sandboxImage: image,
    createdAt: new Date().toISOString(),
    status: 'failed',
    sourceHashes: [...pages, ...heldOut.map((entry) => entry.page)].map((page) => ({
      url: page.url,
      hash: hash(page.html),
    })),
    attempts: [],
    heldOut: [],
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    note:
      options.mode === 'fixture'
        ? 'Scripted fixture generation with real isolated code execution. No model call or model-quality result.'
        : options.mode === 'provided-code'
          ? 'Saved site scraper rechecked in the sandbox without a model call. Validation covers the supplied pages only.'
          : 'Captured-page checks are not proof of complete content or cross-page reliability. Review before use; no pages were fetched or imported.',
  }
  let previous: GenerationContext['previous'] = options.previous
  let code: string | null = null
  const budget = options.mode === 'provided-code' ? 1 : 3
  for (let number = 1; number <= budget; number++) {
    let generated: GeneratedAdapter
    try {
      generated = await options.generate({
        pages,
        ...(options.expectedKind ? { expectedKind: options.expectedKind } : {}),
        ...(previous ? { previous } : {}),
      })
      generated.adapter = scraperCodeSchema.parse(generated.adapter)
    } catch {
      report.attempts.push({
        number,
        checks: [],
        inputTokens: 0,
        outputTokens: 0,
        error:
          'Generation failed or returned incomplete output. Check provider availability; no automatic retry was made.',
      })
      break
    }
    code = generated.adapter.code
    await save(`attempt-${number}.mjs`, code)
    await save(
      `attempt-${number}.json`,
      JSON.stringify(
        {
          ...generated.adapter,
          code: undefined,
          inputTokens: generated.inputTokens,
          outputTokens: generated.outputTokens,
        },
        null,
        2,
      ),
    )
    const checks = await evaluate(code, options.training, options.expectedKind)
    report.attempts.push({
      number,
      codeHash: hash(code),
      checks,
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
    })
    report.inputTokens += generated.inputTokens
    report.outputTokens += generated.outputTokens
    if (checks.every((check) => check.passed)) {
      report.heldOut = await evaluate(code, heldOut, options.expectedKind)
      if (report.heldOut.every((check) => check.passed))
        report.status = checks.every((check) => check.output?.kind === 'blocked')
          ? 'blocked'
          : 'needs_review'
      break
    }
    previous = {
      code,
      failures: checks.filter((check) => !check.passed).map(({ url, issues }) => ({ url, issues })),
    }
  }
  report.durationMs = Date.now() - started
  if (code && options.strategy)
    report.adapter = {
      origin: new URL(pages[0].url).origin,
      codeHash: hash(code),
      strategy: options.strategy,
    }
  await save('report.json', JSON.stringify(report, null, 2))
  return { report, code, artifactDirectory }
}
