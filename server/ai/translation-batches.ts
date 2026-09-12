import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '../../src/lib/supabase/database.types.ts'
import {
  averageTranslationTimings,
  sourceChapters,
  translationTaskSchema,
} from '../../src/lib/translation/context.ts'
import {
  translationBatchRequestSchema,
  type TranslationBatchOverview,
  type TranslationBatchPlan,
  type TranslationBatchResponse,
  type TranslationBatchStatus,
} from '../../src/lib/translation/batches.ts'
import { textModelPrices } from '../../src/lib/ai/pricing.ts'
import {
  acquireAILibrary,
  authenticateAILibrary,
  ExperimentError,
  type AIConfiguration,
} from './experiments.ts'
import { chapters, runBookTranslation } from './translation.ts'
import { outputLimits } from './responses.ts'
import { groupModelOutputLimit, runTranslationGroup } from './grouped-translation.ts'

type Client = SupabaseClient<Database>

async function catalog(client: Client, bookId: string, configuration: AIConfiguration) {
  const [book, settings, progress] = await Promise.all([
    client.from('books').select('id').eq('id', bookId).single(),
    client.from('book_translation_settings').select('*').eq('book_id', bookId).maybeSingle(),
    client.from('reading_progress').select('chapter').eq('book_id', bookId).maybeSingle(),
  ])
  if (book.error) throw new ExperimentError('Book not found in this library.', 404)
  if (settings.error) throw settings.error
  if (!settings.data)
    throw new ExperimentError(
      'Save translation settings for this book before translating a range.',
      422,
    )
  const selected = settings.data
  const source = await (
    selected.main_source_id
      ? client.from('novel_sources').select('*').eq('id', selected.main_source_id)
      : client.from('novel_sources').select('*').eq('book_id', bookId)
  )
    .neq('role', 'metadata')
    .maybeSingle()
  if (source.error) throw source.error
  if (selected.main_source_id && !source.data)
    throw new ExperimentError('The saved chapter source is unavailable.', 404)
  const local = !source.data || source.data.book_id === bookId ? await chapters(client, bookId) : []
  const listing = local.length
    ? local
    : source.data
      ? sourceChapters({ id: bookId, chapters: [] }, source.data)
      : []
  const downloaded = new Map<string, string | null>(local.map((chapter) => [chapter.key, null]))
  if (!local.length && source.data)
    for (let offset = 0; ; offset += 1000) {
      const page = await client
        .from('source_chapters')
        .select('url,content_hash')
        .eq('source_id', source.data.id)
        .order('url')
        .range(offset, offset + 999)
      if (page.error) throw page.error
      for (const chapter of page.data) downloaded.set(chapter.url, chapter.content_hash)
      if (page.data.length < 1000) break
    }
  const saved = new Set<string>()
  for (let offset = 0; ; offset += 1000) {
    let query = client
      .from('book_translation_previews')
      .select('source_key,storage_hash:context->source->>storageHash')
      .eq('book_id', bookId)
      .eq('kind', 'chapter')
      .eq('target_language', selected.target_language)
      .order('id')
      .range(offset, offset + 999)
    if (source.data) query = query.eq('context->source->>sourceId', source.data.id)
    const page = await query
    if (page.error) throw page.error
    for (const preview of page.data)
      if (
        preview.source_key &&
        (!preview.storage_hash || preview.storage_hash === downloaded.get(preview.source_key))
      )
        saved.add(preview.source_key)
    if (page.data.length < 1000) break
  }
  const model = selected.translation_model || configuration.translationModel || configuration.model
  const firstMissing =
    listing.find(
      (chapter) => chapter.position >= (progress.data?.chapter ?? 0) && !saved.has(chapter.key),
    ) ?? listing.find((chapter) => !saved.has(chapter.key))
  const overview: TranslationBatchOverview = {
    total: listing.length,
    downloaded: listing.filter((chapter) => downloaded.has(chapter.key)).length,
    savedVersions: listing.filter((chapter) => saved.has(chapter.key)).length,
    defaultStart: firstMissing
      ? firstMissing.position + 1
      : Math.max(1, Math.min(listing.length, (progress.data?.chapter ?? 0) + 1)),
    sourceId: source.data?.id ?? null,
    language: selected.target_language,
    model,
    revision: selected.revision,
    automaticGuide: selected.guide_auto_update,
    guideInterval: selected.guide_interval,
  }
  return { overview, selected, listing, downloaded, saved }
}

