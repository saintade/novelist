import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/supabase/database.types.ts'
import {
  SCRAPER_CONTRACT_VERSION,
  scraperCodeSchema,
  type ScraperReport,
} from '../../src/lib/scraper/contracts.ts'
import { ExperimentError } from '../ai/experiments.ts'

const hash = (code: string) => createHash('sha256').update(code).digest('hex')

export async function findSiteScraper(
  client: SupabaseClient<Database>,
  origin: string,
  kind: 'chapter' | 'index',
  artifactRoot: string,
): Promise<string | null> {
  const saved = await client
    .from('site_scrapers')
    .select('code,code_hash,contract_version')
    .eq('origin', origin)
    .eq('page_kind', kind)
    .maybeSingle()
  if (saved.error)
    throw new ExperimentError(
      'Saved site scrapers could not be loaded. Apply the local migrations before generating another adapter.',
      503,
    )
  if (
    saved.data?.contract_version === SCRAPER_CONTRACT_VERSION &&
    hash(saved.data.code) === saved.data.code_hash
  )
    return scraperCodeSchema.shape.code.parse(saved.data.code)
  let entries
  try {
    entries = await readdir(artifactRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
      .map(async (entry) => ({
        path: join(artifactRoot, entry.name),
        modified: (await stat(join(artifactRoot, entry.name))).mtimeMs,
      })),
  )
  for (const directory of directories
    .sort((first, second) => second.modified - first.modified)
    .slice(0, 100)) {
    try {
      const report = JSON.parse(
        await readFile(join(directory.path, 'report.json'), 'utf8'),
      ) as ScraperReport
      const last = report.attempts.at(-1)
      if (
        report.contractVersion !== SCRAPER_CONTRACT_VERSION ||
        report.status !== 'needs_review' ||
        !last?.checks.length ||
        !last.checks.every((check) => check.passed && new URL(check.url).origin === origin) ||
        !last.checks.some((check) => check.output?.kind === kind) ||
        !Number.isInteger(last.number) ||
        last.number < 1 ||
        last.number > 3
      )
        continue
      const code = scraperCodeSchema.shape.code.parse(
        await readFile(join(directory.path, `attempt-${last.number}.mjs`), 'utf8'),
      )
      if (hash(code) === last.codeHash) return code
    } catch {
      continue
    }
  }
  return null
}

export async function saveSiteScraper(
  client: SupabaseClient<Database>,
  origin: string,
  code: string,
  report: ScraperReport,
) {
  if (report.status !== 'needs_review') return
  const checks = report.attempts.at(-1)?.checks ?? []
  if (!checks.length || checks.some((check) => !check.passed)) return
  const kinds = [
    ...new Set(
      checks.flatMap((check) =>
        check.output?.kind && check.output.kind !== 'blocked' ? [check.output.kind] : [],
      ),
    ),
  ]
  if (!kinds.length) return
  const saved = await client.from('site_scrapers').upsert(
    kinds.map((kind) => ({
      origin,
      page_kind: kind,
      code,
      code_hash: hash(code),
      contract_version: SCRAPER_CONTRACT_VERSION,
      report_id: report.id,
      validated_at: new Date().toISOString(),
    })),
    { onConflict: 'owner_id,origin,page_kind' },
  )
  if (saved.error) throw saved.error
}
