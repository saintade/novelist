import type { LibraryBook } from '../books'
import { ensureSession, supabase } from '../supabase/client'
import { averageTranslationTimings, glossarySourcesSchema, type GlossarySourceSelection } from './context'
import type {
  Novel,
  NovelSource,
  GlossaryEntry,
  StyleProfile,
  StyleExample,
  TranslationRun,
  BookTranslationSettings,
  ChapterReferencePair,
  TranslationPreview,
} from './types'
export type {
  Novel,
  NovelSource,
  GlossaryEntry,
  StyleProfile,
  StyleExample,
  TranslationRun,
} from './types'
export type GlossaryScope = 'global' | 'novel' | 'chapter'
export const termCategories = [
  'person',
  'place',
  'organization',
  'rank',
  'technique',
  'item',
  'concept',
] as const

export interface TranslationWorkspace {
  novel: Novel
  sources: NovelSource[]
  contextSources: NovelSource[]
  glossary: GlossaryEntry[]
  profiles: StyleProfile[]
  examples: StyleExample[]
  runs: TranslationRun[]
  translationSettings: BookTranslationSettings | null
  chapterPairs: ChapterReferencePair[]
  previews: TranslationPreview[]
  timingAverages: ReturnType<typeof averageTranslationTimings>
}

function requireNovel(book: LibraryBook): string {
  if (!book.novelId) throw new Error('Reload this book to initialize its translation workspace.')
  return book.novelId
}

export async function getNovelSources(book: LibraryBook): Promise<NovelSource[]> {
  await ensureSession()
  const { data, error } = await supabase
    .from('novel_sources')
    .select('*')
    .eq('novel_id', requireNovel(book))
    .order('created_at')
  if (error) throw error
  return data
}

export async function attachBookCatalog(book: LibraryBook, url: string) {
  await ensureSession()
  const result = await supabase.rpc('attach_novelupdates', {
    target_book: book.id,
    catalog_url: url,
  })
  if (result.error) throw new Error(result.error.message)
  return result.data
}

export async function removeNovelSource(
  book: LibraryBook,
  sourceId: string,
): Promise<{ warning?: string }> {
  const ownerId = await ensureSession()
  requireNovel(book)
  const removed = await supabase.rpc('remove_novel_source', {
    target_book: book.id,
    target_source: sourceId,
  })
  if (removed.error) throw new Error(removed.error.message)
  const paths = removed.data.filter((path) => path.startsWith(`${ownerId}/sources/${sourceId}/`))
  for (let offset = 0; offset < paths.length; offset += 100) {
    const deleted = await supabase.storage.from('library').remove(paths.slice(offset, offset + 100))
    if (deleted.error)
      return { warning: 'Source removed, but some private chapter files could not be cleaned up.' }
  }
  return {}
}

export async function getLibraryReadingSources(): Promise<NovelSource[]> {
  await ensureSession()
  const sources: NovelSource[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await supabase
      .from('novel_sources')
      .select('*')
      .neq('role', 'metadata')
      .not('book_id', 'is', null)
      .order('id')
      .range(offset, offset + 999)
    if (page.error) throw page.error
    sources.push(...page.data)
    if (page.data.length < 1000) return sources
  }
}

async function getTranslationTimingAverages(bookId: string) {
  const records: Parameters<typeof averageTranslationTimings>[0] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await supabase.from('book_translation_previews').select('kind,model,target_language,input_tokens,output_tokens,timings:context->timings').eq('book_id', bookId).eq('kind', 'chapter').neq('model', 'manual edit').is('context->manualEdit', null).not('context->timings', 'is', null).order('id').range(offset, offset + 999)
    if (page.error) throw page.error
    records.push(...page.data.map(record => ({ ...record, context: { timings: record.timings } })))
    if (page.data.length < 1000) return averageTranslationTimings(records)
  }
}

