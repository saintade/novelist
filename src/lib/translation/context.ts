import { z } from 'zod'
import { replaceTermForm, translatedTermForms, translatedTermPattern } from './glossary.ts'
import { catalogMetadataSchema, novelInspectionSchema } from '../extension/contracts.ts'
import type { NovelSource } from './types.ts'
import { extractedTermSchema, validateExtraction } from '../ai/contracts.ts'
import { referenceChapters, type ReferenceChapter, type BookChapterListing } from './references.ts'

export function sourceChapters(book: BookChapterListing, source?: NovelSource): ReferenceChapter[] {
  if (!source || (source.book_id === book.id && book.chapters.length))
    return referenceChapters(book)
  const parsed = catalogMetadataSchema.shape.contents.safeParse(source.contents_data)
  const contents = parsed.success ? parsed.data : null
  if (!contents && source.book_id === book.id) return referenceChapters(book)
  return (contents?.chapters ?? []).map((chapter, position) => ({
    key: chapter.url,
    title: chapter.sourceTitle || chapter.title,
    position,
  }))
}
export const translationTaskSchema = z
  .object({
    bookId: z.string().regex(/^[a-f0-9]{32}$/),
    action: z.enum(['context', 'metadata', 'translate']),
    sourceKey: z.string().max(2048).optional(),
    translateMetadata: z.boolean().default(false),
    confirmed: z.boolean().default(false),
    continuation: z.boolean().default(false),
  })
  .strict()
export const readingGuideRequestSchema = z
  .object({
    bookId: translationTaskSchema.shape.bookId,
    sourceKey: z.string().min(1).max(2048),
    confirmed: z.boolean().default(false),
  })
  .strict()
export const translationTermEditSchema = z
  .object({
    previewId: z.string().uuid(),
    source: z.string().min(1).max(160),
    previous: z.string().min(1).max(200),
    preferred: z.string().trim().min(1).max(200),
    category: extractedTermSchema.shape.category,
    scope: z.enum(['novel', 'global']),
    sense: z.string().max(300).default(''),
    aliases: extractedTermSchema.shape.aliases.default([]),
  })
  .strict()
export const glossarySourcesSchema = z.array(z.object({
  bookId: translationTaskSchema.shape.bookId,
  sourceLanguage: z.string().min(2).max(35),
  targetLanguage: z.string().min(2).max(35),
}).strict()).max(32)
export type GlossarySourceSelection = z.infer<typeof glossarySourcesSchema>[number]
export const termSuggestionRequestSchema = z.object({
  bookId: translationTaskSchema.shape.bookId,
  sourceKey: z.string().min(1).max(2048),
  previewId: z.string().uuid().optional(),
  source: extractedTermSchema.shape.sourceTerm,
  currentTarget: z.string().max(200),
  targetLanguage: z.string().min(2).max(35),
  readerContext: z.string().trim().max(2000).default(''),
  confirmed: z.literal(true),
}).strict()
export const termSuggestionResultSchema = z.object({
  source: extractedTermSchema.shape.sourceTerm,
  target: extractedTermSchema.shape.targetTerm,
  category: extractedTermSchema.shape.category,
  sense: extractedTermSchema.shape.sense,
  aliases: extractedTermSchema.shape.aliases,
  evidenceQuote: extractedTermSchema.shape.evidenceQuote,
  explanation: z.string().min(1).max(1800),
  alternatives: z.array(z.object({ target: extractedTermSchema.shape.targetTerm, explanation: z.string().min(1).max(600) }).strict()).max(3),
  warnings: z.array(z.string().max(500)).max(5),
}).strict()
export type TermSuggestionResult = z.infer<typeof termSuggestionResultSchema>
export const translationTimingsSchema = z.object({ preparationMs: z.number().nonnegative(), guideMs: z.number().nonnegative(), modelMs: z.number().nonnegative() })

