import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/supabase/database.types.ts'
import { readerIndexRequestSchema, type ReaderChatContext, type ReaderIndexStatus } from '../../src/lib/reader/chat.ts'
import { chapterTranslationSchema, glossarySourcesSchema, sourceChapters } from '../../src/lib/translation/context.ts'
import { precedingReferenceChapters, type ReferenceChapter } from '../../src/lib/translation/references.ts'
import { sameGlossaryLanguage } from '../../src/lib/translation/glossary.ts'
import { storedSourceChapter } from '../sources/chapters.ts'
import { acquireAILibrary, ExperimentError, type AIConfiguration } from './experiments.ts'
import { chapters as importedChapters, chapterText } from './translation.ts'
import { savedTranslationChapters } from './continuity.ts'

type Client = SupabaseClient<Database>
type Document = { bookId: string; sourceId?: string; key: string; variant: string; position: number; title: string; hash: string; versionId?: string }
type IndexedDocument = Database['public']['Tables']['reader_search_documents']['Row']
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex')
const documentKey = (document: Document) => JSON.stringify([document.bookId, document.key, document.variant])
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
export function searchWords(text: string) {
  const normalized = text.normalize('NFKC')
  const words = [...segmenter.segment(normalized)].filter(segment => segment.isWordLike).map(segment => segment.segment)
  for (const match of normalized.matchAll(/\p{Script=Han}{2,}/gu)) {
    const characters = [...match[0]]
    for (let index = 0; index < characters.length - 1; index++) words.push(characters[index] + characters[index + 1])
  }
  return [...new Set(words)]
}

export function searchChunks(text: string) {
  const chunks: { index: number; start: number; end: number; text: string }[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 2400)
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n\n', end)
      if (paragraph > start + 1200) end = paragraph
      else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
    }
    chunks.push({ index: chunks.length, start, end, text: searchWords(text.slice(start, end)).join(' ') })
    if (end === text.length) break
    start = end - 160
    if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start--
  }
  if (chunks.length > 1024) throw new ExperimentError('This chapter is too large for the reading search index.')
  return chunks
}

async function bookPlan(client: Client, bookId: string, selectedSourceId?: string) {
  const book = await client.from('books').select('id,novel_id,format,language').eq('id', bookId).single()
  if (book.error) throw new ExperimentError('Book not found in this library.', 404)
  const sources = await client.from('novel_sources').select('*').eq('novel_id', book.data.novel_id).neq('role', 'metadata')
  if (sources.error) throw sources.error
  const source = selectedSourceId ? sources.data.find(source => source.id === selectedSourceId) : sources.data.find(source => source.book_id === bookId)
  if (selectedSourceId && !source) throw new ExperimentError('This reading source is unavailable.', 404)
  const listing = book.data.format === 'WEB' || (source && source.book_id !== bookId)
    ? source ? sourceChapters({ id: bookId, chapters: [] }, source) : []
    : await importedChapters(client, bookId)
  return { book: book.data, source, listing }
}

async function planDocuments(client: Client, plan: Awaited<ReturnType<typeof bookPlan>>, eligible: ReferenceChapter[], language: string) {
  const documents: Document[] = []
  const positions = new Map(eligible.map(chapter => [chapter.key, chapter]))
  const common = { bookId: plan.book.id, sourceId: plan.source?.id }
  if (eligible[0]?.key.startsWith('local:')) {
    for (const chapter of eligible) documents.push({ ...common, ...chapter, variant: 'original', hash: fingerprint(`${plan.book.id}:${chapter.key}`) })
  } else if (plan.source) {
    for (let offset = 0; ; offset += 1000) {
      const page = await client.from('source_chapters').select('url,content_hash,title').eq('source_id', plan.source.id).order('url').range(offset, offset + 999)
      if (page.error) throw page.error
      for (const row of page.data) {
        const chapter = positions.get(row.url)
        if (chapter) documents.push({ ...common, ...chapter, title: row.title || chapter.title, variant: 'original', hash: row.content_hash })
      }
      if (page.data.length < 1000) break
    }
  }
  if (eligible.length) {
    const translations = await savedTranslationChapters(client, plan.book.id, plan.source?.id, eligible, Math.max(...eligible.map(chapter => chapter.position)) + 1, language)
    for (const chapter of translations) documents.push({ ...common, ...chapter, variant: `translation:${language}` })
  }
  return documents
}

