import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Check, Eye, Languages, LoaderCircle, Save } from 'lucide-react'
import type { LibraryBook } from '../../lib/books'
import { useLibrary } from '../../app/library-context'
import { outputLanguages } from '../../lib/extension/contracts'
import {
  applyMetadataPreview,
  saveTranslationSettings,
  saveReaderModels,
  type TranslationWorkspace,
} from '../../lib/translation/repository'
import { metadataResultSchema } from '../../lib/translation/context'
import { bookTranslationTask, getAIStatus } from '../../lib/ai/client'
import type { AIStatus } from '../../lib/ai/contracts'
import { textModelPrices } from '../../lib/ai/pricing'
import { Dialog } from '../ui'
import { bookSourceLabel } from '../../lib/library/presentation'
import { GlossarySources } from './GlossaryPanel'

function ModelPreferences({ bookId, workspace, refresh }: { bookId: string; workspace: TranslationWorkspace; refresh: () => Promise<void> }) {
  const settings = workspace.translationSettings
  const [translation, setTranslation] = useState(settings?.translation_model ?? '')
  const [chat, setChat] = useState(settings?.chat_model ?? '')
  const [status, setStatus] = useState<AIStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { let cancelled = false; void getAIStatus().then(status => { if (!cancelled) setStatus(status) }).catch(() => undefined); return () => { cancelled = true } }, [])
  if (!settings) return null
  const averages = workspace.timingAverages
  return <section className="setup-section model-preferences" aria-label="Reader models">
    <h2>Models</h2>
    <div className="setup-fields">
      <label>Translation model<select value={translation} disabled={busy} onChange={event => setTranslation(event.target.value)}><option value="">Default ({status?.translationModel || 'gpt-5.6-luna'})</option>{textModelPrices.map(entry => <option key={entry.model} value={entry.model}>{entry.model}</option>)}</select></label>
      <label>Chat model<select value={chat} disabled={busy} onChange={event => setChat(event.target.value)}><option value="">Default ({status?.chatModel || 'gpt-4.1-mini'})</option>{textModelPrices.map(entry => <option key={entry.model} value={entry.model}>{entry.model}</option>)}</select></label>
    </div>
    <div className="setup-actions"><button className="button" disabled={busy || (translation === (settings.translation_model ?? '') && chat === (settings.chat_model ?? ''))} onClick={() => {
      setBusy(true); setError(''); void saveReaderModels(bookId, settings.revision, translation, chat).then(refresh).catch(failure => setError(failure instanceof Error ? failure.message : 'Models could not be saved.')).finally(() => setBusy(false))
    }}><Save size={16} />Save models</button>{status?.limits && <span className="guide-status">{status.limits.concurrency} concurrent AI tasks</span>}</div>
    <h3>Average translation time</h3>
    {averages.length ? <ul className="translation-timings">{averages.map(average => <li key={`${average.model}:${average.language}`}><strong>{average.model} / {average.language}</strong><small>{average.samples} measured {average.samples === 1 ? 'translation' : 'translations'}</small><span>{(average.totalMs / 1000).toFixed(1)}s average per chapter</span><div><span>Preparation {(average.preparationMs / 1000).toFixed(1)}s</span><span>Guide {(average.guideMs / 1000).toFixed(1)}s</span><span>Generation {(average.modelMs / 1000).toFixed(1)}s</span></div></li>)}</ul> : <p className="muted">No measured translations yet.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>
}

