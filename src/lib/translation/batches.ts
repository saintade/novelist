import { z } from 'zod'
import type { Database } from '../supabase/database.types.ts'
import { translationTaskSchema } from './context.ts'

export const translationBatchRequestSchema = z
  .object({
    action: z.enum(['overview', 'plan', 'start', 'status', 'pause', 'resume', 'cancel']),
    bookId: translationTaskSchema.shape.bookId,
    batchId: z.string().uuid().optional(),
    requestId: z.string().uuid().optional(),
    from: z.number().int().min(1).max(20000).optional(),
    to: z.number().int().min(1).max(20000).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    expectedCount: z.number().int().min(1).max(20000).optional(),
    confirmed: z.boolean().default(false),
    retryFailed: z.boolean().default(false),
    chaptersPerRequest: z.number().int().min(1).max(10).default(1),
    readerRequest: z.boolean().default(false),
    retranslate: z.boolean().default(false),
    allUntranslated: z.boolean().default(false),
  })
  .strict()

export interface TranslationBatchOverview {
  total: number
  downloaded: number
  savedVersions: number
  defaultStart: number
  sourceId: string | null
  language: string
  model: string
  revision: number
  automaticGuide: boolean
  guideInterval: number
}

export interface TranslationBatchPlan extends TranslationBatchOverview {
  allUntranslated: boolean
  maxAttempts: number
  chaptersPerRequest: number
  outputTokenLimit: number
  from: number
  to: number
  count: number
  undownloadedCount: number
  missing: { position: number; title: string }[]
  missingCount: number
  savedCandidates: number
  estimatedUsd: number | null
  maximumUsd: number | null
  estimatedSeconds: number | null
  timingSamples: number
  maxModelRequests: number
}

export type TranslationBatch = Database['public']['Tables']['translation_batches']['Row']
export type TranslationBatchChapter =
  Database['public']['Tables']['translation_batch_chapters']['Row']
export interface TranslationBatchStatus {
  batch: TranslationBatch | null
  chapters: TranslationBatchChapter[]
}

export interface TranslationBatchResponse {
  overview?: TranslationBatchOverview
  plan?: TranslationBatchPlan
  status?: TranslationBatchStatus
}