async function planRange(
  client: Client,
  bookId: string,
  from: number,
  to: number,
  configuration: AIConfiguration,
  chaptersPerRequest = 1,
  allUntranslated = false,
): Promise<TranslationBatchPlan> {
  const current = await catalog(client, bookId, configuration)
  if (allUntranslated) {
    from = 1
    to = current.listing.length
  }
  if (to < from || to > 20000 || (!allUntranslated && to - from >= 1000))
    throw new ExperimentError('Choose an inclusive range of up to 1,000 chapters.', 422)
  if (to > current.listing.length)
    throw new ExperimentError("The range exceeds this book's saved chapter inventory.", 422)
  const selected = current.listing.slice(from - 1, to)
  const missing = selected.filter((chapter) => !current.downloaded.has(chapter.key))
  const timings = await client
    .from('book_translation_previews')
    .select('kind,model,target_language,input_tokens,output_tokens,timings:context->timings')
    .eq('book_id', bookId)
    .eq('kind', 'chapter')
    .eq('model', current.overview.model)
    .eq('target_language', current.overview.language)
    .is('context->manualEdit', null)
    .not('context->timings', 'is', null)
    .order('created_at', { ascending: false })
    .limit(100)
  if (timings.error) throw timings.error
  const average = averageTranslationTimings(
    timings.data.map((record) => ({ ...record, context: { timings: record.timings } })),
  )[0]
  const price = textModelPrices.find((price) => price.model === current.overview.model)
  const guidePrice = textModelPrices.find((price) => price.model === configuration.model)
  const outputTokenLimit =
    chaptersPerRequest > 1
      ? groupModelOutputLimit(current.overview.model, configuration.groupOutputLimit)
      : outputLimits.chapter
  const maxAttempts = configuration.translationMaxAttempts ?? 3
  const count = selected.length
  const estimatedUsd =
    price && average
      ? (count * (average.inputTokens * price.input + average.outputTokens * price.output)) /
        1000000
      : null
  const maximumUsd =
    price && (!current.overview.automaticGuide || guidePrice)
      ? (count *
          maxAttempts *
          (current.selected.context_tokens * price.input +
            outputTokenLimit * price.output +
            (current.overview.automaticGuide && guidePrice
              ? (128000 - outputLimits.style) * guidePrice.input +
                outputLimits.style * guidePrice.output
              : 0))) /
        1000000
      : null
  return {
    ...current.overview,
    allUntranslated,
    maxAttempts,
    chaptersPerRequest,
    outputTokenLimit,
    from,
    to,
    count,
    missing: missing
      .slice(0, 10)
      .map((chapter) => ({ position: chapter.position, title: chapter.title })),
    missingCount: missing.length,
    savedCandidates: selected.filter((chapter) => current.saved.has(chapter.key)).length,
    estimatedUsd,
    maximumUsd,
    estimatedSeconds: average ? (average.totalMs * count) / 1000 : null,
    timingSamples: average?.samples ?? 0,
    maxModelRequests: count * maxAttempts * (current.overview.automaticGuide ? 2 : 1),
  }
}

export class TranslationBatchManager {
  private configuration: AIConfiguration
  private retryDelayMs: number
  private runtime: {
    stopping: boolean
    workers: Map<string, { token: string; ownerId: string; promise: Promise<void> }>
  }
  private get stopping() {
    return this.runtime.stopping
  }
  private set stopping(value: boolean) {
    this.runtime.stopping = value
  }
  private get workers() {
    return this.runtime.workers
  }

  constructor(
    configuration: AIConfiguration,
    retryDelayMs = 5000,
    previous?: TranslationBatchManager,
  ) {
    this.configuration = configuration
    this.retryDelayMs = retryDelayMs
    this.runtime = previous?.runtime ?? { stopping: false, workers: new Map() }
  }

