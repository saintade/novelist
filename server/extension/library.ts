import {
  addNovelRequestSchema,
  addedNovelSchema,
  novelInspectionSchema,
  contentsCaptureSchema,
  outputLanguageSchema,
  catalogMetadataSchema,
  type InspectionResult,
} from '../../src/lib/extension/contracts.ts'
import {
  discoverContents,
  canonicalChapterUrl,
  resolveChapterDestination,
  uniqueChapterLinks,
} from '../../src/lib/extension/contents.ts'
import { capturedPageSchema, publicPageUrl } from '../../src/lib/scraper/contracts.ts'
import type { Json } from '../../src/lib/supabase/database.types.ts'
import { acquireAILibrary, ExperimentError, type AIConfiguration } from '../ai/experiments.ts'
import { readLibraryCatalog } from '../../src/lib/library/catalog.ts'
import { z } from 'zod'
import { isNovelUpdatesSeries } from '../../src/lib/extension/metadata.ts'
import { downloadSourceChapter } from '../sources/chapters.ts'
import {
  pairedLibrarySourceSchema,
  pairLibraryRequestSchema,
  matchSavedSource,
} from '../../src/lib/extension/library-catalog.ts'

export async function connectedLibrary(token: string, configuration: AIConfiguration) {
  const { client, release } = await acquireAILibrary(token, configuration, 0)
  try {
    return await readLibraryCatalog(client)
  } finally {
    release()
  }
}

export async function savedSourceContext(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
) {
  const input = z.object({ url: z.string().url() }).strict().parse(payload)
  const url = publicPageUrl(input.url)
  const { client, release } = await acquireAILibrary(token, configuration, 0)
  try {
    const book = matchSavedSource([url], await readLibraryCatalog(client))
    if (!book) return { book: null }
    const sources = await client
      .from('novel_sources')
      .select('id,url,book_id,identification_id,contents_data')
      .eq('novel_id', book.novelId)
    if (sources.error) throw sources.error
    const source = sources.data.find(
      (entry) => entry.url === url || (entry.contents_data as { url?: string }).url === url,
    )
    const storedBook = await client
      .from('books')
      .select('source_url,identification_id,catalog_metadata')
      .eq('id', book.id)
      .single()
    if (storedBook.error) throw storedBook.error
    const catalog = storedBook.data.catalog_metadata as {
      canonicalUrl?: string
      contents?: unknown
    }
    const original = storedBook.data.source_url === url || catalog.canonicalUrl === url
    const identificationId =
      source?.identification_id ||
      (original || source?.book_id === book.id ? storedBook.data.identification_id : null)
    let inspection: InspectionResult | undefined
    if (identificationId) {
      const record = await client
        .from('page_identifications')
        .select('id,source_url,source_language,output_language,metadata,model')
        .eq('id', identificationId)
        .single()
      const metadata = novelInspectionSchema.strip().safeParse(record.data?.metadata)
      if (record.data && metadata.success) {
        const contents = catalogMetadataSchema.shape.contents.parse(
          source?.contents_data &&
            typeof source.contents_data === 'object' &&
            Object.hasOwn(source.contents_data, 'chapters')
            ? source.contents_data
            : original
              ? catalog.contents
              : null,
        )
        inspection = {
          inspection: metadata.data,
          recordId: record.data.id,
          sourceUrl: record.data.source_url,
          sourceLanguage: record.data.source_language,
          outputLanguage: outputLanguageSchema.parse(record.data.output_language),
          model: record.data.model,
          inputTokens: 0,
          outputTokens: 0,
          ...(contents ? { contents } : {}),
        }
      }
    }
    return { book, inspection }
  } finally {
    release()
  }
}