export function averageTranslationTimings(records: { kind: string; model: string | null; target_language: string; context: unknown; input_tokens: number; output_tokens: number }[]) {
  const groups = new Map<string, { model: string; language: string; samples: number; preparationMs: number; guideMs: number; modelMs: number; inputTokens: number; outputTokens: number }>()
  for (const record of records) {
    const parsed = z.object({ timings: translationTimingsSchema, manualEdit: z.unknown().optional() }).safeParse(record.context)
    if (record.kind !== 'chapter' || record.model === 'manual edit' || !parsed.success || parsed.data.manualEdit !== undefined) continue
    const key = JSON.stringify([record.model, record.target_language])
    const group = groups.get(key) ?? { model: record.model || 'Unknown model', language: record.target_language, samples: 0, preparationMs: 0, guideMs: 0, modelMs: 0, inputTokens: 0, outputTokens: 0 }
    group.samples++
    group.preparationMs += parsed.data.timings.preparationMs
    group.guideMs += parsed.data.timings.guideMs
    group.modelMs += parsed.data.timings.modelMs
    group.inputTokens += record.input_tokens
    group.outputTokens += record.output_tokens
    groups.set(key, group)
  }
  return [...groups.values()].map(group => ({ ...group, preparationMs: group.preparationMs / group.samples, guideMs: group.guideMs / group.samples, modelMs: group.modelMs / group.samples, inputTokens: group.inputTokens / group.samples, outputTokens: group.outputTokens / group.samples, totalMs: (group.preparationMs + group.guideMs + group.modelMs) / group.samples }))
}

export interface ReadingGuideResult {
  profileId: string | null
  covered: number
  total: number
  remaining: number
  updated: boolean
  instructions?: string
  chapters?: { url: string; hash: string; kind: 'reference' | 'translation'; title?: string; position?: number; versionId?: string }[]
  history?: { id: string; instructions: string; createdAt: string; feedback: string }[]
}
export const metadataResultSchema = z
  .object({
    title: z.string().min(1).max(500),
    author: z.string().min(1).max(300),
    synopsis: z.string().max(48000),
    coverAlt: z.string().max(500),
  })
  .strict()
export const chapterTranslationSchema = z
  .object({
    title: z.string().min(1).max(500),
    paragraphs: z.array(z.string().min(1).max(10000)).min(1).max(1000),
    terminology: z
      .array(
        z
          .object({
            source: z.string().max(200),
            target: z.string().max(200),
            category: extractedTermSchema.shape.category.optional(),
            sense: extractedTermSchema.shape.sense.optional(),
            evidenceQuote: extractedTermSchema.shape.evidenceQuote.optional(),
          })
          .strict(),
      )
      .max(80),
  })
  .strict()
export type MetadataResult = z.infer<typeof metadataResultSchema>
export const chapterGenerationSchema = chapterTranslationSchema.extend({
  terminology: z
    .array(
      z
        .object({
          source: extractedTermSchema.shape.sourceTerm,
          target: extractedTermSchema.shape.targetTerm,
          category: extractedTermSchema.shape.category,
          sense: extractedTermSchema.shape.sense,
          evidenceQuote: extractedTermSchema.shape.evidenceQuote,
        })
        .strict(),
    )
    .max(80),
})

export function validateChapterDraft(value: unknown, sourceText: string, warnings: string[] = []) {
  const parsed = chapterGenerationSchema.parse(value)
  const result = chapterGenerationSchema.parse({
    ...parsed,
    paragraphs: parsed.paragraphs
      .flatMap((paragraph) => paragraph.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n+/))
      .map((paragraph) => paragraph.trim())
      .filter(Boolean),
  })
  if (
    sourceText.split(/\n[\t ]*\n+/).filter((paragraph) => paragraph.trim()).length > 1 &&
    result.paragraphs.length < 2
  )
    throw new Error('The translation collapsed paragraph breaks. No version was saved.')
  const identities = new Set<string>()
  result.terminology = result.terminology.filter(term => {
    const identity = JSON.stringify([term.source, term.sense])
    try {
      validateExtraction({ terms: [{ sourceTerm: term.source, targetTerm: term.target, category: term.category, sense: term.sense, evidenceQuote: term.evidenceQuote, aliases: [] }], warnings: [] }, sourceText)
      if (!result.paragraphs.some(paragraph => translatedTermPattern([term.target]).test(paragraph)))
        throw new Error('The target spelling is absent from the translated paragraphs.')
      if (identities.has(identity)) throw new Error('A proposal for this spelling and meaning is already present.')
      identities.add(identity)
      return true
    } catch (failure) {
      warnings.push(`Terminology skipped for "${term.source}": ${failure instanceof Error ? failure.message : 'Unsupported evidence.'}`)
      return false
    }
  })
  return result
}

