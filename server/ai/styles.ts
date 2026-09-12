import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { styleRequestSchema, validateStyleExamples } from '../../src/lib/ai/contracts.ts'
import type { Database, Json } from '../../src/lib/supabase/database.types.ts'
import {
  readingGuideRequestSchema,
  chapterTranslationSchema,
  sourceChapters,
  type ReadingGuideResult,
} from '../../src/lib/translation/context.ts'
import {
  precedingReferenceChapters,
  type ReferenceChapter,
} from '../../src/lib/translation/references.ts'
import type { NovelSource } from '../../src/lib/translation/types.ts'
import { storedSourceChapter } from '../sources/chapters.ts'
import { acquireAILibrary, ExperimentError, type AIConfiguration } from './experiments.ts'
import { inferStyleWithOpenAI, STYLE_PROMPT_VERSION } from './extractor.ts'
import { ContextBudgetError } from './budget.ts'
import { modelRequestFailure } from './responses.ts'
import { savedTranslationChapters } from './continuity.ts'

const readingGuideSchema = z.object({
  kind: z.literal('continuation'),
  referenceSourceId: z.string().uuid().nullable(),
  sourceId: z.string().uuid().optional(),
  targetLanguage: z.string(),
  chapters: z
    .array(z.object({ url: z.string().url(), hash: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['reference', 'translation']).default('reference'), versionId: z.string().uuid().optional(), title: z.string().optional(), position: z.number().int().optional() }))
    .min(1)
    .max(20_000),
})

export async function earlierDownloadedChapters(
  client: SupabaseClient<Database>,
  reference: NovelSource,
  source: ReferenceChapter,
) {
  const downloaded = new Map<string, string>()
  for (let offset = 0; ; offset += 1000) {
    const page = await client
      .from('source_chapters')
      .select('url,content_hash')
      .eq('source_id', reference.id)
      .order('url')
      .range(offset, offset + 999)
    if (page.error) throw page.error
    page.data.forEach((chapter) => downloaded.set(chapter.url, chapter.content_hash))
    if (page.data.length < 1000) break
  }
  return precedingReferenceChapters(source, sourceChapters({ id: '', chapters: [] }, reference))
    .filter((chapter) => downloaded.has(chapter.key))
    .map((chapter) => ({ ...chapter, hash: downloaded.get(chapter.key)! }))
}

export function compatibleReadingGuide(
  inference: Json,
  referenceId: string | undefined,
  targetLanguage: string,
  chapters: { key: string; hash: string; kind?: 'reference' | 'translation' }[],
  sourceId?: string,
) {
  const parsed = readingGuideSchema.safeParse(inference)
  const hashes = new Map(chapters.map((chapter) => [`${chapter.kind ?? 'reference'}:${chapter.key}`, chapter.hash]))
  return parsed.success &&
    parsed.data.referenceSourceId === (referenceId ?? null) &&
    (!sourceId || !parsed.data.sourceId || parsed.data.sourceId === sourceId) &&
    parsed.data.targetLanguage === targetLanguage &&
    parsed.data.chapters.every((chapter) => hashes.get(`${chapter.kind}:${chapter.url}`) === chapter.hash)
    ? parsed.data
    : null
}