export async function saveSourceContents(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
) {
  const input = z
    .object({
      bookId: z.string().regex(/^[a-f0-9]{32}$/),
      sourceUrl: z.string().url(),
      contents: contentsCaptureSchema,
    })
    .strict()
    .parse(payload)
  const sourceUrl = publicPageUrl(input.sourceUrl)
  if (
    isNovelUpdatesSeries(sourceUrl) ||
    new URL(input.contents.url).origin !== new URL(sourceUrl).origin
  )
    throw new ExperimentError('Contents must belong to the saved reading source.')
  const { client, release } = await acquireAILibrary(token, configuration, 0)
  try {
    const book = await client
      .from('books')
      .select('source_url,catalog_metadata,novel_id')
      .eq('id', input.bookId)
      .single()
    if (book.error)
      throw new ExperimentError('This book is not available in the connected library.', 404)
    const sources = await client
      .from('novel_sources')
      .select('url,contents_data,url_aliases')
      .eq('novel_id', book.data.novel_id)
    if (sources.error) throw sources.error
    const source = sources.data.find(
      (source) =>
        source.url === sourceUrl || (source.contents_data as { url?: string })?.url === sourceUrl,
    )
    const links = uniqueChapterLinks(input.contents.url, input.contents.links).map((link) => ({
      ...link,
      url: canonicalChapterUrl(link.url, source?.url_aliases),
    }))
    const contents = discoverContents(
      { ...input.contents, links },
      { chapterLinks: [], chapterCount: null, indexUrl: null },
    )
    const catalog = catalogMetadataSchema.safeParse(book.data.catalog_metadata)
    if (catalog.success && [book.data.source_url, catalog.data.canonicalUrl].includes(sourceUrl))
      contents.reportedCount = catalog.data.inspection.chapterCount
    const saved = await client.rpc('save_source_contents', {
      target_book: input.bookId,
      source_url: sourceUrl,
      contents: contents as unknown as Json,
    })
    if (saved.error)
      throw new ExperimentError(
        'The discovered contents could not be saved to this source. Refresh the library and retry.',
        saved.error.code === 'P0002' ? 404 : 502,
      )
    return { saved: saved.data, foundCount: contents.foundCount }
  } finally {
    release()
  }
}

export async function downloadedSourceUrls(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
) {
  const input = z
    .object({ bookId: z.string().regex(/^[a-f0-9]{32}$/), sourceUrl: z.string().url() })
    .strict()
    .parse(payload)
  const access = await acquireAILibrary(token, configuration, 0)
  try {
    const book = await access.client
      .from('books')
      .select('novel_id')
      .eq('id', input.bookId)
      .single()
    if (book.error) throw new ExperimentError('Book not found in this library.', 404)
    const sources = await access.client
      .from('novel_sources')
      .select('id,url,role,contents_data,url_aliases')
      .eq('novel_id', book.data.novel_id)
    if (sources.error) throw sources.error
    const url = publicPageUrl(input.sourceUrl)
    const source = sources.data.find(
      (source) => source.url === url || (source.contents_data as { url?: string })?.url === url,
    )
    if (!source || source.role === 'metadata' || isNovelUpdatesSeries(url))
      throw new ExperimentError('Choose a saved reading source.', 404)
    const urls: string[] = []
    for (let offset = 0; ; offset += 1000) {
      const page = await access.client
        .from('source_chapters')
        .select('url')
        .eq('source_id', source.id)
        .order('url')
        .range(offset, offset + 999)
      if (page.error) throw page.error
      urls.push(...page.data.map((chapter) => chapter.url))
      if (page.data.length < 1000) break
    }
    return { urls, aliases: source.url_aliases }
  } finally {
    access.release()
  }
}

export async function saveRenderedSourceChapter(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
) {
  const input = z
    .object({
      bookId: z.string().regex(/^[a-f0-9]{32}$/),
      sourceUrl: z.string().url(),
      page: capturedPageSchema.optional(),
      requestedUrl: capturedPageSchema.shape.url.optional(),
      confirmed: z.boolean().default(false),
    })
    .strict()
    .refine(
      (input) => Boolean(input.page || input.requestedUrl),
      'Select a chapter URL or a rendered chapter page.',
    )
    .parse(payload)
  const access = await acquireAILibrary(token, configuration, 0)
  let sourceId: string
  let chapterUrl = input.page?.url ?? input.requestedUrl!
  try {
    const book = await access.client
      .from('books')
      .select('novel_id')
      .eq('id', input.bookId)
      .single()
    if (book.error) throw new ExperimentError('Book not found.', 404)
    const sources = await access.client
      .from('novel_sources')
      .select('id,url,contents_data,url_aliases')
      .eq('novel_id', book.data.novel_id)
    if (sources.error) throw sources.error
    const source = sources.data.find(
      (source) =>
        source.url === input.sourceUrl ||
        (source.contents_data as { url?: string })?.url === input.sourceUrl,
    )
    if (!source) throw new ExperimentError('Pair and scan this reading source first.', 404)
    sourceId = source.id
    if (!input.page) chapterUrl = canonicalChapterUrl(chapterUrl, source.url_aliases)
    if (
      input.page &&
      input.requestedUrl &&
      publicPageUrl(input.requestedUrl) !== publicPageUrl(input.page.url)
    ) {
      const requested = publicPageUrl(input.requestedUrl)
      const known = canonicalChapterUrl(requested, source.url_aliases)
      const inventory = catalogMetadataSchema.shape.contents.parse(source.contents_data)
      const canonical = resolveChapterDestination(known, input.page.url, inventory?.chapters ?? [])
      if (known === requested) {
        const recorded = await access.client.rpc('record_source_chapter_alias', {
          target_source: source.id,
          requested_url: requested,
          canonical_url: canonical,
        })
        if (recorded.error) throw new ExperimentError(recorded.error.message, 409)
      }
    }
  } finally {
    access.release()
  }
  const result = await downloadSourceChapter(
    token,
    { sourceId, url: chapterUrl, page: input.page, confirmed: input.confirmed },
    configuration,
  )
  return result.state === 'ready'
    ? {
        state: result.state,
        title: result.chapter.title,
        cached: result.cached,
        canonicalUrl: result.record.url,
      }
    : { ...result, canonicalUrl: publicPageUrl(chapterUrl) }
}