async function retrievalPlan(client: Client, input: ReaderChatContext) {
  const settings = await client.from('book_translation_settings').select('main_source_id,reference_source_id,reference_book_id,target_language,glossary_sources').eq('book_id', input.bookId).maybeSingle()
  if (settings.error) throw settings.error
  const main = await bookPlan(client, input.bookId, input.sourceId ?? settings.data?.main_source_id ?? undefined)
  const current = main.listing.find(chapter => chapter.key === input.sourceKey)
  if (!current) throw new ExperimentError('Choose a saved chapter before using reading search.')
  const language = settings.data?.target_language ?? 'en'
  const documents = await planDocuments(client, main, main.listing.filter(chapter => chapter.position <= current.position), language)
  let referenceBookId = settings.data?.reference_book_id ?? undefined
  if (settings.data?.reference_source_id) {
    const reference = await client.from('novel_sources').select('book_id').eq('id', settings.data.reference_source_id).maybeSingle()
    if (reference.error) throw reference.error
    referenceBookId = reference.data?.book_id ?? undefined
  }
  if (referenceBookId && referenceBookId !== input.bookId) {
    const reference = await bookPlan(client, referenceBookId, settings.data?.reference_source_id ?? undefined)
    documents.push(...await planDocuments(client, reference, precedingReferenceChapters(current, reference.listing), language))
  }
  return { documents, current, novelId: main.book.novel_id, language, sourceLanguage: main.source?.language || main.book.language, glossarySources: glossarySourcesSchema.parse(settings.data?.glossary_sources ?? []) }
}

async function indexedDocuments(client: Client, documents: Document[]) {
  const bookIds = [...new Set(documents.map(document => document.bookId))]
  const records: IndexedDocument[] = []
  if (!bookIds.length) return records
  for (let offset = 0; ; offset += 1000) {
    const page = await client.from('reader_search_documents').select('*').in('book_id', bookIds).order('id').range(offset, offset + 999)
    if (page.error) throw page.error
    records.push(...page.data)
    if (page.data.length < 1000) return records
  }
}

async function documentText(client: Client, ownerId: string, document: Document) {
  if (document.versionId) {
    const row = await client.from('book_translation_previews').select('result').eq('book_id', document.bookId).eq('id', document.versionId).single()
    if (row.error) throw row.error
    return chapterTranslationSchema.parse(row.data.result).paragraphs.join('\n\n')
  }
  if (document.key.startsWith('local:')) return chapterText(client, ownerId, document.bookId, document.position)
  if (!document.sourceId) throw new ExperimentError('Reading source is unavailable.')
  const stored = await storedSourceChapter(client, document.sourceId, document.key)
  if (!stored || stored.record.content_hash !== document.hash) throw new ExperimentError('Chapter text changed. Reopen chat to refresh the search index.', 409)
  return stored.chapter.paragraphs.join('\n\n')
}

export async function prepareReaderIndex(access: Awaited<ReturnType<typeof acquireAILibrary>>, input: ReaderChatContext): Promise<ReaderIndexStatus> {
  const { client, ownerId } = access
  const { documents } = await retrievalPlan(client, input)
  const indexed = await indexedDocuments(client, documents)
  const existing = new Map(indexed.map(document => [JSON.stringify([document.book_id, document.source_key, document.variant]), document]))
  const pending = documents.filter(document => {
    const stored = existing.get(documentKey(document))
    return stored?.content_hash !== document.hash || stored.chapter_position !== document.position || stored.title !== document.title || stored.source_id !== (document.sourceId ?? null)
  })
  const batch = pending.slice(0, 40)
  for (let offset = 0; offset < batch.length; offset += 4) {
    await Promise.all(batch.slice(offset, offset + 4).map(async document => {
      const text = await documentText(client, ownerId, document)
      const result = await client.rpc('index_reader_document', {
        target_book: document.bookId, reading_source: (document.sourceId ?? null) as unknown as string, chapter_key: document.key, variant_key: document.variant,
        chapter_index: document.position, chapter_title: document.title, translation_version: (document.versionId ?? null) as unknown as string,
        fingerprint: document.hash, chunks: searchChunks(text),
      })
      if (result.error) throw result.error
    }))
  }
  const current = batch.length ? await indexedDocuments(client, documents) : indexed
  const wanted = new Map(documents.map(document => [documentKey(document), document.hash]))
  const ready = current.filter(document => wanted.get(JSON.stringify([document.book_id, document.source_key, document.variant])) === document.content_hash)
  return { chapters: new Set(documents.map(document => `${document.bookId}:${document.key}`)).size, indexedChapters: new Set(ready.map(document => `${document.book_id}:${document.source_key}`)).size, passages: ready.reduce((count, document) => count + document.chunk_count, 0), remaining: Math.max(0, pending.length - batch.length), estimatedBytes: ready.reduce((bytes, document) => bytes + document.search_bytes + 256, 0) }
}

