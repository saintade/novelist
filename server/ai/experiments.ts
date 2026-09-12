import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { convert } from 'html-to-text'
import type { Database, Json } from '../../src/lib/supabase/database.types.ts'
import { experimentRequestSchema } from '../../src/lib/ai/contracts.ts'
import { resolveGlossary } from '../../src/lib/translation/glossary.ts'
import type { GlossaryEntry } from '../../src/lib/translation/types.ts'
import { extractWithOpenAI, fixtureExtraction, PROMPT_VERSION } from './extractor.ts'
import { modelRequestFailure } from './responses.ts'

export interface AIConfiguration {
  supabaseUrl: string
  publishableKey: string
  apiKey: string
  liveEnabled: boolean
  model: string
  translationModel?: string
  scraperModel?: string
  identificationModel?: string
  maxConcurrentRequests?: number
  maxRequestsPerHour?: number
  translationMaxAttempts?: number
  chatModel?: string
  groupOutputLimit?: number
  publicOrigin?: string
  allowedUserId?: string
  hosted?: boolean
  root: string
}

export class ExperimentError extends Error {
  status: number
  code?: string
  constructor(message: string, status = 400, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const limitsKey = Symbol.for('novelist.ai.request-limits')
const processLimits = globalThis as unknown as Record<symbol, {
  activeUsers: Map<string, number>
  requestsByUser: Map<string, { count: number; startedAt: number }>
} | undefined>
const { activeUsers, requestsByUser } = processLimits[limitsKey] ??= {
  activeUsers: new Map(),
  requestsByUser: new Map(),
}

export function localAILimits(configuration: AIConfiguration) {
  return {
    concurrency: Number.isInteger(configuration.maxConcurrentRequests) ? Math.max(1, Math.min(32, configuration.maxConcurrentRequests!)) : 8,
    hourlyRequests: Number.isInteger(configuration.maxRequestsPerHour) ? Math.max(0, configuration.maxRequestsPerHour!) : 0,
  }
}

export function fastModelReasoning(model: string) {
  return /^gpt-5(?:-nano|-mini)?(?:-20\d\d-\d\d-\d\d)?$/.test(model)
    ? { effort: 'minimal' as const }
    : model.startsWith('gpt-4') ? undefined : { effort: 'none' as const }
}

export async function authenticateAILibrary(token: string, configuration: AIConfiguration) {
  const client = createClient<Database>(configuration.supabaseUrl, configuration.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const user = await client.auth.getUser(token)
  if (user.error || !user.data.user)
    throw new ExperimentError('Your library session could not be verified.', 401)
  const ownerId = user.data.user.id
  if ((configuration.hosted && (!configuration.allowedUserId || user.data.user.is_anonymous)) || (configuration.allowedUserId && ownerId !== configuration.allowedUserId))
    throw new ExperimentError('This account is not allowed to access this private library.', 403)
  return { client, ownerId }
}

export async function acquireAILibrary(
  token: string,
  configuration: AIConfiguration,
  reservedRequests = 1,
) {
  const { client, ownerId } = await authenticateAILibrary(token, configuration)
  const limits = localAILimits(configuration)
  const active = activeUsers.get(ownerId) ?? 0
  if (active >= limits.concurrency)
    throw new ExperimentError(`All ${limits.concurrency} local AI slots are busy. Waiting for a request to finish.`, 429, 'local_capacity')
  const hour = 60 * 60 * 1000
  for (const [id, request] of requestsByUser)
    if (Date.now() - request.startedAt > hour) requestsByUser.delete(id)
  const requestCount = requestsByUser.get(ownerId) ?? { count: 0, startedAt: Date.now() }
  const reserveRequests = (count: number) => {
    if (limits.hourlyRequests && requestCount.count + count > limits.hourlyRequests)
      throw new ExperimentError(`The configured local AI limit is ${limits.hourlyRequests} requests per hour.`, 429)
    requestCount.count += count
    requestsByUser.set(ownerId, requestCount)
  }
  reserveRequests(reservedRequests)
  activeUsers.set(ownerId, active + 1)
  let released = false
  return { client, ownerId, reserveRequests, release: () => {
    if (released) return
    released = true
    const remaining = (activeUsers.get(ownerId) ?? 1) - 1
    if (remaining) activeUsers.set(ownerId, remaining)
    else activeUsers.delete(ownerId)
  } }
}

export async function runTermExperiment(
  token: string,
  payload: unknown,
  configuration: AIConfiguration,
): Promise<{ runId: string; terms: number }> {
  const input = experimentRequestSchema.parse(payload)
  if (input.mode === 'live' && (!configuration.liveEnabled || !configuration.apiKey))
    throw new ExperimentError(
      'Live OpenAI calls are disabled. Configure the server key and explicitly enable live experiments.',
      403,
    )
  const { client, ownerId, release } = await acquireAILibrary(token, configuration)
  let runId: string | undefined
  try {
    const book = await client.from('books').select('*').eq('id', input.bookId).single()
    if (book.error) throw new ExperimentError('Book not found in this library.', 404)
    if (!book.data.language.startsWith('zh'))
      throw new ExperimentError('This experiment currently accepts Chinese source chapters only.')
    const source = await client
      .from('novel_sources')
      .select('*')
      .eq('book_id', input.bookId)
      .single()
    if (source.error) throw new ExperimentError('This book has no imported source record.')
    if (source.data.rights_status === 'unreviewed')
      throw new ExperimentError('Review source permissions before running an AI experiment.')
    const chapter = await client
      .from('chapters')
      .select('*')
      .eq('book_id', input.bookId)
      .eq('position', input.chapter)
      .single()
    if (chapter.error) throw new ExperimentError('Chapter not found.', 404)
    if (!chapter.data.content_path.startsWith(`${ownerId}/${input.bookId}/`))
      throw new ExperimentError('Invalid source storage path.')
    const content = await client.storage.from('library').download(chapter.data.content_path)
    if (content.error) throw new ExperimentError('The chapter content could not be read.')
    if (content.data.size > 2_000_000)
      throw new ExperimentError('This chapter is too large for the extraction experiment.')
    const stored: unknown = JSON.parse(await content.data.text())
    if (
      !stored ||
      typeof stored !== 'object' ||
      !('html' in stored) ||
      typeof stored.html !== 'string'
    )
      throw new ExperimentError('The stored chapter is invalid.')
    const text = convert(stored.html, {
      wordwrap: false,
      selectors: [
        { selector: 'img', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } },
      ],
    })
    if (text.length > 18_000 || !text.trim())
      throw new ExperimentError(
        'Choose a chapter with 1-18,000 text characters for this bounded experiment.',
      )
    if (input.mode === 'fixture') {
      const fixture = await readFile(
        resolve(configuration.root, 'public/books/qinglan-crossing.zh.txt'),
        'utf8',
      )
      const expected = fixture.split(/^CHAPTER[^\n]*\n/gm).slice(1)[input.chapter]
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
      if (!expected || normalize(text) !== normalize(expected))
        throw new ExperimentError(
          'Fixture mode only accepts the unmodified Qinglan Crossing test chapters.',
        )
    }
    const novel = await client.from('novels').select('*').eq('id', book.data.novel_id).single()
    if (novel.error) throw novel.error
    const style = novel.data.style_profile_id
      ? await client
          .from('style_profiles')
          .select('*')
          .eq('id', novel.data.style_profile_id)
          .single()
      : null
    if (style?.error) throw style.error
    const glossary: GlossaryEntry[] = []
    for (let offset = 0; ; offset += 1000) {
      const page = await client
        .from('glossary_entries')
        .select('*')
        .eq('status', 'approved')
        .or(`scope.eq.global,novel_id.eq.${book.data.novel_id}`)
        .order('id')
        .range(offset, offset + 999)
      if (page.error) throw page.error
      glossary.push(...page.data)
      if (page.data.length < 1000) break
    }
    const applicable = resolveGlossary(glossary, {
      novelId: book.data.novel_id,
      bookId: input.bookId,
      chapter: input.chapter,
      sourceLanguage: book.data.language,
      targetLanguage: 'en',
    }).filter(
      (entry) =>
        text.includes(entry.source_term) || entry.aliases.some((alias) => text.includes(alias)),
    )
    if (applicable.length > 100)
      throw new ExperimentError(
        'This chapter needs more glossary context than the initial experiment supports.',
      )
    const context = {
      sourceLanguage: book.data.language,
      style: style?.data?.instructions ?? '',
      glossary: applicable.map((entry) => ({
        sourceTerm: entry.source_term,
        targetTerm: entry.target_term,
        sense: entry.sense,
      })),
    }
    const snapshot = {
      context,
      glossaryVersions: applicable.map((entry) => ({ id: entry.id, revision: entry.revision })),
      styleProfile: style?.data ?? null,
      sourceId: source.data.id,
      sourcePath: chapter.data.content_path,
    }
    const started = await client
      .from('translation_runs')
      .insert({
        owner_id: ownerId,
        novel_id: book.data.novel_id,
        book_id: input.bookId,
        chapter_position: input.chapter,
        kind: 'extract_terms',
        mode: input.mode,
        model: input.mode === 'fixture' ? 'fixture-terms-v1' : configuration.model,
        prompt_version: PROMPT_VERSION,
        input_hash: createHash('sha256').update(text).digest('hex'),
        context_snapshot: snapshot as unknown as Json,
      })
      .select('id')
      .single()
    if (started.error) throw started.error
    runId = started.data.id
    const output =
      input.mode === 'fixture'
        ? { result: fixtureExtraction(text), inputTokens: 0, outputTokens: 0 }
        : await extractWithOpenAI(text, context, {
            apiKey: configuration.apiKey,
            model: configuration.model,
          })
    const saved = await client.rpc('complete_term_extraction', {
      extraction_id: runId,
      extraction_result: output.result as unknown as Json,
      consumed_input: output.inputTokens,
      consumed_output: output.outputTokens,
    })
    if (saved.error) throw saved.error
    return { runId, terms: output.result.terms.length }
  } catch (failure) {
    const providerFailure = modelRequestFailure(failure)
    const message =
      failure instanceof ExperimentError
        ? failure.message
        : providerFailure
          ? providerFailure.message
        : 'The extraction failed. Check the source, model configuration, and server connection. No approval was applied.'
    if (runId)
      await client
        .from('translation_runs')
        .update({
          status: 'failed',
          error_message: message,
          completed_at: new Date().toISOString(),
        })
        .eq('id', runId)
    if (failure instanceof ExperimentError) throw failure
    throw new ExperimentError(message, providerFailure?.status ?? 502)
  } finally {
    release()
  }
}