export async function pairIdentifiedEdition(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
) {
  const input = pairLibraryRequestSchema.parse(payload)
  const { client, release } = await acquireAILibrary(token, configuration, 0)
  try {
    const captured = await client
      .from('page_identifications')
      .select('source_url')
      .eq('id', input.recordId)
      .single()
    if (captured.error) throw new ExperimentError('Identification not found in this library.', 404)
    if (!isNovelUpdatesSeries(captured.data.source_url))
      throw new ExperimentError(
        'Reading sources are separate library books. Add this source to the library instead of pairing it.',
      )
    const attached = await client.rpc('attach_novelupdates', {
      target_book: input.bookId,
      catalog_url: captured.data.source_url,
    })
    if (attached.error) throw new ExperimentError(attached.error.message, 400)
    const source = await client
      .from('novel_sources')
      .select('id,novel_id,url')
      .eq('id', attached.data)
      .single()
    if (source.error) throw source.error
    return pairedLibrarySourceSchema.parse({
      bookId: input.bookId,
      novelId: source.data.novel_id,
      sourceId: source.data.id,
      url: source.data.url,
      alreadyPaired: false,
    })
  } finally {
    release()
  }
}

export async function addIdentifiedNovel(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
) {
  const input = addNovelRequestSchema.parse(payload)
  const { client, release } = await acquireAILibrary(token, configuration, 0)
  try {
    const record = await client
      .from('page_identifications')
      .select('source_url,metadata')
      .eq('id', input.recordId)
      .single()
    if (record.error)
      throw new ExperimentError(
        'This identification is not available in the connected library. Analyze the page again.',
        404,
      )
    const inspection = novelInspectionSchema.strip().parse(record.data.metadata)
    if (
      input.contents &&
      new URL(publicPageUrl(input.contents.url)).origin !== new URL(record.data.source_url).origin
    )
      throw new ExperimentError('The contents page must belong to the identified site.')
    const contents = input.contents ? discoverContents(input.contents, inspection) : {}
    const saved = await client.rpc('add_source_book', {
      identification: input.recordId,
      reviewed_title: input.title,
      reviewed_author: input.author,
      contents_data: contents as unknown as Json,
      reference_sources: input.referenceVersions as unknown as Json,
      overwrite_existing: input.overwrite,
      novel_updates_url: (input.novelUpdatesUrl ?? null) as unknown as string,
    })
    if (saved.error)
      throw new ExperimentError(
        'The novel could not be saved. Your existing library has not been changed.',
        502,
      )
    return addedNovelSchema.parse(saved.data)
  } finally {
    release()
  }
}

export async function attachNovelUpdates(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
) {
  const input = z
    .object({ bookId: z.string().regex(/^[a-f0-9]{32}$/), url: z.string().url().max(2048) })
    .strict()
    .parse(payload)
  if (!isNovelUpdatesSeries(input.url)) throw new ExperimentError('Use a Novel Updates series URL.')
  const { client, release } = await acquireAILibrary(token, configuration, 0)
  try {
    const result = await client.rpc('attach_novelupdates', {
      target_book: input.bookId,
      catalog_url: input.url,
    })
    if (result.error) throw new ExperimentError(result.error.message, 400)
    return { sourceId: result.data }
  } finally {
    release()
  }
}
