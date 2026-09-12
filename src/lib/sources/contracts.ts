import { z } from 'zod'
import { capturedPageSchema } from '../scraper/contracts.ts'
import type { Database } from '../supabase/database.types.ts'
import { extractedTermSchema } from '../ai/contracts.ts'

export type ReadingSource = Database['public']['Tables']['novel_sources']['Row']
export type SourceChapterRow = Database['public']['Tables']['source_chapters']['Row']

export const sourceChapterContentSchema = z.object({
  title: z.string().min(1).max(500),
  paragraphs: z.array(z.string().min(1).max(10_000)).min(1).max(2000),
})
export type SourceChapterContent = z.infer<typeof sourceChapterContentSchema>
export const sourceDownloadSchema = z
  .object({
    sourceId: z.string().uuid(),
    url: capturedPageSchema.shape.url,
    confirmed: z.boolean().default(false),
    page: capturedPageSchema.optional(),
  })
  .strict()
export type SourceDownloadRequest = z.input<typeof sourceDownloadSchema>
export const sourceExtractionSchema = sourceDownloadSchema
  .omit({ page: true })
  .extend({
    forceRegenerate: z.boolean().default(false),
  })
  .refine(
    (input) => !input.forceRegenerate || input.confirmed,
    'Confirm model use before rebuilding the scraper.',
  )
export type SourceExtractionRequest = z.input<typeof sourceExtractionSchema>
export type SourceExtractionResult =
  | {
      state: 'ready'
      url: string
      title: string
      paragraphs: string[]
      characters: number
      htmlCharacters: number
      strategy: string
      nextPageUrl: string | null
      warning?: string
    }
  | { state: 'needs_scraper' | 'needs_browser' | 'failed'; message: string }
export type SourceDownloadResult =
  | { state: 'ready'; chapter: SourceChapterContent; record: SourceChapterRow; cached: boolean }
  | { state: 'needs_scraper' | 'needs_browser'; message: string }

export const sourceAnalysisRequestSchema = z
  .object({
    bookId: z.string().regex(/^[a-f0-9]{32}$/),
    sourceUrl: capturedPageSchema.shape.url,
    referenceUrls: z.array(capturedPageSchema.shape.url).min(1).max(5),
    confirmed: z.literal(true),
  })
  .strict()
export const sourceAnalysisSchema = z.object({
  matches: z.array(z.object({ url: z.string().max(2048), reason: z.string().max(600) })).max(5),
  reason: z.string().max(1000),
  terms: z
    .array(extractedTermSchema.extend({ referenceQuote: z.string().min(1).max(500) }))
    .max(40),
})
export type SourceAnalysis = z.infer<typeof sourceAnalysisSchema>
