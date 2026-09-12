import { useEffect, useRef, useState } from 'react'
import { Check, Link2, Search, Sparkles, X } from 'lucide-react'
import type {
  ReadingSource,
  SourceChapterRow,
  SourceChapterContent,
} from '../../lib/sources/contracts'
import type { ReferenceChapter } from '../../lib/translation/references'
import { suggestReferencePairs } from '../../lib/translation/references'
import {
  analyzeChapters,
  readDownloadedChapter,
  reviewAlignment,
  sourceInventory,
} from '../../lib/sources/repository'
import { supabase } from '../../lib/supabase/client'
import { Dialog } from '../ui'

export function SourceComparison({
  bookId,
  source,
  reference,
  chapter,
  downloaded,
  disabled,
  onSaved,
}: {
  bookId: string
  source: ReadingSource
  reference: ReadingSource
  chapter: ReferenceChapter
  downloaded: SourceChapterRow[]
  disabled: boolean
  onSaved: (useMatches?: boolean) => Promise<void>
}) {
  const listing = sourceInventory(reference)
  const suggested = suggestReferencePairs(
    [chapter],
    listing.map((entry, position) => ({
      key: entry.url,
      title: entry.sourceTitle || entry.title,
      position,
    })),
  )[0]
  const [urls, setUrls] = useState(() =>
    suggested.positions.map((position) => listing[position].url),
  )
  const [status, setStatus] = useState('Suggested by chapter number/title')
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const editVersion = useRef(0)
  const [texts, setTexts] = useState<{
    key: string
    source: SourceChapterContent | null
    references: SourceChapterContent[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState('')
  const selectedUrls = JSON.stringify(urls)
  const sourceText = texts?.key === selectedUrls ? texts.source : null
  const referenceText = texts?.key === selectedUrls ? texts.references : []
  useEffect(() => {
    let cancelled = false
    const version = editVersion.current
    supabase
      .from('source_chapter_alignments')
      .select('*')
      .eq('source_id', source.id)
      .eq('source_url', chapter.key)
      .eq('reference_source_id', reference.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setError(error.message)
          return
        }
        if (data && version === editVersion.current) {
          setUrls(data.reference_urls)
          setStatus(
            data.status === 'confirmed'
              ? 'Confirmed pairing'
              : data.status === 'rejected'
                ? 'Pairing rejected'
                : 'AI suggestion: review required',
          )
          setResult(data.reason)
        }
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [source.id, reference.id, chapter.key, revision])
  useEffect(() => {
    let cancelled = false
    const original = downloaded.find(
      (row) => row.source_id === source.id && row.url === chapter.key,
    )
    const references = (JSON.parse(selectedUrls) as string[]).flatMap((url) =>
      downloaded.filter((row) => row.source_id === reference.id && row.url === url),
    )
    Promise.all([
      original ? readDownloadedChapter(original) : null,
      Promise.all(references.map(readDownloadedChapter)),
    ])
      .then(([left, right]) => {
        if (!cancelled) {
          setTexts({ key: selectedUrls, source: left, references: right })
        }
      })
      .catch((failure) => {
        if (!cancelled)
          setError(failure instanceof Error ? failure.message : 'Chapter text could not be loaded.')
      })
    return () => {
      cancelled = true
    }
  }, [source.id, reference.id, chapter.key, selectedUrls, downloaded])
  const run = async (operation: () => Promise<void>, useMatches = false) => {
    setBusy(true)
    setError('')
    try {
      await operation()
      await onSaved(useMatches)
      setRevision((value) => value + 1)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The review could not be saved.')
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }
  const ready = Boolean(sourceText && urls.length && urls.length === referenceText.length)
  return (
    <section className="source-comparison" aria-label="Compare source chapters">
      <div className="comparison-heading">
        <h3>Context chapter matches</h3>
        <span className="pairing-status">{loaded ? status : 'Loading saved pairing...'}</span>
      </div>
      <fieldset className="reference-selection" disabled={busy || disabled || !loaded}>
        <legend>Reference chapters ({urls.length} selected)</legend>
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="Search reference chapters"
            placeholder="Find a reference chapter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="reference-choices">
          {listing
            .filter((entry) =>
              `${entry.title} ${entry.sourceTitle}`.toLowerCase().includes(query.toLowerCase()),
            )
            .map((entry) => {
              const stored = downloaded.some(
                (row) => row.source_id === reference.id && row.url === entry.url,
              )
              return (
                <label key={entry.url}>
                  <input
                    type="checkbox"
                    checked={urls.includes(entry.url)}
                    onChange={(event) => {
                      editVersion.current++
                      setUrls(
                        event.target.checked
                          ? [...urls, entry.url]
                          : urls.filter((url) => url !== entry.url),
                      )
                      setStatus('Unsaved pairing')
                      setSavedMessage('')
                    }}
                  />
                  <span>
                    {entry.sourceTitle || entry.title}
                    <small>{stored ? 'Downloaded' : 'Not downloaded'}</small>
                  </span>
                </label>
              )
            })}
        </div>
      </fieldset>
      <div className="comparison-actions">
        <button
          className="button primary"
          title="Save these exact source/reference chapter URLs as a confirmed pair. Both texts must be downloaded."
          disabled={
            !loaded ||
            busy ||
            disabled ||
            !ready ||
            urls.length > 20 ||
            status === 'Confirmed pairing'
          }
          onClick={() =>
            void run(async () => {
              await reviewAlignment(source.id, chapter.key, reference.id, urls, 'confirmed')
              setSavedMessage('Pairing saved.')
            }, true)
          }
        >
          <Check size={15} />
          Confirm &amp; save pairing
        </button>
        <button
          className="button"
          disabled={!loaded || busy || disabled || !sourceText}
          onClick={() =>
            void run(() => reviewAlignment(source.id, chapter.key, reference.id, [], 'rejected'))
          }
        >
          <X size={15} />
          Reject pairing
        </button>
        <button
          className="button"
          title="One confirmed model request compares selected chapter text and proposes glossary terms."
          disabled={!loaded || busy || disabled || !ready || urls.length > 5}
          onClick={() => setConfirm(true)}
        >
          <Sparkles size={15} />
          AI match chapters
        </button>
      </div>
      {savedMessage && <p role="status">{savedMessage}</p>}
      {loaded && !ready && (
        <p className="pairing-status">
          {!sourceText
            ? 'Source chapter not downloaded.'
            : urls.length === 0
              ? 'No reference chapters selected.'
              : 'Selected reference text is loading or not downloaded.'}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {result && <p className="comparison-result">{result}</p>}
      <div className="comparison-panes">
        <section aria-label="Original chapter text">
          <header>
            <strong>{source.label}</strong>
            <small>{chapter.title}</small>
          </header>
          <article lang={source.language}>
            {sourceText ? (
              sourceText.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)
            ) : (
              <p className="muted">Not downloaded</p>
            )}
          </article>
        </section>
        <section aria-label="Reference chapter text">
          <header>
            <strong>{reference.label}</strong>
            <small>{referenceText.length} selected chapters downloaded</small>
          </header>
          <article lang={reference.language}>
            {referenceText.length ? (
              referenceText.map((content, chapterIndex) => (
                <div key={chapterIndex}>
                  <h4>{content.title}</h4>
                  {content.paragraphs.map((paragraph, index) => (
                    <p key={index}>{paragraph}</p>
                  ))}
                </div>
              ))
            ) : (
              <p className="muted">Not downloaded</p>
            )}
          </article>
        </section>
      </div>
      {confirm && (
        <Dialog
          title="Analyze chapter pairing"
          onClose={() => {
            if (!busy) setConfirm(false)
          }}
        >
          <p className="dialog-copy">
            One billable request using the configured identification model (GPT-5 nano by default).
            Selected chapter text is sent for matching and bilingual term proposals. Nothing is
            approved automatically.
          </p>
          <div className="dialog-actions">
            <button className="button" disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const analysis = await analyzeChapters(bookId, chapter.key, urls)
                  setResult(
                    `${analysis.result.terms.length} glossary proposals saved for review. ${analysis.result.reason}`,
                  )
                })
              }
            >
              <Link2 size={15} />
              Analyze chapters
            </button>
          </div>
        </Dialog>
      )}
    </section>
  )
}
