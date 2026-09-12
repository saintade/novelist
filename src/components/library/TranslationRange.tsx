import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Languages,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react'
import type { LibraryBook } from '../../lib/books'
import type { ReadingSource } from '../../lib/sources/contracts'
import { sourceInventory } from '../../lib/sources/repository'
import { translationBatchTask } from '../../lib/ai/client'
import type {
  TranslationBatchOverview,
  TranslationBatchPlan,
  TranslationBatchStatus,
} from '../../lib/translation/batches'
import { Dialog, IconButton } from '../ui'
import '../../styles/sources.css'

const stateLabels = {
  pending: 'Queued',
  running: 'Translating',
  completed: 'Saved',
  skipped: 'Already translated',
  failed: 'Needs review',
  cancelled: 'Cancelled',
}
const activeStates = ['running', 'pausing', 'cancelling']
const priceLabel = (amount: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount)

export function TranslationRange({
  book,
  source,
  active,
}: {
  book: LibraryBook
  source?: ReadingSource
  active: boolean
}) {
  const [overview, setOverview] = useState<TranslationBatchOverview | null>(null)
  const [status, setStatus] = useState<TranslationBatchStatus>({ batch: null, chapters: [] })
  const [range, setRange] = useState<{ from: number; to: number } | null>(null)
  const [chaptersPerRequest, setChaptersPerRequest] = useState(10)
  const [plan, setPlan] = useState<TranslationBatchPlan | null>(null)
  const [confirmation, setConfirmation] = useState<'start' | 'resume' | 'cancel' | null>(null)
  const [permission, setPermission] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [listPage, setListPage] = useState<number | null>(null)
  const refreshing = useRef(false)
  const requestId = useRef('')
  const batch = status.batch
  const chapterPositions = new Map(
    (source ? sourceInventory(source) : []).map((chapter, index) => [chapter.url, index]),
  )
  const batchId = batch?.id
  const batchState = batch?.state
  const endedBatchId = batch && ['completed', 'cancelled'].includes(batch.state) ? batch.id : null
  const open = Boolean(batch && !['completed', 'cancelled'].includes(batch.state))
  const from = range?.from ?? overview?.defaultStart ?? 1
  const to = range?.to ?? Math.min(overview?.total ?? 1, from + 9)
  const valid =
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 1 &&
    to >= from &&
    to <= (overview?.total ?? 0) &&
    to - from < 1000
  const completed = status.chapters.filter((chapter) => chapter.state === 'completed').length
  const skipped = status.chapters.filter((chapter) => chapter.state === 'skipped').length
  const failed = status.chapters.filter((chapter) => chapter.state === 'failed').length
  const current = status.chapters.find((chapter) => chapter.state === 'running')
  const nextIndex = Math.max(
    0,
    status.chapters.findIndex((chapter) =>
      ['running', 'pending', 'failed'].includes(chapter.state),
    ),
  )
  const pageCount = Math.max(1, Math.ceil(status.chapters.length / 25))
  const page = Math.min(listPage ?? Math.floor(nextIndex / 25), pageCount - 1)
  const refresh = async (full = true) => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const result = await translationBatchTask({
        action: full ? 'overview' : 'status',
        bookId: book.id,
        ...(full ? {} : { batchId: batch?.id }),
      })
      if (result.overview) setOverview(result.overview)
      if (result.status) setStatus(result.status)
      setLoadError('')
    } catch (failure) {
      setLoadError(
        failure instanceof Error ? failure.message : 'The translation queue could not be loaded.',
      )
    } finally {
      refreshing.current = false
      setLoading(false)
    }
  }
  const readStatus = useEffectEvent(() =>
    translationBatchTask({ action: 'status', bookId: book.id, batchId }),
  )
  useEffect(() => {
    if (!active || busy) return
    let cancelled = false
    const focus = () => {
      void translationBatchTask({ action: 'overview', bookId: book.id })
        .then((result) => {
          if (cancelled) return
          if (result.overview) setOverview(result.overview)
          if (result.status) setStatus(result.status)
          setLoadError('')
        })
        .catch((failure) => {
          if (!cancelled)
            setLoadError(
              failure instanceof Error
                ? failure.message
                : 'The translation queue could not be loaded.',
            )
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    focus()
    window.addEventListener('focus', focus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', focus)
    }
  }, [book.id, active, endedBatchId, busy])
  useEffect(() => {
    if (!active || busy || !batchId || !batchState || !activeStates.includes(batchState)) return
    let cancelled = false
    let pending = false
    const timer = setInterval(() => {
      if (pending) return
      pending = true
      void readStatus()
        .then((result) => {
          if (!cancelled && result.status) {
            setStatus(result.status)
            setLoadError('')
          }
        })
        .catch((failure) => {
          if (!cancelled)
            setLoadError(
              failure instanceof Error ? failure.message : 'Queue status is unavailable.',
            )
        })
        .finally(() => {
          pending = false
        })
    }, 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, busy, batchId, batchState])
  const review = async (allUntranslated = false) => {
    if (
      busy ||
      (!allUntranslated && !valid) ||
      !Number.isInteger(chaptersPerRequest) ||
      chaptersPerRequest < 1 ||
      chaptersPerRequest > 10
    )
      return
    setBusy(true)
    setError('')
    try {
      const result = await translationBatchTask({
        action: 'plan',
        bookId: book.id,
        ...(allUntranslated ? { allUntranslated: true } : { from, to }),
        chaptersPerRequest,
      })
      if (!result.plan) throw new Error('The translation job could not be prepared.')
      setPlan(result.plan)
      requestId.current = crypto.randomUUID()
      setPermission(false)
      setConfirmation('start')
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The translation job could not be prepared.',
      )
    } finally {
      setBusy(false)
    }
  }
  const perform = async (action: 'pause' | 'resume' | 'cancel' | 'start') => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result =
        action === 'start' && plan
          ? await translationBatchTask({
              action,
              bookId: book.id,
              requestId: requestId.current,
              from: plan.from,
              to: plan.to,
              expectedRevision: plan.revision,
              expectedCount: plan.count,
              chaptersPerRequest: plan.chaptersPerRequest,
              allUntranslated: plan.allUntranslated,
              confirmed: permission,
            })
          : await translationBatchTask({
              action,
              bookId: book.id,
              batchId: batch?.id,
              confirmed: permission,
              retryFailed,
            })
      if (result.status) {
        setStatus(result.status)
        setListPage(null)
        if (action === 'start') setRange(null)
      }
      setConfirmation(null)
      setPlan(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The queue could not be updated.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="translation-range" aria-label="Bulk translation">
      <div className="translation-range-heading">
        <div>
          <h2>Translate chapters</h2>
          <p>
            {overview
              ? `${overview.model} / ${overview.language}`
              : 'Saved translation preferences'}
          </p>
        </div>
        <div className="translation-range-tools">
          <Link className="button" to={`/books/${book.id}/translation?tab=settings`}>
            Preferences
          </Link>
          <IconButton
            label="Refresh translation queue"
            disabled={busy || loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={17} />
          </IconButton>
        </div>
      </div>
      {loading && (
        <p role="status">
          <LoaderCircle className="spin" size={17} />
          Loading translation queue...
        </p>
      )}
      {overview && !open && (
        <>
          <div className="translation-range-summary">
            <span>{overview.downloaded} downloaded</span>
            <span>{overview.savedVersions} with saved translations</span>
            <span>{overview.total} indexed</span>
          </div>
          <div className="setup-actions">
            <button
              className="button primary"
              disabled={
                busy ||
                overview.downloaded === 0 ||
                !Number.isInteger(chaptersPerRequest) ||
                chaptersPerRequest < 1 ||
                chaptersPerRequest > 10
              }
              onClick={() => void review(true)}
            >
              <Languages size={17} />
              Translate untranslated
            </button>
          </div>
          <form
            className="translation-range-form"
            onSubmit={(event) => {
              event.preventDefault()
              void review()
            }}
          >
            <label>
              From chapter
              <input
                type="number"
                required
                min={1}
                max={overview.total}
                value={from}
                disabled={busy}
                onChange={(event) => {
                  setRange({ from: Number(event.target.value), to })
                  setPlan(null)
                }}
              />
            </label>
            <label>
              To chapter
              <input
                type="number"
                required
                min={from}
                max={Math.min(overview.total, from + 999)}
                value={to}
                disabled={busy}
                onChange={(event) => {
                  setRange({ from, to: Number(event.target.value) })
                  setPlan(null)
                }}
              />
            </label>
            <label>
              Chapters per request (maximum)
              <input
                type="number"
                min={1}
                max={10}
                required
                value={chaptersPerRequest}
                disabled={busy}
                onChange={(event) => {
                  setChaptersPerRequest(Number(event.target.value))
                  setPlan(null)
                }}
              />
            </label>
            <button
              className="button"
              disabled={
                busy ||
                !valid ||
                !Number.isInteger(chaptersPerRequest) ||
                chaptersPerRequest < 1 ||
                chaptersPerRequest > 10
              }
            >
              {busy ? <LoaderCircle size={17} className="spin" /> : <Languages size={17} />}Review
              translation range
            </button>
          </form>
          {to - from >= 1000 && (
            <p className="form-error">Choose up to 1,000 chapters per manual range.</p>
          )}
        </>
      )}
      {batch && (
        <section className="translation-queue" aria-label="Translation queue">
          <div className="translation-queue-heading">
            <div>
              <h3>
                {batch.all_untranslated
                  ? 'Untranslated chapters'
                  : `Chapters ${batch.range_start}-${batch.range_end}`}
              </h3>
              <p>
                {batch.model} / {batch.target_language} / up to {batch.chapters_per_request ?? 1}{' '}
                chapters per request / {batch.max_attempts ?? 3} attempts per chapter
              </p>
            </div>
            <span className={`queue-state queue-${batch.state}`}>
              {batch.state === 'running' && batch.retry_at
                ? 'Retrying automatically'
                : batch.state === 'pausing'
                  ? 'Pausing after current request'
                  : batch.state === 'cancelling'
                    ? 'Cancelling after current request'
                    : batch.state === 'failed'
                      ? 'Stopped after an error'
                      : batch.state[0].toUpperCase() + batch.state.slice(1)}
            </span>
          </div>
          <progress
            aria-label="Translation queue progress"
            max={status.chapters.length || 1}
            value={completed + skipped}
          />
          <div className="translation-queue-counts" role="status">
            <span>{completed} translated</span>
            <span>{skipped} already saved</span>
            <span>
              {
                status.chapters.filter(
                  (chapter) => chapter.state === 'pending' || chapter.state === 'running',
                ).length
              }{' '}
              remaining
            </span>
            {failed > 0 && <span>{failed} need review</span>}
          </div>
          {current && (
            <p className="translation-current">
              <LoaderCircle className="spin" size={16} />
              {current.title}
            </p>
          )}
          {batch.error && (
            <p role="alert" className="form-error">
              {batch.error}
            </p>
          )}
          {open && (
            <div className="setup-actions">
              {batch.state === 'running' && (
                <button className="button" disabled={busy} onClick={() => void perform('pause')}>
                  <Pause size={16} />
                  Pause translations
                </button>
              )}
              {['paused', 'failed'].includes(batch.state) && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => {
                    setPermission(false)
                    setRetryFailed(false)
                    setConfirmation('resume')
                  }}
                >
                  <Play size={16} />
                  Resume translations
                </button>
              )}
              <button
                className="button"
                disabled={busy || batch.state === 'cancelling'}
                onClick={() => setConfirmation('cancel')}
              >
                <Square size={15} />
                Cancel queue
              </button>
            </div>
          )}
          <div className="translation-queue-list">
            {status.chapters.slice(page * 25, (page + 1) * 25).map((chapter) => (
              <article className="translation-queue-row" key={chapter.position}>
                <span className="toc-number">{chapter.position + 1}</span>
                <div>
                  <strong>{chapter.title}</strong>
                  {chapter.error && <p className="form-error">{chapter.error}</p>}
                </div>
                <span className={`queue-item-state queue-item-${chapter.state}`}>
                  {chapter.state === 'completed' && <Check size={14} />}
                  {stateLabels[chapter.state as keyof typeof stateLabels]}
                </span>
                {chapter.preview_id &&
                  batch.source_id === source?.id &&
                  chapterPositions.has(chapter.source_key) && (
                    <Link
                      className="button subtle"
                      to={`/read-source/${book.id}/${batch.source_id}/${chapterPositions.get(chapter.source_key)}?translated=${encodeURIComponent(batch.target_language)}&version=${chapter.preview_id}`}
                    >
                      Read
                    </Link>
                  )}
              </article>
            ))}
          </div>
          {pageCount > 1 && (
            <nav className="pagination" aria-label="Translation queue pages">
              <IconButton
                label="Previous translation queue page"
                disabled={!page}
                onClick={() => setListPage(page - 1)}
              >
                <ChevronLeft size={18} />
              </IconButton>
              <span>
                {page + 1} / {pageCount}
              </span>
              <IconButton
                label="Next translation queue page"
                disabled={page + 1 === pageCount}
                onClick={() => setListPage(page + 1)}
              >
                <ChevronRight size={18} />
              </IconButton>
            </nav>
          )}
        </section>
      )}
      {(loadError || error) && !confirmation && (
        <p className="form-error" role="alert">
          {error || loadError}
        </p>
      )}
      {confirmation && (
        <Dialog
          className="translation-range-confirmation"
          title={
            confirmation === 'start'
              ? plan?.allUntranslated
                ? 'Translate untranslated chapters'
                : 'Translate chapter range'
              : confirmation === 'resume'
                ? 'Resume translation queue'
                : 'Cancel translation queue'
          }
          onClose={() => {
            if (!busy) {
              setConfirmation(null)
              setError('')
            }
          }}
        >
          <div className="edit-form">
            {confirmation === 'start' && plan ? (
              <>
                <p>
                  Chapters {plan.from}-{plan.to} / {plan.count} chapters / {plan.model} /{' '}
                  {plan.language}
                </p>
                {plan.allUntranslated && (
                  <p>
                    {plan.count} downloaded {plan.count === 1 ? 'chapter' : 'chapters'} selected.{' '}
                    {plan.undownloadedCount} undownloaded{' '}
                    {plan.undownloadedCount === 1 ? 'chapter' : 'chapters'} excluded.
                  </p>
                )}
                {plan.missingCount ? (
                  <div role="alert" className="form-error">
                    <p>
                      {plan.missingCount}{' '}
                      {plan.missingCount === 1 ? 'chapter needs' : 'chapters need'} downloading
                      first.
                    </p>
                    {plan.missing.map((chapter) => (
                      <p key={chapter.position}>{chapter.title}</p>
                    ))}
                    <Link
                      to={`/books/${book.id}?tab=downloads`}
                      onClick={() => setConfirmation(null)}
                    >
                      Open Downloads
                    </Link>
                  </div>
                ) : (
                  <>
                    <p>
                      {plan.savedCandidates}{' '}
                      {plan.savedCandidates === 1
                        ? 'chapter has a saved version'
                        : 'chapters have saved versions'}
                      . Every chapter is rechecked against its current source before any model call;
                      valid versions are skipped.
                    </p>
                    <dl className="batch-costs">
                      <div>
                        <dt>Chapters per request</dt>
                        <dd>Up to {plan.chaptersPerRequest} / adaptive</dd>
                      </div>
                      <div>
                        <dt>Output ceiling per request</dt>
                        <dd>{plan.outputTokenLimit.toLocaleString()} tokens</dd>
                      </div>
                      <div>
                        <dt>Chapter requests</dt>
                        <dd>Up to {plan.count * plan.maxAttempts}, including retries</dd>
                      </div>
                      <div>
                        <dt>Automatic retries</dt>
                        <dd>Up to {plan.maxAttempts} total attempts per unfinished chapter</dd>
                      </div>
                      <div>
                        <dt>Automatic guide updates</dt>
                        <dd>
                          {plan.automaticGuide
                            ? `Enabled / every ${plan.guideInterval} new chapters or context pressure`
                            : 'Off'}
                        </dd>
                      </div>
                      <div>
                        <dt>Chapter cost estimate</dt>
                        <dd>
                          {plan.estimatedUsd === null
                            ? 'No measured estimate yet'
                            : priceLabel(plan.estimatedUsd)}
                        </dd>
                      </div>
                      <div>
                        <dt>Budget-based maximum</dt>
                        <dd>
                          {plan.maximumUsd === null
                            ? 'Pricing unavailable for this model'
                            : priceLabel(plan.maximumUsd)}
                        </dd>
                      </div>
                      {plan.estimatedSeconds !== null && (
                        <div>
                          <dt>Estimated time</dt>
                          <dd>
                            {plan.estimatedSeconds < 60
                              ? `${Math.ceil(plan.estimatedSeconds)}s`
                              : `${Math.ceil(plan.estimatedSeconds / 60)} min`}{' '}
                            / {plan.timingSamples} measured{' '}
                            {plan.timingSamples === 1 ? 'sample' : 'samples'}
                          </dd>
                        </div>
                      )}
                    </dl>
                    {plan.chaptersPerRequest > 1 && (
                      <p className="batch-cost-note">
                        Groups shrink to fit the input and estimated output budgets. Each complete
                        chapter is validated and saved separately; unfinished chapters retry
                        automatically within the attempt limit. Guide updates happen between
                        requests, not within a group.
                      </p>
                    )}
                    <p className="batch-cost-note">
                      Normal API pricing, not the discounted Batch API. Estimates include all
                      selected chapters before skips; guide calls add usage. The budget-based
                      maximum includes retries and up to one guide update per attempt at the
                      configured price table. Actual provider prices and usage determine billing.
                    </p>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={permission}
                        onChange={(event) => setPermission(event.target.checked)}
                        disabled={busy}
                      />
                      Allow up to {plan.maxModelRequests} billable requests for this range
                    </label>
                  </>
                )}
              </>
            ) : confirmation === 'resume' ? (
              <>
                <p>
                  Resume chapters {batch?.range_start}-{batch?.range_end} with {batch?.model}.
                  Completed translations are kept, and saved versions are checked before continuing.
                </p>
                {failed > 0 && (
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={retryFailed}
                      onChange={(event) => setRetryFailed(event.target.checked)}
                      disabled={busy}
                    />
                    Retry failed or interrupted chapters. Previous provider usage may have been
                    charged.
                  </label>
                )}
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={permission}
                    onChange={(event) => setPermission(event.target.checked)}
                    disabled={busy}
                  />
                  Authorize the remaining billable translation and configured guide requests
                </label>
              </>
            ) : (
              <p>
                Stop after the current chapter and cancel the remaining queue. Original text,
                completed translations and earlier versions are kept.
              </p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  setConfirmation(null)
                  setError('')
                }}
              >
                Back
              </button>
              <button
                className={`button ${confirmation === 'cancel' ? 'danger-button' : 'primary'}`}
                disabled={
                  busy ||
                  (confirmation !== 'cancel' &&
                    (!permission ||
                      (confirmation === 'start' && Boolean(plan?.missingCount)) ||
                      (confirmation === 'resume' && failed > 0 && !retryFailed)))
                }
                onClick={() => void perform(confirmation)}
              >
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : confirmation === 'cancel' ? (
                  <Square size={16} />
                ) : (
                  <Play size={16} />
                )}
                {confirmation === 'start'
                  ? 'Start translations'
                  : confirmation === 'resume'
                    ? 'Resume queue'
                    : 'Cancel remaining chapters'}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  )
}