  stop() {
    this.stopping = true
  }

  async drain() {
    await Promise.all([...this.workers.values()].map((worker) => worker.promise))
  }

  async wait(batchId: string) {
    await this.workers.get(batchId)?.promise
  }

  async refreshAuthorization(token: string) {
    const { client, ownerId } = await authenticateAILibrary(token, this.configuration)
    for (const worker of this.workers.values()) if (worker.ownerId === ownerId) worker.token = token
    if (this.stopping || !this.configuration.liveEnabled || !this.configuration.apiKey)
      return { resumed: 0 }
    const eligible = await client
      .from('translation_batches')
      .select('id,book_id')
      .eq('resume_automatically', true)
      .in('state', ['running', 'paused', 'failed'])
      .order('created_at')
      .limit(50)
    if (eligible.error) throw eligible.error
    let resumed = 0
    for (const candidate of eligible.data) {
      if (this.workers.has(candidate.id)) continue
      const current = await this.status(client, candidate.book_id, candidate.id)
      const batch = current.batch!
      if (
        !['paused', 'failed'].includes(batch.state) ||
        !['server_restart', 'worker_interrupted'].includes(batch.last_error_code)
      )
        continue
      if (
        current.chapters.some(
          (chapter) =>
            ['running', 'failed'].includes(chapter.state) && chapter.attempts >= batch.max_attempts,
        )
      )
        continue
      try {
        await this.launch(token, ownerId, client, batch.id, true)
        resumed += 1
      } catch (failure) {
        if (failure instanceof ExperimentError && failure.message.includes('preferences changed')) {
          const stopped = await client
            .from('translation_batches')
            .update({
              state: 'failed',
              resume_automatically: false,
              last_error_code: 'settings_changed',
              error: failure.message,
            })
            .eq('id', batch.id)
            .is('worker_id', null)
          if (stopped.error) throw stopped.error
        }
      }
    }
    return { resumed }
  }

  private async status(
    client: Client,
    bookId: string,
    batchId?: string,
  ): Promise<TranslationBatchStatus> {
    let query = client.from('translation_batches').select('*').eq('book_id', bookId)
    if (batchId) query = query.eq('id', batchId)
    else query = query.eq('request_kind', 'bulk')
    const result = await query.order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (result.error) throw result.error
    if (!result.data) {
      if (batchId) throw new ExperimentError('Translation batch not found in this book.', 404)
      return { batch: null, chapters: [] }
    }
    let batch = result.data
    if (batch.worker_id && Date.parse(batch.lease_expires_at ?? '') <= Date.now()) {
      const recovered = await client.rpc('control_translation_batch', {
        target_batch: batch.id,
        command: 'status',
      })
      if (recovered.error) throw recovered.error
      const updated = await client
        .from('translation_batches')
        .select('*')
        .eq('id', batch.id)
        .single()
      if (updated.error) throw updated.error
      batch = updated.data
    }
    const chapters: TranslationBatchStatus['chapters'] = []
    for (let offset = 0; ; offset += 1000) {
      const items = await client
        .from('translation_batch_chapters')
        .select('*')
        .eq('batch_id', batch.id)
        .order('position')
        .range(offset, offset + 999)
      if (items.error) throw items.error
      chapters.push(...items.data)
      if (items.data.length < 1000) break
    }
    return { batch, chapters }
  }

  async startChapter(token: string, payload: unknown): Promise<TranslationBatchResponse> {
    const input = translationTaskSchema
      .extend({
        action: z.literal('translate'),
        background: z.literal(true),
        requestId: z.string().uuid(),
        expectedRevision: z.number().int().nonnegative(),
        retranslate: z.boolean().default(false),
      })
      .parse(payload)
    if (!input.confirmed)
      throw new ExperimentError('Confirm billable translation before starting.', 403)
    const { client } = await authenticateAILibrary(token, this.configuration)
    const current = await catalog(client, input.bookId, this.configuration)
    const chapter = current.listing.find((chapter) => chapter.key === input.sourceKey)
    if (!chapter)
      throw new ExperimentError("The chapter is not in this book's saved source inventory.", 404)
    return this.handle(token, {
      action: 'start',
      bookId: input.bookId,
      from: chapter.position + 1,
      to: chapter.position + 1,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      confirmed: true,
      chaptersPerRequest: 1,
      readerRequest: true,
      retranslate: input.retranslate,
    })
  }