export type ChapterTranslation = z.infer<typeof chapterTranslationSchema>
export const chapterTermContextSchema = z.object({
  glossary: z.array(z.object({ source: z.string(), target: z.string(), sense: z.string().default(''), aliases: z.array(z.string()).default([]), category: extractedTermSchema.shape.category.optional() })).default([]),
  warnings: z.array(z.string()).default([]),
})

export function chapterTermInventory(translation: ChapterTranslation, sourceText: string, snapshot: unknown, targetLanguage = 'en') {
  const parsed = chapterTermContextSchema.safeParse(snapshot)
  const glossary = parsed.success ? parsed.data.glossary : []
  const terms = [...translation.terminology]
  for (const known of glossary) {
    const spelling = [known.source, ...known.aliases].find(spelling => spelling && sourceText.includes(spelling))
    if (spelling && !terms.some(term => term.source === spelling && term.target === known.target))
      terms.push({ source: spelling, target: known.target, sense: known.sense, category: known.category, evidenceQuote: spelling })
  }
  return terms.filter((term, position) => terms.findIndex(other => other.source === term.source && other.target === term.target) === position).map(term => {
    const known = glossary.find(known => known.source === term.source || known.aliases.includes(term.source))
    const forms = translatedTermForms(term, targetLanguage)
    const present = translation.paragraphs.some(paragraph => translatedTermPattern(forms).test(paragraph))
    const ambiguous = terms.some(other => other.target === term.target && other.source !== term.source)
    return { ...term, forms, state: known ? known.target === term.target ? 'established' as const : 'different' as const : 'new' as const, knownTarget: known?.target, present, ambiguous }
  })
}

export function replaceTranslatedTerm(
  translation: ChapterTranslation,
  source: string,
  previous: string,
  preferred: string,
  targetLanguage = 'en',
): ChapterTranslation {
  preferred = preferred.trim()
  if (!preferred || preferred.length > 200)
    throw new Error('Use a preferred translation between 1 and 200 characters.')
  const selected = translation.terminology.find((term) => term.source === source && term.target === previous)
  if (!selected)
    throw new Error('This terminology entry is no longer in the selected version.')
  if (translation.terminology.some(term => term.target === previous && term.source !== source))
    throw new Error('This translated label maps to multiple source terms. Save a glossary preference and retranslate instead of replacing every occurrence.')
  const pattern = translatedTermPattern(translatedTermForms(selected, targetLanguage))
  let changed = false
  const paragraphs = translation.paragraphs.map((paragraph) =>
    paragraph.replace(pattern, occurrence => {
      changed = true
      return replaceTermForm(previous, preferred, occurrence)
    }),
  )
  if (!changed) throw new Error('The complete term could not be found in this version.')
  return chapterTranslationSchema.parse({
    ...translation,
    paragraphs,
    terminology: translation.terminology.map((term) =>
      term.source === source && term.target === previous ? { ...term, target: preferred } : term,
    ),
  })
}

export interface RetrievedReference {
  sourceId?: string
  url?: string
  position: number
  title: string
  text: string
  truncated: boolean
  hash: string
}
export interface TranslationContext {
  targetLanguage: string
  settingsRevision: number
  source: {
    key: string
    title: string
    text: string | null
    hash: string | null
    language: string
    sourceId?: string
    storageHash?: string
  }
  referenceSource?: { id: string; label: string }
  referenceBook: { id: string; title: string } | null
  mode: 'same_novel' | 'style_only' | 'continuation'
  basis: string
  references: RetrievedReference[]
  recentTranslations?: RetrievedReference[]
  glossary: { source: string; target: string; sense: string; aliases?: string[] }[]
  terminologyMemory?: {
    source: string
    target: string
    sense: string
    match: 'exact' | 'alias' | 'similar'
    status: string
    novelId: string | null
  }[]
  style: string
  warnings: string[]
}
export function metadataFromInspection(value: unknown, fallback: MetadataResult): MetadataResult {
  const parsed = novelInspectionSchema.strip().safeParse(value)
  if (!parsed.success) return fallback
  return {
    title: parsed.data.title || fallback.title,
    author: parsed.data.author || fallback.author,
    synopsis: parsed.data.synopses.map((entry) => entry.text).join('\n\n') || fallback.synopsis,
    coverAlt: parsed.data.coverImage?.alt || '',
  }
}
