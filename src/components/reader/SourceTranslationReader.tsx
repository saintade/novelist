import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Eye, Languages, List, LoaderCircle, RotateCw, Square } from 'lucide-react'
import { useLibrary } from '../../app/library-context'
import type { Chapter, LibraryBook } from '../../lib/books'
import type {
  ReadingSource,
  SourceChapterContent,
  SourceChapterRow,
} from '../../lib/sources/contracts'
import {
  readableSourceChapter,
  saveSourceProgress,
  sourceInventory,
} from '../../lib/sources/repository'
import { supabase } from '../../lib/supabase/client'
import { readSetting, writeSetting } from '../../lib/preferences'
import type { Database } from '../../lib/supabase/database.types'
import {
  chapterTranslationSchema,
  chapterTermInventory,
  type ChapterTranslation,
} from '../../lib/translation/context'
import { bookTranslationTask, translationBatchTask, TranslationRequestError } from '../../lib/ai/client'
import { outputLanguages } from '../../lib/extension/contracts'
import {
  getLibraryReadingSources,
  saveTranslationSettings,
} from '../../lib/translation/repository'
import { bookSourceLabel } from '../../lib/library/presentation'
import type { AIInputBudget } from '../../lib/ai/contracts'
import { Reader } from '../Reader'
import { Dialog } from '../ui'
import { ChapterTerms, TermSuggestion } from './TermSuggestion'

type Settings = Database['public']['Tables']['book_translation_settings']['Row']