export async function runReadingGuide(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
  libraryAccess?: Awaited<ReturnType<typeof acquireAILibrary>>,
): Promise<ReadingGuideResult> {
  const input = readingGuideRequestSchema.parse(payload)
  const { client, reserveRequests, release } =
    libraryAccess ?? (await acquireAILibrary(token, configuration, 0))
  try {
    const book = await client.from('books').select('id,novel_id').eq('id', input.bookId).single()
    if (book.error) throw new ExperimentError('Book not found in this library.', 404)
    const settings = await client
      .from('book_translation_settings')
      .select('*')
      .eq('book_id', input.bookId)
      .single()
    if (settings.error) throw new ExperimentError('Save translation settings first.')
    const selected = settings.data
    const sources = await client
      .from('novel_sources')
      .select('*')
      .or(
        `novel_id.eq.${book.data.novel_id}${selected.reference_source_id ? `,id.eq.${selected.reference_source_id}` : ''}`,
      )
    if (sources.error) throw sources.error
    const main = sources.data.find(
      (source) => source.id === selected.main_source_id && source.role !== 'metadata',
    )
    const reference = sources.data.find(
      (source) =>
        source.id === selected.reference_source_id &&
        source.role !== 'metadata' &&
        source.language.split(/[-_]/)[0] === selected.target_language.split(/[-_]/)[0],
    )
    const chapter =
      main &&
      sourceChapters({ id: book.data.id, chapters: [] }, main).find(
        (chapter) => chapter.key === input.sourceKey,
      )
    if (!chapter || !main || reference?.id === main.id)
      throw new ExperimentError('Select a chapter from this book to update its guide.')
    const translations = await savedTranslationChapters(client, book.data.id, main.id, sourceChapters({ id: book.data.id, chapters: [] }, main), chapter.position, selected.target_language)
    const eligible = [
      ...translations.slice(0, Math.max(0, translations.length - selected.recent_chapters)).map(candidate => ({ ...candidate, kind: 'translation' as const })),
      ...(reference ? await earlierDownloadedChapters(client, reference, chapter) : []).map(candidate => ({ ...candidate, kind: 'reference' as const })),
    ]
    const novel = await client
      .from('novels')
      .select('style_profile_id')
      .eq('id', book.data.novel_id)
      .single()
    if (novel.error) throw novel.error
    const profileId = novel.data.style_profile_id
    const profile = profileId
      ? await client
          .from('style_profiles')
          .select('instructions,inference')
          .eq('id', profileId)
          .single()
      : null
    if (profile?.error) throw profile.error
    const previous = profile?.data
      ? compatibleReadingGuide(
          profile.data.inference,
          selected.reference_source_id ?? undefined,
          selected.target_language,
          eligible,
          main.id,
        )
      : null
    const coverage = previous?.chapters ?? []
    const coveredUrls = new Set(coverage.map((chapter) => `${chapter.kind}:${chapter.url}`))
    const pending = eligible.filter((chapter) => !coveredUrls.has(`${chapter.kind}:${chapter.key}`))
    const previousFeedback =
      (profile?.data?.inference as { feedback?: string } | null)?.feedback ?? ''
    const feedbackChanged =
      selected.guide_feedback !== previousFeedback
    const history = await client
      .from('style_profiles')
      .select('id,instructions,inference,updated_at')
      .eq('inference->>bookId', book.data.id)
      .order('updated_at', { ascending: false })
      .limit(5)
    if (history.error) throw history.error
    const result = {
      profileId: previous ? profileId : null,
      covered: coverage.length,
      total: eligible.length,
      remaining: pending.length,
      updated: false,
      chapters: coverage,
      instructions: previous ? profile!.data!.instructions : '',
      history: history.data.map((profile) => ({
        id: profile.id,
        instructions: profile.instructions,
        createdAt: profile.updated_at,
        feedback: (profile.inference as { feedback?: string })?.feedback ?? '',
      })),
    }
    if (!input.confirmed || (!pending.length && !feedbackChanged)) return result
    if (!eligible.length)
      throw new ExperimentError(
        'No older translations or downloaded reference chapters are available before this chapter.',
      )
    if (!configuration.liveEnabled || !configuration.apiKey)
      throw new ExperimentError('Guide updates require enabled live AI and a server API key.', 403)
    const examples = []
    const included = []
    let characters = 0
    for (const candidate of pending.length ? pending.slice(0, 8) : eligible.slice(-3)) {
      let example: { id: string; fileName: string; text: string }
      if (candidate.kind === 'translation') {
        const saved = await client.from('book_translation_previews').select('result').eq('id', candidate.versionId).eq('book_id', book.data.id).single()
        const translation = chapterTranslationSchema.safeParse(saved.data?.result)
        if (saved.error || !translation.success) throw new ExperimentError('A saved translation changed. Reload before updating the guide.', 409)
        example = { id: candidate.versionId, fileName: `Generated translation / ${translation.data.title}`, text: translation.data.paragraphs.join('\n\n') }
      } else {
        const stored = await storedSourceChapter(client, reference!.id, candidate.key)
        if (!stored || stored.record.content_hash !== candidate.hash)
          throw new ExperimentError('Reference text changed. Reload before updating the guide.', 409)
        example = { id: stored.record.id, fileName: stored.chapter.title, text: stored.chapter.paragraphs.join('\n\n') }
      }
      const text = example.text
      if (characters + text.length > 32_000) {
        if (!examples.length)
          throw new ExperimentError(
            'This chapter exceeds the 32,000-character guide batch limit. No text was truncated.',
          )
        break
      }
      examples.push(example)
      if (!coveredUrls.has(`${candidate.kind}:${candidate.key}`))
        included.push({ url: candidate.key, hash: candidate.hash, kind: candidate.kind, title: candidate.title, position: candidate.position, ...(candidate.kind === 'translation' ? { versionId: candidate.versionId } : {}) })
      characters += text.length
    }
    reserveRequests(1)
    const output = await inferStyleWithOpenAI(
      examples,
      { ...configuration, tracking: { client, bookId: book.data.id, operation: 'reading_guide' } },
      previous ? profile!.data!.instructions : undefined,
      selected.guide_feedback,
    )
    const saved = await client.rpc('save_continuation_style', {
      target_book: book.data.id,
      reference_source: selected.reference_source_id as string,
      expected_revision: selected.revision,
      expected_profile: profileId as string,
      style_instructions: output.result.instructions,
      style_metadata: {
        kind: 'continuation',
        bookId: book.data.id,
        feedback: selected.guide_feedback,
        referenceSourceId: selected.reference_source_id,
        sourceId: main.id,
        recentChapters: selected.recent_chapters,
        targetLanguage: selected.target_language,
        chapters: [...coverage, ...included],
        previousProfileId: profileId,
        throughSourceKey: chapter.key,
        batchCharacters: characters,
        result: output.result,
        model: configuration.model,
        promptVersion: `${STYLE_PROMPT_VERSION}-continuation-v2`,
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens,
        createdAt: new Date().toISOString(),
      } as unknown as Json,
    })
    if (saved.error)
      throw new ExperimentError(
        'The settings or selected style changed. Reload before updating the guide again.',
        409,
      )
    return {
      profileId: saved.data,
      covered: coverage.length + included.length,
      total: eligible.length,
      remaining: pending.length - included.length,
      updated: true,
      chapters: [...coverage, ...included],
      instructions: output.result.instructions,
      history: [
        {
          id: saved.data,
          instructions: output.result.instructions,
          createdAt: new Date().toISOString(),
          feedback: selected.guide_feedback,
        },
        ...result.history,
      ].slice(0, 5),
    }
  } catch (failure) {
    if (failure instanceof ExperimentError) throw failure
    if (failure instanceof ContextBudgetError) throw new ExperimentError(failure.message, 413)
    const providerFailure = modelRequestFailure(failure)
    if (providerFailure) throw new ExperimentError(providerFailure.message, providerFailure.status)
    throw new ExperimentError(
      'The reading guide could not be updated. Your previous guide is unchanged.',
      502,
    )
  } finally {
    if (!libraryAccess) release()
  }
}

