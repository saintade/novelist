import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/supabase/database.types.ts'
import {
  chapterTranslationSchema,
  type RetrievedReference,
  type TranslationContext,
} from '../../src/lib/translation/context.ts'
import type { ReferenceChapter } from '../../src/lib/translation/references.ts'
import { estimateInputBudget } from './budget.ts'
import { outputLimits } from './responses.ts'

export async function savedTranslationChapters(
  client: SupabaseClient<Database>,
  bookId: string,
  sourceId: string | undefined,
  chapters: ReferenceChapter[],
  currentPosition: number,
  language: string,
){
  const positions = new Map(
    chapters
      .filter((chapter) => chapter.position < currentPosition)
      .map((chapter) => [chapter.key, chapter.position]),
  )
  if (!positions.size) return []
  const latest = new Map<string, string>()
  for (let offset = 0; ; offset += 1000) {
    let query = client
      .from('book_translation_previews')
      .select('id,source_key')
      .eq('book_id', bookId)
      .eq('kind', 'chapter')
      .eq('target_language', language)
      .order('created_at', { ascending: false })
      .order('id')
      .range(offset, offset + 999)
    if (sourceId) query = query.eq('context->source->>sourceId', sourceId)
    const page = await query
    if (page.error) throw page.error
    for (const row of page.data)
      if (row.source_key && positions.has(row.source_key) && !latest.has(row.source_key))
        latest.set(row.source_key, row.id)
    if (page.data.length < 1000) break
  }
  return [...latest]
    .sort((first, second) => positions.get(first[0])! - positions.get(second[0])!)
    .map(([key, versionId]) => ({
      ...chapters.find(chapter => chapter.key === key)!,
      versionId,
      hash: createHash('sha256').update(`translation:${versionId}`).digest('hex'),
    }))
}

export async function recentBookTranslations(
  client: SupabaseClient<Database>,
  bookId: string,
  sourceId: string | undefined,
  chapters: ReferenceChapter[],
  currentPosition: number,
  language: string,
  count: number,
): Promise<RetrievedReference[]> {
  const selected = (await savedTranslationChapters(client, bookId, sourceId, chapters, currentPosition, language))
    .slice(-count)
  if (!selected.length) return []
  const saved = await client
    .from('book_translation_previews')
    .select('id,result')
    .in(
      'id',
      selected.map(chapter => chapter.versionId),
    )
  if (saved.error) throw saved.error
  return selected.flatMap(({ key, versionId, position }) => {
    const parsed = chapterTranslationSchema.safeParse(
      saved.data.find((row) => row.id === versionId)?.result,
    )
    if (!parsed.success) return []
    const text = parsed.data.paragraphs.join('\n\n')
    return [
      {
        sourceId,
        url: key,
        position,
        versionId,
        title: parsed.data.title,
        text,
        hash: createHash('sha256').update(text).digest('hex'),
        truncated: false,
      },
    ]
  })
}

export function fitTranslationContext(
  context: TranslationContext,
  format: unknown,
  model: string,
  contextLimit: number,
) {
  const fitted: TranslationContext = {
    ...context,
    references: [...context.references],
    recentTranslations: [...(context.recentTranslations ?? [])],
    warnings: [...context.warnings],
  }
  let budget = estimateInputBudget(fitted, format, outputLimits.chapter, model, contextLimit)
  let omitted = 0
  while (budget.compactionRecommended) {
    if (
      fitted.references.length &&
      context.basis !== 'confirmed' &&
      (fitted.references.length > 1 || fitted.recentTranslations!.length)
    )
      fitted.references.shift()
    else if (fitted.recentTranslations!.length > 1) fitted.recentTranslations!.shift()
    else break
    omitted++
    budget = estimateInputBudget(fitted, format, outputLimits.chapter, model, contextLimit)
  }
  if (omitted)
    fitted.warnings.push(
      `${omitted} older context chapters omitted to keep the rolling window within its budget. Their saved text is unchanged; the compact guide and glossary are retained.`,
    )
  return {
    context: fitted,
    budget: estimateInputBudget(fitted, format, outputLimits.chapter, model, contextLimit),
    omitted,
  }
}
