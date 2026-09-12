import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { diffWordsWithSpace } from 'diff'
import { BookOpen, LoaderCircle, Save, Sparkles, Trash2, Upload } from 'lucide-react'
import type { LibraryBook } from '../../lib/books'
import { getAIStatus, inferStyle, readingGuide } from '../../lib/ai/client'
import {
  STYLE_CHARACTER_LIMIT,
  STYLE_EXAMPLE_LIMIT,
  styleInferenceSchema,
  type AIStatus,
} from '../../lib/ai/contracts'
import {
  assignStyleProfile,
  saveContextPreferences,
  removeStyleExample,
  uploadStyleExample,
  type StyleExample,
  type StyleProfile,
  type TranslationWorkspace,
} from '../../lib/translation/repository'
import { sourceChapters, type ReadingGuideResult } from '../../lib/translation/context'
import { Dialog, IconButton } from '../ui'
import { useSourceDirectory } from '../../lib/sources/use-source-directory'
import { readDownloadedChapter, sourceInventory } from '../../lib/sources/repository'
import { validateStyleExamples } from '../../lib/ai/contracts'
import '../../styles/sources.css'

function ReadingGuideEditor({ book, workspace, profile, refresh }: { book: LibraryBook; workspace: TranslationWorkspace; profile?: StyleProfile; refresh: () => Promise<void> }) {
  const settings = workspace.translationSettings
  const [parameters] = useSearchParams()
  const main = workspace.sources.find(source => source.id === settings?.main_source_id && source.role !== 'metadata')
  const chapters = main?.url ? sourceChapters(book, main) : []
  const [chapterKey, setChapterKey] = useState('')
  const chapter = chapters.find(chapter => chapter.key === chapterKey) ?? (parameters.has('chapter') ? chapters[Number(parameters.get('chapter'))] : chapters.find(chapter => chapter.key === book.sourceProgress?.chapterUrl)) ?? chapters[book.progress.chapter] ?? chapters[0]
  const [tokenBudget, setTokenBudget] = useState(settings?.context_tokens ?? 128000)
  const [recentChapters, setRecentChapters] = useState(settings?.recent_chapters ?? 3)
  const [automatic, setAutomatic] = useState(settings?.guide_auto_update ?? false)
  const [interval, setInterval] = useState(settings?.guide_interval ?? 5)
  const [feedback, setFeedback] = useState(settings?.guide_feedback ?? '')
  const [guide, setGuide] = useState<ReadingGuideResult | null>(null)
  const [historyId, setHistoryId] = useState('')
  const [beforeId, setBeforeId] = useState('')
  const [compare, setCompare] = useState(false)
  const [loadedGuideKey, setLoadedGuideKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [permission, setPermission] = useState(false)
  const sourceKey = chapter?.key
  const settingsRevision = settings?.revision
  const guideKey = JSON.stringify([book.id, sourceKey, settingsRevision, profile?.id])
  const checking = Boolean(sourceKey && settings && loadedGuideKey !== guideKey)
  const dirty = Boolean(settings && (tokenBudget !== settings.context_tokens || recentChapters !== settings.recent_chapters || automatic !== settings.guide_auto_update || interval !== settings.guide_interval || feedback !== settings.guide_feedback))
  useEffect(() => {
    if (!sourceKey || settingsRevision === undefined) return
    let cancelled = false
    readingGuide(book.id, sourceKey).then(result => {
      if (!cancelled) { setGuide(result); setHistoryId(''); setBeforeId(''); setError('') }
    }).catch(failure => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : 'Guide could not be loaded.')
    }).finally(() => { if (!cancelled) setLoadedGuideKey(guideKey) })
    return () => { cancelled = true }
  }, [book.id, sourceKey, settingsRevision, guideKey])
  if (!settings) return <p className="empty-inline"><Link to={`/books/${book.id}/translation?tab=settings`}>Save translation settings</Link></p>
  const inferred = profile?.inference as { kind?: string } | null
  const instructions = historyId ? guide?.history?.find(entry => entry.id === historyId)?.instructions : guide?.instructions || (inferred?.kind !== 'continuation' ? profile?.instructions : '')
  const history = guide?.history ?? []
  const afterIndex = historyId ? history.findIndex(entry => entry.id === historyId) : history.findIndex(entry => entry.id === guide?.profileId)
  const before = history.find(entry => entry.id === beforeId) ?? history[afterIndex + 1]
  const differences = diffWordsWithSpace(before?.instructions ?? '', instructions ?? '')
  return <div className="guide-panel translation-setup">
    <form className="translation-preferences" onSubmit={event => {
      event.preventDefault()
      setBusy(true)
      setError('')
      void saveContextPreferences(book.id, settings.revision, { tokenBudget, recentChapters, automatic, interval, feedback }).then(refresh).catch(failure => setError(failure instanceof Error ? failure.message : 'Guide preferences could not be saved.')).finally(() => setBusy(false))
    }}>
      <h2>Context and updates</h2>
      <div className="setup-fields">
        <label>Total context budget<input type="number" min={32000} max={128000} step={1000} value={tokenBudget} disabled={busy} onChange={event => setTokenBudget(Number(event.target.value))} /></label>
        <label>Recent translated chapters<input type="number" min={1} max={10} value={recentChapters} disabled={busy} onChange={event => setRecentChapters(Number(event.target.value))} /></label>
        <label>Update every (new chapters)<input type="number" min={1} max={100} value={interval} disabled={busy} onChange={event => setInterval(Number(event.target.value))} /></label>
        <label className="check-label"><input type="checkbox" checked={automatic} disabled={busy} onChange={event => setAutomatic(event.target.checked)} />Allow automatic billable guide updates</label>
      </div>
      <label>Guide request<textarea rows={3} maxLength={2000} value={feedback} disabled={busy} onChange={event => setFeedback(event.target.value)} /></label>
      <div className="setup-actions"><button className="button primary" disabled={busy || !dirty}><Save size={16} />Save guide preferences</button><span className="guide-status">{settings.guide_chapters_since_update} / {settings.guide_interval} new chapters since update</span></div>
    </form>
    <section className="setup-section">
      <div className="setup-fields">
        <label>Before chapter<select value={chapter?.key ?? ''} disabled={busy || !chapters.length} onChange={event => setChapterKey(event.target.value)}>{chapters.map(chapter => <option key={chapter.key} value={chapter.key}>{chapter.title}</option>)}</select></label>
        <label>Guide version<select value={historyId} onChange={event => setHistoryId(event.target.value)}><option value="">Current guide</option>{guide?.history?.map(entry => <option key={entry.id} value={entry.id}>{new Date(entry.createdAt).toLocaleString()}</option>)}</select></label>
      </div>
      <div className="translation-toolbar"><h2>Current guide</h2><button className="button" disabled={busy || checking || dirty || !chapter || !guide?.total} onClick={() => { setPermission(false); setConfirming(true) }}><Sparkles size={16} />Update guide</button></div>
      {checking ? <p role="status"><LoaderCircle className="spin" size={16} />Loading guide...</p> : <>
        {guide && <p className="guide-status">{guide.covered} of {guide.total} eligible chapters covered / {guide.remaining} pending</p>}
        {instructions && <div className="guide-display-options" role="group" aria-label="Guide display">
          <button aria-pressed={!compare} onClick={() => setCompare(false)}>Guide</button>
          <button aria-pressed={compare} disabled={!before} onClick={() => setCompare(true)}>Before / after</button>
        </div>}
        {instructions ? compare && before ? <div className="guide-comparison" role="region" aria-label="Guide comparison">
          <section><h3>Before</h3><label>Compare with<select aria-label="Previous guide version" value={before?.id ?? ''} onChange={event => setBeforeId(event.target.value)}>{history.filter(entry => entry.id !== (historyId || guide?.profileId)).map(entry => <option value={entry.id} key={entry.id}>{new Date(entry.createdAt).toLocaleString()}</option>)}</select></label>
            <div className="guide-prose" aria-label="Before guide">{differences.filter(change => !change.added).map((change, index) => change.removed ? <del key={index}>{change.value}</del> : <span key={index}>{change.value}</span>)}</div>
          </section>
          <section><h3>After</h3><p className="guide-change-label">{historyId ? 'Selected version' : 'Current version'}</p><div className="guide-prose" aria-label="After guide">{differences.filter(change => !change.removed).map((change, index) => change.added ? <ins key={index}>{change.value}</ins> : <span key={index}>{change.value}</span>)}</div></section>
        </div> : <div className="guide-instructions guide-prose" aria-label="Guide instructions">{instructions}</div> : <p className="empty-inline">No compatible guide saved for this chapter.</p>}
        {Boolean(guide?.chapters?.length) && <><h3>Covered chapters</h3><ul className="guide-coverage">{guide!.chapters!.slice(-50).map(entry => <li key={`${entry.kind}:${entry.url}`}><span>{entry.title || `Chapter ${(entry.position ?? 0) + 1}`}</span><small>{entry.kind === 'translation' ? 'Saved translation' : 'Reference chapter'}</small></li>)}</ul>{guide!.chapters!.length > 50 && <small>Latest 50 of {guide!.chapters!.length} covered chapters</small>}</>}
      </>}
    </section>
    {error && !checking && <p className="form-error" role="alert">{error}</p>}
    {confirming && <Dialog title="Update reading guide" onClose={() => { if (!busy) setConfirming(false) }}><div className="edit-form">
      <p>One billable model request using older saved translations, available reference chapters, the previous guide and your guide request. Originals and previous guide versions are kept.</p>
      <label className="check-label"><input type="checkbox" checked={permission} disabled={busy} onChange={event => setPermission(event.target.checked)} />Allow this guide request</label>
      <button className="button primary" disabled={!permission || busy} onClick={() => {
        if (!chapter) return
        setBusy(true)
        setError('')
        void readingGuide(book.id, chapter.key, true).then(async result => { setGuide(result); setConfirming(false); await refresh() }).catch(failure => setError(failure instanceof Error ? failure.message : 'Guide update failed.')).finally(() => setBusy(false))
      }}><Sparkles size={16} />{busy ? 'Updating...' : 'Update guide'}</button>
    </div></Dialog>}
  </div>
}