  async handle(token: string, payload: unknown): Promise<TranslationBatchResponse> {
    const input = translationBatchRequestSchema.parse(payload)
    if (
      (input.readerRequest &&
        (input.from !== input.to || input.chaptersPerRequest !== 1 || input.allUntranslated)) ||
      (input.retranslate && !input.readerRequest)
    )
      throw new ExperimentError('Reader translation jobs must contain exactly one chapter.', 422)
    if (['pause', 'resume', 'cancel'].includes(input.action) && !input.batchId)
      throw new ExperimentError('Choose the saved queue to update.', 422)
    const { client, ownerId } = await authenticateAILibrary(token, this.configuration)
    for (const worker of this.workers.values()) if (worker.ownerId === ownerId) worker.token = token
    if (input.action === 'overview' || input.action === 'status')
      await this.refreshAuthorization(token)
    if (input.action === 'overview')
      return {
        overview: (await catalog(client, input.bookId, this.configuration)).overview,
        status: await this.status(client, input.bookId),
      }
    if (input.action === 'plan') {
      if ((!input.from || !input.to) && !input.allUntranslated)
        throw new ExperimentError('Choose a chapter range.', 422)
      return {
        plan: await planRange(
          client,
          input.bookId,
          input.from ?? 1,
          input.to ?? 1,
          this.configuration,
          input.chaptersPerRequest,
          input.allUntranslated,
        ),
      }
    }
    if (input.action === 'start') {
      if (!input.confirmed || !input.requestId || !input.from || !input.to)
        throw new ExperimentError('Review the range and confirm billable model use.', 403)
      const existing = await client
        .from('translation_batches')
        .select(
          'id,book_id,range_start,range_end,chapters_per_request,retranslate,request_kind,all_untranslated',
        )
        .eq('id', input.requestId)
        .maybeSingle()
      if (existing.error) throw existing.error
      if (existing.data) {
        if (
          existing.data.book_id !== input.bookId ||
          existing.data.range_start !== input.from ||
          existing.data.range_end !== input.to ||
          existing.data.chapters_per_request !== input.chaptersPerRequest ||
          existing.data.retranslate !== input.retranslate ||
          existing.data.request_kind !== (input.readerRequest ? 'reader' : 'bulk') ||
          existing.data.all_untranslated !== input.allUntranslated
        )
          throw new ExperimentError('Request ID belongs to a different range.', 409)
        return { status: await this.status(client, input.bookId, input.requestId) }
      }
      const plan = await planRange(
        client,
        input.bookId,
        input.from,
        input.to,
        this.configuration,
        input.chaptersPerRequest,
        input.allUntranslated,
      )
      if (plan.from !== input.from || plan.to !== input.to)
        throw new ExperimentError('The chapter inventory changed. Review the job again.', 409)
      if (plan.missingCount)
        throw new ExperimentError('Download every chapter in this range first.', 422)
      if (plan.revision !== input.expectedRevision)
        throw new ExperimentError('Translation preferences changed. Review the range again.', 409)
      if (!this.configuration.liveEnabled || !this.configuration.apiKey)
        throw new ExperimentError('Enable the local AI server before starting translations.', 403)
      const created = input.allUntranslated
        ? await client.rpc('create_untranslated_translation_batch', {
            request_id: input.requestId,
            target_book: input.bookId,
            chapter_count: plan.to,
            expected_revision: plan.revision,
            chosen_model: plan.model,
            cost_estimate: plan as unknown as Json,
            maximum_group_size: input.chaptersPerRequest,
          })
        : input.readerRequest
          ? await client.rpc('create_reader_translation_batch', {
              request_id: input.requestId,
              target_book: input.bookId,
              chapter_position: input.from,
              expected_revision: plan.revision,
              chosen_model: plan.model,
              cost_estimate: plan as unknown as Json,
              new_version: input.retranslate,
            })
          : await client.rpc('create_grouped_translation_batch', {
              request_id: input.requestId,
              target_book: input.bookId,
              range_start: input.from,
              range_end: input.to,
              expected_revision: plan.revision,
              chosen_model: plan.model,
              cost_estimate: plan as unknown as Json,
              maximum_group_size: input.chaptersPerRequest,
            })
      if (created.error)
        throw new ExperimentError(
          created.error.code === '23505'
            ? 'This book already has an open translation queue. Resume or cancel it first.'
            : created.error.message,
          409,
        )
      if (created.data === input.requestId) {
        const preferences = await client
          .from('translation_batches')
          .update({ max_attempts: this.configuration.translationMaxAttempts ?? 3 })
          .eq('id', created.data)
        if (preferences.error) throw preferences.error
        await this.launch(token, ownerId, client, created.data, false)
      }
      return { status: await this.status(client, input.bookId, created.data) }
    }
    const current = await this.status(client, input.bookId, input.batchId)
    if (!current.batch) return { status: current }
    const batch = current.batch
    const worker = this.workers.get(batch.id)
    if (worker?.ownerId === ownerId) worker.token = token
    if (input.action === 'pause' || input.action === 'cancel') {
      const controlled = await client.rpc('control_translation_batch', {
        target_batch: batch.id,
        command: input.action,
      })
      if (controlled.error) throw controlled.error
    } else if (input.action === 'resume') {
      if (!input.confirmed)
        throw new ExperimentError('Confirm billable model use before resuming.', 403)
      if (!this.configuration.liveEnabled || !this.configuration.apiKey)
        throw new ExperimentError('Enable the local AI server before resuming translations.', 403)
      if (worker) throw new ExperimentError('This queue still has an active worker.', 409)
      const resumed = await client
        .from('translation_batches')
        .update({ resume_automatically: true, retry_at: null })
        .eq('id', batch.id)
      if (resumed.error) throw resumed.error
      await this.launch(token, ownerId, client, batch.id, input.retryFailed)
    }
    return { status: await this.status(client, input.bookId, batch.id) }
  }

