import { z } from 'zod'

export const outputLimits = { chapter: 16384, metadata: 8192, extraction: 12000, style: 8192, term: 4096 } as const

export class ModelResponseError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, code: string, status = 502) {
    super(message)
    this.name = 'ModelResponseError'
    this.code = code
    this.status = status
  }
}

interface StructuredResponse {
  status?: string
  output_text?: string
  incomplete_details?: { reason?: string } | null
  output?: { type: string; status?: string | null; content?: { type: string; text?: string }[] }[]
}

export function completedStructuredOutput<Schema extends z.ZodType>(response: StructuredResponse, schema: Schema, operation: string, outputLimit: number): z.output<Schema> {
  if (response.status === 'incomplete' || response.output?.some(item => item.type === 'message' && item.status === 'incomplete')) {
    const limited = response.incomplete_details?.reason === 'max_output_tokens'
    throw new ModelResponseError(limited
      ? `${operation} reached its ${outputLimit.toLocaleString('en-US')}-token output limit. The partial response was not saved.`
      : `${operation} returned incomplete output (${response.incomplete_details?.reason ?? 'unknown reason'}). Nothing from the partial response was saved.`, limited ? 'output_limit' : 'incomplete_output')
  }
  if (response.output?.some(item => item.content?.some(content => content.type === 'refusal')))
    throw new ModelResponseError(`The model declined ${operation.toLowerCase()}. No generated content was saved.`, 'refusal', 422)
  if (response.status !== 'completed')
    throw new ModelResponseError(`${operation} did not complete (${response.status ?? 'no completion status'}). No generated content was saved.`, 'incomplete_output')
  const text = response.output_text || response.output?.flatMap(item => item.type === 'message' ? item.content?.flatMap(content => content.type === 'output_text' ? [content.text ?? ''] : []) ?? [] : []).join('')
  if (!text) throw new ModelResponseError(`${operation} returned no structured result. No generated content was saved.`, 'empty_output')
  let value: unknown
  try { value = JSON.parse(text) } catch {
    throw new ModelResponseError(`${operation} returned invalid or cut-off JSON despite reporting completion. Nothing was saved.`, 'invalid_json')
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'result'))].slice(0, 3).join(', ')
    throw new ModelResponseError(`${operation} returned an invalid structured result (${fields}). Nothing was saved.`, 'invalid_schema')
  }
  return parsed.data
}

export function modelRequestFailure(failure: unknown): ModelResponseError | null {
  if (failure instanceof ModelResponseError) return failure
  if (!failure || typeof failure !== 'object') return null
  const error = failure as { name?: string; status?: number; code?: string }
  if (error.name === 'APIConnectionTimeoutError' || error.name === 'AbortError') return new ModelResponseError('The model request timed out. No completed translation was saved; provider usage may still have been charged.', 'timeout', 504)
  if (error.name === 'APIConnectionError') return new ModelResponseError('The connection to the model provider was interrupted. Provider usage may still have been charged.', 'connection', 502)
  if (['insufficient_quota', 'billing_hard_limit_reached', 'billing_limit_reached', 'usage_limit_reached', 'spend_limit_reached'].includes(error.code ?? '')) return new ModelResponseError('The model provider reported exhausted quota or a billing limit. Check OpenAI billing before resuming.', 'quota', 429)
  if (error.status === 429) return new ModelResponseError('The model provider rate-limited this request.', 'rate_limit', 429)
  if (error.status === 401 || error.status === 403) return new ModelResponseError('The model provider rejected the server credentials or model access. Check the configured API key and selected model on the server.', 'model_access', 502)
  if (error.status === 400 || error.status === 404) return new ModelResponseError('The model provider rejected the model or request options. Select a supported structured-output model and retry.', 'model_configuration', 422)
  if (typeof error.status === 'number' && error.status >= 500) return new ModelResponseError('The model provider is temporarily unavailable.', 'provider_unavailable', 502)
  return null
}