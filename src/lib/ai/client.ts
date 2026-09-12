import { ensureSession, supabase } from '../supabase/client'
import type { AIInputBudget, AIStatus } from './contracts'
import type { AIAdminOverview, aiAdminRequestSchema } from './admin'
import type { translationBatchRequestSchema, TranslationBatchResponse, TranslationBatchStatus } from '../translation/batches'
import type { Database } from '../supabase/database.types'
import type { ReaderChatContext, ReaderIndexStatus, readerChatRequestSchema } from '../reader/chat'
import type { z } from 'zod'
import type { translationTermEditSchema, termSuggestionRequestSchema, TermSuggestionResult } from '../translation/context'
import type {
  ChapterTranslation,
  MetadataResult,
  ReadingGuideResult,
  TranslationContext,
} from '../translation/context'

export class TranslationRequestError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'TranslationRequestError'
    this.status = status
  }
}

export async function suggestTranslationTerm(input: z.input<typeof termSuggestionRequestSchema>): Promise<{ suggestion: TermSuggestionResult; model: string; existingChoices: { source: string; target: string; sense: string }[]; relatedGlossary?: { source: string; target: string; category: string; status: string; scope: string; match: string; via: string; sense: string }[]; context?: { originalCharacters: number; translatedCharacters: number; relatedTerms: number }; usage: { inputTokens: number; outputTokens: number } }> {
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/term-suggestion', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(input) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'The term suggestion failed.')
  return result
}

export async function translationBatchTask(input: z.input<typeof translationBatchRequestSchema>): Promise<TranslationBatchResponse> {
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/translation-batch', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(input) })
  let result: TranslationBatchResponse & { error?: string }
  try { result = await response.json() } catch { throw new Error('The queue response was interrupted. Reload its status before retrying; no paid request was automatically replayed.') }
  if (!response.ok) throw new TranslationRequestError(result.error || 'The translation queue could not be updated.', response.status)
  return result
}

export async function editTranslationTerm(
  input: z.input<typeof translationTermEditSchema>,
): Promise<{ previewId: string; translation: ChapterTranslation }> {
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/translation-term', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify(input),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'The term could not be updated.')
  return result
}

export async function prepareReadingSearch(context: ReaderChatContext, signal?: AbortSignal): Promise<ReaderIndexStatus> {
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/reader-index', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify({ bookId: context.bookId, sourceKey: context.sourceKey, sourceId: context.sourceId }), signal,
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Reading search could not be prepared.')
  return result
}

export async function askReadingQuestion(input: z.input<typeof readerChatRequestSchema>): Promise<Database['public']['Tables']['reader_chat_turns']['Row']> {
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/reader-chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(input),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'The question could not be answered.')
  return result
}

export async function readingGuide(
  bookId: string,
  sourceKey: string,
  confirmed = false,
): Promise<ReadingGuideResult> {
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/reading-guide', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify({ bookId, sourceKey, confirmed }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'The reading guide could not be updated.')
  return result
}

export async function bookTranslationTask(input: {
  bookId: string
  action: 'context' | 'metadata' | 'translate'
  sourceKey?: string
  translateMetadata?: boolean
  confirmed?: boolean
  continuation?: boolean
  background?: boolean
  requestId?: string
  expectedRevision?: number
  retranslate?: boolean
}): Promise<{
  job?: TranslationBatchStatus
  context?: TranslationContext
  budget?: AIInputBudget
  usage?: { inputTokens: number; outputTokens: number }
  previewId?: string
  metadata?: MetadataResult
  translation?: ChapterTranslation
  termsSaved?: number
}> {
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/book-translation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify(input),
  })
  const result = await response.json()
  if (!response.ok) throw new TranslationRequestError(result.error || 'The translation request failed.', response.status)
  return result
}

export async function aiAdminTask(input: z.input<typeof aiAdminRequestSchema>): Promise<AIAdminOverview> {
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(input) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'AI usage could not be loaded.')
  return result
}

export async function getAIStatus(): Promise<AIStatus> {
  const response = await fetch('/api/ai/status')
  if (!response.ok) throw new Error('The local AI server is not available.')
  return response.json()
}

export async function inferStyle(
  bookId: string,
  exampleIds: string[],
  expectedProfileId: string | null,
): Promise<{ profileId: string }> {
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/infer-style', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify({ bookId, exampleIds, expectedProfileId, rightsConfirmed: true }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Style inference failed.')
  return result
}

export async function extractTerms(
  bookId: string,
  chapter: number,
  mode: 'fixture' | 'live',
): Promise<{ runId: string; terms: number }> {
  await ensureSession()
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new Error('The library session has expired.')
  const response = await fetch('/api/ai/extract-terms', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify({ bookId, chapter, mode }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'The extraction failed.')
  return result
}