  private async launch(
    token: string,
    ownerId: string,
    client: Client,
    batchId: string,
    retryFailed: boolean,
  ) {
    if (this.stopping)
      throw new ExperimentError(
        'The server is restarting. Resume this saved queue after it returns.',
        503,
      )
    const workerId = randomUUID()
    const claim = await client.rpc('claim_translation_batch', {
      target_batch: batchId,
      worker_key: workerId,
      retry_failed: retryFailed,
    })
    if (claim.error) throw new ExperimentError(claim.error.message, 409)
    const state = { token, ownerId, promise: Promise.resolve() }
    this.workers.set(batchId, state)
    state.promise = this.process(batchId, workerId, state)
      .catch(async (failure) => {
        const message =
          failure instanceof ExperimentError
            ? failure.message
            : 'The queue could not continue. Completed chapters are kept; review before retrying.'
        try {
          const failed = await client.rpc('fail_translation_batch', {
            target_batch: batchId,
            worker_key: workerId,
            failure_message: message,
          })
          if (failed.error)
            console.warn('Translation queue could not record failure', {
              batchId,
              code: failed.error.code,
            })
        } catch {
          console.warn('Translation queue lost its database connection', { batchId })
        }
      })
      .finally(() => {
        this.workers.delete(batchId)
      })
  }