export function TranslationSetup({
  book,
  workspace,
  refresh,
  view = 'settings',
}: {
  book: LibraryBook
  workspace: TranslationWorkspace
  refresh: () => Promise<void>
  view?: 'settings' | 'metadata'
}) {
  const { books } = useLibrary()
  const [, setParameters] = useSearchParams()
  const settings = workspace.translationSettings
  const [language, setLanguage] = useState(settings?.target_language ?? 'en')
  const [referenceId, setReferenceId] = useState(settings?.reference_book_id ?? '')
  const [referenceSourceId, setReferenceSourceId] = useState(settings?.reference_source_id ?? '')
  const [mode, setMode] = useState<'style_only' | 'continuation'>(
    settings?.reference_mode === 'style_only'
      ? 'style_only'
      : 'continuation',
  )
  const mainSource =
    workspace.sources.find((source) => source.book_id === book.id && source.role !== 'metadata')
      ?.id ?? ''
  const [metadataSource, setMetadataSource] = useState(
    settings?.metadata_source_id ??
      (settings ? '' : (workspace.sources.find((source) => source.role === 'metadata')?.id ?? '')),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [permission, setPermission] = useState(false)
  const metadataPreview = workspace.previews.find(preview => preview.kind === 'metadata' && preview.target_language === language)
  const metadata = metadataResultSchema.safeParse(metadataPreview?.result)
  const dirty =
    !settings ||
    language !== settings.target_language ||
    referenceId !== (settings.reference_book_id ?? '') ||
    referenceSourceId !== (settings.reference_source_id ?? '') ||
    mode !== settings.reference_mode ||
    mainSource !== (settings.main_source_id ?? '') ||
    metadataSource !== (settings.metadata_source_id ?? '')
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The operation failed.')
    } finally {
      setBusy(false)
    }
  }
  const task = async (paid: boolean) => {
    await bookTranslationTask({
      bookId: book.id,
      action: 'metadata',
      translateMetadata: paid,
      confirmed: paid,
    })
    await refresh()
  }
  const savePreferences = async () => {
    await saveTranslationSettings(book.id, {
      targetLanguage: language,
      referenceBookId: referenceId || null,
      referenceSourceId: referenceSourceId || null,
      referenceMode: mode,
      mainSource: mainSource || null,
      metadataSource: metadataSource || null,
    }, settings?.revision ?? 0)
    setParameters(previous => {
      const next = new URLSearchParams(previous)
      next.delete('source')
      return next
    }, { replace: true })
    await refresh()
  }
  return (
    <section className="translation-setup" aria-label={view === 'metadata' ? 'Book metadata' : 'Translation settings'}>
      {view === 'settings' && (
        <form
          className="translation-preferences"
          onSubmit={(event) => {
            event.preventDefault()
            void run(savePreferences)
          }}
        >
          <h2>Translation preferences</h2>
          <div className="setup-fields">
            <label>
              Target language
              <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                {outputLanguages.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Context book
              <span className="translation-select-control">
              <select
                value={
                  referenceSourceId
                    ? `source:${referenceSourceId}`
                    : referenceId
                      ? `book:${referenceId}`
                      : ''
                }
                onChange={(event) => {
                  if (event.target.value.startsWith('source:')) {
                    setReferenceSourceId(event.target.value.slice(7))
                    setReferenceId('')
                  } else {
                    setReferenceSourceId('')
                    setReferenceId(event.target.value.replace(/^book:/, ''))
                  }
                }}
              >
                <option value="">None</option>
                {books
                  .filter((entry) => entry.id !== book.id)
                  .flatMap((entry) => {
                    const source = workspace.contextSources.find(
                      (source) => source.book_id === entry.id,
                    )
                    if (entry.format === 'WEB' && !source) return []
                    return (
                      <option
                        key={entry.id}
                        value={entry.format === 'WEB' ? `source:${source!.id}` : `book:${entry.id}`}
                      >
                        {entry.title} / {bookSourceLabel(entry)} ({entry.language})
                      </option>
                    )
                  })}
              </select>
              </span>
            </label>
            <label>
              Context use
              <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
                <option value="continuation">Recent earlier chapters</option>
                <option value="style_only">Writing style only</option>
              </select>
            </label>
          </div>
          <div className="setup-actions"><button className="button primary" disabled={busy || !dirty}>
            <Save size={16} />
            Save preferences
          </button><Link className="button" to={`/books/${book.id}`}>Open book</Link></div>
        </form>
      )}
      {view === 'settings' && <><ModelPreferences bookId={book.id} workspace={workspace} refresh={refresh} /><GlossarySources book={book} settings={settings} refresh={refresh} /></>}
      {view === 'metadata' && <section className="setup-section metadata-options">
        <h2>Book page metadata</h2>
        <label>
          Metadata source
          <select
            value={metadataSource}
            onChange={(event) => setMetadataSource(event.target.value)}
          >
            <option value="">Book source</option>
            {workspace.sources
              .filter((source) => source.role === 'metadata')
              .map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
          </select>
        </label>
        <div className="setup-actions">
          <button className="button primary" disabled={busy || !dirty} onClick={() => void run(savePreferences)}><Save size={16} />Save metadata source</button>
          <button
            className="button"
            disabled={busy || dirty}
            onClick={() => void run(() => task(false))}
          >
            <Eye size={16} />
            Preview source metadata
          </button>
          <button
            className="button"
            disabled={busy || dirty}
            onClick={() => {
              setPermission(false)
              setConfirm(true)
            }}
          >
            <Languages size={16} />
            Translate title and synopsis
          </button>
        </div>
      </section>}
      {view === 'metadata' && metadataPreview && metadata.success && (
        <section className="setup-section" aria-label="Metadata review">
          <h2>Metadata review</h2>
          <h3>{metadata.data.title}</h3>
          <p>{metadata.data.author}</p>
          <p>{metadata.data.synopsis}</p>
          {metadata.data.coverAlt && <small>{metadata.data.coverAlt}</small>}
          <button className="button" disabled={busy || Boolean(metadataPreview.applied_at)} onClick={() => void run(async () => {
            await applyMetadataPreview(metadataPreview.id)
            window.dispatchEvent(new Event('focus'))
            await refresh()
          })}><Check size={15} />Apply to book page</button>
          <small>{metadataPreview.model || 'Saved source metadata'} / {metadataPreview.input_tokens + metadataPreview.output_tokens} reported tokens</small>
        </section>
      )}
      {busy && (
        <p role="status">
          <LoaderCircle size={17} className="spin" />
          Working...
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {confirm && (
        <Dialog
          title="Translate metadata"
          onClose={() => {
            if (!busy) setConfirm(false)
          }}
        >
          <div className="edit-form">
            <p>
              One billable model request.{' '}
              The selected source title, author, synopsis and cover description will be sent to OpenAI. Review the result before applying it.
            </p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={permission}
                onChange={(event) => setPermission(event.target.checked)}
              />
              I have permission to send this material to the model.
            </label>
            <button
              className="button primary"
              disabled={busy || !permission}
              onClick={() => {
                setConfirm(false)
                void run(() => task(true))
              }}
            >
              <Languages size={16} />
              Create preview
            </button>
          </div>
        </Dialog>
      )}
    </section>
  )
}