export async function runStyleInference(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
): Promise<{ profileId: string }> {
  const input = styleRequestSchema.parse(payload)
  if (!configuration.liveEnabled || !configuration.apiKey)
    throw new ExperimentError('Style inference requires a server API key and enabled live AI.', 403)
  const { client, ownerId, release } = await acquireAILibrary(token, configuration)
  try {
    const book = await client.from('books').select('novel_id').eq('id', input.bookId).single()
    if (book.error) throw new ExperimentError('Book not found in this library.', 404)
    const novel = await client
      .from('novels')
      .select('style_profile_id')
      .eq('id', book.data.novel_id)
      .single()
    if (novel.error) throw new ExperimentError('Novel not found in this library.', 404)
    if (novel.data.style_profile_id !== input.expectedProfileId)
      throw new ExperimentError('The selected style changed. Reload before inferring again.', 409)
    const sources = await client
      .from('style_examples')
      .select('*')
      .eq('novel_id', book.data.novel_id)
      .in('id', input.exampleIds)
      .order('id')
    if (sources.error || sources.data.length !== input.exampleIds.length)
      throw new ExperimentError(
        'Some selected examples are no longer available in this novel.',
        404,
      )
    const examples = await Promise.all(
      sources.data.map(async (source) => {
        if (source.content_path !== `${ownerId}/${source.book_id}/style-example-${source.id}.txt`)
          throw new ExperimentError('Invalid example storage path.')
        const file = await client.storage.from('library').download(source.content_path)
        if (file.error) throw new ExperimentError('An example could not be read. Upload it again.')
        if (file.data.size > 1_000_000)
          throw new ExperimentError('An example exceeds the upload limit.')
        const bytes = Buffer.from(await file.data.arrayBuffer())
        if (createHash('sha256').update(bytes).digest('hex') !== source.content_hash)
          throw new ExperimentError(
            'An example changed in storage. Upload it again before inferring.',
          )
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (text.length !== source.character_count)
          throw new ExperimentError('Invalid example metadata.')
        return { id: source.id, fileName: source.file_name, text }
      }),
    )
    try {
      validateStyleExamples(examples)
    } catch (failure) {
      throw new ExperimentError(
        failure instanceof Error ? failure.message : 'Invalid chapter examples.',
      )
    }
    const output = await inferStyleWithOpenAI(examples, { ...configuration, tracking: { client, bookId: input.bookId, operation: 'style_guide' } })
    const saved = await client.rpc('create_inferred_style', {
      target_book: input.bookId,
      expected_profile: input.expectedProfileId as string,
      example_ids: input.exampleIds,
      style_instructions: output.result.instructions,
      style_metadata: {
        model: configuration.model,
        promptVersion: STYLE_PROMPT_VERSION,
        examples: sources.data.map((source) => ({
          id: source.id,
          fileName: source.file_name,
          hash: source.content_hash,
          characters: source.character_count,
        })),
        result: output.result,
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens,
        createdAt: new Date().toISOString(),
      } as unknown as Json,
    })
    if (saved.error)
      throw new ExperimentError(
        'The profile could not be saved. Your style or examples may have changed; reload before retrying.',
        409,
      )
    return { profileId: saved.data }
  } catch (failure) {
    if (failure instanceof ExperimentError) throw failure
    if (failure instanceof ContextBudgetError) throw new ExperimentError(failure.message, 413)
    const providerFailure = modelRequestFailure(failure)
    if (providerFailure) throw new ExperimentError(providerFailure.message, providerFailure.status)
    throw new ExperimentError(
      'Style inference failed. Check the model configuration and try again. Your existing profile has not changed.',
      502,
    )
  } finally {
    release()
  }
}