  private async process(batchId: string, workerId: string, state: { token: string }) {
    while (true) {
      let access: Awaited<ReturnType<typeof acquireAILibrary>>
      try {
        access = await acquireAILibrary(state.token, this.configuration, 0)
      } catch (failure) {
        if (!(failure instanceof ExperimentError) || failure.code !== 'local_capacity')
          throw failure
        const { client } = await authenticateAILibrary(state.token, this.configuration)
        if (this.stopping) {
          const paused = await client.rpc('control_translation_batch', {
            target_batch: batchId,
            command: 'suspend',
          })
          if (paused.error) throw paused.error
        }
        const renewed = await client.rpc('renew_translation_batch_lease', {
          target_batch: batchId,
          worker_key: workerId,
        })
        if (renewed.error) throw renewed.error
        if (!renewed.data) {
          const stopped = await client.rpc('claim_translation_batch_group', {
            target_batch: batchId,
            worker_key: workerId,
            maximum_chapters: 1,
          })
          if (stopped.error) throw stopped.error
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }
      try {
        if (this.stopping) {
          const pause = await access.client.rpc('control_translation_batch', {
            target_batch: batchId,
            command: 'suspend',
          })
          if (pause.error) throw pause.error
        }
        const batch = await access.client
          .from('translation_batches')
          .select('*')
          .eq('id', batchId)
          .single()
        if (batch.error) throw batch.error
        if (
          batch.data.retry_at &&
          Date.parse(batch.data.retry_at) > Date.now() &&
          batch.data.state === 'running' &&
          !this.stopping
        ) {
          access.release()
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(1000, Date.parse(batch.data.retry_at!) - Date.now())),
          )
          continue
        }
        const claimed = await access.client.rpc('claim_translation_batch_group', {
          target_batch: batchId,
          worker_key: workerId,
          maximum_chapters: [
            'group_validation',
            'output_limit',
            'invalid_schema',
            'invalid_json',
          ].includes(batch.data.last_error_code)
            ? 1
            : batch.data.chapters_per_request,
        })
        if (claimed.error) throw claimed.error
        const items = claimed.data.sort((first, second) => first.position - second.position)
        const item = items[0]
        if (!item) {
          const current = await this.status(access.client, batch.data.book_id, batchId)
          if (
            current.batch?.state === 'running' &&
            current.chapters.some((chapter) => chapter.state === 'pending')
          ) {
            access.release()
            await new Promise((resolve) => setTimeout(resolve, 1000))
            continue
          }
          return
        }
        if (batch.data.chapters_per_request > 1) {
          await runTranslationGroup(
            state.token,
            batch.data,
            items,
            workerId,
            this.configuration,
            access,
          )
          const cleared = await access.client
            .from('translation_batches')
            .update({ retry_at: null, last_error_code: '', error: '' })
            .eq('id', batchId)
            .eq('worker_id', workerId)
            .eq('state', 'running')
          if (cleared.error) throw cleared.error
          continue
        }
        await runBookTranslation(
          state.token,
          {
            bookId: batch.data.book_id,
            sourceKey: item.source_key,
            action: 'translate',
            confirmed: true,
          },
          this.configuration,
          access,
          {
            batchId,
            position: item.position,
            workerId,
            settingsRevision: batch.data.settings_revision,
            sourceId: batch.data.source_id,
            contentHash: item.content_hash,
            model: batch.data.model,
            retranslate: batch.data.retranslate,
          },
        )
        const cleared = await access.client
          .from('translation_batches')
          .update({ retry_at: null, last_error_code: '', error: '' })
          .eq('id', batchId)
          .eq('worker_id', workerId)
          .eq('state', 'running')
        if (cleared.error) throw cleared.error
      } catch (failure) {
        const code =
          failure instanceof ExperimentError ? (failure.code ?? 'queue_error') : 'queue_error'
        const current = await access.client
          .from('translation_batch_chapters')
          .select('attempts')
          .eq('batch_id', batchId)
          .eq('state', 'running')
        if (current.error) throw failure
        const attempt = Math.max(1, ...current.data.map((chapter) => chapter.attempts))
        const retry = await access.client.rpc('schedule_translation_retry', {
          target_batch: batchId,
          worker_key: workerId,
          failure_message:
            failure instanceof Error ? failure.message : 'The translation request failed.',
          failure_code: code,
          retry_delay_seconds: Math.min(
            120,
            Math.ceil((this.retryDelayMs * 2 ** (attempt - 1)) / 1000),
          ),
        })
        if (retry.error) throw failure
        if (!retry.data) return
      } finally {
        access.release()
      }
    }
  }
}