export async function runReaderIndex(token: string, payload: unknown, configuration: AIConfiguration) {
  const input = readerIndexRequestSchema.parse(payload)
  const access = await acquireAILibrary(token, configuration, 0)
  try { return await prepareReaderIndex(access, input) } finally { access.release() }
}

export async function retrieveReaderPassages(access: Awaited<ReturnType<typeof acquireAILibrary>>, input: ReaderChatContext, question: string) {
  const { client, ownerId } = access
  const plan = await retrievalPlan(client, input)
  const documents = plan.documents.filter(document => document.bookId !== input.bookId || document.key !== input.sourceKey)
  const desired = new Map(documents.map(document => [documentKey(document), document]))
  const indexed = (await indexedDocuments(client, documents)).filter(document => desired.get(JSON.stringify([document.book_id, document.source_key, document.variant]))?.hash === document.content_hash)
  if (!indexed.length) return []
  const aliases: string[] = []
  const selectedBooks = plan.glossarySources.length ? await client.from('books').select('id,novel_id').in('id', plan.glossarySources.map(source => source.bookId)) : null
  if (selectedBooks?.error) throw selectedBooks.error
  const selectedGlossaries = plan.glossarySources.flatMap(source => {
    const book = selectedBooks?.data?.find(book => book.id === source.bookId)
    return book ? [{ ...source, novelId: book.novel_id }] : []
  })
  for (let offset = 0; ; offset += 1000) {
    const glossary = await client.from('glossary_entries').select('scope,book_id,novel_id,chapter_position,source_term,target_term,source_language,target_language,aliases').eq('status', 'approved').or(`scope.eq.global,novel_id.in.(${[plan.novelId, ...selectedGlossaries.map(source => source.novelId)].join(',')})`).order('id').range(offset, offset + 999)
    if (glossary.error) throw glossary.error
    for (const term of glossary.data) {
      const applicable = term.scope === 'global' || (term.novel_id === plan.novelId && (term.scope !== 'chapter' || (term.book_id === input.bookId && term.chapter_position === plan.current.position))) || (term.scope === 'novel' && selectedGlossaries.some(source => source.novelId === term.novel_id && source.sourceLanguage === term.source_language && source.targetLanguage === term.target_language))
      if (applicable && sameGlossaryLanguage(term.source_language, plan.sourceLanguage) && sameGlossaryLanguage(term.target_language, plan.language) && question.normalize('NFKC').toLowerCase().includes(term.target_term.normalize('NFKC').toLowerCase())) aliases.push(term.source_term, ...term.aliases)
    }
    if (glossary.data.length < 1000) break
  }
  const terms = [...new Set(searchWords([...aliases, question].join(' ')))].filter(word => word.length <= 100).slice(0, 40)
  const hits = await client.rpc('search_reader_passages', { document_ids: indexed.map(document => document.id), query_terms: terms })
  if (hits.error) throw hits.error
  const texts = new Map<string, string>()
  const sources = []
  const chapterCounts = new Map<string, number>()
  for (const hit of hits.data) {
    const stored = indexed.find(document => document.id === hit.document_id)!
    const document = desired.get(JSON.stringify([stored.book_id, stored.source_key, stored.variant]))!
    const key = `${document.bookId}:${document.key}`
    if ((chapterCounts.get(key) ?? 0) >= 2) continue
    let text = texts.get(stored.id)
    if (text === undefined) { text = await documentText(client, ownerId, document); texts.set(stored.id, text) }
    sources.push({ id: `retrieved-${sources.length}`, key: document.key, bookId: document.bookId, title: document.title, text: text.slice(hit.start_offset, hit.end_offset), kind: document.variant === 'original' ? 'original' : 'translation', position: document.position })
    chapterCounts.set(key, (chapterCounts.get(key) ?? 0) + 1)
    if (sources.length === 6) break
  }
  return sources
}