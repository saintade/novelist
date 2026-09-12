import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import type { SupabaseClient } from '@supabase/supabase-js'
import { load } from 'cheerio'
import type { Database, Json } from '../../src/lib/supabase/database.types.ts'
import { catalogMetadataSchema } from '../../src/lib/extension/contracts.ts'
import { publicPageUrl, type CapturedPage } from '../../src/lib/scraper/contracts.ts'
import {
  sourceChapterContentSchema,
  sourceDownloadSchema,
  sourceExtractionSchema,
  type SourceExtractionResult,
  type SourceDownloadResult,
} from '../../src/lib/sources/contracts.ts'
import { acquireAILibrary, ExperimentError, type AIConfiguration } from '../ai/experiments.ts'
import { fetchChapterSample } from '../extension/sample.ts'
import { isNovelUpdatesSeries } from '../../src/lib/extension/metadata.ts'
import { runScraperTool } from '../scraper/tool.ts'
import { isAccessChallenge } from '../../src/lib/extension/navigation.ts'
import { canonicalChapterUrl } from '../../src/lib/extension/contents.ts'
import { storedChapterText } from '../../src/lib/sources/content.ts'

const active = new Set<string>()
const nextFetch = new Map<string, number>()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export async function storedSourceChapter(
  client: SupabaseClient<Database>,
  sourceId: string,
  url: string,
) {
  const row = await client
    .from('source_chapters')
    .select('*')
    .eq('source_id', sourceId)
    .eq('url', url)
    .maybeSingle()
  if (row.error) throw row.error
  if (!row.data) return null
  const file = await client.storage.from('library').download(row.data.content_path)
  if (file.error || !file.data || file.data.size > 2_000_000)
    throw new ExperimentError('Stored chapter text is unavailable or too large.', 502)
  const text = await storedChapterText(file.data, row.data.content_path)
  if (hash(text) !== row.data.content_hash)
    throw new ExperimentError('Stored chapter integrity check failed.', 409)
  return { record: row.data, chapter: sourceChapterContentSchema.parse(JSON.parse(text)) }
}

async function chapterSource(
  client: SupabaseClient<Database>,
  sourceId: string,
  requestedUrl: string,
) {
  const source = await client.from('novel_sources').select('*').eq('id', sourceId).single()
  if (source.error || !source.data)
    throw new ExperimentError('Source not found in this library.', 404)
  if (source.data.role === 'metadata' || !source.data.url || isNovelUpdatesSeries(source.data.url))
    throw new ExperimentError('Catalogs do not contain downloadable chapters.')
  const url = canonicalChapterUrl(requestedUrl, source.data.url_aliases)
  const contents = catalogMetadataSchema.shape.contents.safeParse(source.data.contents_data)
  if (
    new URL(url).origin !== new URL(source.data.url).origin ||
    !contents.success ||
    !contents.data?.chapters.some((chapter) => chapter.url === url)
  )
    throw new ExperimentError("Choose a chapter from this source's saved contents.", 404)
  return { source: source.data, url }
}

async function fetchSourcePage(previous: CapturedPage, url: string) {
  const origin = new URL(previous.url).origin
  await delay(Math.max(0, (nextFetch.get(origin) ?? 0) - Date.now()))
  nextFetch.set(origin, Date.now() + 1000)
  return fetchChapterSample(previous, url)
}

export async function testSourceExtraction(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
): Promise<SourceExtractionResult> {
  const input = sourceExtractionSchema.parse(payload)
  const access = await acquireAILibrary(token, configuration, 0)
  const { client, ownerId } = access
  access.release()
  const { source, url } = await chapterSource(client, input.sourceId, input.url)
  if (active.has(ownerId))
    throw new ExperimentError('Another chapter operation is running. Wait for it to finish.', 409)
  active.add(ownerId)
  try {
    const anchor = load('<a>Chapter</a>')
    anchor('a').attr('href', url)
    let page: CapturedPage
    try {
      page = await fetchSourcePage({ url: source.url!, html: anchor.html() }, url)
    } catch (failure) {
      return {
        state: 'needs_browser',
        message: `${failure instanceof Error ? failure.message : 'Direct fetch failed.'} Use the browser extension for this source.`,
      }
    }
    const document = load(page.html)
    if (isAccessChallenge(document('title,h1').text(), document('body').text()))
      return {
        state: 'needs_browser',
        message: 'Direct fetch returned an access or verification page. No model request was made.',
      }
    let result: Awaited<ReturnType<typeof runScraperTool>>
    try {
      result = await runScraperTool(
        token,
        {
          pages: [page],
          expectedKind: 'chapter',
          forceRegenerate: input.forceRegenerate,
          rightsConfirmed: true,
          sendToModelConfirmed: true,
        },
        configuration,
        input.confirmed,
      )
    } catch (failure) {
      if (failure instanceof ExperimentError && failure.status === 402)
        return {
          state: 'needs_scraper',
          message:
            'Direct fetch worked. Confirm model use to generate an extractor for the fetched HTML.',
        }
      throw failure
    }
    const check = result.report.attempts.at(-1)?.checks.find((check) => check.url === url)
    if (
      result.report.status !== 'needs_review' ||
      !check?.passed ||
      check.output?.kind !== 'chapter'
    )
      return {
        state: 'failed',
        message:
          'Direct fetch worked, but extraction did not pass validation. The previous scraper and downloaded chapters were retained.',
      }
    return {
      state: 'ready',
      url,
      title: check.output.title,
      paragraphs: check.output.paragraphs.slice(0, 3),
      characters: check.output.paragraphs.join('\n\n').length,
      htmlCharacters: page.html.length,
      strategy: result.report.adapter?.strategy ?? 'generated',
      nextPageUrl: check.output.nextPageUrl,
      warning: result.report.persistenceWarning,
    }
  } finally {
    active.delete(ownerId)
  }
}

