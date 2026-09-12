import { ensureSession, supabase } from '../supabase/client'
import { catalogMetadataSchema } from '../extension/contracts'
import {
  sourceChapterContentSchema,
  type ReadingSource,
  type SourceChapterRow,
  type SourceDownloadRequest,
  type SourceDownloadResult,
  type SourceChapterContent,
  type SourceAnalysis,
  type SourceExtractionRequest,
  type SourceExtractionResult,
} from './contracts'
import type { Chapter } from '../books'

export function sourceInventory(source: ReadingSource) {
  const parsed = catalogMetadataSchema.shape.contents.safeParse(source.contents_data)
  return parsed.success && parsed.data ? parsed.data.chapters : []
}

export async function getSourceDirectory(novelId: string, contextSourceId?: string) {
  await ensureSession()
  const sources = await supabase
    .from('novel_sources')
    .select('*')
    .or(`novel_id.eq.${novelId}${contextSourceId ? `,id.eq.${contextSourceId}` : ''}`)
    .order('created_at')
  if (sources.error) throw sources.error
  const downloaded: SourceChapterRow[] = []
  if (sources.data.length)
    for (let offset = 0; ; offset += 1000) {
      const page = await supabase
        .from('source_chapters')
        .select('*')
        .in(
          'source_id',
          sources.data.map((source) => source.id),
        )
        .order('id')
        .range(offset, offset + 999)
      if (page.error) throw page.error
      downloaded.push(...page.data)
      if (page.data.length < 1000) break
    }
  const progress = sources.data.length
    ? await supabase
        .from('source_reading_progress')
        .select('*')
        .in(
          'source_id',
          sources.data.map((source) => source.id),
        )
    : { data: [], error: null }
  if (progress.error) throw progress.error
  return { sources: sources.data, downloaded, progress: progress.data }
}

export async function testDirectExtraction(
  input: SourceExtractionRequest,
): Promise<SourceExtractionResult> {
  await ensureSession()
  const session = await supabase.auth.getSession()
  const response = await fetch('/api/ai/source-extraction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.data.session?.access_token}`,
    },
    body: JSON.stringify(input),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Direct extraction test failed.')
  return result
}

const pendingDownloads = new Map<string, Promise<SourceDownloadResult>>()
export async function downloadChapter(input: SourceDownloadRequest): Promise<SourceDownloadResult> {
  const key = JSON.stringify({
    sourceId: input.sourceId,
    url: input.url,
    confirmed: input.confirmed ?? false,
    page: input.page,
  })
  const pending = pendingDownloads.get(key)
  if (pending) return pending
  const task = (async (): Promise<SourceDownloadResult> => {
    await ensureSession()
    const saved = await getSavedChapter(input.sourceId, input.url)
    if (saved) return saved
    const session = await supabase.auth.getSession()
    const response = await fetch('/api/ai/source-chapter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.data.session?.access_token}`,
      },
      body: JSON.stringify(input),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Chapter download failed.')
    return result
  })()
  pendingDownloads.set(key, task)
  try {
    return await task
  } finally {
    if (pendingDownloads.get(key) === task) pendingDownloads.delete(key)
  }
}

export function readableSourceChapter(
  content: SourceChapterContent,
  record: SourceChapterRow,
): Chapter {
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
    )
  return {
    id: record.id,
    title: content.title,
    wordCount: record.word_count,
    html: content.paragraphs
      .map((paragraph) => `<p class="source-paragraph">${escape(paragraph)}</p>`)
      .join(''),
  }
}

export async function saveSourceProgress(sourceId: string, url: string, fraction: number, options: { language?: string; versionId?: string; finished?: boolean; observedAt?: string } = {}) {
  const observedAt = options.observedAt ?? new Date().toISOString()
  await ensureSession()
  const saved = await supabase.rpc('save_source_reading_position', { target_source: sourceId, chapter_url: url, fraction, language: (options.language ?? null) as unknown as string, version_id: (options.versionId ?? null) as unknown as string, finished: options.finished ?? false, observed_at: observedAt })
  if (saved.error) throw saved.error
}

export async function readDownloadedChapter(
  record: SourceChapterRow,
): Promise<SourceChapterContent> {
  await ensureSession()
  const file = await supabase.storage.from('library').download(record.content_path)
  if (file.error || !file.data || file.data.size > 2_000_000)
    throw new Error('Stored chapter text could not be read.')
  const { storedChapterText } = await import('./content')
  const text = await storedChapterText(file.data, record.content_path)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const hash = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  if (hash !== record.content_hash) throw new Error('Stored chapter integrity check failed.')
  return sourceChapterContentSchema.parse(JSON.parse(text))
}

export async function getSavedChapter(
  sourceId: string,
  url: string,
): Promise<Extract<SourceDownloadResult, { state: 'ready' }> | null> {
  await ensureSession()
  const result = await supabase
    .from('source_chapters')
    .select('*')
    .eq('source_id', sourceId)
    .eq('url', url)
    .maybeSingle()
  if (result.error) throw new Error(result.error.message)
  if (!result.data) return null
  return {
    state: 'ready',
    record: result.data,
    chapter: await readDownloadedChapter(result.data),
    cached: true,
  }
}

export async function analyzeChapters(bookId: string, sourceUrl: string, referenceUrls: string[]) {
  await ensureSession()
  const session = await supabase.auth.getSession()
  const response = await fetch('/api/ai/source-analysis', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.data.session?.access_token}`,
    },
    body: JSON.stringify({ bookId, sourceUrl, referenceUrls, confirmed: true }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Chapter analysis failed.')
  return result as { id: string; result: SourceAnalysis; model: string }
}

export async function reviewAlignment(
  sourceId: string,
  url: string,
  referenceId: string,
  urls: string[],
  decision: 'confirmed' | 'rejected',
) {
  await ensureSession()
  const result = await supabase.rpc('review_source_alignment', {
    target_source: sourceId,
    chapter_url: url,
    reference_source: referenceId,
    paired_urls: urls,
    decision,
  })
  if (result.error) throw new Error(result.error.message)
}