export async function getTranslationWorkspace(book: LibraryBook): Promise<TranslationWorkspace> {
  await ensureSession()
  const novelId = requireNovel(book)
  const [novel, sources, profiles, runs, examples, settings, previews, contextSources, timingAverages] =
    await Promise.all([
      supabase.from('novels').select('*').eq('id', novelId).single(),
      supabase.from('novel_sources').select('*').eq('novel_id', novelId).order('created_at'),
      supabase.from('style_profiles').select('*').order('name'),
      supabase
        .from('translation_runs')
        .select('*')
        .eq('book_id', book.id)
        .order('created_at', { ascending: false })
        .limit(20),
      getStyleExamples(book),
      supabase.from('book_translation_settings').select('*').eq('book_id', book.id).maybeSingle(),
      supabase
        .from('book_translation_previews')
        .select('*')
        .eq('book_id', book.id)
        .order('created_at', { ascending: false })
        .limit(10),
      getLibraryReadingSources(),
      getTranslationTimingAverages(book.id),
    ])
  if (novel.error) throw novel.error
  if (sources.error) throw sources.error
  if (profiles.error) throw profiles.error
  if (runs.error) throw runs.error
  if (settings.error) throw settings.error
  if (previews.error) throw previews.error
  const chapterPairs: ChapterReferencePair[] = []
  if (settings.data?.reference_book_id)
    for (let offset = 0; ; offset += 1000) {
      const page = await supabase
        .from('chapter_reference_pairs')
        .select('*')
        .eq('book_id', book.id)
        .eq('reference_book_id', settings.data.reference_book_id)
        .order('source_key')
        .order('reference_position')
        .range(offset, offset + 999)
      if (page.error) throw page.error
      chapterPairs.push(...page.data)
      if (page.data.length < 1000) break
    }
  const glossary: GlossaryEntry[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('glossary_entries')
      .select('*')
      .or(`scope.eq.global,novel_id.eq.${novelId}`)
      .order('source_term')
      .order('id')
      .range(offset, offset + 999)
    if (error) throw error
    glossary.push(...data)
    if (data.length < 1000) break
  }
  return {
    novel: novel.data,
    sources: sources.data,
    contextSources: contextSources.filter((source) => source.book_id !== book.id),
    profiles: profiles.data,
    examples,
    runs: runs.data,
    glossary,
    translationSettings: settings.data,
    chapterPairs,
    previews: previews.data,
    timingAverages,
  }
}

export async function saveTranslationSettings(
  bookId: string,
  input: {
    targetLanguage: string
    referenceBookId: string | null
    referenceMode: 'same_novel' | 'style_only' | 'continuation'
    mainSource: string | null
    metadataSource: string | null
    referenceSourceId?: string | null
  },
  revision: number,
) {
  await ensureSession()
  const result = await supabase.rpc('set_source_translation_settings', {
    target_book: bookId,
    target_language: input.targetLanguage,
    reference_book: input.referenceBookId as string,
    reference_mode: input.referenceMode,
    expected_revision: revision,
    main_source: input.mainSource as string,
    metadata_source: input.metadataSource as string,
    reference_source: (input.referenceSourceId ?? null) as string,
  })
  if (result.error)
    throw new Error(
      result.error.code === '40001'
        ? 'Translation settings changed. Refresh before saving.'
        : result.error.message,
    )
}

export async function saveContextPreferences(
  bookId: string,
  revision: number,
  options: {
    tokenBudget: number
    recentChapters: number
    automatic: boolean
    interval: number
    feedback: string
  },
) {
  await ensureSession()
  const result = await supabase.rpc('set_context_preferences', {
    target_book: bookId,
    expected_revision: revision,
    token_budget: options.tokenBudget,
    recent_count: options.recentChapters,
    auto_guide: options.automatic,
    update_interval: options.interval,
    feedback: options.feedback,
  })
  if (result.error) throw new Error(result.error.message)
}

export async function getLibraryGlossaries() {
  await ensureSession()
  const result = await supabase.rpc('list_library_glossaries')
  if (result.error) throw new Error(result.error.message)
  return result.data
}

export async function saveReaderModels(bookId: string, revision: number, translation: string, chat: string) {
  await ensureSession()
  const result = await supabase.rpc('set_reader_models', { target_book: bookId, expected_revision: revision, translation_choice: translation, chat_choice: chat })
  if (result.error) throw new Error(result.error.message)
}

export async function saveGlossarySources(bookId: string, revision: number, sources: GlossarySourceSelection[]) {
  await ensureSession()
  const result = await supabase.rpc('set_glossary_sources', { target_book: bookId, expected_revision: revision, selected_sources: glossarySourcesSchema.parse(sources) })
  if (result.error) throw new Error(result.error.message)
}

export async function saveChapterReferencePair(
  bookId: string,
  sourceKey: string,
  referenceBookId: string,
  positions: number[],
  revision: number,
) {
  await ensureSession()
  const result = await supabase.rpc('set_chapter_reference_pair', {
    target_book: bookId,
    chapter_key: sourceKey,
    reference_book: referenceBookId,
    positions,
    expected_revision: revision,
  })
  if (result.error) throw new Error(result.error.message)
}