export async function downloadSourceChapter(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
): Promise<SourceDownloadResult> {
  const input = sourceDownloadSchema.parse(payload)
  const access = await acquireAILibrary(token, configuration, 0)
  const { client, ownerId } = access
  access.release()
  const { source, url } = await chapterSource(client, input.sourceId, input.url)
  const stored = await storedSourceChapter(client, input.sourceId, url)
  if (stored) return { state: 'ready', ...stored, cached: true }
  if (active.has(ownerId))
    throw new ExperimentError('Another chapter download is running. Wait for it to finish.', 409)
  active.add(ownerId)
  try {
    const anchor = load('<a>Chapter</a>')
    anchor('a').attr('href', url)
    let previous: CapturedPage = { url: source.url!, html: anchor.html() }
    let next: string | null = url
    const visited = new Set<string>()
    const paragraphs: string[] = []
    const pages: Json[] = []
    let title = ''
    let generationAvailable = input.confirmed
    for (let count = 0; next; count++) {
      if (count >= 5 || visited.has(next))
        throw new ExperimentError(
          'Chapter pagination is incomplete or repeats. No partial chapter was saved.',
          422,
        )
      visited.add(next)
      let captured: CapturedPage
      if (input.page && count === 0) {
        if (publicPageUrl(input.page.url) !== url)
          throw new ExperimentError('The browser capture must match the selected chapter.')
        captured = input.page
      } else {
        try {
          captured = await fetchSourcePage(previous, next)
        } catch (failure) {
          return {
            state: 'needs_browser',
            message: `${failure instanceof Error ? failure.message : 'Direct download failed.'} Open this chapter with the connected extension to capture its rendered text.`,
          }
        }
      }
      const document = load(captured.html)
      const heading = document('title,h1').text().replace(/\s+/g, ' ').trim()
      if (isAccessChallenge(heading, document('body').text()))
        return {
          state: 'needs_browser',
          message:
            'The source returned an access or verification page. No text was saved and no model request was made for this page. Review access in the browser before trying again.',
        }
      let result: Awaited<ReturnType<typeof runScraperTool>>
      try {
        result = await runScraperTool(
          token,
          {
            pages: [captured],
            expectedKind: 'chapter',
            rightsConfirmed: true,
            sendToModelConfirmed: true,
          },
          configuration,
          generationAvailable,
        )
      } catch (failure) {
        if (failure instanceof ExperimentError && failure.status === 402)
          return { state: 'needs_scraper', message: failure.message }
        throw failure
      }
      const check = result.report.attempts.at(-1)?.checks.find((entry) => entry.url === next)
      if (
        result.report.status !== 'needs_review' ||
        !check?.passed ||
        check.output?.kind !== 'chapter'
      )
        return {
          state: 'needs_browser',
          message:
            'No valid chapter text was found. No partial text was saved. Open the chapter in the extension to try its rendered page.',
        }
      const output = check.output
      if (result.report.adapter?.strategy !== 'reused') generationAvailable = false
      title ||= output.title
      paragraphs.push(...output.paragraphs)
      if (paragraphs.length > 2000 || paragraphs.join('\n\n').length > 160_000)
        throw new ExperimentError(
          'This chapter exceeds the download text limit. No partial text was saved.',
          413,
        )
      pages.push({
        url: captured.url,
        captureHash: hash(captured.html),
        reportId: result.report.id,
        adapter: result.report.adapter as unknown as Json,
      })
      previous = captured
      next = output.nextPageUrl
    }
    const chapter = sourceChapterContentSchema.parse({ title, paragraphs })
    const serialized = JSON.stringify(chapter)
    const contentHash = hash(serialized)
    const originalBytes = Buffer.from(serialized)
    const compressed = originalBytes.length >= 1024 ? gzipSync(originalBytes) : null
    const useCompression = compressed !== null && compressed.length < originalBytes.length * 0.9
    const path = `${ownerId}/sources/${source.id}/${hash(url)}/${contentHash}.json${useCompression ? '.gz' : ''}`
    const uploaded = await client.storage
      .from('library')
      .upload(path, useCompression ? compressed! : originalBytes, { contentType: useCompression ? 'application/gzip' : 'application/json', upsert: true })
    if (uploaded.error) throw new ExperimentError('Chapter text could not be stored.', 502)
    const saved = await client
      .from('source_chapters')
      .upsert(
        {
          source_id: input.sourceId,
          url,
          title,
          content_path: path,
          content_hash: contentHash,
          word_count: paragraphs.join(' ').match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu)?.length ?? 0,
          provenance: { method: input.page ? 'browser' : 'http', pages },
        },
        { onConflict: 'owner_id,source_id,url' },
      )
      .select('*')
      .single()
    if (saved.error) {
      await client.storage.from('library').remove([path])
      throw new ExperimentError('Chapter metadata could not be saved. Retry the download.', 502)
    }
    return { state: 'ready', record: saved.data, chapter, cached: false }
  } finally {
    active.delete(ownerId)
  }
}
