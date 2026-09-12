import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/supabase/database.types.ts'
import { identificationCost } from '../../src/lib/ai/pricing.ts'
import { modelRequestFailure } from './responses.ts'

export interface ModelTracking {
  client: SupabaseClient<Database>
  bookId?: string
  operation: string
  groupSize?: number
}

interface UsageResponse {
  id?: string
  status?: string | null
  incomplete_details?: { reason?: string | null } | null
  usage?: {
    input_tokens: number
    output_tokens: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  } | null
}

export async function trackModelResponse<Response extends UsageResponse>(
  model: string,
  tracking: ModelTracking | undefined,
  request: () => Promise<Response>,
): Promise<Response> {
  if (!tracking) return request()
  const inserted = await tracking.client
    .from('ai_request_usage')
    .insert({
      book_id: tracking.bookId,
      operation: tracking.operation,
      model,
      group_size: tracking.groupSize ?? 1,
    })
    .select('id')
    .single()
  if (inserted.error) throw new Error('AI usage could not be recorded. No model request was sent.')
  let response: Response
  try {
    response = await request()
  } catch (failure) {
    const classified = modelRequestFailure(failure)
    const saved = await tracking.client
      .from('ai_request_usage')
      .update({
        state: 'failed',
        error_code: classified?.code ?? 'unknown',
        finished_at: new Date().toISOString(),
      })
      .eq('id', inserted.data.id)
    if (saved.error)
      console.warn('AI usage outcome unavailable', {
        requestId: inserted.data.id,
        code: saved.error.code,
      })
    throw failure
  }
  const usage = response.usage
  const cost = identificationCost(
    model,
    {
      inputTokens: usage?.input_tokens ?? 0,
      cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
    },
    { basis: 'reported-usage', capturedCharacters: 0, usageKnown: Boolean(usage) },
  )
  const state =
    response.status === 'completed'
      ? 'completed'
      : response.status === 'incomplete'
        ? 'incomplete'
        : 'unknown'
  const saved = await tracking.client
    .from('ai_request_usage')
    .update({
      state,
      response_id: response.id,
      input_tokens: usage?.input_tokens ?? null,
      cached_input_tokens: usage?.input_tokens_details?.cached_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      estimated_usd: cost.estimatedUsd,
      error_code:
        response.incomplete_details?.reason === 'max_output_tokens'
          ? 'output_limit'
          : state === 'incomplete'
            ? 'incomplete_output'
            : '',
      finished_at: new Date().toISOString(),
    })
    .eq('id', inserted.data.id)
  if (saved.error)
    console.warn('AI usage outcome unavailable', {
      requestId: inserted.data.id,
      code: saved.error.code,
    })
  return response
}