export async function applyMetadataPreview(previewId: string) {
  await ensureSession()
  const result = await supabase.rpc('apply_book_metadata', { preview_id: previewId })
  if (result.error) throw new Error(result.error.message)
}

export interface GlossaryInput {
  sourceTerm: string
  targetTerm: string
  category: (typeof termCategories)[number]
  scope: GlossaryScope
  chapter: number
  sense: string
  notes: string
  aliases: string[]
  targetLanguage?: string
}

export async function getLibraryGlossary(targetLanguage: string): Promise<GlossaryEntry[]> {
  await ensureSession()
  const entries: GlossaryEntry[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await supabase
      .from('glossary_entries')
      .select('*')
      .eq('target_language', targetLanguage)
      .neq('status', 'rejected')
      .order('updated_at', { ascending: false })
      .order('id')
      .range(offset, offset + 999)
    if (page.error) throw page.error
    entries.push(...page.data)
    if (page.data.length < 1000) return entries
  }
}

export async function saveGlossaryEntry(
  book: LibraryBook,
  input: GlossaryInput,
  existing?: GlossaryEntry,
): Promise<void> {
  const ownerId = await ensureSession()
  if (!input.sourceTerm.trim() || !input.targetTerm.trim())
    throw new Error('Both terms are required.')
  if (
    input.scope === 'chapter' &&
    (!Number.isInteger(input.chapter) || input.chapter < 0 || input.chapter >= book.chapters.length)
  )
    throw new Error('Choose an available chapter.')
  const values = {
    owner_id: ownerId,
    novel_id: input.scope === 'global' ? null : requireNovel(book),
    book_id: input.scope === 'chapter' ? book.id : null,
    chapter_position: input.scope === 'chapter' ? input.chapter : null,
    scope: input.scope,
    source_term: input.sourceTerm.trim(),
    target_term: input.targetTerm.trim(),
    source_language: existing?.source_language ?? book.language,
    target_language: existing?.target_language ?? input.targetLanguage ?? 'en',
    category: input.category,
    sense: input.sense.trim(),
    notes: input.notes.trim(),
    aliases: [...new Set(input.aliases.map((alias) => alias.trim()).filter(Boolean))],
    status: existing?.status ?? 'approved',
  }
  const result = existing
    ? await supabase
        .from('glossary_entries')
        .update(values)
        .eq('id', existing.id)
        .eq('revision', existing.revision)
        .select('id')
    : await supabase.from('glossary_entries').insert(values).select('id')
  if (result.error?.code === '23505')
    throw new Error('An approved term already exists for this scope and meaning.')
  if (result.error) throw result.error
  if (!result.data?.length)
    throw new Error('This term changed elsewhere. Reload before editing it.')
}

export async function setGlossaryStatus(
  entry: GlossaryEntry,
  status: 'approved' | 'rejected',
): Promise<void> {
  await ensureSession()
  const { data, error } = await supabase
    .from('glossary_entries')
    .update({ status })
    .eq('id', entry.id)
    .eq('revision', entry.revision)
    .select('id')
  if (error?.code === '23505')
    throw new Error(
      'An approved term already exists. Edit it explicitly to change the preferred translation.',
    )
  if (error) throw error
  if (!data.length) throw new Error('This term changed elsewhere. Reload and try again.')
}

export async function removeGlossaryEntry(entry: GlossaryEntry): Promise<void> {
  await ensureSession()
  const { error } = await supabase
    .from('glossary_entries')
    .delete()
    .eq('id', entry.id)
    .eq('revision', entry.revision)
  if (error) throw error
}

export async function addNovelSource(
  book: LibraryBook,
  input: {
    label: string
    url: string
    language: string
    role: 'original' | 'reference'
    edition: string
  },
): Promise<void> {
  const ownerId = await ensureSession()
  const url = new URL(input.url)
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Use an HTTP or HTTPS source URL.')
  const { error } = await supabase.from('novel_sources').insert({
    owner_id: ownerId,
    novel_id: requireNovel(book),
    label: input.label.trim(),
    url: url.href,
    language: input.language,
    role: input.role,
    edition_label: input.edition.trim(),
  })
  if (error?.code === '23505') throw new Error('This source edition is already linked.')
  if (error) throw error
}