export function StylePanel({
  book,
  profiles,
  examples,
  selectedId,
  referenceSourceId,
  refresh,
  workspace,
}: {
  book: LibraryBook
  profiles: StyleProfile[]
  examples: StyleExample[]
  selectedId: string | null
  referenceSourceId?: string | null
  refresh: () => Promise<void>
  workspace: TranslationWorkspace
}) {
  const [view, setView] = useState<'guide' | 'examples'>('guide')
  const fileInput = useRef<HTMLInputElement>(null)
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [action, setAction] = useState<'upload' | 'copy' | 'infer' | 'select' | 'remove' | null>(
    null,
  )
  const directory = useSourceDirectory(book, referenceSourceId ?? undefined)
  const [exampleSourceId, setExampleSourceId] = useState(referenceSourceId ?? '')
  const [chapterUrls, setChapterUrls] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const englishSources = directory.sources.filter(
    (source) => source.role !== 'metadata' && source.language.startsWith('en'),
  )
  const exampleSource =
    englishSources.find((source) => source.id === exampleSourceId) ?? englishSources[0]
  const downloadedChapters = exampleSource
    ? sourceInventory(exampleSource).flatMap((chapter) =>
        directory.downloaded.filter(
          (row) => row.source_id === exampleSource.id && row.url === chapter.url,
        ),
      )
    : []
  const [error, setError] = useState('')
  const [status, setStatus] = useState<AIStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [permission, setPermission] = useState(false)
  const [removing, setRemoving] = useState<StyleExample | null>(null)
  const selected = profiles.find((profile) => profile.id === selectedId)
  const chosen = examples.filter((example) => checkedIds.includes(example.id))
  const characters = chosen.reduce((total, example) => total + example.character_count, 0)
  const overLimit = chosen.length > STYLE_EXAMPLE_LIMIT || characters > STYLE_CHARACTER_LIMIT
  const metadata =
    selected?.inference &&
    typeof selected.inference === 'object' &&
    !Array.isArray(selected.inference)
      ? selected.inference
      : null
  const evidence = styleInferenceSchema.safeParse(metadata?.result)

  useEffect(() => {
    let cancelled = false
    getAIStatus()
      .then((data) => {
        if (!cancelled) setStatus(data)
      })
      .catch(() => {
        if (!cancelled) setStatusError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="style-profile-panel" aria-label="Translation style">
      <div className="filter-tabs" role="tablist" aria-label="Style guide views">
        <button role="tab" aria-selected={view === 'guide'} onClick={() => setView('guide')}>Guide</button>
        <button role="tab" aria-selected={view === 'examples'} onClick={() => setView('examples')}>Examples</button>
      </div>
      {view === 'guide' ? <ReadingGuideEditor key={workspace.translationSettings?.revision ?? 0} book={book} workspace={workspace} profile={selected} refresh={refresh} /> : <>
      {englishSources.length > 0 && (
        <section className="source-style-examples">
          <h2>Downloaded English chapters</h2>
          <label className="style-selector">
            Example source
            <select
              aria-label="English style source"
              value={exampleSource?.id ?? ''}
              disabled={Boolean(action)}
              onChange={(event) => {
                setExampleSourceId(event.target.value)
                setChapterUrls([])
              }}
            >
              {englishSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
          </label>
          <div className="reference-choices">
            {downloadedChapters.map((chapter) => (
              <label key={chapter.id}>
                <input
                  type="checkbox"
                  aria-label={`Use ${chapter.title} as a style example`}
                  checked={chapterUrls.includes(chapter.url)}
                  disabled={Boolean(action)}
                  onChange={(event) =>
                    setChapterUrls(
                      event.target.checked
                        ? [...chapterUrls, chapter.url]
                        : chapterUrls.filter((url) => url !== chapter.url),
                    )
                  }
                />
                <span title={chapter.url}>
                  {chapter.title}
                  <small>{chapter.word_count.toLocaleString()} words</small>
                </span>
              </label>
            ))}
          </div>
          {!downloadedChapters.length && (
            <p className="empty-inline">No downloaded English chapters in this source.</p>
          )}
          <button
            className="button"
            title="Save private copies of the selected chapters as reusable style examples. No model request is made until Infer style is confirmed."
            disabled={
              Boolean(action) || !chapterUrls.length || chapterUrls.length > STYLE_EXAMPLE_LIMIT
            }
            onClick={async () => {
              setAction('copy')
              setError('')
              setNotice('')
              try {
                const selectedChapters = downloadedChapters.filter((chapter) =>
                  chapterUrls.includes(chapter.url),
                )
                const texts = await Promise.all(
                  selectedChapters.map(async (chapter) => ({
                    id: chapter.id,
                    fileName:
                      `${new URL(chapter.url).hostname} - ${chapter.title}`.slice(0, 230) + '.txt',
                    text: (await readDownloadedChapter(chapter)).paragraphs.join('\n\n'),
                  })),
                )
                validateStyleExamples(texts)
                for (const example of texts) {
                  const saved = await uploadStyleExample(
                    book,
                    new File([example.text], example.fileName, { type: 'text/plain' }),
                  )
                  setCheckedIds((previous) => [...new Set([...previous, saved.id])])
                }
                await refresh()
                setNotice('Style examples saved.')
              } catch (failure) {
                setError(
                  failure instanceof Error ? failure.message : 'Style examples could not be saved.',
                )
              } finally {
                setAction(null)
              }
            }}
          >
            <BookOpen size={16} />
            Use as style examples
          </button>
        </section>
      )}
      {(notice || directory.error) && (
        <p role={directory.error ? 'alert' : 'status'}>{directory.error || notice}</p>
      )}
      <div className="translation-toolbar">
        <h2 className="style-section-title">Chapter examples</h2>
        <button
          className="button"
          disabled={Boolean(action)}
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={16} /> {action === 'upload' ? 'Uploading...' : 'Upload examples'}
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept=".txt,text/plain"
          aria-label="Upload chapter examples"
          onChange={async (event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (!files.length) return
            setAction('upload')
            setError('')
            try {
              for (const file of files) {
                const saved = await uploadStyleExample(book, file)
                setCheckedIds((previous) => [...new Set([...previous, saved.id])])
              }
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : 'Upload failed.')
            } finally {
              try {
                await refresh()
              } catch {
                setError('Examples could not be reloaded. Refresh the workspace.')
              }
              setAction(null)
            }
          }}
        />
      </div>
      {!examples.length && <p className="empty-inline">No chapter examples uploaded.</p>}
      <ul className="style-example-list">
        {examples.map((example) => (
          <li className="style-example-row" key={example.id}>
            <label className="style-example-choice">
              <input
                type="checkbox"
                checked={checkedIds.includes(example.id)}
                disabled={Boolean(action)}
                aria-label={`Use ${example.file_name} for style`}
                onChange={(event) =>
                  setCheckedIds((previous) =>
                    event.target.checked
                      ? [...previous, example.id]
                      : previous.filter((id) => id !== example.id),
                  )
                }
              />
              <span>
                <strong>{example.file_name}</strong>
                <small>{example.character_count.toLocaleString()} characters</small>
              </span>
            </label>
            <IconButton
              label={`Remove ${example.file_name}`}
              disabled={Boolean(action)}
              onClick={() => {
                setError('')
                setRemoving(example)
              }}
            >
              <Trash2 size={17} />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="style-inference-controls">
        <div className="style-inference-status" role="status">
          <span>
            {chosen.length} selected / {characters.toLocaleString()} characters
          </span>
          <small>
            {status?.liveEnabled
              ? status.model
              : statusError
                ? 'AI server unavailable'
                : status
                  ? 'Style inference unavailable: live AI is off'
                  : 'Checking AI availability...'}
          </small>
          {overLimit && (
            <small className="form-error">
              Select up to 12 examples totaling 48,000 characters.
            </small>
          )}
        </div>
        <button
          className="button primary"
          title="Infer and save a reusable style guide from the selected examples. The new guide is selected automatically for future translations of this novel."
          disabled={Boolean(action) || !chosen.length || overLimit || !status?.liveEnabled}
          onClick={() => {
            setError('')
            setPermission(false)
            setConfirming(true)
          }}
        >
          <Sparkles size={16} /> {action === 'infer' ? 'Inferring...' : 'Infer style'}
        </button>
      </div>
      {error && !confirming && !removing && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="translation-toolbar">
        <label className="style-selector">
          Style profile
          <select
            aria-label="Style profile"
            value={selectedId ?? ''}
            disabled={Boolean(action)}
            onChange={async (event) => {
              setAction('select')
              setError('')
              try {
                await assignStyleProfile(book, event.target.value || null)
                await refresh()
              } catch (failure) {
                setError(
                  failure instanceof Error ? failure.message : 'Profile could not be selected.',
                )
              } finally {
                setAction(null)
              }
            }}
          >
            <option value="">Default translation</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="style-profile-text">
        {selected ? (
          <>
            <h3>{selected.name}</h3>
            <p>{selected.instructions}</p>
            <small>
              {selected.inference ? 'Inferred from chapter examples' : 'Saved profile'} / Version{' '}
              {selected.version}
            </small>
            {evidence.success && (
              <details className="style-evidence">
                <summary>Example evidence</summary>
                {evidence.data.observations.map((observation, index) => (
                  <div key={`${observation.exampleId}-${index}`}>
                    <blockquote>{observation.quote}</blockquote>
                    <p>{observation.pattern}</p>
                  </div>
                ))}
                {evidence.data.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </details>
            )}
          </>
        ) : (
          <p>No inferred style yet.</p>
        )}
      </div>
      {confirming && (
        <Dialog
          title="Infer translation style"
          onClose={() => {
            if (!action) setConfirming(false)
          }}
        >
          <div className="edit-form">
            <p>
              {chosen.length} chapter examples ({characters.toLocaleString()} characters) will be
              sent to OpenAI. This incurs API usage.
            </p>
            <label className="style-permission">
              <input
                type="checkbox"
                checked={permission}
                disabled={Boolean(action)}
                onChange={(event) => setPermission(event.target.checked)}
              />
              I have permission to use these examples with OpenAI.
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button"
                disabled={Boolean(action)}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={Boolean(action) || !permission}
                onClick={async () => {
                  setAction('infer')
                  setError('')
                  try {
                    await inferStyle(
                      book.id,
                      chosen.map((example) => example.id),
                      selectedId,
                    )
                    await refresh()
                    setNotice('Style guide saved and selected for future translations.')
                    setConfirming(false)
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : 'Style inference failed.')
                  } finally {
                    setAction(null)
                  }
                }}
              >
                {action === 'infer' ? 'Inferring...' : 'Infer style'}
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {removing && (
        <Dialog
          title="Remove chapter example"
          onClose={() => {
            if (!action) setRemoving(null)
          }}
        >
          <div className="edit-form">
            <p>Remove {removing.file_name}? Saved style profiles will be kept.</p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button"
                disabled={Boolean(action)}
                onClick={() => setRemoving(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={Boolean(action)}
                onClick={async () => {
                  setAction('remove')
                  setError('')
                  try {
                    await removeStyleExample(removing)
                    setCheckedIds((previous) => previous.filter((id) => id !== removing.id))
                    await refresh()
                    setRemoving(null)
                  } catch (failure) {
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : 'The example could not be removed.',
                    )
                  } finally {
                    setAction(null)
                  }
                }}
              >
                {action === 'remove' ? 'Removing...' : 'Remove example'}
              </button>
            </div>
          </div>
        </Dialog>
      )}
      </>}
    </section>
  )
}
