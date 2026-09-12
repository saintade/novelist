import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadEnv } from 'vite'
import { scraperRequestSchema } from '../../src/lib/scraper/contracts.ts'
import { runScraperExperiment } from './experiment.ts'
import { fixtureAdapterCode } from './fixture-adapter.ts'
import { heldOutFixtures, trainingFixtures } from './fixtures.ts'
import { generateScraper } from './generator.ts'
import { prepareCapturedPage } from './validate.ts'

async function main() {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'boolean' },
      'live-fixture': { type: 'boolean' },
      input: { type: 'string' },
      adapter: { type: 'string' },
      'allow-api-spend': { type: 'boolean' },
    },
  })
  if (
    [values.fixture, values['live-fixture'], values.input].filter(Boolean).length !== 1 ||
    (values.adapter && !values.input)
  )
    throw new Error(
      'Choose --fixture, --live-fixture --allow-api-spend, or --input captures.json [--adapter parser.mjs | --allow-api-spend].',
    )
  const root = process.cwd()
  const environment = { ...loadEnv('development', root, ''), ...process.env }
  const live = !values.fixture && !values.adapter
  if (
    live &&
    (!values['allow-api-spend'] ||
      !environment.OPENAI_API_KEY ||
      environment.NOVELIST_ENABLE_LIVE_AI !== 'true')
  )
    throw new Error(
      'Live generation requires --allow-api-spend, OPENAI_API_KEY, and NOVELIST_ENABLE_LIVE_AI=true. No API request was made.',
    )
  const readLimited = async (path: string, limit: number) => {
    const absolute = resolve(path)
    if ((await stat(absolute)).size > limit)
      throw new Error('Experiment input file exceeds its size limit.')
    return readFile(absolute, 'utf8')
  }
  const training = values.input
    ? scraperRequestSchema
        .parse(JSON.parse(await readLimited(values.input, 1_000_000)))
        .pages.map((page) => ({ page: prepareCapturedPage(page) }))
    : trainingFixtures
  const code = values.adapter ? await readLimited(values.adapter, 24_000) : null
  const model =
    environment.OPENAI_SCRAPER_MODEL || environment.OPENAI_EXTRACTION_MODEL || 'gpt-5.6-luna'
  const result = await runScraperExperiment({
    training,
    heldOut: values.input ? [] : heldOutFixtures,
    artifactRoot: join(root, '.novelist', 'scraper', 'cli'),
    mode: values.fixture ? 'fixture' : code ? 'provided-code' : 'live',
    model: live ? model : null,
    generate: live
      ? (context) => generateScraper(context, { apiKey: environment.OPENAI_API_KEY, model })
      : async (context) => ({
          adapter: {
            code: code ?? (context.previous ? fixtureAdapterCode : 'export default () => ({})'),
            explanation: code
              ? 'User-provided adapter, not an API generation.'
              : 'Scripted generator repairs an intentionally invalid first response.',
            limitations: ['This is a workflow test, not a model-quality result.'],
          },
          inputTokens: 0,
          outputTokens: 0,
        }),
  })
  console.log(
    JSON.stringify(
      {
        id: result.report.id,
        mode: result.report.mode,
        status: result.report.status,
        attempts: result.report.attempts.length,
        trainingPassed:
          result.report.attempts.at(-1)?.checks.filter((check) => check.passed).length ?? 0,
        heldOutPassed: result.report.heldOut.filter((check) => check.passed).length,
        inputTokens: result.report.inputTokens,
        outputTokens: result.report.outputTokens,
        durationMs: result.report.durationMs,
        artifactDirectory: result.artifactDirectory,
        note: result.report.note,
      },
      null,
      2,
    ),
  )
  if (result.report.status === 'failed') process.exitCode = 1
}

void main().catch((failure: unknown) => {
  console.error(failure instanceof Error ? failure.message : 'The scraper experiment failed.')
  process.exitCode = 1
})