export async function saveStyleProfile(
  input: { name: string; instructions: string },
  existing?: StyleProfile,
): Promise<StyleProfile> {
  const ownerId = await ensureSession()
  const values = {
    owner_id: ownerId,
    name: input.name.trim(),
    instructions: input.instructions.trim(),
  }
  const result = existing
    ? await supabase
        .from('style_profiles')
        .update(values)
        .eq('id', existing.id)
        .eq('version', existing.version)
        .select()
        .single()
    : await supabase.from('style_profiles').insert(values).select().single()
  if (result.error)
    throw new Error(
      result.error.code === '23505'
        ? 'A profile with this name already exists.'
        : 'The style profile could not be saved. Reload and try again.',
    )
  return result.data
}

export async function assignStyleProfile(
  book: LibraryBook,
  profileId: string | null,
): Promise<void> {
  await ensureSession()
  const { error } = await supabase
    .from('novels')
    .update({ style_profile_id: profileId })
    .eq('id', requireNovel(book))
  if (error) throw error
}

export async function getStyleExamples(book: LibraryBook): Promise<StyleExample[]> {
  await ensureSession()
  const examples: StyleExample[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('style_examples')
      .select('*')
      .eq('novel_id', requireNovel(book))
      .order('created_at')
      .order('id')
      .range(offset, offset + 999)
    if (error) throw error
    examples.push(...data)
    if (data.length < 1000) return examples
  }
}

export async function uploadStyleExample(book: LibraryBook, file: File): Promise<StyleExample> {
  if (!file.name.toLowerCase().endsWith('.txt'))
    throw new Error('Choose a UTF-8 .txt chapter example.')
  if (file.size > 1_000_000) throw new Error('Each chapter example must be smaller than 1 MB.')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true })
      .decode(await file.arrayBuffer())
      .replace(/\r\n?/g, '\n')
      .trim()
  } catch {
    throw new Error('This file is not valid UTF-8 text.')
  }
  if (!text) throw new Error('This chapter example is empty.')
  if (text.length > 200_000) throw new Error('Each example can contain up to 200,000 characters.')
  if (text.includes('\0')) throw new Error('Choose a plain-text chapter example.')
  const ownerId = await ensureSession()
  const novelId = requireNovel(book)
  const bytes = new TextEncoder().encode(text)
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  const existing = await supabase
    .from('style_examples')
    .select('*')
    .eq('novel_id', novelId)
    .eq('content_hash', hash)
    .maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data) return existing.data
  const id = crypto.randomUUID()
  const path = `${ownerId}/${book.id}/style-example-${id}.txt`
  const stored = await supabase.storage
    .from('library')
    .upload(path, bytes, { contentType: 'text/plain', upsert: false })
  if (stored.error) throw new Error('The example could not be uploaded. Try again.')
  const result = await supabase
    .from('style_examples')
    .insert({
      id,
      owner_id: ownerId,
      novel_id: novelId,
      book_id: book.id,
      file_name: file.name.slice(0, 240),
      content_path: path,
      content_hash: hash,
      character_count: text.length,
    })
    .select('*')
    .single()
  if (result.error) {
    await supabase.storage.from('library').remove([path])
    if (result.error.code === '23505') {
      const duplicate = await supabase
        .from('style_examples')
        .select('*')
        .eq('novel_id', novelId)
        .eq('content_hash', hash)
        .single()
      if (duplicate.data) return duplicate.data
    }
    throw new Error('The example could not be saved. Try again.')
  }
  return result.data
}

export async function removeStyleExample(example: StyleExample): Promise<void> {
  await ensureSession()
  const stored = await supabase
    .from('style_examples')
    .select('content_path')
    .eq('id', example.id)
    .maybeSingle()
  if (stored.error) throw stored.error
  if (!stored.data) return
  const removed = await supabase.storage.from('library').remove([stored.data.content_path])
  if (removed.error) throw new Error('The example file could not be removed. Try again.')
  const result = await supabase.from('style_examples').delete().eq('id', example.id)
  if (result.error) throw new Error('The example record could not be removed. Try again.')
}

export async function downloadSourceFile(source: NovelSource): Promise<string> {
  await ensureSession()
  if (!source.original_path) throw new Error('This source has not been imported.')
  const { data, error } = await supabase.storage
    .from('library')
    .createSignedUrl(source.original_path, 60, { download: true })
  if (error) throw error
  return data.signedUrl
}