export function SourceTranslationReader({
  book,
  source,
  index,
  offset,
  offsetUpdatedAt,
  content,
  record,
}: {
  book: LibraryBook
  source: ReadingSource
  index: number
  offset: number
  offsetUpdatedAt: number
  content: SourceChapterContent
  record: SourceChapterRow
}) {
  const { books, theme, setTheme, notify, rememberSourceReading } = useLibrary()
  const [parameters, setParameters] = useSearchParams()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [language, setLanguage] = useState('en')
  const [referenceId, setReferenceId] = useState('')
  const [contextSources, setContextSources] = useState<ReadingSource[]>([])
  const [referenceMode, setReferenceMode] = useState<'continuation' | 'style_only'>(
    'continuation',
  )
  const referenceSourceId = referenceId.startsWith('source:') ? referenceId.slice(7) : ''
  const referenceBookId = referenceId.startsWith('book:') ? referenceId.slice(5) : ''
  const [versions, setVersions] = useState<
    {
      id: string
      translation: ChapterTranslation
      key: string
      createdAt: string
      model: string | null
      inputTokens: number
      outputTokens: number
      termContext?: unknown
    }[]
  >([])
  const [retranslate, setRetranslate] = useState(false)
  const [inputBudget, setInputBudget] = useState<AIInputBudget | null>(null)
  const [contextSummary, setContextSummary] = useState('')
  const [checkedKey, setCheckedKey] = useState('')
  const [translationPosition, setTranslationPosition] = useState<{ chapter_url: string; fraction: number; updated_at: string; translation_version: string | null } | null>(null)
  const [originalPosition, setOriginalPosition] = useState({ fraction: offset, updatedAt: offsetUpdatedAt })
  const [lookupError, setLookupError] = useState('')
  const [working, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  const [termSelection, setTermSelection] = useState<string | null>(null)
  const [editingTerm, setEditingTerm] = useState<{ source: string; target: string } | null>(null)
  const [termsOpen, setTermsOpen] = useState(false)
  const [termQuery, setTermQuery] = useState('')
  const listing = sourceInventory(source)
  const selected = listing[index]
  const lookupKey = JSON.stringify([source.id, selected.url, record.content_hash, language])
  const pendingKey = `novelist-translation-job:${JSON.stringify([book.ownerId, book.id, source.id, selected.url, record.content_hash])}`
  const [pendingJob, setPendingJob] = useState<{ id: string; language: string } | null>(() => readSetting(pendingKey, null))
  const [recovery, setRecovery] = useState<{ id: string; language: string; requestKind: string } | null>(null)
  const [recoveryConsent, setRecoveryConsent] = useState(false)
  const busy = working || Boolean(pendingJob)
  const requestedVersion = parameters.get('version')
  const selectionKey = JSON.stringify([lookupKey, requestedVersion])
  const matchingVersions = versions.filter((version) => version.key === lookupKey)
  const saved = (requestedVersion ? matchingVersions.find((version) => version.id === requestedVersion) : matchingVersions[0]) ?? null
  const checking = !loaded || checkedKey !== selectionKey
  const translated = parameters.has('translated')
  const showingTranslation = translated && Boolean(saved) && !checking
  const requestedLanguage = parameters.get('translated')
  const back = `/books/${book.id}?source=${source.id}`
  const readerGeneration = useRef(0)
  useEffect(() => {
    readerGeneration.current += 1
    return () => { readerGeneration.current += 1 }
  }, [lookupKey])
  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from('book_translation_settings').select('*').eq('book_id', book.id).maybeSingle(),
      getLibraryReadingSources(),
    ])
      .then(([{ data, error }, librarySources]) => {
        if (cancelled) return
        if (error) {
          setError(error.message)
          return
        }
        setSettings(data)
        setLanguage(
          outputLanguages.some((entry) => entry.value === requestedLanguage)
            ? requestedLanguage!
            : (data?.target_language ?? 'en'),
        )
        setContextSources(librarySources)
        setReferenceId(
          data?.reference_source_id
            ? `source:${data.reference_source_id}`
            : data?.reference_book_id
              ? `book:${data.reference_book_id}`
              : '',
        )
        setReferenceMode(
          data?.reference_mode === 'style_only'
            ? data.reference_mode
            : 'continuation',
        )
        setLoaded(true)
      })
      .catch((failure) => {
        if (!cancelled)
          setError(
            failure instanceof Error ? failure.message : 'Context books could not be loaded.',
          )
      })
    return () => {
      cancelled = true
    }
  }, [book.id, source.id, requestedLanguage])
  useEffect(() => {
    if (!loaded) return
    let cancelled = false
    const read = async () => {
      setLookupError('')
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(content.paragraphs.join('\n\n')),
      )
      const hash = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
      const versionQuery = () => supabase
        .from('book_translation_previews')
        .select('id,result,created_at,model,input_tokens,output_tokens,glossary:context->glossary,warnings:context->warnings')
        .eq('book_id', book.id)
        .eq('kind', 'chapter')
        .eq('source_key', selected.url)
        .eq('target_language', language)
        .eq('context->source->>sourceId', source.id)
        .eq('context->source->>hash', hash)
      const result = await versionQuery()
        .order('created_at', { ascending: false })
        .limit(20)
      if (result.error) throw new Error(result.error.message)
      if (requestedVersion && !result.data.some(row => row.id === requestedVersion)) {
        const selectedVersion = await versionQuery().eq('id', requestedVersion).maybeSingle()
        if (selectedVersion.error) throw new Error(selectedVersion.error.message)
        if (!selectedVersion.data) throw new Error('This translation version is no longer available for the saved original. Choose Original or another saved version.')
        result.data.push(selectedVersion.data)
      }
      const position = await supabase.from('source_translation_progress').select('chapter_url,fraction,updated_at,translation_version').eq('source_id', source.id).eq('target_language', language).maybeSingle()
      if (position.error) throw new Error(position.error.message)
      if (!cancelled) setTranslationPosition(position.data)
      if (!cancelled)
        setVersions(
          result.data.flatMap((row) => {
            const parsed = chapterTranslationSchema.safeParse(row.result)
            return parsed.success
              ? [
                  {
                    id: row.id,
                    translation: parsed.data,
                    key: lookupKey,
                    createdAt: row.created_at,
                    model: row.model,
                    inputTokens: row.input_tokens,
                    outputTokens: row.output_tokens,
                    termContext: { glossary: row.glossary ?? [], warnings: row.warnings ?? [] },
                  },
                ]
              : []
          }),
        )
    }
    read()
      .catch((failure) => {
        if (!cancelled)
          setLookupError(
            failure instanceof Error ? failure.message : 'Saved translation could not be read.',
          )
      })
      .finally(() => {
        if (!cancelled) setCheckedKey(selectionKey)
      })
    return () => {
      cancelled = true
    }
  }, [loaded, language, book.id, source.id, selected.url, content, lookupKey, requestedVersion, selectionKey])
  useEffect(() => {
    if (!loaded || !pendingJob) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      try {
        const result = await translationBatchTask({ action: 'status', bookId: book.id, batchId: pendingJob.id })
        if (cancelled) return
        const batch = result.status?.batch
        const chapter = result.status?.chapters.find(chapter => chapter.source_key === selected.url)
        if (!batch || !chapter || batch.source_id !== source.id || batch.target_language !== pendingJob.language)
          throw new Error('This queued translation no longer matches the chapter. Check the book\'s Translate tab before retrying.')
        if ((chapter.state === 'completed' || chapter.state === 'skipped') && chapter.preview_id) {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content.paragraphs.join('\n\n')))
          const sourceHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
          const saved = await supabase.from('book_translation_previews').select('id,result,created_at,model,input_tokens,output_tokens,context').eq('book_id', book.id).eq('id', chapter.preview_id).eq('source_key', selected.url).eq('target_language', pendingJob.language).eq('context->source->>sourceId', source.id).eq('context->source->>hash', sourceHash).single()
          if (cancelled) return
          if (saved.error) throw new Error(saved.error.message)
          const translation = chapterTranslationSchema.parse(saved.data.result)
          const version = { id: saved.data.id, translation, key: JSON.stringify([source.id, selected.url, record.content_hash, pendingJob.language]), createdAt: saved.data.created_at, model: saved.data.model, inputTokens: saved.data.input_tokens, outputTokens: saved.data.output_tokens, termContext: saved.data.context }
          writeSetting(pendingKey, null)
          setPendingJob(null)
          setVersions(previous => [version, ...previous.filter(entry => entry.id !== version.id)])
          setLanguage(pendingJob.language)
          setConfirm(false)
          setParameters({ translated: pendingJob.language, version: version.id }, { replace: true })
          notify('Translation saved. Glossary candidates are available for review.')
          return
        }
        if (['failed', 'cancelled'].includes(chapter.state) || ['failed', 'paused', 'cancelled'].includes(batch.state)) {
          if (batch.state === 'cancelled') writeSetting(pendingKey, null)
          else { setRecovery({ ...pendingJob, requestKind: batch.request_kind }); setRecoveryConsent(false) }
          throw new Error(chapter.error || batch.error || 'The translation job is paused.')
        }
        timer = setTimeout(() => void check(), 2000)
      } catch (failure) {
        if (!cancelled) {
          if (failure instanceof TranslationRequestError && failure.status === 404) writeSetting(pendingKey, null)
          setError(failure instanceof Error ? failure.message : 'The translation job could not be checked. Reopen this chapter to check again.')
          setPendingJob(null)
        }
      }
    }
    void check()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [loaded, pendingJob, pendingKey, book.id, source.id, selected.url, record.content_hash, content, setParameters, notify])
  const saveSettings = async () => {
    if (
      !settings ||
      settings.target_language !== language ||
      settings.main_source_id !== source.id ||
      (settings.reference_source_id ?? '') !== referenceSourceId ||
      (settings.reference_book_id ?? '') !== referenceBookId ||
      settings.reference_mode !== referenceMode
    ) {
      await saveTranslationSettings(
        book.id,
        {
          targetLanguage: language,
          mainSource: source.id,
          referenceSourceId: referenceSourceId || null,
          referenceBookId: referenceBookId || null,
          referenceMode,
          metadataSource: settings?.metadata_source_id ?? null,
        },
        settings?.revision ?? 0,
      )
      const latest = await supabase
        .from('book_translation_settings')
        .select('*')
        .eq('book_id', book.id)
        .single()
      if (latest.error) throw new Error(latest.error.message)
      setSettings(latest.data)
      return latest.data
    }
    return settings
  }
  const previewContext = async () => {
    if (busy || !loaded) return
    setBusy(true)
    setError('')
    try {
      await saveSettings()
      const result = await bookTranslationTask({
        bookId: book.id,
        sourceKey: selected.url,
        action: 'context',
        continuation: referenceMode === 'continuation',
      })
      setInputBudget(result.budget ?? null)
      setContextSummary(
        `${result.context?.recentTranslations?.length ?? 0} recent translations / ${result.context?.references.length ?? 0} reference chapters / ${result.context?.style.length ?? 0} guide characters / ${result.context?.glossary.length ?? 0} glossary terms / ${result.context?.terminologyMemory?.length ?? 0} earlier choices`,
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Context could not be checked.')
    } finally {
      setBusy(false)
    }
  }
  const openTranslation = (newVersion = false) => {
    setRetranslate(newVersion)
    setConfirm(true)
    setInputBudget(null)
    void previewContext()
  }
  const translate = async () => {
    if (busy || checking || lookupError) return
    const existingJob = readSetting<{ id: string; language: string } | null>(pendingKey, null)
    if (existingJob) { setError(''); setPendingJob(existingJob); return }
    const generation = readerGeneration.current
    const requestId = crypto.randomUUID()
    setBusy(true)
    setError('')
    try {
      const currentSettings = await saveSettings()
      writeSetting(pendingKey, { id: requestId, language })
      const result = await bookTranslationTask({
        bookId: book.id,
        sourceKey: selected.url,
        action: 'translate',
        continuation: referenceMode === 'continuation',
        confirmed: true,
        background: true,
        requestId,
        expectedRevision: currentSettings.revision,
        retranslate,
      })
      if (result.job?.batch) {
        writeSetting(pendingKey, { id: result.job.batch.id, language: result.job.batch.target_language })
        if (generation === readerGeneration.current) {
          setPendingJob({ id: result.job.batch.id, language: result.job.batch.target_language })
          setConfirm(false)
        }
        notify('Translation queued. You can keep reading.')
        return
      }
      if (!result.previewId || !result.translation)
        throw new Error('The translation was not saved.')
      writeSetting(pendingKey, null)
      notify('Translation saved. Glossary candidates are available for review.')
      if (generation !== readerGeneration.current) return
      const savedVersion = {
        id: result.previewId,
        translation: result.translation,
        key: lookupKey,
        createdAt: new Date().toISOString(),
        model: result.budget?.model ?? inputBudget?.model ?? null,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        termContext: result.context,
      }
      setVersions((previous) => [
        savedVersion,
        ...previous.filter((version) => version.id !== savedVersion.id),
      ])
      setConfirm(false)
      setParameters({ translated: language, version: savedVersion.id }, { replace: true })
    } catch (failure) {
      if (failure instanceof TranslationRequestError && failure.status >= 400 && failure.status < 500 && failure.status !== 408) writeSetting(pendingKey, null)
      if (generation === readerGeneration.current)
        setError(failure instanceof Error ? failure.message : 'Translation could not complete.')
    } finally {
      if (generation === readerGeneration.current) setBusy(false)
    }
  }
  const original = readableSourceChapter(content, record)
  const chapterTerms = saved ? chapterTermInventory(saved.translation, content.paragraphs.join('\n\n'), saved.termContext, language) : []
  const persistReading = async (position: number, fraction: number, observedAt: number, finished = false) => {
    if (checking || lookupError) return
    const reading = { sourceId: source.id, chapterUrl: listing[position].url, language: showingTranslation ? language : undefined, versionId: showingTranslation ? saved?.id : undefined }
    rememberSourceReading(book.id, { source: reading, chapter: position, fraction, observedAt, finished })
    if (showingTranslation) setTranslationPosition({ chapter_url: reading.chapterUrl, fraction, updated_at: new Date(observedAt).toISOString(), translation_version: reading.versionId ?? null })
    else setOriginalPosition({ fraction, updatedAt: observedAt })
    await saveSourceProgress(source.id, reading.chapterUrl, fraction, { language: reading.language, versionId: reading.versionId, finished, observedAt: new Date(observedAt).toISOString() })
  }
  const readingContent: Chapter =
    showingTranslation && saved
      ? {
          ...original,
          id: saved.id,
          title: saved.translation.title,
          wordCount: saved.translation.paragraphs.join(' ').split(/\s+/).length,
          html: readableSourceChapter(saved.translation, record).html,
        }
      : original
  const readingBook: LibraryBook = {
    ...book,
    id: `${source.id}${showingTranslation ? `:${language}:${saved?.id}` : ''}`,
    language: showingTranslation ? language : source.language,
    chapters: listing.map((chapter, position) => ({
      id: chapter.url,
      title: position === index ? readingContent.title : chapter.title,
      wordCount: position === index ? readingContent.wordCount : 0,
    })),
    bookmarks: [],
    progress: { chapter: index, offset: showingTranslation ? (translationPosition?.chapter_url === selected.url && translationPosition.translation_version === saved?.id ? translationPosition.fraction : 0) : originalPosition.fraction },
    lastReadAt: showingTranslation ? (translationPosition ? Date.parse(translationPosition.updated_at) : 0) : originalPosition.updatedAt,
    status: 'reading',
  }
  const actions = (
    <div className="source-reader-links">
      <div className="reader-edition-switch" role="group" aria-label="Reading version">
        <button
          aria-pressed={!showingTranslation}
          onClick={() => setParameters({}, { replace: true })}
        >
          Original
        </button>
        <button
          aria-pressed={showingTranslation}
          disabled={!loaded || checking || busy || Boolean(lookupError)}
          title={
            saved
              ? 'Read the saved translation'
              : 'Translate and save this chapter using your preferences. One billable translation request.'
          }
          onClick={() => {
            if (saved) setParameters({ translated: language }, { replace: true })
            else if (
              settings &&
              settings.main_source_id === source.id &&
              settings.target_language === language &&
              (settings.reference_source_id ?? '') === referenceSourceId &&
              (settings.reference_book_id ?? '') === referenceBookId &&
              settings.reference_mode === referenceMode
            )
              void translate()
            else openTranslation()
          }}
        >
          {checking || busy ? <LoaderCircle className="spin" size={15} /> : <Languages size={15} />}
          Translate
        </button>
      </div>
    </div>
  )
  return (
    <>
      {
        <Reader
          key={`${source.id}:${index}:${showingTranslation ? saved?.id : 'original'}`}
          book={readingBook}
          theme={theme}
          onTheme={setTheme}
          loadChapter={async () => readingContent}
          bookPath={back}
          chapterPath={(position) =>
            `/read-source/${book.id}/${source.id}/${position}${translated ? `?translated=${language}` : ''}`
          }
          bookmarksEnabled={false}
          trackingEnabled={!checking && !lookupError}
          chatContext={{ bookId: book.id, sourceId: source.id, sourceKey: selected.url, versionId: showingTranslation ? saved?.id : undefined }}
          chapterActions={actions}
          onSuggestTerm={(text) => {
            setEditingTerm(null)
            setTermSelection(text)
          }}
          terminology={checking ? [] : chapterTerms.flatMap(term => (showingTranslation ? term.forms : [term.source]).map(display => ({ source: term.source, target: term.target, display })))}
          onReviewTerms={label => { setTermQuery(chapterTerms.find(term => term.forms.includes(label))?.target ?? label); setTermsOpen(true) }}
          onEditTerm={(source, target) => {
            setEditingTerm({ source, target })
            setTermSelection(target)
          }}
          chapterSettings={(close) => (
            <div className="chapter-settings-controls">
              <p title={source.url ?? undefined}>
                {bookSourceLabel(book)} / {language}
              </p>
              {saved && (
                <button
                  className="button"
                  title="Create a new translation version without overwriting earlier versions."
                  disabled={busy || checking}
                  onClick={() => {
                    close()
                    openTranslation(true)
                  }}
                >
                  <RotateCw size={16} />
                  Retranslate chapter
                </button>
              )}
              {saved && <button className="button" onClick={() => { close(); setTermQuery(''); setTermsOpen(true) }}><List size={16} />Chapter terms ({chapterTerms.length})</button>}
              {matchingVersions.length > 1 && (
                <label>
                  Saved version
                  <select
                    aria-label="Translation version"
                    value={saved?.id ?? ''}
                    onChange={(event) => {
                      setParameters(
                        { translated: language, version: event.target.value },
                        { replace: true },
                      )
                      close()
                    }}
                  >
                    {matchingVersions.map((version, position) => (
                      <option key={version.id} value={version.id}>
                        {position === 0 ? 'Latest' : `Previous ${position}`} /{' '}
                        {new Date(version.createdAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <Link to={`/books/${book.id}/translation?tab=style&chapter=${index}`}>Style guide</Link>
              <button
                className="button"
                onClick={() => {
                  close()
                  setEditingTerm(null)
                  setTermSelection('')
                }}
              >
                Suggest translation term
              </button>
              <Link to={`/books/${book.id}/translation?tab=settings&chapter=${index}`}>
                Translation settings
              </Link>
              <a href={selected.url} target="_blank" rel="noreferrer">
                Source link
              </a>
            </div>
          )}
          onProgress={async (_id, position, fraction, observedAt) => {
            try {
              await persistReading(position, fraction, observedAt)
            } catch {
              notify('Reading position could not be saved.')
            }
          }}
          onBookmark={async () => undefined}
          onFinish={async () => {
            try {
              await persistReading(index, 1, Date.now(), true)
              return true
            } catch {
              notify('Reading position could not be saved.')
              return false
            }
          }}
        />
      }
      {(error || lookupError) && !confirm && (
        <p className="reader-translation-error" role="alert">
          {error || lookupError}
        </p>
      )}
      {recovery && <Dialog title="Resume chapter translation" onClose={() => { if (!working) setRecovery(null) }}>
        <div className="edit-form">
          <p>{error || 'This translation did not finish.'}</p>
          {recovery.requestKind === 'reader' ? <>
            <label className="consent-row"><input type="checkbox" checked={recoveryConsent} disabled={working} onChange={event => setRecoveryConsent(event.target.checked)} />Allow another billable attempt. Earlier provider usage may have been charged.</label>
            <button className="button primary" disabled={working || !recoveryConsent} onClick={async () => {
              const generation = readerGeneration.current
              setBusy(true)
              try {
                await translationBatchTask({ action: 'resume', bookId: book.id, batchId: recovery.id, confirmed: true, retryFailed: true })
                if (generation !== readerGeneration.current) return
                setPendingJob({ id: recovery.id, language: recovery.language })
                setRecovery(null)
                setError('')
              } catch (failure) { if (generation === readerGeneration.current) setError(failure instanceof Error ? failure.message : 'The job could not resume.') }
              finally { if (generation === readerGeneration.current) setBusy(false) }
            }}><RotateCw size={16} />Resume translation</button>
            <button className="button" disabled={working} onClick={async () => {
              const generation = readerGeneration.current
              setBusy(true)
              try {
                await translationBatchTask({ action: 'cancel', bookId: book.id, batchId: recovery.id })
                writeSetting(pendingKey, null)
                if (generation !== readerGeneration.current) return
                setRecovery(null)
                setError('')
              } catch (failure) { if (generation === readerGeneration.current) setError(failure instanceof Error ? failure.message : 'The job could not be cancelled.') }
              finally { if (generation === readerGeneration.current) setBusy(false) }
            }}><Square size={16} />Cancel chapter job</button>
          </> : <Link className="button" to={`/books/${book.id}?tab=translate`}><List size={16} />Review bulk queue</Link>}
        </div>
      </Dialog>}
      {termsOpen && saved && <ChapterTerms translation={saved.translation} sourceText={content.paragraphs.join('\n\n')} snapshot={saved.termContext} targetLanguage={language} initialQuery={termQuery} onClose={() => setTermsOpen(false)} onChoose={(source, target) => { setTermsOpen(false); setEditingTerm({ source, target }); setTermSelection(target) }} />}
      {termSelection !== null && (
        <TermSuggestion
          book={{ ...book, language: source.language }}
          sourceText={content.paragraphs.join('\n\n')}
          sourceUrl={selected.url}
          selectedText={termSelection}
          translation={editingTerm || showingTranslation ? saved?.translation : undefined}
          inline={editingTerm && saved && saved.translation.terminology.some(term => term.source === editingTerm.source && term.target === editingTerm.target) && !chapterTerms.some(term => term.target === editingTerm.target && term.ambiguous) ? { ...editingTerm, previewId: saved.id } : undefined}
          initialTerm={editingTerm ?? undefined}
          previewId={editingTerm || showingTranslation ? saved?.id : undefined}
          targetLanguage={language}
          onClose={() => {
            setEditingTerm(null)
            setTermSelection(null)
          }}
          onSaved={(edited) => {
            setEditingTerm(null)
            setTermSelection(null)
            setInputBudget(null)
            if (edited) {
              setVersions((previous) => [
                {
                  id: edited.previewId,
                  translation: edited.translation,
                  key: lookupKey,
                  createdAt: new Date().toISOString(),
                  model: 'manual edit',
                  inputTokens: 0,
                  outputTokens: 0,
                  termContext: saved?.termContext,
                },
                ...previous,
              ])
              setParameters({ translated: language, version: edited.previewId }, { replace: true })
              notify('Term updated. The earlier translation version is kept.')
            } else notify('Preferred term saved. Retranslate to apply it to this chapter.')
          }}
        />
      )}
      {confirm && (
        <Dialog
          title={retranslate ? 'Retranslate chapter' : 'Translate & read'}
          onClose={() => {
            if (!busy) setConfirm(false)
          }}
        >
          <div className="edit-form">
            <label>
              Read in
              <select
                value={language}
                disabled={busy}
                onChange={(event) => {
                  setLanguage(event.target.value)
                  setInputBudget(null)
                }}
              >
                {outputLanguages.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Context book
              <select
                value={referenceId}
                disabled={busy}
                onChange={(event) => {
                  setReferenceId(event.target.value)
                  setInputBudget(null)
                }}
              >
                <option value="">None</option>
                {books
                  .filter((entry) => entry.id !== book.id)
                  .flatMap((entry) => {
                    const contextSource = contextSources.find(
                      (source) => source.book_id === entry.id,
                    )
                    if (entry.format === 'WEB' && !contextSource) return []
                    return (
                      <option
                        key={entry.id}
                        value={
                          entry.format === 'WEB'
                            ? `source:${contextSource!.id}`
                            : `book:${entry.id}`
                        }
                      >
                        {entry.title} / {bookSourceLabel(entry)} ({entry.language})
                      </option>
                    )
                  })}
              </select>
            </label>
            {referenceId && (
              <label>
                Context use
                <select
                  value={referenceMode}
                  disabled={busy}
                  onChange={(event) => {
                    setReferenceMode(event.target.value as typeof referenceMode)
                    setInputBudget(null)
                  }}
                >
                  <option value="continuation">Recent earlier chapters</option>
                  <option value="style_only">Writing style only</option>
                </select>
              </label>
            )}
            <p>
              One billable translation request{inputBudget ? ` using ${inputBudget.model}` : ''}.
              Original text{retranslate ? ' and earlier translations are' : ' is'} kept.
            </p>
            <div className="translation-budget">
              <button className="button" disabled={busy} onClick={() => void previewContext()}>
                <Eye size={15} />
                Check input context
              </button>
              {inputBudget && (
                <>
                  <p>
                    {inputBudget.inputTokens.toLocaleString()} /{' '}
                    {inputBudget.inputLimit.toLocaleString()} estimated input tokens /{' '}
                    {inputBudget.outputReserve.toLocaleString()} output reserve
                  </p>
                  <p>{contextSummary}</p>
                  {!inputBudget.withinLimit && (
                    <p role="alert">
                      Context exceeds the local input limit. Reduce context before translating.
                    </p>
                  )}
                </>
              )}
              {saved && (
                <p>
                  Saved version: {saved.model || 'Unknown model'} /{' '}
                  {saved.inputTokens.toLocaleString()} input / {saved.outputTokens.toLocaleString()}{' '}
                  output tokens
                </p>
              )}
            </div>
            <Link to={`/books/${book.id}/translation?tab=style&chapter=${index}`}>Style guide and context preferences</Link>
            {(error || lookupError) && (
              <p role="alert" className="form-error">
                {error || lookupError}
              </p>
            )}
            <button
              className="button primary"
              disabled={
                busy || checking || Boolean(lookupError) || inputBudget?.withinLimit === false
              }
              onClick={() =>
                saved && !retranslate
                  ? (setConfirm(false), setParameters({ translated: language }, { replace: true }))
                  : void translate()
              }
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <Languages size={16} />}
              {retranslate
                ? 'Retranslate & save new version'
                : saved
                  ? 'Read saved translation'
                  : 'Translate & read'}
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}
